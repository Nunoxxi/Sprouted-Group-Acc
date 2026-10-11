/**
 * The payroll calculation: one employee, one period, against dated rates.
 *
 * The rates below are test fixtures, not the real Ghanaian figures — the
 * engine never holds a rate of its own, and these tests prove it does what
 * the rows say. Every expected figure is worked by hand in the comment beside
 * it, in cedis, so a reader can check the arithmetic without running anything.
 *
 * Every test also checks the identity the payroll journal stands on: every
 * pesewa of gross pay is net pay or a deduction.
 */

import { describe, expect, it } from 'vitest';

import { applyRate, calculatePay, type EntityPayrollSettings, type PayInput, type PayResult } from '@/lib/payroll-engine';
import { basisPointsFrom, placeVersion, RateBook, PayrollRefusal, validateRateVersion, type StatutoryRateRow } from '@/lib/payroll-rates';

const ghs = (cedis: number) => Math.round(cedis * 100);
const bp = (percent: number) => Math.round(percent * 100);

let nextId = 0;
function row(key: string, from: string, to: string | null, values: { rate?: number; amount?: number; maxCount?: number; sequence?: number; choice?: string }): StatutoryRateRow {
  return {
    id: `r${nextId++}`,
    key,
    sequence: values.sequence ?? 0,
    effectiveFrom: from,
    effectiveTo: to,
    rateBasisPoints: values.rate === undefined ? null : bp(values.rate),
    amountMinor: values.amount === undefined ? null : ghs(values.amount),
    maxCount: values.maxCount ?? null,
    choice: values.choice ?? null,
    dayOfMonth: null,
    isPlaceholder: false,
    source: 'test fixture',
    note: null,
  };
}

type SetOptions = { bands?: [number | null, number][]; employeeSsnit?: number; employerSsnit?: number; nonResident?: 'progressive' | 'flat'; tier1Total?: number };

/** A full set of rates, in force from `from` to `to`. */
function rateSet(from: string, to: string | null, options: SetOptions = {}): StatutoryRateRow[] {
  const bands = options.bands ?? [
    [490, 0],
    [110, 5],
    [130, 10],
    [3166.67, 17.5],
    [16000, 25],
    [30520, 30],
    [null, 35],
  ];
  const employee = options.employeeSsnit ?? 5.5;
  const employer = options.employerSsnit ?? 8;
  return [
    ...bands.map(([width, rate], sequence) => row('paye.band', from, to, { sequence, rate, amount: width ?? undefined })),
    row('paye.non-resident-basis', from, to, { choice: options.nonResident ?? 'progressive' }),
    row('paye.non-resident', from, to, { rate: 25 }),
    row('ssnit.employee', from, to, { rate: employee }),
    row('ssnit.employer', from, to, { rate: employer }),
    row('ssnit.tier2', from, to, { rate: 5 }),
    row('ssnit.tier1-total', from, to, { rate: options.tier1Total ?? employee + employer }),
    row('ssnit.employer-total', from, to, { rate: employer + 5 }),
    row('ssnit.combined-total', from, to, { rate: employee + employer + 5 }),
    row('ssnit.max-insurable', from, to, { amount: 61000 }),
    row('tier3.deductible-cap', from, to, { rate: 16.5 }),
    row('relief.marriage', from, to, { amount: 100 }),
    row('relief.child-education', from, to, { amount: 50, maxCount: 3 }),
    row('relief.aged-dependant', from, to, { amount: 83.33, maxCount: 2 }),
    row('relief.disability', from, to, { rate: 25 }),
    row('relief.old-age', from, to, { amount: 125 }),
    row('bonus.cap', from, to, { rate: 15 }),
    row('bonus.final-rate', from, to, { rate: 5 }),
    row('overtime.eligible-max-basic', from, to, { amount: 1500 }),
    row('overtime.lower-cap', from, to, { rate: 50 }),
    row('overtime.lower-rate', from, to, { rate: 5 }),
    row('overtime.upper-rate', from, to, { rate: 10 }),
    row('bik.vehicle', from, to, { rate: 5, amount: 500 }),
    row('bik.vehicle-fuel', from, to, { rate: 12.5, amount: 1000 }),
    row('bik.accommodation', from, to, { rate: 10 }),
    row('bik.accommodation-furnished', from, to, { rate: 12.5 }),
  ];
}

