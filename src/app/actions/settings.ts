'use server';

/**
 * Server Functions for the Settings area: projects and their budgets, funds,
 * contacts, entities, fixed asset classes and the tax rates.
 *
 * Two rules hold throughout, and they are why so much of this is a warning
 * rather than a refusal:
 *
 *  - Nothing here alters a posted transaction. A posted journal keeps the
 *    figures it was posted with, whatever a rate is changed to afterwards.
 *  - Anything that changes how history reports says so first, in plain words,
 *    and does nothing until that is acknowledged.
 *
 * Every change writes an audit event carrying the old value and the new one.
 */

import { refresh } from 'next/cache';
import { Prisma } from '@prisma/client';

import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess } from '@/lib/dal';
import { contactRecord, entityRecord, toPrismaEnum } from '@/lib/data/mappers';
import { fromMinor, toMinor } from '@/lib/data/money';
import type { ContactRecord, EntityRecord } from '@/lib/data/types';
import { encryptField } from '@/lib/pii-crypto';
import {
  canCloseProject,
  canDeleteProject,
  canReopenProject,
  fundClassificationEffect,
  revisionEffect,
  statutoryTaxRates,
  taxRateEffect,
  validateAssetCategory,
  validateBudgetLine,
  validateEntity,
  validateFund,
  validateProject,
  validateTaxRates,
  type FundClassification,
  type ProjectKind,
  type TaxRates,
} from '@/lib/settings';
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

const dateOf = (value: string | null | undefined): Date | null => {
  const trimmed = value?.trim();
  return trimmed ? new Date(`${trimmed}T00:00:00.000Z`) : null;
};

async function audit(tx: Tx, entityId: string, principal: Principal, input: { resourceType: string; resourceRef: string; summary: string; before?: unknown; after?: unknown }) {
  await recordAuditEvent(
    {
      entityId,
      userId: principal.userId,
      userName: principal.name,
      action: 'EDIT',
      resourceType: input.resourceType,
      resourceRef: input.resourceRef,
      summary: input.summary,
      metadata: { before: input.before ?? null, after: input.after ?? null },
    },
    tx,
  );
}

// --- projects --------------------------------------------------------------------------------

const projectKindToPrisma: Record<ProjectKind, 'GRANT_FUNDED' | 'SERVICE_CONTRACT'> = {
  'grant-funded': 'GRANT_FUNDED',
  'service-contract': 'SERVICE_CONTRACT',
};

export type ProjectInput = {
  id?: string;
  code: string;
  name: string;
  kind: ProjectKind;
  currency: 'GHS' | 'USD' | 'EUR';
  fundingMinor: number;
  startDate?: string | null;
  endDate?: string | null;
  fundCode?: string | null;
  funderContactId?: string | null;
};

export async function saveProject(entityId: string, input: ProjectInput): Promise<ActionResult<{ id: string; code: string }>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const [projects, funds] = await Promise.all([
      prisma.project.findMany({ where: { entityId }, select: { id: true, code: true } }),
      prisma.fund.findMany({ where: { entityId }, select: { id: true, code: true } }),
    ]);
    const current = input.id ? await prisma.project.findFirst({ where: { id: input.id, entityId } }) : null;
    if (input.id && !current) return fail('That project is not on this entity.');

    const problems = validateProject(input, projects.map((p) => p.code), current?.code);
    if (problems.length) return fail(problems.map((p) => p.message).join(' '));

    const fundId = input.fundCode?.trim() ? (funds.find((f) => f.code === input.fundCode?.trim())?.id ?? null) : null;
    if (input.fundCode?.trim() && !fundId) return fail(`There is no fund ${input.fundCode.trim()} on this company.`);

    const data = {
      code: input.code.trim(),
      name: input.name.trim(),
      kind: projectKindToPrisma[input.kind],
      currency: input.currency,
      fundingMinor: fromMinor(input.fundingMinor),
      startDate: dateOf(input.startDate),
      endDate: dateOf(input.endDate),
      fundId,
      funderContactId: input.funderContactId?.trim() || null,
    };

    const saved = await prisma.$transaction(async (tx: Tx) => {
      const row = current
        ? await tx.project.update({ where: { id: current.id }, data })
        : await tx.project.create({ data: { entityId, ...data } });
      await audit(tx, entityId, principal, {
        resourceType: 'project',
        resourceRef: row.code,
        summary: current ? `Changed project ${current.code} ${current.name}` : `Added project ${row.code} ${row.name}`,
        before: current ? { code: current.code, name: current.name, fundId: current.fundId, fundingMinor: toMinor(current.fundingMinor) } : null,
        after: { code: row.code, name: row.name, fundId: row.fundId, fundingMinor: toMinor(row.fundingMinor) },
      });
      return row;
    });

    refresh();
    return { ok: true, value: { id: saved.id, code: saved.code } };
  });
}

