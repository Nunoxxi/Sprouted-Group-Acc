'use server';

/**
 * Server Functions for sales contracts and LBC mode. Same contract as the
 * rest: authorize first through src/lib/dal.ts, scope by entity, and write
 * each change with its journal and audit event in one transaction.
 *
 * A delivery draws stock from a location at that location's weighted
 * average and posts one CONTRACT journal shaped by the contract's terms and
 * the entity's LBC settings (src/lib/contracts.ts). What is shown on screen
 * is computed from the same records this file writes.
 */

import { refresh } from 'next/cache';
import { Prisma } from '@prisma/client';

import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import {
  acceptanceJournal,
  cmcReceiptJournal,
  contractAccounts,
  contractValueMinor,
  deliveryJournal,
  journalBalanced,
  priceUnits,
  seedFundJournal,
  type PriceUnit,
  type SeedFundKind,
} from '@/lib/contracts';
import { authorizationFailure, requireEntityAccess } from '@/lib/dal';
import { seedChartForEntity } from '@/lib/data/chart.ts';
import { contractInclude, contractRecord, seedFundInclude, seedFundRecord } from '@/lib/data/contracts';
import { entityRecord, entityTypeOf, rateText } from '@/lib/data/mappers';
import { fromMinor, toMinor } from '@/lib/data/money';
import { balanceAt, moveBalance, StockRefusal } from '@/lib/data/stock';
import type { EntityRecord, SalesContractRecord, SeedFundRecord } from '@/lib/data/types';
import { periodOf } from '@/lib/documents';
import { convertMinor, isCurrency, normalizeRate, selectRate, type Currency } from '@/lib/fx';
import { accountForStock, formatKg, issue, toGrams, type StockUnit } from '@/lib/inventory';
import { prisma } from '@/lib/prisma';
import { holdsStock, type TradingJournalLine } from '@/lib/trading';

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
  if (!holdsStock(entityTypeOf(entity.type))) throw new StockRefusal(`${entity.name} is an impact programme and holds no stock to sell.`);
  return entity;
}

async function requireOpenPeriod(entityId: string, date: string) {
  const period = periodOf(date);
  if (await prisma.taxPeriodFiling.findUnique({ where: { entityId_period: { entityId, period } } })) throw new StockRefusal(`Period ${period} has been filed.`);
}

async function namesFor(tx: Tx, entityId: string): Promise<Record<string, string>> {
  return Object.fromEntries((await tx.account.findMany({ where: { entityId }, select: { code: true, name: true } })).map((a) => [a.code, a.name]));
}

/**
 * A CONTRACT journal. Lines on the receivable and revenue accounts carry
 * the contract currency and the delivery-date rate, so a foreign
 * receivable is revalued at period end like any other monetary balance.
 */
async function postContractJournal(
  tx: Tx,
  entityId: string,
  lines: TradingJournalLine[],
  date: string,
  reference: string,
  description: string,
  principal: Principal,
  foreign: { currency: Currency; rate: string; txnByCode: Record<string, number> } | null,
): Promise<string | null> {
  if (lines.length === 0) return null;
  if (!journalBalanced(lines)) throw new Error('Contract journal does not balance; refusing to post');
  const accounts = await tx.account.findMany({ where: { entityId, code: { in: lines.map((l) => l.accountCode) } }, select: { id: true, code: true } });
  const idOf = new Map(accounts.map((a) => [a.code, a.id]));
  for (const line of lines) if (!idOf.has(line.accountCode)) throw new StockRefusal(`Account ${line.accountCode} is not in this entity's chart. Save the LBC settings once to add the contract accounts.`);
  const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
  const entry = await tx.journalEntry.create({
    data: {
      entityId, kind: 'CONTRACT', reference, description, postedAt: dateOf(date), postedById: principal.userId,
      lines: {
        create: lines.map((line) => {
          const txn = foreign && line.accountCode in foreign.txnByCode ? { txnCurrency: foreign.currency, txnAmountMinor: fromMinor(foreign.txnByCode[line.accountCode]), rate: new Prisma.Decimal(foreign.rate) } : { txnCurrency: entity.functionalCurrency, txnAmountMinor: fromMinor(line.amount), rate: new Prisma.Decimal(1) };
          return { entityId, accountId: idOf.get(line.accountCode) as string, ...txn, amountMinor: fromMinor(line.amount), direction: line.type === 'debit' ? ('MONEY_IN' as const) : ('MONEY_OUT' as const) };
        }),
      },
    },
    select: { id: true },
  });
  return entry.id;
}

