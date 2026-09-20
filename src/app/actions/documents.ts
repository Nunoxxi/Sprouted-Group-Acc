'use server';

/**
 * Server Functions for invoices and bills.
 *
 * Every function takes an explicit entityId, verifies it, and scopes every
 * query by it. Changes that matter are made inside one transaction together
 * with their audit event, so the ledger can never hold a journal without the
 * event that explains it, or the reverse.
 *
 * Every function is reachable by direct POST, so none of them trusts the
 * caller: the first thing each does is ask src/lib/dal.ts who is signed in
 * and whether their role and entity access allow the operation. The
 * identity recorded on journals, documents, filings and audit events is the
 * session's, never an argument.
 *
 * Server functions dispatch sequentially on the client, so a debounced
 * autosave queued behind a slow post blocks other actions — the shell
 * cancels its autosave timer before posting or voiding.
 */

import { refresh } from 'next/cache';

import { journalEntriesBalance } from '@/lib/accounting-integrity';
import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess, requirePermission } from '@/lib/dal';
import { seedChartForEntity } from '@/lib/data/chart.ts';
import { documentInclude, documentRecord, kindToPrisma, vatToPrisma } from '@/lib/data/documents';
import { contactRecord, entityRecord, toPrismaEnum } from '@/lib/data/mappers';
import { fromMinor } from '@/lib/data/money';
import type { ContactRecord, DocumentRecord, EntityRecord, EntityType } from '@/lib/data/types';
import {
  accountNameMap,
  journalLinesFor,
  normalizeDocument,
  periodOf,
  type DocumentFormState,
} from '@/lib/documents';
import { prisma } from '@/lib/prisma';
import { accentPalette } from '@/lib/seed-data';

import type { WithholdingTaxStatus } from '@/lib/ghana-tax';

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

function fail<T>(error: string): ActionResult<T> {
  return { ok: false, error };
}

/**
 * Authorize first, then run. Nothing inside `run` executes — no query, no
 * read — unless the signed-in user may perform `permission` on `entityId`.
 * An authorization failure is returned as a value, like any other refusal.
 */
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

async function withPermission<T>(permission: Permission, run: (principal: Principal) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  let principal: Principal;
  try {
    principal = await requirePermission(permission);
  } catch (error) {
    const failure = authorizationFailure(error);
    if (failure) return failure;
    throw error;
  }
  return run(principal);
}

async function requireEntity(entityId: string) {
  const entity = await prisma.entity.findUnique({ where: { id: entityId }, select: { id: true, name: true } });
  if (!entity) {
    throw new Error(`Unknown entity ${entityId}`);
  }
  return entity;
}

