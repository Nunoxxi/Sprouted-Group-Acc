/**
 * The statutory payroll rates: what each one means, and which are in force
 * for a given pay period.
 *
 * There are no figures in this file and there must never be any. The PAYE
 * bands, the SSNIT rates, the reliefs and every concessionary rate live in
 * the StatutoryRate table, each row dated, and are entered by a person who
 * has checked them against GRA and SSNIT. This file is the catalogue — what a
 * key is called, whether it holds a rate, an amount or both — and the lookup.
 *
 * The rates are national law, so they are held once for every entity.
 *
 * A pay period reads the rows in force on its last day. A rate may start on
 * any date — budget measures do not always start on the 1st — and when one
 * starts part way through a period the RateBook says so, so the working can
 * show it rather than leave it to be noticed.
 *
 * Pure: no I/O, no Prisma.
 */

// --- the catalogue ---------------------------------------------------------------------------

export type RateField = 'required' | 'optional' | 'none';

/** A setting the law leaves open, held in the table rather than decided in code. */
export type RateChoice = { value: string; label: string };

export type RateDefinition = {
  key: string;
  group: RateGroup;
  label: string;
  /** What the figure is applied to, in plain words, for the entry screen. */
  help: string;
  rate: RateField;
  amount: RateField;
  maxCount: RateField;
  /** Several rows make one set, e.g. the PAYE bands. */
  multiRow?: boolean;
  /** For a setting rather than a figure: the options, the first the default. */
  choices?: readonly RateChoice[];
  /** For a deadline: a day of the month after the pay period. */
  day?: 'required';
};

export const rateGroups = ['PAYE', 'SSNIT and pensions', 'Personal reliefs', 'Bonus', 'Overtime', 'Benefits in kind', 'Payment deadlines'] as const;
export type RateGroup = (typeof rateGroups)[number];