/** Close a project, or reopen one. Closed projects leave the coding lists and stay in every report. */
export async function setProjectClosed(entityId: string, projectId: string, closed: boolean): Promise<ActionResult<{ code: string }>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const row = await prisma.project.findFirst({ where: { id: projectId, entityId }, select: { id: true, code: true, name: true, closedAt: true } });
    if (!row) return fail('That project is not on this entity.');

    const check = closed ? canCloseProject({ closed: !!row.closedAt }) : canReopenProject({ closed: !!row.closedAt });
    if (!check.ok) return fail(check.error);

    await prisma.$transaction(async (tx: Tx) => {
      await tx.project.update({ where: { id: row.id }, data: { closedAt: closed ? new Date() : null, isActive: !closed } });
      await audit(tx, entityId, principal, {
        resourceType: 'project',
        resourceRef: row.code,
        summary: `${closed ? 'Closed' : 'Reopened'} project ${row.code} ${row.name}`,
        before: { closed: !!row.closedAt },
        after: { closed },
      });
    });

    refresh();
    return { ok: true, value: { code: row.code } };
  });
}

export async function deleteProject(entityId: string, projectId: string): Promise<ActionResult<{ code: string }>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const row = await prisma.project.findFirst({ where: { id: projectId, entityId }, select: { id: true, code: true, name: true } });
    if (!row) return fail('That project is not on this entity.');

    const [postings, documentLines, grants, budgetLines] = await Promise.all([
      prisma.journalLine.count({ where: { projectId: row.id } }),
      prisma.documentLine.count({ where: { projectId: row.id } }),
      prisma.grant.count({ where: { projectId: row.id } }),
      prisma.projectBudgetLine.count({ where: { projectId: row.id } }),
    ]);
    const check = canDeleteProject({ postings, documentLines, grants, budgetLines });
    if (!check.ok) return fail(check.error);

    await prisma.$transaction(async (tx: Tx) => {
      await tx.projectBudgetLine.deleteMany({ where: { projectId: row.id } });
      await tx.project.delete({ where: { id: row.id } });
      await audit(tx, entityId, principal, {
        resourceType: 'project',
        resourceRef: row.code,
        summary: `Deleted project ${row.code} ${row.name}, which had nothing coded to it`,
        before: { code: row.code, name: row.name },
      });
    });

    refresh();
    return { ok: true, value: { code: row.code } };
  });
}

// --- budget lines -----------------------------------------------------------------------------

export type ProjectBudgetLineInput = { id?: string; projectId: string; name: string; accountCode?: string | null; amountMinor: number; note?: string };

/**
 * Add a budget line, or change one that has not been agreed yet. Revising an
 * agreed line is a separate action, because it keeps the original.
 */
export async function saveProjectBudgetLine(entityId: string, input: ProjectBudgetLineInput): Promise<ActionResult<{ id: string }>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const project = await prisma.project.findFirst({ where: { id: input.projectId, entityId }, select: { id: true, code: true } });
    if (!project) return fail('That project is not on this entity.');

    const problems = validateBudgetLine({ name: input.name, amountMinor: input.amountMinor });
    if (problems.length) return fail(problems.map((p) => p.message).join(' '));

    const accountId = input.accountCode?.trim()
      ? (await prisma.account.findFirst({ where: { entityId, code: input.accountCode.trim() }, select: { id: true } }))?.id ?? null
      : null;
    if (input.accountCode?.trim() && !accountId) return fail(`There is no account ${input.accountCode.trim()} on this company.`);

    const current = input.id ? await prisma.projectBudgetLine.findFirst({ where: { id: input.id, entityId } }) : null;
    if (input.id && !current) return fail('That budget line is not on this entity.');

    const saved = await prisma.$transaction(async (tx: Tx) => {
      const row = current
        ? await tx.projectBudgetLine.update({
            where: { id: current.id },
            // The original is never edited here. Changing an agreed figure is
            // reviseBudgetLine, which keeps it.
            data: { name: input.name.trim(), accountId, note: input.note?.trim() || null },
          })
        : await tx.projectBudgetLine.create({
            data: { entityId, projectId: project.id, name: input.name.trim(), accountId, originalMinor: fromMinor(input.amountMinor), note: input.note?.trim() || null },
          });
      await audit(tx, entityId, principal, {
        resourceType: 'project-budget-line',
        resourceRef: `${project.code}/${row.name}`,
        summary: current ? `Changed budget line ${row.name} on project ${project.code}` : `Added budget line ${row.name} to project ${project.code} at ${(input.amountMinor / 100).toFixed(2)}`,
        before: current ? { name: current.name, originalMinor: toMinor(current.originalMinor) } : null,
        after: { name: row.name, originalMinor: toMinor(row.originalMinor) },
      });
      return row;
    });

    refresh();
    return { ok: true, value: { id: saved.id } };
  });
}

