'use server';

/**
 * Server Functions for cash flow forecasting: the buying seasons, the
 * recurring costs, and the scenarios with their assumptions, rates and any
 * lines added by hand.
 *
 * Nothing here posts to the ledger. A forecast is a view of what might
 * happen; it never touches the books, so none of these write a journal.
 * That is also why a scenario can be changed and deleted freely, unlike
 * anything that has been posted.
 *
 * Same contract as documents.ts otherwise: authorize first through
 * src/lib/dal.ts, scope every query by entity, record an audit event.
 */

import { refresh } from 'next/cache';
import { Prisma } from '@prisma/client';

import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess } from '@/lib/dal';
import { cashSourcesFor, frequencyToPrisma, scenarioInclude, scenarioRecord, seasonInclude, seasonRecord, recurringInclude, recurringRecord } from '@/lib/data/cashflow';
import { fromMinor } from '@/lib/data/money';
import { StockRefusal } from '@/lib/data/stock';
import type { BuyingSeasonRecord, CashScenarioRecord, CashSourceRecord, RecurringCostRecord } from '@/lib/data/types';
import { recurringFrequencies, type RecurringFrequency } from '@/lib/cashflow';
import { isCurrency, normalizeRate, type Currency } from '@/lib/fx';
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

function dateOf(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new StockRefusal('Date must be YYYY-MM-DD.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new StockRefusal('That is not a real date.');
  return date;
}

// --- buying seasons ---------------------------------------------------------------------------

export type SeasonInput = {
  id?: string;
  commodityId: string;
  name: string;
  startDate: string;
  peakDate: string;
  endDate: string;
  expectedGrams: number;
  priceMinorPerKg: number;
  currency?: Currency;
  note?: string;
  isActive?: boolean;
};

/**
 * When a commodity is bought, how heavily and at what price. The peak is
 * what makes the forecast useful: buying is not spread evenly across a
 * season, and the squeeze is around the peak, when money has gone out and
 * nothing has been sold.
 */
export async function saveBuyingSeason(entityId: string, input: SeasonInput): Promise<ActionResult<BuyingSeasonRecord>> {
  return withEntityAccess(entityId, 'inventory:manage', (principal) =>
    refusable(async () => {
      const name = String(input.name ?? '').trim();
      if (!name) return fail('Give the season a name.');
      if (input.endDate < input.startDate) return fail('The season cannot end before it starts.');
      if (input.peakDate < input.startDate || input.peakDate > input.endDate) return fail('The peak has to fall inside the season.');
      const expectedGrams = Math.round(Number(input.expectedGrams));
      const priceMinorPerKg = Math.round(Number(input.priceMinorPerKg));
      if (!(expectedGrams >= 0) || !(priceMinorPerKg >= 0)) return fail('Volume and price cannot be negative.');
      if (input.currency && !isCurrency(input.currency)) return fail('Unknown currency.');

      const row = await prisma.$transaction(async (tx) => {
        const commodity = await tx.commodity.findFirst({ where: { id: input.commodityId, entityId }, select: { id: true, name: true } });
        if (!commodity) throw new StockRefusal('Unknown commodity for this entity.');
        const clash = await tx.buyingSeason.findFirst({ where: { entityId, name, ...(input.id ? { NOT: { id: input.id } } : {}) }, select: { id: true } });
        if (clash) throw new StockRefusal(`${name} is already the name of another season.`);
        const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
        const data = {
          commodityId: commodity.id,
          name,
          startDate: dateOf(input.startDate),
          peakDate: dateOf(input.peakDate),
          endDate: dateOf(input.endDate),
          expectedGrams: fromMinor(expectedGrams),
          priceMinorPerKg: fromMinor(priceMinorPerKg),
          currency: input.currency ?? entity.functionalCurrency,
          note: input.note?.trim() || null,
          isActive: input.isActive ?? true,
        };
        if (input.id && !(await tx.buyingSeason.findFirst({ where: { id: input.id, entityId }, select: { id: true } }))) throw new StockRefusal('That season no longer exists.');
        const saved = input.id
          ? await tx.buyingSeason.update({ where: { id: input.id }, data, include: seasonInclude })
          : await tx.buyingSeason.create({ data: { entityId, ...data }, include: seasonInclude });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'buying-season', resourceRef: name, summary: `Buying season ${input.id ? 'updated' : 'added'}: ${name}, ${commodity.name}, ${(expectedGrams / 1_000_000).toFixed(1)} tonnes at ${(priceMinorPerKg / 100).toFixed(2)} a kilo` },
          tx,
        );
        return saved;
      });
      refresh();
      return { ok: true, value: seasonRecord(row) };
    }),
  );
}