function dateOf(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date ${value}`);
  }
  return date;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function documentLabel(kind: 'invoice' | 'bill', number: string): string {
  return `${kind === 'invoice' ? 'Invoice' : 'Bill'} ${number || '(draft)'}`;
}

/** A document past DRAFT always has a number; one without is corrupt, not a draft. */
function postedNumberOf(document: { id: string; status: string; number: string | null }): string {
  if (document.status === 'DRAFT' || !document.number) {
    throw new Error(`Document ${document.id} has status ${document.status} but no number`);
  }
  return document.number;
}

// --- drafts ------------------------------------------------------------------------

/**
 * Create or update a draft. Silently does nothing if the document is no
 * longer a draft — the editor's autosave can fire after a post, and that
 * must not be an error.
 */
export async function saveDocumentDraft(entityId: string, input: unknown): Promise<ActionResult<DocumentRecord>> {
  return withEntityAccess(entityId, 'document:draft', (principal) => saveDraft(entityId, input, principal));
}

async function saveDraft(entityId: string, input: unknown, principal: Principal): Promise<ActionResult<DocumentRecord>> {
  await requireEntity(entityId);

  const kind = (input as { kind?: string } | null)?.kind === 'bill' ? 'bill' : 'invoice';
  const fallbackContact = await prisma.contact.findFirst({ where: { isActive: true }, select: { id: true }, orderBy: { name: 'asc' } });
  const form = normalizeDocument(input, kind, fallbackContact?.id ?? '');

  if (!form.contactId) {
    return fail('Choose a contact before saving.');
  }

  const accounts = await prisma.account.findMany({ where: { entityId, isActive: true }, select: { id: true, code: true } });
  const accountIdOf = new Map(accounts.map((account) => [account.code, account.id]));
  for (const line of form.lines) {
    if (!accountIdOf.has(line.accountCode)) {
      return fail(`Account ${line.accountCode} is not in this entity's chart.`);
    }
  }

  const contact = await prisma.contact.findUnique({ where: { id: form.contactId }, select: { id: true } });
  if (!contact) {
    return fail('That contact no longer exists.');
  }

  const linesData = form.lines.map((line, position) => ({
    entityId,
    position,
    description: line.description,
    quantity: line.quantity,
    unitPriceMinor: fromMinor(line.unitPrice),
    accountId: accountIdOf.get(line.accountCode) as string,
    vatTreatment: vatToPrisma[line.vatTreatment],
  }));

  // The id must belong to *this* entity. One that does not — whether it is
  // another entity's document or nonsense — is refused the same way, as a
  // value, before the transaction opens.
  if (form.id) {
    const owned = await prisma.document.count({ where: { id: form.id, entityId } });
    if (owned !== 1) {
      return fail('Document not found.');
    }
  }

  const row = await prisma.$transaction(async (tx) => {
    if (form.id) {
      const existing = await tx.document.findFirst({ where: { id: form.id, entityId }, select: { status: true } });
      if (!existing) {
        throw new Error('Document not found'); // raced a concurrent change; unreachable in practice
      }
      if (existing.status !== 'DRAFT') {
        // Not an error: the autosave raced a post. Return what is there.
        return tx.document.findUniqueOrThrow({ where: { id: form.id }, include: documentInclude });
      }

      await tx.documentLine.deleteMany({ where: { documentId: form.id } });
      return tx.document.update({
        where: { id: form.id },
        data: {
          contactId: form.contactId,
          date: dateOf(form.date),
          dueDate: dateOf(form.dueDate),
          evatClearanceNumber: form.evatClearanceNumber || null,
          evatQrCode: form.evatQrCode || null,
          evatTimestamp: form.evatTimestamp || null,
          lastEditedById: principal.userId,
          lines: { create: linesData },
        },
        include: documentInclude,
      });
    }

    return tx.document.create({
      data: {
        entityId,
        kind: kindToPrisma[kind],
        number: null, // allocated on posting; NULL keeps the unique index off drafts
        contactId: form.contactId,
        date: dateOf(form.date),
        dueDate: dateOf(form.dueDate),
        status: 'DRAFT',
        evatClearanceNumber: form.evatClearanceNumber || null,
        evatQrCode: form.evatQrCode || null,
        evatTimestamp: form.evatTimestamp || null,
        createdById: principal.userId,
        lastEditedById: principal.userId,
        lines: { create: linesData },
      },
      include: documentInclude,
    });
  });

  // Drafts are not audited (the audit trail is for the ledger); the editor's
  // identity is on the row.
  refresh();
  return { ok: true, value: documentRecord(row) };
}

// --- posting -----------------------------------------------------------------------

/**
 * Post a draft: allocate its number, write a balanced journal dated the
 * document's date, and record the audit event — all in one transaction.
 *
 * The status change is a guarded updateMany on DRAFT, so two concurrent
 * posts of the same document produce exactly one journal.
 */
export async function postDocument(entityId: string, documentId: string): Promise<ActionResult<DocumentRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) => post(entityId, documentId, principal));
}

