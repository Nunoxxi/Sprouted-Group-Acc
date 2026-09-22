'use server';

/**
 * Server Functions for grant management: grants and their budget lines and
 * conditions, money in from donors, income recognised on receipt or held as
 * deferred income and released as it is earned, in-kind contributions, staff
 * time charged to grants, and the donor report.
 *
 * Same contract as documents.ts: authorize first through src/lib/dal.ts,
 * scope every query by entity, and write each change with its journal and
 * audit event in one transaction.
 *
 * The recognition policy is a person's decision, taken per grant and stored
 * on it. Nothing here infers it, and changing it once money has been
 * recognised is refused — that would restate income already reported.
 */

import { refresh } from 'next/cache';
import { Prisma } from '@prisma/client';

import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess } from '@/lib/dal';
import { basisToPrisma, frequencyToPrisma, grantActuals, inKindRecord, inKindToPrisma, policyToPrisma, readGrant, staffTimeRecord, statusToPrisma } from '@/lib/data/grants';
import { entityTypeOf } from '@/lib/data/mappers';
import { fromMinor, toMinor } from '@/lib/data/money';
import { StockRefusal } from '@/lib/data/stock';
import type { GrantRecord, InKindRecord, StaffTimeRecord } from '@/lib/data/types';
import { periodOf } from '@/lib/documents';
import { isCurrency, normalizeRate, type Currency } from '@/lib/fx';
import {
  budgetVsActual,
  conditionRelease,
  grantAccounts,
  inKindJournal,
  inKindKinds,
  incomePolicies,
  receiptJournal,
  releaseJournal,
  reportingFrequencies,
  reportingPeriods,
  runsGrants,
  spendingRelease,
  staffTimeJournal,
  staffTimeValue,
  toFunctional,
  type BudgetVsActual,
  type InKindKind,
  type IncomePolicy,
  type ReportingFrequency,
} from '@/lib/grants';
import type { TradingJournalLine } from '@/lib/trading';
import { prisma } from '@/lib/prisma';

import type { ActionResult } from './documents';

function fail<T>(error: string): ActionResult<T> {
  return { ok: false, error };
}

async function withEntityAccess<T>(entityId: string, permission: Permission, run: (principal: Principal) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
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

async function refusable<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StockRefusal) return fail(error.message);
    throw error;
  }
}

type Tx = Prisma.TransactionClient;

function dateOf(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new StockRefusal('Date must be YYYY-MM-DD.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new StockRefusal('That is not a real date.');
  return date;
}

/** Grants belong to the programme entity; the trading entities buy and sell. */
async function requireProgramme(entityId: string) {
  const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId } });
  if (!runsGrants(entityTypeOf(entity.type))) throw new StockRefusal(`${entity.name} is a trading entity and has no grants.`);
  return entity;
}

async function requireOpenPeriod(tx: Tx, entityId: string, date: string) {
  const period = periodOf(date);
  if (await tx.taxPeriodFiling.findUnique({ where: { entityId_period: { entityId, period } } })) {
    throw new StockRefusal(`Period ${period} has been filed. Date this in an open period.`);
  }
}

async function namesFor(tx: Tx, entityId: string): Promise<Record<string, string>> {
  return Object.fromEntries((await tx.account.findMany({ where: { entityId }, select: { code: true, name: true } })).map((a) => [a.code, a.name]));
}

/**
 * A GRANT journal in the functional currency. `analysis` codes every line to
 * the grant, so income recognition and staff time land in the grant's actuals
 * the same way an expense on a bill does.
 */