export async function removeBuyingSeason(entityId: string, seasonId: string): Promise<ActionResult<{ id: string }>> {
  return withEntityAccess(entityId, 'inventory:manage', (principal) =>
    refusable(async () => {
      await prisma.$transaction(async (tx) => {
        const season = await tx.buyingSeason.findFirst({ where: { id: seasonId, entityId } });
        if (!season) throw new StockRefusal('Unknown buying season.');
        await tx.buyingSeason.delete({ where: { id: season.id } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'buying-season', resourceRef: season.name, summary: `Buying season removed: ${season.name}` }, tx);
      });
      refresh();
      return { ok: true, value: { id: seasonId } };
    }),
  );
}

// --- recurring costs ---------------------------------------------------------------------------

export type RecurringInput = {
  id?: string;
  name: string;
  currency?: Currency;
  amountMinor: number;
  frequency: RecurringFrequency;
  startDate: string;
  endDate?: string | null;
  accountCode?: string;
  note?: string;
  isActive?: boolean;
};

/** Payroll, rent and anything else that goes out on a rhythm. */
export async function saveRecurringCost(entityId: string, input: RecurringInput): Promise<ActionResult<RecurringCostRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const name = String(input.name ?? '').trim();
      if (!name) return fail('Give the cost a name.');
      if (!recurringFrequencies.includes(input.frequency)) return fail('Choose how often it goes out.');
      const amountMinor = Math.round(Number(input.amountMinor));
      if (!(amountMinor > 0)) return fail('The amount must be more than zero.');
      if (input.endDate && input.endDate < input.startDate) return fail('It cannot end before it starts.');
      if (input.currency && !isCurrency(input.currency)) return fail('Unknown currency.');

      const row = await prisma.$transaction(async (tx) => {
        const clash = await tx.recurringCost.findFirst({ where: { entityId, name, ...(input.id ? { NOT: { id: input.id } } : {}) }, select: { id: true } });
        if (clash) throw new StockRefusal(`${name} is already the name of another recurring cost.`);
        const account = input.accountCode ? await tx.account.findFirst({ where: { entityId, code: input.accountCode, isActive: true }, select: { id: true } }) : null;
        if (input.accountCode && !account) throw new StockRefusal(`Account ${input.accountCode} is not in this entity's chart.`);
        const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
        const data = {
          name,
          currency: input.currency ?? entity.functionalCurrency,
          amountMinor: fromMinor(amountMinor),
          frequency: frequencyToPrisma[input.frequency],
          startDate: dateOf(input.startDate),
          endDate: input.endDate ? dateOf(input.endDate) : null,
          accountId: account?.id ?? null,
          note: input.note?.trim() || null,
          isActive: input.isActive ?? true,
        };
        if (input.id && !(await tx.recurringCost.findFirst({ where: { id: input.id, entityId }, select: { id: true } }))) throw new StockRefusal('That recurring cost no longer exists.');
        const saved = input.id
          ? await tx.recurringCost.update({ where: { id: input.id }, data, include: recurringInclude })
          : await tx.recurringCost.create({ data: { entityId, ...data }, include: recurringInclude });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'recurring-cost', resourceRef: name, summary: `Recurring cost ${input.id ? 'updated' : 'added'}: ${name}, ${(amountMinor / 100).toFixed(2)} ${input.frequency}` },
          tx,
        );
        return saved;
      });
      refresh();
      return { ok: true, value: recurringRecord(row) };
    }),
  );
}

export async function removeRecurringCost(entityId: string, costId: string): Promise<ActionResult<{ id: string }>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      await prisma.$transaction(async (tx) => {
        const cost = await tx.recurringCost.findFirst({ where: { id: costId, entityId } });
        if (!cost) throw new StockRefusal('Unknown recurring cost.');
        await tx.recurringCost.delete({ where: { id: cost.id } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'recurring-cost', resourceRef: cost.name, summary: `Recurring cost removed: ${cost.name}` }, tx);
      });
      refresh();
      return { ok: true, value: { id: costId } };
    }),
  );
}

// --- scenarios -----------------------------------------------------------------------------------

export type ScenarioInput = {
  id?: string;
  name: string;
  collectionDelayDays?: number;
  pricePct?: number;
  volumePct?: number;
  floatLeadDays?: number;
  minimumCashMinor?: number;
  note?: string;
  /** Currency → functional units per one unit of it. Replaces what is there. */
  rates?: Record<string, string>;
};

const wholeNumber = (value: unknown, fallback: number) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? number : fallback;
};