const rates2026 = rateSet('2026-01-01', null);
const calendar: EntityPayrollSettings = { prorationBasis: 'calendar-days', tier3Offered: true };

function employee(overrides: Partial<PayInput['employee']> = {}): PayInput['employee'] {
  return { name: 'Test Person', employmentType: 'permanent', residency: 'resident', startDate: '2020-01-01', endDate: null, juniorStaffOvertime: false, ...overrides };
}

function pay(input: Partial<PayInput> & { basicMinor: number }, rows: StatutoryRateRow[] = rates2026): PayResult {
  const full: PayInput = { period: '2026-03', settings: calendar, employee: employee(), allowances: [], ...input };
  const result = calculatePay(full, new RateBook(rows, full.period));
  // The identity the journal stands on: every pesewa of gross is net or a deduction.
  expect(result.netMinor + result.employeeSsnitMinor + result.tier3Minor + result.payeMinor + result.deductionsMinor).toBe(result.grossMinor);
  expect(result.employerCostMinor).toBe(result.grossMinor + result.employerSsnitMinor + result.employerTier2Minor);
  // The PAYE lines shown add up to the PAYE charged, exactly.
  const shown = result.working.filter((line) => line.step === 'PAYE' && !line.total && line.calc);
  expect(shown.reduce((sum, line) => sum + line.amountMinor, 0)).toBe(result.payeMinor);
  expect(result.incomeTaxMinor + result.bonusTaxMinor + result.overtimeTaxMinor).toBe(result.payeMinor);
  return result;
}

const payeLines = (result: PayResult) => result.working.filter((line) => line.step === 'PAYE' && !line.total && line.calc).map((line) => line.amountMinor);

describe('applyRate', () => {
  it('rounds half up to the pesewa, in integers', () => {
    expect(applyRate(ghs(3166.67), bp(17.5))).toBe(ghs(554.17)); // 554.16725
    expect(applyRate(ghs(2105), bp(17.5))).toBe(ghs(368.38)); // 368.375 exactly: half rounds up
    expect(applyRate(1, bp(50))).toBe(1); // half a pesewa rounds up
    expect(applyRate(1, bp(49.99))).toBe(0);
  });
});

describe('the worked example', () => {
  // Basic 4,000.00, transport 500.00 (taxable), field per diem 200.00 (not
  // taxable), tier 3 200.00, married, loan instalment 150.00.
  const result = pay({
    basicMinor: ghs(4000),
    allowances: [
      { name: 'Transport allowance', amountMinor: ghs(500), taxable: true, pensionable: false },
      { name: 'Field per diem', amountMinor: ghs(200), taxable: false, pensionable: false },
    ],
    tier3Minor: ghs(200),
    reliefs: [{ kind: 'marriage' }],
    deductions: [{ name: 'Staff loan', amountMinor: ghs(150) }],
  });

  it('follows the calculation order to the pesewa', () => {
    expect(result.grossMinor).toBe(ghs(4700)); // 4,000 + 500 + 200
    expect(result.employeeSsnitMinor).toBe(ghs(220)); // 5.5% of basic 4,000; no allowance is pensionable
    expect(result.tier3DeductibleMinor).toBe(ghs(200)); // within 16.5% of 4,000 = 660
    expect(result.assessableMinor).toBe(ghs(4080)); // 4,700 − 200 per diem − 220 − 200
    expect(result.chargeableMinor).toBe(ghs(3980)); // less marriage relief 100
    // 0 + 5.50 + 13.00 + 554.16725 + 20.8325 = 593.49975 → 593.50
    expect(result.payeExact).toBe('59349.975');
    expect(result.payeMinor).toBe(ghs(593.5));
    expect(result.netMinor).toBe(ghs(3536.5)); // 4,700 − 220 − 200 − 593.50 − 150
    expect(result.employerSsnitMinor).toBe(ghs(320)); // 8% of 4,000
    expect(result.employerTier2Minor).toBe(ghs(200)); // 5% of 4,000
    expect(result.employerCostMinor).toBe(ghs(5220));
  });

  it('names every rate it used, with its dates', () => {
    expect(result.ratesUsed.map((used) => used.key)).toEqual([
      'paye.band', 'paye.band', 'paye.band', 'paye.band', 'paye.band', 'paye.band', 'paye.band',
      'ssnit.employee', 'ssnit.employer', 'ssnit.tier2', 'ssnit.tier1-total', 'ssnit.employer-total', 'ssnit.combined-total',
      'ssnit.max-insurable', 'tier3.deductible-cap', 'relief.marriage',
    ]);
    expect(result.ratesUsed.every((used) => used.effectiveFrom === '2026-01-01')).toBe(true);
  });
});