async function postJournal(
  tx: Tx,
  entityId: string,
  lines: TradingJournalLine[],
  date: string,
  reference: string,
  description: string,
  principal: Principal,
  analysis?: { grantId: string; budgetLineId?: string | null; fundId?: string | null; onlyAccountCode?: string },
): Promise<string | null> {
  if (lines.length === 0) return null;
  const debits = lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amount, 0);
  const credits = lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amount, 0);
  if (debits !== credits) throw new Error('Grant journal does not balance; refusing to post');
  const accounts = await tx.account.findMany({ where: { entityId, code: { in: lines.map((l) => l.accountCode) } }, select: { id: true, code: true } });
  const idOf = new Map(accounts.map((a) => [a.code, a.id]));
  for (const line of lines) if (!idOf.has(line.accountCode)) throw new StockRefusal(`Account ${line.accountCode} is not in this entity's chart.`);
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
        create: lines.map((line, index) => {
          // Staff time debits and credits the same account: only the debit
          // carries the grant, or the two would cancel in the analysis.
          const coded = analysis && (!analysis.onlyAccountCode || (line.accountCode === analysis.onlyAccountCode && line.type === 'debit' && index === 0));
          return {
            entityId,
            accountId: idOf.get(line.accountCode) as string,
            grantId: coded ? analysis.grantId : null,
            budgetLineId: coded ? (analysis.budgetLineId ?? null) : null,
            fundId: coded ? (analysis.fundId ?? null) : null,
            txnCurrency: entity.functionalCurrency,
            txnAmountMinor: fromMinor(line.amount),
            rate: new Prisma.Decimal(1),
            amountMinor: fromMinor(line.amount),
            direction: line.type === 'debit' ? ('MONEY_IN' as const) : ('MONEY_OUT' as const),
          };
        }),
      },
    },
    select: { id: true },
  });
  return entry.id;
}

async function grantOf(tx: Tx, entityId: string, grantId: string) {
  const grant = await tx.grant.findFirst({ where: { id: grantId, entityId } });
  if (!grant) throw new StockRefusal('Unknown grant.');
  return grant;
}

// --- the grant --------------------------------------------------------------------------------

export type GrantInput = {
  id?: string;
  code: string;
  name: string;
  donorContactId: string;
  fundId?: string | null;
  projectId?: string | null;
  currency: Currency;
  amountMinor: number;
  rate: string;
  startDate: string;
  endDate: string;
  restricted: boolean;
  incomePolicy: IncomePolicy;
  reportingFrequency: ReportingFrequency;
  reportingStartDate?: string | null;
  reportingDueDays?: number;
  underspendThresholdPct?: number;
  note?: string;
};

/**
 * Add or edit a grant. The recognition policy is the person's choice; once
 * income has been recognised under it, it is fixed — changing it would
 * restate income the donor has already been told about.
 */
export async function saveGrant(entityId: string, input: GrantInput): Promise<ActionResult<GrantRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      await requireProgramme(entityId);
      const code = String(input.code ?? '').trim().toUpperCase();
      const name = String(input.name ?? '').trim();
      if (!code) return fail('Give the grant a reference.');
      if (!name) return fail('Give the grant a name.');
      if (!isCurrency(input.currency)) return fail('Unknown currency.');
      if (!incomePolicies.includes(input.incomePolicy)) return fail('Choose how this grant is recognised.');
      if (!reportingFrequencies.includes(input.reportingFrequency)) return fail('Choose how often the donor is reported to.');
      const amountMinor = Math.round(Number(input.amountMinor));
      if (!(amountMinor > 0)) return fail('The award must be more than zero.');
      if (input.endDate < input.startDate) return fail('The grant cannot end before it starts.');
      let rate: string;
      try {
        rate = normalizeRate(input.rate);
      } catch {
        return fail('That exchange rate is not a number.');
      }
      const threshold = Math.round(Number(input.underspendThresholdPct ?? 75));
      if (!(threshold >= 0 && threshold <= 100)) return fail('The underspend threshold is a percentage between 0 and 100.');

      const row = await prisma.$transaction(async (tx) => {
        const donor = await tx.contact.findUnique({ where: { id: input.donorContactId }, select: { id: true } });
        if (!donor) throw new StockRefusal('Unknown donor.');
        if (input.fundId && !(await tx.fund.findFirst({ where: { id: input.fundId, entityId }, select: { id: true } }))) throw new StockRefusal('That fund does not belong to this entity.');
        if (input.projectId && !(await tx.project.findFirst({ where: { id: input.projectId, entityId }, select: { id: true } }))) throw new StockRefusal('That project does not belong to this entity.');
        const clash = await tx.grant.findFirst({ where: { entityId, code, ...(input.id ? { NOT: { id: input.id } } : {}) }, select: { id: true } });
        if (clash) throw new StockRefusal(`${code} is already the reference of another grant.`);

        const data = {
          code,
          name,
          donorContactId: donor.id,
          fundId: input.fundId || null,
          projectId: input.projectId || null,
          currency: input.currency,
          amountMinor: fromMinor(amountMinor),
          rate: new Prisma.Decimal(rate),
          startDate: dateOf(input.startDate),
          endDate: dateOf(input.endDate),
          restricted: !!input.restricted,
          incomePolicy: policyToPrisma[input.incomePolicy],
          reportingFrequency: frequencyToPrisma[input.reportingFrequency],
          reportingStartDate: input.reportingStartDate ? dateOf(input.reportingStartDate) : null,
          reportingDueDays: Math.max(0, Math.round(Number(input.reportingDueDays ?? 30))),
          underspendThresholdPct: threshold,
          note: input.note?.trim() || null,
        };

        if (input.id) {
          const existing = await grantOf(tx, entityId, input.id);
          if (existing.incomePolicy !== data.incomePolicy) {
            const recognised = await tx.grantReceipt.count({ where: { grantId: existing.id } });
            if (recognised > 0) throw new StockRefusal('Money has already been recognised under the current policy. Recognition cannot be switched after the fact — close this grant and open another if the agreement really changed.');
          }
          const saved = await tx.grant.update({ where: { id: existing.id }, data });
          await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'grant', resourceRef: code, summary: `Grant ${code} updated: ${name}` }, tx);
          return saved;
        }
        const saved = await tx.grant.create({ data: { entityId, ...data, createdById: principal.userId } });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'grant', resourceRef: code, summary: `Grant ${code} added: ${name}, ${input.currency} ${(amountMinor / 100).toFixed(2)}, ${input.incomePolicy === 'deferred' ? 'deferred' : 'recognised on receipt'}`, metadata: { incomePolicy: input.incomePolicy, restricted: !!input.restricted } },
          tx,
        );
        return saved;
      });
      refresh();
      return { ok: true, value: await readGrant(entityId, row.id) };
    }),
  );
}

