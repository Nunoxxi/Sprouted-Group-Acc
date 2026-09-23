'use server';

/**
 * Server Functions for attachments: uploading a file to cloud storage,
 * attaching it to a transaction or leaving it in the inbox to be matched
 * later, issuing a link that expires, and the rules that say when a
 * transaction must carry one.
 *
 * Files never go in the database. The bytes go to storage; the database
 * keeps where they are, what they are, how big they were and a checksum.
 *
 * An attachment on a posted transaction cannot be removed. Every upload,
 * match and removal is recorded in the audit log.
 */

import { createHash } from 'node:crypto';

import { refresh } from 'next/cache';

import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess } from '@/lib/dal';
import { attachmentInclude, attachmentRecord, ruleRecord, targetOf, targetToPrisma } from '@/lib/data/attachments';
import { fromMinor } from '@/lib/data/money';
import { StockRefusal } from '@/lib/data/stock';
import type { AttachmentRecord, AttachmentRuleRecord } from '@/lib/data/types';
import {
  attachmentTargetLabels,
  attachmentTargets,
  canRemove,
  checkFile,
  ruleTargets,
  safeFileName,
  storageKey,
  suggestMatches,
  type AttachmentTarget,
  type Candidate,
} from '@/lib/attachments';
import { prisma } from '@/lib/prisma';
import { putObject, removeObject, signedUrl, StorageUnavailable, storageConfigured } from '@/lib/storage';

import type { ActionResult } from './documents';

function fail<T>(error: string): ActionResult<T> {
  return { ok: false, error };
}

async function withEntityAccess<T>(entityId: string, permission: Permission, run: (principal: Principal) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  let principal: Principal;
  try {
    principal = await requireEntityAccess(entityId, permission);
  } catch (error) {
    const failure = authorizationFailure(error);
    if (failure) return failure;
    throw error;
  }
  return run(principal);
}

async function refusable<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StockRefusal) return fail(error.message);
    // Storage being down is not the person's fault, and saying so plainly is
    // better than a stack trace they cannot act on.
    if (error instanceof StorageUnavailable) return fail(error.message);
    throw error;
  }
}

/**
 * Whether the thing an attachment hangs off has been posted. A posted
 * transaction's attachments stay; a draft's can still be taken away.
 */
async function targetIsPosted(entityId: string, target: AttachmentTarget, targetId: string): Promise<boolean> {
  switch (target) {
    case 'invoice':
    case 'bill': {
      const document = await prisma.document.findFirst({ where: { id: targetId, entityId }, select: { status: true } });
      return !!document && document.status !== 'DRAFT';
    }
    case 'payment':
      return !!(await prisma.payment.findFirst({ where: { id: targetId, entityId }, select: { id: true } }));
    case 'journal':
      return !!(await prisma.journalEntry.findFirst({ where: { id: targetId, entityId }, select: { id: true } }));
    case 'agent-purchase': {
      const purchase = await prisma.agentPurchase.findFirst({ where: { id: targetId, entityId }, select: { status: true } });
      return !!purchase && purchase.status === 'POSTED';
    }
    case 'stock-count': {
      const count = await prisma.stockCount.findFirst({ where: { id: targetId, entityId }, select: { status: true } });
      return !!count && count.status !== 'DRAFT';
    }
    case 'fixed-asset':
      return !!(await prisma.fixedAsset.findFirst({ where: { id: targetId, entityId }, select: { id: true } }));
    default:
      return false;
  }
}

/** That the thing named actually belongs to this entity. */
async function targetExists(entityId: string, target: AttachmentTarget, targetId: string): Promise<boolean> {
  switch (target) {
    case 'invoice':
      return !!(await prisma.document.findFirst({ where: { id: targetId, entityId, kind: 'INVOICE' }, select: { id: true } }));
    case 'bill':
      return !!(await prisma.document.findFirst({ where: { id: targetId, entityId, kind: 'BILL' }, select: { id: true } }));
    case 'payment':
      return !!(await prisma.payment.findFirst({ where: { id: targetId, entityId }, select: { id: true } }));
    case 'journal':
      return !!(await prisma.journalEntry.findFirst({ where: { id: targetId, entityId }, select: { id: true } }));
    case 'agent-purchase':
      return !!(await prisma.agentPurchase.findFirst({ where: { id: targetId, entityId }, select: { id: true } }));
    case 'stock-count':
      return !!(await prisma.stockCount.findFirst({ where: { id: targetId, entityId }, select: { id: true } }));
    case 'fixed-asset':
      return !!(await prisma.fixedAsset.findFirst({ where: { id: targetId, entityId }, select: { id: true } }));
    default:
      return false;
  }
}