/** The system location that holds stock delivered but not yet accepted, carried in Goods in Transit. */
async function transitLocation(tx: Tx, entityId: string) {
  const existing = await tx.stockLocation.findUnique({ where: { entityId_code: { entityId, code: 'DELIVERED' } }, include: { account: true } });
  if (existing) return existing;
  const account = await tx.account.findFirst({ where: { entityId, code: contractAccounts.goodsInTransit } });
  if (!account) throw new StockRefusal(`Account ${contractAccounts.goodsInTransit} (Goods in Transit) is not in this entity's chart.`);
  return tx.stockLocation.create({ data: { entityId, code: 'DELIVERED', name: 'Delivered, awaiting acceptance', accountId: account.id }, include: { account: true } });
}

// --- contracts ------------------------------------------------------------------------------------

export type ContractInput = {
  id?: string;
  buyerContactId: string;
  itemId: string;
  quantity: number;
  quantityUnit: StockUnit;
  /** Price per priceUnit in the contract currency, minor units. */
  priceMinor: number;
  priceUnit: PriceUnit;
  currency: Currency;
  /** Functional per 1 unit of currency at signing; ignored for functional-currency contracts. */
  contractRate?: string | null;
  deliveryTerms: string;
  deliveryFrom: string;
  deliveryTo: string;
  recognizeOn: 'delivery' | 'acceptance';
  saleType: 'domestic' | 'export';
  /** LBC mode: a CMC contract at the producer price. */
  isCmc?: boolean;
  note?: string;
};

export async function saveContract(entityId: string, input: ContractInput): Promise<ActionResult<SalesContractRecord>> {
  return withEntityAccess(entityId, 'document:draft', (principal) =>
    refusable(async () => {
      const entity = await requireTrader(entityId);
      if (!isCurrency(input.currency)) return fail('Unknown currency.');
      if (!priceUnits.includes(input.priceUnit)) return fail('Price per kg, bag or tonne.');
      if (!(input.quantity > 0)) return fail('Enter the contracted quantity.');
      if (!Number.isInteger(input.priceMinor) || input.priceMinor <= 0) return fail('Enter the price.');
      if (!input.deliveryTerms.trim()) return fail('Enter the delivery terms (e.g. FOB Tema, EXW warehouse, CMC take-over Kumasi).');
      dateOf(input.deliveryFrom); dateOf(input.deliveryTo);
      if (input.deliveryTo < input.deliveryFrom) return fail('The delivery period ends before it starts.');
      const foreign = input.currency !== entity.functionalCurrency;
      let contractRate: string | null = null;
      if (foreign && input.contractRate?.trim()) {
        try { contractRate = normalizeRate(input.contractRate); } catch { return fail('The contract rate must be a positive decimal number.'); }
      }
      const isCmc = !!input.isCmc;
      if (isCmc && !entity.lbcMode) return fail('CMC contracts need LBC mode on (Contracts → LBC).');
      if (isCmc && input.currency !== entity.functionalCurrency) return fail('A CMC contract is in the functional currency at the producer price.');

      const row = await prisma.$transaction(async (tx) => {
        await seedChartForEntity(tx, entityId, entityTypeOf(entity.type));
        const buyer = await tx.contact.findFirst({ where: { id: input.buyerContactId, isActive: true } });
        if (!buyer) throw new StockRefusal('Choose a buyer.');
        const item = await tx.item.findFirst({ where: { id: input.itemId, entityId, isActive: true }, include: { commodity: true } });
        if (!item || !item.commodityId || !item.commodity) throw new StockRefusal('Choose a grade of this entity.');
        const grams = toGrams(input.quantity, input.quantityUnit, { baseUnit: 'bag', gramsPerBag: item.commodity.gramsPerBag, gramsPerCarton: null });
        if (grams <= 0) throw new StockRefusal('The quantity rounds to nothing.');
        const data = {
          buyerContactId: buyer.id, commodityId: item.commodityId, itemId: item.id, quantityGrams: fromMinor(grams), priceMinor: fromMinor(input.priceMinor),
          priceUnit: input.priceUnit === 'bag' ? ('BAG' as const) : input.priceUnit === 'tonne' ? ('TONNE' as const) : ('KG' as const),
          currency: input.currency, contractRate: contractRate ? new Prisma.Decimal(contractRate) : null, deliveryTerms: input.deliveryTerms.trim(),
          deliveryFrom: dateOf(input.deliveryFrom), deliveryTo: dateOf(input.deliveryTo), recognizeOn: input.recognizeOn === 'acceptance' ? ('ACCEPTANCE' as const) : ('DELIVERY' as const),
          saleType: input.saleType === 'export' ? ('EXPORT' as const) : ('DOMESTIC' as const), isCmc, note: input.note?.trim() || null,
        };
        if (input.id) {
          const existing = await tx.salesContract.findFirst({ where: { id: input.id, entityId }, include: { deliveries: { select: { id: true } } } });
          if (!existing) throw new StockRefusal('Contract not found.');
          if (existing.deliveries.length > 0) throw new StockRefusal(`${existing.contractNo} has deliveries; its terms are fixed. Close it and raise a new one for any change.`);
          if (existing.status !== 'OPEN') throw new StockRefusal(`${existing.contractNo} is ${existing.status.toLowerCase()}.`);
          const updated = await tx.salesContract.update({ where: { id: existing.id }, data, include: contractInclude });
          await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'contract', resourceRef: existing.contractNo, summary: `Contract ${existing.contractNo} updated: ${formatKg(grams)} ${item.name} to ${buyer.name} at ${(input.priceMinor / 100).toFixed(2)} ${input.currency}/${input.priceUnit}` }, tx);
          return updated;
        }
        const count = await tx.salesContract.count({ where: { entityId } });
        const contractNo = `SC-${String(count + 1).padStart(4, '0')}`;
        const created = await tx.salesContract.create({ data: { entityId, contractNo, ...data, createdById: principal.userId }, include: contractInclude });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'contract', resourceRef: contractNo, summary: `Contract ${contractNo}: ${formatKg(grams)} ${item.name} to ${buyer.name} at ${(input.priceMinor / 100).toFixed(2)} ${input.currency}/${input.priceUnit}, ${input.deliveryTerms.trim()}, ${input.deliveryFrom} to ${input.deliveryTo}${isCmc ? ' (CMC)' : ''}` }, tx);
        return created;
      });
      refresh();
      return { ok: true, value: contractRecord(row) };
    }),
  );
}

