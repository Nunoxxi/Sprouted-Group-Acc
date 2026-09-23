'use server';

/**
 * Server Functions for the payroll import. There is no payroll engine here:
 * payroll is run in a Ghanaian payroll system or a spreadsheet, and this
 * takes the summary, reads it against a mapping the app remembers, and posts
 * one journal a month.
 *
 * Casual and seasonal labour paid by a buying agent is not payroll. It goes
 * through the agent float, in src/app/actions/trading.ts, where the money
 * actually left the entity.
 *
 * Same contract as documents.ts: authorize first through src/lib/dal.ts,
 * scope every query by entity, and write each change with its journal and
 * audit event in one transaction.
 */

import { refresh } from 'next/cache';
import { Prisma } from '@prisma/client';

import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess } from '@/lib/dal';
import { allocationInclude, allocationRecord, departmentInclude, departmentRecord, kindToPrisma, mappingInclude, mappingRecord, readRun, runInclude, runRecord } from '@/lib/data/payroll';
import { entityRecord } from '@/lib/data/mappers';
import { fromMinor, toMinor } from '@/lib/data/money';
import { StockRefusal } from '@/lib/data/stock';
import type { EntityRecord, PayrollAllocationRecord, PayrollDepartmentRecord, PayrollMappingRecord, PayrollRunRecord } from '@/lib/data/types';
import { periodOf } from '@/lib/documents';
import {
  allocationTotal,
  liabilitiesFor,
  liabilityKindLabels,
  liabilityPaymentJournal,
  looksLikeCasualLabour,
  parsePayroll,
  payrollJournal,
  totalsOf,
  type Allocation,
  type CostLine,
  type LiabilityKind,
  type PayrollMapping as MappingShape,
} from '@/lib/payroll';
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
 * A PAYROLL journal in the functional currency. Each line carries the grant
 * and budget line it was split to, so staff costs reach budget-against-actual
 * the same way a bill does.
 */
async function postJournal(
  tx: Tx,
  entityId: string,
  lines: { accountCode: string; amount: number; type: 'debit' | 'credit'; grantId?: string | null; budgetLineId?: string | null }[],
  date: string,
  reference: string,
  description: string,
  principal: Principal,
  fundOfGrant: Map<string, string | null>,
): Promise<string | null> {
  if (lines.length === 0) return null;
  const debits = lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amount, 0);
  const credits = lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amount, 0);
  if (debits !== credits) throw new Error('Payroll journal does not balance; refusing to post');
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
          grantId: line.grantId ?? null,
          budgetLineId: line.budgetLineId ?? null,
          // A grant names a fund, so coding to the grant codes to its fund too.
          fundId: line.grantId ? (fundOfGrant.get(line.grantId) ?? null) : null,
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

// --- when things fall due ---------------------------------------------------------------------

/** The days PAYE and SSNIT fall due are settings, because filing dates move. */
export async function setPayrollDueDays(entityId: string, payeDueDay: number, ssnitDueDay: number): Promise<ActionResult<EntityRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const paye = Math.round(Number(payeDueDay));
      const ssnit = Math.round(Number(ssnitDueDay));
      if (!(paye >= 1 && paye <= 31) || !(ssnit >= 1 && ssnit <= 31)) return fail('A due day is between 1 and 31.');
      const row = await prisma.$transaction(async (tx) => {
        const entity = await tx.entity.update({ where: { id: entityId }, data: { payeDueDay: paye, ssnitDueDay: ssnit } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'entity', resourceRef: entityId, summary: `Payroll due days set: PAYE on the ${paye}th, SSNIT on the ${ssnit}th of the following month` }, tx);
        return entity;
      });
      refresh();
      return { ok: true, value: entityRecord(row) };
    }),
  );
}

// --- the mapping ------------------------------------------------------------------------------

export type MappingInput = {
  id?: string;
  name: string;
  employeeRefColumn?: string;
  employeeNameColumn: string;
  departmentColumn?: string;
  grossColumn: string;
  payeColumn?: string;
  employeeSsnitColumn?: string;
  employerSsnitColumn?: string;
  ssnitTier2Column?: string;
  otherDeductionsColumn?: string;
  netColumn?: string;
  defaultAccountCode?: string;
};

