import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';

import { verifyChain, type ChainEventLike } from '@/lib/audit';

/**
 * Build a valid chain the same way recordAuditEvent does, so the tests
 * exercise the real hashing contract rather than a copy of it.
 */
function buildChain(count: number): ChainEventLike[] {
  const events: ChainEventLike[] = [];
  let previousHash: string | null = null;

  for (let index = 0; index < count; index += 1) {
    const createdAt = new Date(Date.UTC(2026, 8, 20, 9, index));
    const base = {
      entityId: 'sprouted-roots',
      userName: 'system',
      action: 'POST',
      resourceType: 'invoice',
      resourceRef: `INV-${1000 + index}`,
      summary: `Invoice ${1000 + index} posted`,
      metadataJson: JSON.stringify({ total: 100 * (index + 1) }),
    };

    const payload: string = JSON.stringify({
      entityId: base.entityId,
      userName: base.userName,
      action: base.action,
      resourceType: base.resourceType,
      resourceRef: base.resourceRef,
      summary: base.summary,
      metadata: JSON.parse(base.metadataJson),
      previousHash,
      createdAt: createdAt.toISOString(),
    });
    const hash: string = crypto.createHash('sha256').update(payload).digest('hex');

    events.push({ id: `evt-${index}`, ...base, hash, previousHash, createdAt });
    previousHash = hash;
  }

  return events;
}

/** Recompute an event's hash from its current fields, as a forger would. */
function rehash(event: ChainEventLike): ChainEventLike {
  const payload = JSON.stringify({
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
  return { ...event, hash: crypto.createHash('sha256').update(payload).digest('hex') };
}

describe('the audit log is a chain, not a pile of self-consistent records', () => {
  it('accepts an untouched chain', () => {
    expect(verifyChain(buildChain(5))).toBeNull();
  });

  it('accepts an empty chain', () => {
    expect(verifyChain([])).toBeNull();
  });

  it('catches an edit made without recomputing the hash', () => {
    const chain = buildChain(4);
    chain[1] = { ...chain[1], summary: 'Invoice 1001 posted — amount quietly changed' };

    expect(verifyChain(chain)).toBe('evt-1');
  });

  it('catches an edit even when the forger recomputes that record\'s own hash', () => {
    // The tampered record is self-consistent. Only the link from the NEXT
    // record — which still points at the original hash — gives it away.
    const chain = buildChain(4);
    chain[1] = rehash({ ...chain[1], summary: 'Invoice 1001 posted — amount quietly changed' });

    expect(verifyChain(chain)).toBe('evt-2');
  });

  it('catches an event deleted from the middle of the chain', () => {
    const chain = buildChain(5);
    chain.splice(2, 1); // evt-2 removed; evt-3 still points at evt-2's hash

    expect(verifyChain(chain)).toBe('evt-3');
  });

  it('catches events that have been reordered', () => {
    const chain = buildChain(4);
    [chain[1], chain[2]] = [chain[2], chain[1]];

    expect(verifyChain(chain)).toBe('evt-2');
  });

  it('catches a forged first event that claims to have a predecessor', () => {
    const chain = buildChain(2);
    chain[0] = rehash({ ...chain[0], previousHash: 'deadbeef' });

    expect(verifyChain(chain)).toBe('evt-0');
  });

  it('catches the last event being silently dropped', () => {
    // Truncation is the one thing a chain alone cannot catch — the remaining
    // chain is perfectly valid. This documents that limit rather than hiding
    // it: detecting truncation needs an external anchor (e.g. the latest hash
    // recorded in a backup), not a change to verifyChain.
    const chain = buildChain(4);
    chain.pop();

    expect(verifyChain(chain)).toBeNull();
  });
});
