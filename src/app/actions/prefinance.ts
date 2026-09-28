'use server';

/**
 * Server Functions for pre-finance: the facility, what is drawn against it,
 * what goes out to aggregators, and what comes back as nuts.
 *
 * Three rules hold throughout:
 *
 *  - Every movement of money posts a balanced journal in the same transaction
 *    that writes the record. A row without its entry, or an entry without its
 *    row, would let the dashboard and the trial balance disagree.
 *  - Quality terms are copied onto an advance when it is created and never
 *    rewritten. Editing the defaults afterwards changes the next advance, not
 *    a deal already struck.
 *  - Nothing is deleted. A bad advance is written off, which is an entry of
 *    its own, not a disappearance.
 *
 * Every export is async, because this is a 'use server' module and the
 * framework requires it.
 */

import { refresh } from 'next/cache';
import { Prisma } from '@prisma/client';

import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess } from '@/lib/dal';
import { fromMinor, toMinor } from '@/lib/data/money';
import {
  aggregatorExposure,
  basisToPrisma,
  moistureToPrisma,
  outturnToPrisma,
} from '@/lib/data/prefinance';
import type { AggregatorAdvanceRecord } from '@/lib/data/types';
import {
  aggregatorRecord,
  ageAdvances,
  checkExposure,
  interestOn,
  netWeight,
  provisionTotal,
  settleQuality,
  validateQualityTerms,
  validateTicket,
  type DayCountBasis,
  type MoistureMethod,
  type OutturnMethod,
  type QualityTerms,
  type SettlementOutcome,
} from '@/lib/prefinance';
import {
  advanceJournal,
  advanceWriteOffJournal,
  deliveryJournal,
  interestAccrualJournal,
  preFinanceAccounts,
  provisionMovementJournal,
  trancheDrawnJournal,
  trancheRepaidJournal,
  type PreFinanceJournalLine,
} from '@/lib/prefinance-posting';
import { prisma } from '@/lib/prisma';

import type { ActionResult } from './documents';

function fail<T>(error: string): ActionResult<T> {
  return { ok: false, error };
}

async function withEntityAccess<T>(
  entityId: string,
  permission: Permission,
  run: (principal: Principal) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  let principal: Principal;
  try {
    principal = await requireEntityAccess(entityId, permission);
  } catch (error) {
    const failure = authorizationFailure(error);
    if (failure) return failure;
    throw error;
  }
  return run(principal);
}

type Tx = Prisma.TransactionClient;

const dateOf = (value: string): Date => new Date(`${value.trim()}T00:00:00.000Z`);
const isoDate = (value: Date): string => value.toISOString().slice(0, 10);
const today = (): string => new Date().toISOString().slice(0, 10);

/** A refusal a person caused, as distinct from something going wrong. */
class Refusal extends Error {}

async function audit(
  tx: Tx,
  entityId: string,
  principal: Principal,
  input: { action?: 'POST' | 'EDIT' | 'VOID'; resourceType: string; resourceRef: string; summary: string; metadata?: unknown },
) {
  await recordAuditEvent(
    {
      entityId,
      userId: principal.userId,
      userName: principal.name,
      action: input.action ?? 'EDIT',
      resourceType: input.resourceType,
      resourceRef: input.resourceRef,
      summary: input.summary,
      metadata: (input.metadata ?? undefined) as Record<string, unknown> | undefined,
    },
    tx,
  );
}

async function namesFor(tx: Tx, entityId: string): Promise<Record<string, string>> {
  const accounts = await tx.account.findMany({ where: { entityId }, select: { code: true, name: true } });
  return Object.fromEntries(accounts.map((account) => [account.code, account.name]));
}

/**
 * Write a balanced entry, or refuse. The balance check is here rather than
 * trusted from the builders because this is the last point at which a wrong
 * entry can still be stopped.
 */
async function postJournal(
  tx: Tx,
  entityId: string,
  lines: PreFinanceJournalLine[],
  date: string,
  reference: string,
  description: string,
  principal: Principal,
): Promise<string | null> {
  if (lines.length === 0) return null;
  const debits = lines.filter((line) => line.type === 'debit').reduce((sum, line) => sum + line.amount, 0);
  const credits = lines.filter((line) => line.type === 'credit').reduce((sum, line) => sum + line.amount, 0);
  if (debits !== credits) throw new Error('Pre-finance journal does not balance; refusing to post');

  const accounts = await tx.account.findMany({
    where: { entityId, code: { in: lines.map((line) => line.accountCode) } },
    select: { id: true, code: true, isActive: true },
  });
  const idOf = new Map(accounts.map((account) => [account.code, account.id]));
  for (const line of lines) {
    if (!idOf.has(line.accountCode)) {
      throw new Refusal(`Account ${line.accountCode} is not in this company's chart. Re-run the seed to add the pre-finance accounts.`);
    }
  }

  const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
  const entry = await tx.journalEntry.create({
    data: {
      entityId,
      kind: 'MANUAL',
      reference,
      description,
      postedAt: dateOf(date),
      postedById: principal.userId,
      lines: {
        create: lines.map((line) => ({
          entityId,
          accountId: idOf.get(line.accountCode) as string,
          txnCurrency: entity.functionalCurrency,
          txnAmountMinor: fromMinor(line.amount),
          rate: new Prisma.Decimal(1),
          amountMinor: fromMinor(line.amount),
          direction: line.type === 'debit' ? ('MONEY_IN' as const) : ('MONEY_OUT' as const),
        })),
      },
    },
    select: { id: true },
  });
  return entry.id;
}

/** Turn a Refusal into a message, and let anything else be a real error. */
async function guarded<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Refusal) return fail(error.message);
    throw error;
  }
}

