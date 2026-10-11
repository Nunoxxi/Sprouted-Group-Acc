/**
 * Readers for payroll reference data: the statutory rates, which are national
 * and held once, and each entity's own payroll settings.
 *
 * Withdrawn placeholders are kept in the table but never leave it.
 */

import type { PayrollSetting, StatutoryRate } from '@prisma/client';

import type { ProrationBasis } from '../payroll-engine';
import type { StatutoryRateRow } from '../payroll-rates';
import { prisma } from '../prisma';
import { toMinor } from './money';

const isoDate = (value: Date) => value.toISOString().slice(0, 10);

export function statutoryRateRecord(row: StatutoryRate): StatutoryRateRow {
  return {
    id: row.id,
    key: row.key,
    sequence: row.sequence,
    effectiveFrom: isoDate(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? isoDate(row.effectiveTo) : null,
    rateBasisPoints: row.rateBasisPoints,
    amountMinor: row.amountMinor === null ? null : toMinor(row.amountMinor),
    maxCount: row.maxCount,
    choice: row.choice,
    dayOfMonth: row.dayOfMonth,
    isPlaceholder: row.isPlaceholder,
    source: row.source,
    note: row.note,
  };
}

/**
 * Every statutory rate, all dates. National reference data — the same for
 * every entity and nothing about any one of them — so it is not scoped.
 */
export async function loadStatutoryRates(): Promise<StatutoryRateRow[]> {
  const rows = await prisma.statutoryRate.findMany({ where: { withdrawnAt: null }, orderBy: [{ key: 'asc' }, { effectiveFrom: 'asc' }, { sequence: 'asc' }] });
  return rows.map(statutoryRateRecord);
}

export type PayrollSettingRecord = {
  entityId: string;
  payrollEnabled: boolean;
  payDay: number;
  tier3Offered: boolean;
  prorationBasis: ProrationBasis;
};

export const prorationBasisToPrisma: Record<ProrationBasis, 'CALENDAR_DAYS' | 'WORKING_DAYS'> = {
  'calendar-days': 'CALENDAR_DAYS',
  'working-days': 'WORKING_DAYS',
};

export function payrollSettingRecord(entityId: string, row: PayrollSetting | null): PayrollSettingRecord {
  // No row means nobody has set payroll up: off, with the defaults.
  return {
    entityId,
    payrollEnabled: row?.payrollEnabled ?? false,
    payDay: row?.payDay ?? 28,
    tier3Offered: row?.tier3Offered ?? false,
    prorationBasis: row?.prorationBasis === 'WORKING_DAYS' ? 'working-days' : 'calendar-days',
  };
}

/** Every entity has a record, defaulted, so the screen never guards for a missing row. */
export async function loadPayrollSettings(scope: { entityId?: { in: string[] } }, entityIds: string[]): Promise<Record<string, PayrollSettingRecord>> {
  const rows = await prisma.payrollSetting.findMany({ where: scope });
  return Object.fromEntries(entityIds.map((id) => [id, payrollSettingRecord(id, rows.find((row) => row.entityId === id) ?? null)]));
}