/** Match the columns once; the same file shape imports every month after. */
export async function savePayrollMapping(entityId: string, input: MappingInput): Promise<ActionResult<PayrollMappingRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const name = String(input.name ?? '').trim();
      if (!name) return fail('Give the mapping a name.');
      if (!input.employeeNameColumn?.trim()) return fail('Name the column that holds each person.');
      if (!input.grossColumn?.trim()) return fail('Name the column that holds gross pay.');

      const row = await prisma.$transaction(async (tx) => {
        const clash = await tx.payrollMapping.findFirst({ where: { entityId, name, ...(input.id ? { NOT: { id: input.id } } : {}) }, select: { id: true } });
        if (clash) throw new StockRefusal(`${name} is already the name of another mapping.`);
        if (input.id && !(await tx.payrollMapping.findFirst({ where: { id: input.id, entityId }, select: { id: true } }))) throw new StockRefusal('That mapping no longer exists.');
        const account = input.defaultAccountCode ? await tx.account.findFirst({ where: { entityId, code: input.defaultAccountCode, isActive: true }, select: { id: true } }) : null;
        if (input.defaultAccountCode && !account) throw new StockRefusal(`Account ${input.defaultAccountCode} is not in this entity's chart.`);
        const blank = (value?: string) => value?.trim() || null;
        const data = {
          name,
          employeeRefColumn: blank(input.employeeRefColumn),
          employeeNameColumn: input.employeeNameColumn.trim(),
          departmentColumn: blank(input.departmentColumn),
          grossColumn: input.grossColumn.trim(),
          payeColumn: blank(input.payeColumn),
          employeeSsnitColumn: blank(input.employeeSsnitColumn),
          employerSsnitColumn: blank(input.employerSsnitColumn),
          ssnitTier2Column: blank(input.ssnitTier2Column),
          otherDeductionsColumn: blank(input.otherDeductionsColumn),
          netColumn: blank(input.netColumn),
          defaultAccountId: account?.id ?? null,
        };
        const saved = input.id
          ? await tx.payrollMapping.update({ where: { id: input.id }, data, include: mappingInclude })
          : await tx.payrollMapping.create({ data: { entityId, ...data }, include: mappingInclude });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'payroll-mapping', resourceRef: name, summary: `Payroll mapping ${input.id ? 'updated' : 'added'}: ${name}` }, tx);
        return saved;
      });
      refresh();
      return { ok: true, value: mappingRecord(row) };
    }),
  );
}

// --- departments ------------------------------------------------------------------------------------

/** Which account a department's gross pay is charged to. */
export async function savePayrollDepartment(entityId: string, name: string, accountCode: string): Promise<ActionResult<PayrollDepartmentRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const department = String(name ?? '').trim();
      if (!department) return fail('Name the department.');
      const row = await prisma.$transaction(async (tx) => {
        const account = await tx.account.findFirst({ where: { entityId, code: accountCode, isActive: true }, select: { id: true } });
        if (!account) throw new StockRefusal(`Account ${accountCode} is not in this entity's chart.`);
        const saved = await tx.payrollDepartment.upsert({
          where: { entityId_name: { entityId, name: department } },
          create: { entityId, name: department, accountId: account.id },
          update: { accountId: account.id },
          include: departmentInclude,
        });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'payroll-department', resourceRef: department, summary: `Payroll department "${department}" charged to ${accountCode}` }, tx);
        return saved;
      });
      refresh();
      return { ok: true, value: departmentRecord(row) };
    }),
  );
}

// --- splitting a person's cost across grants ------------------------------------------------------------

export type AllocationInput = { employeeKey: string; employeeName?: string; grantId: string; budgetLineId?: string | null; pct: string };

/**
 * How much of one person's cost each grant carries. Kept against the person,
 * so it is set once and applies to every payroll after it. The percentages
 * cannot come to more than a hundred; anything under is core-funded and stays
 * uncoded.
 */