// --- the defaults a new advance is filled in from -------------------------------------------------

export type PreFinanceSettingsInput = {
  defaultOutturn: number;
  defaultMoisturePct: number;
  defaultMoistureMethod: MoistureMethod;
  defaultMoisturePctPerPoint?: number | null;
  defaultOutturnMethod: OutturnMethod;
  defaultOutturnMinorPerPoint?: number | null;
  defaultOutturnBonus?: boolean | null;
  flagAfterDays: number;
  provisionAfterDays: number;
  provisionPct: number;
};

export async function savePreFinanceSettings(entityId: string, input: PreFinanceSettingsInput): Promise<ActionResult<{ entityId: string }>> {
  return withEntityAccess(entityId, 'prefinance:manage', async (principal) =>
    guarded(async () => {
      const problems = validateQualityTerms({
        outturn: input.defaultOutturn,
        moisturePct: input.defaultMoisturePct,
        moistureMethod: input.defaultMoistureMethod,
        moisturePctPerPoint: input.defaultMoisturePctPerPoint ?? undefined,
        outturnMethod: input.defaultOutturnMethod,
        outturnMinorPerPoint: input.defaultOutturnMinorPerPoint ?? undefined,
      });
      if (problems.length) return fail(problems.join(' '));
      if (input.flagAfterDays < 0 || input.provisionAfterDays < 0) return fail('Days cannot be negative.');
      if (input.provisionPct < 0 || input.provisionPct > 100) return fail('The provision has to be between nil and 100%.');
      if (input.provisionAfterDays < input.flagAfterDays) {
        return fail('An advance cannot be provided against before it is even flagged. Make the provision day the later of the two.');
      }

      const data = {
        defaultOutturn: new Prisma.Decimal(input.defaultOutturn),
        defaultMoisturePct: new Prisma.Decimal(input.defaultMoisturePct),
        defaultMoistureMethod: moistureToPrisma[input.defaultMoistureMethod],
        defaultMoisturePctPerPoint:
          input.defaultMoisturePctPerPoint === null || input.defaultMoisturePctPerPoint === undefined
            ? null
            : new Prisma.Decimal(input.defaultMoisturePctPerPoint),
        defaultOutturnMethod: outturnToPrisma[input.defaultOutturnMethod],
        defaultOutturnMinorPerPoint:
          input.defaultOutturnMinorPerPoint === null || input.defaultOutturnMinorPerPoint === undefined
            ? null
            : fromMinor(input.defaultOutturnMinorPerPoint),
        defaultOutturnBonus: input.defaultOutturnBonus ?? null,
        flagAfterDays: input.flagAfterDays,
        provisionAfterDays: input.provisionAfterDays,
        provisionPct: new Prisma.Decimal(input.provisionPct),
        updatedById: principal.userId,
      };

      await prisma.$transaction(async (tx) => {
        await tx.preFinanceSetting.upsert({ where: { entityId }, create: { entityId, ...data }, update: data });
        await audit(tx, entityId, principal, {
          resourceType: 'prefinance-settings',
          resourceRef: entityId,
          summary: `Pre-finance defaults set to ${input.defaultOutturn} outturn and ${input.defaultMoisturePct}% moisture`,
          metadata: { after: input },
        });
      });

      refresh();
      return { ok: true, value: { entityId } };
    }),
  );
}

// --- the facility ---------------------------------------------------------------------------------

export type FacilityInput = {
  id?: string;
  reference: string;
  lenderId?: string | null;
  limitMinor: number;
  ratePct: string;
  basis: DayCountBasis;
  startsOn: string;
  endsOn?: string | null;
  notes?: string;
};

export async function saveFacility(entityId: string, input: FacilityInput): Promise<ActionResult<{ id: string }>> {
  return withEntityAccess(entityId, 'prefinance:manage', async (principal) =>
    guarded(async () => {
      const reference = input.reference.trim();
      if (!reference) return fail('A facility needs a reference so it can be told from the others.');
      if (input.limitMinor <= 0) return fail('A facility needs a limit of more than nil.');
      const rate = Number(input.ratePct);
      if (!Number.isFinite(rate) || rate < 0) return fail('The interest rate has to be a number of nil or more.');
      if (input.endsOn && input.endsOn < input.startsOn) return fail('A facility cannot end before it starts.');

      const clash = await prisma.loanFacility.findFirst({ where: { entityId, reference, NOT: input.id ? { id: input.id } : undefined }, select: { id: true } });
      if (clash) return fail(`There is already a facility called ${reference} on this company.`);

      const data = {
        reference,
        lenderId: input.lenderId?.trim() || null,
        limitMinor: fromMinor(input.limitMinor),
        ratePct: new Prisma.Decimal(input.ratePct),
        basis: basisToPrisma[input.basis],
        startsOn: dateOf(input.startsOn),
        endsOn: input.endsOn ? dateOf(input.endsOn) : null,
        notes: input.notes?.trim() || null,
      };

      const id = await prisma.$transaction(async (tx) => {
        if (input.id) {
          const current = await tx.loanFacility.findFirst({ where: { id: input.id, entityId }, select: { id: true } });
          if (!current) throw new Refusal('That facility is not on this company.');
          // Reducing a limit below what is already drawn would make the
          // headroom negative, which is not a thing that can be true.
          const drawn = await tx.loanTranche.aggregate({ where: { facilityId: input.id, entityId, repaidOn: null }, _sum: { amountMinor: true } });
          const outstanding = drawn._sum.amountMinor ? toMinor(drawn._sum.amountMinor) : 0;
          if (input.limitMinor < outstanding) {
            throw new Refusal(`GHS ${(outstanding / 100).toLocaleString()} is already drawn on this facility, so the limit cannot be set below that.`);
          }
          await tx.loanFacility.update({ where: { id: input.id }, data });
          await audit(tx, entityId, principal, { resourceType: 'loan-facility', resourceRef: reference, summary: `Facility ${reference} changed`, metadata: { after: input } });
          return input.id;
        }
        const created = await tx.loanFacility.create({ data: { entityId, ...data, createdById: principal.userId }, select: { id: true } });
        await audit(tx, entityId, principal, {
          resourceType: 'loan-facility',
          resourceRef: reference,
          summary: `Facility ${reference} added, limit GHS ${(input.limitMinor / 100).toLocaleString()} at ${input.ratePct}%`,
          metadata: { after: input },
        });
        return created.id;
      });

      refresh();
      return { ok: true, value: { id } };
    }),
  );
}

