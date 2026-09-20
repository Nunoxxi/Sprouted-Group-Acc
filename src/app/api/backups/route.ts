import { NextResponse } from 'next/server';
import fs from 'fs';

import { AuthorizationError } from '@/lib/authz';
import { requireEntityAccess } from '@/lib/dal';
import { backupFileExists, runLedgerExport, verifyBackupFile } from '@/lib/export';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

function refused(error: unknown) {
  if (error instanceof AuthorizationError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

type BackupRunRow = {
  id: string;
  entityId: string | null;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  status: string;
  checksum: string;
  createdAt: Date;
  error: string | null;
};

function toView(run: BackupRunRow) {
  return {
    id: run.id,
    entityId: run.entityId,
    fileName: run.fileName,
    sizeBytes: run.sizeBytes,
    status: run.status,
    checksum: run.checksum,
    createdAt: run.createdAt.toISOString(),
    error: run.error,
    // Files are pruned past the retention limit while their rows are kept, so
    // the row existing does not mean the file is still downloadable.
    available: run.status === 'SUCCESS' && backupFileExists(run.filePath),
  };
}

async function resolveEntity(entityId: string | null) {
  if (!entityId) return null;
  return prisma.entity.findUnique({ where: { id: entityId }, select: { id: true } });
}

/**
 * Exports are scoped to one entity, always. A missing or unknown entity is
 * refused rather than widened to every entity's exports.
 */
// The nightly scheduler is started once, at boot, by src/instrumentation.ts.
// It is deliberately not started from here: nothing an unauthenticated
// request does should touch the database.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const download = searchParams.get('download');
  const entityParam = searchParams.get('entityId');
  if (!entityParam) {
    return NextResponse.json({ error: 'entityId is required' }, { status: 400 });
  }

  // An export is the whole ledger: access is checked before anything is read.
  try {
    await requireEntityAccess(entityParam, 'export:run');
  } catch (error) {
    return refused(error);
  }

  const entity = await resolveEntity(entityParam);
  if (!entity) {
    return NextResponse.json({ error: 'unknown entity' }, { status: 404 });
  }

  if (download) {
    const run = await prisma.backupRun.findFirst({
      where: { entityId: entity.id, fileName: download, status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
    });

    if (!run) {
      return NextResponse.json({ error: 'Export not found' }, { status: 404 });
    }

    // Verify before handing it over — a corrupted export found at restore time
    // is worse than no export, because it was trusted in the meantime.
    const verification = verifyBackupFile(run.filePath, run.checksum);
    if (!verification.ok) {
      return NextResponse.json(
        {
          error:
            verification.reason === 'missing-file'
              ? 'Export file is no longer on disk'
              : 'Export file failed its checksum check and may be corrupted',
          reason: verification.reason,
        },
        { status: verification.reason === 'missing-file' ? 404 : 409 },
      );
    }

    const buffer = fs.readFileSync(run.filePath);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${run.fileName}"`,
        'Content-Length': String(buffer.length),
      },
    });
  }

  const [runs, lastSuccessful] = await Promise.all([
    prisma.backupRun.findMany({ where: { entityId: entity.id }, orderBy: { createdAt: 'desc' }, take: 30 }),
    prisma.backupRun.findFirst({ where: { entityId: entity.id, status: 'SUCCESS' }, orderBy: { createdAt: 'desc' } }),
  ]);

  return NextResponse.json({
    runs: runs.map((run: BackupRunRow) => toView(run)),
    // Reported separately so the UI can never mistake "most recent run" for
    // "most recent successful run" — they are different the moment one fails.
    lastSuccessful: lastSuccessful ? toView(lastSuccessful as BackupRunRow) : null,
    lastRunFailed: runs.length > 0 && runs[0].status === 'FAILED',
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { entityId?: string } | null;
  if (!body?.entityId) {
    return NextResponse.json({ error: 'entityId is required' }, { status: 400 });
  }

  let principal;
  try {
    principal = await requireEntityAccess(body.entityId, 'export:run');
  } catch (error) {
    return refused(error);
  }

  const entity = await resolveEntity(body.entityId);
  if (!entity) {
    return NextResponse.json({ error: 'unknown entity' }, { status: 404 });
  }

  const run = await runLedgerExport(entity.id, 'manual', { userId: principal.userId, userName: principal.name });
  const view = toView(run as BackupRunRow);

  // A failed export is an error, not a 200 with bad news in the body.
  return NextResponse.json(view, { status: run.status === 'SUCCESS' ? 200 : 500 });
}
