'use server';

/**
 * Server Functions for commodity trading: commodities and their grades,
 * buying agents and their floats, purchases synced from the field, and
 * weigh-outs (shrinkage). Same contract as documents.ts: authorize first
 * through src/lib/dal.ts, scope by entity, and write each change with its
 * journal and audit event in one transaction.
 */

import { refresh } from 'next/cache';
import { Prisma } from '@prisma/client';

import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess } from '@/lib/dal';
import { seedChartForEntity } from '@/lib/data/chart.ts';
import { itemInclude, itemRecord } from '@/lib/data/inventory';
import { entityRecord, entityTypeOf } from '@/lib/data/mappers';
import { fromMinor, toMinor } from '@/lib/data/money';
import { balanceAt, moveBalance, StockRefusal } from '@/lib/data/stock';
import { evidenceToPrisma, settlementToPrisma } from '@/lib/data/momo';
import { agentRecord, commodityRecord, floatInclude, floatRecord, kindToPrisma, lotInclude, lotRecord, paymentToPrisma, purchaseInclude, purchaseRecord } from '@/lib/data/trading';
import type { AgentPurchaseRecord, BuyingAgentRecord, CommodityRecord, EntityRecord, FloatAdvanceRecord, ItemRecord, LotRecord } from '@/lib/data/types';
import { attachmentGate } from '@/lib/attachments';
import { attachmentCount, rulesFor } from '@/lib/data/attachments';
import { periodOf } from '@/lib/documents';
import { accountForStock, formatKg, inventoryAccountCategory, type StockPosition } from '@/lib/inventory';
import { momoAccounts, planRecovery, purchaseJournal } from '@/lib/momo';
import { encryptField } from '@/lib/pii-crypto';
import {
  abnormalLossValue,
  commodityKinds,
  floatAdvanceJournal,
  floatReturnJournal,
  holdsStock,
  shrinkageSplit,
  stockLossJournal,
  tradingAccounts,
  type CommodityKind,
  type Quality,
  type TradingJournalLine,
} from '@/lib/trading';
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

async function requireTrader(entityId: string) {
  const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId } });
  if (!holdsStock(entityTypeOf(entity.type))) throw new StockRefusal(`${entity.name} is an impact programme and holds no stock.`);
  return entity;
}

async function requireOpenPeriod(entityId: string, date: string) {
  const period = periodOf(date);
  if (await prisma.taxPeriodFiling.findUnique({ where: { entityId_period: { entityId, period } } })) {
    throw new StockRefusal(`Period ${period} has been filed. Date this in an open period.`);
  }
}

async function namesFor(tx: Tx, entityId: string): Promise<Record<string, string>> {
  return Object.fromEntries((await tx.account.findMany({ where: { entityId }, select: { code: true, name: true } })).map((a) => [a.code, a.name]));
}

/** A STOCK journal in the functional currency, from trading lines. Null when nothing to post. */
async function postJournal(tx: Tx, entityId: string, lines: TradingJournalLine[], date: string, reference: string, description: string, principal: Principal): Promise<string | null> {
  if (lines.length === 0) return null;
  const debits = lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amount, 0);
  const credits = lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amount, 0);
  if (debits !== credits) throw new Error('Trading journal does not balance; refusing to post');
  const accounts = await tx.account.findMany({ where: { entityId, code: { in: lines.map((l) => l.accountCode) } }, select: { id: true, code: true } });
  const idOf = new Map(accounts.map((a) => [a.code, a.id]));
  for (const line of lines) if (!idOf.has(line.accountCode)) throw new StockRefusal(`Account ${line.accountCode} is not in this entity's chart. Save any commodity once to add the trading accounts.`);
  const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
  const entry = await tx.journalEntry.create({
    data: {
      entityId, kind: 'STOCK', reference, description, postedAt: dateOf(date), postedById: principal.userId,
      lines: { create: lines.map((line) => ({ entityId, accountId: idOf.get(line.accountCode) as string, txnCurrency: entity.functionalCurrency, txnAmountMinor: fromMinor(line.amount), rate: new Prisma.Decimal(1), amountMinor: fromMinor(line.amount), direction: line.type === 'debit' ? ('MONEY_IN' as const) : ('MONEY_OUT' as const) })) },
    },
    select: { id: true },
  });
  return entry.id;
}

function qualityData(quality: Quality | undefined) {
  const q = quality ?? {};
  return {
    kor: typeof q.kor === 'number' ? new Prisma.Decimal(q.kor) : null,
    moisturePct: typeof q.moisturePct === 'number' ? new Prisma.Decimal(q.moisturePct) : null,
    nutCount: typeof q.nutCount === 'number' ? Math.round(q.nutCount) : null,
    cocoaGrade: typeof q.cocoaGrade === 'string' && q.cocoaGrade.trim() ? q.cocoaGrade.trim() : null,
    beanCount: typeof q.beanCount === 'number' ? Math.round(q.beanCount) : null,
  };
}

// --- commodities and grades ---------------------------------------------------------------------

