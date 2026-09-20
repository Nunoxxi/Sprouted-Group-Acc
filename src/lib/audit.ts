import crypto from 'crypto';

import { prisma } from './prisma';

export type AuditAction = 'POST' | 'EDIT' | 'VOID' | 'MATCH' | 'BACKUP' | 'FILE_PERIOD';

export type AuditEventInput = {
  entityId: string;
  userName?: string;
  action: AuditAction;
  resourceType: string;
  resourceRef: string;
  summary: string;
  metadata?: Record<string, unknown>;
};

/**
 * Append an immutable audit event.
 *
 * There are intentionally no update or delete functions for this model.
 * Events form a hash chain per entity: each event's hash covers its content
 * plus the previous event's hash, so any tampering with an earlier record
 * breaks every hash after it and is detectable.
 */
export async function recordAuditEvent(input: AuditEventInput): Promise<string> {
  const previous = await prisma.auditEvent.findFirst({
    where: { entityId: input.entityId },
    orderBy: { createdAt: 'desc' },
    select: { hash: true },
  });

  const createdAt = new Date();
  const createdAtIso = createdAt.toISOString();
  const payload = JSON.stringify({
    entityId: input.entityId,
    userName: input.userName ?? 'system',
    action: input.action,
    resourceType: input.resourceType,
    resourceRef: input.resourceRef,
    summary: input.summary,
    metadata: input.metadata ?? null,
    previousHash: previous?.hash ?? null,
    createdAt: createdAtIso,
  });

  const hash = crypto.createHash('sha256').update(payload).digest('hex');

  const event = await prisma.auditEvent.create({
    data: {
      entityId: input.entityId,
      userName: input.userName ?? 'system',
      action: input.action,
      resourceType: input.resourceType,
      resourceRef: input.resourceRef,
      summary: input.summary,
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      hash,
      previousHash: previous?.hash ?? null,
      createdAt,
    },
  });

  return event.id;
}

export type ChainEventLike = {
  id: string;
  entityId: string;
  userName: string;
  action: string;
  resourceType: string;
  resourceRef: string;
  summary: string;
  metadataJson: string | null;
  hash: string;
  previousHash: string | null;
  createdAt: Date;
};

/**
 * Walk a chain of events in order and return the id of the first one that
 * breaks it, or null when the chain is intact.
 *
 * Two things are checked for every event, and both are needed:
 *
 * 1. Its stored previousHash equals the hash of the event before it. This is
 *    the link. Without it a record can be deleted from the middle, reordered,
 *    or replaced by a self-consistent forgery and nothing notices — which is
 *    precisely what a hash chain exists to catch.
 * 2. Its stored hash equals a fresh hash of its own content. This catches an
 *    edit made without recomputing the hash.
 *
 * Pure so it can be tested without a database.
 */
export function verifyChain(events: ChainEventLike[]): string | null {
  let previousHash: string | null = null;

  for (const event of events) {
    if (event.previousHash !== previousHash) {
      return event.id;
    }

    const payload: string = JSON.stringify({
      entityId: event.entityId,
      userName: event.userName,
      action: event.action,
      resourceType: event.resourceType,
      resourceRef: event.resourceRef,
      summary: event.summary,
      metadata: event.metadataJson ? JSON.parse(event.metadataJson) : null,
      previousHash: event.previousHash,
      createdAt: event.createdAt.toISOString(),
    });

    const hash: string = crypto.createHash('sha256').update(payload).digest('hex');
    if (hash !== event.hash) {
      return event.id;
    }

    previousHash = event.hash;
  }

  return null;
}

/**
 * Verify the audit chain for an entity. Returns the id of the first
 * tampered event, or null when the chain is intact.
 */
export async function verifyAuditChain(entityId: string): Promise<string | null> {
  const events = await prisma.auditEvent.findMany({
    where: { entityId },
    orderBy: { createdAt: 'asc' },
  });

  return verifyChain(events);
}
