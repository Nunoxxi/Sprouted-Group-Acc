'use server';

/**
 * Server Functions for the fixed asset register and the tax computation:
 * assets, the monthly depreciation run, disposals, the capital allowance
 * classes, the tax years with their rates, adjustments and incentives, and
 * the quarterly provisional payments.
 *
 * Same contract as documents.ts: authorize first through src/lib/dal.ts,
 * scope every query by entity, and write each change with its journal and
 * audit event in one transaction.
 *
 * Every rate here — depreciation, capital allowance class, tax — comes from
 * what a person entered. Nothing about Ghana's classes or rates is decided in
 * code, because a number baked in is a number nobody can correct when the
 * budget moves it.
 */

import { refresh } from 'next/cache';
import { Prisma } from '@prisma/client';

import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess } from '@/lib/dal';
import { adjustmentToPrisma, allowanceClassRecord, assetInclude, assetRecord, methodToPrisma, readAsset, readTaxYear, runInclude, runRecord } from '@/lib/data/assets';
import { entityRecord } from '@/lib/data/mappers';
import { fromMinor, toMinor } from '@/lib/data/money';
import { StockRefusal } from '@/lib/data/stock';
import type { AllowanceClassRecord, DepreciationRunRecord, EntityRecord, FixedAssetRecord, TaxYearRecord } from '@/lib/data/types';
import { periodOf } from '@/lib/documents';
import {
  adjustmentKinds,
  assetAccounts,
  depreciationFor,
  depreciationJournal,
  depreciationMethods,
  disposalJournal,
  disposalResult,
  isTaxed,
  monthOf,
  provisionalPaymentJournal,
  reducingMonthlyRate,
  taxChargeJournal,
  taxStatuses,
  type AdjustmentKind,
  type DepreciationMethod,
  type TaxStatus,
} from '@/lib/assets';
import type { TradingJournalLine } from '@/lib/trading';
import { prisma } from '@/lib/prisma';

import { computationFor, type Worksheet } from '@/lib/data/tax';

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

async function requireOpenPeriod(tx: Tx, entityId: string, date: string) {
  const period = periodOf(date);
  if (await tx.taxPeriodFiling.findUnique({ where: { entityId_period: { entityId, period } } })) {
    throw new StockRefusal(`Period ${period} has been filed. Date this in an open period.`);
  }
}

async function namesFor(tx: Tx, entityId: string): Promise<Record<string, string>> {
  return Object.fromEntries((await tx.account.findMany({ where: { entityId }, select: { code: true, name: true } })).map((a) => [a.code, a.name]));
}

/** The depreciation expense account of this chart, found by category. */
async function depreciationCode(tx: Tx, entityId: string): Promise<string> {
  const account = await tx.account.findFirst({ where: { entityId, category: assetAccounts.depreciationCategory, isActive: true }, select: { code: true } });
  if (!account) throw new StockRefusal("This entity's chart has no depreciation account. Re-run the seed to add one.");
  return account.code;
}

/** An ASSET journal in the functional currency. Null when there is nothing to post. */
async function postJournal(tx: Tx, entityId: string, lines: TradingJournalLine[], date: string, reference: string, description: string, principal: Principal): Promise<string | null> {
  if (lines.length === 0) return null;
  const debits = lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amount, 0);
  const credits = lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amount, 0);
  if (debits !== credits) throw new Error('Asset journal does not balance; refusing to post');
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

// --- the entity's tax status -------------------------------------------------------------------

/**
 * Whether an entity has a computation at all. Sprouted Roots may be exempt;
 * marking it so hides the computation rather than showing a nil one, which
 * would only invite someone to fill it in.
 */
export async function setEntityTaxStatus(entityId: string, status: TaxStatus): Promise<ActionResult<EntityRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      if (!taxStatuses.includes(status)) return fail('Unknown tax status.');
      const row = await prisma.$transaction(async (tx) => {
        const entity = await tx.entity.update({
          where: { id: entityId },
          data: { taxStatus: status === 'exempt' ? 'EXEMPT' : status === 'special-rate' ? 'SPECIAL_RATE' : 'TAXABLE' },
        });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'entity', resourceRef: entityId, summary: `${entity.name} marked ${status === 'exempt' ? 'exempt from company tax' : status === 'special-rate' ? 'taxed at its own rate' : 'taxable at the standard rate'}` }, tx);
        return entity;
      });
      refresh();
      return { ok: true, value: entityRecord(row) };
    }),
  );
}

