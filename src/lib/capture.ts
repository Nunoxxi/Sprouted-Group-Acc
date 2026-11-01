/**
 * Documents sent from a phone: the capture page (/capture) that staff use on
 * the move to send in a supplier's bill, a customer invoice, an expense claim
 * or a receipt.
 *
 * A capture is not a transaction. It is a file with what the person said
 * about it — the kind, the amount, the date, a note — and it lands in the
 * entity's inbox for someone in finance to match or enter. Nothing posts.
 *
 * Pure: no I/O, no Prisma. Money is integer pesewas throughout.
 */

export type CaptureKind = 'bill' | 'invoice' | 'expense-claim' | 'receipt';

export const captureKinds: CaptureKind[] = ['bill', 'invoice', 'expense-claim', 'receipt'];

export const captureKindLabels: Record<CaptureKind, string> = {
  bill: 'Supplier bill',
  invoice: 'Customer invoice',
  'expense-claim': 'Expense claim',
  receipt: 'Receipt',
};

/** One line under each choice on the phone, in the words staff would use. */
export const captureKindHints: Record<CaptureKind, string> = {
  bill: 'A supplier wants paying',
  invoice: 'We billed a customer',
  'expense-claim': 'I paid and want it back',
  receipt: 'Proof of something already paid',
};

/** The most a phone can claim a document is for: GHS 100 million. A typo, not a bill. */
export const maxCaptureAmountMinor = 10_000_000_000;

/**
 * Cedis typed on a phone to pesewas. Blank is null (no amount given);
 * anything that is not a plain amount with at most two decimals is
 * undefined, so it is refused rather than quietly read as something else.
 */
export function parseCedis(text: string): number | null | undefined {
  const cleaned = text.trim().replace(/[₵\s]/g, '').replace(/^GHS/i, '').replace(/,/g, '');
  if (!cleaned) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const [whole, fraction = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export type CaptureDetails = {
  /** The phone's own reference, made when the capture is saved. */
  clientRef: string;
  kind: CaptureKind;
  amountMinor: number | null;
  /** YYYY-MM-DD, or null when the person did not say. */
  date: string | null;
  note: string;
};

export type CaptureCheck = { ok: true; value: CaptureDetails } | { ok: false; error: string };

/**
 * Whether what the phone sent can be kept. An expense claim needs an amount:
 * nobody can be paid back an unknown sum. A date may not be more than a day
 * ahead of the server's (a phone in another time zone is a day out at most).
 */
export function checkCapture(input: { clientRef: string; kind: string; amountMinor: number | null; date: string | null; note?: string }, today: string): CaptureCheck {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(input.clientRef)) return { ok: false, error: 'This capture has no reference. Take it again.' };
  if (!(captureKinds as string[]).includes(input.kind)) return { ok: false, error: 'Say what the document is.' };
  const kind = input.kind as CaptureKind;

  const amount = input.amountMinor;
  if (amount !== null && !(Number.isSafeInteger(amount) && amount > 0 && amount <= maxCaptureAmountMinor)) {
    return { ok: false, error: 'That amount cannot be right. Check it and try again.' };
  }
  if (kind === 'expense-claim' && amount === null) return { ok: false, error: 'An expense claim needs the amount you paid.' };

  let date: string | null = null;
  if (input.date) {
    const parsed = new Date(`${input.date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input.date) {
      return { ok: false, error: 'That date cannot be read.' };
    }
    const latest = new Date(`${today}T00:00:00Z`);
    latest.setUTCDate(latest.getUTCDate() + 1);
    if (parsed > latest) return { ok: false, error: 'That date is in the future.' };
    date = input.date;
  }

  const note = (input.note ?? '').trim().slice(0, 500);
  return { ok: true, value: { clientRef: input.clientRef, kind, amountMinor: amount, date, note } };
}