describe('rounding PAYE once', () => {
  it('rounds the total, not each band, so it can differ from summing rounded bands', () => {
    // Basic 60,000: chargeable 56,700. Exact: 0 + 5.50 + 13.00 + 554.16725 + 4,000 + 9,156 + 2,199.1655
    // = 15,927.83275 → 15,927.83. Rounding each band first would give 554.17 + 2,199.17 → 15,927.84.
    const result = pay({ basicMinor: ghs(60000) });
    expect(result.payeExact).toBe('1592783.275');
    expect(result.payeMinor).toBe(ghs(15927.83));
  });

  it('shows each band rounded, with the residue on the last band, adding up to the total', () => {
    const result = pay({ basicMinor: ghs(60000) });
    // 554.16725 shows as 554.17 (+0.275p); 2,199.1655 would show as 2,199.17 (+0.45p); together they overshoot by one pesewa,
    // so the last band shows 2,199.16 and the lines add up to 15,927.83.
    expect(payeLines(result)).toEqual([0, 550, 1300, 55417, 400000, 915600, 219916]);
    const last = result.working.filter((line) => line.step === 'PAYE' && line.calc).at(-1)!;
    expect(last.calc!.exact).toBe('219916.55');
    expect(last.detail).toMatch(/includes -1 pesewa/);
  });

  it('puts the bonus at its final rate into the same single rounding', () => {
    // Basic 4,000; bonus 10,000: 7,200 within the concession @ 5% = 360. Chargeable 6,580:
    // 572.66725 + 2,683.33 @ 25% = 670.8325 → bands 1,243.49975. With the bonus: 1,603.49975 → 1,603.50.
    const result = pay({ basicMinor: ghs(4000), bonusMinor: ghs(10000) });
    expect(result.payeExact).toBe('160349.975');
    expect(result.payeMinor).toBe(ghs(1603.5));
    expect(result.bonusTaxMinor).toBe(ghs(360));
  });
});