// --- the register ------------------------------------------------------------------------------

export type AssetInput = {
  id?: string;
  code: string;
  description: string;
  category?: string;
  purchaseDate: string;
  inServiceDate?: string;
  costMinor: number;
  residualMinor?: number;
  usefulLifeMonths: number;
  method: DepreciationMethod;
  supplierContactId?: string | null;
  location?: string;
  custodian?: string;
  serialNumber?: string;
  allowanceClassId?: string | null;
  openingAccumulated?: number;
  note?: string;
};

/**
 * Add or edit an asset. Buying it is an ordinary bill — this records what the
 * register needs to know about it afterwards: how it is written down, who has
 * it, and which capital allowance pool it belongs to for tax.
 */
export async function saveAsset(entityId: string, input: AssetInput): Promise<ActionResult<FixedAssetRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const code = String(input.code ?? '').trim().toUpperCase();
      const description = String(input.description ?? '').trim();
      if (!code) return fail('Give the asset a reference.');
      if (!description) return fail('Say what the asset is.');
      if (!depreciationMethods.includes(input.method)) return fail('Choose how it is depreciated.');
      const costMinor = Math.round(Number(input.costMinor));
      const residualMinor = Math.round(Number(input.residualMinor ?? 0));
      const usefulLifeMonths = Math.round(Number(input.usefulLifeMonths));
      if (!(costMinor > 0)) return fail('The cost must be more than zero.');
      if (!(residualMinor >= 0)) return fail('The residual value cannot be negative.');
      if (residualMinor >= costMinor) return fail('The residual value has to be less than the cost, or there is nothing to depreciate.');
      if (!(usefulLifeMonths > 0)) return fail('Give a useful life in months.');
      if (input.method === 'reducing-balance' && reducingMonthlyRate({ costMinor, residualMinor, usefulLifeMonths }) === null) {
        return fail('Reducing balance never reaches nil, so it needs a residual value above zero. Use straight line, or give it one.');
      }
      const inServiceDate = input.inServiceDate || input.purchaseDate;
      if (inServiceDate < input.purchaseDate) return fail('It cannot go into service before it was bought.');

      const row = await prisma.$transaction(async (tx) => {
        const clash = await tx.fixedAsset.findFirst({ where: { entityId, code, ...(input.id ? { NOT: { id: input.id } } : {}) }, select: { id: true } });
        if (clash) throw new StockRefusal(`${code} is already the reference of another asset.`);
        if (input.supplierContactId && !(await tx.contact.findUnique({ where: { id: input.supplierContactId }, select: { id: true } }))) throw new StockRefusal('Unknown supplier.');
        if (input.allowanceClassId && !(await tx.capitalAllowanceClass.findFirst({ where: { id: input.allowanceClassId, entityId }, select: { id: true } }))) {
          throw new StockRefusal('That capital allowance class does not belong to this entity.');
        }
        const existing = input.id ? await tx.fixedAsset.findFirst({ where: { id: input.id, entityId } }) : null;
        if (input.id && !existing) throw new StockRefusal('That asset no longer exists.');
        if (existing?.status === 'DISPOSED') throw new StockRefusal('That asset has been disposed of; its record is history now.');
        // Changing the terms of an asset that has already been depreciated
        // would rewrite what was posted, so it is refused.
        if (existing) {
          const posted = await tx.depreciationLine.count({ where: { assetId: existing.id } });
          const changedTerms = toMinor(existing.costMinor) !== costMinor || toMinor(existing.residualMinor) !== residualMinor || existing.usefulLifeMonths !== usefulLifeMonths || existing.method !== methodToPrisma[input.method];
          if (posted > 0 && changedTerms) throw new StockRefusal('Depreciation has already been posted on this asset, so its cost, life, residual and method are fixed. Dispose of it and record the replacement if the terms really changed.');
        }

        const data = {
          code,
          description,
          category: input.category?.trim() || null,
          purchaseDate: dateOf(input.purchaseDate),
          inServiceDate: dateOf(inServiceDate),
          costMinor: fromMinor(costMinor),
          residualMinor: fromMinor(residualMinor),
          usefulLifeMonths,
          method: methodToPrisma[input.method],
          supplierContactId: input.supplierContactId || null,
          location: input.location?.trim() || null,
          custodian: input.custodian?.trim() || null,
          serialNumber: input.serialNumber?.trim() || null,
          allowanceClassId: input.allowanceClassId || null,
          openingAccumulated: fromMinor(Math.max(Math.round(Number(input.openingAccumulated ?? 0)), 0)),
          note: input.note?.trim() || null,
        };
        const saved = existing
          ? await tx.fixedAsset.update({ where: { id: existing.id }, data, include: assetInclude })
          : await tx.fixedAsset.create({ data: { entityId, ...data, createdById: principal.userId }, include: assetInclude });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'fixed-asset', resourceRef: code, summary: `Asset ${existing ? 'updated' : 'added'}: ${code} ${description}, ${(costMinor / 100).toFixed(2)} over ${usefulLifeMonths} months${data.custodian ? `, with ${data.custodian}` : ''}` },
          tx,
        );
        return saved;
      });
      refresh();
      return { ok: true, value: assetRecord(row) };
    }),
  );
}