async function post(entityId: string, documentId: string, principal: Principal): Promise<ActionResult<DocumentRecord>> {
  await requireEntity(entityId);

  const document = await prisma.document.findFirst({
    where: { id: documentId, entityId },
    include: { ...documentInclude, contact: true },
  });
  if (!document) {
    return fail('Document not found.');
  }
  if (document.status !== 'DRAFT') {
    return fail('Only a draft can be posted.');
  }
  if (document.lines.length === 0) {
    return fail('Add at least one line before posting.');
  }

  const period = periodOf(document.date.toISOString());
  const filed = await prisma.taxPeriodFiling.findUnique({ where: { entityId_period: { entityId, period } } });
  if (filed) {
    return fail(`Period ${period} has been filed. Date the document in an open period.`);
  }

  const accounts = await prisma.account.findMany({ where: { entityId, isActive: true }, select: { id: true, code: true, name: true } });
  const accountIdOf = new Map(accounts.map((account) => [account.code, account.id]));
  const names = accountNameMap(accounts);

  const isPurchase = document.kind === 'BILL';
  const contact = contactRecord({ ...document.contact, balances: [] });
  const form = documentRecordToForm(documentRecord(document));
  const lines = journalLinesFor(form, isPurchase, contact, names);

  if (!journalEntriesBalance([{ entityId, lines }])) {
    // Cannot happen if the builder is correct; refuse loudly rather than
    // write an unbalanced entry.
    throw new Error('Journal does not balance; refusing to post');
  }

  for (const line of lines) {
    if (!accountIdOf.has(line.accountCode)) {
      return fail(`Account ${line.accountCode} is not in this entity's chart.`);
    }
  }

  const kind = document.kind === 'BILL' ? 'bill' : 'invoice';

  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.document.updateMany({
        where: { id: documentId, entityId, status: 'DRAFT' },
        data: { status: 'AWAITING_PAYMENT' },
      });
      if (claimed.count !== 1) {
        throw new AlreadyPostedError();
      }

      const counter = await tx.documentCounter.upsert({
        where: { entityId_kind: { entityId, kind: document.kind } },
        create: { entityId, kind: document.kind, next: 2 },
        update: { next: { increment: 1 } },
        select: { next: true },
      });
      const number = `${kind === 'invoice' ? 'INV' : 'BILL'}-${String(counter.next - 1).padStart(4, '0')}`;

      const entry = await tx.journalEntry.create({
        data: {
          entityId,
          kind: 'DOCUMENT',
          reference: number,
          description: `${documentLabel(kind, number)} — ${document.contact.name}`,
          postedAt: document.date,
          postedById: principal.userId,
          lines: {
            create: lines.map((line) => ({
              entityId,
              accountId: accountIdOf.get(line.accountCode) as string,
              contactId: document.contactId,
              amountMinor: fromMinor(line.amount),
              direction: line.type === 'debit' ? 'MONEY_IN' : 'MONEY_OUT',
            })),
          },
        },
        select: { id: true },
      });

      await tx.document.update({
        where: { id: documentId },
        data: { number, journalEntryId: entry.id },
      });

      await recordAuditEvent(
        {
          entityId,
          userId: principal.userId,
          userName: principal.name,
          action: 'POST',
          resourceType: kind,
          resourceRef: number,
          summary: `${documentLabel(kind, number)} posted for ${document.contact.name}`,
          metadata: { journalEntryId: entry.id, lines: lines.length, total: lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amount, 0) },
        },
        tx,
      );
    });
  } catch (error) {
    if (error instanceof AlreadyPostedError) {
      return fail('This document was already posted.');
    }
    throw error;
  }

  const posted = await prisma.document.findUniqueOrThrow({ where: { id: documentId }, include: documentInclude });
  refresh();
  return { ok: true, value: documentRecord(posted) };
}

class AlreadyPostedError extends Error {}

function documentRecordToForm(record: DocumentRecord): DocumentFormState {
  return {
    id: record.id,
    kind: record.kind,
    docNumber: record.docNumber,
    contactId: record.contactId,
    date: record.date,
    dueDate: record.dueDate,
    status: record.status,
    lines: record.lines.map((line) => ({
      id: line.id,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      accountCode: line.accountCode,
      vatTreatment: line.vatTreatment,
    })),
    evatClearanceNumber: record.evatClearanceNumber,
    evatQrCode: record.evatQrCode,
    evatTimestamp: record.evatTimestamp,
  };
}

// --- paid --------------------------------------------------------------------------

/**
 * Status and audit only. Posting the cash movement belongs to bank
 * reconciliation, which is not persisted yet — recorded as a known gap.
 */
export async function markDocumentPaid(entityId: string, documentId: string): Promise<ActionResult<DocumentRecord>> {
  return withEntityAccess(entityId, 'document:mark-paid', (principal) => markPaid(entityId, documentId, principal));
}

async function markPaid(entityId: string, documentId: string, principal: Principal): Promise<ActionResult<DocumentRecord>> {
  await requireEntity(entityId);

  const row = await prisma.$transaction(async (tx) => {
    const claimed = await tx.document.updateMany({
      where: { id: documentId, entityId, status: 'AWAITING_PAYMENT' },
      data: { status: 'PAID' },
    });
    if (claimed.count !== 1) {
      return null;
    }
    const document = await tx.document.findUniqueOrThrow({ where: { id: documentId }, include: documentInclude });
    const kind = document.kind === 'BILL' ? 'bill' : 'invoice';
    const number = postedNumberOf(document);
    await recordAuditEvent(
      {
        entityId,
        userId: principal.userId,
        userName: principal.name,
        action: 'EDIT',
        resourceType: kind,
        resourceRef: number,
        summary: `${documentLabel(kind, number)} marked paid`,
      },
      tx,
    );
    return document;
  });

  if (!row) {
    return fail('Only a document awaiting payment can be marked paid.');
  }

  refresh();
  return { ok: true, value: documentRecord(row) };
}