export async function setGrantStatus(entityId: string, grantId: string, status: GrantRecord['status']): Promise<ActionResult<GrantRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      await requireProgramme(entityId);
      await prisma.$transaction(async (tx) => {
        const grant = await grantOf(tx, entityId, grantId);
        if (status === 'closed') {
          const held = toMinor((await tx.grantReceipt.aggregate({ where: { grantId }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n) - toMinor((await tx.grantRelease.aggregate({ where: { grantId }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n);
          if (grant.incomePolicy === 'DEFERRED' && held > 0) throw new StockRefusal(`${grant.code} still holds ${(held / 100).toFixed(2)} in deferred income. Release it or return it to the donor before closing.`);
        }
        await tx.grant.update({ where: { id: grant.id }, data: { status: statusToPrisma[status] } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'grant', resourceRef: grant.code, summary: `Grant ${grant.code} marked ${status}` }, tx);
      });
      refresh();
      return { ok: true, value: await readGrant(entityId, grantId) };
    }),
  );
}

// --- budget lines ------------------------------------------------------------------------------

export type BudgetLineInput = { id?: string; grantId: string; code: string; name: string; accountCode: string; budgetMinor: number; note?: string };

/** A line of the donor's budget, in their currency. */
export async function saveBudgetLine(entityId: string, input: BudgetLineInput): Promise<ActionResult<GrantRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      await requireProgramme(entityId);
      const code = String(input.code ?? '').trim().toUpperCase();
      const name = String(input.name ?? '').trim();
      if (!code || !name) return fail('Give the budget line a reference and a name.');
      const budgetMinor = Math.round(Number(input.budgetMinor));
      if (!(budgetMinor >= 0)) return fail('A budget cannot be negative.');

      await prisma.$transaction(async (tx) => {
        const grant = await grantOf(tx, entityId, input.grantId);
        const account = await tx.account.findFirst({ where: { entityId, code: input.accountCode, isActive: true }, select: { id: true } });
        if (!account) throw new StockRefusal(`Account ${input.accountCode} is not in this entity's chart.`);
        const clash = await tx.grantBudgetLine.findFirst({ where: { grantId: grant.id, code, ...(input.id ? { NOT: { id: input.id } } : {}) }, select: { id: true } });
        if (clash) throw new StockRefusal(`${grant.code} already has a budget line ${code}.`);
        const data = { code, name, accountId: account.id, budgetMinor: fromMinor(budgetMinor), note: input.note?.trim() || null };
        if (input.id) {
          await tx.grantBudgetLine.findFirstOrThrow({ where: { id: input.id, entityId, grantId: grant.id }, select: { id: true } });
          await tx.grantBudgetLine.update({ where: { id: input.id }, data });
        } else {
          await tx.grantBudgetLine.create({ data: { entityId, grantId: grant.id, ...data } });
        }
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'grant-budget', resourceRef: `${grant.code}/${code}`, summary: `Budget line ${code} ${input.id ? 'updated' : 'added'} on ${grant.code}: ${name}, ${(budgetMinor / 100).toFixed(2)}` }, tx);
      });
      refresh();
      return { ok: true, value: await readGrant(entityId, input.grantId) };
    }),
  );
}

