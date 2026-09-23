'use server';

/**
 * Server Functions for editing the chart of accounts.
 *
 * Every one of them is Owner-only, scoped to one entity, and writes an audit
 * event carrying the old value and the new one, because a chart change
 * reaches every report that was ever run.
 *
 * Nothing here touches a posted transaction. The one function that comes
 * close is the merge, which repoints journal lines from one account to
 * another — it changes which account a posting sits on and nothing else: not
 * the date, not the amount, not the journal it belongs to, and not whether
 * that journal balances.
 */

import { refresh } from 'next/cache';
import { Prisma } from '@prisma/client';

import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess } from '@/lib/dal';
import { accountRecord } from '@/lib/data/mappers';
import type { AccountRecord } from '@/lib/data/types';
import {
  canMerge,
  chartToCsv,
  historicEffect,
  mergeEffect,
  parseChartCsv,
  permissionsFor,
  reorderedPositions,
  validateAccount,
  type AccountDraft,
  type AccountFacts,
  type AccountType,
  type EditPermissions,
} from '@/lib/chart-edit';
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

type Tx = Prisma.TransactionClient;

/** Everything pointing at an account other than a posting. */
async function referenceCount(client: Tx | typeof prisma, accountId: string): Promise<number> {
  const [children, bank, items, locations, budgetLines, staffTime, recurring, mappings, departments, documentLines] = await Promise.all([
    client.account.count({ where: { parentId: accountId } }),
    client.bankAccount.count({ where: { accountId } }),
    client.item.count({ where: { accountId } }),
    client.stockLocation.count({ where: { accountId } }),
    client.grantBudgetLine.count({ where: { accountId } }),
    client.staffTimeAllocation.count({ where: { accountId } }),
    client.recurringCost.count({ where: { accountId } }),
    client.payrollMapping.count({ where: { defaultAccountId: accountId } }),
    client.payrollDepartment.count({ where: { accountId } }),
    client.documentLine.count({ where: { accountId } }),
  ]);
  return children + bank + items + locations + budgetLines + staffTime + recurring + mappings + departments + documentLines;
}

async function factsFor(client: Tx | typeof prisma, row: { id: string; code: string; type: string; isActive: boolean }): Promise<AccountFacts> {
  const [postings, references] = await Promise.all([
    client.journalLine.count({ where: { accountId: row.id } }),
    referenceCount(client, row.id),
  ]);
  return { code: row.code, type: row.type as AccountType, postings, references, isActive: row.isActive };
}

// --- reading ------------------------------------------------------------------------------

export type AccountEditState = AccountFacts & { id: string; name: string; permissions: EditPermissions };

/** What the editor needs to know before offering to change an account. */
export async function accountEditState(entityId: string, accountId: string): Promise<ActionResult<AccountEditState>> {
  return withEntityAccess(entityId, 'settings:manage', async () => {
    const row = await prisma.account.findFirst({ where: { id: accountId, entityId }, select: { id: true, code: true, name: true, type: true, isActive: true } });
    if (!row) return fail('That account is not on this entity.');
    const facts = await factsFor(prisma, row);
    return { ok: true, value: { ...facts, id: row.id, name: row.name, permissions: permissionsFor(facts) } };
  });
}

/** The whole chart as CSV, in the order it is shown. */
export async function exportChart(entityId: string): Promise<ActionResult<{ fileName: string; csv: string }>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const rows = await prisma.account.findMany({
      where: { entityId },
      select: { code: true, name: true, type: true, category: true, isActive: true, sortOrder: true, parent: { select: { code: true } } },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
    await recordAuditEvent({
      entityId,
      userId: principal.userId,
      userName: principal.name,
      action: 'BACKUP',
      resourceType: 'chart-of-accounts',
      resourceRef: entityId,
      summary: `Exported the chart of accounts (${rows.length} accounts)`,
      metadata: { accounts: rows.length },
    });
    const csv = chartToCsv(rows.map((row) => ({ ...row, parentCode: row.parent?.code ?? null })));
    return { ok: true, value: { fileName: `chart-of-accounts-${entityId}.csv`, csv } };
  });
}

