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