/** A budget line can go only while nothing has been charged to it. */
export async function removeBudgetLine(entityId: string, budgetLineId: string): Promise<ActionResult<GrantRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      await requireProgramme(entityId);
      const grantId = await prisma.$transaction(async (tx) => {
        const line = await tx.grantBudgetLine.findFirst({ where: { id: budgetLineId, entityId }, include: { grant: { select: { code: true } } } });
        if (!line) throw new StockRefusal('Unknown budget line.');
        const charged = await tx.journalLine.count({ where: { budgetLineId: line.id } });
        const drafted = await tx.documentLine.count({ where: { budgetLineId: line.id } });
        if (charged + drafted > 0) throw new StockRefusal(`${line.code} already has spending against it. Set its budget to zero instead of removing it.`);
        await tx.grantBudgetLine.delete({ where: { id: line.id } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'grant-budget', resourceRef: `${line.grant.code}/${line.code}`, summary: `Budget line ${line.code} removed from ${line.grant.code}` }, tx);
        return line.grantId;
      });
      refresh();
      return { ok: true, value: await readGrant(entityId, grantId) };
    }),
  );
}

// --- conditions ---------------------------------------------------------------------------------

export type ConditionInput = { id?: string; grantId: string; description: string; dueDate?: string | null; note?: string };

export async function saveCondition(entityId: string, input: ConditionInput): Promise<ActionResult<GrantRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      await requireProgramme(entityId);
      const description = String(input.description ?? '').trim();
      if (!description) return fail('Say what the condition is.');
      await prisma.$transaction(async (tx) => {
        const grant = await grantOf(tx, entityId, input.grantId);
        const data = { description, dueDate: input.dueDate ? dateOf(input.dueDate) : null, note: input.note?.trim() || null };
        if (input.id) {
          await tx.grantCondition.findFirstOrThrow({ where: { id: input.id, entityId, grantId: grant.id }, select: { id: true } });
          await tx.grantCondition.update({ where: { id: input.id }, data });
        } else {
          await tx.grantCondition.create({ data: { entityId, grantId: grant.id, ...data } });
        }
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'grant-condition', resourceRef: grant.code, summary: `Condition ${input.id ? 'updated' : 'added'} on ${grant.code}: ${description.slice(0, 120)}` }, tx);
      });
      refresh();
      return { ok: true, value: await readGrant(entityId, input.grantId) };
    }),
  );
}

/** Mark a condition met, or unmark it while nothing has been released for it. */
export async function setConditionMet(entityId: string, conditionId: string, met: boolean): Promise<ActionResult<GrantRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      await requireProgramme(entityId);
      const grantId = await prisma.$transaction(async (tx) => {
        const condition = await tx.grantCondition.findFirst({ where: { id: conditionId, entityId }, include: { grant: { select: { code: true } }, releases: { select: { id: true } } } });
        if (!condition) throw new StockRefusal('Unknown condition.');
        if (!met && condition.releases.length > 0) throw new StockRefusal('Income has already been released against this condition. Reverse the release first.');
        await tx.grantCondition.update({ where: { id: condition.id }, data: { metAt: met ? new Date() : null, metById: met ? principal.userId : null } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'grant-condition', resourceRef: condition.grant.code, summary: `Condition ${met ? 'met' : 'reopened'} on ${condition.grant.code}: ${condition.description.slice(0, 120)}` }, tx);
        return condition.grantId;
      });
      refresh();
      return { ok: true, value: await readGrant(entityId, grantId) };
    }),
  );
}

// --- money in ---------------------------------------------------------------------------------------

export type ReceiptInput = { grantId: string; date: string; txnAmountMinor: number; rate?: string; bankAccountId: string; reference?: string };

