/**
 * Multi-currency: the arithmetic and the rules. Pure — no database, no UI.
 *
 * Conventions used everywhere:
 * - A rate is "units of the *to* currency per 1 unit of the *from* currency",
 *   e.g. USD→GHS 12.5 means $1 = GH₵12.50. Rates are decimal strings and
 *   are applied with integer arithmetic scaled by 1e10, so a rate is exact
 *   and a converted amount is a whole pesewa (or cent) with one rounding.
 * - Every journal line carries the transaction currency and amount, the rate
 *   used, and the resulting functional amount. The functional amount is
 *   computed once, at posting, and stored; it is never recomputed from the
 *   rate later. A historic rate is history.
 * - Amounts are integers in minor units of *their* currency: pesewas for
 *   GHS, cents for USD and EUR.
 */

import type { JournalLineDraft } from './documents';

export const currencies = ['GHS', 'USD', 'EUR'] as const;
export type Currency = (typeof currencies)[number];

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (currencies as readonly string[]).includes(value);
}

export const currencySymbols: Record<Currency, string> = { GHS: 'GH₵', USD: '$', EUR: '€' };
export const currencyNames: Record<Currency, string> = { GHS: 'Ghana cedi', USD: 'US dollar', EUR: 'Euro' };

/** "GH₵ 1,234.56", "(US$ 12.00)" for negatives. Never a bare number. */
export function formatMoney(minor: number, currency: Currency): string {
  const numeric = new Intl.NumberFormat('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(minor) / 100);
  const text = `${currencySymbols[currency]} ${numeric}`;
  return minor < 0 ? `(${text})` : text;
}

// --- rates ---------------------------------------------------------------------------

export const RATE_DECIMALS = 10;
const RATE_SCALE = 10n ** BigInt(RATE_DECIMALS);

/** Parse a decimal rate string into its exact scaled integer. Throws on anything that is not a positive decimal. */
export function parseRate(rate: string | number): bigint {
  const text = typeof rate === 'number' ? rate.toString() : rate.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new RangeError(`Invalid exchange rate "${text}"`);
  }
  const [, whole, fraction = ''] = match;
  if (fraction.length > RATE_DECIMALS) {
    throw new RangeError(`Exchange rate "${text}" has more than ${RATE_DECIMALS} decimal places`);
  }
  const scaled = BigInt(whole) * RATE_SCALE + BigInt(fraction.padEnd(RATE_DECIMALS, '0'));
  if (scaled <= 0n) {
    throw new RangeError('Exchange rate must be positive');
  }
  return scaled;
}

/** Canonical text for a rate: no exponent, trailing zeros trimmed, at least one decimal. */
export function normalizeRate(rate: string | number): string {
  const scaled = parseRate(rate);
  const whole = scaled / RATE_SCALE;
  const fraction = (scaled % RATE_SCALE).toString().padStart(RATE_DECIMALS, '0').replace(/0+$/, '');
  return `${whole}.${fraction || '0'}`;
}

/** The inverse of a rate, to 10 decimal places. Marked as derived by callers. */
export function invertRate(rate: string): string {
  const scaled = parseRate(rate);
  // 1 / rate, scaled: RATE_SCALE * RATE_SCALE / scaled, rounded half up.
  const numerator = RATE_SCALE * RATE_SCALE;
  const inverted = (numerator + scaled / 2n) / scaled;
  return formatScaled(inverted);
}

function formatScaled(scaled: bigint): string {
  const whole = scaled / RATE_SCALE;
  const fraction = (scaled % RATE_SCALE).toString().padStart(RATE_DECIMALS, '0').replace(/0+$/, '');
  return `${whole}.${fraction || '0'}`;
}

/**
 * Convert a minor-unit amount at a rate. Exact: integer × scaled rate, then
 * one rounding (half away from zero) back to minor units.
 */
export function convertMinor(minor: number, rate: string | number): number {
  if (!Number.isInteger(minor)) {
    throw new RangeError(`Amount ${minor} is not a whole number of minor units`);
  }
  const scaled = parseRate(rate);
  const product = BigInt(minor) * scaled;
  const half = RATE_SCALE / 2n;
  const rounded = product >= 0n ? (product + half) / RATE_SCALE : -((-product + half) / RATE_SCALE);
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('Converted amount exceeds the safe integer range');
  }
  return result;
}