// --- uploading ---------------------------------------------------------------------------------

export type UploadInput = {
  fileName: string;
  contentType: string;
  /** The file, base64. Photographs are reduced in the browser before they get here. */
  base64: string;
  /** Where it belongs; 'inbox' to match it to something later. */
  target: AttachmentTarget;
  targetId?: string | null;
  note?: string;
};

/**
 * Put a file in storage and record it. The bytes go to the private bucket
 * under a key nobody can guess; the database keeps the name, the type, the
 * size and a checksum of exactly what was stored.
 *
 * The row is only written once the bytes are safely in storage, so a record
 * can never point at a file that is not there.
 */
export async function uploadAttachment(entityId: string, input: UploadInput): Promise<ActionResult<AttachmentRecord>> {
  return withEntityAccess(entityId, 'document:draft', (principal) =>
    refusable(async () => {
      if (!storageConfigured()) return fail('File storage is not configured on this server, so nothing can be attached yet.');
      if (!attachmentTargets.includes(input.target)) return fail('Unknown kind of attachment.');
      if (input.target !== 'inbox' && !input.targetId) return fail('Say what the file belongs to, or put it in the inbox.');

      let bytes: Buffer;
      try {
        bytes = Buffer.from(input.base64, 'base64');
      } catch {
        return fail('That file did not arrive properly. Try again.');
      }
      const checked = checkFile(input.contentType, bytes.byteLength);
      if (!checked.ok) return fail(checked.error);

      if (input.target !== 'inbox' && !(await targetExists(entityId, input.target, input.targetId as string))) {
        return fail(`That ${attachmentTargetLabels[input.target].toLowerCase()} does not belong to this entity.`);
      }

      const uploadedAt = new Date();
      const id = createHash('sha256').update(`${entityId}:${uploadedAt.toISOString()}:${input.fileName}:${Math.random()}`).digest('hex').slice(0, 24);
      const key = storageKey(entityId, uploadedAt.toISOString(), id, checked.extension);
      const checksum = createHash('sha256').update(bytes).digest('hex');

      // Storage first. A row that points at nothing is worse than no row.
      await putObject(key, new Uint8Array(bytes), input.contentType);

      const row = await prisma.$transaction(async (tx) => {
        const saved = await tx.attachment.create({
          data: {
            entityId,
            targetKind: targetToPrisma[input.target],
            targetId: input.target === 'inbox' ? null : (input.targetId as string),
            storageKey: key,
            fileName: safeFileName(input.fileName, checked.extension),
            contentType: input.contentType,
            byteSize: bytes.byteLength,
            checksum,
            note: input.note?.trim() || null,
            matchedAt: input.target === 'inbox' ? null : uploadedAt,
            uploadedById: principal.userId,
            uploadedAt,
          },
          include: attachmentInclude,
        });
        await recordAuditEvent(
          {
            entityId,
            userId: principal.userId,
            userName: principal.name,
            action: 'EDIT',
            resourceType: 'attachment',
            resourceRef: saved.fileName,
            summary: `${saved.fileName} (${(bytes.byteLength / 1024).toFixed(0)} KB) attached to ${input.target === 'inbox' ? 'the inbox' : attachmentTargetLabels[input.target].toLowerCase()}`,
            metadata: { storageKey: key, checksum, byteSize: bytes.byteLength, target: input.target, targetId: input.targetId ?? null },
          },
          tx,
        );
        return saved;
      });
      refresh();
      return { ok: true, value: attachmentRecord(row) };
    }),
  );
}

// --- matching out of the inbox ---------------------------------------------------------------------