export type CommodityInput = { id?: string; code: string; name: string; kind: CommodityKind; gramsPerBag: number; shrinkageTolerancePct: number; isActive?: boolean };

export async function saveCommodity(entityId: string, input: CommodityInput): Promise<ActionResult<CommodityRecord>> {
  return withEntityAccess(entityId, 'inventory:manage', (principal) =>
    refusable(async () => {
      const entity = await requireTrader(entityId);
      const code = input.code.trim().toUpperCase();
      const name = input.name.trim();
      if (!code || !name) return fail('A commodity needs a code and a name.');
      if (!commodityKinds.includes(input.kind)) return fail('Unknown commodity kind.');
      if (!Number.isInteger(input.gramsPerBag) || input.gramsPerBag <= 0) return fail('Enter the weight of one bag in kg.');
      if (!(input.shrinkageTolerancePct >= 0 && input.shrinkageTolerancePct <= 50)) return fail('Shrinkage tolerance is a percentage of weight in, 0 to 50.');
      const row = await prisma.$transaction(async (tx) => {
        await seedChartForEntity(tx, entityId, entityTypeOf(entity.type));
        const data = { code, name, kind: kindToPrisma[input.kind], gramsPerBag: input.gramsPerBag, shrinkageTolerancePct: new Prisma.Decimal(input.shrinkageTolerancePct) };
        if (input.id) {
          const existing = await tx.commodity.findFirst({ where: { id: input.id, entityId } });
          if (!existing) throw new StockRefusal('Commodity not found.');
          const updated = await tx.commodity.update({ where: { id: existing.id }, data: { ...data, isActive: input.isActive ?? existing.isActive } });
          // Grades follow the commodity's bag weight.
          await tx.item.updateMany({ where: { commodityId: existing.id }, data: { gramsPerBag: input.gramsPerBag } });
          await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'commodity', resourceRef: code, summary: `Commodity ${code} ${name} updated: ${input.gramsPerBag / 1000} kg/bag, shrinkage tolerance ${input.shrinkageTolerancePct}%` }, tx);
          return updated;
        }
        if (await tx.commodity.findUnique({ where: { entityId_code: { entityId, code } } })) throw new StockRefusal(`Commodity code ${code} already exists.`);
        const created = await tx.commodity.create({ data: { entityId, ...data } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'commodity', resourceRef: code, summary: `Commodity ${code} ${name} created: ${input.gramsPerBag / 1000} kg/bag, shrinkage tolerance ${input.shrinkageTolerancePct}%` }, tx);
        return created;
      });
      refresh();
      return { ok: true, value: commodityRecord(row) };
    }),
  );
}

export type GradeInput = { id?: string; commodityId: string; grade: string; accountCode?: string; isActive?: boolean };

/** A grade of a commodity is an Item: the costing key with a location. Bags convert through the commodity. */
export async function saveGrade(entityId: string, input: GradeInput): Promise<ActionResult<ItemRecord>> {
  return withEntityAccess(entityId, 'inventory:manage', (principal) =>
    refusable(async () => {
      await requireTrader(entityId);
      const grade = input.grade.trim();
      if (!grade) return fail('Give the grade a name (e.g. Grade 1, W320, Standard).');
      const row = await prisma.$transaction(async (tx) => {
        const commodity = await tx.commodity.findFirst({ where: { id: input.commodityId, entityId, isActive: true } });
        if (!commodity) throw new StockRefusal('Choose a commodity of this entity.');
        const accountCode = input.accountCode?.trim() || '1030';
        const account = await tx.account.findFirst({ where: { entityId, code: accountCode, category: inventoryAccountCategory, isActive: true } });
        if (!account) throw new StockRefusal(`${accountCode} is not an inventory account in this entity's chart.`);
        const code = `${commodity.code}-${grade.toUpperCase().replace(/[^A-Z0-9]+/g, '')}`;
        const name = `${commodity.name} — ${grade}`;
        if (input.id) {
          const existing = await tx.item.findFirst({ where: { id: input.id, entityId } });
          if (!existing) throw new StockRefusal('Grade not found.');
          const updated = await tx.item.update({ where: { id: existing.id }, data: { code, name, grade, commodityId: commodity.id, baseUnit: 'BAG', gramsPerBag: commodity.gramsPerBag, accountId: account.id, category: 'RAW_MATERIAL', isActive: input.isActive ?? existing.isActive }, include: itemInclude });
          await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'item', resourceRef: code, summary: `Grade ${name} updated` }, tx);
          return updated;
        }
        if (await tx.item.findUnique({ where: { entityId_code: { entityId, code } } })) throw new StockRefusal(`${commodity.code} already has a grade "${grade}".`);
        const created = await tx.item.create({ data: { entityId, code, name, grade, commodityId: commodity.id, category: 'RAW_MATERIAL', baseUnit: 'BAG', gramsPerBag: commodity.gramsPerBag, accountId: account.id }, include: itemInclude });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'item', resourceRef: code, summary: `Grade ${name} created in ${accountCode}` }, tx);
        return created;
      });
      refresh();
      return { ok: true, value: itemRecord(row) };
    }),
  );
}