export async function setContractStatus(entityId: string, contractId: string, status: 'open' | 'closed' | 'cancelled'): Promise<ActionResult<SalesContractRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      await requireTrader(entityId);
      const row = await prisma.$transaction(async (tx) => {
        const contract = await tx.salesContract.findFirst({ where: { id: contractId, entityId }, include: { deliveries: { select: { id: true } } } });
        if (!contract) throw new StockRefusal('Contract not found.');
        if (status === 'cancelled' && contract.deliveries.length > 0) throw new StockRefusal('A contract with deliveries cannot be cancelled; close it.');
        const updated = await tx.salesContract.update({ where: { id: contract.id }, data: { status: status === 'closed' ? 'CLOSED' : status === 'cancelled' ? 'CANCELLED' : 'OPEN' }, include: contractInclude });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'contract', resourceRef: contract.contractNo, summary: `Contract ${contract.contractNo} ${status}` }, tx);
        return updated;
      });
      refresh();
      return { ok: true, value: contractRecord(row) };
    }),
  );
}

// --- deliveries -----------------------------------------------------------------------------------

export type DeliveryInput = { contractId: string; date: string; locationId: string; quantity: number; unit: StockUnit; rate?: string | null; destination?: string; note?: string };

/**
 * Deliver against a contract: stock out at the location's average, revenue
 * at the contract price (converted at the delivery-date rate and fixed),
 * one journal shaped by the terms and by LBC mode.
 */
