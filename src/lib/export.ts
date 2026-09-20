import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { documentInclude, documentRecord, postedJournal } from './data/documents';
import { auditEventRecord, contactRecord, entityRecord, fundRecord, projectRecord, accountRecord } from './data/mappers';
import { assertNoBigInt } from './data/money';
import { prisma } from './prisma';
import { recordAuditEvent } from './audit';

const EXPORT_INTERVAL_MS = 24 * 60 * 60 * 1000; // nightly

/**
 * How many export files to keep on disk per entity. BackupRun rows are never
 * deleted — they are the record that an export happened, and this app does not
 * hard-delete records. Only the files are pruned.
 */
const KEEP_EXPORT_FILES = 14;

let schedulerStarted = false;

/**
 * Where export files are written. Set EXPORT_DIR to durable storage; the
 * default is an `exports/` folder next to the app, which does not survive a
 * container redeploy. Database-level backups are the database platform's job.
 */
function exportDir(): string {
  return (
    process.env.EXPORT_DIR ??
    process.env.BACKUP_DIR ?? // one release of backwards compatibility
    path.join(/* turbopackIgnore: true */ process.cwd(), 'exports')
  );
}

function sha256Of(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Everything about one entity that a person could need to reconstruct its
 * books elsewhere. Built through the mappers so it is plain JSON — no bigint,
 * no Date objects.
 */
export async function buildLedgerExport(entityId: string) {
  const entity = await prisma.entity.findUnique({ where: { id: entityId } });
  if (!entity) {
    throw new Error(`Unknown entity ${entityId}`);
  }

  const [accounts, contacts, funds, projects, documents, journalEntries, filings, auditEvents] = await Promise.all([
    prisma.account.findMany({ where: { entityId }, include: { parent: { select: { code: true } } }, orderBy: { code: 'asc' } }),
    prisma.contact.findMany({
      where: { balances: { some: { entityId } } },
      include: { balances: { where: { entityId } } },
      orderBy: { name: 'asc' },
    }),
    prisma.fund.findMany({ where: { entityId }, orderBy: { code: 'asc' } }),
    prisma.project.findMany({ where: { entityId }, include: { fund: { select: { classification: true } } }, orderBy: { code: 'asc' } }),
    prisma.document.findMany({ where: { entityId }, include: documentInclude, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] }),
    prisma.journalEntry.findMany({
      where: { entityId },
      include: { lines: { include: { account: { select: { code: true, name: true } } } } },
      orderBy: [{ postedAt: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.taxPeriodFiling.findMany({ where: { entityId }, orderBy: { period: 'asc' } }),
    prisma.auditEvent.findMany({ where: { entityId }, orderBy: { sequence: 'asc' } }),
  ]);

  const payload = {
    format: 'sprouted-ledger-export',
    version: 2,
    exportedAt: new Date().toISOString(),
    entity: entityRecord(entity),
    accounts: accounts.map(accountRecord),
    contacts: contacts.map(contactRecord),
    funds: funds.map(fundRecord),
    projects: projects.map(projectRecord),
    documents: documents.map(documentRecord),
    journalEntries: journalEntries.map((entry) => ({
      ...postedJournal(entry),
      reference: entry.reference,
      description: entry.description,
      reversalOfId: entry.reversalOfId,
    })),
    filedPeriods: filings.map((filing) => ({ period: filing.period, filedAt: filing.filedAt.toISOString(), filedBy: filing.filedBy })),
    auditEvents: auditEvents.map(auditEventRecord),
  };

  // A bigint here means a mapper was bypassed. Fail loudly at the boundary.
  assertNoBigInt(payload, 'export');
  return payload;
}

/**
 * Delete this entity's export files beyond the retention limit, newest kept.
 * Failures are logged and swallowed: a full disk is a problem, but it must not
 * turn a successful export into a reported failure.
 */
async function pruneOldExportFiles(entityId: string) {
  try {
    const stale = await prisma.backupRun.findMany({
      where: { entityId, status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
      skip: KEEP_EXPORT_FILES,
      select: { filePath: true },
    });

    for (const run of stale) {
      fs.rmSync(run.filePath, { force: true });
    }
  } catch (error) {
    console.error('Pruning old export files failed', error);
  }
}

/**
 * Export one entity's ledger to a checksummed JSON file.
 *
 * Both outcomes are recorded in BackupRun and written to that entity's audit
 * trail. Returns the run. Callers MUST check `status` — a failed export
 * resolves normally rather than throwing, so the failure is recorded rather
 * than lost, but it is emphatically not a success.
 */
export async function runLedgerExport(entityId: string, trigger: 'nightly' | 'manual' = 'manual') {
  const directory = exportDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `sprouted-${entityId}-${timestamp}.json`;
  const target = path.join(directory, fileName);
  const label = trigger === 'nightly' ? 'Nightly' : 'Manual';

  try {
    const payload = await buildLedgerExport(entityId);

    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(payload, null, 2));

    const checksum = sha256Of(target);
    const sizeBytes = fs.statSync(target).size;
    if (sizeBytes === 0) {
      throw new Error('Export file is empty');
    }

    const run = await prisma.backupRun.create({
      data: { entityId, kind: 'export', fileName, filePath: target, sizeBytes, status: 'SUCCESS', checksum },
    });

    await recordAuditEvent({
      entityId,
      userName: 'system',
      action: 'BACKUP',
      resourceType: 'export',
      resourceRef: fileName,
      summary: `${label} ledger export completed`,
      metadata: { sizeBytes, checksum, records: countRecords(payload) },
    });

    await pruneOldExportFiles(entityId);

    return run;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    const run = await prisma.backupRun.create({
      data: { entityId, kind: 'export', fileName, filePath: target, sizeBytes: 0, status: 'FAILED', error: message, checksum: '' },
    });

    // A failed export is more important to record than a successful one.
    await recordAuditEvent({
      entityId,
      userName: 'system',
      action: 'BACKUP',
      resourceType: 'export',
      resourceRef: fileName,
      summary: `${label} ledger export FAILED`,
      metadata: { error: message },
    }).catch((auditError) => console.error('Could not audit export failure', auditError));

    console.error(`Ledger export failed for ${entityId}`, error);
    return run;
  }
}

function countRecords(payload: Awaited<ReturnType<typeof buildLedgerExport>>) {
  return {
    accounts: payload.accounts.length,
    contacts: payload.contacts.length,
    funds: payload.funds.length,
    projects: payload.projects.length,
    documents: payload.documents.length,
    journalEntries: payload.journalEntries.length,
    auditEvents: payload.auditEvents.length,
  };
}

export type BackupVerification =
  | { ok: true; checksum: string }
  | { ok: false; reason: 'missing-file' | 'checksum-mismatch'; expected: string; actual?: string };

/**
 * Re-read an export file and check it still matches the checksum recorded when
 * it was written. A stored checksum nobody ever re-checks proves nothing.
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
 * Starts the nightly export scheduler. Safe to call repeatedly — it only starts
 * once per process. Started from instrumentation.ts on server boot.
 *
 * In-process timer: suits a long-running server. On a host that sleeps idle
 * services it runs when the service is next awake, which is best-effort. The
 * nightly export is a convenience copy; the database platform's own backups
 * are the real safety net.
 */
export function ensureExportScheduler() {
  if (schedulerStarted) {
    return;
  }
  schedulerStarted = true;

  const tick = async () => {
    try {
      const entities = await prisma.entity.findMany({ select: { id: true } });

      for (const entity of entities) {
        const last = await prisma.backupRun.findFirst({
          where: { entityId: entity.id, status: 'SUCCESS' },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        });

        const due = !last || Date.now() - last.createdAt.getTime() >= EXPORT_INTERVAL_MS;
        if (due) {
          await runLedgerExport(entity.id, 'nightly');
        }
      }
    } catch (error) {
      console.error('Nightly export check failed', error);
    }
  };

  void tick();
  setInterval(() => void tick(), EXPORT_INTERVAL_MS).unref();
}