// --- the monthly run ----------------------------------------------------------------------------

/**
 * Depreciate everything for one month and post it as a single journal. The
 * month is claimed by a unique key, so running it twice cannot charge twice —
 * the second attempt is refused, not quietly ignored.
 */
export async function runDepreciation(entityId: string, period: string): Promise<ActionResult<DepreciationRunRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      if (!/^\d{4}-\d{2}$/.test(period)) return fail('The month must be YYYY-MM.');
      const lastDay = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);

      const row = await prisma.$transaction(async (tx) => {
        if (await tx.depreciationRun.findUnique({ where: { entityId_period: { entityId, period } } })) {
          throw new StockRefusal(`${period} has already been depreciated.`);
        }
        await requireOpenPeriod(tx, entityId, lastDay);

        const assets = await tx.fixedAsset.findMany({ where: { entityId, status: 'IN_USE' }, include: { depreciation: { select: { amountMinor: true } } } });
        const charges: { assetId: string; amountMinor: number }[] = [];
        for (const asset of assets) {
          // An asset disposed of part way through is not depreciated again.
          const accumulated = toMinor(asset.openingAccumulated) + asset.depreciation.reduce((total, line) => total + toMinor(line.amountMinor), 0);
          const amountMinor = depreciationFor(
            {
              costMinor: toMinor(asset.costMinor),
              residualMinor: toMinor(asset.residualMinor),
              usefulLifeMonths: asset.usefulLifeMonths,
              method: asset.method === 'REDUCING_BALANCE' ? 'reducing-balance' : 'straight-line',
              inServiceMonth: monthOf(asset.inServiceDate.toISOString()),
            },
            period,
            accumulated,
          );
          if (amountMinor > 0) charges.push({ assetId: asset.id, amountMinor });
        }
        const totalMinor = charges.reduce((total, charge) => total + charge.amountMinor, 0);
        if (totalMinor === 0) throw new StockRefusal(`Nothing to depreciate in ${period}: no asset was in service with life left.`);

        const names = await namesFor(tx, entityId);
        const journalId = await postJournal(tx, entityId, depreciationJournal(totalMinor, await depreciationCode(tx, entityId), names), lastDay, `DEP ${period}`, `Depreciation for ${period}`, principal);
        const run = await tx.depreciationRun.create({
          data: {
            entityId,
            period,
            totalMinor: fromMinor(totalMinor),
            journalEntryId: journalId,
            postedById: principal.userId,
            lines: { create: charges.map((charge) => ({ entityId, assetId: charge.assetId, amountMinor: fromMinor(charge.amountMinor) })) },
          },
          include: runInclude,
        });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'depreciation-run', resourceRef: period, summary: `Depreciation for ${period}: ${(totalMinor / 100).toFixed(2)} across ${charges.length} asset${charges.length === 1 ? '' : 's'}`, metadata: { journalEntryId: journalId, totalMinor } },
          tx,
        );
        return run;
      });
      refresh();
      return { ok: true, value: runRecord(row) };
    }),
  );
}

// --- disposal -----------------------------------------------------------------------------------

export type DisposalInput = { assetId: string; date: string; proceedsMinor: number; bankAccountId?: string | null; note?: string };

