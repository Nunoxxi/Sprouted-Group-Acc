/**
 * Ghanaian payroll: one employee, one pay period.
 *
 * Everything statutory comes from the RateBook — the StatutoryRate rows in
 * force on the last day of the period. There is no rate, band, relief, cap or
 * split in this file. If you find yourself typing a percentage here, it
 * belongs in the rates table and the catalogue in src/lib/payroll-rates.ts.
 *
 * Money is integer pesewas throughout; a rate is integer basis points (1750 is
 * 17.5%). Amounts paid or deducted — SSNIT, a prorated salary, a relief — are
 * each rounded half up to the pesewa where they arise, because each is a sum
 * of money that changes hands or is entered on a return. PAYE is different:
 * it is computed at full precision across every band (and any concessionary
 * rate) and rounded once, on the final figure, so the result is what GRA's
 * own calculation gives. The working shows each band rounded for display,
 * with any residue put on the last band, so the lines add up to the total
 * without the total being distorted.
 *
 * Pure: no I/O, no Prisma, no clock.
 */

import { firstDayOf, lastDayOf, PayrollRefusal, rateDefinition, type RateBook, type RateUsed } from './payroll-rates';

// --- inputs ----------------------------------------------------------------------------------

export type EmploymentType = 'permanent' | 'contract' | 'casual';
export type Residency = 'resident' | 'non-resident';
export type ProrationBasis = 'calendar-days' | 'working-days';
export type ReliefKind = 'marriage' | 'child-education' | 'aged-dependant' | 'disability' | 'old-age';
export type BenefitKind = 'vehicle' | 'vehicle-fuel' | 'accommodation' | 'accommodation-furnished';

export type Allowance = {
  name: string;
  /** For a full month; prorated with basic for a part month. */
  amountMinor: number;
  taxable: boolean;
  /** In the SSNIT and tier 2 base. Off unless the employee's contract puts it there. */
  pensionable: boolean;
};

/** What the entity has decided about its own payroll (PayrollSetting). */
export type EntityPayrollSettings = {
  prorationBasis: ProrationBasis;
  tier3Offered: boolean;
};

export type PayInput = {
  /** YYYY-MM. */
  period: string;
  settings: EntityPayrollSettings;
  employee: {
    name: string;
    employmentType: EmploymentType;
    residency: Residency;
    /** YYYY-MM-DD. */
    startDate: string;
    endDate: string | null;
    /** Marked by a person; the rates table decides whether their basic is low enough. */
    juniorStaffOvertime: boolean;
  };
  /** Contractual monthly basic. Always pensionable; it cannot be unflagged. */
  basicMinor: number;
  allowances: Allowance[];
  bonusMinor?: number;
  /** How much of this year's bonus concession earlier months have already used. */
  bonusConcessionUsedMinor?: number;
  overtimeMinor?: number;
  /** The employee's voluntary tier 3 contribution this month. */
  tier3Minor?: number;
  reliefs?: { kind: ReliefKind; count?: number }[];
  benefitsInKind?: BenefitKind[];
  /** Loan and advance instalments and anything else taken from net pay. */
  deductions?: { name: string; amountMinor: number }[];
};

// --- outputs ---------------------------------------------------------------------------------

export type WorkingStep = 'Proration' | 'Gross pay' | 'Pensionable base' | 'Employee SSNIT' | 'Tier 3' | 'Chargeable income' | 'PAYE' | 'Net pay' | 'Employer';

export type WorkingLine = {
  step: WorkingStep;
  label: string;
  /** Pesewas, as used in the calculation (or, for a PAYE band, as displayed). */
  amountMinor: number;
  /** How the figure was reached, in words, e.g. "5.5% of 4,000.00". */
  detail?: string;
  /**
   * For a figure that is a rate applied to a base: the base in pesewas, the
   * rate in basis points, and the exact result in pesewas before rounding,
   * e.g. "55416.725".
   */
  calc?: { baseMinor: number; rateBasisPoints: number; exact: string };
  /** A subtotal the lines above it add up to. */
  total?: boolean;
};