describe('an employee in each PAYE band', () => {
  // Basic only, so chargeable = basic − 5.5% SSNIT.
  const cases: [string, number, number, number][] = [
    // label, basic, chargeable, PAYE
    ['below the tax-free threshold', 400, 378, 0],
    ['in the 5% band', 600, 567, 3.85], // 77 @ 5%
    ['in the 10% band', 700, 661.5, 11.65], // 5.50 + 61.50 @ 10%
    ['in the 17.5% band', 2000, 1890, 221.5], // 18.50 + 1,160 @ 17.5%
    ['in the 25% band', 10000, 9450, 1961], // 572.66725 + 5,553.33 @ 25% = 1,388.3325 → 1,960.99975
    ['in the 30% band', 30000, 28350, 7108.67], // 4,572.66725 + 8,453.33 @ 30% = 2,535.999 → 7,108.66625
    ['in the 35% band', 60000, 56700, 15927.83], // 13,728.66725 + 6,283.33 @ 35% = 2,199.1655 → 15,927.83275
  ];
  for (const [label, basic, chargeable, paye] of cases) {
    it(label, () => {
      const result = pay({ basicMinor: ghs(basic) });
      expect(result.chargeableMinor).toBe(ghs(chargeable));
      expect(result.payeMinor).toBe(ghs(paye));
    });
  }

  it('pays no PAYE at all below the threshold, but still SSNIT', () => {
    const result = pay({ basicMinor: ghs(400) });
    expect(result.payeMinor).toBe(0);
    expect(result.employeeSsnitMinor).toBe(ghs(22));
    expect(result.netMinor).toBe(ghs(378));
    expect(payeLines(result)).toEqual([0]); // stops in the first band
  });

  it('charges SSNIT on no more than the maximum insurable earnings', () => {
    const result = pay({ basicMinor: ghs(80000) });
    expect(result.ssnitBaseMinor).toBe(ghs(61000));
    expect(result.employeeSsnitMinor).toBe(ghs(3355)); // 5.5% of 61,000
    // 76,645: 13,728.66725 + 26,228.33 @ 35% = 9,179.9155 → 22,908.58275
    expect(result.payeMinor).toBe(ghs(22908.58));
  });
});

describe('the pensionable base', () => {
  it('is basic alone unless an allowance is marked pensionable', () => {
    const result = pay({ basicMinor: ghs(4000), allowances: [{ name: 'Responsibility', amountMinor: ghs(1000), taxable: true, pensionable: false }] });
    expect(result.ssnitBaseMinor).toBe(ghs(4000));
    expect(result.employeeSsnitMinor).toBe(ghs(220));
  });

  it('takes in an allowance marked pensionable, for the employee and the employer alike', () => {
    const result = pay({ basicMinor: ghs(4000), allowances: [{ name: 'Responsibility', amountMinor: ghs(1000), taxable: true, pensionable: true }] });
    expect(result.ssnitBaseMinor).toBe(ghs(5000));
    expect(result.employeeSsnitMinor).toBe(ghs(275)); // 5.5% of 5,000
    expect(result.employerSsnitMinor).toBe(ghs(400)); // 8%
    expect(result.employerTier2Minor).toBe(ghs(250)); // 5%
  });

  it('is capped at maximum insurable earnings with the allowance in it', () => {
    const result = pay({ basicMinor: ghs(58000), allowances: [{ name: 'Responsibility', amountMinor: ghs(8000), taxable: true, pensionable: true }] });
    expect(result.pensionablePayMinor).toBe(ghs(66000));
    expect(result.ssnitBaseMinor).toBe(ghs(61000));
  });

  it('refuses rates that do not add up to the published totals', () => {
    expect(() => pay({ basicMinor: ghs(1000) }, rateSet('2026-01-01', null, { tier1Total: 13 }))).toThrow(/Tier 1 total \(check figure\) is 13% but the rates come to 13.5%/);
  });
});