export async function closeFacility(entityId: string, facilityId: string): Promise<ActionResult<{ id: string }>> {
  return withEntityAccess(entityId, 'prefinance:manage', async (principal) =>
    guarded(async () => {
      const facility = await prisma.loanFacility.findFirst({
        where: { id: facilityId, entityId },
        select: { reference: true, tranches: { where: { repaidOn: null }, select: { id: true } } },
      });
      if (!facility) return fail('That facility is not on this company.');
      if (facility.tranches.length > 0) {
        return fail(`${facility.tranches.length} drawdown${facility.tranches.length === 1 ? ' has' : 's have'} not been repaid, so this facility is not finished.`);
      }

      await prisma.$transaction(async (tx) => {
        await tx.loanFacility.update({ where: { id: facilityId }, data: { status: 'CLOSED' } });
        await audit(tx, entityId, principal, { resourceType: 'loan-facility', resourceRef: facility.reference, summary: `Facility ${facility.reference} closed` });
      });

      refresh();
      return { ok: true, value: { id: facilityId } };
    }),
  );
}

// --- drawing and repaying ---------------------------------------------------------------------------

export type TrancheInput = {
  facilityId: string;
  drawnOn: string;
  amountMinor: number;
  bankAccountId: string;
};

export async function drawTranche(entityId: string, input: TrancheInput): Promise<ActionResult<{ id: string }>> {
  return withEntityAccess(entityId, 'prefinance:manage', async (principal) =>
    guarded(async () => {
      if (input.amountMinor <= 0) return fail('A drawdown has to be more than nil.');

      const id = await prisma.$transaction(async (tx) => {
        const facility = await tx.loanFacility.findFirst({
          where: { id: input.facilityId, entityId },
          select: { reference: true, limitMinor: true, status: true, startsOn: true, tranches: { where: { repaidOn: null }, select: { amountMinor: true } } },
        });
        if (!facility) throw new Refusal('That facility is not on this company.');
        if (facility.status === 'CLOSED') throw new Refusal('That facility is closed. Reopen it before drawing on it.');
        if (dateOf(input.drawnOn) < facility.startsOn) throw new Refusal('A drawdown cannot be dated before the facility starts.');

        const outstanding = facility.tranches.reduce((sum, tranche) => sum + toMinor(tranche.amountMinor), 0);
        const headroom = toMinor(facility.limitMinor) - outstanding;
        if (input.amountMinor > headroom) {
          throw new Refusal(`Only GHS ${(headroom / 100).toLocaleString()} is left on this facility. Repay some of it, or raise the limit.`);
        }

        const bank = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, entityId }, select: { account: { select: { code: true } } } });
        if (!bank) throw new Refusal('That bank account is not on this company.');

        const names = await namesFor(tx, entityId);
        const lines = trancheDrawnJournal(input.amountMinor, bank.account.code, names);
        const reference = `DRAW-${input.drawnOn}-${facility.reference}`;
        const journalEntryId = await postJournal(tx, entityId, lines, input.drawnOn, reference, `Drawdown on ${facility.reference}`, principal);

        const tranche = await tx.loanTranche.create({
          data: {
            entityId,
            facilityId: input.facilityId,
            drawnOn: dateOf(input.drawnOn),
            amountMinor: fromMinor(input.amountMinor),
            bankAccountId: input.bankAccountId,
            journalEntryId,
            createdById: principal.userId,
          },
          select: { id: true },
        });

        await audit(tx, entityId, principal, {
          action: 'POST',
          resourceType: 'loan-tranche',
          resourceRef: reference,
          summary: `GHS ${(input.amountMinor / 100).toLocaleString()} drawn on ${facility.reference}`,
          metadata: { after: input },
        });
        return tranche.id;
      });

      refresh();
      return { ok: true, value: { id } };
    }),
  );
}

export async function repayTranche(entityId: string, trancheId: string, input: { repaidOn: string; bankAccountId: string }): Promise<ActionResult<{ id: string }>> {
  return withEntityAccess(entityId, 'prefinance:manage', async (principal) =>
    guarded(async () => {
      await prisma.$transaction(async (tx) => {
        const tranche = await tx.loanTranche.findFirst({
          where: { id: trancheId, entityId },
          select: { amountMinor: true, repaidOn: true, drawnOn: true, facility: { select: { reference: true } } },
        });
        if (!tranche) throw new Refusal('That drawdown is not on this company.');
        if (tranche.repaidOn) throw new Refusal('That drawdown has already been repaid.');
        if (dateOf(input.repaidOn) < tranche.drawnOn) throw new Refusal('A repayment cannot be dated before the drawdown.');

        const bank = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, entityId }, select: { account: { select: { code: true } } } });
        if (!bank) throw new Refusal('That bank account is not on this company.');

        const amount = toMinor(tranche.amountMinor);
        const names = await namesFor(tx, entityId);
        const reference = `REPAY-${input.repaidOn}-${tranche.facility.reference}`;
        await postJournal(tx, entityId, trancheRepaidJournal(amount, bank.account.code, names), input.repaidOn, reference, `Repayment on ${tranche.facility.reference}`, principal);

        await tx.loanTranche.update({ where: { id: trancheId }, data: { repaidOn: dateOf(input.repaidOn) } });
        await audit(tx, entityId, principal, {
          action: 'POST',
          resourceType: 'loan-tranche',
          resourceRef: reference,
          summary: `GHS ${(amount / 100).toLocaleString()} repaid on ${tranche.facility.reference}`,
        });
      });

      refresh();
      return { ok: true, value: { id: trancheId } };
    }),
  );
}