export type ExchangeRateRecord = {
  base: Currency;
  quote: Currency;
  /** YYYY-MM-DD */
  date: string;
  rate: string;
};

export type RateQuote = {
  rate: string;
  /** The date the rate was entered for. */
  rateDate: string;
  /** False when no rate exists for the requested date and a prior one was used. */
  exact: boolean;
  /** True when only the reverse pair was on file and the rate is its inverse. */
  inverted: boolean;
};

/**
 * The rate to default a transaction to: the pair's rate for that date, else
 * the most recent prior date (callers show a warning), else the inverse of
 * the reverse pair by the same rules, else null. Identity when from === to.
 */
export function selectRate(rates: readonly ExchangeRateRecord[], from: Currency, to: Currency, date: string): RateQuote | null {
  if (from === to) {
    return { rate: '1.0', rateDate: date, exact: true, inverted: false };
  }
  const direct = latestOnOrBefore(rates, from, to, date);
  if (direct) {
    return { rate: direct.rate, rateDate: direct.date, exact: direct.date === date, inverted: false };
  }
  const reverse = latestOnOrBefore(rates, to, from, date);
  if (reverse) {
    return { rate: invertRate(reverse.rate), rateDate: reverse.date, exact: reverse.date === date, inverted: true };
  }
  return null;
}

function latestOnOrBefore(rates: readonly ExchangeRateRecord[], base: Currency, quote: Currency, date: string) {
  let best: ExchangeRateRecord | undefined;
  for (const candidate of rates) {
    if (candidate.base !== base || candidate.quote !== quote || candidate.date > date) continue;
    if (!best || candidate.date > best.date) best = candidate;
  }
  return best;
}

// --- journal conversion ----------------------------------------------------------------

/** A journal line with both currencies on it: what the ledger stores. */
export type FxJournalLine = JournalLineDraft & {
  currency: Currency;
  /** Amount in the transaction currency, minor units. */
  txnAmount: number;
  /** Rate applied; '1.0' for functional-currency lines. */
  rate: string;
  /** Amount in the entity's functional currency, minor units. Stored forever. */
  functionalAmount: number;
};

/**
 * Convert a balanced journal from its transaction currency to functional
 * amounts at one rate. Each line is rounded on its own, so the total may be
 * off by a pesewa; the difference is put on `balancingAccountCode` (the
 * control account the document settles through) so the stored journal
 * balances exactly in both currencies.
 */
export function convertJournal(
  lines: readonly JournalLineDraft[],
  currency: Currency,
  functionalCurrency: Currency,
  rate: string,
  balancingAccountCode: string,
): FxJournalLine[] {
  const effectiveRate = currency === functionalCurrency ? '1.0' : normalizeRate(rate);
  const converted: FxJournalLine[] = lines.map((line) => ({
    ...line,
    currency,
    txnAmount: line.amount,
    rate: effectiveRate,
    functionalAmount: convertMinor(line.amount, effectiveRate),
    amount: convertMinor(line.amount, effectiveRate),
  }));

  const imbalance = converted.reduce((sum, line) => sum + (line.type === 'debit' ? line.functionalAmount : -line.functionalAmount), 0);
  if (imbalance !== 0) {
    const balancing = converted.find((line) => line.accountCode === balancingAccountCode);
    if (!balancing) {
      throw new Error(`Journal does not balance after conversion and has no ${balancingAccountCode} line to absorb ${imbalance}`);
    }
    // A debit line grows to absorb a credit surplus and vice versa.
    const adjustment = balancing.type === 'debit' ? -imbalance : imbalance;
    balancing.functionalAmount += adjustment;
    balancing.amount = balancing.functionalAmount;
  }
  return converted;
}

export function journalBalances(lines: readonly { type: 'debit' | 'credit'; functionalAmount: number }[]): boolean {
  return lines.reduce((sum, line) => sum + (line.type === 'debit' ? line.functionalAmount : -line.functionalAmount), 0) === 0;
}

// --- settlement: realised gains and losses --------------------------------------------

export const fxAccounts = {
  realised: '7010',
  unrealised: '7020',
} as const;

