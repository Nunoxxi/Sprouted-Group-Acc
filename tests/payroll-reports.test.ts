/**
 * Payroll reports, each checked against the journal it has to agree with:
 * the PAYE schedule totals what was credited to PAYE, the SSNIT schedule what
 * was credited to the tiers, project cost what was charged to each project.
 * Then the month-on-month comparison, year to date, the reconciliation of the
 * control accounts, and labour cost with casual labour beside payroll.
 */

import { describe, expect, it } from 'vitest';

import type { EntityPayrollSettings } from '@/lib/payroll-engine';
import { calculateRun, payRunJournal, type CalculatedLine, type EmployeeForPay } from '@/lib/payroll-run';
import {
  costByDepartment,
  costByEntity,
  costByProject,
  employerCostPerEmployee,
  factOf,
  labourCost,
  monthOnMonth,
  payeSchedule,
  reconcilePayroll,
  ssnitSchedule,
  tier3Schedule,
  yearToDate,
  type PayLineFact,
} from '@/lib/payroll-reports';

import { employee, ghs, rateSet } from './payroll-fixtures';

const settings: EntityPayrollSettings = { prorationBasis: 'calendar-days', tier3Offered: true };
const rates = rateSet('2026-01-01', null);

function facts(period: string, staff: (EmployeeForPay & { tin?: string | null; ssnitNumber?: string | null })[], entityId = 'roots'): { lines: CalculatedLine[]; facts: PayLineFact[] } {
  const lines = calculateRun({ period, settings, employees: staff, loans: [], variables: {}, bonusConcessionUsed: {}, rates });
  return {
    lines,
    facts: lines.map((line) => {
      const person = staff.find((s) => s.id === line.employeeId)!;
      return factOf({
        entityId,
        runId: `run-${period}`,
        employee: { ...person, tin: person.tin ?? null, ssnitNumber: person.ssnitNumber ?? null },
        input: line.input!,
        result: line.result!,
        allocations: line.allocations,
      });
    }),
  };
}

const credited = (lines: CalculatedLine[], code: string) =>
  payRunJournal(lines.map((l) => ({ expenseAccountCode: l.expenseAccountCode, allocations: l.allocations, result: l.result! })))
    .filter((j) => j.accountCode === code && j.type === 'credit')
    .reduce((sum, j) => sum + j.amount, 0);

const ama = { ...employee({ basicMinor: ghs(4250), name: 'Ama Owusu', department: 'Programmes', allowances: [{ name: 'Transport', amountMinor: ghs(650), taxable: true, pensionable: false }, { name: 'Per diem', amountMinor: ghs(300), taxable: false, pensionable: false }], reliefs: { marriage: true, childrenInEducation: 0, agedDependants: 0, disability: false, oldAge: false }, tier3Minor: ghs(100), allocations: [{ projectId: 'p1', fundId: null, shareBasisPoints: 7500 }, { projectId: 'p2', fundId: null, shareBasisPoints: 2500 }] }), tin: 'P0012345678', ssnitNumber: 'C123456789012' };
const kwame = { ...employee({ basicMinor: ghs(50000), name: 'Kwame Asante', department: 'Finance', allowances: [{ name: 'Responsibility', amountMinor: ghs(8000), taxable: true, pensionable: true }] }), tin: null, ssnitNumber: 'C987654321098' };
const kofi = { ...employee({ basicMinor: ghs(500), name: 'Kofi Mensah', department: 'Field' }), tin: 'P0099999999', ssnitNumber: null };
const october = facts('2026-10', [ama, kwame, kofi]);

describe('the PAYE schedule', () => {
  const schedule = payeSchedule(october.facts);

  it('lists every employee with their TIN, chargeable income and tax deducted', () => {
    const row = schedule.rows.find((r) => r.name === 'Ama Owusu')!;
    expect(row.tin).toBe('P0012345678');
    expect(row.allowancesMinor).toBe(ghs(650)); // taxable cash allowances only
    expect(row.chargeableMinor).toBe(october.facts.find((f) => f.name === 'Ama Owusu')!.chargeableMinor);
  });

  it('totals exactly what the journal credited to PAYE', () => {
    expect(schedule.totals.payeMinor).toBe(credited(october.lines, '2040'));
  });

  it('names anyone without a TIN, to put right before filing', () => {
    expect(schedule.missingTin).toEqual(['Kwame Asante']);
  });
});

describe('the SSNIT schedule', () => {
  const schedule = ssnitSchedule(october.facts);

  it('shows basic, the contribution base, tier 1 and tier 2 for each employee', () => {
    const row = schedule.rows.find((r) => r.name === 'Kwame Asante')!;
    expect(row.basicMinor).toBe(ghs(50000));
    expect(row.contributionBaseMinor).toBe(ghs(58000)); // basic + the pensionable allowance
    expect(row.tier1Minor).toBe(row.employeeTier1Minor + row.employerTier1Minor);
  });

  it('totals exactly what the journal credited to tier 1 and tier 2', () => {
    expect(schedule.totals.tier1Minor).toBe(credited(october.lines, '2045'));
    expect(schedule.totals.tier2Minor).toBe(credited(october.lines, '2046'));
  });

  it('names anyone without an SSNIT number', () => {
    expect(schedule.missingSsnitNumber).toEqual(['Kofi Mensah']);
  });
});

describe('the tier 3 schedule', () => {
  it('lists only those who contributed, totalling the tier 3 liability', () => {
    const schedule = tier3Schedule(october.facts);
    expect(schedule.rows.map((r) => r.name)).toEqual(['Ama Owusu']);
    expect(schedule.totals.tier3Minor).toBe(credited(october.lines, '2049'));
  });
});