export const rateCatalogue: readonly RateDefinition[] = [
  {
    key: 'paye.band',
    group: 'PAYE',
    label: 'PAYE bands (resident)',
    help: 'Each band is the slice of monthly chargeable income taxed at its own rate, lowest first. The last band has no width: everything above the others.',
    rate: 'required',
    amount: 'optional',
    maxCount: 'none',
    multiRow: true,
  },
  {
    key: 'paye.non-resident-basis',
    group: 'PAYE',
    label: 'Non-resident basis',
    help: 'How a non-resident employee’s chargeable income is taxed. Unresolved — check the Income Tax Act and choose. Either way there are no personal reliefs and no bonus or overtime concession.',
    rate: 'none',
    amount: 'none',
    maxCount: 'none',
    choices: [
      { value: 'progressive', label: 'The resident bands' },
      { value: 'flat', label: 'One flat rate (below)' },
    ],
  },
  {
    key: 'paye.non-resident',
    group: 'PAYE',
    label: 'Non-resident flat rate',
    help: 'Used only when the non-resident basis is a flat rate: one rate on the whole of chargeable income.',
    rate: 'required',
    amount: 'none',
    maxCount: 'none',
  },
  {
    key: 'ssnit.employee',
    group: 'SSNIT and pensions',
    label: 'Employee SSNIT (tier 1)',
    help: 'Taken from the employee’s pay, on the pensionable base: basic salary plus any allowance marked pensionable.',
    rate: 'required',
    amount: 'none',
    maxCount: 'none',
  },
  {
    key: 'ssnit.employer',
    group: 'SSNIT and pensions',
    label: 'Employer SSNIT (tier 1)',
    help: 'Paid by the employer on top of pay, on the pensionable base. A cost to the company, not a deduction.',
    rate: 'required',
    amount: 'none',
    maxCount: 'none',
  },
  {
    key: 'ssnit.tier2',
    group: 'SSNIT and pensions',
    label: 'Employer tier 2',
    help: 'Paid by the employer to the tier 2 trustee, on the pensionable base.',
    rate: 'required',
    amount: 'none',
    maxCount: 'none',
  },
  {
    key: 'ssnit.tier1-total',
    group: 'SSNIT and pensions',
    label: 'Tier 1 total (check figure)',
    help: 'As published: employee plus employer tier 1. Not used to calculate anything — a payroll is refused if the rates above do not add up to it.',
    rate: 'required',
    amount: 'none',
    maxCount: 'none',
  },
  {
    key: 'ssnit.employer-total',
    group: 'SSNIT and pensions',
    label: 'Employer total (check figure)',
    help: 'As published: employer tier 1 plus tier 2. A payroll is refused if the rates above do not add up to it.',
    rate: 'required',
    amount: 'none',
    maxCount: 'none',
  },
  {
    key: 'ssnit.combined-total',
    group: 'SSNIT and pensions',
    label: 'Combined total (check figure)',
    help: 'As published: everything, employee and employer. A payroll is refused if the rates above do not add up to it.',
    rate: 'required',
    amount: 'none',
    maxCount: 'none',
  },
  {
    key: 'ssnit.max-insurable',
    group: 'SSNIT and pensions',
    label: 'Maximum insurable earnings',
    help: 'The most pensionable pay a month that SSNIT and tier 2 are charged on. Leave it out and there is no ceiling.',
    rate: 'none',
    amount: 'required',
    maxCount: 'none',
  },
  {
    key: 'tier3.deductible-cap',
    group: 'SSNIT and pensions',
    label: 'Tier 3 deductible cap',
    help: 'The share of basic salary an employee’s voluntary tier 3 contribution may reduce taxable income by. Anything above it is still taken from pay but is not deductible.',
    rate: 'required',
    amount: 'none',
    maxCount: 'none',
  },
  {
    key: 'relief.marriage',
    group: 'Personal reliefs',
    label: 'Marriage or dependent spouse',
    help: 'Taken off chargeable income each month for an employee who has registered it.',
    rate: 'none',
    amount: 'required',
    maxCount: 'none',
  },
  {
    key: 'relief.child-education',
    group: 'Personal reliefs',
    label: 'Children’s education',
    help: 'For each child, up to the most that may be claimed.',
    rate: 'none',
    amount: 'required',
    maxCount: 'required',
  },
  {
    key: 'relief.aged-dependant',
    group: 'Personal reliefs',
    label: 'Aged dependant',
    help: 'For each aged dependant, up to the most that may be claimed.',
    rate: 'none',
    amount: 'required',
    maxCount: 'required',
  },
  {
    key: 'relief.disability',
    group: 'Personal reliefs',
    label: 'Disability',
    help: 'A share of the employee’s assessable income (pay less SSNIT and deductible tier 3).',
    rate: 'required',
    amount: 'none',
    maxCount: 'none',
  },
  {
    key: 'relief.old-age',
    group: 'Personal reliefs',
    label: 'Old age',
    help: 'Taken off chargeable income each month for an employee who has registered it.',
    rate: 'none',
    amount: 'required',
    maxCount: 'none',
  },
  {
    key: 'bonus.cap',
    group: 'Bonus',
    label: 'Bonus concession limit',
    help: 'The share of annual basic salary that bonuses in a year may be taxed at the concessionary rate. Above it, the bonus joins chargeable income.',
    rate: 'required',
    amount: 'none',
    maxCount: 'none',
  },
  {
    key: 'bonus.final-rate',
    group: 'Bonus',
    label: 'Bonus concessionary rate',
    help: 'A final tax on the part of a bonus within the limit.',
    rate: 'required',
    amount: 'none',
    maxCount: 'none',
  },
  {
    key: 'overtime.eligible-max-basic',
    group: 'Overtime',
    label: 'Junior staff: highest monthly basic',
    help: 'An employee marked as qualifying junior staff gets the overtime rates only while their monthly basic is at or below this.',
    rate: 'none',
    amount: 'required',
    maxCount: 'none',
  },
  {
    key: 'overtime.lower-cap',
    group: 'Overtime',
    label: 'Overtime at the lower rate, as a share of basic',
    help: 'Overtime up to this share of the month’s basic is taxed at the lower rate; the rest at the upper rate.',
    rate: 'required',
    amount: 'none',
    maxCount: 'none',
  },
  {
    key: 'overtime.lower-rate',
    group: 'Overtime',
    label: 'Overtime lower rate',
    help: 'Final tax on overtime within the share of basic above.',
    rate: 'required',
    amount: 'none',
    maxCount: 'none',
  },
  {
    key: 'overtime.upper-rate',
    group: 'Overtime',
    label: 'Overtime upper rate',
    help: 'Final tax on the rest of a qualifying employee’s overtime.',
    rate: 'required',
    amount: 'none',
    maxCount: 'none',
  },
  {
    key: 'bik.vehicle',
    group: 'Benefits in kind',
    label: 'Vehicle',
    help: 'A share of total cash emoluments (basic plus taxable allowances), up to a monthly cap. Added to chargeable income; no cash changes hands.',
    rate: 'required',
    amount: 'optional',
    maxCount: 'none',
  },
  {
    key: 'bik.vehicle-fuel',
    group: 'Benefits in kind',
    label: 'Vehicle with fuel',
    help: 'As for a vehicle, where the employer also pays for fuel. Used instead of the vehicle rate, not as well.',
    rate: 'required',
    amount: 'optional',
    maxCount: 'none',
  },
  {
    key: 'bik.accommodation',
    group: 'Benefits in kind',
    label: 'Accommodation',
    help: 'A share of total cash emoluments, with an optional monthly cap.',
    rate: 'required',
    amount: 'optional',
    maxCount: 'none',
  },
  {
    key: 'bik.accommodation-furnished',
    group: 'Benefits in kind',
    label: 'Furnished accommodation',
    help: 'Used instead of the accommodation rate when it comes furnished.',
    rate: 'required',
    amount: 'optional',
    maxCount: 'none',
  },
  {
    key: 'deadline.paye',
    group: 'Payment deadlines',
    label: 'PAYE to GRA',
    help: 'The day of the month after the pay period that PAYE has to reach GRA, and what happens when it falls at a weekend.',
    rate: 'none',
    amount: 'none',
    maxCount: 'none',
    day: 'required',
    choices: [
      { value: 'as-is', label: 'Due that day, even at a weekend' },
      { value: 'next-working-day', label: 'Moves to the next working day' },
      { value: 'previous-working-day', label: 'Moves to the working day before' },
    ],
  },
  {
    key: 'deadline.ssnit-tier1',
    group: 'Payment deadlines',
    label: 'SSNIT tier 1',
    help: 'The day of the month after the pay period that tier 1 (employee and employer) has to reach SSNIT.',
    rate: 'none',
    amount: 'none',
    maxCount: 'none',
    day: 'required',
    choices: [
      { value: 'as-is', label: 'Due that day, even at a weekend' },
      { value: 'next-working-day', label: 'Moves to the next working day' },
      { value: 'previous-working-day', label: 'Moves to the working day before' },
    ],
  },
  {
    key: 'deadline.ssnit-tier2',
    group: 'Payment deadlines',
    label: 'Tier 2 to the trustee',
    help: 'The day of the month after the pay period that tier 2 has to reach the trustee.',
    rate: 'none',
    amount: 'none',
    maxCount: 'none',
    day: 'required',
    choices: [
      { value: 'as-is', label: 'Due that day, even at a weekend' },
      { value: 'next-working-day', label: 'Moves to the next working day' },
      { value: 'previous-working-day', label: 'Moves to the working day before' },
    ],
  },
  {
    key: 'deadline.tier3',
    group: 'Payment deadlines',
    label: 'Tier 3 to the provider',
    help: 'The day of the month after the pay period that tier 3 contributions have to reach the provider.',
    rate: 'none',
    amount: 'none',
    maxCount: 'none',
    day: 'required',
    choices: [
      { value: 'as-is', label: 'Due that day, even at a weekend' },
      { value: 'next-working-day', label: 'Moves to the next working day' },
      { value: 'previous-working-day', label: 'Moves to the working day before' },
    ],
  },
];