export type SettlementInput = {
  kind: 'invoice' | 'bill';
  documentCurrency: Currency;
  functionalCurrency: Currency;
  /** The rate the document was posted at. */
  documentRate: string;
  /** Amount being settled now, in the document currency. */
  txnAmount: number;
  /** The rate at settlement — what the bank actually gave, or the day's rate. */
  settlementRate: string;
  bankCurrency: Currency;
  /** Functional book value of the control account balance still open for this document. */
  remainingBookMinor: number;
  /** True when this payment clears the document: the relief is the exact remaining book value. */
  isFinal: boolean;
  controlAccountCode: string;
  bankAccountCode: string;
  names?: Record<string, string>;
};

export type Settlement = {
  /** Functional value of the receivable/payable being cleared (at the document's historic rate). */
  reliefMinor: number;
  /** Functional value of what the bank received or paid (at the settlement rate). */
  bankFunctionalMinor: number;
  /** Amount that hits the bank account, in the bank's own currency. */
  bankAmountMinor: number;
  /** Positive = gain, negative = loss, in functional currency. */
  gainLossMinor: number;
  lines: FxJournalLine[];
};

/**
 * The journal for settling (part of) a document, with the realised FX
 * difference. Invoice: Dr bank at today's rate, Cr receivable at the invoice
 * rate; the gap is a gain (credit 7010) or loss (debit 7010). Bill: mirrored.
 *
 * The bank must be in the document's currency or the functional currency;
 * a third currency would need a second rate and is refused.
 */
export function settlementFor(input: SettlementInput): Settlement {
  const { kind, documentCurrency, functionalCurrency, bankCurrency } = input;
  if (!Number.isInteger(input.txnAmount) || input.txnAmount <= 0) {
    throw new RangeError('Settlement amount must be a positive whole number of minor units');
  }
  if (bankCurrency !== documentCurrency && bankCurrency !== functionalCurrency) {
    throw new RangeError(`A ${documentCurrency} document cannot be settled through a ${bankCurrency} bank account`);
  }

  const documentRate = documentCurrency === functionalCurrency ? '1.0' : normalizeRate(input.documentRate);
  const settlementRate = documentCurrency === functionalCurrency ? '1.0' : normalizeRate(input.settlementRate);
  const name = (code: string, fallback: string) => input.names?.[code] ?? fallback;

  const reliefMinor = input.isFinal ? input.remainingBookMinor : convertMinor(input.txnAmount, documentRate);
  const bankFunctionalMinor = convertMinor(input.txnAmount, settlementRate);
  const bankAmountMinor = bankCurrency === functionalCurrency ? bankFunctionalMinor : input.txnAmount;

  // Invoice: we booked `relief` and received `bankFunctional`; more is a gain.
  // Bill: we booked `relief` and paid `bankFunctional`; more is a loss.
  const gainLossMinor = kind === 'invoice' ? bankFunctionalMinor - reliefMinor : reliefMinor - bankFunctionalMinor;

  const bankLine: FxJournalLine = {
    accountCode: input.bankAccountCode,
    accountName: name(input.bankAccountCode, 'Bank'),
    type: kind === 'invoice' ? 'debit' : 'credit',
    currency: bankCurrency,
    txnAmount: bankAmountMinor,
    rate: bankCurrency === functionalCurrency ? '1.0' : settlementRate,
    functionalAmount: bankFunctionalMinor,
    amount: bankFunctionalMinor,
  };
  const controlLine: FxJournalLine = {
    accountCode: input.controlAccountCode,
    accountName: name(input.controlAccountCode, kind === 'invoice' ? 'Trade Receivables' : 'Trade Payables'),
    type: kind === 'invoice' ? 'credit' : 'debit',
    currency: documentCurrency,
    txnAmount: input.txnAmount,
    rate: documentRate,
    functionalAmount: reliefMinor,
    amount: reliefMinor,
  };
  const lines = [bankLine, controlLine];
  if (gainLossMinor !== 0) {
    lines.push({
      accountCode: fxAccounts.realised,
      accountName: name(fxAccounts.realised, 'Realised Foreign Exchange Gain/Loss'),
      // A gain is income (credit); a loss is expense (debit).
      type: gainLossMinor > 0 ? 'credit' : 'debit',
      currency: functionalCurrency,
      txnAmount: Math.abs(gainLossMinor),
      rate: '1.0',
      functionalAmount: Math.abs(gainLossMinor),
      amount: Math.abs(gainLossMinor),
    });
  }

  return { reliefMinor, bankFunctionalMinor, bankAmountMinor, gainLossMinor, lines };
}

