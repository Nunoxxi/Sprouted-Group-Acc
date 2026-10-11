'use server';

/**
 * Server Function for how one entity runs payroll: whether it does at all,
 * the day staff are paid, whether tier 3 is offered and how a part month is
 * prorated. Everything statutory is in the rates table, not here.
 *
 * Owner only (settings:manage), scoped to the entity, audited with the
 * settings before and after.
 */

import { refresh } from 'next/cache';
import { Prisma } from '@prisma/client';

import { recordAuditEvent } from '@/lib/audit';
import type { Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess } from '@/lib/dal';
import { payrollSettingRecord, prorationBasisToPrisma, type PayrollSettingRecord } from '@/lib/data/payroll-rates';
import type { ProrationBasis } from '@/lib/payroll-engine';
import { prisma } from '@/lib/prisma';

import type { ActionResult } from './documents';

type Tx = Prisma.TransactionClient;

export type PayrollSettingsInput = {
  payrollEnabled: boolean;
  payDay: number;
  tier3Offered: boolean;
  prorationBasis: ProrationBasis;
};

export async function savePayrollSettings(entityId: string, input: PayrollSettingsInput): Promise<ActionResult<PayrollSettingRecord>> {
  let principal: Principal;
  try {
    principal = await requireEntityAccess(entityId, 'settings:manage');
  } catch (error) {
    const failure = authorizationFailure(error);
    if (failure) return failure;
    throw error;
  }
  if (!Number.isInteger(input.payDay) || input.payDay < 1 || input.payDay > 31) return { ok: false, error: 'The pay day is a day of the month, 1 to 31.' };
  if (!(input.prorationBasis in prorationBasisToPrisma)) return { ok: false, error: 'Choose calendar days or working days.' };

  return prisma.$transaction(async (tx: Tx): Promise<ActionResult<PayrollSettingRecord>> => {
    const before = payrollSettingRecord(entityId, await tx.payrollSetting.findUnique({ where: { entityId } }));
    const data = {
      payrollEnabled: input.payrollEnabled,
      payDay: input.payDay,
      tier3Offered: input.tier3Offered,
      prorationBasis: prorationBasisToPrisma[input.prorationBasis],
      updatedById: principal.userId,
    };
    const saved = await tx.payrollSetting.upsert({ where: { entityId }, create: { entityId, ...data }, update: data });
    const after = payrollSettingRecord(entityId, saved);
    await recordAuditEvent(
      {
        entityId,
        userId: principal.userId,
        userName: principal.name,
        action: 'EDIT',
        resourceType: 'payroll-settings',
        resourceRef: entityId,
        summary: `Payroll ${after.payrollEnabled ? 'on' : 'off'}; paid on day ${after.payDay}; tier 3 ${after.tier3Offered ? 'offered' : 'not offered'}; part months by ${after.prorationBasis === 'calendar-days' ? 'calendar' : 'working'} days`,
        metadata: { before, after },
      },
      tx,
    );
    refresh();
    return { ok: true, value: after };
  });
}