/**
 * Sell or scrap an asset. Its cost and accumulated depreciation both leave
 * the books and whatever is left over is the gain or loss, fixed here at what
 * the books said on the day.
 */
export async function disposeAsset(entityId: string, input: DisposalInput): Promise<ActionResult<FixedAssetRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const proceedsMinor = Math.round(Number(input.proceedsMinor ?? 0));
      if (!(proceedsMinor >= 0)) return fail('Proceeds cannot be negative.');
      if (proceedsMinor > 0 && !input.bankAccountId) return fail('Say which account the money came into.');

      await prisma.$transaction(async (tx) => {
        const asset = await tx.fixedAsset.findFirst({ where: { id: input.assetId, entityId }, include: { depreciation: { select: { amountMinor: true } } } });
        if (!asset) throw new StockRefusal('Unknown asset.');
        if (asset.status === 'DISPOSED') throw new StockRefusal(`${asset.code} has already been disposed of.`);
        if (input.date < asset.purchaseDate.toISOString().slice(0, 10)) throw new StockRefusal('It cannot be disposed of before it was bought.');
        await requireOpenPeriod(tx, entityId, input.date);

        const costMinor = toMinor(asset.costMinor);
        const accumulatedMinor = toMinor(asset.openingAccumulated) + asset.depreciation.reduce((total, line) => total + toMinor(line.amountMinor), 0);
        const result = disposalResult({ costMinor, accumulatedMinor, proceedsMinor });

        let bankCode = '';
        if (input.bankAccountId) {
          const bank = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, entityId, isActive: true }, include: { account: { select: { code: true } } } });
          if (!bank) throw new StockRefusal('Unknown bank account for this entity.');
          bankCode = bank.account.code;
        }
        const names = await namesFor(tx, entityId);
        const journalId = await postJournal(
          tx,
          entityId,
          disposalJournal({ costMinor, accumulatedMinor, proceedsMinor }, bankCode, names),
          input.date,
          asset.code,
          `Disposal of ${asset.code} ${asset.description}`,
          principal,
        );
        await tx.assetDisposal.create({
          data: {
            entityId,
            assetId: asset.id,
            date: dateOf(input.date),
            proceedsMinor: fromMinor(proceedsMinor),
            bankAccountId: input.bankAccountId || null,
            bookValueMinor: fromMinor(result.bookValueMinor),
            gainLossMinor: fromMinor(result.gainLossMinor),
            note: input.note?.trim() || null,
            journalEntryId: journalId,
            createdById: principal.userId,
          },
        });
        await tx.fixedAsset.update({ where: { id: asset.id }, data: { status: 'DISPOSED' } });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'asset-disposal', resourceRef: asset.code, summary: `${asset.code} disposed of for ${(proceedsMinor / 100).toFixed(2)} against a book value of ${(result.bookValueMinor / 100).toFixed(2)}: ${result.gainLossMinor >= 0 ? 'gain' : 'loss'} of ${(Math.abs(result.gainLossMinor) / 100).toFixed(2)}`, metadata: { journalEntryId: journalId, gainLossMinor: result.gainLossMinor } },
          tx,
        );
      });
      refresh();
      return { ok: true, value: await readAsset(entityId, input.assetId) };
    }),
  );
}

// --- capital allowance classes --------------------------------------------------------------------

export type AllowanceClassInput = { id?: string; code: string; name: string; ratePct: string; method: DepreciationMethod; note?: string; isActive?: boolean };

/**
 * A capital allowance class and its rate, exactly as the person enters them.
 * Ghana's classes and rates are theirs to keep current; nothing here assumes
 * what they are.
 */
