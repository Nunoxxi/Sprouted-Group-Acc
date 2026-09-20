import { NextResponse } from 'next/server';

import { recordAuditEvent, verifyAuditChain, type AuditAction } from '@/lib/audit';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const VALID_ACTIONS: AuditAction[] = ['POST', 'EDIT', 'VOID', 'MATCH', 'BACKUP', 'FILE_PERIOD'];

const ENTITY_ALIASES: Record<string, string> = {
  'sprouted-roots': 'Sprouted Roots',
  'sprouted-crafts': 'Sprouted Crafts',
  oikazi: 'Oikazi',
};

async function resolveEntityId(idOrAlias: string): Promise<string | null> {
  const byId = await prisma.entity.findUnique({ where: { id: idOrAlias }, select: { id: true } });
  if (byId) return byId.id;
  const name = ENTITY_ALIASES[idOrAlias];
  if (!name) return null;
  const byName = await prisma.entity.findFirst({ where: { name }, select: { id: true } });
  return byName?.id ?? null;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const entityParam = searchParams.get('entityId');

  // Reads are scoped to one entity, always. A missing or unknown entity is
  // refused rather than widened to every entity's audit trail.
  if (!entityParam) {
    return NextResponse.json({ error: 'entityId is required' }, { status: 400 });
  }

  const entityId = await resolveEntityId(entityParam);
  if (!entityId) {
    return NextResponse.json({ error: 'unknown entity' }, { status: 404 });
  }

  const events = await prisma.auditEvent.findMany({
    where: { entityId },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  const integrity = await verifyAuditChain(entityId);

  return NextResponse.json({
    events: events.map((event: (typeof events)[number]) => ({
      id: event.id,
      entityId: event.entityId,
      userName: event.userName,
      action: event.action,
      resourceType: event.resourceType,
      resourceRef: event.resourceRef,
      summary: event.summary,
      createdAt: event.createdAt.toISOString(),
    })),
    chainIntact: integrity === null,
    tamperedEventId: integrity,
  });
}

export async function POST(request: Request) {
  const body = await request.json();

  if (!body.entityId || !body.resourceRef || !body.summary || !VALID_ACTIONS.includes(body.action)) {
    return NextResponse.json({ error: 'Invalid audit event' }, { status: 400 });
  }

  const entityId = await resolveEntityId(body.entityId);
  if (!entityId) {
    return NextResponse.json({ error: 'Unknown entity' }, { status: 404 });
  }

  const id = await recordAuditEvent({
    entityId,
    userName: body.userName,
    action: body.action,
    resourceType: body.resourceType ?? 'document',
    resourceRef: body.resourceRef,
    summary: body.summary,
    metadata: body.metadata,
  });

  return NextResponse.json({ id }, { status: 201 });
}

// Deliberately no PUT, PATCH or DELETE handlers — the audit log is
// append-only and cannot be altered through this API.
