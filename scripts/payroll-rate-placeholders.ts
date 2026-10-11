/**
 * PLACEHOLDER statutory payroll figures. Seed data, not code.
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │  NOTHING IN THIS FILE IS A VERIFIED RATE.                                │
 * │  Every row is seeded with isPlaceholder = true. A payroll using a        │
 * │  placeholder can be calculated but never approved. An Owner checks each  │
 * │  figure against GRA and SSNIT under Settings → Payroll rates, corrects   │
 * │  it if needed and marks it verified with its source.                     │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * A best recollection of the published Ghanaian figures, put in so the
 * screens and the worked examples have something realistic to show. They may
 * be out of date or wrong. The app never reads this file — only the seed
 * script does, once, into an empty table.
 */

export const PLACEHOLDER_EFFECTIVE_FROM = '2026-01-01';
export const PLACEHOLDER_NOTE = 'PLACEHOLDER — not verified. Check against GRA / SSNIT before any payroll is approved.';

/** cedis → pesewas, for readability below. */
const ghs = (cedis: number) => Math.round(cedis * 100);
/** percent → basis points. */
const bp = (percent: number) => Math.round(percent * 100);

export type PlaceholderRate = { key: string; sequence?: number; rate?: number; amount?: number; maxCount?: number; choice?: string; dayOfMonth?: number };

export const placeholderRates: PlaceholderRate[] = [
  // PAYE, resident, monthly bands: the width of each slice, the last open-ended.
  { key: 'paye.band', sequence: 0, amount: ghs(490), rate: bp(0) },
  { key: 'paye.band', sequence: 1, amount: ghs(110), rate: bp(5) },
  { key: 'paye.band', sequence: 2, amount: ghs(130), rate: bp(10) },
  { key: 'paye.band', sequence: 3, amount: ghs(3166.67), rate: bp(17.5) },
  { key: 'paye.band', sequence: 4, amount: ghs(16000), rate: bp(25) },
  { key: 'paye.band', sequence: 5, amount: ghs(30520), rate: bp(30) },
  { key: 'paye.band', sequence: 6, rate: bp(35) },
  // Unresolved: progressive by default until the Income Tax Act is checked.
  { key: 'paye.non-resident-basis', choice: 'progressive' },
  { key: 'paye.non-resident', rate: bp(25) },

  // SSNIT: employee 5.5% + employer 8% to tier 1 (13.5%), employer 5% to tier 2.
  { key: 'ssnit.employee', rate: bp(5.5) },
  { key: 'ssnit.employer', rate: bp(8) },
  { key: 'ssnit.tier2', rate: bp(5) },
  { key: 'ssnit.tier1-total', rate: bp(13.5) },
  { key: 'ssnit.employer-total', rate: bp(13) },
  { key: 'ssnit.combined-total', rate: bp(18.5) },
  { key: 'ssnit.max-insurable', amount: ghs(61000) },
  { key: 'tier3.deductible-cap', rate: bp(16.5) },

  // Personal reliefs, as monthly amounts (annual figure ÷ 12).
  { key: 'relief.marriage', amount: ghs(100) },
  { key: 'relief.child-education', amount: ghs(50), maxCount: 3 },
  { key: 'relief.aged-dependant', amount: ghs(83.33), maxCount: 2 },
  { key: 'relief.disability', rate: bp(25) },
  { key: 'relief.old-age', amount: ghs(125) },

  { key: 'bonus.cap', rate: bp(15) },
  { key: 'bonus.final-rate', rate: bp(5) },

  { key: 'overtime.eligible-max-basic', amount: ghs(1500) },
  { key: 'overtime.lower-cap', rate: bp(50) },
  { key: 'overtime.lower-rate', rate: bp(5) },
  { key: 'overtime.upper-rate', rate: bp(10) },

  { key: 'bik.vehicle', rate: bp(5), amount: ghs(500) },
  { key: 'bik.vehicle-fuel', rate: bp(12.5), amount: ghs(1000) },
  { key: 'bik.accommodation', rate: bp(10) },
  { key: 'bik.accommodation-furnished', rate: bp(12.5) },

  // Deadlines: a day of the month after the pay period, and what a weekend does.
  { key: 'deadline.paye', dayOfMonth: 15, choice: 'as-is' },
  { key: 'deadline.ssnit-tier1', dayOfMonth: 14, choice: 'as-is' },
  { key: 'deadline.ssnit-tier2', dayOfMonth: 14, choice: 'as-is' },
  { key: 'deadline.tier3', dayOfMonth: 14, choice: 'as-is' },
];