/** Attach a file that was waiting in the inbox to the transaction it belongs to. */
export async function matchAttachment(entityId: string, attachmentId: string, target: AttachmentTarget, targetId: string): Promise<ActionResult<AttachmentRecord>> {
  return withEntityAccess(entityId, 'document:draft', (principal) =>
    refusable(async () => {
      if (target === 'inbox') return fail('Say what the file belongs to.');
      if (!attachmentTargets.includes(target)) return fail('Unknown kind of attachment.');
      if (!(await targetExists(entityId, target, targetId))) return fail(`That ${attachmentTargetLabels[target].toLowerCase()} does not belong to this entity.`);

      const row = await prisma.$transaction(async (tx) => {
        const attachment = await tx.attachment.findFirst({ where: { id: attachmentId, entityId } });
        if (!attachment) throw new StockRefusal('Unknown attachment.');
        if (attachment.targetKind !== 'INBOX') throw new StockRefusal(`That file is already attached to a ${attachmentTargetLabels[targetOf(attachment.targetKind)].toLowerCase()}.`);
        const saved = await tx.attachment.update({
          where: { id: attachment.id },
          data: { targetKind: targetToPrisma[target], targetId, matchedAt: new Date() },
          include: attachmentInclude,
        });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'MATCH', resourceType: 'attachment', resourceRef: saved.fileName, summary: `${saved.fileName} matched from the inbox to a ${attachmentTargetLabels[target].toLowerCase()}`, metadata: { target, targetId } },
          tx,
        );
        return saved;
      });
      refresh();
      return { ok: true, value: attachmentRecord(row) };
    }),
  );
}

/** Put a file back in the inbox — only while what it is attached to is unposted. */
export async function unmatchAttachment(entityId: string, attachmentId: string): Promise<ActionResult<AttachmentRecord>> {
  return withEntityAccess(entityId, 'document:draft', (principal) =>
    refusable(async () => {
      const attachment = await prisma.attachment.findFirst({ where: { id: attachmentId, entityId } });
      if (!attachment) return fail('Unknown attachment.');
      if (attachment.targetKind === 'INBOX') return fail('That file is already in the inbox.');
      const target = targetOf(attachment.targetKind);
      if (attachment.targetId && (await targetIsPosted(entityId, target, attachment.targetId))) {
        return fail('This has been posted, so its attachments stay. You can add more, but nothing can be taken away.');
      }

      const row = await prisma.$transaction(async (tx) => {
        const saved = await tx.attachment.update({ where: { id: attachment.id }, data: { targetKind: 'INBOX', targetId: null, matchedAt: null }, include: attachmentInclude });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'attachment', resourceRef: saved.fileName, summary: `${saved.fileName} put back in the inbox` }, tx);
        return saved;
      });
      refresh();
      return { ok: true, value: attachmentRecord(row) };
    }),
  );
}

// --- removing -----------------------------------------------------------------------------------------

/**
 * Take a file away. Only from the inbox or from something not yet posted, and
 * only by the person who put it there. The bytes go too: a file nobody can
 * reach is not worth paying to store.
 */
export async function removeAttachment(entityId: string, attachmentId: string): Promise<ActionResult<{ id: string }>> {
  return withEntityAccess(entityId, 'document:draft', (principal) =>
    refusable(async () => {
      const attachment = await prisma.attachment.findFirst({ where: { id: attachmentId, entityId } });
      if (!attachment) return fail('Unknown attachment.');
      const posted = attachment.targetId ? await targetIsPosted(entityId, targetOf(attachment.targetKind), attachment.targetId) : false;
      const gate = canRemove({ targetPosted: posted, uploadedByThem: attachment.uploadedById === principal.userId });
      if (!gate.ok) return fail(gate.error);

      await prisma.$transaction(async (tx) => {
        await tx.attachment.delete({ where: { id: attachment.id } });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'attachment', resourceRef: attachment.fileName, summary: `${attachment.fileName} removed before posting`, metadata: { storageKey: attachment.storageKey, checksum: attachment.checksum } },
          tx,
        );
      });
      // The row is gone either way; a file left behind in storage is untidy,
      // not dangerous, so a failure here does not undo the removal.
      try {
        await removeObject(attachment.storageKey);
      } catch {
        /* the object is orphaned; the record is what matters */
      }
      refresh();
      return { ok: true, value: { id: attachmentId } };
    }),
  );
}

// --- looking at one ------------------------------------------------------------------------------------

/** A link to the file that works for ten minutes and then stops. */
export async function attachmentUrl(entityId: string, attachmentId: string): Promise<ActionResult<{ url: string; fileName: string; contentType: string }>> {
  return withEntityAccess(entityId, 'reports:view', () =>
    refusable(async () => {
      const attachment = await prisma.attachment.findFirst({ where: { id: attachmentId, entityId } });
      if (!attachment) return fail('Unknown attachment.');
      return { ok: true, value: { url: await signedUrl(attachment.storageKey), fileName: attachment.fileName, contentType: attachment.contentType } };
    }),
  );
}