/**
 * Interest from where it was last charged up to a date.
 *
 * Charged on the principal for the days it was actually out, on the facility's
 * own basis, so a cycle carries the financing it consumed rather than whatever
 * the lender happened to bill that month.
 */
export async function accrueTrancheInterest(entityId: string, trancheId: string, toDate: string): Promise<ActionResult<{ interestMinor: number }>> {
  return withEntityAccess(entityId, 'prefinance:manage', async (principal) =>
    guarded(async () => {
      const result = await prisma.$transaction(async (tx) => {
        const tranche = await tx.loanTranche.findFirst({
          where: { id: trancheId, entityId },
          select: {
            amountMinor: true,
            drawnOn: true,
            repaidOn: true,
            interestToDate: true,
            interestMinor: true,
            facility: { select: { reference: true, ratePct: true, basis: true } },
          },
        });
        if (!tranche) throw new Refusal('That drawdown is not on this company.');

        const from = isoDate(tranche.interestToDate ?? tranche.drawnOn);
        // Interest stops when the principal is repaid, whatever date is asked for.
        const stop = tranche.repaidOn ? isoDate(tranche.repaidOn) : toDate;
        const to = stop < toDate ? stop : toDate;
        if (to <= from) throw new Refusal(`Interest is already charged to ${from}. Choose a later date.`);

        const basis: DayCountBasis = tranche.facility.basis === 'ACTUAL_360' ? 'actual/360' : tranche.facility.basis === 'THIRTY_360' ? '30/360' : 'actual/365';
        const days = Math.max(0, Math.round((dateOf(to).getTime() - dateOf(from).getTime()) / 86_400_000));
        const amount = interestOn(toMinor(tranche.amountMinor), Number(tranche.facility.ratePct.toString()), days, basis);
        if (amount <= 0) throw new Refusal('That period works out at no interest.');

        const names = await namesFor(tx, entityId);
        const reference = `INT-${to}-${tranche.facility.reference}`;
        await postJournal(tx, entityId, interestAccrualJournal(amount, names), to, reference, `Interest on ${tranche.facility.reference}, ${from} to ${to}`, principal);

        await tx.loanTranche.update({
          where: { id: trancheId },
          data: { interestToDate: dateOf(to), interestMinor: fromMinor(toMinor(tranche.interestMinor) + amount) },
        });
        await audit(tx, entityId, principal, {
          action: 'POST',
          resourceType: 'loan-interest',
          resourceRef: reference,
          summary: `GHS ${(amount / 100).toLocaleString()} interest charged for ${days} days on ${tranche.facility.reference}`,
        });
        return { interestMinor: amount };
      });

      refresh();
      return { ok: true, value: result };
    }),
  );
}

// --- advancing to an aggregator ----------------------------------------------------------------------

export type AdvanceInput = {
  reference: string;
  aggregatorId: string;
  advancedOn: string;
  expectedOn: string;
  amountMinor: number;
  pricePerKgMinor: number;
  bankAccountId: string;
  facilityId?: string | null;
  terms: QualityTerms;
  notes?: string;
  /** Set once the exposure warning has been seen and accepted. */
  acknowledgedExposure?: boolean;
};