/**
 * Revise a budget line mid-project. The figure first agreed is kept, so a
 * report can show the budget as agreed, as revised, and the movement.
 */
export async function reviseProjectBudgetLine(entityId: string, budgetLineId: string, amountMinor: number, acknowledged = false): Promise<ActionResult<{ warning?: string }>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const row = await prisma.projectBudgetLine.findFirst({ where: { id: budgetLineId, entityId }, include: { project: { select: { code: true } } } });
    if (!row) return fail('That budget line is not on this entity.');

    const problems = validateBudgetLine({ name: row.name, amountMinor });
    if (problems.length) return fail(problems.map((p) => p.message).join(' '));

    const line = { id: row.id, name: row.name, originalMinor: toMinor(row.originalMinor), revisedMinor: row.revisedMinor === null ? null : toMinor(row.revisedMinor) };
    const warning = revisionEffect(line, amountMinor);
    if (!acknowledged) return { ok: true, value: { warning } };

    await prisma.$transaction(async (tx: Tx) => {
      await tx.projectBudgetLine.update({ where: { id: row.id }, data: { revisedMinor: fromMinor(amountMinor), revisedAt: new Date() } });
      await audit(tx, entityId, principal, {
        resourceType: 'project-budget-line',
        resourceRef: `${row.project.code}/${row.name}`,
        summary: `Revised budget line ${row.name} on project ${row.project.code} to ${(amountMinor / 100).toFixed(2)}; the figure first agreed is kept`,
        before: { originalMinor: line.originalMinor, revisedMinor: line.revisedMinor },
        after: { originalMinor: line.originalMinor, revisedMinor: amountMinor },
      });
    });

    refresh();
    return { ok: true, value: {} };
  });
}

export async function removeProjectBudgetLine(entityId: string, budgetLineId: string): Promise<ActionResult<{ name: string }>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const row = await prisma.projectBudgetLine.findFirst({ where: { id: budgetLineId, entityId }, include: { project: { select: { code: true } } } });
    if (!row) return fail('That budget line is not on this entity.');

    await prisma.$transaction(async (tx: Tx) => {
      await tx.projectBudgetLine.delete({ where: { id: row.id } });
      await audit(tx, entityId, principal, {
        resourceType: 'project-budget-line',
        resourceRef: `${row.project.code}/${row.name}`,
        summary: `Removed budget line ${row.name} from project ${row.project.code}`,
        before: { name: row.name, originalMinor: toMinor(row.originalMinor) },
      });
    });

    refresh();
    return { ok: true, value: { name: row.name } };
  });
}

// --- funds ------------------------------------------------------------------------------------

export type FundInput = { id?: string; code: string; name: string; classification: FundClassification; funder?: string };

