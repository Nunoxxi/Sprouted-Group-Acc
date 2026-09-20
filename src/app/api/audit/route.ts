import { NextResponse } from 'next/server';

import { recordAuditEvent, verifyAuditChain, type AuditAction } from '@/lib/audit';
import { AuthorizationError } from '@/lib/authz';
import { requireEntityAccess } from '@/lib/dal';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

// Actions a client may record from the browser. Ledger actions (POST, VOID,
// FILE_PERIOD) are written by the server functions that perform them; USER
// events by the user-management functions. Neither is accepted here.
const CLIENT_ACTIONS: AuditAction[] = ['MATCH', 'EDIT'];

function refused(error: unknown) {
  if (error instanceof AuthorizationError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

// Only reached after the access check: Owners hold every entity, so for them
// an unknown id is genuinely unknown rather than merely not granted.
async function entityExists(id: string): Promise<boolean> {
  return (await prisma.entity.count({ where: { id } })) === 1;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const entityId = searchParams.get('entityId');

  // Reads are scoped to one entity, always. A missing entity is refused
  // rather than widened to every entity's audit trail.
  if (!entityId) {
    return NextResponse.json({ error: 'entityId is required' }, { status: 400 });
  }

  // Access is checked before the entity is looked up, so an entity the caller
  // may not see is indistinguishable from one that does not exist.
  try {
    await requireEntityAccess(entityId, 'audit:read');
  } catch (error) {
    return refused(error);
  }
  if (!(await entityExists(entityId))) {
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
      userId: event.userId,
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
  const body = await request.json().catch(() => null);

  if (!body?.entityId || !body.resourceRef || !body.summary || !CLIENT_ACTIONS.includes(body.action)) {
    return NextResponse.json({ error: 'Invalid audit event' }, { status: 400 });
  }

  // Bank matching and intercompany posting are reconciliation work.
  let principal;
  try {
    principal = await requireEntityAccess(body.entityId, 'document:mark-paid');
  } catch (error) {
    return refused(error);
  }
  if (!(await entityExists(body.entityId))) {
    return NextResponse.json({ error: 'Unknown entity' }, { status: 404 });
  }

  const id = await recordAuditEvent({
    entityId: body.entityId,
    userId: principal.userId,
    userName: principal.name, // the session's name, never the body's
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