export async function saveAllowanceClass(entityId: string, input: AllowanceClassInput): Promise<ActionResult<AllowanceClassRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const code = String(input.code ?? '').trim();
      const name = String(input.name ?? '').trim();
      if (!code || !name) return fail('Give the class a code and a name.');
      if (!depreciationMethods.includes(input.method)) return fail('Choose how the class is written down.');
      const rate = Number(input.ratePct);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) return fail('The rate is a percentage between 0 and 100.');

      const row = await prisma.$transaction(async (tx) => {
        const clash = await tx.capitalAllowanceClass.findFirst({ where: { entityId, code, ...(input.id ? { NOT: { id: input.id } } : {}) }, select: { id: true } });
        if (clash) throw new StockRefusal(`Class ${code} already exists.`);
        if (input.id && !(await tx.capitalAllowanceClass.findFirst({ where: { id: input.id, entityId }, select: { id: true } }))) throw new StockRefusal('That class no longer exists.');
        const data = { code, name, ratePct: new Prisma.Decimal(input.ratePct), method: methodToPrisma[input.method], note: input.note?.trim() || null, isActive: input.isActive ?? true };
        const saved = input.id ? await tx.capitalAllowanceClass.update({ where: { id: input.id }, data }) : await tx.capitalAllowanceClass.create({ data: { entityId, ...data } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'allowance-class', resourceRef: code, summary: `Capital allowance class ${input.id ? 'updated' : 'added'}: ${code} ${name} at ${input.ratePct}% ${input.method === 'reducing-balance' ? 'reducing balance' : 'straight line'}` }, tx);
        return saved;
      });
      refresh();
      return { ok: true, value: allowanceClassRecord(row) };
    }),
  );
}

export async function removeAllowanceClass(entityId: string, classId: string): Promise<ActionResult<{ id: string }>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      await prisma.$transaction(async (tx) => {
        const klass = await tx.capitalAllowanceClass.findFirst({ where: { id: classId, entityId } });
        if (!klass) throw new StockRefusal('Unknown class.');
        const assets = await tx.fixedAsset.count({ where: { allowanceClassId: klass.id } });
        if (assets > 0) throw new StockRefusal(`${assets} asset${assets === 1 ? ' is' : 's are'} in this class. Move them first, or make it inactive instead.`);
        await tx.taxYearPool.deleteMany({ where: { classId: klass.id } });
        await tx.capitalAllowanceClass.delete({ where: { id: klass.id } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'allowance-class', resourceRef: klass.code, summary: `Capital allowance class removed: ${klass.code} ${klass.name}` }, tx);
      });
      refresh();
      return { ok: true, value: { id: classId } };
    }),
  );
}

// --- the tax year ------------------------------------------------------------------------------------

export type TaxYearInput = {
  id?: string;
  label: string;
  startDate: string;
  endDate: string;
  ratePct: string;
  lossBroughtForwardMinor?: number;
  estimatedLiabilityMinor?: number;
  note?: string;
  /** Written-down value brought into the year, per class. */
  pools?: Record<string, number>;
};

/** A year of tax with its rate — a setting on the year, so a change of rate applies where it should. */
export async function saveTaxYear(entityId: string, input: TaxYearInput): Promise<ActionResult<TaxYearRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId }, select: { name: true, taxStatus: true } });
      if (!isTaxed(entity.taxStatus === 'EXEMPT' ? 'exempt' : 'taxable')) return fail(`${entity.name} is marked exempt from company tax, so it has no computation.`);
      const label = String(input.label ?? '').trim();
      if (!label) return fail('Give the year a label.');
      if (input.endDate < input.startDate) return fail('The year cannot end before it starts.');
      const rate = Number(input.ratePct);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) return fail('The tax rate is a percentage between 0 and 100.');

      const id = await prisma.$transaction(async (tx) => {
        const clash = await tx.taxYear.findFirst({ where: { entityId, label, ...(input.id ? { NOT: { id: input.id } } : {}) }, select: { id: true } });
        if (clash) throw new StockRefusal(`${label} is already a tax year here.`);
        const existing = input.id ? await tx.taxYear.findFirst({ where: { id: input.id, entityId } }) : null;
        if (input.id && !existing) throw new StockRefusal('That tax year no longer exists.');
        if (existing?.postedAt) throw new StockRefusal(`${existing.label} has been posted. Its figures are fixed; correct it with a journal.`);

        const data = {
          label,
          startDate: dateOf(input.startDate),
          endDate: dateOf(input.endDate),
          ratePct: new Prisma.Decimal(input.ratePct),
          lossBroughtForwardMinor: fromMinor(Math.max(Math.round(Number(input.lossBroughtForwardMinor ?? 0)), 0)),
          estimatedLiabilityMinor: fromMinor(Math.max(Math.round(Number(input.estimatedLiabilityMinor ?? 0)), 0)),
          note: input.note?.trim() || null,
        };
        const saved = existing ? await tx.taxYear.update({ where: { id: existing.id }, data }) : await tx.taxYear.create({ data: { entityId, ...data, createdById: principal.userId } });

        if (input.pools) {
          await tx.taxYearPool.deleteMany({ where: { taxYearId: saved.id } });
          for (const [classId, openingMinor] of Object.entries(input.pools)) {
            if (!(await tx.capitalAllowanceClass.findFirst({ where: { id: classId, entityId }, select: { id: true } }))) throw new StockRefusal('A pool names a class that does not belong to this entity.');
            await tx.taxYearPool.create({ data: { entityId, taxYearId: saved.id, classId, openingMinor: fromMinor(Math.round(Number(openingMinor))) } });
          }
        }
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'tax-year', resourceRef: label, summary: `Tax year ${existing ? 'updated' : 'added'}: ${label}, ${input.startDate} to ${input.endDate} at ${input.ratePct}%` }, tx);
        return saved.id;
      });
      refresh();
      return { ok: true, value: await readTaxYear(entityId, id) };
    }),
  );
}