export async function saveFund(entityId: string, input: FundInput, acknowledged = false): Promise<ActionResult<{ code: string; warning?: string }>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const funds = await prisma.fund.findMany({ where: { entityId }, select: { code: true } });
    const current = input.id ? await prisma.fund.findFirst({ where: { id: input.id, entityId } }) : null;
    if (input.id && !current) return fail('That fund is not on this entity.');

    const problems = validateFund(input, funds.map((f) => f.code), current?.code);
    if (problems.length) return fail(problems.map((p) => p.message).join(' '));

    if (current) {
      const before: FundClassification = current.classification === 'RESTRICTED' ? 'restricted' : 'unrestricted';
      if (before !== input.classification) {
        const postings = await prisma.journalLine.count({ where: { fundId: current.id } });
        const warning = fundClassificationEffect(before, input.classification, postings);
        if (warning && !acknowledged) return { ok: true, value: { code: current.code, warning } };
      }
    }

    const data = {
      code: input.code.trim(),
      name: input.name.trim(),
      classification: toPrismaEnum.fundClassification[input.classification],
      funder: input.funder?.trim() || null,
    };

    const saved = await prisma.$transaction(async (tx: Tx) => {
      const row = current ? await tx.fund.update({ where: { id: current.id }, data }) : await tx.fund.create({ data: { entityId, ...data } });
      await audit(tx, entityId, principal, {
        resourceType: 'fund',
        resourceRef: row.code,
        summary: current ? `Changed fund ${current.code} ${current.name}` : `Added fund ${row.code} ${row.name}`,
        before: current ? { code: current.code, name: current.name, classification: current.classification } : null,
        after: { code: row.code, name: row.name, classification: row.classification },
      });
      return row;
    });

    refresh();
    return { ok: true, value: { code: saved.code } };
  });
}

export async function setFundActive(entityId: string, fundId: string, isActive: boolean): Promise<ActionResult<{ code: string }>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const row = await prisma.fund.findFirst({ where: { id: fundId, entityId }, select: { id: true, code: true, name: true, isActive: true } });
    if (!row) return fail('That fund is not on this entity.');
    if (row.isActive === isActive) return fail(isActive ? 'That fund is already open.' : 'That fund is already closed.');

    await prisma.$transaction(async (tx: Tx) => {
      await tx.fund.update({ where: { id: row.id }, data: { isActive } });
      await audit(tx, entityId, principal, {
        resourceType: 'fund',
        resourceRef: row.code,
        summary: `${isActive ? 'Reopened' : 'Closed'} fund ${row.code} ${row.name}`,
        before: { isActive: row.isActive },
        after: { isActive },
      });
    });

    refresh();
    return { ok: true, value: { code: row.code } };
  });
}

// --- contacts ----------------------------------------------------------------------------------

export type ContactEditInput = {
  id: string;
  name: string;
  type: 'customer' | 'supplier' | 'both';
  category: 'customer' | 'supplier' | 'farmer' | 'group-entity' | 'other';
  tin: string;
  phone: string;
  email: string;
  address: string;
  withholdingTaxStatus: 'none' | '5%' | '10%' | 'exempt';
};

/**
 * Correct a contact. Contacts are shared across the group, so this is not
 * scoped to one entity — but it is recorded against the entity the person was
 * looking at, so the change is findable.
 */
export async function updateContact(entityId: string, input: ContactEditInput): Promise<ActionResult<ContactRecord>> {
  return withEntityAccess(entityId, 'contact:create', async (principal) => {
    const current = await prisma.contact.findFirst({
      where: { id: input.id, balances: { some: { entityId } } },
      select: { id: true, name: true, type: true, category: true, tin: true, withholdingTaxStatus: true },
    });
    if (!current) return fail('That contact does not trade with this company.');

    const name = input.name.trim();
    if (!name) return fail('A contact needs a name.');

    const saved = await prisma.$transaction(async (tx: Tx) => {
      const row = await tx.contact.update({
        where: { id: current.id },
        data: {
          name,
          type: toPrismaEnum.contactType[input.type],
          category: toPrismaEnum.contactCategory[input.category],
          tin: input.tin.trim() || null,
          phone: encryptField('Contact.phone', input.phone.trim()),
          email: encryptField('Contact.email', input.email.trim()),
          address: encryptField('Contact.address', input.address.trim()),
          withholdingTaxStatus: toPrismaEnum.withholdingTaxStatus[input.withholdingTaxStatus],
        },
        include: { balances: true },
      });
      await audit(tx, entityId, principal, {
        resourceType: 'contact',
        resourceRef: row.id,
        summary: `Changed contact ${current.name}${current.name !== name ? `, now ${name}` : ''}`,
        // The telephone number and the rest are personal data, so the audit
        // says which fields changed, not what they changed to.
        before: { name: current.name, type: current.type, category: current.category, tin: current.tin, withholdingTaxStatus: current.withholdingTaxStatus },
        after: { name, type: input.type, category: input.category, tin: input.tin.trim() || null, withholdingTaxStatus: input.withholdingTaxStatus, contactDetailsChanged: true },
      });
      return row;
    });

    refresh();
    return { ok: true, value: contactRecord(saved) };
  });
}

