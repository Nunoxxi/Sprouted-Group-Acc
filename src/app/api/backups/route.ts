import { NextResponse } from 'next/server';
import fs from 'fs';

import { backupFileExists, ensureBackupScheduler, runBackupNow, verifyBackupFile } from '@/lib/backup';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

type BackupRunRow = {
  id: string;
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

export async function GET(request: Request) {
  // Belt and braces: instrumentation.ts starts this on boot, but a process that
  // somehow skipped it should not go without backups.
  ensureBackupScheduler();

  const { searchParams } = new URL(request.url);
  const download = searchParams.get('download');

  if (download) {
    const run = await prisma.backupRun.findFirst({
      where: { fileName: download, status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
    });

    if (!run) {
      return NextResponse.json({ error: 'Backup not found' }, { status: 404 });
    }

    // Verify before handing it over — a corrupted backup found at restore time
    // is worse than no backup, because it was trusted in the meantime.
    const verification = verifyBackupFile(run.filePath, run.checksum);
    if (!verification.ok) {
      return NextResponse.json(
        {
          error:
            verification.reason === 'missing-file'
              ? 'Backup file is no longer on disk'
              : 'Backup file failed its checksum check and may be corrupted',
          reason: verification.reason,
        },
        { status: verification.reason === 'missing-file' ? 404 : 409 },
      );
    }

    const buffer = fs.readFileSync(run.filePath);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${run.fileName}"`,
        'Content-Length': String(buffer.length),
      },
    });
  }

  const runs = await prisma.backupRun.findMany({
    orderBy: { createdAt: 'desc' },
    take: 30,
  });

  const lastSuccessful = await prisma.backupRun.findFirst({
    where: { status: 'SUCCESS' },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({
    runs: runs.map((run: BackupRunRow) => toView(run)),
    // Reported separately so the UI can never mistake "most recent run" for
    // "most recent successful run" — they are different the moment one fails.
    lastSuccessful: lastSuccessful ? toView(lastSuccessful as BackupRunRow) : null,
    lastRunFailed: runs.length > 0 && runs[0].status === 'FAILED',
  });
}

export async function POST() {
  ensureBackupScheduler();
  const run = await runBackupNow('manual');
  const view = toView(run as BackupRunRow);

  // A failed backup is an error, not a 200 with bad news in the body.
  return NextResponse.json(view, { status: run.status === 'SUCCESS' ? 200 : 500 });
}
