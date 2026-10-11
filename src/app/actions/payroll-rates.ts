'use server';

/**
 * Server Functions for the statutory payroll rates.
 *
 * The rates are national law, held once for the whole group — not per entity
 * — so these take no entity and need 'payroll-rates:manage', which only an
 * Owner holds. Every change is written into every entity's audit trail,
 * because every entity's payroll reads the same figures.
 *
 * History is added to, not rewritten. A change in the law is a new set of
 * figures from its own effective date, and the set it replaces is closed the
 * day before — so a payroll for an earlier month still finds exactly the
 * figures it was calculated with.
 *
 * The one exception is a placeholder. A placeholder has never been verified,
 * so no payroll can have been approved with it. Correcting one withdraws it
 * (kept, never deleted, never read again) and puts the corrected figures in
 * beside it. Once a set is marked verified, with where it was checked, the
 * only way to change it is a new set from a later date.
 */

import { refresh } from 'next/cache';
import { Prisma } from '@prisma/client';

import { recordAuditEvent } from '@/lib/audit';
import type { Principal } from '@/lib/authz';
import { authorizationFailure, requirePermission } from '@/lib/dal';
import { fromMinor } from '@/lib/data/money';
import { statutoryRateRecord } from '@/lib/data/payroll-rates';
import { isDate, placeVersion, rateDefinition, validateRateVersion, type RateVersionInput } from '@/lib/payroll-rates';
import { prisma } from '@/lib/prisma';

import type { ActionResult } from './documents';

type Tx = Prisma.TransactionClient;

function fail<T>(error: string): ActionResult<T> {
  return { ok: false, error };
}

async function asRatesOwner<T>(run: (principal: Principal) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  let principal: Principal;
  try {
    principal = await requirePermission('payroll-rates:manage');
  } catch (error) {
    const failure = authorizationFailure(error);
    if (failure) return failure;
    throw error;
  }
  return run(principal);
}

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

/** One event in every entity's trail: the same law reaches every payroll. */
async function audit(tx: Tx, principal: Principal, summary: string, resourceRef: string, before: unknown, after: unknown) {
  const entities = await tx.entity.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
  for (const entity of entities) {
    await recordAuditEvent(
      {
        entityId: entity.id,
        userId: principal.userId,
        userName: principal.name,
        action: 'EDIT',
        resourceType: 'statutory-rate',
        resourceRef,
        summary,
        metadata: { before: before ?? null, after: after ?? null },
      },
      tx,
    );
  }
}

async function versionRows(tx: Tx, key: string, effectiveFrom: string) {
  return tx.statutoryRate.findMany({ where: { key, effectiveFrom: day(effectiveFrom), withdrawnAt: null }, orderBy: { sequence: 'asc' } });
}

export type RateVersionSave = RateVersionInput & {
  /** Verified against GRA or SSNIT as it is entered; needs a source. */
  verified: boolean;
  source?: string | null;
  note?: string | null;
};

function cleanSource(input: RateVersionSave): { problem?: string; source: string | null } {
  const source = input.source?.trim() || null;
  if (input.verified && !source) return { problem: 'Say where the figures were checked — a GRA notice, an SSNIT circular — before marking them verified.', source };
  return { source };
}

function rowsToCreate(input: RateVersionSave, source: string | null, effectiveTo: Date | null, principal: Principal) {
  return input.rows.map((row, sequence) => ({
    key: input.key,
    sequence,
    effectiveFrom: day(input.effectiveFrom),
    effectiveTo,
    rateBasisPoints: row.rateBasisPoints,
    amountMinor: row.amountMinor === null ? null : fromMinor(row.amountMinor),
    maxCount: row.maxCount,
    choice: row.choice ?? null,
    dayOfMonth: row.dayOfMonth ?? null,
    isPlaceholder: !input.verified,
    source,
    note: input.note?.trim() || null,
    updatedById: principal.userId,
  }));
}

/** A new set of figures for one key, from its effective date. */
export async function addRateVersion(input: RateVersionSave): Promise<ActionResult<{ closed: number }>> {
  return asRatesOwner(async (principal) => {
    const problems = validateRateVersion(input);
    if (problems.length) return fail(problems.join(' '));
    const { problem, source } = cleanSource(input);
    if (problem) return fail(problem);

    return prisma.$transaction(async (tx: Tx): Promise<ActionResult<{ closed: number }>> => {
      const existing = (await tx.statutoryRate.findMany({ where: { key: input.key, withdrawnAt: null } })).map(statutoryRateRecord);
      const placed = placeVersion(existing, input.key, input.effectiveFrom);
      if ('problem' in placed) return fail(placed.problem);
      if (placed.closeIds.length) {
        await tx.statutoryRate.updateMany({ where: { id: { in: placed.closeIds } }, data: { effectiveTo: day(placed.closeOn), updatedById: principal.userId } });
      }
      await tx.statutoryRate.createMany({ data: rowsToCreate(input, source, input.effectiveTo ? day(input.effectiveTo) : null, principal) });
      await audit(
        tx,
        principal,
        `New ${rateDefinition(input.key).label} from ${input.effectiveFrom}${placed.closeIds.length ? `; the previous figures end ${placed.closeOn}` : ''}${input.verified ? '' : ' (placeholder)'}`,
        input.key,
        null,
        input,
      );
      refresh();
      return { ok: true, value: { closed: placed.closeIds.length } };
    });
  });
}

