/**
 * Ghana statutory tax rules for Sprouted Group.
 *
 * This is the single source of truth for the levy rule. The document entry
 * form, the journal builder, the tax reports and the test suite all call these
 * functions — there is deliberately no second implementation anywhere.
 *
 * Every amount in and out is an integer number of pesewas.
 */

export type VATTreatment = 'standard' | 'zero-rated' | 'exempt';
export type WithholdingTaxStatus = 'none' | '5%' | '10%' | 'exempt';
export type WithholdingRate = 0 | 0.05 | 0.1;

/**
 * The 20% effective rate is three separate levies charged on the same base.
 * They are assessed, reported and recovered independently, so each one is
 * rounded on its own rather than being carved out of a single 20% figure.
 */
export const GHANA_LEVY_RATES = {
  vat: 0.15,
  nhil: 0.025,
  getFund: 0.025,
} as const;

export type TaxBreakdown = {
  base: number;
  vat: number;
  nhil: number;
  getFund: number;
  totalTax: number;
  totalInclTax: number;
};

/**
 * Round to whole pesewas. Half-up on the absolute value so that a credit and a
 * debit of the same magnitude always round to the same number — Math.round
 * alone breaks that symmetry on negatives (it rounds -0.5 to -0).
 */
export function roundPesewas(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** The three levies charged on one taxable base. */
export function leviesOnBase(base: number, treatment: VATTreatment = 'standard'): TaxBreakdown {
  if (treatment === 'zero-rated' || treatment === 'exempt') {
    return { base, vat: 0, nhil: 0, getFund: 0, totalTax: 0, totalInclTax: base };
  }

  const vat = roundPesewas(base * GHANA_LEVY_RATES.vat);
  const nhil = roundPesewas(base * GHANA_LEVY_RATES.nhil);
  const getFund = roundPesewas(base * GHANA_LEVY_RATES.getFund);
  const totalTax = vat + nhil + getFund;

  return { base, vat, nhil, getFund, totalTax, totalInclTax: base + totalTax };
}

export function withholdingRateOf(status: WithholdingTaxStatus | undefined): WithholdingRate {
  if (status === '5%') return 0.05;
  if (status === '10%') return 0.1;
  return 0;
}

/** Withholding tax is charged on the tax-inclusive total, not the base. */
export function withholdingTaxOn(totalInclTax: number, rate: WithholdingRate): number {
  return rate > 0 ? roundPesewas(totalInclTax * rate) : 0;
}

// --- VAT registration ----------------------------------------------------------------

/**
 * Whether an entity charges and recovers VAT on a transaction. Registration
 * is per entity, off by default, and takes effect from the registration date:
 * a transaction dated before it is never taxed, however registered the entity
 * is now. Nothing here is ever applied retrospectively.
 */
export type VatRegistration = {
  vatRegistered: boolean;
  /** YYYY-MM-DD. Recorded when registration is switched on; null while unregistered. */
  vatRegisteredFrom: string | null;
};

export function vatAppliesOn(entity: VatRegistration, date: string): boolean {
  if (!entity.vatRegistered || !entity.vatRegisteredFrom) {
    return false;
  }
  return date >= entity.vatRegisteredFrom;
}

/**
 * Ghana's compulsory registration threshold for suppliers of goods: GHS
 * 750,000 of taxable supplies in any rolling twelve-month period. In pesewas.
 * Suppliers of services must register regardless of turnover; the settings
 * screen says so, because the app cannot decide which category an entity
 * falls into.
 */
export const VAT_REGISTRATION_THRESHOLD_MINOR = 750_000_00;

/** The tracker warns at these fractions of the threshold. */
export const VAT_THRESHOLD_WARNING_LEVELS = { warning: 0.75, critical: 0.9 } as const;

export type ThresholdLevel = 'clear' | 'warning' | 'critical' | 'exceeded';

export function thresholdStatus(turnoverMinor: number): { percent: number; level: ThresholdLevel } {
  const ratio = turnoverMinor / VAT_REGISTRATION_THRESHOLD_MINOR;
  const percent = Math.round(ratio * 1000) / 10;
  const level: ThresholdLevel =
    ratio >= 1 ? 'exceeded' : ratio >= VAT_THRESHOLD_WARNING_LEVELS.critical ? 'critical' : ratio >= VAT_THRESHOLD_WARNING_LEVELS.warning ? 'warning' : 'clear';
  return { percent, level };
}

/** A taxable supply: a sale that counts towards the registration threshold. Exempt supplies do not count. */
export type TaxableSupply = { date: string; baseMinor: number };

/** The day twelve months before `asOf`, exclusive: the window is (start, asOf]. */
export function rollingWindowStart(asOf: string): string {
  const [year, month, day] = asOf.split('-').map(Number);
  const start = new Date(Date.UTC(year - 1, month - 1, day));
  // 29 Feb minus a year lands on 1 Mar; pull it back to the last day of February.
  if (start.getUTCMonth() !== month - 1) {
    start.setUTCDate(0);
  }
  return start.toISOString().slice(0, 10);
}

/** Taxable turnover in the twelve months ending on `asOf`, inclusive. */
export function rollingTaxableTurnover(supplies: TaxableSupply[], asOf: string): number {
  const start = rollingWindowStart(asOf);
  return supplies.filter((supply) => supply.date > start && supply.date <= asOf).reduce((sum, supply) => sum + supply.baseMinor, 0);
}

/**
 * Import VAT is paid at the port as one figure, but it is the same three
 * levies at 15 + 2.5 + 2.5. Once registered they are recovered separately,
 * so the figure is split in those proportions; the rounding remainder goes
 * to VAT so the parts always sum to what was paid.
 */
export function splitImportLevies(importVatMinor: number): Pick<TaxBreakdown, 'vat' | 'nhil' | 'getFund'> {
  const totalRate = GHANA_LEVY_RATES.vat + GHANA_LEVY_RATES.nhil + GHANA_LEVY_RATES.getFund;
  const nhil = roundPesewas((importVatMinor * GHANA_LEVY_RATES.nhil) / totalRate);
  const getFund = roundPesewas((importVatMinor * GHANA_LEVY_RATES.getFund) / totalRate);
  return { vat: importVatMinor - nhil - getFund, nhil, getFund };
}
