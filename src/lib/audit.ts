import crypto from 'crypto';

import type { Prisma } from '@prisma/client';

import { assertNoBigInt } from './data/money';
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

/** Either the global client or the `tx` handed to a $transaction callback. */
export type AuditClient = Prisma.TransactionClient;

type HashInput = {
  entityId: string;
  sequence: number;
  userName: string;
  action: string;
  resourceType: string;
  resourceRef: string;
  summary: string;
  metadata: unknown;
  previousHash: string | null;
  createdAt: string;
};

function hashOf(input: HashInput): string {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/**
 * Append an immutable audit event.
 *
 * There are intentionally no update or delete functions for this model.
 * Events form a hash chain per entity: each event's hash covers its content,
 * its position in the chain, and the previous event's hash, so any tampering
 * with an earlier record breaks every hash after it and is detectable.
 *
 * Pass the caller's transaction client to record the event atomically with
 * the change it describes — a posted journal without its POST event, or the
 * reverse, is worse than a failed post. Without one, this opens its own.
 *
 * The next sequence number is read under a per-entity advisory lock so two
 * concurrent writers cannot both read the same tail and fork the chain.
 */
export async function recordAuditEvent(input: AuditEventInput, client?: AuditClient): Promise<string> {
  if (client) {
    return appendEvent(input, client);
  }
  return prisma.$transaction((tx) => appendEvent(input, tx));
}

async function appendEvent(input: AuditEventInput, tx: AuditClient): Promise<string> {
  // A bigint in metadata would throw inside JSON.stringify and roll back the
  // caller's whole transaction with an unhelpful message. Fail clearly instead.
  assertNoBigInt(input.metadata ?? null, 'audit metadata');

  // Held until the surrounding transaction ends. Keyed by entity so entities
  // never block each other.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.entityId}))`;

  const previous = await tx.auditEvent.findFirst({
    where: { entityId: input.entityId },
    orderBy: { sequence: 'desc' },
    select: { hash: true, sequence: true },
  });

  const sequence = (previous?.sequence ?? 0) + 1;
  const userName = input.userName ?? 'system';
  const createdAt = new Date();
  const metadata = input.metadata ?? null;

  const hash = hashOf({
    entityId: input.entityId,
    sequence,
    userName,
    action: input.action,
    resourceType: input.resourceType,
    resourceRef: input.resourceRef,
    summary: input.summary,
    metadata,
    previousHash: previous?.hash ?? null,
    createdAt: createdAt.toISOString(),
  });

  const event = await tx.auditEvent.create({
    data: {
      entityId: input.entityId,
      sequence,
      userName,
      action: input.action,
      resourceType: input.resourceType,
      resourceRef: input.resourceRef,
      summary: input.summary,
      metadataJson: metadata ? JSON.stringify(metadata) : null,
      hash,
      previousHash: previous?.hash ?? null,
      createdAt,
    },
    select: { id: true },
  });

  return event.id;
}

export type ChainEventLike = {
  id: string;
  entityId: string;
  sequence: number;
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
 * Walk a chain of events in sequence order and return the id of the first one
 * that breaks it, or null when the chain is intact.
 *
 * Three things are checked for every event:
 *
 * 1. Its sequence is exactly one more than the last. Catches a deleted or
 *    inserted record directly.
 * 2. Its stored previousHash equals the hash of the event before it. This is
 *    the link: without it a record can be replaced by a self-consistent forgery
 *    and nothing notices.
 * 3. Its stored hash equals a fresh hash of its own content. Catches an edit
 *    made without recomputing the hash.
 *
 * Pure so it can be tested without a database.
 */
export function verifyChain(events: ChainEventLike[]): string | null {
  let previousHash: string | null = null;
  let expectedSequence = 1;

  for (const event of events) {
    if (event.sequence !== expectedSequence || event.previousHash !== previousHash) {
      return event.id;
    }

    const hash = hashOf({
      entityId: event.entityId,
      sequence: event.sequence,
      userName: event.userName,
      action: event.action,
      resourceType: event.resourceType,
      resourceRef: event.resourceRef,
      summary: event.summary,
      metadata: event.metadataJson ? JSON.parse(event.metadataJson) : null,
      previousHash: event.previousHash,
      createdAt: event.createdAt.toISOString(),
    });

    if (hash !== event.hash) {
      return event.id;
    }

    previousHash = event.hash;
    expectedSequence += 1;
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
    orderBy: { sequence: 'asc' },
  });

  return verifyChain(events);
}