/** Add or change a set of assumptions. The first scenario an entity has is its baseline. */
export async function saveScenario(entityId: string, input: ScenarioInput): Promise<ActionResult<CashScenarioRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const name = String(input.name ?? '').trim();
      if (!name) return fail('Give the scenario a name.');
      const pricePct = wholeNumber(input.pricePct ?? 100, 100);
      const volumePct = wholeNumber(input.volumePct ?? 100, 100);
      if (pricePct < 0 || volumePct < 0) return fail('Price and volume are percentages and cannot be negative.');
      const collectionDelayDays = wholeNumber(input.collectionDelayDays ?? 0, 0);
      const floatLeadDays = wholeNumber(input.floatLeadDays ?? 7, 7);
      if (collectionDelayDays < 0 || floatLeadDays < 0) return fail('Days cannot be negative.');
      const minimumCashMinor = wholeNumber(input.minimumCashMinor ?? 0, 0);

      const rates: { currency: Currency; rate: string }[] = [];
      for (const [currency, rate] of Object.entries(input.rates ?? {})) {
        if (!isCurrency(currency)) return fail(`Unknown currency ${currency}.`);
        if (!String(rate).trim()) continue;
        try {
          rates.push({ currency, rate: normalizeRate(String(rate)) });
        } catch {
          return fail(`The rate for ${currency} is not a number.`);
        }
      }

      const row = await prisma.$transaction(async (tx) => {
        const clash = await tx.cashScenario.findFirst({ where: { entityId, name, ...(input.id ? { NOT: { id: input.id } } : {}) }, select: { id: true } });
        if (clash) throw new StockRefusal(`${name} is already the name of another scenario.`);
        const data = { name, collectionDelayDays, pricePct, volumePct, floatLeadDays, minimumCashMinor: fromMinor(minimumCashMinor), note: input.note?.trim() || null };
        if (input.id && !(await tx.cashScenario.findFirst({ where: { id: input.id, entityId }, select: { id: true } }))) throw new StockRefusal('That scenario no longer exists.');
        const saved = input.id
          ? await tx.cashScenario.update({ where: { id: input.id }, data })
          : await tx.cashScenario.create({ data: { entityId, ...data, isBaseline: (await tx.cashScenario.count({ where: { entityId } })) === 0, createdById: principal.userId } });

        if (input.rates) {
          await tx.cashScenarioRate.deleteMany({ where: { scenarioId: saved.id } });
          for (const rate of rates) await tx.cashScenarioRate.create({ data: { entityId, scenarioId: saved.id, currency: rate.currency, rate: new Prisma.Decimal(rate.rate) } });
        }
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'cash-scenario', resourceRef: name, summary: `Cash flow scenario ${input.id ? 'updated' : 'added'}: ${name} (collection +${collectionDelayDays}d, price ${pricePct}%, volume ${volumePct}%)` },
          tx,
        );
        return tx.cashScenario.findUniqueOrThrow({ where: { id: saved.id }, include: scenarioInclude });
      });
      refresh();
      return { ok: true, value: scenarioRecord(row) };
    }),
  );
}

/** Copy a scenario, assumptions, rates, manual lines and all, to change from. */
export async function duplicateScenario(entityId: string, scenarioId: string, name: string): Promise<ActionResult<CashScenarioRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const newName = String(name ?? '').trim();
      if (!newName) return fail('Give the copy a name.');
      const row = await prisma.$transaction(async (tx) => {
        const source = await tx.cashScenario.findFirst({ where: { id: scenarioId, entityId }, include: scenarioInclude });
        if (!source) throw new StockRefusal('Unknown scenario.');
        if (await tx.cashScenario.findFirst({ where: { entityId, name: newName }, select: { id: true } })) throw new StockRefusal(`${newName} is already the name of another scenario.`);
        const copy = await tx.cashScenario.create({
          data: {
            entityId,
            name: newName,
            isBaseline: false,
            collectionDelayDays: source.collectionDelayDays,
            pricePct: source.pricePct,
            volumePct: source.volumePct,
            floatLeadDays: source.floatLeadDays,
            minimumCashMinor: source.minimumCashMinor,
            note: source.note,
            createdById: principal.userId,
            rates: { create: source.rates.map((rate) => ({ entityId, currency: rate.currency, rate: rate.rate })) },
            lines: { create: source.lines.map((line) => ({ entityId, date: line.date, currency: line.currency, amountMinor: line.amountMinor, description: line.description, createdById: principal.userId })) },
          },
          include: scenarioInclude,
        });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'cash-scenario', resourceRef: newName, summary: `Cash flow scenario "${newName}" copied from "${source.name}"` }, tx);
        return copy;
      });
      refresh();
      return { ok: true, value: scenarioRecord(row) };
    }),
  );
}