/**
 * Correct a set that is still a placeholder: the old rows are withdrawn and
 * the corrected ones go in beside them, with the same dates. Refused once the
 * set has been verified — from then on it is history, and a change is a new set.
 */
export async function correctPlaceholderRates(input: RateVersionSave): Promise<ActionResult<{ ok: true }>> {
  return asRatesOwner(async (principal) => {
    const problems = validateRateVersion(input);
    if (problems.length) return fail(problems.join(' '));
    const { problem, source } = cleanSource(input);
    if (problem) return fail(problem);

    return prisma.$transaction(async (tx: Tx): Promise<ActionResult<{ ok: true }>> => {
      const current = await versionRows(tx, input.key, input.effectiveFrom);
      if (current.length === 0) return fail('Those figures are no longer there. Reload the page.');
      if (current.some((row) => !row.isPlaceholder)) {
        return fail(`${rateDefinition(input.key).label} from ${input.effectiveFrom} has been verified, so it is no longer corrected in place. Enter new figures from the date the change takes effect.`);
      }
      const before = current.map(statutoryRateRecord);
      await tx.statutoryRate.updateMany({ where: { id: { in: current.map((row) => row.id) }, isPlaceholder: true }, data: { withdrawnAt: new Date(), updatedById: principal.userId } });
      await tx.statutoryRate.createMany({ data: rowsToCreate(input, source, current[0].effectiveTo, principal) });
      await audit(tx, principal, `Corrected placeholder ${rateDefinition(input.key).label} from ${input.effectiveFrom}${input.verified ? ' and marked it verified' : ''}`, input.key, before, input);
      refresh();
      return { ok: true, value: { ok: true } };
    });
  });
}

/** Mark a set verified, as it stands, saying where it was checked. */
export async function verifyRates(key: string, effectiveFrom: string, source: string): Promise<ActionResult<{ ok: true }>> {
  return asRatesOwner(async (principal) => {
    const trimmed = source.trim();
    if (!trimmed) return fail('Say where the figures were checked — a GRA notice, an SSNIT circular.');
    return prisma.$transaction(async (tx: Tx): Promise<ActionResult<{ ok: true }>> => {
      const current = await versionRows(tx, key, effectiveFrom);
      if (current.length === 0) return fail('Those figures are no longer there. Reload the page.');
      if (current.every((row) => !row.isPlaceholder)) return fail('Those figures are already verified.');
      await tx.statutoryRate.updateMany({ where: { id: { in: current.map((row) => row.id) } }, data: { isPlaceholder: false, source: trimmed, updatedById: principal.userId } });
      await audit(tx, principal, `Verified ${rateDefinition(key).label} from ${effectiveFrom} against ${trimmed}`, key, current.map(statutoryRateRecord), { source: trimmed });
      refresh();
      return { ok: true, value: { ok: true } };
    });
  });
}

/** End a set on a date — a relief abolished, say — with nothing replacing it. */
export async function endRates(key: string, effectiveFrom: string, lastDay: string): Promise<ActionResult<{ ok: true }>> {
  return asRatesOwner(async (principal) => {
    if (!isDate(lastDay)) return fail('Choose the last day the figures apply.');
    if (lastDay < effectiveFrom) return fail('They cannot end before they start.');
    return prisma.$transaction(async (tx: Tx): Promise<ActionResult<{ ok: true }>> => {
      const current = await versionRows(tx, key, effectiveFrom);
      if (current.length === 0) return fail('Those figures are no longer there. Reload the page.');
      if (current[0].effectiveTo && current[0].effectiveTo.toISOString().slice(0, 10) < lastDay) {
        return fail('Those figures already end earlier. An end date is brought forward, never pushed back.');
      }
      await tx.statutoryRate.updateMany({ where: { id: { in: current.map((row) => row.id) } }, data: { effectiveTo: day(lastDay), updatedById: principal.userId } });
      await audit(tx, principal, `${rateDefinition(key).label} from ${effectiveFrom} now ends ${lastDay}`, key, current.map(statutoryRateRecord), { effectiveTo: lastDay });
      refresh();
      return { ok: true, value: { ok: true } };
    });
  });
}