// --- agents --------------------------------------------------------------------------------------

export type AgentInput = { id?: string; name: string; phone?: string; defaultLocationId?: string | null; isActive?: boolean };

export async function saveAgent(entityId: string, input: AgentInput): Promise<ActionResult<BuyingAgentRecord>> {
  return withEntityAccess(entityId, 'inventory:manage', (principal) =>
    refusable(async () => {
      await requireTrader(entityId);
      const name = input.name.trim();
      if (!name) return fail('An agent needs a name.');
      const row = await prisma.$transaction(async (tx) => {
        let defaultLocationId: string | null = null;
        if (input.defaultLocationId) {
          if (!(await tx.stockLocation.findFirst({ where: { id: input.defaultLocationId, entityId, isActive: true } }))) throw new StockRefusal('Choose a location of this entity.');
          defaultLocationId = input.defaultLocationId;
        }
        const data = { name, phone: encryptField('BuyingAgent.phone', input.phone?.trim()), defaultLocationId };
        if (input.id) {
          const existing = await tx.buyingAgent.findFirst({ where: { id: input.id, entityId } });
          if (!existing) throw new StockRefusal('Agent not found.');
          const updated = await tx.buyingAgent.update({ where: { id: existing.id }, data: { ...data, isActive: input.isActive ?? existing.isActive } });
          await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'agent', resourceRef: existing.id, summary: `Buying agent ${name} updated` }, tx);
          return updated;
        }
        const created = await tx.buyingAgent.create({ data: { entityId, ...data } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'agent', resourceRef: created.id, summary: `Buying agent ${name} created` }, tx);
        return created;
      });
      refresh();
      return { ok: true, value: agentRecord(row) };
    }),
  );
}

export async function setFloatAgeLimit(entityId: string, days: number): Promise<ActionResult<EntityRecord>> {
  return withEntityAccess(entityId, 'inventory:manage', (principal) =>
    refusable(async () => {
      await requireTrader(entityId);
      if (!Number.isInteger(days) || days < 1 || days > 365) return fail('The float age limit is a number of days, 1 to 365.');
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.entity.update({ where: { id: entityId }, data: { floatAgeLimitDays: days } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'entity', resourceRef: entityId, summary: `Float age limit set to ${days} days` }, tx);
        return row;
      });
      refresh();
      return { ok: true, value: entityRecord(updated) };
    }),
  );
}

// --- floats --------------------------------------------------------------------------------------

export type FloatInput = { agentId: string; date: string; amountMinor: number; bankAccountId: string; note?: string };

/** Cash out to an agent: Dr Agent Float Advances / Cr bank. */
export async function advanceFloat(entityId: string, input: FloatInput): Promise<ActionResult<FloatAdvanceRecord>> {
  return withEntityAccess(entityId, 'stock:post', (principal) =>
    refusable(async () => {
      await requireTrader(entityId);
      if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) return fail('Enter the amount advanced.');
      dateOf(input.date);
      await requireOpenPeriod(entityId, input.date);
      const row = await prisma.$transaction(async (tx) => {
        const agent = await tx.buyingAgent.findFirst({ where: { id: input.agentId, entityId, isActive: true } });
        if (!agent) throw new StockRefusal('Choose an active agent of this entity.');
        const bank = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, entityId, isActive: true }, include: { account: true } });
        if (!bank) throw new StockRefusal('Choose a bank account of this entity.');
        const names = await namesFor(tx, entityId);
        const journalId = await postJournal(tx, entityId, floatAdvanceJournal(input.amountMinor, bank.account.code, names), input.date, `FLOAT ${agent.name}`, `Float advanced to ${agent.name}${input.note ? ` — ${input.note.trim()}` : ''}`, principal);
        const created = await tx.floatAdvance.create({ data: { entityId, agentId: agent.id, date: dateOf(input.date), amountMinor: fromMinor(input.amountMinor), bankAccountId: bank.id, journalEntryId: journalId, createdById: principal.userId }, include: floatInclude });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'float', resourceRef: created.id, summary: `Float of ${(input.amountMinor / 100).toFixed(2)} advanced to ${agent.name} from ${bank.name}`, metadata: { journalEntryId: journalId, agentId: agent.id } }, tx);
        return created;
      });
      refresh();
      return { ok: true, value: floatRecord(row) };
    }),
  );
}

export type FloatReturnInput = { floatId: string; date: string; amountMinor: number; bankAccountId: string };