describe('joiners and leavers', () => {
  it('prorates a mid-month joiner by calendar days', () => {
    // Joins 16 March: 16 of 31 days. Basic 3,100 → 1,600.00; allowance 310 → 160.00.
    const result = pay({
      basicMinor: ghs(3100),
      allowances: [{ name: 'Transport', amountMinor: ghs(310), taxable: true, pensionable: false }],
      employee: employee({ startDate: '2026-03-16' }),
    });
    expect(result.daysEmployed).toBe(16);
    expect(result.grossMinor).toBe(ghs(1760));
    expect(result.employeeSsnitMinor).toBe(ghs(88)); // 5.5% of 1,600
    expect(result.payeMinor).toBe(ghs(183.35)); // 1,672: 18.50 + 942 @ 17.5% = 164.85
    expect(result.netMinor).toBe(ghs(1488.65));
    expect(result.employerSsnitMinor).toBe(ghs(128)); // 8% of the prorated basic
  });

  it('prorates by working days where the entity says so', () => {
    // March 2026 has 22 weekdays; joining Monday 16 March leaves 12. Basic 3,100 × 12/22 = 1,690.909… → 1,690.91.
    const result = pay({ basicMinor: ghs(3100), settings: { prorationBasis: 'working-days', tier3Offered: false }, employee: employee({ startDate: '2026-03-16' }) });
    expect(result.daysInPeriod).toBe(22);
    expect(result.daysEmployed).toBe(12);
    expect(result.basicMinor).toBe(ghs(1690.91));
  });

  it('prorates a mid-month leaver by calendar days', () => {
    // Leaves 10 April: 10 of 30 days. Basic 4,500 → 1,500.00.
    const result = pay({ period: '2026-04', basicMinor: ghs(4500), employee: employee({ endDate: '2026-04-10' }) });
    expect(result.daysEmployed).toBe(10);
    expect(result.grossMinor).toBe(ghs(1500));
    expect(result.payeMinor).toBe(ghs(138.81)); // 1,417.50: 18.50 + 687.50 @ 17.5% = 120.3125 → 138.8125
    expect(result.netMinor).toBe(ghs(1278.69));
  });

  it('refuses someone not employed in the period', () => {
    expect(() => pay({ basicMinor: ghs(1000), employee: employee({ endDate: '2026-02-28' }) })).toThrow(PayrollRefusal);
  });
});

describe('a bonus month', () => {
  it('taxes the bonus within the concession at the final rate and the rest through the bands', () => {
    // Basic 4,000; bonus 10,000. Limit 15% of 48,000 = 7,200 @ 5% = 360.
    // The other 2,800 joins chargeable income: 4,000 + 2,800 − 220 = 6,580.
    const result = pay({ basicMinor: ghs(4000), bonusMinor: ghs(10000) });
    expect(result.bonusConcessionMinor).toBe(ghs(7200));
    expect(result.chargeableMinor).toBe(ghs(6580));
    expect(result.incomeTaxMinor).toBe(ghs(1243.5));
    expect(result.payeMinor).toBe(ghs(1603.5));
    expect(result.netMinor).toBe(ghs(12176.5)); // 14,000 − 220 − 1,603.50
  });

  it('shares the concession across the year', () => {
    const result = pay({ basicMinor: ghs(4000), bonusMinor: ghs(1000), bonusConcessionUsedMinor: ghs(7200) });
    expect(result.bonusConcessionMinor).toBe(0);
    expect(result.chargeableMinor).toBe(ghs(4780)); // the whole bonus in the bands
  });
});

describe('reliefs', () => {
  it('takes each registered relief off chargeable income, limited to what may be claimed', () => {
    // Assessable 3,780. Marriage 100 + 3 children (4 claimed, limit 3) × 50 + 1 aged dependant 83.33 + old age 125 = 458.33.
    const result = pay({
      basicMinor: ghs(4000),
      reliefs: [{ kind: 'marriage' }, { kind: 'child-education', count: 4 }, { kind: 'aged-dependant', count: 1 }, { kind: 'old-age' }],
    });
    expect(result.reliefsMinor).toBe(ghs(458.33));
    expect(result.chargeableMinor).toBe(ghs(3321.67));
    expect(result.payeMinor).toBe(ghs(472.04)); // 18.50 + 2,591.67 @ 17.5% = 453.54225 → 472.04225
  });

  it('values disability relief as a share of assessable income', () => {
    const result = pay({ basicMinor: ghs(4000), reliefs: [{ kind: 'disability' }] });
    expect(result.reliefsMinor).toBe(ghs(945)); // 25% of 3,780
    expect(result.payeMinor).toBe(ghs(386.88)); // 2,835: 18.50 + 2,105 @ 17.5% = 368.375 → 386.875 → 386.88
  });

  it('never takes chargeable income below nil', () => {
    const result = pay({ basicMinor: ghs(300), reliefs: [{ kind: 'marriage' }, { kind: 'old-age' }, { kind: 'aged-dependant', count: 2 }] });
    expect(result.chargeableMinor).toBe(0);
    expect(result.payeMinor).toBe(0);
  });
});

