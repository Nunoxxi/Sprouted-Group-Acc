/**
 * The tax computation for one year, assembled from the three places its
 * figures actually live: the ledger (the accounting profit and the
 * depreciation in it), the register (what each capital allowance pool bought
 * and sold), and the settings a person entered (the classes and their rates,
 * the tax rate, the add-backs and the incentives).
 *
 * The arithmetic itself is pure and lives in src/lib/assets.ts. This only
 * fetches and arranges.
 */

import { allowanceSchedule, taxComputation, type AllowanceClass, type AllowanceSchedule, type ComputationResult, type PoolMovement } from '../assets';
import { allowanceClassRecord, readTaxYear } from './assets';
import { prisma } from './../prisma';
import type { TaxYearRecord } from './types';

export type Worksheet = ComputationResult & {
  year: TaxYearRecord;
  allowances: AllowanceSchedule;
};

/** Everything the worksheet shows, and the figure that would be posted. */
export async function computationFor(entityId: string, taxYearId: string): Promise<Worksheet> {
  const year = await readTaxYear(entityId, taxYearId);
  const classRows = await prisma.capitalAllowanceClass.findMany({ where: { entityId }, orderBy: { code: 'asc' } });
  const classes: AllowanceClass[] = classRows.map(allowanceClassRecord).map((row) => ({ id: row.id, code: row.code, name: row.name, ratePct: row.ratePct, method: row.method }));

  // Every class gets a row, even one with nothing in it, so a pool that has
  // been emptied is visible rather than silently absent.
  const openingByClass = new Map(year.pools.map((pool) => [pool.classId, pool.openingMinor]));
  const movements: PoolMovement[] = classes.map((klass) => ({
    classId: klass.id,
    openingMinor: openingByClass.get(klass.id) ?? 0,
    additionsMinor: year.additionsByClass[klass.id] ?? 0,
    disposalProceedsMinor: year.disposalProceedsByClass[klass.id] ?? 0,
    straightLineCostMinor: year.straightLineCostByClass[klass.id] ?? 0,
  }));
  const allowances = allowanceSchedule(movements, classes);

  const result = taxComputation({
    accountingProfitMinor: year.accountingProfitMinor,
    depreciationMinor: year.depreciationMinor,
    addBacks: year.adjustments.filter((adjustment) => adjustment.kind === 'add-back'),
    deductions: year.adjustments.filter((adjustment) => adjustment.kind === 'deduction'),
    incentives: year.adjustments.filter((adjustment) => adjustment.kind === 'incentive'),
    capitalAllowancesMinor: allowances.totalAllowanceMinor,
    ratePct: year.ratePct,
    lossBroughtForwardMinor: year.lossBroughtForwardMinor,
  });

  return { ...result, year, allowances };
}