// --- void --------------------------------------------------------------------------

/**
 * Void a posted document by writing a reversing journal dated today. The
 * original entry is untouched — nothing is deleted. Refused if today's period
 * has been filed, because the reversal has to land in an open period.
 */
export async function voidDocument(entityId: string, documentId: string): Promise<ActionResult<DocumentRecord>> {
  return withEntityAccess(entityId, 'document:void', (principal) => voidPosted(entityId, documentId, principal));
}

async function voidPosted(entityId: string, documentId: string, principal: Principal): Promise<ActionResult<DocumentRecord>> {
  await requireEntity(entityId);

  const today = todayIso();
  const filed = await prisma.taxPeriodFiling.findUnique({ where: { entityId_period: { entityId, period: periodOf(today) } } });
  if (filed) {
    return fail(`Period ${periodOf(today)} has been filed, so a reversal cannot be dated today.`);
  }

  const document = await prisma.document.findFirst({
    where: { id: documentId, entityId },
    include: { journalEntry: { include: { lines: true } }, contact: { select: { name: true } } },
  });
  if (!document) {
    return fail('Document not found.');
  }
  if (document.status === 'VOIDED') {
    return fail('This document is already voided.');
  }
  if (document.status === 'DRAFT' || !document.journalEntry) {
    return fail('A draft has nothing to reverse; delete its lines instead.');
  }

  const kind = document.kind === 'BILL' ? 'bill' : 'invoice';
  const number = postedNumberOf(document);
  const original = document.journalEntry;

  const row = await prisma.$transaction(async (tx) => {
    const claimed = await tx.document.updateMany({
      where: { id: documentId, entityId, status: { in: ['AWAITING_PAYMENT', 'PAID'] } },
      data: { status: 'VOIDED' },
    });
    if (claimed.count !== 1) {
      throw new AlreadyPostedError();
    }

    const reversal = await tx.journalEntry.create({
      data: {
        entityId,
        kind: 'REVERSAL',
        reference: number,
        description: `Reversal of ${documentLabel(kind, number)} — ${document.contact.name}`,
        postedAt: dateOf(today),
        reversalOfId: original.id,
        postedById: principal.userId,
        lines: {
          create: original.lines.map((line) => ({
            entityId,
            accountId: line.accountId,
            fundId: line.fundId,
            projectId: line.projectId,
            contactId: line.contactId,
            amountMinor: line.amountMinor,
            direction: line.direction === 'MONEY_IN' ? 'MONEY_OUT' : 'MONEY_IN',
          })),
        },
      },
      select: { id: true },
    });

    await tx.document.update({ where: { id: documentId }, data: { voidEntryId: reversal.id } });

    await recordAuditEvent(
      {
        entityId,
        userId: principal.userId,
        userName: principal.name,
        action: 'VOID',
        resourceType: kind,
        resourceRef: number,
        summary: `${documentLabel(kind, number)} voided; reversal dated ${today}`,
        metadata: { reversalOf: original.id, reversalEntryId: reversal.id },
      },
      tx,
    );

    return tx.document.findUniqueOrThrow({ where: { id: documentId }, include: documentInclude });
  }).catch((error) => {
    if (error instanceof AlreadyPostedError) return null;
    throw error;
  });

  if (!row) {
    return fail('This document changed while you were voiding it. Reload and try again.');
  }

  refresh();
  return { ok: true, value: documentRecord(row) };
}

// --- periods -----------------------------------------------------------------------

export async function fileTaxPeriod(entityId: string, period: string): Promise<ActionResult<string[]>> {
  return withEntityAccess(entityId, 'period:file', (principal) => filePeriod(entityId, period, principal));
}

async function filePeriod(entityId: string, period: string, principal: Principal): Promise<ActionResult<string[]>> {
  await requireEntity(entityId);
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return fail('Period must be YYYY-MM.');
  }

  await prisma.$transaction(async (tx) => {
    const existing = await tx.taxPeriodFiling.findUnique({ where: { entityId_period: { entityId, period } } });
    if (existing) return;

    await tx.taxPeriodFiling.create({ data: { entityId, period, filedBy: principal.name, filedById: principal.userId } });
    await recordAuditEvent(
      {
        entityId,
        userId: principal.userId,
        userName: principal.name,
        action: 'FILE_PERIOD',
        resourceType: 'vat-period',
        resourceRef: period,
        summary: `VAT period ${period} filed and locked`,
      },
      tx,
    );
  });

  const periods = await prisma.taxPeriodFiling.findMany({ where: { entityId }, select: { period: true }, orderBy: { period: 'asc' } });
  refresh();
  return { ok: true, value: periods.map((filing) => filing.period) };
}

