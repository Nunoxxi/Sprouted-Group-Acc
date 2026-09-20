/**
 * Document readers: Prisma → DocumentRecord, and the one-shot loader the
 * page uses. Every amount passes through toMinor() here.
 */

import type {
  Document,
  DocumentKind as PrismaDocumentKind,
  DocumentLine,
  DocumentStatus as PrismaDocumentStatus,
  JournalEntry,
  JournalLine,
  VatTreatment as PrismaVatTreatment,
  Account,
  Contact,
} from '@prisma/client';

import { can, permissions, roleLabels, type Principal } from '../authz';
import { prisma } from '../prisma';
import { accountRecord, contactRecord, entityRecord, fundRecord, projectRecord } from './mappers';
import { toMinor } from './money';
import type { DocumentKind, DocumentRecord, DocumentStatus, InitialData, PostedJournal, VatTreatment } from './types';

// --- enum translations -------------------------------------------------------

const kindToRecord: Record<PrismaDocumentKind, DocumentKind> = { INVOICE: 'invoice', BILL: 'bill' };
export const kindToPrisma: Record<DocumentKind, PrismaDocumentKind> = { invoice: 'INVOICE', bill: 'BILL' };

const statusToRecord: Record<PrismaDocumentStatus, DocumentStatus> = {
  DRAFT: 'draft',
  AWAITING_PAYMENT: 'awaiting-payment',
  PAID: 'paid',
  VOIDED: 'voided',
};
export const statusToPrisma: Record<DocumentStatus, PrismaDocumentStatus> = {
  draft: 'DRAFT',
  'awaiting-payment': 'AWAITING_PAYMENT',
  paid: 'PAID',
  voided: 'VOIDED',
};

const vatToRecord: Record<PrismaVatTreatment, VatTreatment> = {
  STANDARD: 'standard',
  ZERO_RATED: 'zero-rated',
  EXEMPT: 'exempt',
};
export const vatToPrisma: Record<VatTreatment, PrismaVatTreatment> = {
  standard: 'STANDARD',
  'zero-rated': 'ZERO_RATED',
  exempt: 'EXEMPT',
};

// --- row → record --------------------------------------------------------------

type JournalRow = JournalEntry & { lines: (JournalLine & { account: Pick<Account, 'code' | 'name'> })[] };

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function postedJournal(row: JournalRow): PostedJournal {
  return {
    id: row.id,
    kind: row.kind,
    postedAt: isoDate(row.postedAt),
    lines: row.lines.map((line) => ({
      accountCode: line.account.code,
      accountName: line.account.name,
      amount: toMinor(line.amountMinor),
      type: line.direction === 'MONEY_IN' ? 'debit' : 'credit',
    })),
  };
}

export type DocumentRow = Document & {
  contact: Pick<Contact, 'name'>;
  lines: (DocumentLine & { account: Pick<Account, 'code'> })[];
  journalEntry: JournalRow | null;
  voidEntry: JournalRow | null;
};

export function documentRecord(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    kind: kindToRecord[row.kind],
    docNumber: row.number ?? '',
    contactId: row.contactId,
    contactName: row.contact.name,
    date: isoDate(row.date),
    dueDate: isoDate(row.dueDate),
    status: statusToRecord[row.status],
    lines: [...row.lines]
      .sort((a, b) => a.position - b.position)
      .map((line) => ({
        id: line.id,
        description: line.description,
        quantity: line.quantity,
        unitPrice: toMinor(line.unitPriceMinor),
        accountCode: line.account.code,
        vatTreatment: vatToRecord[line.vatTreatment],
        projectId: line.projectId,
        fundId: line.fundId,
      })),
    evatClearanceNumber: row.evatClearanceNumber ?? '',
    evatQrCode: row.evatQrCode ?? '',
    evatTimestamp: row.evatTimestamp ?? '',
    journal: row.journalEntry ? postedJournal(row.journalEntry) : null,
    voidJournal: row.voidEntry ? postedJournal(row.voidEntry) : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const documentInclude = {
  contact: { select: { name: true } },
  lines: { include: { account: { select: { code: true } } } },
  journalEntry: { include: { lines: { include: { account: { select: { code: true, name: true } } } } } },
  voidEntry: { include: { lines: { include: { account: { select: { code: true, name: true } } } } } },
} as const;

// --- the page loader -----------------------------------------------------------

function groupBy<T>(items: T[], keyOf: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    (groups[keyOf(item)] ??= []).push(item);
  }
  return groups;
}

/**
 * Everything the shell needs, in one round of queries. Three entities and a
 * few dozen documents — no pagination at this scale.
 */
/**
 * Everything the shell needs, restricted to the entities the principal may
 * see. The restriction is in the queries themselves — `where: { entityId: in
 * ... }` — not applied afterwards, so nothing from another entity is ever
 * read. Contacts are group-wide by design; their balances are filtered.
 */
export async function loadInitialData(principal: Principal): Promise<InitialData> {
  const entityScope = principal.entityIds === 'all' ? {} : { entityId: { in: [...principal.entityIds] } };
  const entityFilter = principal.entityIds === 'all' ? {} : { id: { in: [...principal.entityIds] } };

  const [entities, contacts, accounts, funds, projects, documents, filings] = await Promise.all([
    prisma.entity.findMany({ where: entityFilter, orderBy: { code: 'asc' } }),
    prisma.contact.findMany({ include: { balances: { where: entityScope } }, orderBy: { name: 'asc' } }),
    prisma.account.findMany({ where: entityScope, include: { parent: { select: { code: true } } }, orderBy: [{ entityId: 'asc' }, { code: 'asc' }] }),
    prisma.fund.findMany({ where: entityScope, orderBy: { code: 'asc' } }),
    prisma.project.findMany({ where: entityScope, include: { fund: { select: { classification: true } } }, orderBy: { code: 'asc' } }),
    prisma.document.findMany({ where: entityScope, include: documentInclude, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] }),
    prisma.taxPeriodFiling.findMany({ where: entityScope, select: { entityId: true, period: true }, orderBy: { period: 'asc' } }),
  ]);

  const entityIds = entities.map((entity) => entity.id);
  const withAllEntities = <T>(grouped: Record<string, T[]>): Record<string, T[]> =>
    Object.fromEntries(entityIds.map((id) => [id, grouped[id] ?? []]));

  const periodsByEntity = groupBy(filings, (filing) => filing.entityId);

  return {
    currentUser: {
      id: principal.userId,
      name: principal.name,
      email: principal.email,
      role: principal.role,
      roleLabel: roleLabels[principal.role],
      permissions: permissions.filter((permission) => can(principal, permission)),
    },
    entities: entities.map(entityRecord),
    contacts: contacts.map(contactRecord),
    accountsByEntity: withAllEntities(groupBy(accounts.map(accountRecord), (account) => account.entityId)),
    fundsByEntity: withAllEntities(groupBy(funds.map(fundRecord), (fund) => fund.entityId)),
    projectsByEntity: withAllEntities(groupBy(projects.map(projectRecord), (project) => project.entityId)),
    documentsByEntity: withAllEntities(groupBy(documents.map(documentRecord), (document) => document.entityId)),
    filedPeriodsByEntity: Object.fromEntries(
      entityIds.map((id) => [id, (periodsByEntity[id] ?? []).map((filing) => filing.period)]),
    ),
  };
}