export async function recordDelivery(entityId: string, input: DeliveryInput): Promise<ActionResult<SalesContractRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const entity = await requireTrader(entityId);
      dateOf(input.date);
      await requireOpenPeriod(entityId, input.date);
      if (!(input.quantity > 0)) return fail('Enter the quantity delivered.');

      const row = await prisma.$transaction(async (tx) => {
        const contract = await tx.salesContract.findFirst({ where: { id: input.contractId, entityId }, include: { ...contractInclude, item: { include: { account: true, commodity: true } } } });
        if (!contract) throw new StockRefusal('Contract not found.');
        if (contract.status !== 'OPEN') throw new StockRefusal(`${contract.contractNo} is ${contract.status.toLowerCase()}.`);
        const gramsPerBag = contract.item.commodity?.gramsPerBag ?? 0;
        const grams = toGrams(input.quantity, input.unit, { baseUnit: 'bag', gramsPerBag, gramsPerCarton: null });
        const delivered = contract.deliveries.reduce((s, d) => s + toMinor(d.grams), 0);
        const remaining = toMinor(contract.quantityGrams) - delivered;
        if (grams <= 0) throw new StockRefusal('The quantity rounds to nothing.');
        if (grams > remaining) throw new StockRefusal(`${formatKg(grams)} exceeds the ${formatKg(remaining)} still to deliver on ${contract.contractNo}.`);
        const location = await tx.stockLocation.findFirst({ where: { id: input.locationId, entityId, isActive: true }, include: { account: true } });
        if (!location) throw new StockRefusal('Choose the location the stock leaves from.');
        if (location.code === 'DELIVERED') throw new StockRefusal('Deliver from a warehouse, not from the awaiting-acceptance location.');

        // Cost at this location's weighted average.
        const here = await balanceAt(tx, contract.itemId, location.id);
        if (grams > here.quantityGrams) throw new StockRefusal(`Only ${formatKg(here.quantityGrams)} of ${contract.item.name} at ${location.name}.`);
        const { valueMinor: costMinor } = issue(here, grams);

        // Revenue in the contract currency, fixed in functional at the delivery-date rate.
        const priceUnit: PriceUnit = contract.priceUnit === 'BAG' ? 'bag' : contract.priceUnit === 'TONNE' ? 'tonne' : 'kg';
        const revenueTxn = contractValueMinor(grams, toMinor(contract.priceMinor), priceUnit, gramsPerBag);
        const foreign = contract.currency !== entity.functionalCurrency;
        let rate = '1.0';
        if (foreign) {
          if (input.rate?.trim()) {
            try { rate = normalizeRate(input.rate); } catch { throw new StockRefusal('The rate must be a positive decimal number.'); }
          } else {
            const rows = await tx.exchangeRate.findMany({ where: { entityId }, select: { base: true, quote: true, date: true, rate: true } });
            const quote = selectRate(rows.map((r) => ({ base: r.base, quote: r.quote, date: r.date.toISOString().slice(0, 10), rate: rateText(r.rate) ?? '1.0' })), contract.currency, entity.functionalCurrency, input.date);
            if (!quote) throw new StockRefusal(`No ${contract.currency}→${entity.functionalCurrency} rate on file on or before ${input.date}. Enter one under Settings, or type a rate on the delivery.`);
            rate = quote.rate;
          }
        }
        const revenueMinor = foreign ? convertMinor(revenueTxn, rate) : revenueTxn;

        // LBC: margin and haulage per kg from the gazetted rates.
        const lbc = entity.lbcMode && contract.isCmc;
        if (lbc && (entity.buyerMarginMinorPerKg === null || entity.haulageMinorPerKg === null)) throw new StockRefusal("Set the buyer's margin and haulage allowance per kg under Contracts → LBC before delivering to CMC.");
        const marginMinor = lbc ? Number((BigInt(toMinor(entity.buyerMarginMinorPerKg as bigint)) * BigInt(grams) * 2n + 1000n) / 2000n) : 0;
        const haulageMinor = lbc ? Number((BigInt(toMinor(entity.haulageMinorPerKg as bigint)) * BigInt(grams) * 2n + 1000n) / 2000n) : 0;

        const recognizeOn = lbc ? 'delivery' : contract.recognizeOn === 'ACCEPTANCE' ? 'acceptance' : 'delivery';
        const inventoryCode = accountForStock({ accountCode: contract.item.account.code }, { accountCode: location.account?.code ?? null });
        const names = await namesFor(tx, entityId);
        const lines = deliveryJournal({ revenueMinor, costMinor, inventoryCode, saleType: contract.saleType === 'EXPORT' ? 'export' : 'domestic', recognizeOn, lbc: lbc ? { presentation: entity.revenuePresentation === 'NET' ? 'net' : 'gross', marginMinor, haulageMinor } : null, names });
        const salesCode = contract.saleType === 'EXPORT' ? contractAccounts.exportSales : contractAccounts.domesticSales;
        const journalId = await postContractJournal(tx, entityId, lines, input.date, contract.contractNo, `Delivery on ${contract.contractNo}: ${formatKg(grams)} ${contract.item.name} to ${contract.buyer.name}${input.destination ? ` (${input.destination.trim()})` : ''}`, principal, foreign ? { currency: contract.currency, rate, txnByCode: { [contractAccounts.receivables]: revenueTxn, [salesCode]: revenueTxn } } : null);

        // Stock: out of the location; on acceptance terms, into the awaiting-acceptance location.
        await moveBalance(tx, entityId, contract.itemId, location.id, -grams, -costMinor);
        const deliveryNo = contract.deliveries.length + 1;
        const delivery = await tx.contractDelivery.create({
          data: {
            entityId, contractId: contract.id, deliveryNo, date: dateOf(input.date), locationId: location.id, grams: fromMinor(grams), destination: input.destination?.trim() || null,
            rate: new Prisma.Decimal(rate), revenueTxnMinor: fromMinor(revenueTxn), revenueMinor: fromMinor(revenueMinor), costMinor: fromMinor(costMinor), marginMinor: fromMinor(marginMinor), haulageMinor: fromMinor(haulageMinor),
            status: recognizeOn === 'acceptance' ? 'AWAITING_ACCEPTANCE' : 'DELIVERED', journalEntryId: journalId, note: input.note?.trim() || null, createdById: principal.userId,
          },
        });
        if (recognizeOn === 'acceptance') {
          const transit = await transitLocation(tx, entityId);
          await moveBalance(tx, entityId, contract.itemId, transit.id, grams, costMinor);
          await tx.stockMovement.create({ data: { entityId, kind: 'DELIVERY', date: dateOf(input.date), itemId: contract.itemId, fromLocationId: location.id, toLocationId: transit.id, quantityGrams: fromMinor(grams), valueMinor: fromMinor(costMinor), deliveryId: delivery.id, journalEntryId: journalId, createdById: principal.userId, note: `${contract.contractNo} delivery ${deliveryNo}, awaiting acceptance` } });
        } else {
          await tx.stockMovement.create({ data: { entityId, kind: 'DELIVERY', date: dateOf(input.date), itemId: contract.itemId, fromLocationId: location.id, quantityGrams: fromMinor(-grams), valueMinor: fromMinor(-costMinor), deliveryId: delivery.id, journalEntryId: journalId, createdById: principal.userId, note: `${contract.contractNo} delivery ${deliveryNo} to ${contract.buyer.name}` } });
        }
        // Fully delivered: close.
        if (delivered + grams >= toMinor(contract.quantityGrams)) await tx.salesContract.update({ where: { id: contract.id }, data: { status: 'CLOSED' } });

        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'delivery', resourceRef: `${contract.contractNo}/${deliveryNo}`, summary: `Delivery ${deliveryNo} on ${contract.contractNo}: ${formatKg(grams)} ${contract.item.name} at cost ${(costMinor / 100).toFixed(2)}, revenue ${(revenueTxn / 100).toFixed(2)} ${contract.currency}${foreign ? ` at ${rate} = ${(revenueMinor / 100).toFixed(2)}` : ''}${lbc ? ` (LBC ${entity.revenuePresentation.toLowerCase()}: margin ${(marginMinor / 100).toFixed(2)}, haulage ${(haulageMinor / 100).toFixed(2)})` : ''}${recognizeOn === 'acceptance' ? ', revenue on acceptance' : ''}`, metadata: { journalEntryId: journalId, deliveryId: delivery.id, rate, costMinor, revenueMinor } },
          tx,
        );
        return tx.salesContract.findUniqueOrThrow({ where: { id: contract.id }, include: contractInclude });
      });
      refresh();
      return { ok: true, value: contractRecord(row) };
    }),
  );
}