const definitionByKey = new Map(rateCatalogue.map((definition) => [definition.key, definition]));

export function rateDefinition(key: string): RateDefinition {
  const definition = definitionByKey.get(key);
  if (!definition) throw new Error(`Unknown statutory rate ${key}`);
  return definition;
}

// --- rows --------------------------------------------------------------------------------------

/** One row of the StatutoryRate table, as the rest of the app sees it. */
export type StatutoryRateRow = {
  id: string;
  key: string;
  sequence: number;
  /** YYYY-MM-DD. */
  effectiveFrom: string;
  /** YYYY-MM-DD, or null while in force. */
  effectiveTo: string | null;
  rateBasisPoints: number | null;
  amountMinor: number | null;
  maxCount: number | null;
  choice: string | null;
  dayOfMonth: number | null;
  isPlaceholder: boolean;
  source: string | null;
  note: string | null;
};

/** A payroll could not be worked out as asked. The message is for a person. */
export class PayrollRefusal extends Error {}

/** A real YYYY-MM-DD date, not 2026-02-30. */
export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function firstDayOf(period: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new PayrollRefusal(`${period} is not a pay period. Use YYYY-MM.`);
  return `${period}-01`;
}

export function lastDayOf(period: string): string {
  firstDayOf(period);
  const [year, month] = period.split('-').map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(days).padStart(2, '0')}`;
}

/** The day before a YYYY-MM-DD date. */
export function dayBefore(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

const inForceOn = (row: StatutoryRateRow, date: string) => row.effectiveFrom <= date && (row.effectiveTo === null || row.effectiveTo >= date);

/** A figure the calculation actually relied on, for the working and the payslip. */
export type RateUsed = {
  key: string;
  label: string;
  sequence: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  rateBasisPoints: number | null;
  amountMinor: number | null;
  choice: string | null;
  isPlaceholder: boolean;
};

/**
 * The rates in force for one pay period, read lazily: a calculation asks for
 * a key when it needs it, a key that has no row in force is refused by name,
 * and every row consulted is remembered so the working can say exactly which
 * figures — and which dates of them — produced the result.
 *
 * "In force for the period" means in force on its last day. A rate that
 * starts part way through the period therefore applies to the whole of it,
 * and changedWithin() names it so the working says so rather than leaving it
 * to be noticed.
 */
export class RateBook {
  readonly period: string;
  readonly date: string;
  private readonly all: readonly StatutoryRateRow[];
  private readonly rows: StatutoryRateRow[];
  private readonly consulted = new Map<string, StatutoryRateRow>();

  constructor(rows: readonly StatutoryRateRow[], period: string) {
    this.period = period;
    this.date = lastDayOf(period);
    this.all = rows;
    this.rows = rows.filter((row) => inForceOn(row, this.date));
  }

  private rowsFor(key: string): StatutoryRateRow[] {
    return this.rows.filter((row) => row.key === key).sort((a, b) => a.sequence - b.sequence);
  }

  private one(key: string, required: boolean): StatutoryRateRow | null {
    const found = this.rowsFor(key);
    if (found.length === 0) {
      if (!required) return null;
      throw new PayrollRefusal(`No “${rateDefinition(key).label}” is in force on ${this.date}. Enter it under Settings → Payroll rates.`);
    }
    if (found.length > 1) throw new PayrollRefusal(`More than one “${rateDefinition(key).label}” is in force on ${this.date}. Close one of them.`);
    this.consulted.set(`${key}#0`, found[0]);
    return found[0];
  }

  /** Basis points; refused if not in force. */
  rate(key: string): number {
    const row = this.one(key, true)!;
    if (row.rateBasisPoints === null) throw new PayrollRefusal(`“${rateDefinition(key).label}” in force on ${this.date} has no rate entered.`);
    return row.rateBasisPoints;
  }

  /** Pesewas; refused if not in force. */
  amount(key: string): number {
    const row = this.one(key, true)!;
    if (row.amountMinor === null) throw new PayrollRefusal(`“${rateDefinition(key).label}” in force on ${this.date} has no amount entered.`);
    return row.amountMinor;
  }

  /** Pesewas, or null when the key is not in force or has no amount (a cap that does not apply). */
  optionalAmount(key: string): number | null {
    return this.one(key, false)?.amountMinor ?? null;
  }

  /** A rate that may be capped: the rate is required, the cap is not. */
  rateWithCap(key: string): { rateBasisPoints: number; capMinor: number | null } {
    const rateBasisPoints = this.rate(key);
    return { rateBasisPoints, capMinor: this.rowsFor(key)[0].amountMinor };
  }

  maxCount(key: string): number {
    const row = this.one(key, true)!;
    if (row.maxCount === null) throw new PayrollRefusal(`“${rateDefinition(key).label}” in force on ${this.date} has no limit on how many may be claimed.`);
    return row.maxCount;
  }

  /** The option chosen for a setting; refused if not in force or not one of its options. */
  choice(key: string): string {
    const row = this.one(key, true)!;
    const options = rateDefinition(key).choices ?? [];
    if (!row.choice || !options.some((option) => option.value === row.choice)) {
      throw new PayrollRefusal(`“${rateDefinition(key).label}” in force on ${this.date} has no valid choice made.`);
    }
    return row.choice;
  }

  /** A deadline: the day of the following month and what a weekend does to it. */
  deadline(key: string): { dayOfMonth: number; weekend: string } {
    const weekend = this.choice(key);
    const row = this.one(key, true)!;
    if (row.dayOfMonth === null) throw new PayrollRefusal(`“${rateDefinition(key).label}” in force on ${this.date} has no day entered.`);
    return { dayOfMonth: row.dayOfMonth, weekend };
  }

  /** The resident PAYE bands, lowest first, checked to be a usable ladder. */
  bands(): { widthMinor: number | null; rateBasisPoints: number }[] {
    const rows = this.rowsFor('paye.band');
    if (rows.length === 0) throw new PayrollRefusal(`No PAYE bands are in force on ${this.date}. Enter them under Settings → Payroll rates.`);
    const problem = bandProblem(rows.map((row) => ({ widthMinor: row.amountMinor, rateBasisPoints: row.rateBasisPoints })));
    if (problem) throw new PayrollRefusal(`The PAYE bands in force on ${this.date} cannot be used: ${problem}`);
    rows.forEach((row) => this.consulted.set(`${row.key}#${row.sequence}`, row));
    return rows.map((row) => ({ widthMinor: row.amountMinor, rateBasisPoints: row.rateBasisPoints! }));
  }

  /** Rates consulted so far that took new figures after the first day of the period. */
  changedWithin(): { key: string; label: string; from: string }[] {
    const start = firstDayOf(this.period);
    const keys = [...new Set([...this.consulted.values()].map((row) => row.key))];
    const changes: { key: string; label: string; from: string }[] = [];
    for (const key of keys) {
      const starts = this.all.filter((row) => row.key === key && row.effectiveFrom > start && row.effectiveFrom <= this.date).map((row) => row.effectiveFrom).sort();
      if (starts.length) changes.push({ key, label: rateDefinition(key).label, from: starts[starts.length - 1] });
    }
    return changes;
  }

  /** Every row consulted so far, in catalogue order. */
  used(): RateUsed[] {
    const order = new Map(rateCatalogue.map((definition, index) => [definition.key, index]));
    return [...this.consulted.values()]
      .sort((a, b) => order.get(a.key)! - order.get(b.key)! || a.sequence - b.sequence)
      .map((row) => ({
        key: row.key,
        label: rateDefinition(row.key).label,
        sequence: row.sequence,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        rateBasisPoints: row.rateBasisPoints,
        amountMinor: row.amountMinor,
        choice: row.choice,
        isPlaceholder: row.isPlaceholder,
      }));
  }
}

