'use server';

/**
 * Server Functions for multi-currency: the rate table, functional currency,
 * bank accounts, and period-end revaluation. Same contract as documents.ts:
 * authorize first through src/lib/dal.ts, scope everything by entity, write
 * the audit event in the same transaction as the change.
 */

import { refresh } from 'next/cache';
import { Prisma } from '@prisma/client';

import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess } from '@/lib/dal';
import { bankAccountRecord, exchangeRateRow, revaluationRecord } from '@/lib/data/documents';
import { rateText } from '@/lib/data/mappers';
import { fromMinor, toMinor } from '@/lib/data/money';
import type { BankAccountRecord, ExchangeRateRow, RevaluationRecord } from '@/lib/data/types';
import { periodOf } from '@/lib/documents';
import {
  foreignBalancesFrom,
  isCurrency,
  monetaryControlCodes,
  normalizeRate,
  revaluationFor,
  type Currency,
  type FxJournalLine,
} from '@/lib/fx';
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

function dateOf(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date ${value}`);
  return date;
}

const journalLinesInclude = { lines: { include: { account: { select: { code: true, name: true } } } } } as const;

// --- exchange rates ----------------------------------------------------------------

export type RateInput = { base: Currency; quote: Currency; date: string; rate: string; source?: string };

/**
 * Enter or replace the rate for one pair on one date. Replacing is allowed:
 * the table is a reference, not a ledger — every posted journal has already
 * copied the rate it used and is unaffected.
 */
export async function upsertExchangeRate(entityId: string, input: RateInput): Promise<ActionResult<ExchangeRateRow>> {
  return withEntityAccess(entityId, 'rates:manage', async (principal) => {
    if (!isCurrency(input.base) || !isCurrency(input.quote) || input.base === input.quote) return fail('Choose two different currencies.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return fail('Date must be YYYY-MM-DD.');
    let rate: string;
    try {
      rate = normalizeRate(input.rate);
    } catch {
      return fail('The rate must be a positive decimal number, e.g. 12.5.');
    }

    const row = await prisma.$transaction(async (tx) => {
      const saved = await tx.exchangeRate.upsert({
        where: { entityId_base_quote_date: { entityId, base: input.base, quote: input.quote, date: dateOf(input.date) } },
        create: { entityId, base: input.base, quote: input.quote, date: dateOf(input.date), rate: new Prisma.Decimal(rate), source: input.source?.trim() || null, createdById: principal.userId },
        update: { rate: new Prisma.Decimal(rate), source: input.source?.trim() || null, createdById: principal.userId },
      });
      await recordAuditEvent(
        {
          entityId,
          userId: principal.userId,
          userName: principal.name,
          action: 'EDIT',
          resourceType: 'exchange-rate',
          resourceRef: `${input.base}/${input.quote} ${input.date}`,
          summary: `Exchange rate ${input.base}→${input.quote} for ${input.date} set to ${rate}`,
          metadata: { rate, source: input.source ?? null },
        },
        tx,
      );
      return saved;
    });

    refresh();
    return { ok: true, value: exchangeRateRow(row) };
  });
}

// --- functional currency -------------------------------------------------------------

/**
 * Change an entity's functional currency. Only while its ledger is empty:
 * once anything has been posted the functional amounts on record are in the
 * old currency, and re-denominating a ledger is a different, larger job.
 */
export async function setFunctionalCurrency(entityId: string, currency: Currency): Promise<ActionResult<Currency>> {
  return withEntityAccess(entityId, 'entity:configure', async (principal) => {
    if (!isCurrency(currency)) return fail('Unknown currency.');
    const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
    if (entity.functionalCurrency === currency) return { ok: true, value: currency };
    const posted = await prisma.journalEntry.count({ where: { entityId } });
    if (posted > 0) {
      return fail(`${entityId} already has ${posted} posted journal${posted === 1 ? '' : 's'} in ${entity.functionalCurrency}. The functional currency can only be changed on an empty ledger.`);
    }

    await prisma.$transaction(async (tx) => {
      await tx.entity.update({ where: { id: entityId }, data: { functionalCurrency: currency } });
      // The default bank account follows the functional currency while nothing is posted.
      const cash = await tx.account.findUnique({ where: { entityId_code: { entityId, code: '1001' } }, select: { id: true } });
      if (cash) {
        await tx.bankAccount.updateMany({ where: { accountId: cash.id }, data: { currency, name: `Main ${currency} account` } });
      }
      await recordAuditEvent(
        {
          entityId,
          userId: principal.userId,
          userName: principal.name,
          action: 'EDIT',
          resourceType: 'entity',
          resourceRef: entityId,
          summary: `Functional currency changed from ${entity.functionalCurrency} to ${currency}`,
        },
        tx,
      );
    });

    refresh();
    return { ok: true, value: currency };
  });
}

// --- bank accounts --------------------------------------------------------------------

const bankAccountCodes = ['1002', '1003', '1004', '1006', '1007', '1008', '1009'];

/** Add a bank account in one currency. It gets its own GL account under cash. */
export async function createBankAccount(entityId: string, input: { name: string; currency: Currency }): Promise<ActionResult<BankAccountRecord>> {
  return withEntityAccess(entityId, 'rates:manage', async (principal) => {
    const name = input.name.trim();
    if (!name) return fail('Give the bank account a name.');
    if (!isCurrency(input.currency)) return fail('Unknown currency.');

    const row = await prisma.$transaction(async (tx) => {
      const taken = new Set((await tx.account.findMany({ where: { entityId, code: { in: bankAccountCodes } }, select: { code: true } })).map((a) => a.code));
      const code = bankAccountCodes.find((candidate) => !taken.has(candidate));
      if (!code) throw new Error('No spare bank account code in the 1002–1009 range.');
      const cashParent = await tx.account.findUnique({ where: { entityId_code: { entityId, code: '1001' } }, select: { id: true } });
      const account = await tx.account.create({
        data: { entityId, code, name: `${name} (${input.currency})`, type: 'ASSET', category: 'bank', parentId: cashParent?.id ?? null },
      });
      const bank = await tx.bankAccount.create({
        data: { entityId, name, currency: input.currency, accountId: account.id },
        include: { account: { select: { code: true, name: true } } },
      });
      await recordAuditEvent(
        {
          entityId,
          userId: principal.userId,
          userName: principal.name,
          action: 'EDIT',
          resourceType: 'bank-account',
          resourceRef: code,
          summary: `Bank account "${name}" (${input.currency}) added as ${code}`,
        },
        tx,
      );
      return bank;
    });

    refresh();
    return { ok: true, value: bankAccountRecord(row) };
  });
}

// --- period-end revaluation -----------------------------------------------------------

export type RevaluationPreview = {
  period: string;
  closingDate: string;
  functionalCurrency: Currency;
  adjustments: {
    accountCode: string;
    accountName: string;
    currency: Currency;
    foreignMinor: number;
    bookMinor: number;
    closingRate: string;
    revaluedMinor: number;
    differenceMinor: number;
  }[];
  totalMinor: number;
};

async function computeRevaluation(entityId: string, period: string, closingRates: Partial<Record<Currency, string>>) {
  const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
  const closingDate = lastDayOf(period);
  const [lines, banks] = await Promise.all([
    prisma.journalLine.findMany({
      where: { entityId, journalEntry: { postedAt: { lte: dateOf(closingDate) } } },
      include: { account: { select: { code: true, name: true } } },
    }),
    prisma.bankAccount.findMany({ where: { entityId }, include: { account: { select: { code: true } } } }),
  ]);
  const monetary = new Set<string>([...monetaryControlCodes, ...banks.map((bank) => bank.account.code)]);
  const balances = foreignBalancesFrom(
    lines.map((line) => ({
      accountCode: line.account.code,
      accountName: line.account.name,
      currency: line.txnCurrency,
      txnAmount: toMinor(line.txnAmountMinor),
      functionalAmount: toMinor(line.amountMinor),
      type: line.direction === 'MONEY_IN' ? ('debit' as const) : ('credit' as const),
    })),
    monetary,
    entity.functionalCurrency,
  );
  const names = Object.fromEntries(lines.map((line) => [line.account.code, line.account.name]));
  const adjustments = revaluationFor(balances, closingRates, entity.functionalCurrency, names);
  return { entity, closingDate, adjustments, names };
}

function lastDayOf(period: string): string {
  const [year, month] = period.split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0)); // day 0 of next month
  return last.toISOString().slice(0, 10);
}

function normaliseClosingRates(input: Partial<Record<string, string>>): Partial<Record<Currency, string>> | string {
  const rates: Partial<Record<Currency, string>> = {};
  for (const [currency, rate] of Object.entries(input)) {
    if (!isCurrency(currency) || !rate?.trim()) continue;
    try {
      rates[currency] = normalizeRate(rate);
    } catch {
      return `The ${currency} closing rate must be a positive decimal number.`;
    }
  }
  return rates;
}

/** What a revaluation would post, without posting it. */
export async function previewRevaluation(entityId: string, period: string, closingRates: Partial<Record<string, string>>): Promise<ActionResult<RevaluationPreview>> {
  return withEntityAccess(entityId, 'revaluation:run', async () => {
    if (!/^\d{4}-\d{2}$/.test(period)) return fail('Period must be YYYY-MM.');
    const rates = normaliseClosingRates(closingRates);
    if (typeof rates === 'string') return fail(rates);
    const { entity, closingDate, adjustments } = await computeRevaluation(entityId, period, rates);
    return {
      ok: true,
      value: {
        period,
        closingDate,
        functionalCurrency: entity.functionalCurrency,
        adjustments: adjustments.map((a) => ({
          accountCode: a.accountCode,
          accountName: a.accountName ?? a.accountCode,
          currency: a.currency,
          foreignMinor: a.foreignMinor,
          bookMinor: a.bookMinor,
          closingRate: a.closingRate,
          revaluedMinor: a.revaluedMinor,
          differenceMinor: a.differenceMinor,
        })),
        totalMinor: adjustments.reduce((sum, a) => sum + a.differenceMinor, 0),
      },
    };
  });
}

/**
 * Post the period-end revaluation: one REVALUATION journal dated the last
 * day of the period, one adjustment per foreign monetary balance, the net
 * to 7020. One per entity per period; reverse it before running it again.
 */
export async function runRevaluation(entityId: string, period: string, closingRates: Partial<Record<string, string>>): Promise<ActionResult<RevaluationRecord>> {
  return withEntityAccess(entityId, 'revaluation:run', async (principal) => {
    if (!/^\d{4}-\d{2}$/.test(period)) return fail('Period must be YYYY-MM.');
    const rates = normaliseClosingRates(closingRates);
    if (typeof rates === 'string') return fail(rates);
    if (await prisma.taxPeriodFiling.findUnique({ where: { entityId_period: { entityId, period } } })) {
      return fail(`Period ${period} has been filed and is locked.`);
    }
    if (await prisma.revaluation.findUnique({ where: { entityId_period: { entityId, period } } })) {
      return fail(`A revaluation for ${period} already exists. Reverse it before running another.`);
    }

    const { entity, closingDate, adjustments } = await computeRevaluation(entityId, period, rates);
    if (adjustments.length === 0) return fail('Nothing to revalue: no foreign-currency monetary balances differ from the closing rates.');

    const lines: FxJournalLine[] = adjustments.flatMap((a) => a.lines);
    const accounts = await prisma.account.findMany({ where: { entityId }, select: { id: true, code: true } });
    const accountIdOf = new Map(accounts.map((a) => [a.code, a.id]));
    for (const line of lines) {
      if (!accountIdOf.has(line.accountCode)) return fail(`Account ${line.accountCode} is not in this entity's chart.`);
    }

    const row = await prisma.$transaction(async (tx) => {
      const entry = await tx.journalEntry.create({
        data: {
          entityId,
          kind: 'REVALUATION',
          reference: period,
          description: `Period-end FX revaluation ${period} at closing rates`,
          postedAt: dateOf(closingDate),
          postedById: principal.userId,
          lines: {
            create: lines.map((line) => ({
              entityId,
              accountId: accountIdOf.get(line.accountCode) as string,
              txnCurrency: line.currency,
              txnAmountMinor: fromMinor(line.txnAmount),
              rate: new Prisma.Decimal(line.rate),
              amountMinor: fromMinor(line.functionalAmount),
              direction: line.type === 'debit' ? 'MONEY_IN' : 'MONEY_OUT',
            })),
          },
        },
        select: { id: true },
      });
      const saved = await tx.revaluation.create({
        data: { entityId, period, closingRatesJson: JSON.stringify(rates), journalEntryId: entry.id, runById: principal.userId },
        include: { journalEntry: { include: journalLinesInclude }, reversalEntry: { include: journalLinesInclude } },
      });
      const total = adjustments.reduce((sum, a) => sum + a.differenceMinor, 0);
      await recordAuditEvent(
        {
          entityId,
          userId: principal.userId,
          userName: principal.name,
          action: 'POST',
          resourceType: 'revaluation',
          resourceRef: period,
          summary: `FX revaluation ${period}: net unrealised ${total >= 0 ? 'gain' : 'loss'} ${Math.abs(total) / 100} ${entity.functionalCurrency} across ${adjustments.length} balance${adjustments.length === 1 ? '' : 's'}`,
          metadata: { journalEntryId: entry.id, closingRates: rates, adjustments: adjustments.map((a) => ({ account: a.accountCode, currency: a.currency, difference: a.differenceMinor })) },
        },
        tx,
      );
      return saved;
    });

    refresh();
    return { ok: true, value: revaluationRecord(row) };
  });
}