describe('non-residents', () => {
  it('are taxed on the resident bands by default, with no reliefs', () => {
    // Chargeable 3,780 (no marriage relief): 18.50 + 3,050 @ 17.5% = 533.75 → 552.25.
    const result = pay({ basicMinor: ghs(4000), reliefs: [{ kind: 'marriage' }], employee: employee({ residency: 'non-resident' }) });
    expect(result.taxBasis).toBe('non-resident-bands');
    expect(result.reliefsMinor).toBe(0);
    expect(result.payeMinor).toBe(ghs(552.25));
  });

  it('are taxed at one flat rate when the rates table says so', () => {
    const result = pay({ basicMinor: ghs(4000), employee: employee({ residency: 'non-resident' }) }, rateSet('2026-01-01', null, { nonResident: 'flat' }));
    expect(result.taxBasis).toBe('non-resident-flat');
    expect(result.payeMinor).toBe(ghs(945)); // 25% of 3,780
  });

  it('get no bonus or overtime concession', () => {
    const result = pay(
      { basicMinor: ghs(1200), bonusMinor: ghs(1000), overtimeMinor: ghs(800), employee: employee({ residency: 'non-resident', juniorStaffOvertime: true }) },
      rateSet('2026-01-01', null, { nonResident: 'flat' }),
    );
    expect(result.bonusConcessionMinor).toBe(0);
    expect(result.overtimeTaxMinor).toBe(0);
    expect(result.payeMinor).toBe(ghs(733.5)); // 25% of (3,000 − 66) = 2,934
  });
});

describe('casual workers', () => {
  it('are refused until their treatment is confirmed', () => {
    expect(() => pay({ basicMinor: ghs(1000), employee: employee({ employmentType: 'casual' }) })).toThrow(/Casual workers cannot be paid through payroll yet/);
  });
});

describe('tier 3', () => {
  it('is refused where the entity does not offer it', () => {
    expect(() => pay({ basicMinor: ghs(4000), tier3Minor: ghs(100), settings: { prorationBasis: 'calendar-days', tier3Offered: false } })).toThrow(/does not offer tier 3/);
  });

  it('is deductible only up to the cap, but taken from pay in full', () => {
    const result = pay({ basicMinor: ghs(4000), tier3Minor: ghs(1000) });
    expect(result.tier3DeductibleMinor).toBe(ghs(660)); // 16.5% of 4,000
    expect(result.chargeableMinor).toBe(ghs(3120)); // 4,000 − 220 − 660
    expect(result.netMinor).toBe(ghs(4000 - 220 - 1000) - result.payeMinor);
  });
});

describe('overtime and benefits in kind', () => {
  it('taxes qualifying junior-staff overtime separately at the lower then upper rate', () => {
    // Basic 1,200 is within the 1,500 ceiling. Overtime 800: first 600 (50% of basic) @ 5% = 30, then 200 @ 10% = 20.
    // Chargeable: 2,000 − 66 − 800 = 1,134 → 18.50 + 404 @ 17.5% = 70.70 → 89.20. With overtime: 139.20.
    const result = pay({ basicMinor: ghs(1200), overtimeMinor: ghs(800), employee: employee({ juniorStaffOvertime: true }) });
    expect(result.overtimeTaxMinor).toBe(ghs(50));
    expect(result.chargeableMinor).toBe(ghs(1134));
    expect(result.payeMinor).toBe(ghs(139.2));
  });

  it('puts overtime in chargeable income when basic is above the ceiling', () => {
    const result = pay({ basicMinor: ghs(2000), overtimeMinor: ghs(800), employee: employee({ juniorStaffOvertime: true }) });
    expect(result.overtimeTaxMinor).toBe(0);
    expect(result.chargeableMinor).toBe(ghs(2690)); // 2,800 − 110
  });

  it('adds benefits in kind to chargeable income without paying them in cash', () => {
    // Cash emoluments 5,000 + 1,000 = 6,000. Vehicle with fuel 12.5% = 750; accommodation 10% = 600.
    const result = pay({
      basicMinor: ghs(5000),
      allowances: [{ name: 'Responsibility', amountMinor: ghs(1000), taxable: true, pensionable: false }],
      benefitsInKind: ['vehicle-fuel', 'accommodation'],
    });
    expect(result.benefitsInKindMinor).toBe(ghs(1350));
    expect(result.grossMinor).toBe(ghs(6000));
    expect(result.chargeableMinor).toBe(ghs(7075)); // 6,000 − 275 + 1,350
  });

  it('caps a vehicle benefit', () => {
    const result = pay({ basicMinor: ghs(20000), benefitsInKind: ['vehicle'] });
    expect(result.benefitsInKindMinor).toBe(ghs(500)); // 5% would be 1,000
  });
});