// --- contacts and entities ---------------------------------------------------------

export type NewContactInput = {
  name: string;
  type: ContactRecord['type'];
  category: ContactRecord['category'];
  tin: string;
  phone: string;
  email: string;
  address: string;
  withholdingTaxStatus: WithholdingTaxStatus;
  isFarmerAggregator: boolean;
};

// Contacts are shared across the group, so this is a role check, not an
// entity one: anyone who can draft a document can add the contact it needs.
export async function createContact(input: NewContactInput): Promise<ActionResult<ContactRecord>> {
  return withPermission('contact:create', () => addContact(input));
}

async function addContact(input: NewContactInput): Promise<ActionResult<ContactRecord>> {
  const name = input.name.trim();
  if (!name) {
    return fail('A contact needs a name.');
  }

  const entities = await prisma.entity.findMany({ select: { id: true } });

  const row = await prisma.contact.create({
    data: {
      name,
      type: toPrismaEnum.contactType[input.type],
      category: toPrismaEnum.contactCategory[input.category],
      tin: input.tin.trim() || null,
      phone: input.phone.trim() || null,
      email: input.email.trim() || null,
      address: input.address.trim() || null,
      withholdingTaxStatus: toPrismaEnum.withholdingTaxStatus[input.withholdingTaxStatus],
      isFarmerAggregator: input.isFarmerAggregator,
      balances: { create: entities.map((entity) => ({ entityId: entity.id, balanceMinor: BigInt(0) })) },
    },
    include: { balances: true },
  });

  refresh();
  return { ok: true, value: contactRecord(row) };
}

export type NewEntityInput = {
  name: string;
  type: EntityType;
  financialYearEnd: string;
  vatRegistered: boolean;
  tin: string;
};

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Create an entity with a full chart of accounts from the template for its
 * type, plus the group-entity contact the other entities trade with it
 * through. No schema change is needed for a fourth, fifth or tenth entity.
 */
export async function createEntity(input: NewEntityInput): Promise<ActionResult<{ entity: EntityRecord; contact: ContactRecord }>> {
  return withPermission('entity:create', () => addEntity(input));
}

async function addEntity(input: NewEntityInput): Promise<ActionResult<{ entity: EntityRecord; contact: ContactRecord }>> {
  const name = input.name.trim();
  if (!name) {
    return fail('An entity needs a name.');
  }

  const base = slugify(name) || 'entity';
  const existingCount = await prisma.entity.count();

  const result = await prisma.$transaction(async (tx) => {
    let id = base;
    for (let suffix = 2; await tx.entity.findUnique({ where: { id }, select: { id: true } }); suffix += 1) {
      id = `${base}-${suffix}`;
    }

    const entity = await tx.entity.create({
      data: {
        id,
        code: `SG${String(existingCount + 1).padStart(3, '0')}`,
        name,
        type: input.type,
        financialYearEnd: input.financialYearEnd.trim() || null,
        vatRegistered: input.vatRegistered,
        tin: input.tin.trim() || null,
        accent: accentPalette[existingCount % accentPalette.length],
      },
    });

    await seedChartForEntity(tx, entity.id, input.type);

    // Every existing contact gets a zero balance with the new entity, and the
    // new entity gets a group-entity contact everyone else can trade with.
    const contacts = await tx.contact.findMany({ select: { id: true } });
    await tx.contactEntityBalance.createMany({
      data: contacts.map((contact) => ({ contactId: contact.id, entityId: entity.id, balanceMinor: BigInt(0) })),
    });

    const allEntities = await tx.entity.findMany({ select: { id: true } });
    const groupContact = await tx.contact.create({
      data: {
        id: `${id}-contact`,
        name,
        type: 'SUPPLIER',
        category: 'GROUP_ENTITY',
        tin: input.tin.trim() || null,
        withholdingTaxStatus: 'WHT_5',
        balances: { create: allEntities.map((e) => ({ entityId: e.id, balanceMinor: BigInt(0) })) },
      },
      include: { balances: true },
    });

    return { entity, groupContact };
  });

  refresh();
  return { ok: true, value: { entity: entityRecord(result.entity), contact: contactRecord(result.groupContact) } };
}