/** Cash back from the agent: Dr bank / Cr Agent Float Advances. */
export async function returnFloatCash(entityId: string, input: FloatReturnInput): Promise<ActionResult<FloatAdvanceRecord>> {
  return withEntityAccess(entityId, 'stock:post', (principal) =>
    refusable(async () => {
      await requireTrader(entityId);
      if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) return fail('Enter the amount returned.');
      dateOf(input.date);
      await requireOpenPeriod(entityId, input.date);
      const row = await prisma.$transaction(async (tx) => {
        const float = await tx.floatAdvance.findFirst({ where: { id: input.floatId, entityId }, include: { ...floatInclude, agent: true } });
        if (!float) throw new StockRefusal('Float not found.');
        if (float.status === 'RECONCILED') throw new StockRefusal('This float is reconciled.');
        const outstanding = toMinor(float.amountMinor) - float.purchases.filter((p) => p.status === 'POSTED').reduce((s, p) => s + toMinor(p.priceMinor), 0) - float.returns.reduce((s, r) => s + toMinor(r.amountMinor), 0);
        if (input.amountMinor > outstanding) throw new StockRefusal(`Only ${(outstanding / 100).toFixed(2)} is outstanding on this float.`);
        const bank = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, entityId, isActive: true }, include: { account: true } });
        if (!bank) throw new StockRefusal('Choose a bank account of this entity.');
        const names = await namesFor(tx, entityId);
        const journalId = await postJournal(tx, entityId, floatReturnJournal(input.amountMinor, bank.account.code, names), input.date, `FLOAT ${float.agent.name}`, `Float cash returned by ${float.agent.name}`, principal);
        await tx.floatReturn.create({ data: { entityId, floatId: float.id, date: dateOf(input.date), amountMinor: fromMinor(input.amountMinor), bankAccountId: bank.id, journalEntryId: journalId, createdById: principal.userId } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'float', resourceRef: float.id, summary: `${(input.amountMinor / 100).toFixed(2)} returned by ${float.agent.name} to ${bank.name}`, metadata: { journalEntryId: journalId } }, tx);
        return tx.floatAdvance.findUniqueOrThrow({ where: { id: float.id }, include: floatInclude });
      });
      refresh();
      return { ok: true, value: floatRecord(row) };
    }),
  );
}

/** Close a float: refused unless advanced = purchases posted + cash returned, exactly. */
export async function reconcileFloat(entityId: string, floatId: string): Promise<ActionResult<FloatAdvanceRecord>> {
  return withEntityAccess(entityId, 'stock:post', (principal) =>
    refusable(async () => {
      await requireTrader(entityId);
      const row = await prisma.$transaction(async (tx) => {
        const float = await tx.floatAdvance.findFirst({ where: { id: floatId, entityId }, include: { ...floatInclude, agent: true } });
        if (!float) throw new StockRefusal('Float not found.');
        if (float.status === 'RECONCILED') throw new StockRefusal('Already reconciled.');
        const purchased = float.purchases.filter((p) => p.status === 'POSTED').reduce((s, p) => s + toMinor(p.priceMinor), 0);
        const returned = float.returns.reduce((s, r) => s + toMinor(r.amountMinor), 0);
        const outstanding = toMinor(float.amountMinor) - purchased - returned;
        if (outstanding !== 0) throw new StockRefusal(`Does not reconcile: advanced ${(toMinor(float.amountMinor) / 100).toFixed(2)}, purchases ${(purchased / 100).toFixed(2)}, returned ${(returned / 100).toFixed(2)} — ${(outstanding / 100).toFixed(2)} outstanding.`);
        const pending = await tx.agentPurchase.count({ where: { floatId: float.id, status: 'PENDING' } });
        if (pending > 0) throw new StockRefusal(`${pending} purchase${pending === 1 ? '' : 's'} on this float still pending — post or reject them first.`);
        const updated = await tx.floatAdvance.update({ where: { id: float.id }, data: { status: 'RECONCILED', reconciledAt: new Date(), reconciledById: principal.userId }, include: floatInclude });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'float', resourceRef: float.id, summary: `Float to ${float.agent.name} reconciled: ${(purchased / 100).toFixed(2)} in produce, ${(returned / 100).toFixed(2)} in cash` }, tx);
        return updated;
      });
      refresh();
      return { ok: true, value: floatRecord(row) };
    }),
  );
}

// --- purchases from the field -----------------------------------------------------------------------

export type FieldPurchase = {
  /** Generated on the phone; a resend with the same ref is ignored. */
  clientRef: string;
  agentId: string;
  floatId?: string | null;
  date: string;
  /** Either an existing farmer, or a name that becomes one. */
  farmerId?: string | null;
  farmerName: string;
  farmerPhone?: string;
  walletNumber?: string;
  community?: string;
  district?: string;
  itemId: string;
  locationId?: string | null;
  bags?: number | null;
  /** Weight in grams; the phone converts bags through the commodity. */
  grams: number;
  priceMinor: number;
  paymentMethod: 'cash' | 'mobile-money';
  /** The agent paid from the float now, or the farmer is paid centrally later. */
  settlement?: 'float' | 'payable';
  /** The mobile money transfer reference, when the agent paid that way. */
  paymentRef?: string;
  /** Cash paid now must carry the farmer's signature or thumbprint from the device. */
  evidenceKind?: 'signature' | 'thumbprint' | 'reference';
  evidenceData?: string;
  quality?: Quality;
  note?: string;
};

export type SyncResult = { accepted: string[]; duplicates: string[]; rejected: { clientRef: string; error: string }[] };