export async function saveAdvance(entityId: string, input: AdvanceInput): Promise<ActionResult<{ id: string; warning?: string }>> {
  return withEntityAccess(entityId, 'prefinance:manage', async (principal) =>
    guarded(async () => {
      const reference = input.reference.trim();
      if (!reference) return fail('An advance needs a reference.');
      if (input.amountMinor <= 0) return fail('An advance has to be more than nil.');
      if (input.pricePerKgMinor <= 0) return fail('An advance needs an agreed price per kilogram.');
      if (input.expectedOn < input.advancedOn) return fail('Nuts cannot be expected before the money goes out.');

      const problems = validateQualityTerms(input.terms);
      if (problems.length) return fail(problems.join(' '));

      const clash = await prisma.aggregatorAdvance.findFirst({ where: { entityId, reference }, select: { id: true } });
      if (clash) return fail(`There is already an advance called ${reference} on this company.`);

      // What this aggregator already owes, before adding to it.
      const exposure = await aggregatorExposure(entityId, input.aggregatorId);
      if (!exposure) return fail('That aggregator is not a contact on this system.');
      const record = aggregatorRecord({
        advancedMinor: exposure.advancedMinor,
        deliveredValueMinor: exposure.deliveredValueMinor,
        deliveries: exposure.completedCount,
        daysToDeliver: exposure.daysToDeliver,
        qualityVariances: exposure.qualityVariances,
        unrecoveredMinor: exposure.unrecoveredMinor,
        currentExposureMinor: exposure.outstandingMinor,
        // Nil rather than null: the domain reads nil as no limit agreed.
        exposureLimitMinor: exposure.exposureLimitMinor ?? 0,
      });
      const check = checkExposure(record, input.amountMinor, exposure.name);
      if (!check.ok && !input.acknowledgedExposure) return fail(check.warning);

      const id = await prisma.$transaction(async (tx) => {
        const bank = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, entityId }, select: { account: { select: { code: true } } } });
        if (!bank) throw new Refusal('That bank account is not on this company.');
        if (input.facilityId) {
          const facility = await tx.loanFacility.findFirst({ where: { id: input.facilityId, entityId }, select: { id: true } });
          if (!facility) throw new Refusal('That facility is not on this company.');
        }

        const names = await namesFor(tx, entityId);
        const journalEntryId = await postJournal(
          tx,
          entityId,
          advanceJournal(input.amountMinor, bank.account.code, names),
          input.advancedOn,
          reference,
          `Advance to ${exposure.name}`,
          principal,
        );

        const created = await tx.aggregatorAdvance.create({
          data: {
            entityId,
            reference,
            aggregatorId: input.aggregatorId,
            advancedOn: dateOf(input.advancedOn),
            expectedOn: dateOf(input.expectedOn),
            amountMinor: fromMinor(input.amountMinor),
            pricePerKgMinor: fromMinor(input.pricePerKgMinor),
            bankAccountId: input.bankAccountId,
            facilityId: input.facilityId || null,
            outturn: new Prisma.Decimal(input.terms.outturn),
            moisturePct: new Prisma.Decimal(input.terms.moisturePct),
            moistureMethod: moistureToPrisma[input.terms.moistureMethod],
            moisturePctPerPoint: input.terms.moisturePctPerPoint === undefined ? null : new Prisma.Decimal(input.terms.moisturePctPerPoint),
            outturnMethod: outturnToPrisma[input.terms.outturnMethod],
            outturnMinorPerPoint: input.terms.outturnMinorPerPoint === undefined ? null : fromMinor(input.terms.outturnMinorPerPoint),
            outturnBonus: input.terms.outturnBonus ?? null,
            notes: input.notes?.trim() || null,
            journalEntryId,
            createdById: principal.userId,
          },
          select: { id: true },
        });

        await audit(tx, entityId, principal, {
          action: 'POST',
          resourceType: 'aggregator-advance',
          resourceRef: reference,
          summary: `GHS ${(input.amountMinor / 100).toLocaleString()} advanced to ${exposure.name}, nuts expected ${input.expectedOn}`,
          metadata: { after: input, exposureAtTime: exposure.outstandingMinor, acknowledged: input.acknowledgedExposure ?? false },
        });
        return created.id;
      });

      refresh();
      return { ok: true, value: { id, warning: check.ok ? undefined : check.warning } };
    }),
  );
}

// --- a load arriving ------------------------------------------------------------------------------

export type DeliveryInput = {
  advanceId: string;
  deliveredOn: string;
  /** What the ticket said. Kept so a dispute is settled against the paper. */
  vehicle?: string;
  waybill?: string;
  grossGrams?: number | null;
  tareGrams?: number | null;
  bags?: number | null;
  assayedBy?: string;
  /** Used when there was no weighbridge. Ignored when gross and tare are given. */
  netGrams?: number | null;
  outturn: number;
  moisturePct: number;
  outcome: SettlementOutcome;
  notes?: string;
};

/**
 * Record what a load actually weighed and assayed, settle it against the terms
 * on the advance, and post it.
 *
 * The settlement is worked out here from the advance's own stored terms rather
 * than from anything the caller sends, so a screen cannot talk the books into
 * a different answer.
 */