// --- period-end revaluation: unrealised gains and losses --------------------------------

/**
 * Accounts whose balances are money owed or held in a foreign currency and
 * therefore revalued at period end. Bank accounts are added by the caller
 * from BankAccount rows. Everything else — inventory, fixed assets, income,
 * expenses — is non-monetary and is never here.
 */
export const monetaryControlCodes: readonly string[] = [
  '1010', '1015', '1020', '1025', '1026', '1027', // receivables, incl. intercompany
  '2001', '2015', '2016', '2017', // payables, incl. intercompany
];

export type ForeignBalance = {
  accountCode: string;
  accountName?: string;
  currency: Currency;
  /** Net foreign balance, minor units; positive = debit balance. */
  foreignMinor: number;
  /** Net functional book value of that balance, positive = debit. */
  bookMinor: number;
};

export type RevaluationAdjustment = {
  accountCode: string;
  accountName?: string;
  currency: Currency;
  foreignMinor: number;
  bookMinor: number;
  closingRate: string;
  revaluedMinor: number;
  /** revalued − book; positive = unrealised gain on a debit balance. */
  differenceMinor: number;
  lines: FxJournalLine[];
};

/**
 * Revalue foreign-currency monetary balances at closing rates. Each
 * adjustment line carries the currency it revalues with a *zero* foreign
 * amount and the functional difference, so the foreign balance is untouched
 * and the next revaluation sees the true book value. Balances in the
 * functional currency and balances with no closing rate are skipped.
 */
export function revaluationFor(
  balances: readonly ForeignBalance[],
  closingRates: Partial<Record<Currency, string>>,
  functionalCurrency: Currency,
  names?: Record<string, string>,
): RevaluationAdjustment[] {
  const adjustments: RevaluationAdjustment[] = [];
  for (const balance of balances) {
    if (balance.currency === functionalCurrency) continue;
    const closingRate = closingRates[balance.currency];
    if (!closingRate) continue;
    const rate = normalizeRate(closingRate);
    const revaluedMinor = convertMinor(balance.foreignMinor, rate);
    const differenceMinor = revaluedMinor - balance.bookMinor;
    if (differenceMinor === 0) continue;

    const accountName = balance.accountName ?? names?.[balance.accountCode] ?? balance.accountCode;
    const unrealisedName = names?.[fxAccounts.unrealised] ?? 'Unrealised Foreign Exchange Gain/Loss';
    const magnitude = Math.abs(differenceMinor);
    // A debit balance that grew is a gain: Dr account, Cr unrealised. A debit
    // balance that shrank, or a credit balance that grew, is a loss.
    const accountDebit = differenceMinor > 0;
    adjustments.push({
      accountCode: balance.accountCode,
      accountName,
      currency: balance.currency,
      foreignMinor: balance.foreignMinor,
      bookMinor: balance.bookMinor,
      closingRate: rate,
      revaluedMinor,
      differenceMinor,
      lines: [
        {
          accountCode: balance.accountCode,
          accountName,
          type: accountDebit ? 'debit' : 'credit',
          currency: balance.currency,
          txnAmount: 0,
          rate,
          functionalAmount: magnitude,
          amount: magnitude,
        },
        {
          accountCode: fxAccounts.unrealised,
          accountName: unrealisedName,
          type: accountDebit ? 'credit' : 'debit',
          currency: functionalCurrency,
          txnAmount: magnitude,
          rate: '1.0',
          functionalAmount: magnitude,
          amount: magnitude,
        },
      ],
    });
  }
  return adjustments;
}

/**
 * Net foreign and functional balances per (account, currency) from stored
 * journal lines. `sign` is +1 for money in (debit), −1 for money out.
 */