/**
 * Receive purchase records from the field form. Each is validated on its own
 * so one bad record does not block the rest; a clientRef already seen is a
 * duplicate, not an error. Nothing posts here — an Accountant reviews and
 * posts pending purchases, which is when stock and the float move.
 */
export async function syncAgentPurchases(entityId: string, purchases: FieldPurchase[]): Promise<ActionResult<SyncResult>> {
  return withEntityAccess(entityId, 'stock:enter', (principal) =>
    refusable(async () => {
      await requireTrader(entityId);
      const result: SyncResult = { accepted: [], duplicates: [], rejected: [] };
      for (const purchase of purchases.slice(0, 200)) {
        const clientRef = String(purchase.clientRef ?? '').trim();
        if (!clientRef) { result.rejected.push({ clientRef, error: 'Missing client reference.' }); continue; }
        try {
          await prisma.$transaction(async (tx) => {
            if (await tx.agentPurchase.findUnique({ where: { entityId_clientRef: { entityId, clientRef } } })) { result.duplicates.push(clientRef); return; }
            const agent = await tx.buyingAgent.findFirst({ where: { id: purchase.agentId, entityId, isActive: true } });
            if (!agent) throw new StockRefusal('Unknown agent.');
            const item = await tx.item.findFirst({ where: { id: purchase.itemId, entityId, isActive: true }, include: { commodity: true } });
            if (!item || !item.commodityId) throw new StockRefusal('Unknown commodity grade.');
            const locationId = purchase.locationId || agent.defaultLocationId;
            if (!locationId || !(await tx.stockLocation.findFirst({ where: { id: locationId, entityId, isActive: true } }))) throw new StockRefusal('No receiving location: set the agent\'s default location.');
            if (purchase.floatId && !(await tx.floatAdvance.findFirst({ where: { id: purchase.floatId, entityId, agentId: agent.id, status: 'OPEN' } }))) throw new StockRefusal('The float named is not open for this agent.');
            const grams = Math.round(Number(purchase.grams));
            if (!(grams > 0)) throw new StockRefusal('Weight must be greater than zero.');
            const priceMinor = Math.round(Number(purchase.priceMinor));
            if (!(priceMinor >= 0)) throw new StockRefusal('Price paid cannot be negative.');
            const farmerName = String(purchase.farmerName ?? '').trim();
            if (!farmerName) throw new StockRefusal('Farmer name is required.');
            dateOf(purchase.date);
            const settlement = purchase.settlement === 'payable' ? 'payable' : 'float';
            if (settlement === 'float' && !purchase.floatId) throw new StockRefusal('A purchase the agent paid for needs the float it came out of.');
            // Evidence the farmer was paid: cash needs a signature or thumbprint from the
            // device, mobile money needs the transfer reference. Nothing to evidence yet
            // when the farmer is to be paid centrally.
            const evidenceData = String(purchase.evidenceData ?? '').trim();
            const paymentRef = String(purchase.paymentRef ?? '').trim();
            let evidenceKind = purchase.evidenceKind ?? null;
            if (settlement === 'float') {
              if (purchase.paymentMethod === 'cash') {
                if (evidenceKind !== 'signature' && evidenceKind !== 'thumbprint') throw new StockRefusal("A cash payment needs the farmer's signature or thumbprint.");
                if (!evidenceData) throw new StockRefusal('The signature or thumbprint did not reach us; capture it again.');
              } else {
                if (!paymentRef) throw new StockRefusal('A mobile money payment needs its transfer reference.');
                evidenceKind = evidenceKind ?? 'reference';
              }
            }
            // The farmer record is what advances and payments hang off, so every purchase gets one.
            const farmer = purchase.farmerId
              ? await tx.farmer.findFirst({ where: { id: purchase.farmerId, entityId } })
              : await tx.farmer.findFirst({ where: { entityId, name: farmerName } });
            if (purchase.farmerId && !farmer) throw new StockRefusal('Unknown farmer.');
            const community = purchase.community?.trim() || null;
            const district = purchase.district?.trim() || null;
            const walletNumber = String(purchase.walletNumber ?? '').trim() || null;
            const resolved = farmer
              ? await tx.farmer.update({
                  where: { id: farmer.id },
                  data: {
                    phone: farmer.phone ?? encryptField('Farmer.phone', purchase.farmerPhone?.trim()),
                    community: farmer.community ?? community,
                    district: farmer.district ?? district,
                    walletNumber: farmer.walletNumber ?? encryptField('Farmer.walletNumber', walletNumber),
                  },
                })
              : await tx.farmer.create({
                  data: { entityId, name: farmerName, phone: encryptField('Farmer.phone', purchase.farmerPhone?.trim()), community, district, walletNumber: encryptField('Farmer.walletNumber', walletNumber) },
                });
            await tx.agentPurchase.create({
              data: {
                entityId, agentId: agent.id, floatId: purchase.floatId || null, clientRef, date: dateOf(purchase.date), farmerId: resolved.id, farmerName,
                community, district, itemId: item.id, locationId,
                bags: purchase.bags === null || purchase.bags === undefined ? null : new Prisma.Decimal(purchase.bags), grams: fromMinor(grams), priceMinor: fromMinor(priceMinor),
                paymentMethod: paymentToPrisma[purchase.paymentMethod === 'mobile-money' ? 'mobile-money' : 'cash'],
                settlement: settlementToPrisma[settlement], paymentRef: paymentRef || null,
                evidenceKind: evidenceKind ? evidenceToPrisma[evidenceKind] : null, evidenceData: encryptField('AgentPurchase.evidenceData', evidenceData), evidenceAt: evidenceKind ? new Date() : null,
                ...qualityData(purchase.quality), note: purchase.note?.trim() || null, createdById: principal.userId,
              },
            });
            result.accepted.push(clientRef);
          });
        } catch (error) {
          if (error instanceof StockRefusal) result.rejected.push({ clientRef, error: error.message });
          else throw error;
        }
      }
      if (result.accepted.length) {
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'agent-purchase', resourceRef: `${result.accepted.length} synced`, summary: `${result.accepted.length} field purchase${result.accepted.length === 1 ? '' : 's'} synced by ${principal.name}`, metadata: { clientRefs: result.accepted } });
        refresh();
      }
      return { ok: true, value: result };
    }),
  );
}

