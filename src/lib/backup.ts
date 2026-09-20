import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { prisma } from './prisma';

const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // nightly

/**
 * How many backup files to keep on disk. The BackupRun rows are never deleted —
 * they are the record that a backup happened, and this app does not hard-delete
 * records. Only the .db files are pruned, so history stays auditable while disk
 * use stays bounded.
 */
const KEEP_BACKUP_FILES = 14;

let schedulerStarted = false;

/**
 * Resolve the SQLite file behind DATABASE_URL.
 *
 * Prisma resolves a relative file: URL against the directory holding
 * schema.prisma, NOT the process working directory — so `file:./dev.db` with a
 * schema in prisma/ means prisma/dev.db. Resolving it against cwd finds nothing
 * and would report a perfectly healthy database as missing.
 */
function databaseFilePath(): string {
  const url = process.env.DATABASE_URL ?? 'file:./prisma/dev.db';
  const relative = url.replace(/^file:/, '');
  if (path.isAbsolute(relative)) {
    return relative;
  }
  const schemaDir = path.join(/* turbopackIgnore: true */ process.cwd(), 'prisma');
  return path.resolve(schemaDir, relative);
}

/**
 * Where backup files are written. Set BACKUP_DIR to a path on separate, durable
 * storage — the default sits next to the database, which does not survive the
 * disk failure that backups exist to protect against, nor a container redeploy.
 */
function backupDir(): string {
  return process.env.BACKUP_DIR ?? path.join(/* turbopackIgnore: true */ process.cwd(), 'backups');
}

function sha256Of(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function auditBackupOutcome(fileName: string, summary: string, metadata: Record<string, unknown>) {
  const entities = await prisma.entity.findMany({ select: { id: true } });
  const { recordAuditEvent } = await import('./audit');
  for (const entity of entities) {
    await recordAuditEvent({
      entityId: entity.id,
      userName: 'system',
      action: 'BACKUP',
      resourceType: 'backup',
      resourceRef: fileName,
      summary,
      metadata,
    });
  }
}

/**
 * Delete backup files beyond the retention limit, newest kept. Failures here are
 * logged and swallowed: a full disk is a problem, but it must not turn a
 * successful backup into a reported failure.
 */
async function pruneOldBackupFiles() {
  try {
    const stale = await prisma.backupRun.findMany({
      where: { status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
      skip: KEEP_BACKUP_FILES,
      select: { filePath: true },
    });

    for (const run of stale) {
      fs.rmSync(run.filePath, { force: true });
    }
  } catch (error) {
    console.error('Pruning old backup files failed', error);
  }
}

/**
 * Run a backup of the SQLite database immediately.
 *
 * Uses SQLite's online backup (VACUUM INTO) so it is safe while the app is
 * running, then reads the file back and verifies it before declaring success.
 * Both outcomes are recorded in BackupRun and written to the audit trail.
 *
 * Returns the run. Callers MUST check `status` — a failed backup resolves
 * normally rather than throwing, so that the failure is recorded rather than
 * lost, but it is emphatically not a success.
 */
export async function runBackupNow(trigger: 'nightly' | 'manual' = 'manual') {
  const source = databaseFilePath();
  const directory = backupDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `sprouted-backup-${timestamp}.db`;
  const target = path.join(directory, fileName);

  try {
    if (!fs.existsSync(source)) {
      throw new Error(`Database file not found at ${source}`);
    }

    fs.mkdirSync(directory, { recursive: true });

    // VACUUM INTO produces a consistent, compacted snapshot without locking the live database.
    await prisma.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

    if (!fs.existsSync(target)) {
      throw new Error('VACUUM INTO reported success but wrote no file');
    }

    const checksum = sha256Of(target);
    const sizeBytes = fs.statSync(target).size;

    if (sizeBytes === 0) {
      throw new Error('Backup file is empty');
    }

    const run = await prisma.backupRun.create({
      data: { fileName, filePath: target, sizeBytes, status: 'SUCCESS', checksum },
    });

    await auditBackupOutcome(
      fileName,
      `${trigger === 'nightly' ? 'Nightly' : 'Manual'} database backup completed`,
      { sizeBytes, checksum },
    );

    await pruneOldBackupFiles();

    return run;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    const run = await prisma.backupRun.create({
      data: { fileName, filePath: target, sizeBytes: 0, status: 'FAILED', error: message, checksum: '' },
    });

    // A failed backup is more important to record than a successful one.
    await auditBackupOutcome(
      fileName,
      `${trigger === 'nightly' ? 'Nightly' : 'Manual'} database backup FAILED`,
      { error: message },
    ).catch((auditError) => console.error('Could not audit backup failure', auditError));

    console.error('Database backup failed', error);
    return run;
  }
}

export type BackupVerification =
  | { ok: true; checksum: string }
  | { ok: false; reason: 'missing-file' | 'checksum-mismatch'; expected: string; actual?: string };

/**
 * Re-read a backup file and check it still matches the checksum recorded when it
 * was written. A stored checksum nobody ever re-checks proves nothing.
 */
export function verifyBackupFile(filePath: string, expectedChecksum: string): BackupVerification {
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: 'missing-file', expected: expectedChecksum };
  }

  const actual = sha256Of(filePath);
  if (actual !== expectedChecksum) {
    return { ok: false, reason: 'checksum-mismatch', expected: expectedChecksum, actual };
  }

  return { ok: true, checksum: actual };
}

export function backupFileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/**
 * Starts the nightly backup scheduler. Safe to call repeatedly — it only starts
 * once per process. Call it from instrumentation.ts so it runs on server boot;
 * hanging it off a request handler means no backups until somebody happens to
 * open the right page.
 *
 * This is an in-process timer, so it suits a long-running server. On a platform
 * with ephemeral or per-request processes it will not fire reliably — there, run
 * backups from an external scheduler that POSTs to /api/backups.
 */
export function ensureBackupScheduler() {
  if (schedulerStarted) {
    return;
  }
  schedulerStarted = true;

  const tick = async () => {
    try {
      const last = await prisma.backupRun.findFirst({
        where: { status: 'SUCCESS' },
        orderBy: { createdAt: 'desc' },
      });

      const due = !last || Date.now() - last.createdAt.getTime() >= BACKUP_INTERVAL_MS;
      if (due) {
        await runBackupNow('nightly');
      }
    } catch (error) {
      console.error('Nightly backup check failed', error);
    }
  };

  void tick();
  setInterval(() => void tick(), BACKUP_INTERVAL_MS).unref();
}