/** Reverse a revaluation on the first day of the following period. Nothing is deleted. */
export async function reverseRevaluation(entityId: string, period: string): Promise<ActionResult<RevaluationRecord>> {
  return withEntityAccess(entityId, 'revaluation:run', async (principal) => {
    const revaluation = await prisma.revaluation.findFirst({
      where: { entityId, period },
      include: { journalEntry: { include: journalLinesInclude }, reversalEntry: true },
    });
    if (!revaluation) return fail(`No revaluation exists for ${period}.`);
    if (revaluation.reversalEntryId) return fail(`The ${period} revaluation has already been reversed.`);

    const [year, month] = period.split('-').map(Number);
    const reversalDate = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10); // first day of next period
    const reversalPeriod = periodOf(reversalDate);
    if (await prisma.taxPeriodFiling.findUnique({ where: { entityId_period: { entityId, period: reversalPeriod } } })) {
      return fail(`Period ${reversalPeriod} has been filed, so the reversal cannot be dated ${reversalDate}.`);
    }

    const row = await prisma.$transaction(async (tx) => {
      const entry = await tx.journalEntry.create({
        data: {
          entityId,
          kind: 'REVERSAL',
          reference: period,
          description: `Reversal of FX revaluation ${period}`,
          postedAt: dateOf(reversalDate),
          reversalOfId: revaluation.journalEntryId,
          postedById: principal.userId,
          lines: {
            create: revaluation.journalEntry.lines.map((line) => ({
              entityId,
              accountId: line.accountId,
              txnCurrency: line.txnCurrency,
              txnAmountMinor: line.txnAmountMinor,
              rate: line.rate,
              amountMinor: line.amountMinor,
              direction: line.direction === 'MONEY_IN' ? 'MONEY_OUT' : 'MONEY_IN',
            })),
          },
        },
        select: { id: true },
      });
      const saved = await tx.revaluation.update({
        where: { id: revaluation.id },
        data: { reversalEntryId: entry.id, reversedById: principal.userId, reversedAt: new Date() },
        include: { journalEntry: { include: journalLinesInclude }, reversalEntry: { include: journalLinesInclude } },
      });
      await recordAuditEvent(
        {
          entityId,
          userId: principal.userId,
          userName: principal.name,
          action: 'VOID',
          resourceType: 'revaluation',
          resourceRef: period,
          summary: `FX revaluation ${period} reversed on ${reversalDate}`,
          metadata: { reversalOf: revaluation.journalEntryId, reversalEntryId: entry.id },
        },
        tx,
      );
      return saved;
    });

    refresh();
    return { ok: true, value: revaluationRecord(row) };
  });
}

/** For the settings panel: the rate table as the client sees it. */
export async function listExchangeRates(entityId: string): Promise<ActionResult<ExchangeRateRow[]>> {
  return withEntityAccess(entityId, 'reports:view', async () => {
    const rows = await prisma.exchangeRate.findMany({ where: { entityId }, orderBy: [{ date: 'desc' }, { base: 'asc' }] });
    return { ok: true, value: rows.map((row) => ({ ...exchangeRateRow(row), rate: rateText(row.rate) ?? '1.0' })) };
  });
}
