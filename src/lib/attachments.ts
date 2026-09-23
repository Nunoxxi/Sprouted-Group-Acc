/**
 * File attachments: what may be attached to what, how big a picture is
 * allowed to be, when a transaction must carry one, and where the file goes
 * in storage.
 *
 * Files live in cloud storage, never in the database. The database holds
 * where the file is, what it is, how big it was and its checksum — enough to
 * find it, serve it and prove it has not changed.
 *
 * An attachment on a posted transaction cannot be removed. Evidence that can
 * be taken away after the fact is not evidence.
 *
 * Pure: no I/O, no Prisma. Money is integer minor units throughout.
 */

// --- what can carry an attachment -----------------------------------------------------------

export type AttachmentTarget =
  | 'invoice'
  | 'bill'
  | 'payment'
  | 'journal'
  | 'agent-purchase'
  | 'stock-count'
  | 'fixed-asset'
  | 'inbox';

export const attachmentTargets: AttachmentTarget[] = ['invoice', 'bill', 'payment', 'journal', 'agent-purchase', 'stock-count', 'fixed-asset', 'inbox'];

export const attachmentTargetLabels: Record<AttachmentTarget, string> = {
  invoice: 'Customer invoice',
  bill: 'Supplier bill',
  payment: 'Payment',
  journal: 'Journal',
  'agent-purchase': 'Field purchase',
  'stock-count': 'Stock count',
  'fixed-asset': 'Asset',
  inbox: 'Not matched yet',
};

/** The ones a rule can be set against: the inbox is a waiting room, not a transaction. */
export const ruleTargets: AttachmentTarget[] = attachmentTargets.filter((target) => target !== 'inbox');

// --- what may be uploaded ---------------------------------------------------------------------

/**
 * PDFs and photographs. Nothing executable, nothing that a browser will run:
 * an accounting system is not a file share, and the only reason to accept a
 * file here is so a person can look at it later.
 */
export const acceptedTypes: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

/** After the browser has compressed a photograph, nothing should be near this. */
export const maxBytes = 10 * 1024 * 1024;

/** The longest edge a photograph is reduced to before it is uploaded. */
export const maxImageEdge = 1600;
/** JPEG quality for a compressed photograph: readable, not enormous. */
export const imageQuality = 0.82;

export function isImage(contentType: string): boolean {
  return contentType.startsWith('image/');
}

export type FileCheck = { ok: true; extension: string } | { ok: false; error: string };

/** Whether a file may be uploaded at all, and what it should be called. */
export function checkFile(contentType: string, byteSize: number): FileCheck {
  const extension = acceptedTypes[contentType.toLowerCase()];
  if (!extension) return { ok: false, error: 'Only PDFs and photographs can be attached.' };
  if (!(byteSize > 0)) return { ok: false, error: 'That file is empty.' };
  if (byteSize > maxBytes) return { ok: false, error: `That file is ${(byteSize / 1024 / 1024).toFixed(1)} MB. The most that can be attached is ${maxBytes / 1024 / 1024} MB.` };
  return { ok: true, extension };
}

/**
 * The size a photograph is reduced to: the longest edge capped, the shape
 * kept. A weighbridge ticket photographed on a phone is several thousand
 * pixels across and none of them are needed to read it.
 */
export function plannedSize(width: number, height: number, maxEdge = maxImageEdge): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxEdge / longest;
  return { width: Math.max(Math.round(width * scale), 1), height: Math.max(Math.round(height * scale), 1) };
}

/**
 * A file name safe to store and safe to send back as a download. Any path a
 * browser or phone put in front of it is dropped first: only the name of the
 * file itself is kept.
 */