/**
 * Money arriving from the donor. Under the on-receipt policy it is income
 * that day; under the deferred policy it is a liability until it is earned.
 * Which of the two happens was decided when the grant was set up.
 */
export async function recordGrantReceipt(entityId: string, input: ReceiptInput): Promise<ActionResult<GrantRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      await requireProgramme(entityId);
      const txnAmountMinor = Math.round(Number(input.txnAmountMinor));
      if (!(txnAmountMinor > 0)) return fail('The receipt must be more than zero.');

      await prisma.$transaction(async (tx) => {
        const grant = await grantOf(tx, entityId, input.grantId);
        if (grant.status === 'CLOSED') throw new StockRefusal(`Grant ${grant.code} is closed.`);
        await requireOpenPeriod(tx, entityId, input.date);
        const bank = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, entityId, isActive: true }, include: { account: { select: { code: true } } } });
        if (!bank) throw new StockRefusal('Unknown bank account for this entity.');
        const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });

        // The money arrives in the bank account's currency. Its rate to ours
        // is the grant's unless a different one is given for this receipt.
        let rate: string;
        try {
          rate = bank.currency === entity.functionalCurrency ? '1.0' : normalizeRate(input.rate || grant.rate.toString());
        } catch {
          throw new StockRefusal('That exchange rate is not a number.');
        }
        const amountMinor = toFunctional(txnAmountMinor, rate);

        const names = await namesFor(tx, entityId);
        const journalId = await postJournal(
          tx,
          entityId,
          receiptJournal(grant.incomePolicy === 'DEFERRED' ? 'deferred' : 'on-receipt', grant.restricted, amountMinor, bank.account.code, names),
          input.date,
          grant.code,
          `${grant.incomePolicy === 'DEFERRED' ? 'Grant instalment received (held as deferred income)' : 'Grant instalment received'} — ${grant.name}`,
          principal,
          { grantId: grant.id, fundId: grant.fundId },
        );
        await tx.grantReceipt.create({
          data: {
            entityId,
            grantId: grant.id,
            date: dateOf(input.date),
            txnCurrency: bank.currency,
            txnAmountMinor: fromMinor(txnAmountMinor),
            rate: new Prisma.Decimal(rate),
            amountMinor: fromMinor(amountMinor),
            bankAccountId: bank.id,
            reference: input.reference?.trim() || null,
            journalEntryId: journalId,
            createdById: principal.userId,
          },
        });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'grant-receipt', resourceRef: grant.code, summary: `${bank.currency} ${(txnAmountMinor / 100).toFixed(2)} received on ${grant.code} into ${bank.name}, ${grant.incomePolicy === 'DEFERRED' ? 'held as deferred income' : 'recognised as income'}`, metadata: { journalEntryId: journalId, amountMinor } },
          tx,
        );
      });
      refresh();
      return { ok: true, value: await readGrant(entityId, input.grantId) };
    }),
  );
}

export type ReleaseInput = { grantId: string; date: string; basis: 'spending' | 'condition'; conditionId?: string | null; amountMinor?: number; note?: string };

/**
 * Release deferred income that has been earned. On a spending basis the
 * amount is worked out here — eligible spending not yet released, capped at
 * what has actually been received — so nobody has to compute it by hand. On a
 * condition basis the amount is stated and capped the same way.
 */