/**
 * Post pending purchases: each receives its stock at the agent's location,
 * creates its lot, and gets its own journal. Any pre-season advance the
 * farmer still owes is recovered here, oldest first and never more than the
 * purchase is worth; the net goes against the agent's float when the agent
 * paid on the spot, or to Farmer Payables when a batch will pay it. A
 * purchase the agent paid for with no float named is refused — the money
 * must have come from somewhere.
 */
export async function postAgentPurchases(entityId: string, purchaseIds: string[]): Promise<ActionResult<AgentPurchaseRecord[]>> {
  return withEntityAccess(entityId, 'stock:post', (principal) =>
    refusable(async () => {
      await requireTrader(entityId);
      const attachmentRules = await rulesFor(entityId);
      const posted: string[] = [];
      for (const id of purchaseIds.slice(0, 200)) {
        await prisma.$transaction(async (tx) => {
          const purchase = await tx.agentPurchase.findFirst({ where: { id, entityId, status: 'PENDING' }, include: { agent: true, item: { include: { account: true } }, location: { include: { account: true } } } });
          if (!purchase) return;
          if (purchase.settlement === 'FLOAT' && !purchase.floatId) throw new StockRefusal(`Purchase from ${purchase.farmerName} names no float; assign it to the agent's open float first.`);
          // The entity's attachment rule: a field purchase over the threshold
          // needs its weighbridge ticket or receipt before it can be posted.
          const gate = attachmentGate(attachmentRules, {
            target: 'agent-purchase',
            amountMinor: toMinor(purchase.priceMinor),
            attachmentCount: await attachmentCount(entityId, 'agent-purchase', purchase.id),
          });
          if (!gate.ok) throw new StockRefusal(`${purchase.farmerName}, ${purchase.clientRef}: ${gate.error}`);
          if (!purchase.item.commodityId) throw new StockRefusal('The grade has no commodity.');
          const date = purchase.date.toISOString().slice(0, 10);
          if (await tx.taxPeriodFiling.findUnique({ where: { entityId_period: { entityId, period: periodOf(date) } } })) throw new StockRefusal(`Period ${periodOf(date)} has been filed.`);
          const grams = toMinor(purchase.grams);
          const price = toMinor(purchase.priceMinor);
          // What this delivery recovers of the farmer's advances, and what is left to settle.
          const openAdvances = purchase.farmerId
            ? await tx.farmerAdvance.findMany({ where: { entityId, farmerId: purchase.farmerId, status: 'OPEN' }, select: { id: true, date: true, amountMinor: true, settledMinor: true } })
            : [];
          const plan = planRecovery(price, openAdvances.map((a) => ({ id: a.id, date: a.date.toISOString().slice(0, 10), amountMinor: toMinor(a.amountMinor), settledMinor: toMinor(a.settledMinor) })));
          const lot = await tx.lot.create({
            data: {
              entityId, commodityId: purchase.item.commodityId, itemId: purchase.itemId, locationId: purchase.locationId, lotRef: `AP-${purchase.clientRef.slice(0, 12).toUpperCase()}`, date: purchase.date,
              farmerName: purchase.farmerName, community: purchase.community, district: purchase.district,
              kor: purchase.kor, moisturePct: purchase.moisturePct, nutCount: purchase.nutCount, cocoaGrade: purchase.cocoaGrade, beanCount: purchase.beanCount,
              gramsIn: fromMinor(grams), createdById: principal.userId, note: `Bought by ${purchase.agent.name}`,
            },
          });
          await moveBalance(tx, entityId, purchase.itemId, purchase.locationId, grams, price);
          const inventoryCode = accountForStock({ accountCode: purchase.item.account.code }, { accountCode: purchase.location.account?.code ?? null });
          const names = await namesFor(tx, entityId);
          const settlementCode = purchase.settlement === 'PAYABLE' ? momoAccounts.farmerPayables : tradingAccounts.agentFloats;
          const journalId = await postJournal(tx, entityId, purchaseJournal(price, plan.recoveredMinor, inventoryCode, settlementCode, purchase.settlement === 'PAYABLE' ? 'Farmer Payables' : 'Agent Float Advances', names), date, `AP ${purchase.agent.name}`, `${formatKg(grams)} ${purchase.item.name} bought from ${purchase.farmerName} by ${purchase.agent.name}`, principal);
          for (const recovery of plan.recoveries) {
            await tx.advanceRecovery.create({ data: { entityId, advanceId: recovery.advanceId, purchaseId: purchase.id, amountMinor: fromMinor(recovery.amountMinor) } });
            const advance = openAdvances.find((a) => a.id === recovery.advanceId);
            const settled = toMinor(advance?.settledMinor ?? 0n) + recovery.amountMinor;
            await tx.farmerAdvance.update({ where: { id: recovery.advanceId }, data: { settledMinor: fromMinor(settled), status: settled >= toMinor(advance?.amountMinor ?? 0n) ? 'SETTLED' : 'OPEN' } });
          }
          await tx.stockMovement.create({ data: { entityId, kind: 'RECEIPT', date: purchase.date, itemId: purchase.itemId, toLocationId: purchase.locationId, quantityGrams: fromMinor(grams), valueMinor: fromMinor(price), lotId: lot.id, journalEntryId: journalId, createdById: principal.userId, note: `Field purchase from ${purchase.farmerName}` } });
          await tx.agentPurchase.update({ where: { id: purchase.id }, data: { status: 'POSTED', lotId: lot.id, journalEntryId: journalId, recoveredMinor: fromMinor(plan.recoveredMinor), payableMinor: fromMinor(plan.payableMinor), postedById: principal.userId, postedAt: new Date() } });
          await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'agent-purchase', resourceRef: purchase.clientRef, summary: `Field purchase posted: ${formatKg(grams)} ${purchase.item.name} from ${purchase.farmerName} (${purchase.community ?? '—'}) by ${purchase.agent.name}, ${(price / 100).toFixed(2)} ${purchase.paymentMethod === 'MOBILE_MONEY' ? 'by mobile money' : 'in cash'}${plan.recoveredMinor ? `, ${(plan.recoveredMinor / 100).toFixed(2)} recovered from advances` : ''}${purchase.settlement === 'PAYABLE' ? `, ${(plan.payableMinor / 100).toFixed(2)} left payable` : ''}`, metadata: { journalEntryId: journalId, lotId: lot.id, floatId: purchase.floatId, recoveredMinor: plan.recoveredMinor, payableMinor: plan.payableMinor } }, tx);
          posted.push(purchase.id);
        });
      }
      refresh();
      const rows = await prisma.agentPurchase.findMany({ where: { id: { in: posted } }, include: purchaseInclude });
      return { ok: true, value: rows.map(purchaseRecord) };
    }),
  );
}

