import { NextResponse } from 'next/server';
import fs from 'fs';

import { ensureBackupScheduler, runBackupNow } from '@/lib/backup';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  ensureBackupScheduler();

  const { searchParams } = new URL(request.url);
  const download = searchParams.get('download');

  if (download) {
    const run = await prisma.backupRun.findFirst({
      where: { fileName: download, status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
    });

    if (!run || !fs.existsSync(run.filePath)) {
      return NextResponse.json({ error: 'Backup not found' }, { status: 404 });
    }

    const buffer = fs.readFileSync(run.filePath);
    return new NextResponse(buffer, {
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

  return NextResponse.json({
    runs: runs.map((run: (typeof runs)[number]) => ({
      id: run.id,
      fileName: run.fileName,
      sizeBytes: run.sizeBytes,
      status: run.status,
      checksum: run.checksum,
      createdAt: run.createdAt.toISOString(),
      error: run.error,
    })),
  });
}

export async function POST() {
  ensureBackupScheduler();
  const run = await runBackupNow('manual');
  return NextResponse.json({
    id: run.id,
    fileName: run.fileName,
    sizeBytes: run.sizeBytes,
    status: run.status,
    checksum: run.checksum,
    createdAt: run.createdAt.toISOString(),
    error: run.error,
  });
}