export async function releaseGrantIncome(entityId: string, input: ReleaseInput): Promise<ActionResult<GrantRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      await requireProgramme(entityId);
      const actuals = await grantActuals({ entityId: { in: [entityId] } });

      await prisma.$transaction(async (tx) => {
        const grant = await grantOf(tx, entityId, input.grantId);
        if (grant.incomePolicy !== 'DEFERRED') throw new StockRefusal(`${grant.code} is recognised when the money arrives; there is no deferred income to release.`);
        await requireOpenPeriod(tx, entityId, input.date);

        const receivedMinor = toMinor((await tx.grantReceipt.aggregate({ where: { grantId: grant.id }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n);
        const releasedMinor = toMinor((await tx.grantRelease.aggregate({ where: { grantId: grant.id }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n);

        let amountMinor: number;
        let conditionId: string | null = null;
        if (input.basis === 'spending') {
          const spent = actuals.filter((actual) => actual.grantId === grant.id && actual.date <= input.date).reduce((total, actual) => total + actual.functionalMinor, 0);
          const position = spendingRelease(receivedMinor, releasedMinor, spent);
          amountMinor = position.releasableMinor;
          if (amountMinor <= 0) {
            throw new StockRefusal(
              position.earnedNotReleasedMinor > 0
                ? `${grant.code} has spending of ${(position.earnedNotReleasedMinor / 100).toFixed(2)} still to recognise, but only ${(position.heldMinor / 100).toFixed(2)} has been received. Record the next instalment first.`
                : `${grant.code} has no eligible spending left to recognise.`,
            );
          }
        } else {
          const condition = await tx.grantCondition.findFirst({ where: { id: input.conditionId ?? '', entityId, grantId: grant.id } });
          if (!condition) throw new StockRefusal('Name the condition this release is for.');
          if (!condition.metAt) throw new StockRefusal('Mark the condition met before releasing income for it.');
          conditionId = condition.id;
          amountMinor = conditionRelease(receivedMinor, releasedMinor, Math.round(Number(input.amountMinor ?? 0)));
          if (amountMinor <= 0) throw new StockRefusal(`${grant.code} holds ${((receivedMinor - releasedMinor) / 100).toFixed(2)} of deferred income; there is nothing more to release.`);
        }

        const names = await namesFor(tx, entityId);
        const journalId = await postJournal(
          tx,
          entityId,
          releaseJournal(grant.restricted, amountMinor, names),
          input.date,
          grant.code,
          `Deferred grant income recognised — ${grant.name} (${input.basis === 'spending' ? 'eligible spending' : 'condition met'})`,
          principal,
          { grantId: grant.id, fundId: grant.fundId },
        );
        await tx.grantRelease.create({
          data: { entityId, grantId: grant.id, date: dateOf(input.date), amountMinor: fromMinor(amountMinor), basis: basisToPrisma[input.basis], conditionId, note: input.note?.trim() || null, journalEntryId: journalId, createdById: principal.userId },
        });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'grant-release', resourceRef: grant.code, summary: `${(amountMinor / 100).toFixed(2)} of deferred income recognised on ${grant.code} (${input.basis === 'spending' ? 'eligible spending' : 'condition met'})`, metadata: { journalEntryId: journalId, amountMinor, basis: input.basis } },
          tx,
        );
      });
      refresh();
      return { ok: true, value: await readGrant(entityId, input.grantId) };
    }),
  );
}

// --- in-kind contributions ------------------------------------------------------------------------

export type InKindInput = {
  grantId?: string | null;
  budgetLineId?: string | null;
  date: string;
  description: string;
  kind: InKindKind;
  valueMinor: number;
  basis?: string;
  donorContactId?: string | null;
};

/**
 * A donated good, service or the use of a facility. It is grossed up —
 * income for what it was worth and expenditure for its use — so the donor
 * sees the contribution without the surplus moving.
 */
export async function recordInKind(entityId: string, input: InKindInput): Promise<ActionResult<InKindRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      await requireProgramme(entityId);
      const description = String(input.description ?? '').trim();
      if (!description) return fail('Say what was donated.');
      if (!inKindKinds.includes(input.kind)) return fail('Choose what kind of contribution this was.');
      const valueMinor = Math.round(Number(input.valueMinor));
      if (!(valueMinor > 0)) return fail('Put a value on the contribution.');

      const row = await prisma.$transaction(async (tx) => {
        await requireOpenPeriod(tx, entityId, input.date);
        const grant = input.grantId ? await grantOf(tx, entityId, input.grantId) : null;
        if (input.budgetLineId) {
          if (!grant) throw new StockRefusal('A budget line needs its grant.');
          await tx.grantBudgetLine.findFirstOrThrow({ where: { id: input.budgetLineId, entityId, grantId: grant.id }, select: { id: true } }).catch(() => {
            throw new StockRefusal(`That budget line does not belong to ${grant.code}.`);
          });
        }
        const names = await namesFor(tx, entityId);
        const journalId = await postJournal(
          tx,
          entityId,
          inKindJournal(valueMinor, names),
          input.date,
          grant?.code ?? 'IN-KIND',
          `In-kind: ${description}`,
          principal,
          grant ? { grantId: grant.id, budgetLineId: input.budgetLineId ?? null, fundId: grant.fundId, onlyAccountCode: grantAccounts.inKindExpense } : undefined,
        );
        const saved = await tx.inKindContribution.create({
          data: {
            entityId,
            grantId: grant?.id ?? null,
            budgetLineId: input.budgetLineId || null,
            date: dateOf(input.date),
            description,
            kind: inKindToPrisma[input.kind],
            valueMinor: fromMinor(valueMinor),
            basis: input.basis?.trim() || null,
            donorContactId: input.donorContactId || null,
            journalEntryId: journalId,
            createdById: principal.userId,
          },
          include: { donor: { select: { name: true } }, journalEntry: { include: { lines: { include: { account: { select: { code: true, name: true } } } } } } },
        });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'in-kind', resourceRef: grant?.code ?? description.slice(0, 40), summary: `In-kind ${input.kind} valued at ${(valueMinor / 100).toFixed(2)}${grant ? ` on ${grant.code}` : ''}: ${description.slice(0, 120)}`, metadata: { journalEntryId: journalId, valueMinor } },
          tx,
        );
        return saved;
      });
      refresh();
      return { ok: true, value: inKindRecord(row) };
    }),
  );
}