export async function setContactActive(entityId: string, contactId: string, isActive: boolean): Promise<ActionResult<{ name: string }>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const row = await prisma.contact.findFirst({ where: { id: contactId, balances: { some: { entityId } } }, select: { id: true, name: true, isActive: true, category: true } });
    if (!row) return fail('That contact does not trade with this company.');
    if (row.category === 'GROUP_ENTITY') return fail('That is another company in the group. It cannot be switched off from here.');
    if (row.isActive === isActive) return fail(isActive ? 'That contact is already on.' : 'That contact is already off.');

    await prisma.$transaction(async (tx: Tx) => {
      await tx.contact.update({ where: { id: row.id }, data: { isActive } });
      await audit(tx, entityId, principal, {
        resourceType: 'contact',
        resourceRef: row.id,
        summary: `${isActive ? 'Switched on' : 'Switched off'} contact ${row.name}`,
        before: { isActive: row.isActive },
        after: { isActive },
      });
    });

    refresh();
    return { ok: true, value: { name: row.name } };
  });
}

// --- entities ------------------------------------------------------------------------------------

export type EntityEditInput = { name: string; tin: string; financialYearEnd: string; accent?: string };

/** Correct a company's own details. Its type is not here: see below. */
export async function updateEntity(entityId: string, input: EntityEditInput): Promise<ActionResult<EntityRecord>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const current = await prisma.entity.findUnique({ where: { id: entityId } });
    if (!current) return fail('That company does not exist.');

    const problems = validateEntity(input);
    if (problems.length) return fail(problems.map((p) => p.message).join(' '));

    const saved = await prisma.$transaction(async (tx: Tx) => {
      const row = await tx.entity.update({
        where: { id: entityId },
        data: {
          name: input.name.trim(),
          tin: input.tin.trim() || null,
          financialYearEnd: input.financialYearEnd.trim() || null,
          accent: input.accent?.trim() || current.accent,
        },
      });
      await audit(tx, entityId, principal, {
        resourceType: 'entity',
        resourceRef: entityId,
        summary: `Changed the details of ${current.name}${current.name !== row.name ? `, now ${row.name}` : ''}`,
        before: { name: current.name, tin: current.tin, financialYearEnd: current.financialYearEnd },
        after: { name: row.name, tin: row.tin, financialYearEnd: row.financialYearEnd },
      });
      return row;
    });

    refresh();
    return { ok: true, value: entityRecord(saved) };
  });
}

// --- fixed asset classes ---------------------------------------------------------------------------

export type AssetCategoryInput = { id?: string; name: string; ratePct: number; method: 'straight-line' | 'reducing-balance'; accountCode?: string | null; isActive?: boolean };

export async function saveAssetCategory(entityId: string, input: AssetCategoryInput): Promise<ActionResult<{ name: string }>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const categories = await prisma.assetCategory.findMany({ where: { entityId }, select: { id: true, name: true } });
    const current = input.id ? await prisma.assetCategory.findFirst({ where: { id: input.id, entityId } }) : null;
    if (input.id && !current) return fail('That class of asset is not on this entity.');

    const problems = validateAssetCategory(input, categories.map((c) => c.name), current?.name);
    if (problems.length) return fail(problems.map((p) => p.message).join(' '));

    const accountId = input.accountCode?.trim()
      ? (await prisma.account.findFirst({ where: { entityId, code: input.accountCode.trim() }, select: { id: true } }))?.id ?? null
      : null;

    const data = {
      name: input.name.trim(),
      ratePct: new Prisma.Decimal(input.ratePct),
      method: input.method === 'reducing-balance' ? ('REDUCING_BALANCE' as const) : ('STRAIGHT_LINE' as const),
      accountId,
      isActive: input.isActive ?? true,
    };

    const saved = await prisma.$transaction(async (tx: Tx) => {
      const row = current ? await tx.assetCategory.update({ where: { id: current.id }, data }) : await tx.assetCategory.create({ data: { entityId, ...data } });
      await audit(tx, entityId, principal, {
        resourceType: 'asset-category',
        resourceRef: row.name,
        summary: current
          ? `Changed asset class ${current.name}: ${Number(row.ratePct)}% a year`
          : `Added asset class ${row.name} at ${Number(row.ratePct)}% a year`,
        before: current ? { name: current.name, ratePct: Number(current.ratePct), method: current.method } : null,
        after: { name: row.name, ratePct: Number(row.ratePct), method: row.method },
      });
      return row;
    });

    refresh();
    return { ok: true, value: { name: saved.name } };
  });
}