/** Buyer accepted an on-acceptance delivery: revenue now, cost out of Goods in Transit. */
export async function acceptDelivery(entityId: string, deliveryId: string, date: string): Promise<ActionResult<SalesContractRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      await requireTrader(entityId);
      dateOf(date);
      await requireOpenPeriod(entityId, date);
      const row = await prisma.$transaction(async (tx) => {
        const delivery = await tx.contractDelivery.findFirst({ where: { id: deliveryId, entityId }, include: { contract: { include: { item: true, buyer: true } } } });
        if (!delivery) throw new StockRefusal('Delivery not found.');
        if (delivery.status !== 'AWAITING_ACCEPTANCE') throw new StockRefusal('This delivery is not awaiting acceptance.');
        const transit = await transitLocation(tx, entityId);
        const grams = toMinor(delivery.grams);
        const cost = toMinor(delivery.costMinor);
        await moveBalance(tx, entityId, delivery.contract.itemId, transit.id, -grams, -cost);
        const names = await namesFor(tx, entityId);
        const foreign = delivery.contract.currency !== (await tx.entity.findUniqueOrThrow({ where: { id: entityId } })).functionalCurrency;
        const salesCode = delivery.contract.saleType === 'EXPORT' ? contractAccounts.exportSales : contractAccounts.domesticSales;
        const journalId = await postContractJournal(tx, entityId, acceptanceJournal(toMinor(delivery.revenueMinor), cost, delivery.contract.saleType === 'EXPORT' ? 'export' : 'domestic', names), date, delivery.contract.contractNo, `Acceptance of delivery ${delivery.deliveryNo} on ${delivery.contract.contractNo} by ${delivery.contract.buyer.name}`, principal, foreign ? { currency: delivery.contract.currency, rate: rateText(delivery.rate) ?? '1.0', txnByCode: { [contractAccounts.receivables]: toMinor(delivery.revenueTxnMinor), [salesCode]: toMinor(delivery.revenueTxnMinor) } } : null);
        await tx.stockMovement.create({ data: { entityId, kind: 'DELIVERY', date: dateOf(date), itemId: delivery.contract.itemId, fromLocationId: transit.id, quantityGrams: fromMinor(-grams), valueMinor: fromMinor(-cost), deliveryId: delivery.id, journalEntryId: journalId, createdById: principal.userId, note: `${delivery.contract.contractNo} delivery ${delivery.deliveryNo} accepted` } });
        await tx.contractDelivery.update({ where: { id: delivery.id }, data: { status: 'ACCEPTED', acceptanceJournalEntryId: journalId, acceptedAt: new Date(), acceptedById: principal.userId } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'delivery', resourceRef: `${delivery.contract.contractNo}/${delivery.deliveryNo}`, summary: `Delivery ${delivery.deliveryNo} on ${delivery.contract.contractNo} accepted: revenue ${(toMinor(delivery.revenueMinor) / 100).toFixed(2)} recognised`, metadata: { journalEntryId: journalId } }, tx);
        return tx.salesContract.findUniqueOrThrow({ where: { id: delivery.contractId }, include: contractInclude });
      });
      refresh();
      return { ok: true, value: contractRecord(row) };
    }),
  );
}