export function foreignBalancesFrom(
  lines: readonly { accountCode: string; accountName?: string; currency: Currency; txnAmount: number; functionalAmount: number; type: 'debit' | 'credit' }[],
  monetaryCodes: ReadonlySet<string>,
  functionalCurrency: Currency,
): ForeignBalance[] {
  const buckets = new Map<string, ForeignBalance>();
  for (const line of lines) {
    if (!monetaryCodes.has(line.accountCode) || line.currency === functionalCurrency) continue;
    const key = `${line.accountCode}:${line.currency}`;
    const bucket = buckets.get(key) ?? { accountCode: line.accountCode, accountName: line.accountName, currency: line.currency, foreignMinor: 0, bookMinor: 0 };
    const sign = line.type === 'debit' ? 1 : -1;
    bucket.foreignMinor += sign * line.txnAmount;
    bucket.bookMinor += sign * line.functionalAmount;
    buckets.set(key, bucket);
  }
  return Array.from(buckets.values()).filter((bucket) => bucket.foreignMinor !== 0 || bucket.bookMinor !== 0);
}

// --- intercompany across currencies ------------------------------------------------------

export type IntercompanySide = {
  entityId: string;
  functionalCurrency: Currency;
  /** This entity's own functional amount for the transaction, signed: + owed to it, − owed by it. */
  functionalMinor: number;
};

export type IntercompanyPairBalance = {
  fromEntityId: string;
  toEntityId: string;
  /** What `from` books as owed to it by `to`, in from's functional currency. */
  balanceMinor: number;
  balanceCurrency: Currency;
  /** What `to` books as owed by it to `from`, in to's functional currency (negative). */
  mirroredMinor: number;
  mirroredCurrency: Currency;
  /** Same functional currency on both sides: the pair must net to zero. */
  sameCurrency: boolean;
  /** Same currency only: a non-zero net is a genuine mismatch. */
  mismatch: boolean;
  /**
   * Different currencies: the mirror translated into `from`'s currency at
   * the supplied rate, and the resulting difference — shown, not flagged.
   */
  translatedMirrorMinor: number | null;
  fxDifferenceMinor: number | null;
};

export type IntercompanyEntry = {
  fromEntityId: string;
  toEntityId: string;
  sides: IntercompanySide[];
};

/**
 * Pair balances for the matrix. Each side is summed in its own functional
 * currency. Two entities with the same functional currency must net to
 * zero and are flagged when they do not; two with different currencies
 * cannot net in one currency, so the mirror is translated at `rateFor` and
 * the difference is reported as an FX difference rather than an error.
 */
export function intercompanyPairBalances(
  entities: readonly { id: string; functionalCurrency: Currency }[],
  entries: readonly IntercompanyEntry[],
  rateFor: (from: Currency, to: Currency) => string | null,
): Map<string, IntercompanyPairBalance> {
  const currencyOf = new Map(entities.map((entity) => [entity.id, entity.functionalCurrency]));
  const totals = new Map<string, number>(); // `${entity}->${counterparty}` → entity's own functional net
  for (const entry of entries) {
    for (const side of entry.sides) {
      const counterparty = side.entityId === entry.fromEntityId ? entry.toEntityId : entry.fromEntityId;
      const key = `${side.entityId}->${counterparty}`;
      totals.set(key, (totals.get(key) ?? 0) + side.functionalMinor);
    }
  }

  const matrix = new Map<string, IntercompanyPairBalance>();
  for (const from of entities) {
    for (const to of entities) {
      if (from.id === to.id) continue;
      const balanceMinor = totals.get(`${from.id}->${to.id}`) ?? 0;
      const mirroredMinor = totals.get(`${to.id}->${from.id}`) ?? 0;
      const fromCurrency = currencyOf.get(from.id)!;
      const toCurrency = currencyOf.get(to.id)!;
      const sameCurrency = fromCurrency === toCurrency;
      let translatedMirrorMinor: number | null = null;
      let fxDifferenceMinor: number | null = null;
      if (!sameCurrency) {
        const rate = rateFor(toCurrency, fromCurrency);
        if (rate) {
          translatedMirrorMinor = convertMinor(mirroredMinor, rate);
          fxDifferenceMinor = balanceMinor + translatedMirrorMinor;
        }
      }
      matrix.set(`${from.id}->${to.id}`, {
        fromEntityId: from.id,
        toEntityId: to.id,
        balanceMinor,
        balanceCurrency: fromCurrency,
        mirroredMinor,
        mirroredCurrency: toCurrency,
        sameCurrency,
        mismatch: sameCurrency && balanceMinor + mirroredMinor !== 0,
        translatedMirrorMinor,
        fxDifferenceMinor,
      });
    }
  }
  return matrix;
}