export async function removeAssetCategory(entityId: string, categoryId: string): Promise<ActionResult<{ name: string }>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const row = await prisma.assetCategory.findFirst({ where: { id: categoryId, entityId }, select: { id: true, name: true } });
    if (!row) return fail('That class of asset is not on this entity.');

    // Assets keep whatever terms they were given, so removing a class never
    // restates anything; it only stops it being offered.
    const inUse = await prisma.fixedAsset.count({ where: { entityId, category: row.name } });
    await prisma.$transaction(async (tx: Tx) => {
      if (inUse > 0) await tx.assetCategory.update({ where: { id: row.id }, data: { isActive: false } });
      else await tx.assetCategory.delete({ where: { id: row.id } });
      await audit(tx, entityId, principal, {
        resourceType: 'asset-category',
        resourceRef: row.name,
        summary: inUse > 0
          ? `Switched off asset class ${row.name}; ${inUse} asset${inUse === 1 ? '' : 's'} already use it and keep their own terms`
          : `Deleted asset class ${row.name}, which no asset used`,
        before: { name: row.name },
      });
    });

    refresh();
    return { ok: true, value: { name: row.name } };
  });
}

// --- tax rates -------------------------------------------------------------------------------------

export async function saveTaxRates(entityId: string, input: TaxRates, acknowledged = false): Promise<ActionResult<{ warning?: string }>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    const problems = validateTaxRates(input);
    if (problems.length) return fail(problems.map((p) => p.message).join(' '));

    const current = await prisma.taxRateSetting.findUnique({ where: { entityId } });
    const before: TaxRates = current
      ? {
          vatPct: Number(current.vatPct),
          nhilPct: Number(current.nhilPct),
          getFundPct: Number(current.getFundPct),
          registrationThresholdMinor: toMinor(current.registrationThresholdMinor),
        }
      : statutoryTaxRates;

    const warning = taxRateEffect(before, input);
    if (warning && !acknowledged) return { ok: true, value: { warning } };
    if (!warning) return fail('Those are the rates already in use.');

    await prisma.$transaction(async (tx: Tx) => {
      await tx.taxRateSetting.upsert({
        where: { entityId },
        create: {
          entityId,
          vatPct: new Prisma.Decimal(input.vatPct),
          nhilPct: new Prisma.Decimal(input.nhilPct),
          getFundPct: new Prisma.Decimal(input.getFundPct),
          registrationThresholdMinor: fromMinor(input.registrationThresholdMinor),
        },
        update: {
          vatPct: new Prisma.Decimal(input.vatPct),
          nhilPct: new Prisma.Decimal(input.nhilPct),
          getFundPct: new Prisma.Decimal(input.getFundPct),
          registrationThresholdMinor: fromMinor(input.registrationThresholdMinor),
        },
      });
      await audit(tx, entityId, principal, {
        resourceType: 'tax-rates',
        resourceRef: entityId,
        summary: `Changed the tax rates: VAT ${input.vatPct}%, NHIL ${input.nhilPct}%, GETFund ${input.getFundPct}%`,
        before,
        after: input,
      });
    });

    refresh();
    return { ok: true, value: {} };
  });
}

/** Put an entity's rates back to the Ghanaian ones. */
export async function resetTaxRates(entityId: string): Promise<ActionResult<{ ok: true }>> {
  return withEntityAccess(entityId, 'settings:manage', async (principal) => {
    await prisma.$transaction(async (tx: Tx) => {
      await tx.taxRateSetting.deleteMany({ where: { entityId } });
      await audit(tx, entityId, principal, {
        resourceType: 'tax-rates',
        resourceRef: entityId,
        summary: 'Put the tax rates back to the Ghanaian ones',
        after: statutoryTaxRates,
      });
    });
    refresh();
    return { ok: true, value: { ok: true } };
  });
}