export async function recordDelivery(entityId: string, input: DeliveryInput): Promise<ActionResult<{ id: string; settledValueMinor: number; varianceMinor: number }>> {
  return withEntityAccess(entityId, 'prefinance:deliver', async (principal) =>
    guarded(async () => {
      // The ticket is read here rather than trusting a weight the screen sent,
      // so a load settles on what was actually weighed.
      const ticketProblems = validateTicket(input);
      if (ticketProblems.length) return fail(ticketProblems.join(' '));
      const grams = netWeight(input);
      if (grams === null || grams <= 0) return fail('A delivery needs a weight of more than nil.');
      if (input.outturn <= 0) return fail('A delivery needs an outturn of more than nil.');
      if (input.moisturePct < 0 || input.moisturePct >= 100) return fail('Moisture has to be between nil and 100%.');

      const result = await prisma.$transaction(async (tx) => {
        const advance = await tx.aggregatorAdvance.findFirst({
          where: { id: input.advanceId, entityId },
          include: { aggregator: { select: { name: true } }, deliveries: { select: { settledValueMinor: true } } },
        });
        if (!advance) throw new Refusal('That advance is not on this company.');
        if (advance.status !== 'OPEN') throw new Refusal('That advance is already closed, so nothing more can be delivered against it.');
        if (dateOf(input.deliveredOn) < advance.advancedOn) throw new Refusal('Nuts cannot arrive before the money went out.');

        const terms: QualityTerms = {
          outturn: Number(advance.outturn.toString()),
          moisturePct: Number(advance.moisturePct.toString()),
          moistureMethod: advance.moistureMethod === 'PRICE_DEDUCTION' ? 'price-deduction' : 'weight-deduction',
          moisturePctPerPoint: advance.moisturePctPerPoint === null ? undefined : Number(advance.moisturePctPerPoint.toString()),
          outturnMethod: advance.outturnMethod === 'PER_POINT' ? 'per-point' : 'proportional',
          outturnMinorPerPoint: advance.outturnMinorPerPoint === null ? undefined : toMinor(advance.outturnMinorPerPoint),
          outturnBonus: advance.outturnBonus ?? undefined,
        };

        const settlement = settleQuality(terms, toMinor(advance.pricePerKgMinor), {
          grams,
          outturn: input.outturn,
          moisturePct: input.moisturePct,
        });

        const deliveredSoFar = advance.deliveries.reduce((sum, delivery) => sum + toMinor(delivery.settledValueMinor), 0);
        const outstanding = Math.max(toMinor(advance.amountMinor) - deliveredSoFar, 0);

        const names = await namesFor(tx, entityId);
        const reference = `DEL-${input.deliveredOn}-${advance.reference}`;
        const journalEntryId = await postJournal(
          tx,
          entityId,
          deliveryJournal(
            {
              settledValueMinor: settlement.settledValueMinor,
              advanceOutstandingMinor: outstanding,
              outcome: input.outcome,
              inventoryCode: preFinanceAccounts.rawMaterials,
              payableCode: '2001',
            },
            names,
          ),
          input.deliveredOn,
          reference,
          `Delivery from ${advance.aggregator.name} against ${advance.reference}`,
          principal,
        );

        const delivery = await tx.advanceDelivery.create({
          data: {
            entityId,
            advanceId: input.advanceId,
            deliveredOn: dateOf(input.deliveredOn),
            vehicle: input.vehicle?.trim() || null,
            waybill: input.waybill?.trim() || null,
            grossGrams: input.grossGrams ? fromMinor(input.grossGrams) : null,
            tareGrams: input.tareGrams ? fromMinor(input.tareGrams) : null,
            bags: input.bags ?? null,
            assayedBy: input.assayedBy?.trim() || null,
            grams: fromMinor(grams),
            outturn: new Prisma.Decimal(input.outturn),
            moisturePct: new Prisma.Decimal(input.moisturePct),
            adjustedGrams: fromMinor(settlement.adjustedGrams),
            adjustedPricePerKgMinor: fromMinor(settlement.adjustedPricePerKgMinor),
            valueAtBasisMinor: fromMinor(settlement.valueAtBasisMinor),
            settledValueMinor: fromMinor(settlement.settledValueMinor),
            varianceMinor: fromMinor(settlement.varianceMinor),
            moistureVarianceMinor: fromMinor(settlement.moistureVarianceMinor),
            outturnVarianceMinor: fromMinor(settlement.outturnVarianceMinor),
            notes: input.notes?.trim() || null,
            journalEntryId,
            createdById: principal.userId,
          },
          select: { id: true },
        });

        // The advance closes when enough has come in, or when the shortfall
        // has been squared off rather than carried against the next load.
        const nowDelivered = deliveredSoFar + settlement.settledValueMinor;
        const cleared = nowDelivered >= toMinor(advance.amountMinor) || input.outcome === 'square';
        if (cleared) {
          await tx.aggregatorAdvance.update({ where: { id: input.advanceId }, data: { status: 'SETTLED', settledOn: dateOf(input.deliveredOn) } });
        }

        await audit(tx, entityId, principal, {
          action: 'POST',
          resourceType: 'advance-delivery',
          resourceRef: reference,
          summary:
            `${(grams / 1000).toLocaleString()}kg from ${advance.aggregator.name} at ${input.outturn} outturn, ${input.moisturePct}% moisture — ` +
            `settled GHS ${(settlement.settledValueMinor / 100).toLocaleString()}` +
            (settlement.varianceMinor === 0 ? '' : ` (${settlement.varianceMinor < 0 ? 'under' : 'over'} by GHS ${(Math.abs(settlement.varianceMinor) / 100).toLocaleString()})`),
          metadata: { after: input, settlement, closed: cleared },
        });

        return { id: delivery.id, settledValueMinor: settlement.settledValueMinor, varianceMinor: settlement.varianceMinor };
      });

      refresh();
      return { ok: true, value: result };
    }),
  );
}

// --- what the old ones are worth --------------------------------------------------------------------

/**
 * Provide against advances that have gone past the threshold, as one movement
 * for the whole entity.
 *
 * Posted as the change in the required provision rather than the provision
 * itself, so running it twice in a month does not charge twice.
 */
