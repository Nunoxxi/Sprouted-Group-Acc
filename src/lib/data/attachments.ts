/**
 * Attachment readers: what is attached to each transaction, what is waiting
 * in the inbox, and the rules that say when something must be attached.
 *
 * The bytes are not here. These read where the file is and what it is; the
 * file itself comes from src/lib/storage.ts behind a link that expires.
 */

import type { Attachment, AttachmentRule, AttachmentTargetKind, User } from '@prisma/client';

import type { AttachmentTarget } from '../attachments';
import { prisma } from '../prisma';
import { toMinor } from './money';
import type { AttachmentRecord, AttachmentRuleRecord } from './types';

// --- enum translations ---------------------------------------------------------------

const targetToRecord: Record<AttachmentTargetKind, AttachmentTarget> = {
  INVOICE: 'invoice',
  BILL: 'bill',
  PAYMENT: 'payment',
  JOURNAL: 'journal',
  AGENT_PURCHASE: 'agent-purchase',
  STOCK_COUNT: 'stock-count',
  FIXED_ASSET: 'fixed-asset',
  INBOX: 'inbox',
};
export const targetToPrisma: Record<AttachmentTarget, AttachmentTargetKind> = {
  invoice: 'INVOICE',
  bill: 'BILL',
  payment: 'PAYMENT',
  journal: 'JOURNAL',
  'agent-purchase': 'AGENT_PURCHASE',
  'stock-count': 'STOCK_COUNT',
  'fixed-asset': 'FIXED_ASSET',
  inbox: 'INBOX',
};
export const targetOf = (value: AttachmentTargetKind): AttachmentTarget => targetToRecord[value];

// --- row → record ---------------------------------------------------------------------

export const attachmentInclude = { uploadedBy: { select: { name: true } } } as const;

export function attachmentRecord(row: Attachment & { uploadedBy: Pick<User, 'name'> | null }): AttachmentRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    target: targetToRecord[row.targetKind],
    targetId: row.targetId,
    fileName: row.fileName,
    contentType: row.contentType,
    byteSize: row.byteSize,
    checksum: row.checksum,
    note: row.note ?? '',
    matchedAt: row.matchedAt ? row.matchedAt.toISOString() : null,
    uploadedAt: row.uploadedAt.toISOString(),
    uploadedById: row.uploadedById,
    uploadedByName: row.uploadedBy?.name ?? '',
  };
}

export function ruleRecord(row: AttachmentRule): AttachmentRuleRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    target: targetToRecord[row.targetKind],
    thresholdMinor: toMinor(row.thresholdMinor),
    isActive: row.isActive,
  };
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) (groups[keyOf(item)] ??= []).push(item);
  return groups;
}

/** How many attachments one transaction carries, for the posting gate. */
export async function attachmentCount(entityId: string, target: AttachmentTarget, targetId: string): Promise<number> {
  return prisma.attachment.count({ where: { entityId, targetKind: targetToPrisma[target], targetId } });
}

/** The rules of one entity, in the shape the pure gate wants. */
export async function rulesFor(entityId: string) {
  const rows = await prisma.attachmentRule.findMany({ where: { entityId } });
  return rows.map(ruleRecord).map((rule) => ({ target: rule.target, thresholdMinor: rule.thresholdMinor, isActive: rule.isActive }));
}

/** Scoped by the principal's grant in every query. */
export async function loadAttachmentData(scope: { entityId?: { in: string[] } }, entityIds: string[]) {
  const [attachments, rules] = await Promise.all([
    prisma.attachment.findMany({ where: scope, include: attachmentInclude, orderBy: { uploadedAt: 'desc' }, take: 2000 }),
    prisma.attachmentRule.findMany({ where: scope, orderBy: [{ entityId: 'asc' }, { targetKind: 'asc' }] }),
  ]);
  const withAll = <T>(grouped: Record<string, T[]>): Record<string, T[]> => Object.fromEntries(entityIds.map((id) => [id, grouped[id] ?? []]));
  return {
    attachmentsByEntity: withAll(groupBy(attachments.map(attachmentRecord), (row) => row.entityId)),
    attachmentRulesByEntity: withAll(groupBy(rules.map(ruleRecord), (row) => row.entityId)),
  };
}