/** The baseline is the one the dashboard and the group view use. Exactly one per entity. */
export async function setBaselineScenario(entityId: string, scenarioId: string): Promise<ActionResult<CashScenarioRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const row = await prisma.$transaction(async (tx) => {
        const scenario = await tx.cashScenario.findFirst({ where: { id: scenarioId, entityId }, select: { id: true, name: true } });
        if (!scenario) throw new StockRefusal('Unknown scenario.');
        await tx.cashScenario.updateMany({ where: { entityId }, data: { isBaseline: false } });
        await tx.cashScenario.update({ where: { id: scenario.id }, data: { isBaseline: true } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'cash-scenario', resourceRef: scenario.name, summary: `"${scenario.name}" is now the baseline cash flow scenario` }, tx);
        return tx.cashScenario.findUniqueOrThrow({ where: { id: scenario.id }, include: scenarioInclude });
      });
      refresh();
      return { ok: true, value: scenarioRecord(row) };
    }),
  );
}

export async function removeScenario(entityId: string, scenarioId: string): Promise<ActionResult<{ id: string }>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      await prisma.$transaction(async (tx) => {
        const scenario = await tx.cashScenario.findFirst({ where: { id: scenarioId, entityId } });
        if (!scenario) throw new StockRefusal('Unknown scenario.');
        if (scenario.isBaseline) throw new StockRefusal('Make another scenario the baseline before removing this one.');
        await tx.cashScenario.delete({ where: { id: scenario.id } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'cash-scenario', resourceRef: scenario.name, summary: `Cash flow scenario removed: ${scenario.name}` }, tx);
      });
      refresh();
      return { ok: true, value: { id: scenarioId } };
    }),
  );
}

// --- lines added by hand ---------------------------------------------------------------------------

export type ScenarioLineInput = { scenarioId: string; date: string; currency?: Currency; amountMinor: number; description: string };

/** Anything the records do not know about: a loan, a promised grant, a one-off repair. */
export async function addScenarioLine(entityId: string, input: ScenarioLineInput): Promise<ActionResult<CashScenarioRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const description = String(input.description ?? '').trim();
      if (!description) return fail('Say what the line is.');
      const amountMinor = Math.round(Number(input.amountMinor));
      if (!Number.isFinite(amountMinor) || amountMinor === 0) return fail('Give an amount: positive for money in, negative for money out.');
      if (input.currency && !isCurrency(input.currency)) return fail('Unknown currency.');

      const row = await prisma.$transaction(async (tx) => {
        const scenario = await tx.cashScenario.findFirst({ where: { id: input.scenarioId, entityId }, select: { id: true, name: true } });
        if (!scenario) throw new StockRefusal('Unknown scenario.');
        const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
        await tx.cashScenarioLine.create({
          data: { entityId, scenarioId: scenario.id, date: dateOf(input.date), currency: input.currency ?? entity.functionalCurrency, amountMinor: fromMinor(amountMinor), description, createdById: principal.userId },
        });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'cash-scenario', resourceRef: scenario.name, summary: `Line added to "${scenario.name}": ${description} ${(amountMinor / 100).toFixed(2)} on ${input.date}` },
          tx,
        );
        return tx.cashScenario.findUniqueOrThrow({ where: { id: scenario.id }, include: scenarioInclude });
      });
      refresh();
      return { ok: true, value: scenarioRecord(row) };
    }),
  );
}

export async function removeScenarioLine(entityId: string, lineId: string): Promise<ActionResult<CashScenarioRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const row = await prisma.$transaction(async (tx) => {
        const line = await tx.cashScenarioLine.findFirst({ where: { id: lineId, entityId }, include: { scenario: { select: { id: true, name: true } } } });
        if (!line) throw new StockRefusal('Unknown line.');
        await tx.cashScenarioLine.delete({ where: { id: line.id } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'cash-scenario', resourceRef: line.scenario.name, summary: `Line removed from "${line.scenario.name}": ${line.description}` }, tx);
        return tx.cashScenario.findUniqueOrThrow({ where: { id: line.scenario.id }, include: scenarioInclude });
      });
      refresh();
      return { ok: true, value: scenarioRecord(row) };
    }),
  );
}

// --- reading the sources back -------------------------------------------------------------------------

/**
 * Everything one entity's forecast is built from, read fresh. The screen gets
 * this with the page; this is for asking again after something has changed,
 * without reloading everything else.
 */
export async function cashForecastSources(entityId: string): Promise<ActionResult<CashSourceRecord>> {
  return withEntityAccess(entityId, 'reports:view', () =>
    refusable(async () => {
      const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId }, select: { id: true, name: true, functionalCurrency: true } });
      const sources = await cashSourcesFor(entity.id, entity.name, entity.functionalCurrency as Currency, new Date().toISOString().slice(0, 10));
      return { ok: true, value: sources };
    }),
  );
}