export async function savePayrollAllocation(entityId: string, input: AllocationInput): Promise<ActionResult<PayrollAllocationRecord[]>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const employeeKey = String(input.employeeKey ?? '').trim();
      if (!employeeKey) return fail('Say which person this is for.');
      const pct = Number(input.pct);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return fail('The percentage is between 0 and 100.');

      const rows = await prisma.$transaction(async (tx) => {
        const grant = await tx.grant.findFirst({ where: { id: input.grantId, entityId }, select: { id: true, code: true } });
        if (!grant) throw new StockRefusal('That grant does not belong to this entity.');
        if (input.budgetLineId && !(await tx.grantBudgetLine.findFirst({ where: { id: input.budgetLineId, entityId, grantId: grant.id }, select: { id: true } }))) {
          throw new StockRefusal(`That budget line does not belong to ${grant.code}.`);
        }
        const existing = await tx.payrollAllocation.findMany({ where: { entityId, employeeKey } });
        const others = existing.filter((row) => row.grantId !== grant.id).reduce((total, row) => total + Number(row.pct), 0);
        if (others + pct > 100) throw new StockRefusal(`That would put ${employeeKey} at ${others + pct}% across their grants. The most anyone can be is 100%.`);

        await tx.payrollAllocation.upsert({
          where: { entityId_employeeKey_grantId: { entityId, employeeKey, grantId: grant.id } },
          create: { entityId, employeeKey, employeeName: input.employeeName?.trim() || null, grantId: grant.id, budgetLineId: input.budgetLineId || null, pct: new Prisma.Decimal(input.pct) },
          update: { employeeName: input.employeeName?.trim() || undefined, budgetLineId: input.budgetLineId || null, pct: new Prisma.Decimal(input.pct) },
        });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'payroll-allocation', resourceRef: employeeKey, summary: `${input.employeeName || employeeKey}: ${input.pct}% of their cost to ${grant.code}` }, tx);
        return tx.payrollAllocation.findMany({ where: { entityId, employeeKey }, include: allocationInclude, orderBy: { createdAt: 'asc' } });
      });
      refresh();
      return { ok: true, value: rows.map(allocationRecord) };
    }),
  );
}

export async function removePayrollAllocation(entityId: string, allocationId: string): Promise<ActionResult<{ id: string }>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      await prisma.$transaction(async (tx) => {
        const row = await tx.payrollAllocation.findFirst({ where: { id: allocationId, entityId }, include: { grant: { select: { code: true } } } });
        if (!row) throw new StockRefusal('Unknown allocation.');
        await tx.payrollAllocation.delete({ where: { id: row.id } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'payroll-allocation', resourceRef: row.employeeKey, summary: `${row.employeeName || row.employeeKey} no longer charged to ${row.grant.code}` }, tx);
      });
      refresh();
      return { ok: true, value: { id: allocationId } };
    }),
  );
}

// --- the import ---------------------------------------------------------------------------------------------

export type ImportInput = { period: string; payDate: string; mappingId: string; fileName: string; csv: string };
export type ImportResult = {
  run: PayrollRunRecord;
  errors: { row: number; message: string }[];
  skipped: { row: number; label: string }[];
  unbalanced: { row: number; employeeName: string; expectedMinor: number; statedMinor: number }[];
  /** Departments that look like casual labour, which belongs on the agent float. */
  casualWarnings: string[];
  /** Departments seen for the first time, charged to the mapping's default account. */
  newDepartments: string[];
};

/**
 * Read a month's payroll summary and post it. Gross pay goes to each
 * department's own account, the employer's SSNIT to its own expense, and both
 * are split across grants where that has been set. PAYE, the SSNIT tiers and
 * net pay go up as liabilities with the dates they fall due.
 *
 * A row whose net does not equal gross less its own deductions is reported
 * but still imported: the payroll system is the authority on what somebody is
 * paid, and refusing the whole file over one row helps nobody. What is not
 * allowed is posting a file the app could not read at all.
 */