// --- the rules --------------------------------------------------------------------------------------------

export type RuleInput = { target: AttachmentTarget; thresholdMinor: number; isActive: boolean };

/**
 * When a kind of transaction must carry a document. The threshold is yours:
 * a bill over a set amount cannot be posted without one.
 */
export async function saveAttachmentRule(entityId: string, input: RuleInput): Promise<ActionResult<AttachmentRuleRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      if (!ruleTargets.includes(input.target)) return fail('A rule cannot be set against that.');
      const thresholdMinor = Math.round(Number(input.thresholdMinor));
      if (!(thresholdMinor >= 0)) return fail('A threshold cannot be negative.');

      const row = await prisma.$transaction(async (tx) => {
        const saved = await tx.attachmentRule.upsert({
          where: { entityId_targetKind: { entityId, targetKind: targetToPrisma[input.target] } },
          create: { entityId, targetKind: targetToPrisma[input.target], thresholdMinor: fromMinor(thresholdMinor), isActive: input.isActive },
          update: { thresholdMinor: fromMinor(thresholdMinor), isActive: input.isActive },
        });
        await recordAuditEvent(
          {
            entityId,
            userId: principal.userId,
            userName: principal.name,
            action: 'EDIT',
            resourceType: 'attachment-rule',
            resourceRef: input.target,
            summary: input.isActive
              ? `${attachmentTargetLabels[input.target]}: a document is required ${thresholdMinor > 0 ? `at ${(thresholdMinor / 100).toFixed(2)} and above` : 'on every one'}`
              : `${attachmentTargetLabels[input.target]}: the attachment rule was switched off`,
          },
          tx,
        );
        return saved;
      });
      refresh();
      return { ok: true, value: ruleRecord(row) };
    }),
  );
}

// --- the inbox ----------------------------------------------------------------------------------------------

export type InboxSuggestion = { attachmentId: string; fileName: string; candidates: Candidate[] };

/**
 * What each file in the inbox might belong to: anything whose reference is in
 * the file name, or failing that what is nearest to it in time.
 */
export async function inboxSuggestions(entityId: string): Promise<ActionResult<InboxSuggestion[]>> {
  return withEntityAccess(entityId, 'reports:view', () =>
    refusable(async () => {
      const waiting = await prisma.attachment.findMany({ where: { entityId, targetKind: 'INBOX' }, orderBy: { uploadedAt: 'desc' }, take: 100 });
      if (waiting.length === 0) return { ok: true, value: [] };

      const [documents, purchases] = await Promise.all([
        prisma.document.findMany({
          where: { entityId, status: { not: 'VOIDED' } },
          select: { id: true, kind: true, number: true, date: true, contact: { select: { name: true } }, journalEntry: { select: { lines: { select: { amountMinor: true, direction: true, account: { select: { code: true } } } } } } },
          orderBy: { date: 'desc' },
          take: 200,
        }),
        prisma.agentPurchase.findMany({ where: { entityId }, select: { id: true, clientRef: true, date: true, priceMinor: true, farmerName: true }, orderBy: { date: 'desc' }, take: 100 }),
      ]);

      const candidates: Candidate[] = [
        ...documents.map((document) => {
          const control = document.journalEntry?.lines.find((line) => line.account.code === '1010' || line.account.code === '2001');
          return {
            id: document.id,
            target: (document.kind === 'BILL' ? 'bill' : 'invoice') as AttachmentTarget,
            reference: document.number ?? '',
            date: document.date.toISOString().slice(0, 10),
            amountMinor: control ? Number(control.amountMinor) : 0,
          };
        }),
        ...purchases.map((purchase) => ({
          id: purchase.id,
          target: 'agent-purchase' as AttachmentTarget,
          reference: purchase.clientRef,
          date: purchase.date.toISOString().slice(0, 10),
          amountMinor: Number(purchase.priceMinor),
        })),
      ];

      return {
        ok: true,
        value: waiting.map((attachment) => ({
          attachmentId: attachment.id,
          fileName: attachment.fileName,
          candidates: suggestMatches({ fileName: attachment.fileName, uploadedAt: attachment.uploadedAt.toISOString() }, candidates),
        })),
      };
    }),
  );
}