describe('a rate change part way through the year', () => {
  // From July the bands and SSNIT move. The January set is closed on 30 June.
  const before = rateSet('2026-01-01', null);
  const after = [
    ...rateSet('2026-01-01', '2026-06-30'),
    ...rateSet('2026-07-01', null, {
      bands: [
        [600, 0],
        [200, 5],
        [3200, 17.5],
        [null, 30],
      ],
      employeeSsnit: 6,
      employerSsnit: 9,
    }),
  ];
  const march: Partial<PayInput> & { basicMinor: number } = {
    period: '2026-03',
    basicMinor: ghs(4000),
    allowances: [{ name: 'Transport', amountMinor: ghs(500), taxable: true, pensionable: false }],
    reliefs: [{ kind: 'marriage' }],
  };

  it('reproduces an earlier period exactly after the rates change', () => {
    const original = pay(march, before);
    const rerun = pay(march, after);
    // Identical in every figure and every line of working. The only thing
    // that moved is that the rows it used now carry the end date they were
    // given when July's arrived.
    const withoutEndDates = (result: PayResult) => ({ ...result, ratesUsed: result.ratesUsed.map((used) => ({ ...used, effectiveTo: undefined })) });
    expect(withoutEndDates(rerun)).toEqual(withoutEndDates(original));
    expect(rerun.ratesUsed.every((used) => used.effectiveTo === '2026-06-30')).toBe(true);
    expect(rerun.payeMinor).toBe(ghs(643.5)); // 4,500 − 220 − 100 = 4,180: 572.66725 + 283.33 @ 25% = 70.8325 → 643.49975
  });

  it('uses the new rates from the month they start', () => {
    const july = pay({ ...march, period: '2026-07' }, after);
    expect(july.employeeSsnitMinor).toBe(ghs(240)); // 6% of 4,000
    expect(july.employerSsnitMinor).toBe(ghs(360)); // 9%
    // 4,500 − 240 − 100 = 4,160: 0 + 10.00 + 560.00 + 160 @ 30% = 48.00
    expect(july.payeMinor).toBe(ghs(618));
    expect(july.ratesUsed.every((used) => used.effectiveFrom === '2026-07-01')).toBe(true);
  });

  it('applies a rate that starts mid-month to the whole of that month, and says so', () => {
    const midMonth = [
      ...rateSet('2026-01-01', null).filter((r) => r.key !== 'ssnit.employee' && r.key !== 'ssnit.tier1-total' && r.key !== 'ssnit.combined-total'),
      row('ssnit.employee', '2026-01-01', '2026-07-14', { rate: 5.5 }),
      row('ssnit.tier1-total', '2026-01-01', '2026-07-14', { rate: 13.5 }),
      row('ssnit.combined-total', '2026-01-01', '2026-07-14', { rate: 18.5 }),
      row('ssnit.employee', '2026-07-15', null, { rate: 6 }),
      row('ssnit.tier1-total', '2026-07-15', null, { rate: 14 }),
      row('ssnit.combined-total', '2026-07-15', null, { rate: 19 }),
    ];
    const june = pay({ period: '2026-06', basicMinor: ghs(4000) }, midMonth);
    const july = pay({ period: '2026-07', basicMinor: ghs(4000) }, midMonth);
    expect(june.employeeSsnitMinor).toBe(ghs(220));
    expect(june.ratesChangedWithin).toEqual([]);
    expect(july.employeeSsnitMinor).toBe(ghs(240)); // in force on 31 July
    expect(july.ratesChangedWithin.map((change) => [change.key, change.from])).toEqual([
      ['ssnit.employee', '2026-07-15'],
      ['ssnit.tier1-total', '2026-07-15'],
      ['ssnit.combined-total', '2026-07-15'],
    ]);
  });
});