export async function importPayroll(entityId: string, input: ImportInput): Promise<ActionResult<ImportResult>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      if (!/^\d{4}-\d{2}$/.test(input.period)) return fail('The month must be YYYY-MM.');
      if (!input.csv?.trim()) return fail('The file is empty.');
      if (input.csv.length > 4_000_000) return fail('That file is too large; split it.');

      const mappingRow = await prisma.payrollMapping.findFirst({ where: { id: input.mappingId, entityId }, include: mappingInclude });
      if (!mappingRow) return fail('Choose a mapping for this file.');
      const shape: MappingShape = {
        name: mappingRow.name,
        employeeRefColumn: mappingRow.employeeRefColumn,
        employeeNameColumn: mappingRow.employeeNameColumn,
        departmentColumn: mappingRow.departmentColumn,
        grossColumn: mappingRow.grossColumn,
        payeColumn: mappingRow.payeColumn,
        employeeSsnitColumn: mappingRow.employeeSsnitColumn,
        employerSsnitColumn: mappingRow.employerSsnitColumn,
        ssnitTier2Column: mappingRow.ssnitTier2Column,
        otherDeductionsColumn: mappingRow.otherDeductionsColumn,
        netColumn: mappingRow.netColumn,
      };
      const parsed = parsePayroll(input.csv, shape);
      if (parsed.rows.length === 0) return fail(parsed.errors[0]?.message ?? 'No people in that file.');

      // Every department needs an account. One not seen before is charged to
      // the mapping's default and reported, so nobody has to guess later.
      const departmentNames = [...new Set(parsed.rows.map((row) => row.department.trim()).filter(Boolean))];
      const defaultCode = mappingRow.defaultAccount?.code;
      const [entity, known, anyDepartment, accountRows] = await Promise.all([
        prisma.entity.findUniqueOrThrow({ where: { id: entityId }, select: { payeDueDay: true, ssnitDueDay: true } }),
        prisma.payrollDepartment.findMany({ where: { entityId, name: { in: departmentNames } }, include: departmentInclude }),
        prisma.payrollDepartment.findFirst({ where: { entityId }, include: departmentInclude }),
        prisma.account.findMany({ where: { entityId }, select: { id: true, code: true, name: true } }),
      ]);
      const accountOf = new Map(known.map((row) => [row.name, row.account.code]));
      const names = Object.fromEntries(accountRows.map((account) => [account.code, account.name]));
      const idOfCode = new Map(accountRows.map((account) => [account.code, account.id]));
      const newDepartments = departmentNames.filter((name) => !accountOf.has(name));
      if (newDepartments.length && !defaultCode) {
        return fail(`No account for the department "${newDepartments[0]}". Give the mapping a default account, or set one for this department.`);
      }
      for (const name of newDepartments) accountOf.set(name, defaultCode as string);
      const fallback = defaultCode ?? anyDepartment?.account.code;
      if (!fallback && departmentNames.length === 0) return fail('Give the mapping a default account: the file has no department column.');

      // A person's allocation is looked up by their reference, or their name
      // when the file has none.
      const keys = parsed.rows.map((row) => row.employeeRef || row.employeeName);
      const allocationRows = await prisma.payrollAllocation.findMany({ where: { entityId, employeeKey: { in: keys } } });
      const allocationsOf = new Map<string, Allocation[]>();
      for (const row of allocationRows) {
        const list = allocationsOf.get(row.employeeKey) ?? [];
        list.push({ employeeRef: row.employeeKey, grantId: row.grantId, budgetLineId: row.budgetLineId, pct: row.pct.toString() });
        allocationsOf.set(row.employeeKey, list);
      }

      const costs: CostLine[] = [];
      for (const row of parsed.rows) {
        const code = (row.department.trim() && accountOf.get(row.department.trim())) || fallback || '';
        if (!code) return fail(`No account for ${row.employeeName}. Give the mapping a default account.`);
        costs.push({
          accountCode: code,
          accountName: names[code] ?? 'Staff Salaries',
          grossMinor: row.grossMinor,
          employerSsnitMinor: row.employerSsnitMinor,
          ssnitTier2Minor: row.ssnitTier2Minor,
          allocations: allocationsOf.get(row.employeeRef || row.employeeName) ?? [],
        });
      }

      const grantIds = [...new Set(allocationRows.map((row) => row.grantId))];
      const fundOfGrant = new Map(
        (grantIds.length ? await prisma.grant.findMany({ where: { id: { in: grantIds }, entityId }, select: { id: true, fundId: true } }) : []).map((grant) => [grant.id, grant.fundId]),
      );
      const totals = totalsOf(parsed.rows);

      const result = await prisma.$transaction(async (tx) => {
        // The month is claimed inside the transaction, so two people importing
        // at once cannot both post it.
        if (await tx.payrollRun.findUnique({ where: { entityId_period: { entityId, period: input.period } } })) {
          throw new StockRefusal(`${input.period} has already been imported. Payroll goes in once a month.`);
        }
        await requireOpenPeriod(tx, entityId, input.payDate);
        if (newDepartments.length) {
          const accountId = idOfCode.get(defaultCode as string);
          if (!accountId) throw new StockRefusal(`Account ${defaultCode} is not in this entity's chart.`);
          await tx.payrollDepartment.createMany({ data: newDepartments.map((name) => ({ entityId, name, accountId })), skipDuplicates: true });
        }
        const journalId = await postJournal(
          tx,
          entityId,
          payrollJournal(costs, totals, names),
          input.payDate,
          `PAY ${input.period}`,
          `Payroll for ${input.period}: ${parsed.rows.length} ${parsed.rows.length === 1 ? 'person' : 'people'}`,
          principal,
          fundOfGrant,
        );

        const run = await tx.payrollRun.create({
          data: {
            entityId,
            period: input.period,
            payDate: dateOf(input.payDate),
            mappingId: mappingRow.id,
            fileName: input.fileName.slice(0, 200) || 'payroll.csv',
            grossMinor: fromMinor(totals.grossMinor),
            payeMinor: fromMinor(totals.payeMinor),
            employeeSsnitMinor: fromMinor(totals.employeeSsnitMinor),
            employerSsnitMinor: fromMinor(totals.employerSsnitMinor),
            ssnitTier2Minor: fromMinor(totals.ssnitTier2Minor),
            otherDeductionsMinor: fromMinor(totals.otherDeductionsMinor),
            netMinor: fromMinor(totals.netMinor),
            status: 'POSTED',
            journalEntryId: journalId,
            postedById: principal.userId,
            postedAt: new Date(),
            createdById: principal.userId,
            lines: {
              create: parsed.rows.map((row) => ({
                entityId,
                employeeRef: row.employeeRef || null,
                employeeName: row.employeeName,
                department: row.department || null,
                grossMinor: fromMinor(row.grossMinor),
                payeMinor: fromMinor(row.payeMinor),
                employeeSsnitMinor: fromMinor(row.employeeSsnitMinor),
                employerSsnitMinor: fromMinor(row.employerSsnitMinor),
                ssnitTier2Minor: fromMinor(row.ssnitTier2Minor),
                otherDeductionsMinor: fromMinor(row.otherDeductionsMinor),
                netMinor: fromMinor(row.netMinor),
              })),
            },
            liabilities: {
              create: liabilitiesFor(input.period, input.payDate, totals, { payeDueDay: entity.payeDueDay, ssnitDueDay: entity.ssnitDueDay }).map((liability) => ({
                entityId,
                kind: kindToPrisma[liability.kind],
                amountMinor: fromMinor(liability.amountMinor),
                dueDate: dateOf(liability.dueDate),
              })),
            },
          },
          include: runInclude,
        });

        await recordAuditEvent(
          {
            entityId,
            userId: principal.userId,
            userName: principal.name,
            action: 'POST',
            resourceType: 'payroll-run',
            resourceRef: input.period,
            summary: `Payroll for ${input.period} imported and posted: ${parsed.rows.length} people, gross ${(totals.grossMinor / 100).toFixed(2)}, employer cost ${(totals.employerCostMinor / 100).toFixed(2)}`,
            metadata: { journalEntryId: journalId, fileName: run.fileName, unbalanced: parsed.unbalanced.length },
          },
          tx,
        );

        return {
          run: runRecord(run),
          errors: parsed.errors,
          skipped: parsed.skipped,
          unbalanced: parsed.unbalanced,
          casualWarnings: departmentNames.filter(looksLikeCasualLabour),
          newDepartments,
        };
      }, { timeout: 20_000, maxWait: 10_000 });
      refresh();
      return { ok: true, value: result };
    }),
  );
}