describe('cost', () => {
  it('by project splits gross and employer contributions as the journal did, and adds back to the whole', () => {
    const rows = costByProject(october.facts, { p1: 'Cashew outgrowers', p2: 'Cocoa training' });
    const journal = payRunJournal(october.lines.map((l) => ({ expenseAccountCode: l.expenseAccountCode, allocations: l.allocations, result: l.result! })));
    const charged = (project: string | null) => journal.filter((j) => j.type === 'debit' && j.projectId === project).reduce((sum, j) => sum + j.amount, 0);
    expect(rows.find((r) => r.key === 'p1')!.totalCostMinor).toBe(charged('p1'));
    expect(rows.find((r) => r.key === 'p2')!.totalCostMinor).toBe(charged('p2'));
    expect(rows.find((r) => r.key === '')!.label).toBe('Not charged to a project');
    expect(rows.reduce((sum, r) => sum + r.totalCostMinor, 0)).toBe(journal.filter((j) => j.type === 'debit').reduce((sum, j) => sum + j.amount, 0));
  });

  it('by department and by entity', () => {
    expect(costByDepartment(october.facts).map((r) => r.label)).toEqual(['Finance', 'Programmes', 'Field']);
    const crafts = facts('2026-10', [employee({ basicMinor: ghs(3000) })], 'crafts').facts;
    const rows = costByEntity([...october.facts, ...crafts], { roots: 'Sprouted Roots', crafts: 'Sprouted Crafts' });
    expect(rows.map((r) => [r.label, r.headcount])).toEqual([['Sprouted Roots', 3], ['Sprouted Crafts', 1]]);
  });

  it('per employee, with every employer contribution', () => {
    const row = employerCostPerEmployee(october.facts)[0];
    expect(row.name).toBe('Kwame Asante');
    expect(row.totalCostMinor).toBe(row.grossMinor + row.employerSsnitMinor + row.employerTier2Minor);
  });
});

describe('month on month', () => {
  const september = facts('2026-09', [{ ...ama, basicMinor: ghs(4000) }, kwame, { ...employee({ basicMinor: ghs(1500), name: 'Esi Leaving' }), tin: null, ssnitNumber: null }]).facts;
  const kojo = { ...employee({ basicMinor: ghs(3100), name: 'Kojo Joining', startDate: '2026-10-16' }), tin: null, ssnitNumber: null };
  const comparison = monthOnMonth(september, facts('2026-10', [ama, kwame, kofi, kojo]).facts);

  it('names the joiners and the leavers', () => {
    expect(comparison.joiners.map((j) => j.name)).toEqual(['Kofi Mensah', 'Kojo Joining']);
    expect(comparison.leavers.map((l) => l.name)).toEqual(['Esi Leaving']);
  });

  it('names a pay change, and not someone simply paid the same', () => {
    expect(comparison.payChanges).toEqual([{ name: 'Ama Owusu', staffNumber: ama.staffNumber, basicBeforeMinor: ghs(4000), basicAfterMinor: ghs(4250), grossBeforeMinor: ghs(4950), grossAfterMinor: ghs(5200) }]);
  });

  it('counts a leaver part way through the month as a leaver, not a pay change', () => {
    const leaving = monthOnMonth(september, facts('2026-10', [ama, { ...kwame, endDate: '2026-10-15' }]).facts);
    expect(leaving.leavers.map((l) => l.name)).toContain('Kwame Asante');
    expect(leaving.payChanges.map((p) => p.name)).not.toContain('Kwame Asante');
  });
});

describe('year to date, for the annual employer return', () => {
  it('adds up every posted month of the year per employee, and no other year', () => {
    const lines = [...facts('2026-01', [kwame]).facts, ...facts('2026-02', [kwame]).facts, ...facts('2026-03', [kwame]).facts, ...facts('2027-01', [kwame]).facts];
    const [row] = yearToDate(lines, '2026', '2026-02');
    expect(row.monthsPaid).toBe(2);
    expect(row.grossMinor).toBe(ghs(58000) * 2);
    expect(row.payeMinor).toBe(lines[0].payeMinor + lines[1].payeMinor);
  });
});

describe('reconciling the control accounts', () => {
  it('agrees when the ledger and the records say the same, and flags a difference', () => {
    const rows = reconcilePayroll(
      { '2047': 1000, '2040': 500, '2045': 300, '2046': 100, '2049': 0, '1080': 250 },
      [
        { kind: 'net-pay', amountMinor: 1000 },
        { kind: 'paye', amountMinor: 450 },
        { kind: 'ssnit-tier1', amountMinor: 300 },
        { kind: 'ssnit-tier2', amountMinor: 100 },
      ],
      250,
    );
    expect(rows.filter((r) => !r.agrees).map((r) => [r.label, r.differenceMinor])).toEqual([['PAYE payable', 50]]);
    expect(rows.map((r) => r.accountCode)).toEqual(['2047', '2040', '2045', '2046', '2049', '1080']);
  });
});

describe('total labour cost', () => {
  it('puts payroll and casual labour paid from agents’ floats side by side per entity', () => {
    const result = labourCost(october.facts, [
      { entityId: 'roots', amountMinor: ghs(1200), workers: 8 },
      { entityId: 'oikazi', amountMinor: ghs(500), workers: 4 },
    ], { roots: 'Sprouted Roots', oikazi: 'Oikazi' });
    const roots = result.rows.find((r) => r.entityId === 'roots')!;
    expect(roots.casualLabourMinor).toBe(ghs(1200));
    expect(roots.totalLabourMinor).toBe(roots.payrollTotalMinor + ghs(1200));
    expect(result.rows.find((r) => r.entityId === 'oikazi')!.payrollTotalMinor).toBe(0);
    expect(result.totals.casualWorkers).toBe(12);
  });
});