// --- validation -------------------------------------------------------------------------------

/** What a band ladder needs: every band but the last has a width, the last has none. */
export function bandProblem(bands: { widthMinor: number | null; rateBasisPoints: number | null }[]): string | null {
  if (bands.length === 0) return 'there are no bands.';
  for (const [index, band] of bands.entries()) {
    const last = index === bands.length - 1;
    if (band.rateBasisPoints === null) return `band ${index + 1} has no rate.`;
    if (!last && (band.widthMinor === null || band.widthMinor <= 0)) return `band ${index + 1} needs a width; only the last band is open-ended.`;
    if (last && band.widthMinor !== null) return 'the last band must have no width — it is everything above the others.';
  }
  return null;
}

export type RateVersionInput = {
  key: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  /** One row, or several for a multi-row key such as the PAYE bands. */
  rows: { rateBasisPoints: number | null; amountMinor: number | null; maxCount: number | null; choice?: string | null; dayOfMonth?: number | null }[];
};

/** Everything wrong with a new set of figures for one key, in plain words. */
export function validateRateVersion(input: RateVersionInput): string[] {
  const definition = definitionByKey.get(input.key);
  if (!definition) return [`${input.key} is not a statutory rate the app knows.`];
  const problems: string[] = [];
  if (!isDate(input.effectiveFrom)) problems.push('Give the date the figures take effect.');
  if (input.effectiveTo) {
    if (!isDate(input.effectiveTo)) problems.push('That end date is not a date.');
    else if (input.effectiveTo < input.effectiveFrom) problems.push('It cannot end before it starts.');
  }
  if (input.rows.length === 0) problems.push('Enter at least one figure.');
  if (!definition.multiRow && input.rows.length > 1) problems.push(`${definition.label} is a single figure.`);

  for (const [index, row] of input.rows.entries()) {
    const where = definition.multiRow ? `Band ${index + 1}: ` : '';
    if (row.rateBasisPoints !== null && (!Number.isInteger(row.rateBasisPoints) || row.rateBasisPoints < 0 || row.rateBasisPoints > 10000)) {
      problems.push(`${where}a rate is between 0% and 100%, to two decimal places.`);
    }
    if (row.amountMinor !== null && (!Number.isInteger(row.amountMinor) || row.amountMinor < 0)) problems.push(`${where}an amount is a positive figure in cedis and pesewas.`);
    if (row.maxCount !== null && (!Number.isInteger(row.maxCount) || row.maxCount < 1)) problems.push(`${where}the limit is a whole number, at least 1.`);
    if (definition.rate === 'required' && row.rateBasisPoints === null) problems.push(`${where}enter the rate.`);
    if (definition.rate === 'none' && row.rateBasisPoints !== null) problems.push(`${where}${definition.label} has no rate.`);
    if (definition.amount === 'required' && row.amountMinor === null) problems.push(`${where}enter the amount.`);
    if (definition.amount === 'none' && row.amountMinor !== null) problems.push(`${where}${definition.label} has no amount.`);
    if (definition.maxCount === 'required' && row.maxCount === null) problems.push(`${where}enter how many may be claimed.`);
    if (definition.choices && !definition.choices.some((option) => option.value === row.choice)) {
      problems.push(`Choose one of: ${definition.choices.map((option) => option.label).join(', ')}.`);
    }
    if (!definition.choices && row.choice) problems.push(`${definition.label} is a figure, not a choice.`);
    if (definition.day && !(Number.isInteger(row.dayOfMonth) && row.dayOfMonth! >= 1 && row.dayOfMonth! <= 31)) problems.push('Enter the day of the month, 1 to 31.');
    if (!definition.day && row.dayOfMonth != null) problems.push(`${definition.label} has no day of the month.`);
  }
  if (input.key === 'paye.band' && problems.length === 0) {
    const problem = bandProblem(input.rows.map((row) => ({ widthMinor: row.amountMinor, rateBasisPoints: row.rateBasisPoints })));
    if (problem) problems.push(`The bands cannot be used: ${problem}`);
  }
  return problems;
}

