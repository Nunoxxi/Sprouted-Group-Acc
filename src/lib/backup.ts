import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { prisma } from './prisma';

const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // nightly

let schedulerStarted = false;

function databaseFilePath(): string {
  const url = process.env.DATABASE_URL ?? 'file:./prisma/dev.db';
  const relative = url.replace(/^file:/, '');
  return path.isAbsolute(relative) ? relative : path.join(process.cwd(), relative);
}

function backupDir(): string {
  return path.join(process.cwd(), 'backups');
}

/**
 * Run a backup of the SQLite database immediately.
 * Uses SQLite's online backup (VACUUM INTO) so it is safe while the app is running.
 * Records the outcome in BackupRun and writes an audit event per active entity.
 */
export async function runBackupNow(trigger: 'nightly' | 'manual' = 'manual') {
  const source = databaseFilePath();
  fs.mkdirSync(backupDir(), { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `sprouted-backup-${timestamp}.db`;
  const target = path.join(backupDir(), fileName);

  try {
    // VACUUM INTO produces a consistent, compacted snapshot without locking the live database.
    await prisma.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

    const buffer = fs.readFileSync(target);
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

    const run = await prisma.backupRun.create({
      data: {
        fileName,
        filePath: target,
        sizeBytes: buffer.length,
        status: 'SUCCESS',
        checksum,
      },
    });

    const entities = await prisma.entity.findMany({ select: { id: true } });
    const { recordAuditEvent } = await import('./audit');
    for (const entity of entities) {
      await recordAuditEvent({
        entityId: entity.id,
        userName: 'system',
        action: 'BACKUP',
        resourceType: 'backup',
        resourceRef: fileName,
        summary: `${trigger === 'nightly' ? 'Nightly' : 'Manual'} database backup completed`,
        metadata: { sizeBytes: buffer.length, checksum },
      });
    }

    return run;
  } catch (error) {
    const run = await prisma.backupRun.create({
      data: {
        fileName,
        filePath: target,
        sizeBytes: 0,
        status: 'FAILED',
        error: error instanceof Error ? error.message : String(error),
        checksum: '',
      },
    });
    return run;
  }
}

/**
 * Starts the nightly backup scheduler. Safe to call multiple times — it only
 * starts once per process. On boot it runs a backup if none exists in the
 * last 24 hours, then repeats every 24 hours.
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
      console.error('Nightly backup failed', error);
    }
  };

  void tick();
  setInterval(() => void tick(), BACKUP_INTERVAL_MS).unref();
}