export async function runAdvanceProvision(entityId: string, asOf: string = today()): Promise<ActionResult<{ requiredMinor: number; movementMinor: number; flagged: number }>> {
  return withEntityAccess(entityId, 'prefinance:manage', async (principal) =>
    guarded(async () => {
      const result = await prisma.$transaction(async (tx) => {
        const setting = await tx.preFinanceSetting.findUnique({ where: { entityId } });
        const thresholds = {
          flagAfterDays: setting?.flagAfterDays ?? 14,
          provisionAfterDays: setting?.provisionAfterDays ?? 60,
          provisionPct: setting ? Number(setting.provisionPct.toString()) : 50,
        };

        const open = await tx.aggregatorAdvance.findMany({
          where: { entityId, status: 'OPEN' },
          select: { id: true, aggregatorId: true, amountMinor: true, advancedOn: true, expectedOn: true, aggregator: { select: { name: true } }, deliveries: { select: { settledValueMinor: true } } },
        });

        const aged = ageAdvances(
          open.map((advance) => ({
            id: advance.id,
            aggregatorId: advance.aggregatorId,
            aggregatorName: advance.aggregator.name,
            amountMinor: Math.max(
              toMinor(advance.amountMinor) - advance.deliveries.reduce((sum, delivery) => sum + toMinor(delivery.settledValueMinor), 0),
              0,
            ),
            advancedOn: isoDate(advance.advancedOn),
            expectedOn: isoDate(advance.expectedOn),
          })),
          thresholds,
          asOf,
        );
        const required = provisionTotal(aged);

        // What is already sitting on the provision account.
        const provisionAccount = await tx.account.findFirst({ where: { entityId, code: preFinanceAccounts.advanceProvision }, select: { id: true } });
        if (!provisionAccount) throw new Refusal("This company's chart has no advance provision account. Re-run the seed.");
        const lines = await tx.journalLine.findMany({ where: { entityId, accountId: provisionAccount.id }, select: { amountMinor: true, direction: true } });
        const alreadyProvided = lines.reduce(
          (sum, line) => sum + (line.direction === 'MONEY_OUT' ? toMinor(line.amountMinor) : -toMinor(line.amountMinor)),
          0,
        );

        const movement = provisionMovementJournal(required, alreadyProvided, await namesFor(tx, entityId));
        if (movement.length > 0) {
          await postJournal(tx, entityId, movement, asOf, `PROV-${asOf}`, `Provision against aggregator advances at ${asOf}`, principal);
        }

        await audit(tx, entityId, principal, {
          action: 'POST',
          resourceType: 'advance-provision',
          resourceRef: `PROV-${asOf}`,
          summary:
            movement.length === 0
              ? `Provision unchanged at GHS ${(required / 100).toLocaleString()}`
              : `Provision moved to GHS ${(required / 100).toLocaleString()} against ${aged.filter((a) => a.provisionMinor > 0).length} advances`,
          metadata: { required, alreadyProvided, asOf },
        });

        return { requiredMinor: required, movementMinor: required - alreadyProvided, flagged: aged.filter((advance) => advance.flagged).length };
      });

      refresh();
      return { ok: true, value: result };
    }),
  );
}

/**
 * Give up on an advance.
 *
 * Whatever has already been provided against it is spent first, so the same
 * loss is never charged twice — once when it looked doubtful and again when it
 * became certain. Nothing is deleted: the advance stays, marked.
 */
export async function writeOffAdvance(entityId: string, advanceId: string, input: { onDate: string; reason: string }): Promise<ActionResult<{ id: string; writtenOffMinor: number }>> {
  return withEntityAccess(entityId, 'prefinance:manage', async (principal) =>
    guarded(async () => {
      if (!input.reason.trim()) return fail('Say why this advance is being written off. It stays on the record.');

      const result = await prisma.$transaction(async (tx) => {
        const advance = await tx.aggregatorAdvance.findFirst({
          where: { id: advanceId, entityId },
          select: { reference: true, status: true, amountMinor: true, aggregator: { select: { name: true } }, deliveries: { select: { settledValueMinor: true } } },
        });
        if (!advance) throw new Refusal('That advance is not on this company.');
        if (advance.status !== 'OPEN') throw new Refusal('That advance is already closed.');

        const delivered = advance.deliveries.reduce((sum, delivery) => sum + toMinor(delivery.settledValueMinor), 0);
        const outstanding = Math.max(toMinor(advance.amountMinor) - delivered, 0);
        if (outstanding <= 0) throw new Refusal('There is nothing left outstanding on that advance.');

        const provisionAccount = await tx.account.findFirst({ where: { entityId, code: preFinanceAccounts.advanceProvision }, select: { id: true } });
        const lines = provisionAccount
          ? await tx.journalLine.findMany({ where: { entityId, accountId: provisionAccount.id }, select: { amountMinor: true, direction: true } })
          : [];
        const provided = lines.reduce(
          (sum, line) => sum + (line.direction === 'MONEY_OUT' ? toMinor(line.amountMinor) : -toMinor(line.amountMinor)),
          0,
        );

        const names = await namesFor(tx, entityId);
        const reference = `WOFF-${input.onDate}-${advance.reference}`;
        await postJournal(
          tx,
          entityId,
          advanceWriteOffJournal(outstanding, Math.max(provided, 0), names),
          input.onDate,
          reference,
          `Advance to ${advance.aggregator.name} written off`,
          principal,
        );

        await tx.aggregatorAdvance.update({
          where: { id: advanceId },
          data: { status: 'WRITTEN_OFF', settledOn: dateOf(input.onDate), notes: input.reason.trim() },
        });

        await audit(tx, entityId, principal, {
          action: 'VOID',
          resourceType: 'aggregator-advance',
          resourceRef: reference,
          summary: `GHS ${(outstanding / 100).toLocaleString()} owed by ${advance.aggregator.name} written off: ${input.reason.trim()}`,
          metadata: { outstanding, provided },
        });

        return { id: advanceId, writtenOffMinor: outstanding };
      });

      refresh();
      return { ok: true, value: result };
    }),
  );
}

// --- how much a contact may owe at once ---------------------------------------------------------------

export async function setExposureLimit(entityId: string, contactId: string, limitMinor: number | null): Promise<ActionResult<{ contactId: string }>> {
  return withEntityAccess(entityId, 'prefinance:manage', async (principal) =>
    guarded(async () => {
      if (limitMinor !== null && limitMinor < 0) return fail('A limit cannot be less than nil.');
      const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { name: true } });
      if (!contact) return fail('That contact is not on this system.');

      await prisma.$transaction(async (tx) => {
        await tx.contact.update({ where: { id: contactId }, data: { exposureLimitMinor: limitMinor === null ? null : fromMinor(limitMinor) } });
        await audit(tx, entityId, principal, {
          resourceType: 'contact',
          resourceRef: contact.name,
          summary:
            limitMinor === null
              ? `Exposure limit removed for ${contact.name}`
              : `Exposure limit for ${contact.name} set to GHS ${(limitMinor / 100).toLocaleString()}`,
          metadata: { after: limitMinor },
        });
      });

      refresh();
      return { ok: true, value: { contactId } };
    }),
  );
}