export type AdjustmentInput = { taxYearId: string; kind: AdjustmentKind; description: string; amountMinor: number; note?: string };

/** An add-back, a deduction or an incentive, with the reason it is there. */
export async function saveTaxAdjustment(entityId: string, input: AdjustmentInput): Promise<ActionResult<TaxYearRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const description = String(input.description ?? '').trim();
      if (!description) return fail('Say what the adjustment is for.');
      if (!adjustmentKinds.includes(input.kind)) return fail('Choose what kind of adjustment it is.');
      const amountMinor = Math.round(Number(input.amountMinor));
      if (!(amountMinor > 0)) return fail('The amount must be more than zero.');

      await prisma.$transaction(async (tx) => {
        const year = await tx.taxYear.findFirst({ where: { id: input.taxYearId, entityId }, select: { id: true, label: true, postedAt: true } });
        if (!year) throw new StockRefusal('Unknown tax year.');
        if (year.postedAt) throw new StockRefusal(`${year.label} has been posted; its figures are fixed.`);
        await tx.taxAdjustment.create({ data: { entityId, taxYearId: year.id, kind: adjustmentToPrisma[input.kind], description, amountMinor: fromMinor(amountMinor), note: input.note?.trim() || null } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'tax-adjustment', resourceRef: year.label, summary: `${input.kind === 'add-back' ? 'Add-back' : input.kind === 'deduction' ? 'Deduction' : 'Incentive'} on ${year.label}: ${description} ${(amountMinor / 100).toFixed(2)}` }, tx);
      });
      refresh();
      return { ok: true, value: await readTaxYear(entityId, input.taxYearId) };
    }),
  );
}

export async function removeTaxAdjustment(entityId: string, adjustmentId: string): Promise<ActionResult<TaxYearRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const taxYearId = await prisma.$transaction(async (tx) => {
        const adjustment = await tx.taxAdjustment.findFirst({ where: { id: adjustmentId, entityId }, include: { taxYear: { select: { id: true, label: true, postedAt: true } } } });
        if (!adjustment) throw new StockRefusal('Unknown adjustment.');
        if (adjustment.taxYear.postedAt) throw new StockRefusal(`${adjustment.taxYear.label} has been posted; its figures are fixed.`);
        await tx.taxAdjustment.delete({ where: { id: adjustment.id } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'tax-adjustment', resourceRef: adjustment.taxYear.label, summary: `Adjustment removed from ${adjustment.taxYear.label}: ${adjustment.description}` }, tx);
        return adjustment.taxYear.id;
      });
      refresh();
      return { ok: true, value: await readTaxYear(entityId, taxYearId) };
    }),
  );
}

/**
 * Post the year's charge: an expense and a liability. The figure comes from
 * the caller because the computation is worked out on the screen from the
 * ledger, the register and the settings — but it is checked here against a
 * recomputation before anything is written, so a stale screen cannot post a
 * stale number.
 */