// --- LBC mode -------------------------------------------------------------------------------------------

export type LbcSettingsInput = {
  lbcMode: boolean;
  /** Gross or net: the principal-versus-agent judgement, made by a person. */
  revenuePresentation: 'gross' | 'net';
  producerPriceMinorPerKg: number | null;
  buyerMarginMinorPerKg: number | null;
  haulageMinorPerKg: number | null;
};

export async function setLbcSettings(entityId: string, input: LbcSettingsInput): Promise<ActionResult<EntityRecord>> {
  return withEntityAccess(entityId, 'entity:configure', (principal) =>
    refusable(async () => {
      const entity = await requireTrader(entityId);
      for (const [label, value] of [['producer price', input.producerPriceMinorPerKg], ["buyer's margin", input.buyerMarginMinorPerKg], ['haulage allowance', input.haulageMinorPerKg]] as const) {
        if (value !== null && (!Number.isInteger(value) || value < 0)) return fail(`The ${label} per kg must be a non-negative amount.`);
      }
      const updated = await prisma.$transaction(async (tx) => {
        await seedChartForEntity(tx, entityId, entityTypeOf(entity.type));
        const row = await tx.entity.update({
          where: { id: entityId },
          data: { lbcMode: input.lbcMode, revenuePresentation: input.revenuePresentation === 'net' ? 'NET' : 'GROSS', producerPriceMinorPerKg: input.producerPriceMinorPerKg === null ? null : fromMinor(input.producerPriceMinorPerKg), buyerMarginMinorPerKg: input.buyerMarginMinorPerKg === null ? null : fromMinor(input.buyerMarginMinorPerKg), haulageMinorPerKg: input.haulageMinorPerKg === null ? null : fromMinor(input.haulageMinorPerKg) },
        });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'entity', resourceRef: entityId, summary: `LBC mode ${input.lbcMode ? 'on' : 'off'}, ${input.revenuePresentation} revenue presentation, producer price ${input.producerPriceMinorPerKg === null ? '—' : (input.producerPriceMinorPerKg / 100).toFixed(2)}/kg, margin ${input.buyerMarginMinorPerKg === null ? '—' : (input.buyerMarginMinorPerKg / 100).toFixed(2)}/kg, haulage ${input.haulageMinorPerKg === null ? '—' : (input.haulageMinorPerKg / 100).toFixed(2)}/kg`, metadata: { previous: { lbcMode: entity.lbcMode, revenuePresentation: entity.revenuePresentation } } }, tx);
        return row;
      });
      refresh();
      return { ok: true, value: entityRecord(updated) };
    }),
  );
}