export async function rejectAgentPurchase(entityId: string, purchaseId: string, reason: string): Promise<ActionResult<AgentPurchaseRecord>> {
  return withEntityAccess(entityId, 'stock:post', (principal) =>
    refusable(async () => {
      await requireTrader(entityId);
      if (!reason.trim()) return fail('Give a reason.');
      const row = await prisma.$transaction(async (tx) => {
        const purchase = await tx.agentPurchase.findFirst({ where: { id: purchaseId, entityId, status: 'PENDING' } });
        if (!purchase) throw new StockRefusal('Only a pending purchase can be rejected.');
        const updated = await tx.agentPurchase.update({ where: { id: purchase.id }, data: { status: 'REJECTED', rejectReason: reason.trim() }, include: purchaseInclude });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'agent-purchase', resourceRef: purchase.clientRef, summary: `Field purchase from ${purchase.farmerName} rejected: ${reason.trim()}` }, tx);
        return updated;
      });
      refresh();
      return { ok: true, value: purchaseRecord(row) };
    }),
  );
}

/** Attach a pending purchase to one of the agent's open floats (the field form may not know it). */
export async function assignPurchaseFloat(entityId: string, purchaseId: string, floatId: string): Promise<ActionResult<AgentPurchaseRecord>> {
  return withEntityAccess(entityId, 'stock:post', (principal) =>
    refusable(async () => {
      await requireTrader(entityId);
      const row = await prisma.$transaction(async (tx) => {
        const purchase = await tx.agentPurchase.findFirst({ where: { id: purchaseId, entityId, status: 'PENDING' } });
        if (!purchase) throw new StockRefusal('Only a pending purchase can be reassigned.');
        const float = await tx.floatAdvance.findFirst({ where: { id: floatId, entityId, agentId: purchase.agentId, status: 'OPEN' } });
        if (!float) throw new StockRefusal('That float is not open for this agent.');
        const updated = await tx.agentPurchase.update({ where: { id: purchase.id }, data: { floatId: float.id }, include: purchaseInclude });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'agent-purchase', resourceRef: purchase.clientRef, summary: `Field purchase from ${purchase.farmerName} assigned to float of ${float.date.toISOString().slice(0, 10)}` }, tx);
        return updated;
      });
      refresh();
      return { ok: true, value: purchaseRecord(row) };
    }),
  );
}