// --- the loop the money goes round in -------------------------------------------------------------------

export type CycleInput = {
  id?: string;
  reference: string;
  facilityId?: string | null;
  drawnOn: string;
  advancedOn?: string | null;
  deliveredOn?: string | null;
  processedOn?: string | null;
  soldOn?: string | null;
  cashBackOn?: string | null;
  drawnMinor: number;
  advancedMinor?: number;
  proceedsMinor?: number;
  costsMinor?: number;
  notes?: string;
};

export async function saveCycle(entityId: string, input: CycleInput): Promise<ActionResult<{ id: string }>> {
  return withEntityAccess(entityId, 'prefinance:manage', async (principal) =>
    guarded(async () => {
      const reference = input.reference.trim();
      if (!reference) return fail('A cycle needs a reference.');
      if (input.drawnMinor <= 0) return fail('A cycle starts with money drawn, so that has to be more than nil.');

      // The stages happen in an order. Out of order usually means a typo, and
      // a cycle read backwards would make the recycle figures nonsense.
      const stages: [string, string | null | undefined][] = [
        ['drawn', input.drawnOn],
        ['advanced', input.advancedOn],
        ['delivered', input.deliveredOn],
        ['processed', input.processedOn],
        ['sold', input.soldOn],
        ['cash back', input.cashBackOn],
      ];
      const given = stages.filter(([, date]) => !!date) as [string, string][];
      for (let index = 1; index < given.length; index += 1) {
        if (given[index][1] < given[index - 1][1]) {
          return fail(`${given[index][0]} is dated before ${given[index - 1][0]}. Check the dates.`);
        }
      }

      const clash = await prisma.preFinanceCycle.findFirst({ where: { entityId, reference, NOT: input.id ? { id: input.id } : undefined }, select: { id: true } });
      if (clash) return fail(`There is already a cycle called ${reference} on this company.`);

      const data = {
        reference,
        facilityId: input.facilityId || null,
        drawnOn: dateOf(input.drawnOn),
        advancedOn: input.advancedOn ? dateOf(input.advancedOn) : null,
        deliveredOn: input.deliveredOn ? dateOf(input.deliveredOn) : null,
        processedOn: input.processedOn ? dateOf(input.processedOn) : null,
        soldOn: input.soldOn ? dateOf(input.soldOn) : null,
        cashBackOn: input.cashBackOn ? dateOf(input.cashBackOn) : null,
        drawnMinor: fromMinor(input.drawnMinor),
        advancedMinor: fromMinor(input.advancedMinor ?? 0),
        proceedsMinor: fromMinor(input.proceedsMinor ?? 0),
        costsMinor: fromMinor(input.costsMinor ?? 0),
        notes: input.notes?.trim() || null,
      };

      const id = await prisma.$transaction(async (tx) => {
        if (input.id) {
          const current = await tx.preFinanceCycle.findFirst({ where: { id: input.id, entityId }, select: { id: true } });
          if (!current) throw new Refusal('That cycle is not on this company.');
          await tx.preFinanceCycle.update({ where: { id: input.id }, data });
          await audit(tx, entityId, principal, { resourceType: 'prefinance-cycle', resourceRef: reference, summary: `Cycle ${reference} changed`, metadata: { after: input } });
          return input.id;
        }
        const created = await tx.preFinanceCycle.create({ data: { entityId, ...data, createdById: principal.userId }, select: { id: true } });
        await audit(tx, entityId, principal, { resourceType: 'prefinance-cycle', resourceRef: reference, summary: `Cycle ${reference} started, GHS ${(input.drawnMinor / 100).toLocaleString()} drawn`, metadata: { after: input } });
        return created.id;
      });

      refresh();
      return { ok: true, value: { id } };
    }),
  );
}

/** One aggregator's record and what is at risk with them, for the advance screen. */
export async function readAggregatorExposure(
  entityId: string,
  aggregatorId: string,
): Promise<
  ActionResult<{
    name: string;
    outstandingMinor: number;
    limitMinor: number | null;
    availableMinor: number | null;
    deliveries: number;
    averageDays: number | null;
    averageQualityVarianceMinor: number | null;
    unrecoveredMinor: number;
  }>
> {
  return withEntityAccess(entityId, 'reports:view', async () =>
    guarded(async () => {
      const exposure = await aggregatorExposure(entityId, aggregatorId);
      if (!exposure) return fail('That aggregator is not a contact on this system.');
      const record = aggregatorRecord({
        advancedMinor: exposure.advancedMinor,
        deliveredValueMinor: exposure.deliveredValueMinor,
        deliveries: exposure.completedCount,
        daysToDeliver: exposure.daysToDeliver,
        qualityVariances: exposure.qualityVariances,
        unrecoveredMinor: exposure.unrecoveredMinor,
        currentExposureMinor: exposure.outstandingMinor,
        // Nil rather than null: the domain reads nil as no limit agreed.
        exposureLimitMinor: exposure.exposureLimitMinor ?? 0,
      });
      return {
        ok: true,
        value: {
          name: exposure.name,
          outstandingMinor: exposure.outstandingMinor,
          limitMinor: exposure.exposureLimitMinor,
          availableMinor: record.availableMinor,
          deliveries: record.deliveries,
          averageDays: record.averageDaysToDeliver,
          averageQualityVarianceMinor: record.averageQualityVarianceMinor,
          unrecoveredMinor: record.unrecoveredMinor,
        },
      };
    }),
  );
}

/** Kept so the isolation test can see the record type this module returns. */
export type { AggregatorAdvanceRecord };