/**
 * Where a new version of a key fits among the ones already held. A new version
 * has to start after every version already there — history is added to, not
 * rewritten — and the one in force until then is closed the day before.
 */
export function placeVersion(existing: readonly StatutoryRateRow[], key: string, effectiveFrom: string): { closeIds: string[]; closeOn: string } | { problem: string } {
  const ofKey = existing.filter((row) => row.key === key);
  const latest = ofKey.reduce<string | null>((max, row) => (max === null || row.effectiveFrom > max ? row.effectiveFrom : max), null);
  if (latest !== null && effectiveFrom <= latest) {
    return { problem: `${rateDefinition(key).label} already has figures from ${latest}. A new set has to start after that.` };
  }
  const closeOn = dayBefore(effectiveFrom);
  const overlapping = ofKey.filter((row) => row.effectiveTo === null || row.effectiveTo >= effectiveFrom);
  return { closeIds: overlapping.map((row) => row.id), closeOn };
}

// --- formatting ---------------------------------------------------------------------------------

/** 1750 → "17.5%". */
export function percent(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** "17.5" or "17.50" → 1750; null for blank; NaN for nonsense (validation refuses it). */
export function basisPointsFrom(text: string): number | null {
  const trimmed = text.trim().replace(/%$/, '');
  if (trimmed === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return Number.NaN;
  const [whole, fraction = ''] = trimmed.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