// --- weigh-outs: shrinkage -----------------------------------------------------------------------------

export type WeighOutInput = { lotId: string; date: string; gramsOut: number; note?: string };

/**
 * Re-weigh a lot. Loss within the commodity's tolerance (over the lot's
 * life) leaves quantity only — the cost stays with the remaining stock;
 * loss beyond it is stock loss expense at the grade's average cost.
 */
export async function recordWeighOut(entityId: string, input: WeighOutInput): Promise<ActionResult<LotRecord>> {
  return withEntityAccess(entityId, 'stock:post', (principal) =>
    refusable(async () => {
      await requireTrader(entityId);
      dateOf(input.date);
      await requireOpenPeriod(entityId, input.date);
      const grams = Math.round(Number(input.gramsOut));
      if (!(grams >= 0)) return fail('Enter the weight out.');
      const row = await prisma.$transaction(async (tx) => {
        const lot = await tx.lot.findFirst({ where: { id: input.lotId, entityId }, include: { commodity: true, item: { include: { account: true } }, location: { include: { account: true } } } });
        if (!lot) throw new StockRefusal('Lot not found.');
        let split;
        try {
          split = shrinkageSplit(toMinor(lot.gramsIn), toMinor(lot.gramsShrunk), grams, Number(lot.commodity.shrinkageTolerancePct));
        } catch (error) {
          throw new StockRefusal((error as Error).message);
        }
        if (split.lossGrams === 0) throw new StockRefusal('No weight lost: the lot still weighs what it did.');
        const here = await balanceAt(tx, lot.itemId, lot.locationId);
        if (split.lossGrams > here.quantityGrams) throw new StockRefusal(`Only ${formatKg(here.quantityGrams)} of ${lot.item.name} at ${lot.location.name}; the lot may have moved.`);
        // Costing is per grade per location: the loss is valued at this location's average.
        const position: StockPosition = here;
        const abnormalValue = abnormalLossValue(split.abnormalGrams, position);
        const inventoryCode = accountForStock({ accountCode: lot.item.account.code }, { accountCode: lot.location.account?.code ?? null });
        const names = await namesFor(tx, entityId);

        // Normal shrinkage: quantity down, value untouched — the remaining stock carries the cost.
        if (split.normalGrams > 0) {
          await moveBalance(tx, entityId, lot.itemId, lot.locationId, -split.normalGrams, 0);
          await tx.stockMovement.create({ data: { entityId, kind: 'SHRINKAGE', date: dateOf(input.date), itemId: lot.itemId, fromLocationId: lot.locationId, quantityGrams: fromMinor(-split.normalGrams), valueMinor: 0n, reason: 'MOISTURE_LOSS', lotId: lot.id, createdById: principal.userId, note: `Weigh-out of ${lot.lotRef}: within ${Number(lot.commodity.shrinkageTolerancePct)}% tolerance` } });
        }
        // Abnormal: quantity and value down, value to stock loss.
        let journalId: string | null = null;
        if (split.abnormalGrams > 0) {
          await moveBalance(tx, entityId, lot.itemId, lot.locationId, -split.abnormalGrams, -abnormalValue);
          journalId = await postJournal(tx, entityId, stockLossJournal(abnormalValue, inventoryCode, names), input.date, `LOSS ${lot.lotRef}`, `Shrinkage beyond tolerance on lot ${lot.lotRef}: ${formatKg(split.abnormalGrams)} ${lot.item.name}`, principal);
          await tx.stockMovement.create({ data: { entityId, kind: 'SHRINKAGE', date: dateOf(input.date), itemId: lot.itemId, fromLocationId: lot.locationId, quantityGrams: fromMinor(-split.abnormalGrams), valueMinor: fromMinor(-abnormalValue), reason: 'ABNORMAL_LOSS', lotId: lot.id, journalEntryId: journalId, createdById: principal.userId, note: `Weigh-out of ${lot.lotRef}: beyond tolerance` } });
        }
        const updated = await tx.lot.update({ where: { id: lot.id }, data: { gramsShrunk: { increment: fromMinor(split.lossGrams) }, note: input.note?.trim() ? `${lot.note ? lot.note + ' · ' : ''}${input.note.trim()}` : lot.note }, include: lotInclude });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'lot', resourceRef: lot.lotRef, summary: `Weigh-out of ${lot.lotRef}: ${formatKg(split.lossGrams)} lost — ${formatKg(split.normalGrams)} within tolerance, ${formatKg(split.abnormalGrams)} beyond (${(abnormalValue / 100).toFixed(2)} to ${tradingAccounts.stockLoss})`, metadata: { journalEntryId: journalId, ...split, abnormalValue } }, tx);
        return updated;
      });
      refresh();
      return { ok: true, value: lotRecord(row) };
    }),
  );
}