export type PayResult = {
  period: string;
  /** Days employed in the period and days in it, on the entity's basis; equal for a full month. */
  daysEmployed: number;
  daysInPeriod: number;
  prorationBasis: ProrationBasis;
  basicMinor: number;
  allowancesMinor: number;
  nonTaxableAllowancesMinor: number;
  bonusMinor: number;
  overtimeMinor: number;
  grossMinor: number;

  /** Basic plus pensionable allowances, before any ceiling. */
  pensionablePayMinor: number;
  /** What SSNIT and tier 2 are charged on: pensionable pay, capped at maximum insurable earnings. */
  ssnitBaseMinor: number;
  employeeSsnitMinor: number;
  tier3Minor: number;
  tier3DeductibleMinor: number;

  benefitsInKindMinor: number;
  /** Taxable pay less SSNIT and deductible tier 3, before reliefs. */
  assessableMinor: number;
  reliefsMinor: number;
  chargeableMinor: number;

  /** The parts of PAYE as displayed; they add up to payeMinor exactly. */
  incomeTaxMinor: number;
  bonusTaxMinor: number;
  overtimeTaxMinor: number;
  /** Computed at full precision and rounded once. */
  payeMinor: number;
  /** PAYE before that one rounding, in pesewas, e.g. "59349.975". */
  payeExact: string;
  /** The part of the bonus taxed at the concessionary rate, to carry into next month. */
  bonusConcessionMinor: number;
  /** Which rule taxed chargeable income. */
  taxBasis: 'resident-bands' | 'non-resident-bands' | 'non-resident-flat';

  deductionsMinor: number;
  netMinor: number;

  employerSsnitMinor: number;
  employerTier2Minor: number;
  /** Gross plus the employer's contributions: what the person cost. */
  employerCostMinor: number;

  working: WorkingLine[];
  ratesUsed: RateUsed[];
  /** Rates that took new figures part way through the period, applied to all of it. */
  ratesChangedWithin: { key: string; label: string; from: string }[];
};

// --- arithmetic ------------------------------------------------------------------------------

/** Exact pesewas × basis points: the result in ten-thousandths of a pesewa. */
function product(amountMinor: number, basisPoints: number): number {
  const value = amountMinor * basisPoints;
  if (!Number.isSafeInteger(value)) throw new RangeError('Amount too large to apply a rate to exactly');
  return value;
}

/** n ÷ d rounded half up, for non-negative integers. */
function divideHalfUp(n: number, d: number): number {
  const quotient = Math.floor(n / d);
  return (n - quotient * d) * 2 >= d ? quotient + 1 : quotient;
}

/** amount × basis points ÷ 10,000, rounded half up, in integers only. */
export function applyRate(amountMinor: number, basisPoints: number): number {
  if (!Number.isSafeInteger(amountMinor) || !Number.isSafeInteger(basisPoints)) throw new RangeError('applyRate takes whole pesewas and whole basis points');
  if (amountMinor < 0) return -applyRate(-amountMinor, basisPoints);
  return divideHalfUp(product(amountMinor, basisPoints), 10000);
}