export async function postTaxCharge(entityId: string, taxYearId: string, expectedChargeMinor: number): Promise<ActionResult<TaxYearRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const computed = await computationFor(entityId, taxYearId);
      if (computed.taxChargeMinor !== Math.round(Number(expectedChargeMinor))) {
        return fail(`The computation now comes to ${(computed.taxChargeMinor / 100).toFixed(2)}, not ${(Number(expectedChargeMinor) / 100).toFixed(2)}. Something changed while the screen was open — look again before posting.`);
      }

      await prisma.$transaction(async (tx) => {
        const year = await tx.taxYear.findFirst({ where: { id: taxYearId, entityId } });
        if (!year) throw new StockRefusal('Unknown tax year.');
        if (year.postedAt) throw new StockRefusal(`${year.label} has already been posted.`);
        const endDate = year.endDate.toISOString().slice(0, 10);
        await requireOpenPeriod(tx, entityId, endDate);
        const names = await namesFor(tx, entityId);
        const journalId = await postJournal(tx, entityId, taxChargeJournal(computed.taxChargeMinor, names), endDate, year.label, `Company tax for ${year.label}`, principal);
        await tx.taxYear.update({ where: { id: year.id }, data: { taxChargeMinor: fromMinor(computed.taxChargeMinor), chargeJournalEntryId: journalId, postedAt: new Date() } });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'tax-year', resourceRef: year.label, summary: `Company tax for ${year.label} posted: ${(computed.taxChargeMinor / 100).toFixed(2)} on chargeable income of ${(computed.chargeableIncomeMinor / 100).toFixed(2)}`, metadata: { journalEntryId: journalId, taxChargeMinor: computed.taxChargeMinor } },
          tx,
        );
      });
      refresh();
      return { ok: true, value: await readTaxYear(entityId, taxYearId) };
    }),
  );
}

// --- provisional tax ------------------------------------------------------------------------------------

export type ProvisionalInput = { taxYearId: string; quarter: number; date: string; amountMinor: number; bankAccountId: string; reference?: string };

/** A quarterly instalment paid against the estimate. */
export async function recordProvisionalPayment(entityId: string, input: ProvisionalInput): Promise<ActionResult<TaxYearRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const quarter = Math.round(Number(input.quarter));
      if (![1, 2, 3, 4].includes(quarter)) return fail('The quarter is 1, 2, 3 or 4.');
      const amountMinor = Math.round(Number(input.amountMinor));
      if (!(amountMinor > 0)) return fail('The payment must be more than zero.');

      await prisma.$transaction(async (tx) => {
        const year = await tx.taxYear.findFirst({ where: { id: input.taxYearId, entityId }, select: { id: true, label: true } });
        if (!year) throw new StockRefusal('Unknown tax year.');
        await requireOpenPeriod(tx, entityId, input.date);
        const bank = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, entityId, isActive: true }, include: { account: { select: { code: true } } } });
        if (!bank) throw new StockRefusal('Unknown bank account for this entity.');
        const names = await namesFor(tx, entityId);
        const journalId = await postJournal(tx, entityId, provisionalPaymentJournal(amountMinor, bank.account.code, names), input.date, year.label, `Provisional tax, quarter ${quarter} of ${year.label}`, principal);
        await tx.provisionalTaxPayment.create({
          data: { entityId, taxYearId: year.id, quarter, date: dateOf(input.date), amountMinor: fromMinor(amountMinor), bankAccountId: bank.id, reference: input.reference?.trim() || null, journalEntryId: journalId, createdById: principal.userId },
        });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'provisional-tax', resourceRef: `${year.label} Q${quarter}`, summary: `Provisional tax paid: ${(amountMinor / 100).toFixed(2)} for quarter ${quarter} of ${year.label} from ${bank.name}`, metadata: { journalEntryId: journalId, amountMinor } },
          tx,
        );
      });
      refresh();
      return { ok: true, value: await readTaxYear(entityId, input.taxYearId) };
    }),
  );
}

// --- the worksheet --------------------------------------------------------------------------------------

/**
 * The whole computation for a year, worked out on the server from the ledger,
 * the register and the settings. The screen shows this rather than computing
 * its own, so what is displayed is what would be posted.
 */
export async function taxWorksheet(entityId: string, taxYearId: string): Promise<ActionResult<Worksheet>> {
  return withEntityAccess(entityId, 'reports:view', () =>
    refusable(async () => {
      const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId }, select: { name: true, taxStatus: true } });
      if (entity.taxStatus === 'EXEMPT') return fail(`${entity.name} is exempt from company tax, so there is no computation.`);
      return { ok: true, value: await computationFor(entityId, taxYearId) };
    }),
  );
}