// --- staff time --------------------------------------------------------------------------------------

export type StaffTimeInput = {
  grantId: string;
  budgetLineId?: string | null;
  personName: string;
  role?: string;
  periodStart: string;
  periodEnd: string;
  hours: number;
  rateMinorPerHour: number;
  accountCode: string;
  note?: string;
  /** Post it to the ledger as well as recording it, moving the cost onto the grant. */
  post?: boolean;
};

/**
 * Staff time allocated to a grant. Recording it alone is a note for the donor
 * report; posting it moves the cost onto the grant by debiting and crediting
 * the same salary account, so the entity's total expenditure does not change
 * and only the analysis does.
 */
export async function recordStaffTime(entityId: string, input: StaffTimeInput): Promise<ActionResult<StaffTimeRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      await requireProgramme(entityId);
      const personName = String(input.personName ?? '').trim();
      if (!personName) return fail('Say whose time this was.');
      const hours = Math.round(Number(input.hours) * 100) / 100;
      if (!(hours > 0)) return fail('Hours must be more than zero.');
      const rateMinorPerHour = Math.round(Number(input.rateMinorPerHour));
      if (!(rateMinorPerHour > 0)) return fail('Give an hourly rate.');
      if (input.periodEnd < input.periodStart) return fail('The period cannot end before it starts.');
      const valueMinor = staffTimeValue(hours, rateMinorPerHour);

      const row = await prisma.$transaction(async (tx) => {
        const grant = await grantOf(tx, entityId, input.grantId);
        const account = await tx.account.findFirst({ where: { entityId, code: input.accountCode, isActive: true }, select: { id: true, code: true } });
        if (!account) throw new StockRefusal(`Account ${input.accountCode} is not in this entity's chart.`);
        if (input.budgetLineId) {
          const budgetLine = await tx.grantBudgetLine.findFirst({ where: { id: input.budgetLineId, entityId, grantId: grant.id }, select: { id: true } });
          if (!budgetLine) throw new StockRefusal(`That budget line does not belong to ${grant.code}.`);
        }
        let journalId: string | null = null;
        if (input.post) {
          await requireOpenPeriod(tx, entityId, input.periodEnd);
          const names = await namesFor(tx, entityId);
          journalId = await postJournal(
            tx,
            entityId,
            staffTimeJournal(valueMinor, account.code, names),
            input.periodEnd,
            grant.code,
            `Staff time charged to ${grant.name}: ${personName}, ${hours} hours`,
            principal,
            { grantId: grant.id, budgetLineId: input.budgetLineId ?? null, fundId: grant.fundId, onlyAccountCode: account.code },
          );
        }
        const saved = await tx.staffTimeAllocation.create({
          data: {
            entityId,
            grantId: grant.id,
            budgetLineId: input.budgetLineId || null,
            personName,
            role: input.role?.trim() || null,
            periodStart: dateOf(input.periodStart),
            periodEnd: dateOf(input.periodEnd),
            hours: new Prisma.Decimal(hours),
            rateMinorPerHour: fromMinor(rateMinorPerHour),
            valueMinor: fromMinor(valueMinor),
            accountId: account.id,
            note: input.note?.trim() || null,
            journalEntryId: journalId,
            createdById: principal.userId,
          },
          include: { account: { select: { code: true } } },
        });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: journalId ? 'POST' : 'EDIT', resourceType: 'staff-time', resourceRef: grant.code, summary: `${personName}: ${hours} hours on ${grant.code} valued at ${(valueMinor / 100).toFixed(2)}${journalId ? ', charged to the grant' : ', recorded for reporting only'}`, metadata: { journalEntryId: journalId, valueMinor, hours } },
          tx,
        );
        return saved;
      });
      refresh();
      return { ok: true, value: staffTimeRecord(row) };
    }),
  );
}