/** Ten-thousandths of a pesewa as exact pesewas, e.g. 554167250 → "55416.725". */
function exactPesewas(tenThousandths: number): string {
  const whole = Math.floor(tenThousandths / 10000);
  const fraction = String(tenThousandths - whole * 10000).padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

const cedis = (minor: number) => {
  const sign = minor < 0 ? '−' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100).toLocaleString('en-GH')}.${String(abs % 100).padStart(2, '0')}`;
};
const pct = (basisPoints: number) => `${(basisPoints / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

const dayMs = 86_400_000;
const toTime = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** Days from one date to another inclusive, counting every day or only Monday to Friday. */
function countDays(from: string, to: string, basis: ProrationBasis): number {
  let count = 0;
  for (let time = toTime(from); time <= toTime(to); time += dayMs) {
    const weekday = new Date(time).getUTCDay();
    if (basis === 'calendar-days' || (weekday !== 0 && weekday !== 6)) count += 1;
  }
  return count;
}

const benefitKey: Record<BenefitKind, string> = {
  vehicle: 'bik.vehicle',
  'vehicle-fuel': 'bik.vehicle-fuel',
  accommodation: 'bik.accommodation',
  'accommodation-furnished': 'bik.accommodation-furnished',
};

export const reliefLabels: Record<ReliefKind, string> = {
  marriage: 'Marriage or dependent spouse',
  'child-education': 'Children’s education',
  'aged-dependant': 'Aged dependant',
  disability: 'Disability',
  'old-age': 'Old age',
};

/** The published SSNIT totals have to agree with the rates that are used. */
function checkSsnitTotals(rates: RateBook): { employee: number; employer: number; tier2: number } {
  const employee = rates.rate('ssnit.employee');
  const employer = rates.rate('ssnit.employer');
  const tier2 = rates.rate('ssnit.tier2');
  const checks: [string, number, number][] = [
    ['ssnit.tier1-total', rates.rate('ssnit.tier1-total'), employee + employer],
    ['ssnit.employer-total', rates.rate('ssnit.employer-total'), employer + tier2],
    ['ssnit.combined-total', rates.rate('ssnit.combined-total'), employee + employer + tier2],
  ];
  for (const [key, published, sum] of checks) {
    if (published !== sum) {
      throw new PayrollRefusal(`The SSNIT rates in force on ${rates.date} do not add up: ${rateDefinition(key).label} is ${pct(published)} but the rates come to ${pct(sum)}. Correct them under Settings → Payroll rates.`);
    }
  }
  return { employee, employer, tier2 };
}

// --- the calculation -------------------------------------------------------------------------

/**
 * One employee's pay for one period, in this order and no other:
 *
 *  0. Proration. Someone who joins or leaves part way through the period is
 *     paid basic and allowances for the days they were employed, counted on
 *     the entity's basis — calendar days, or Monday to Friday. Bonus and
 *     overtime are paid as entered.
 *
 *  1. Gross pay = basic salary + every cash allowance, taxable and not,
 *     + bonus + overtime. Benefits in kind are not cash and are not in gross.
 *
 *  2. Employee SSNIT = the employee rate × the pensionable base. The base is
 *     basic salary (always) plus any allowance flagged pensionable, capped at
 *     maximum insurable earnings when the rates table holds one. The published
 *     tier 1, employer and combined totals must agree with the rates.
 *
 *  3. Tier 3, where the entity offers it. Taken from pay in full; deductible
 *     for tax only up to the statutory cap (a share of basic salary).
 *
 *  4. Chargeable income = gross pay
 *        − non-taxable allowances
 *        − employee SSNIT − deductible tier 3
 *        − the part of a bonus within the concession     } taxed on their own
 *        − qualifying junior-staff overtime              } in step 5
 *        + benefits in kind (a share of basic + taxable allowances)
 *                                                       (= assessable income)
 *        − personal reliefs registered for the employee
 *     never below nil. Reliefs and the two concessions are for residents only.
 *
 *  5. PAYE, at full precision and rounded once:
 *     - A resident: the graduated bands, each band's slice at its own rate.
 *     - A non-resident: the bands or one flat rate, whichever the rates table
 *       says is the basis in force.
 *     - Plus the bonus within the concession at its final rate, and
 *       qualifying overtime at the lower rate up to a share of the month's
 *       basic and the upper rate beyond.
 *
 *  6. Net pay = gross − employee SSNIT − tier 3 − PAYE − other deductions
 *     (loan and advance instalments). A net below nil is refused.
 *
 *  7. Employer contributions — employer SSNIT and tier 2, each its rate × the
 *     same base as step 2 — are an employer cost on top of gross, never a
 *     deduction from the employee.
 *
 * Casual workers are not handled: the SSNIT and tax treatment is awaiting
 * confirmation, so a casual employee is refused rather than guessed at.
 *
 * Throws PayrollRefusal, naming what is missing, when a rate the employee
 * needs is not in force for the period.
 */
export function calculatePay(input: PayInput, rates: RateBook): PayResult {
  if (rates.period !== input.period) throw new Error('The rates are for a different period from the pay');
  const { employee, settings } = input;
  if (employee.employmentType === 'casual') {
    throw new PayrollRefusal(
      `${employee.name} is a casual worker. Casual workers cannot be paid through payroll yet: whether they are within SSNIT, and how their pay is taxed, is still being confirmed. Casual labour paid through a buying agent goes through the agent float.`,
    );
  }
  for (const [field, value] of [
    ['basic salary', input.basicMinor],
    ['bonus', input.bonusMinor ?? 0],
    ['overtime', input.overtimeMinor ?? 0],
    ['tier 3', input.tier3Minor ?? 0],
    ...input.allowances.map((a) => [a.name, a.amountMinor] as const),
    ...(input.deductions ?? []).map((d) => [d.name, d.amountMinor] as const),
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new PayrollRefusal(`${employee.name}: ${field} must be a whole number of pesewas, not negative.`);
  }
  if ((input.tier3Minor ?? 0) > 0 && !settings.tier3Offered) {
    throw new PayrollRefusal(`${employee.name} has a tier 3 contribution, but this entity does not offer tier 3. Switch it on in the payroll settings first.`);
  }

  const working: WorkingLine[] = [];
  const line = (entry: WorkingLine) => working.push(entry);
  const residentRules = employee.residency === 'resident';

  // 0. Proration -----------------------------------------------------------------------------
  const periodStart = firstDayOf(input.period);
  const periodEnd = lastDayOf(input.period);
  const from = employee.startDate > periodStart ? employee.startDate : periodStart;
  const to = employee.endDate && employee.endDate < periodEnd ? employee.endDate : periodEnd;
  if (from > to) throw new PayrollRefusal(`${employee.name} was not employed in ${input.period}.`);
  const basisWord = settings.prorationBasis === 'calendar-days' ? 'calendar days' : 'working days (Monday to Friday)';
  const daysInPeriod = countDays(periodStart, periodEnd, settings.prorationBasis);
  const daysEmployed = countDays(from, to, settings.prorationBasis);
  const part = (minor: number) => (daysEmployed === daysInPeriod ? minor : divideHalfUp(minor * daysEmployed, daysInPeriod));
  if (daysEmployed < daysInPeriod) {
    line({ step: 'Proration', label: `Employed ${from} to ${to}`, amountMinor: 0, detail: `${daysEmployed} of ${daysInPeriod} ${basisWord}; basic and allowances paid for those days` });
  }

  // 1. Gross pay -----------------------------------------------------------------------------
  const basic = part(input.basicMinor);
  line({ step: 'Gross pay', label: 'Basic salary', amountMinor: basic, detail: daysEmployed < daysInPeriod ? `${cedis(input.basicMinor)} × ${daysEmployed}/${daysInPeriod}` : undefined });
  let allowances = 0;
  let nonTaxable = 0;
  let taxableAllowances = 0;
  let pensionableAllowances = 0;
  for (const allowance of input.allowances) {
    const amount = part(allowance.amountMinor);
    allowances += amount;
    if (allowance.taxable) taxableAllowances += amount;
    else nonTaxable += amount;
    if (allowance.pensionable) pensionableAllowances += amount;
    line({ step: 'Gross pay', label: allowance.name, amountMinor: amount, detail: [allowance.taxable ? 'taxable' : 'not taxable', allowance.pensionable ? 'pensionable' : null].filter(Boolean).join(', ') });
  }
  const bonus = input.bonusMinor ?? 0;
  const overtime = input.overtimeMinor ?? 0;
  if (bonus) line({ step: 'Gross pay', label: 'Bonus', amountMinor: bonus });
  if (overtime) line({ step: 'Gross pay', label: 'Overtime', amountMinor: overtime });
  const gross = basic + allowances + bonus + overtime;
  line({ step: 'Gross pay', label: 'Gross pay', amountMinor: gross, total: true });

  // 2. Employee SSNIT ------------------------------------------------------------------------
  const ssnit = checkSsnitTotals(rates);
  const pensionablePay = basic + pensionableAllowances;
  const maxInsurable = rates.optionalAmount('ssnit.max-insurable');
  const ssnitBase = maxInsurable !== null && pensionablePay > maxInsurable ? maxInsurable : pensionablePay;
  line({ step: 'Pensionable base', label: 'Basic salary', amountMinor: basic });
  if (pensionableAllowances) line({ step: 'Pensionable base', label: 'Allowances marked pensionable', amountMinor: pensionableAllowances });
  if (ssnitBase < pensionablePay) line({ step: 'Pensionable base', label: 'Capped at maximum insurable earnings', amountMinor: ssnitBase - pensionablePay, detail: `ceiling ${cedis(maxInsurable!)}` });
  line({ step: 'Pensionable base', label: 'Pensionable base', amountMinor: ssnitBase, total: true });
  const employeeSsnit = applyRate(ssnitBase, ssnit.employee);
  line({
    step: 'Employee SSNIT',
    label: 'Employee SSNIT',
    amountMinor: employeeSsnit,
    detail: `${pct(ssnit.employee)} of ${cedis(ssnitBase)}`,
    calc: { baseMinor: ssnitBase, rateBasisPoints: ssnit.employee, exact: exactPesewas(product(ssnitBase, ssnit.employee)) },
  });

  // 3. Tier 3 --------------------------------------------------------------------------------
  const tier3 = input.tier3Minor ?? 0;
  let tier3Deductible = 0;
  if (tier3) {
    const capRate = rates.rate('tier3.deductible-cap');
    const cap = applyRate(basic, capRate);
    tier3Deductible = Math.min(tier3, cap);
    line({ step: 'Tier 3', label: 'Tier 3 contribution', amountMinor: tier3 });
    line({
      step: 'Tier 3',
      label: 'of which deductible for tax',
      amountMinor: tier3Deductible,
      detail: `cap ${pct(capRate)} of basic = ${cedis(cap)}`,
      calc: { baseMinor: basic, rateBasisPoints: capRate, exact: exactPesewas(product(basic, capRate)) },
    });
  }

  // 4. Chargeable income ---------------------------------------------------------------------
  const C = 'Chargeable income' as const;
  line({ step: C, label: 'Gross pay', amountMinor: gross });
  if (nonTaxable) line({ step: C, label: 'less allowances that are not taxable', amountMinor: -nonTaxable });
  line({ step: C, label: 'less employee SSNIT', amountMinor: -employeeSsnit });
  if (tier3Deductible) line({ step: C, label: 'less deductible tier 3', amountMinor: -tier3Deductible });

  // PAYE is assembled as exact parts (ten-thousandths of a pesewa) and rounded once at the end.
  type TaxPart = { label: string; detail: string; baseMinor: number; rateBasisPoints: number; exact: number; band: boolean };
  const taxParts: TaxPart[] = [];

  // Bonus: the part within this year's concession is taxed on its own.
  let bonusConcession = 0;
  if (bonus && residentRules) {
    const capRate = rates.rate('bonus.cap');
    const finalRate = rates.rate('bonus.final-rate');
    const annualCap = applyRate(input.basicMinor * 12, capRate);
    const remaining = Math.max(0, annualCap - (input.bonusConcessionUsedMinor ?? 0));
    bonusConcession = Math.min(bonus, remaining);
    line({
      step: C,
      label: 'less bonus taxed at the concessionary rate',
      amountMinor: -bonusConcession,
      detail: `limit ${pct(capRate)} of annual basic ${cedis(input.basicMinor * 12)} = ${cedis(annualCap)}, ${cedis(remaining)} left this year; the other ${cedis(bonus - bonusConcession)} stays in chargeable income`,
    });
    if (bonusConcession) {
      taxParts.push({ label: 'Bonus at the concessionary rate', detail: `${pct(finalRate)} of ${cedis(bonusConcession)}`, baseMinor: bonusConcession, rateBasisPoints: finalRate, exact: product(bonusConcession, finalRate), band: false });
    }
  }

  // Overtime: qualifying junior staff are taxed on it separately.
  let overtimeConcession = 0;
  if (overtime && residentRules && employee.juniorStaffOvertime) {
    const ceiling = rates.amount('overtime.eligible-max-basic');
    if (input.basicMinor <= ceiling) {
      const lowerShare = rates.rate('overtime.lower-cap');
      const lowerRate = rates.rate('overtime.lower-rate');
      const upperRate = rates.rate('overtime.upper-rate');
      const atLower = Math.min(overtime, applyRate(basic, lowerShare));
      overtimeConcession = overtime;
      line({ step: C, label: 'less junior-staff overtime, taxed separately', amountMinor: -overtime, detail: `basic ${cedis(input.basicMinor)} is within ${cedis(ceiling)}` });
      taxParts.push({ label: 'Overtime at the lower rate', detail: `${pct(lowerRate)} of ${cedis(atLower)} (up to ${pct(lowerShare)} of basic)`, baseMinor: atLower, rateBasisPoints: lowerRate, exact: product(atLower, lowerRate), band: false });
      if (overtime > atLower) {
        taxParts.push({ label: 'Overtime at the upper rate', detail: `${pct(upperRate)} of ${cedis(overtime - atLower)}`, baseMinor: overtime - atLower, rateBasisPoints: upperRate, exact: product(overtime - atLower, upperRate), band: false });
      }
    } else {
      line({ step: C, label: 'Overtime stays in chargeable income', amountMinor: 0, detail: `basic ${cedis(input.basicMinor)} is above the junior-staff ceiling ${cedis(ceiling)}` });
    }
  }

  // Benefits in kind: valued on total cash emoluments, not paid in cash.
  let benefits = 0;
  if (input.benefitsInKind?.length) {
    const emoluments = basic + taxableAllowances;
    for (const kind of input.benefitsInKind) {
      const { rateBasisPoints, capMinor } = rates.rateWithCap(benefitKey[kind]);
      const raw = applyRate(emoluments, rateBasisPoints);
      const value = capMinor !== null ? Math.min(raw, capMinor) : raw;
      benefits += value;
      line({
        step: C,
        label: `add ${rateDefinition(benefitKey[kind]).label.toLowerCase()} benefit`,
        amountMinor: value,
        detail: `${pct(rateBasisPoints)} of cash emoluments ${cedis(emoluments)}${capMinor !== null && raw > capMinor ? `, capped at ${cedis(capMinor)}` : ''}`,
        calc: { baseMinor: emoluments, rateBasisPoints, exact: exactPesewas(product(emoluments, rateBasisPoints)) },
      });
    }
  }

  const assessable = Math.max(0, gross - nonTaxable - employeeSsnit - tier3Deductible - bonusConcession - overtimeConcession + benefits);
  line({ step: C, label: 'Assessable income', amountMinor: assessable, total: true });

  // Personal reliefs, residents only.
  let reliefs = 0;
  if (residentRules) {
    for (const relief of input.reliefs ?? []) {
      const key = `relief.${relief.kind}`;
      let amount: number;
      let detail: string | undefined;
      let calc: WorkingLine['calc'];
      if (relief.kind === 'disability') {
        const rate = rates.rate(key);
        amount = applyRate(assessable, rate);
        detail = `${pct(rate)} of assessable income`;
        calc = { baseMinor: assessable, rateBasisPoints: rate, exact: exactPesewas(product(assessable, rate)) };
      } else if (relief.kind === 'child-education' || relief.kind === 'aged-dependant') {
        const each = rates.amount(key);
        const most = rates.maxCount(key);
        const count = Math.min(Math.max(0, Math.floor(relief.count ?? 1)), most);
        amount = each * count;
        detail = `${count} × ${cedis(each)}${(relief.count ?? 1) > most ? ` (no more than ${most})` : ''}`;
      } else {
        amount = rates.amount(key);
      }
      reliefs += amount;
      line({ step: C, label: `less relief: ${reliefLabels[relief.kind].toLowerCase()}`, amountMinor: -amount, detail, calc });
    }
  } else if (input.reliefs?.length) {
    line({ step: C, label: 'Personal reliefs do not apply', amountMinor: 0, detail: 'non-resident' });
  }
  const chargeable = Math.max(0, assessable - reliefs);
  line({ step: C, label: 'Chargeable income', amountMinor: chargeable, total: true, detail: assessable - reliefs < 0 ? 'reliefs exceed assessable income; nil' : undefined });

  // 5. PAYE ----------------------------------------------------------------------------------
  let taxBasis: PayResult['taxBasis'] = 'resident-bands';
  const incomeParts: TaxPart[] = [];
  if (!residentRules && rates.choice('paye.non-resident-basis') === 'flat') {
    taxBasis = 'non-resident-flat';
    const rate = rates.rate('paye.non-resident');
    incomeParts.push({ label: 'Non-resident flat rate', detail: `${pct(rate)} of ${cedis(chargeable)}`, baseMinor: chargeable, rateBasisPoints: rate, exact: product(chargeable, rate), band: true });
  } else {
    if (!residentRules) taxBasis = 'non-resident-bands';
    let left = chargeable;
    let floor = 0;
    for (const band of rates.bands()) {
      const slice = band.widthMinor === null ? left : Math.min(left, band.widthMinor);
      const range = band.widthMinor === null ? `above ${cedis(floor)}` : `${cedis(floor)} to ${cedis(floor + band.widthMinor)}`;
      incomeParts.push({ label: `Band ${range} at ${pct(band.rateBasisPoints)}`, detail: `${pct(band.rateBasisPoints)} of ${cedis(slice)}`, baseMinor: slice, rateBasisPoints: band.rateBasisPoints, exact: product(slice, band.rateBasisPoints), band: true });
      left -= slice;
      if (band.widthMinor !== null) floor += band.widthMinor;
      if (left === 0) break;
    }
  }
  if (taxBasis !== 'resident-bands') {
    line({ step: 'PAYE', label: taxBasis === 'non-resident-flat' ? 'Non-resident: taxed at one flat rate' : 'Non-resident: taxed on the resident bands', amountMinor: 0, detail: 'the basis set in the rates table' });
  }

  // Round once, on the total. Each part is shown rounded; the residue goes on the last band.
  const parts = [...incomeParts, ...taxParts];
  const exactTotal = parts.reduce((sum, p) => sum + p.exact, 0);
  if (!Number.isSafeInteger(exactTotal)) throw new RangeError('PAYE too large to compute exactly');
  const paye = divideHalfUp(exactTotal, 10000);
  const shown = parts.map((p) => divideHalfUp(p.exact, 10000));
  const lastBand = parts.map((p) => p.band).lastIndexOf(true);
  const residue = paye - shown.reduce((sum, value) => sum + value, 0);
  if (lastBand >= 0) shown[lastBand] += residue;
  parts.forEach((p, index) => {
    line({
      step: 'PAYE',
      label: p.label,
      amountMinor: shown[index],
      detail: index === lastBand && residue !== 0 ? `${p.detail}; includes ${residue > 0 ? '+' : ''}${residue} pesewa${Math.abs(residue) === 1 ? '' : 's'} so the lines add up to the total` : p.detail,
      calc: { baseMinor: p.baseMinor, rateBasisPoints: p.rateBasisPoints, exact: exactPesewas(p.exact) },
    });
  });
  line({ step: 'PAYE', label: 'PAYE', amountMinor: paye, total: true, detail: `${exactPesewas(exactTotal)} pesewas at full precision, rounded once` });
  const incomeTax = shown.slice(0, incomeParts.length).reduce((sum, value) => sum + value, 0);
  const bonusTax = taxParts.filter((p) => p.label.startsWith('Bonus')).reduce((sum, p) => sum + shown[parts.indexOf(p)], 0);
  const overtimeTax = paye - incomeTax - bonusTax;

  // 6. Net pay -------------------------------------------------------------------------------
  line({ step: 'Net pay', label: 'Gross pay', amountMinor: gross });
  line({ step: 'Net pay', label: 'less employee SSNIT', amountMinor: -employeeSsnit });
  if (tier3) line({ step: 'Net pay', label: 'less tier 3', amountMinor: -tier3 });
  line({ step: 'Net pay', label: 'less PAYE', amountMinor: paye ? -paye : 0 });
  let deductions = 0;
  for (const deduction of input.deductions ?? []) {
    deductions += deduction.amountMinor;
    line({ step: 'Net pay', label: `less ${deduction.name}`, amountMinor: -deduction.amountMinor });
  }
  const net = gross - employeeSsnit - tier3 - paye - deductions;
  if (net < 0) throw new PayrollRefusal(`${employee.name}'s deductions come to more than their pay for ${input.period} (net ${cedis(net)}). Reduce a loan instalment or the tier 3 contribution.`);
  line({ step: 'Net pay', label: 'Net pay', amountMinor: net, total: true });

  // 7. Employer contributions ---------------------------------------------------------------
  const employerSsnit = applyRate(ssnitBase, ssnit.employer);
  const employerTier2 = applyRate(ssnitBase, ssnit.tier2);
  line({ step: 'Employer', label: 'Employer SSNIT (tier 1)', amountMinor: employerSsnit, detail: `${pct(ssnit.employer)} of ${cedis(ssnitBase)}`, calc: { baseMinor: ssnitBase, rateBasisPoints: ssnit.employer, exact: exactPesewas(product(ssnitBase, ssnit.employer)) } });
  line({ step: 'Employer', label: 'Tier 2', amountMinor: employerTier2, detail: `${pct(ssnit.tier2)} of ${cedis(ssnitBase)}`, calc: { baseMinor: ssnitBase, rateBasisPoints: ssnit.tier2, exact: exactPesewas(product(ssnitBase, ssnit.tier2)) } });
  line({ step: 'Employer', label: 'Cost to the employer', amountMinor: gross + employerSsnit + employerTier2, total: true, detail: 'gross pay plus employer contributions' });

  return {
    period: input.period,
    daysEmployed,
    daysInPeriod,
    prorationBasis: settings.prorationBasis,
    basicMinor: basic,
    allowancesMinor: allowances,
    nonTaxableAllowancesMinor: nonTaxable,
    bonusMinor: bonus,
    overtimeMinor: overtime,
    grossMinor: gross,
    pensionablePayMinor: pensionablePay,
    ssnitBaseMinor: ssnitBase,
    employeeSsnitMinor: employeeSsnit,
    tier3Minor: tier3,
    tier3DeductibleMinor: tier3Deductible,
    benefitsInKindMinor: benefits,
    assessableMinor: assessable,
    reliefsMinor: reliefs,
    chargeableMinor: chargeable,
    incomeTaxMinor: incomeTax,
    bonusTaxMinor: bonusTax,
    overtimeTaxMinor: overtimeTax,
    payeMinor: paye,
    payeExact: exactPesewas(exactTotal),
    bonusConcessionMinor: bonusConcession,
    taxBasis,
    deductionsMinor: deductions,
    netMinor: net,
    employerSsnitMinor: employerSsnit,
    employerTier2Minor: employerTier2,
    employerCostMinor: gross + employerSsnit + employerTier2,
    working,
    ratesUsed: rates.used(),
    ratesChangedWithin: rates.changedWithin(),
  };
}