// --- creating and editing -------------------------------------------------------------------

export type AccountInput = AccountDraft & { id?: string };

/**
 * Create an account, or change one. Returns the warning rather than the saved
 * account when the change reaches history and has not been acknowledged, so
 * nobody reclassifies a closed period by accident.
 */
export async function saveAccount(entityId: string, input: AccountInput, acknowledged = false): Promise<ActionResult<{ account: AccountRecord; warning?: string }>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const chart = await prisma.account.findMany({ where: { entityId }, select: { id: true, code: true, type: true, parent: { select: { code: true } } } });
    const existing = chart.map((row) => ({ code: row.code, type: row.type as AccountType, parentCode: row.parent?.code ?? null }));

    const current = input.id
      ? await prisma.account.findFirst({ where: { id: input.id, entityId }, select: { id: true, code: true, name: true, type: true, category: true, isActive: true, parentId: true } })
      : null;
    if (input.id && !current) return fail('That account is not on this entity.');

    const before = current ? await factsFor(prisma, current) : undefined;
    const problems = validateAccount(input, existing, before);
    if (problems.length) return fail(problems.map((p) => p.message).join(' '));

    if (before) {
      const warning = historicEffect(before, input);
      if (warning && !acknowledged) return { ok: true, value: { account: null as unknown as AccountRecord, warning } };
    }

    const parentId = input.parentCode?.trim()
      ? (chart.find((row) => row.code === input.parentCode?.trim())?.id ?? null)
      : null;

    const data = {
      code: input.code.trim(),
      name: input.name.trim(),
      type: input.type,
      category: input.category?.trim() || null,
      parentId,
    };

    const saved = await prisma.$transaction(async (tx: Tx) => {
      const row = current
        ? await tx.account.update({ where: { id: current.id }, data, include: { parent: { select: { code: true } } } })
        : await tx.account.create({ data: { entityId, ...data }, include: { parent: { select: { code: true } } } });

      await recordAuditEvent(
        {
          entityId,
          userId: principal.userId,
          userName: principal.name,
          action: current ? 'EDIT' : 'POST',
          resourceType: 'account',
          resourceRef: row.code,
          summary: current
            ? `Changed account ${current.code} ${current.name}`
            : `Added account ${row.code} ${row.name}`,
          metadata: current
            ? {
                before: { code: current.code, name: current.name, type: current.type, category: current.category, parentId: current.parentId },
                after: { code: row.code, name: row.name, type: row.type, category: row.category, parentId: row.parentId },
                postings: before?.postings ?? 0,
              }
            : { after: { code: row.code, name: row.name, type: row.type, category: row.category } },
        },
        tx,
      );
      return row;
    });

    refresh();
    return { ok: true, value: { account: accountRecord(saved) } };
  });
}

/** Switch an account off, so it leaves the lists but stays in the reports. Or back on. */
export async function setAccountActive(entityId: string, accountId: string, isActive: boolean): Promise<ActionResult<AccountRecord>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const row = await prisma.account.findFirst({ where: { id: accountId, entityId }, select: { id: true, code: true, name: true, type: true, isActive: true } });
    if (!row) return fail('That account is not on this entity.');
    if (row.isActive === isActive) return fail(isActive ? 'That account is already on.' : 'That account is already off.');

    const facts = await factsFor(prisma, row);
    if (!isActive && !permissionsFor(facts).deactivate) {
      return fail(permissionsFor(facts).reasons[0] ?? 'That account cannot be switched off.');
    }

    const saved = await prisma.$transaction(async (tx: Tx) => {
      const updated = await tx.account.update({ where: { id: row.id }, data: { isActive }, include: { parent: { select: { code: true } } } });
      await recordAuditEvent(
        {
          entityId,
          userId: principal.userId,
          userName: principal.name,
          action: 'EDIT',
          resourceType: 'account',
          resourceRef: row.code,
          summary: `${isActive ? 'Switched on' : 'Switched off'} account ${row.code} ${row.name}`,
          metadata: { before: { isActive: row.isActive }, after: { isActive }, postings: facts.postings },
        },
        tx,
      );
      return updated;
    });

    refresh();
    return { ok: true, value: accountRecord(saved) };
  });
}