// --- the donor report ----------------------------------------------------------------------------------

export type DonorReport = {
  grant: GrantRecord;
  /** The donor's own periods, not our financial year. */
  periods: { index: number; label: string; start: string; end: string; dueDate: string; actualFunctionalMinor: number; actualDonorMinor: number }[];
  comparison: BudgetVsActual;
  inKind: InKindRecord[];
  staffTime: StaffTimeRecord[];
};

/** One grant's report for a chosen period, or for the whole grant. */
export async function donorReport(entityId: string, grantId: string, from?: string, to?: string): Promise<ActionResult<DonorReport>> {
  return withEntityAccess(entityId, 'reports:view', () =>
    refusable(async () => {
      await requireProgramme(entityId);
      const grant = await readGrant(entityId, grantId);
      const actuals = (await grantActuals({ entityId: { in: [entityId] } })).filter((actual) => actual.grantId === grantId);
      const asOf = to || new Date().toISOString().slice(0, 10);
      const options = { rate: grant.rate, asOf, from, to, underspendThresholdPct: grant.underspendThresholdPct };
      const comparison = budgetVsActual(grant, grant.budgetLines.map((line) => ({ id: line.id, code: line.code, name: line.name, accountCode: line.accountCode, budgetDonorMinor: line.budgetMinor })), actuals, options);

      const [inKind, staffTime] = await Promise.all([
        prisma.inKindContribution.findMany({ where: { entityId, grantId, ...(from || to ? { date: { ...(from ? { gte: dateOf(from) } : {}), ...(to ? { lte: dateOf(to) } : {}) } } : {}) }, include: { donor: { select: { name: true } }, journalEntry: { include: { lines: { include: { account: { select: { code: true, name: true } } } } } } }, orderBy: { date: 'asc' } }),
        prisma.staffTimeAllocation.findMany({ where: { entityId, grantId, ...(from || to ? { periodEnd: { ...(from ? { gte: dateOf(from) } : {}), ...(to ? { lte: dateOf(to) } : {}) } } : {}) }, include: { account: { select: { code: true } } }, orderBy: { periodStart: 'asc' } }),
      ]);
      const periods = reportingPeriods(grant).map((period) => {
        const actualFunctionalMinor = actuals.filter((actual) => actual.date >= period.start && actual.date <= period.end).reduce((total, actual) => total + actual.functionalMinor, 0);
        return { ...period, actualFunctionalMinor, actualDonorMinor: Math.round(actualFunctionalMinor / Number(grant.rate || 1)) };
      });

      return {
        ok: true,
        value: { grant, periods, comparison, inKind: inKind.map(inKindRecord), staffTime: staffTime.map(staffTimeRecord) },
      };
    }),
  );
}

/** The same report as an Excel workbook, base64, for the donor's own file. */
export async function donorReportWorkbook(entityId: string, grantId: string, from?: string, to?: string): Promise<ActionResult<{ fileName: string; base64: string }>> {
  return withEntityAccess(entityId, 'reports:view', () =>
    refusable(async () => {
      const report = await donorReport(entityId, grantId, from, to);
      if (!report.ok) return report;
      const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId }, select: { name: true, functionalCurrency: true } });
      const { buildDonorWorkbook } = await import('@/lib/data/grant-xlsx');
      const buffer = await buildDonorWorkbook(report.value, entity.name, entity.functionalCurrency);
      const window = from || to ? `-${from ?? 'start'}-to-${to ?? 'end'}` : '';
      return { ok: true, value: { fileName: `${report.value.grant.code}-donor-report${window}.xlsx`, base64: Buffer.from(buffer).toString('base64') } };
    }),
  );
}