describe('the rates table', () => {
  it('refuses, by name, a rate that is not in force', () => {
    const noSsnit = rates2026.filter((r) => r.key !== 'ssnit.employee');
    expect(() => pay({ basicMinor: ghs(1000) }, noSsnit)).toThrow(/Employee SSNIT/);
    expect(() => pay({ period: '2025-12', basicMinor: ghs(1000) })).toThrow(/is in force on 2025-12-31/);
  });

  it('only asks for the rates an employee needs', () => {
    const bare = rates2026.filter((r) => !r.key.startsWith('bik.') && !r.key.startsWith('bonus.') && !r.key.startsWith('relief.') && !r.key.startsWith('paye.non-resident'));
    expect(pay({ basicMinor: ghs(1000) }, bare).payeMinor).toBe(ghs(56.13)); // 945: 18.50 + 215 @ 17.5% = 37.625 → 56.125 → 56.13
  });

  it('checks a band ladder before using it', () => {
    expect(validateRateVersion({ key: 'paye.band', effectiveFrom: '2026-01-01', rows: [{ rateBasisPoints: 0, amountMinor: 100, maxCount: null }, { rateBasisPoints: 500, amountMinor: 100, maxCount: null }] })).toEqual([
      'The bands cannot be used: the last band must have no width — it is everything above the others.',
    ]);
  });

  it('lets a rate start on any real date', () => {
    expect(validateRateVersion({ key: 'ssnit.employee', effectiveFrom: '2026-07-15', rows: [{ rateBasisPoints: 550, amountMinor: null, maxCount: null }] })).toEqual([]);
    expect(validateRateVersion({ key: 'ssnit.employee', effectiveFrom: '2026-02-30', rows: [{ rateBasisPoints: 550, amountMinor: null, maxCount: null }] })).toContain('Give the date the figures take effect.');
  });

  it('holds the non-resident basis as a choice between the two options', () => {
    expect(validateRateVersion({ key: 'paye.non-resident-basis', effectiveFrom: '2026-01-01', rows: [{ rateBasisPoints: null, amountMinor: null, maxCount: null, choice: 'flat' }] })).toEqual([]);
    expect(validateRateVersion({ key: 'paye.non-resident-basis', effectiveFrom: '2026-01-01', rows: [{ rateBasisPoints: null, amountMinor: null, maxCount: null, choice: 'half' }] })).toHaveLength(1);
  });

  it('adds a new version after the last and closes the one before', () => {
    const placed = placeVersion(rates2026, 'ssnit.employee', '2026-07-15');
    expect(placed).toEqual({ closeIds: [rates2026.find((r) => r.key === 'ssnit.employee')!.id], closeOn: '2026-07-14' });
    expect(placeVersion(rates2026, 'ssnit.employee', '2026-01-01')).toHaveProperty('problem');
  });

  it('reads a percentage typed by a person into basis points exactly', () => {
    expect(basisPointsFrom('17.5')).toBe(1750);
    expect(basisPointsFrom('5.5%')).toBe(550);
    expect(basisPointsFrom('')).toBeNull();
    expect(basisPointsFrom('5.555')).toBeNaN();
  });
});