/** Delete an account outright. Only ever possible while nothing points at it. */
export async function deleteAccount(entityId: string, accountId: string): Promise<ActionResult<{ code: string }>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const row = await prisma.account.findFirst({ where: { id: accountId, entityId }, select: { id: true, code: true, name: true, type: true, isActive: true } });
    if (!row) return fail('That account is not on this entity.');

    const facts = await factsFor(prisma, row);
    const rules = permissionsFor(facts);
    if (!rules.remove) return fail(rules.reasons[0] ?? 'That account cannot be deleted.');

    await prisma.$transaction(async (tx: Tx) => {
      // Checked again inside the transaction: a posting could have landed
      // between the check above and here.
      const postings = await tx.journalLine.count({ where: { accountId: row.id } });
      if (postings > 0) throw new Prisma.PrismaClientKnownRequestError('posted', { code: 'P2014', clientVersion: 'x' });
      await tx.account.delete({ where: { id: row.id } });
      await recordAuditEvent(
        {
          entityId,
          userId: principal.userId,
          userName: principal.name,
          action: 'EDIT',
          resourceType: 'account',
          resourceRef: row.code,
          summary: `Deleted account ${row.code} ${row.name}, which had no transactions`,
          metadata: { before: { code: row.code, name: row.name, type: row.type }, after: null },
        },
        tx,
      );
    });

    refresh();
    return { ok: true, value: { code: row.code } };
  });
}

/**
 * Move every posting from one account into another and switch the first off.
 * The postings keep their date, their amount and their journal; only which
 * account they sit on changes.
 */
export async function mergeAccounts(entityId: string, fromId: string, intoId: string, acknowledged = false): Promise<ActionResult<{ moved: number; warning?: string }>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const [from, into] = await Promise.all([
      prisma.account.findFirst({ where: { id: fromId, entityId }, select: { id: true, code: true, name: true, type: true, isActive: true } }),
      prisma.account.findFirst({ where: { id: intoId, entityId }, select: { id: true, code: true, name: true, type: true, isActive: true } }),
    ]);
    if (!from || !into) return fail('Both accounts have to be on this entity.');

    const [fromFacts, intoFacts] = await Promise.all([factsFor(prisma, from), factsFor(prisma, into)]);
    const allowed = canMerge(fromFacts, intoFacts);
    if (!allowed.ok) return fail(allowed.error);

    const warning = mergeEffect(fromFacts, intoFacts);
    if (!acknowledged) return { ok: true, value: { moved: 0, warning } };

    const moved = await prisma.$transaction(
      async (tx: Tx) => {
        const lines = await tx.journalLine.updateMany({ where: { entityId, accountId: from.id }, data: { accountId: into.id } });
        // Anything else pointing at the old account follows it, or it could
        // not be switched off.
        await tx.documentLine.updateMany({ where: { entityId, accountId: from.id }, data: { accountId: into.id } });
        await tx.account.update({ where: { id: from.id }, data: { isActive: false } });
        await recordAuditEvent(
          {
            entityId,
            userId: principal.userId,
            userName: principal.name,
            action: 'EDIT',
            resourceType: 'account-merge',
            resourceRef: `${from.code}->${into.code}`,
            summary: `Merged account ${from.code} ${from.name} into ${into.code} ${into.name}: ${lines.count} transaction${lines.count === 1 ? '' : 's'} moved`,
            metadata: {
              before: { code: from.code, name: from.name, postings: fromFacts.postings },
              after: { code: into.code, name: into.name },
              moved: lines.count,
            },
          },
          tx,
        );
        return lines.count;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );

    refresh();
    return { ok: true, value: { moved } };
  });
}