export function safeFileName(name: string, extension: string): string {
  const base = name
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w\-. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'attachment'}.${extension}`;
}

/**
 * Where the file goes: under its entity, then the month it was uploaded, then
 * an id nobody can guess. The entity comes first so one entity's files can
 * never be listed by asking for another's.
 */
export function storageKey(entityId: string, uploadedAt: string, id: string, extension: string): string {
  return `${entityId}/${uploadedAt.slice(0, 7)}/${id}.${extension}`;
}

// --- when a transaction must carry one ----------------------------------------------------------

export type AttachmentRule = {
  target: AttachmentTarget;
  /** At or above this, an attachment is required. Zero means always. */
  thresholdMinor: number;
  isActive: boolean;
};

export type GateInput = {
  target: AttachmentTarget;
  /** The transaction's value, in the entity's functional currency. */
  amountMinor: number;
  attachmentCount: number;
};

export type Gate = { ok: true } | { ok: false; error: string };

/**
 * Whether a transaction may be posted. A rule names a kind and a threshold:
 * at or above it, something has to be attached. The check is on the absolute
 * value, so a credit of the same size is treated the same way.
 */
export function attachmentGate(rules: AttachmentRule[], input: GateInput): Gate {
  const rule = rules.find((candidate) => candidate.isActive && candidate.target === input.target && Math.abs(input.amountMinor) >= candidate.thresholdMinor);
  if (!rule) return { ok: true };
  if (input.attachmentCount > 0) return { ok: true };
  const label = attachmentTargetLabels[input.target].toLowerCase();
  return {
    ok: false,
    error:
      rule.thresholdMinor > 0
        ? `A ${label} of ${(Math.abs(input.amountMinor) / 100).toFixed(2)} or more needs a document attached. Attach one, or change the rule under Settings.`
        : `Every ${label} needs a document attached. Attach one, or change the rule under Settings.`,
  };
}

/** The rule that applies to a kind, if any. For showing a person what is expected. */
export function ruleFor(rules: AttachmentRule[], target: AttachmentTarget): AttachmentRule | null {
  return rules.find((rule) => rule.isActive && rule.target === target) ?? null;
}

// --- what may be taken away ------------------------------------------------------------------------

export type RemovalInput = {
  /** Whether the thing it is attached to has been posted. */
  targetPosted: boolean;
  /** Whether the person asking is the one who uploaded it. */
  uploadedByThem: boolean;
};

/**
 * An attachment on a posted transaction stays. Before posting, and in the
 * inbox, the person who put it there may take it away again — a photograph
 * of the wrong receipt is a mistake, not a record.
 */
export function canRemove(input: RemovalInput): Gate {
  if (input.targetPosted) return { ok: false, error: 'This has been posted, so its attachments stay. You can add more, but nothing can be taken away.' };
  if (!input.uploadedByThem) return { ok: false, error: 'Only the person who uploaded a file can remove it.' };
  return { ok: true };
}

// --- the inbox ----------------------------------------------------------------------------------------

export type InboxItem = {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  uploadedAt: string;
  note: string;
};

/**
 * What a file in the inbox might belong to. A receipt photographed on the
 * road is matched later, and the obvious candidates are the transactions
 * near it in time and, where the file name carries a number, the one whose
 * reference it mentions.
 */
export type Candidate = { id: string; target: AttachmentTarget; reference: string; date: string; amountMinor: number };

export function suggestMatches(item: Pick<InboxItem, 'fileName' | 'uploadedAt'>, candidates: Candidate[], withinDays = 30): Candidate[] {
  const haystack = item.fileName.toLowerCase();
  const byReference = candidates.filter((candidate) => candidate.reference && haystack.includes(candidate.reference.toLowerCase()));
  if (byReference.length) return byReference;
  const uploaded = Date.parse(`${item.uploadedAt.slice(0, 10)}T00:00:00Z`);
  return candidates
    .filter((candidate) => Math.abs(Date.parse(`${candidate.date}T00:00:00Z`) - uploaded) <= withinDays * 86_400_000)
    .sort((a, b) => Math.abs(Date.parse(`${a.date}T00:00:00Z`) - uploaded) - Math.abs(Date.parse(`${b.date}T00:00:00Z`) - uploaded))
    .slice(0, 8);
}