// --- paying what is owed -------------------------------------------------------------------------------------

export type LiabilityPaymentInput = { liabilityId: string; date: string; amountMinor: number; bankAccountId: string; reference?: string };

/** Paying PAYE, SSNIT or the staff: off what is owed, out of the bank. */
export async function payPayrollLiability(entityId: string, input: LiabilityPaymentInput): Promise<ActionResult<PayrollRunRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const amountMinor = Math.round(Number(input.amountMinor));
      if (!(amountMinor > 0)) return fail('The payment must be more than zero.');

      const runId = await prisma.$transaction(async (tx) => {
        const liability = await tx.payrollLiability.findFirst({ where: { id: input.liabilityId, entityId }, include: { run: { select: { id: true, period: true } } } });
        if (!liability) throw new StockRefusal('Unknown payroll liability.');
        const outstanding = toMinor(liability.amountMinor) - toMinor(liability.settledMinor);
        if (amountMinor > outstanding) throw new StockRefusal(`Only ${(outstanding / 100).toFixed(2)} is still owed on that.`);
        await requireOpenPeriod(tx, entityId, input.date);
        const bank = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, entityId, isActive: true }, include: { account: { select: { code: true } } } });
        if (!bank) throw new StockRefusal('Unknown bank account for this entity.');

        const kind = ({ PAYE: 'paye', SSNIT_TIER_1: 'ssnit-tier-1', SSNIT_TIER_2: 'ssnit-tier-2', NET_PAY: 'net-pay', OTHER_DEDUCTIONS: 'other-deductions' } as const)[liability.kind] as LiabilityKind;
        const names = await namesFor(tx, entityId);
        const journalId = await postJournal(
          tx,
          entityId,
          liabilityPaymentJournal(kind, amountMinor, bank.account.code, names),
          input.date,
          `PAY ${liability.run.period}`,
          `${liabilityKindLabels[kind]} for ${liability.run.period} paid from ${bank.name}`,
          principal,
          new Map(),
        );
        await tx.payrollLiabilityPayment.create({
          data: { entityId, liabilityId: liability.id, date: dateOf(input.date), amountMinor: fromMinor(amountMinor), bankAccountId: bank.id, reference: input.reference?.trim() || null, journalEntryId: journalId, createdById: principal.userId },
        });
        await tx.payrollLiability.update({ where: { id: liability.id }, data: { settledMinor: { increment: fromMinor(amountMinor) } } });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'payroll-liability', resourceRef: `${liability.run.period} ${kind}`, summary: `${liabilityKindLabels[kind]} for ${liability.run.period}: ${(amountMinor / 100).toFixed(2)} paid from ${bank.name}`, metadata: { journalEntryId: journalId, amountMinor } },
          tx,
        );
        return liability.run.id;
      });
      refresh();
      return { ok: true, value: await readRun(entityId, runId) };
    }),
  );
}

/** What a person's percentages come to, so the screen can say where they stand. */
export async function payrollAllocationTotal(entityId: string, employeeKey: string): Promise<ActionResult<{ pct: number }>> {
  return withEntityAccess(entityId, 'reports:view', () =>
    refusable(async () => {
      const rows = await prisma.payrollAllocation.findMany({ where: { entityId, employeeKey }, select: { pct: true } });
      return { ok: true, value: { pct: allocationTotal(rows.map((row) => ({ pct: row.pct.toString() }))) } };
    }),
  );
}