export type SeedFundInput = { kind: SeedFundKind; date: string; amountMinor: number; bankAccountId?: string | null; note?: string };

/** Seed funds from COCOBOD: received (liability), repaid, or offset against what CMC owes for cocoa delivered. */
export async function recordSeedFund(entityId: string, input: SeedFundInput): Promise<ActionResult<SeedFundRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const entity = await requireTrader(entityId);
      if (!entity.lbcMode) return fail('Seed funds are recorded in LBC mode only.');
      if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) return fail('Enter the amount.');
      dateOf(input.date);
      await requireOpenPeriod(entityId, input.date);
      const row = await prisma.$transaction(async (tx) => {
        let bankCode: string | null = null;
        let bankId: string | null = null;
        if (input.kind !== 'offset') {
          const bank = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId ?? '', entityId, isActive: true }, include: { account: true } });
          if (!bank) throw new StockRefusal('Choose the bank account.');
          bankCode = bank.account.code;
          bankId = bank.id;
        }
        const names = await namesFor(tx, entityId);
        const journalId = await postContractJournal(tx, entityId, seedFundJournal(input.kind, input.amountMinor, bankCode, names), input.date, 'SEED FUND', `Seed fund ${input.kind}${input.note ? ` — ${input.note.trim()}` : ''}`, principal, null);
        const created = await tx.seedFundMovement.create({ data: { entityId, kind: input.kind === 'received' ? 'RECEIVED' : input.kind === 'repaid' ? 'REPAID' : 'OFFSET', date: dateOf(input.date), amountMinor: fromMinor(input.amountMinor), bankAccountId: bankId, journalEntryId: journalId, note: input.note?.trim() || null, createdById: principal.userId }, include: seedFundInclude });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'seed-fund', resourceRef: created.id, summary: `Seed fund ${input.kind}: ${(input.amountMinor / 100).toFixed(2)}${input.kind === 'offset' ? ' offset against COCOBOD receivable' : ''}`, metadata: { journalEntryId: journalId } }, tx);
        return created;
      });
      refresh();
      return { ok: true, value: seedFundRecord(row) };
    }),
  );
}

/** CMC pays for cocoa delivered: bank in, COCOBOD receivable down. */
export async function recordCmcReceipt(entityId: string, input: { date: string; amountMinor: number; bankAccountId: string }): Promise<ActionResult<{ journalEntryId: string | null }>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const entity = await requireTrader(entityId);
      if (!entity.lbcMode) return fail('CMC receipts are recorded in LBC mode only.');
      if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) return fail('Enter the amount.');
      dateOf(input.date);
      await requireOpenPeriod(entityId, input.date);
      const journalId = await prisma.$transaction(async (tx) => {
        const bank = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, entityId, isActive: true }, include: { account: true } });
        if (!bank) throw new StockRefusal('Choose the bank account.');
        const names = await namesFor(tx, entityId);
        const id = await postContractJournal(tx, entityId, cmcReceiptJournal(input.amountMinor, bank.account.code, names), input.date, 'CMC', 'Payment from COCOBOD (CMC) for cocoa delivered', principal, null);
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'cmc-receipt', resourceRef: id ?? '', summary: `CMC paid ${(input.amountMinor / 100).toFixed(2)} into ${bank.name}`, metadata: { journalEntryId: id } }, tx);
        return id;
      });
      refresh();
      return { ok: true, value: { journalEntryId: journalId } };
    }),
  );
}
