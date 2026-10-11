/**
 * Test fixtures for payroll: a full set of statutory rates and an employee
 * builder. These are test data, not the Ghanaian figures — the code holds no
 * rates of its own, and the tests prove it follows whatever the rows say.
 */

import type { EmployeeForPay } from '@/lib/payroll-run';
import type { StatutoryRateRow } from '@/lib/payroll-rates';

export const ghs = (cedis: number) => Math.round(cedis * 100);
export const bp = (percent: number) => Math.round(percent * 100);

let nextId = 0;
export function rateRow(
  key: string,
  from: string,
  to: string | null,
  values: { rate?: number; amount?: number; maxCount?: number; sequence?: number; choice?: string; dayOfMonth?: number },
): StatutoryRateRow {
  return {
    id: `rate-${nextId++}`,
    key,
    sequence: values.sequence ?? 0,
    effectiveFrom: from,
    effectiveTo: to,
    rateBasisPoints: values.rate === undefined ? null : bp(values.rate),
    amountMinor: values.amount === undefined ? null : ghs(values.amount),
    maxCount: values.maxCount ?? null,
    choice: values.choice ?? null,
    dayOfMonth: values.dayOfMonth ?? null,
    isPlaceholder: false,
    source: 'test fixture',
    note: null,
  };
}

export type RateSetOptions = {
  bands?: [number | null, number][];
  employeeSsnit?: number;
  employerSsnit?: number;
  weekend?: 'as-is' | 'next-working-day' | 'previous-working-day';
  placeholder?: boolean;
};

export function rateSet(from: string, to: string | null, options: RateSetOptions = {}): StatutoryRateRow[] {
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
  const weekend = options.weekend ?? 'as-is';
  const rows = [
    ...bands.map(([width, rate], sequence) => rateRow('paye.band', from, to, { sequence, rate, amount: width ?? undefined })),
    rateRow('paye.non-resident-basis', from, to, { choice: 'progressive' }),
    rateRow('paye.non-resident', from, to, { rate: 25 }),
    rateRow('ssnit.employee', from, to, { rate: employee }),
    rateRow('ssnit.employer', from, to, { rate: employer }),
    rateRow('ssnit.tier2', from, to, { rate: 5 }),
    rateRow('ssnit.tier1-total', from, to, { rate: employee + employer }),
    rateRow('ssnit.employer-total', from, to, { rate: employer + 5 }),
    rateRow('ssnit.combined-total', from, to, { rate: employee + employer + 5 }),
    rateRow('ssnit.max-insurable', from, to, { amount: 61000 }),
    rateRow('tier3.deductible-cap', from, to, { rate: 16.5 }),
    rateRow('relief.marriage', from, to, { amount: 100 }),
    rateRow('relief.child-education', from, to, { amount: 50, maxCount: 3 }),
    rateRow('relief.aged-dependant', from, to, { amount: 83.33, maxCount: 2 }),
    rateRow('relief.disability', from, to, { rate: 25 }),
    rateRow('relief.old-age', from, to, { amount: 125 }),
    rateRow('bonus.cap', from, to, { rate: 15 }),
    rateRow('bonus.final-rate', from, to, { rate: 5 }),
    rateRow('overtime.eligible-max-basic', from, to, { amount: 1500 }),
    rateRow('overtime.lower-cap', from, to, { rate: 50 }),
    rateRow('overtime.lower-rate', from, to, { rate: 5 }),
    rateRow('overtime.upper-rate', from, to, { rate: 10 }),
    rateRow('bik.vehicle', from, to, { rate: 5, amount: 500 }),
    rateRow('bik.vehicle-fuel', from, to, { rate: 12.5, amount: 1000 }),
    rateRow('bik.accommodation', from, to, { rate: 10 }),
    rateRow('bik.accommodation-furnished', from, to, { rate: 12.5 }),
    rateRow('deadline.paye', from, to, { dayOfMonth: 15, choice: weekend }),
    rateRow('deadline.ssnit-tier1', from, to, { dayOfMonth: 14, choice: weekend }),
    rateRow('deadline.ssnit-tier2', from, to, { dayOfMonth: 14, choice: weekend }),
    rateRow('deadline.tier3', from, to, { dayOfMonth: 14, choice: weekend }),
  ];
  return options.placeholder ? rows.map((row) => ({ ...row, isPlaceholder: true })) : rows;
}

let nextEmployee = 0;
export function employee(overrides: Partial<EmployeeForPay> & { basicMinor: number }): EmployeeForPay {
  const n = nextEmployee++;
  return {
    id: `emp-${n}`,
    staffNumber: `S${String(n).padStart(3, '0')}`,
    name: `Employee ${n}`,
    employmentType: 'permanent',
    residency: 'resident',
    startDate: '2020-01-01',
    endDate: null,
    department: 'Programmes',
    expenseAccountCode: '6001',
    juniorStaffOvertime: false,
    tier3Minor: 0,
    benefitsInKind: [],
    reliefs: { marriage: false, childrenInEducation: 0, agedDependants: 0, disability: false, oldAge: false },
    allowances: [],
    allocations: [],
    ...overrides,
  };
}