/** Put the chart in the order given. Codes not named keep where they were. */
export async function reorderAccounts(entityId: string, codesInOrder: string[]): Promise<ActionResult<{ ordered: number }>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const rows = await prisma.account.findMany({ where: { entityId, code: { in: codesInOrder } }, select: { id: true, code: true } });
    const idByCode = new Map(rows.map((row) => [row.code, row.id]));
    const positions = reorderedPositions(codesInOrder).filter((row) => idByCode.has(row.code));
    if (positions.length === 0) return fail('None of those accounts are on this entity.');

    await prisma.$transaction(
      async (tx: Tx) => {
        for (const position of positions) {
          await tx.account.update({ where: { id: idByCode.get(position.code)! }, data: { sortOrder: position.sortOrder } });
        }
        await recordAuditEvent(
          {
            entityId,
            userId: principal.userId,
            userName: principal.name,
            action: 'EDIT',
            resourceType: 'chart-of-accounts',
            resourceRef: entityId,
            summary: `Reordered ${positions.length} accounts in the chart`,
            metadata: { after: positions },
          },
          tx,
        );
      },
      { timeout: 30_000, maxWait: 10_000 },
    );

    refresh();
    return { ok: true, value: { ordered: positions.length } };
  });
}

// --- import -------------------------------------------------------------------------------

export type ImportPreview = {
  add: { code: string; name: string; type: AccountType }[];
  rename: { code: string; from: string; to: string }[];
  unchanged: number;
  blocked: { code: string; reason: string }[];
  rejected: { line: number; raw: string; reason: string }[];
};

/**
 * Read a chart out of a spreadsheet. Nothing is written until `apply` is set,
 * so the first call is a dry run showing exactly what would happen.
 *
 * An import only ever adds accounts and renames existing ones. It never
 * deletes, never switches anything off and never changes a type — a file
 * cannot quietly reclassify the ledger.
 */
export async function importChart(entityId: string, csv: string, apply = false): Promise<ActionResult<ImportPreview>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const { rows, rejected } = parseChartCsv(csv);
    const chart = await prisma.account.findMany({ where: { entityId }, select: { id: true, code: true, name: true, type: true } });
    const byCode = new Map(chart.map((row) => [row.code, row]));

    const preview: ImportPreview = { add: [], rename: [], unchanged: 0, blocked: [], rejected };

    for (const row of rows) {
      const current = byCode.get(row.code);
      if (!current) {
        preview.add.push({ code: row.code, name: row.name, type: row.type });
        continue;
      }
      if (current.type !== row.type) {
        preview.blocked.push({ code: row.code, reason: `The file calls ${row.code} a different kind of account. An import never changes a type; edit it here if that is right.` });
        continue;
      }
      if (current.name !== row.name) preview.rename.push({ code: row.code, from: current.name, to: row.name });
      else preview.unchanged += 1;
    }

    if (!apply) return { ok: true, value: preview };

    await prisma.$transaction(
      async (tx: Tx) => {
        for (const row of preview.add) {
          const source = rows.find((r) => r.code === row.code)!;
          await tx.account.create({ data: { entityId, code: source.code, name: source.name, type: source.type, category: source.category } });
        }
        for (const row of preview.rename) {
          await tx.account.update({ where: { id: byCode.get(row.code)!.id }, data: { name: row.to } });
        }
        await recordAuditEvent(
          {
            entityId,
            userId: principal.userId,
            userName: principal.name,
            action: 'EDIT',
            resourceType: 'chart-of-accounts',
            resourceRef: entityId,
            summary: `Imported a chart of accounts: ${preview.add.length} added, ${preview.rename.length} renamed, ${preview.blocked.length} left alone`,
            metadata: { added: preview.add, renamed: preview.rename, blocked: preview.blocked, rejected: preview.rejected.length },
          },
          tx,
        );
      },
      { timeout: 60_000, maxWait: 20_000 },
    );

    refresh();
    return { ok: true, value: preview };
  });
}
