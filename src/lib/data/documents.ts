/**
 * Document readers: Prisma â†’ DocumentRecord, and the one-shot loader the
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
  SaleType as PrismaSaleType,
  Account,
  Contact,
} from '@prisma/client';

import { can, permissions, roleLabels, type Principal } from '../authz';
import { prisma } from '../prisma';
import { accountRecord, contactRecord, entityRecord, fundRecord, projectRecord, rateText } from './mappers';
import { toMinor } from './money';
import type {
  BankAccountRecord,
  DocumentKind,
  DocumentRecord,
  DocumentStatus,
  ExchangeRateRow,
  InitialData,
  PaymentRecord,
  PostedJournal,
  RevaluationRecord,
  SaleType,
  VatTreatment,
} from './types';
import type { BankAccount, ExchangeRate, Payment, Revaluation } from '@prisma/client';
import type { Quality } from '../trading';
import { loadInventoryData } from './inventory';
import { landedCostKindOf, loadTradingData } from './trading';
import { loadContractData, sellingCostKindOf } from './contracts';
import { loadAssetData } from './assets';
import { loadCashflowData } from './cashflow';
import { loadAttachmentData } from './attachments';
import { encryptionConfigured } from '../pii-crypto';
import { loadPayrollData } from './payroll';
import { redactInitialData } from './redact';
import { loadPrivacyData } from './privacy';
import { loadPreFinanceData } from './prefinance';
import { loadSettingsData } from './settings';
import { loadGrantData } from './grants';
import { bankAccountKindOf, loadMomoData } from './momo';
import { loadOpeningData } from './opening';
import { sections, sectionsByScreen, type Screen, type Section } from '../screens';

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

const saleTypeToRecord: Record<PrismaSaleType, SaleType> = { DOMESTIC: 'domestic', EXPORT: 'export' };
export const saleTypeToPrisma: Record<SaleType, PrismaSaleType> = { domestic: 'DOMESTIC', export: 'EXPORT' };

// --- row â†’ record --------------------------------------------------------------

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
      currency: line.txnCurrency,
      txnAmount: toMinor(line.txnAmountMinor),
      rate: rateText(line.rate) ?? '1.0',
    })),
  };
}

export type PaymentRow = Payment & { bankAccount: BankAccount; journalEntry: JournalRow | null };

export function paymentRecord(row: PaymentRow): PaymentRecord {
  return {
    id: row.id,
    date: isoDate(row.date),
    bankAccountId: row.bankAccountId,
    bankAccountName: row.bankAccount.name,
    bankCurrency: row.bankAccount.currency,
    txnAmount: toMinor(row.txnAmountMinor),
    rate: rateText(row.rate) ?? '1.0',
    bankAmount: toMinor(row.bankAmountMinor),
    bankFunctionalAmount: toMinor(row.bankFunctionalMinor),
    reliefAmount: toMinor(row.reliefMinor),
    gainLoss: toMinor(row.gainLossMinor),
    journal: row.journalEntry ? postedJournal(row.journalEntry) : null,
  };
}

export function exchangeRateRow(row: ExchangeRate): ExchangeRateRow {
  return { id: row.id, base: row.base, quote: row.quote, date: isoDate(row.date), rate: rateText(row.rate) ?? '1.0', source: row.source ?? '' };
}

export function bankAccountRecord(row: BankAccount & { account: Pick<Account, 'code' | 'name'> }): BankAccountRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    name: row.name,
    currency: row.currency,
    kind: bankAccountKindOf(row.kind),
    provider: row.provider ?? '',
    number: row.number ?? '',
    accountCode: row.account.code,
    accountName: row.account.name,
    isActive: row.isActive,
  };
}

export function revaluationRecord(row: Revaluation & { journalEntry: JournalRow; reversalEntry: JournalRow | null }): RevaluationRecord {
  return {
    id: row.id,
    period: row.period,
    closingRates: JSON.parse(row.closingRatesJson),
    journal: postedJournal(row.journalEntry),
    reversalJournal: row.reversalEntry ? postedJournal(row.reversalEntry) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export type DocumentRow = Document & {
  contact: Pick<Contact, 'name'>;
  lines: (DocumentLine & { account: Pick<Account, 'code'>; landedCostLots: { lotId: string }[] })[];
  journalEntry: JournalRow | null;
  voidEntry: JournalRow | null;
  payments: PaymentRow[];
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
    currency: row.currency,
    rate: rateText(row.rate),
    rateDate: row.rateDate ? isoDate(row.rateDate) : null,
    rateExact: row.rateExact,
    paidTxnMinor: toMinor(row.paidTxnMinor),
    saleType: saleTypeToRecord[row.saleType],
    importVat: toMinor(row.importVatMinor),
    vatApplied: row.vatApplied,
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
        itemId: line.itemId,
        locationId: line.locationId,
        landedCostKind: landedCostKindOf(line.landedCostKind),
        landedCostLotIds: line.landedCostLots.map((allocation) => allocation.lotId),
        lotRef: line.lotRef ?? '',
        community: line.community ?? '',
        district: line.district ?? '',
        quality: line.qualityJson ? (JSON.parse(line.qualityJson) as Quality) : {},
        contractId: line.contractId,
        sellingCostKind: sellingCostKindOf(line.sellingCostKind),
        grantId: line.grantId,
        budgetLineId: line.budgetLineId,
      })),
    evatClearanceNumber: row.evatClearanceNumber ?? '',
    evatQrCode: row.evatQrCode ?? '',
    evatTimestamp: row.evatTimestamp ?? '',
    payments: [...row.payments].sort((a, b) => a.date.getTime() - b.date.getTime()).map(paymentRecord),
    journal: row.journalEntry ? postedJournal(row.journalEntry) : null,
    voidJournal: row.voidEntry ? postedJournal(row.voidEntry) : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const documentInclude = {
  contact: { select: { name: true } },
  lines: { include: { account: { select: { code: true } }, landedCostLots: { select: { lotId: true } } } },
  journalEntry: { include: { lines: { include: { account: { select: { code: true, name: true } } } } } },
  voidEntry: { include: { lines: { include: { account: { select: { code: true, name: true } } } } } },
  payments: {
    include: {
      bankAccount: true,
      journalEntry: { include: { lines: { include: { account: { select: { code: true, name: true } } } } } },
    },
  },
} as const;

const journalLinesInclude = { lines: { include: { account: { select: { code: true, name: true } } } } } as const;

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
 * few dozen documents â€” no pagination at this scale.
 */
/**
 * Everything the shell needs, restricted to the entities the principal may
 * see. The restriction is in the queries themselves â€” `where: { entityId: in
 * ... }` â€” not applied afterwards, so nothing from another entity is ever
 * read. Contacts are group-wide by design; their balances are filtered.
 */
/**
 * Everything the signed-in person may see, assembled once. Personal details
 * are held back here, on the server, for a role that has no reason for them:
 * hiding them in the interface would leave them in the page source.
 */
export async function loadInitialData(principal: Principal, screen: Screen = 'Dashboard'): Promise<InitialData> {
  return redactInitialData(await loadEverything(principal, screen), principal.role);
}

type Scope = { entityId?: { in: string[] } };

/** Each section's loader, by name. */
function sectionLoaders(scope: Scope, entityIds: string[], entities: { id: string; name: string; functionalCurrency: string }[], principal: Principal) {
  return {
    inventory: () => loadInventoryData(scope, entityIds),
    trading: () => loadTradingData(scope, entityIds),
    contracts: () => loadContractData(scope, entityIds),
    opening: () => loadOpeningData(entityIds),
    momo: () => loadMomoData(scope, entityIds),
    grants: () => loadGrantData(scope, entityIds),
    cashflow: () => loadCashflowData(scope, entityIds, entities),
    assets: () => loadAssetData(scope, entityIds),
    attachments: () => loadAttachmentData(scope, entityIds),
    privacy: () => loadPrivacyData(scope, entityIds),
    settings: () => loadSettingsData(scope, entityIds),
    prefinance: () => loadPreFinanceData(scope, entityIds),
    payroll: () => loadPayrollData(scope, entityIds, can(principal, 'payroll:view')),
  } satisfies Record<Section, () => Promise<object>>;
}

type SectionData = { [S in Section]: Awaited<ReturnType<ReturnType<typeof sectionLoaders>[S]>> };

/**
 * Each section's fields, so a section the screen does not read is sent empty
 * rather than missing: code outside the screen may look a value up, and an
 * empty map answers with nothing rather than throwing.
 */
export const sectionFields = {
  inventory: ['itemsByEntity', 'locationsByEntity', 'stockBalancesByEntity', 'stockMovementsByEntity', 'stockCountsByEntity', 'nrvPricesByEntity', 'inventoryLedgerByEntity'],
  trading: ['agentsByEntity', 'floatsByEntity', 'agentPurchasesByEntity', 'commoditiesByEntity', 'lotsByEntity'],
  contracts: ['contractsByEntity', 'seedFundsByEntity'],
  opening: ['openingByEntity'],
  momo: ['farmersByEntity', 'farmerAdvancesByEntity', 'paymentBatchesByEntity', 'statementMappingsByEntity', 'statementImportsByEntity'],
  grants: ['grantsByEntity', 'grantActualsByEntity', 'inKindByEntity', 'staffTimeByEntity'],
  cashflow: ['seasonsByEntity', 'recurringByEntity', 'scenariosByEntity', 'cashSourcesByEntity'],
  assets: ['assetsByEntity', 'depreciationRunsByEntity', 'allowanceClassesByEntity', 'taxYearsByEntity'],
  attachments: ['attachmentsByEntity', 'attachmentRulesByEntity'],
  privacy: ['dataRequestsByEntity', 'piiAccessByEntity', 'personalDataCountsByEntity'],
  settings: ['assetCategoriesByEntity', 'budgetLinesByEntity', 'payrollSettingsByEntity', 'taxRatesByEntity', 'statutoryRates'],
  prefinance: ['preFinanceSettingsByEntity', 'facilitiesByEntity', 'tranchesByEntity', 'advancesByEntity', 'advanceDeliveriesByEntity', 'preFinanceCyclesByEntity'],
  payroll: ['employeesByEntity', 'payRunsByEntity', 'staffLoansByEntity', 'remittancesByEntity', 'payFactsByEntity', 'casualLabourByEntity', 'payrollLedgerByEntity'],
} as const satisfies { [S in Section]: readonly (keyof SectionData[S])[] };

// Fails to compile when a loader returns a field the list above leaves out.
type Unlisted = { [S in Section]: Exclude<keyof SectionData[S], (typeof sectionFields)[S][number]> };
const everyFieldListed: { [S in Section]: never } = null as unknown as Unlisted;
void everyFieldListed;

function emptySection<S extends Section>(section: S): SectionData[S] {
  return Object.fromEntries(sectionFields[section].map((field) => [field, field === 'statutoryRates' ? [] : {}])) as SectionData[S];
}

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;
type AllSections = UnionToIntersection<SectionData[Section]>;

async function loadEverything(principal: Principal, screen: Screen): Promise<InitialData> {
  const entityScope = principal.entityIds === 'all' ? {} : { entityId: { in: [...principal.entityIds] } };
  const entityFilter = principal.entityIds === 'all' ? {} : { id: { in: [...principal.entityIds] } };

  // The screen's own sections need only the entity list, so they start as
  // soon as that arrives rather than waiting for the documents and the rest.
  const entitiesLoaded = prisma.entity.findMany({ where: entityFilter, orderBy: { code: 'asc' } });
  const wanted = new Set(sectionsByScreen[screen]);
  const sectionsLoaded = entitiesLoaded.then((rows) => {
    const loaders = sectionLoaders(entityScope, rows.map((entity) => entity.id), rows, principal);
    return Promise.all(sections.map((section) => (wanted.has(section) ? loaders[section]() : emptySection(section))));
  });

  const [entities, contacts, accounts, funds, projects, documents, filings, rates, bankAccounts, revaluations, loaded] = await Promise.all([
    entitiesLoaded,
    prisma.contact.findMany({ include: { balances: { where: entityScope } }, orderBy: { name: 'asc' } }),
    prisma.account.findMany({ where: entityScope, include: { parent: { select: { code: true } } }, orderBy: [{ entityId: 'asc' }, { code: 'asc' }] }),
    prisma.fund.findMany({ where: entityScope, orderBy: { code: 'asc' } }),
    prisma.project.findMany({ where: entityScope, include: { fund: { select: { classification: true } } }, orderBy: { code: 'asc' } }),
    prisma.document.findMany({ where: entityScope, include: documentInclude, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] }),
    prisma.taxPeriodFiling.findMany({ where: entityScope, select: { entityId: true, period: true }, orderBy: { period: 'asc' } }),
    prisma.exchangeRate.findMany({ where: entityScope, orderBy: [{ date: 'desc' }, { base: 'asc' }] }),
    prisma.bankAccount.findMany({ where: entityScope, include: { account: { select: { code: true, name: true } } }, orderBy: { createdAt: 'asc' } }),
    prisma.revaluation.findMany({
      where: entityScope,
      include: { journalEntry: { include: journalLinesInclude }, reversalEntry: { include: journalLinesInclude } },
      orderBy: { period: 'desc' },
    }),
    sectionsLoaded,
  ]);

  const entityIds = entities.map((entity) => entity.id);
  const withAllEntities = <T>(grouped: Record<string, T[]>): Record<string, T[]> =>
    Object.fromEntries(entityIds.map((id) => [id, grouped[id] ?? []]));

  const periodsByEntity = groupBy(filings, (filing) => filing.entityId);

  // Only the sections this screen reads were loaded; the rest are empty.
  const sectionData = Object.assign({}, ...loaded) as AllSections;

  return {
    screen,
    currentUser: {
      id: principal.userId,
      name: principal.name,
      email: principal.email,
      role: principal.role,
      roleLabel: roleLabels[principal.role],
      permissions: permissions.filter((permission) => can(principal, permission)),
    },
    // False only when PII_ENCRYPTION_KEY is unset. Numbers then read as blank,
    // and the interface has to say why rather than look like there are none.
    encryptionConfigured: encryptionConfigured(),
    entities: entities.map(entityRecord),
    contacts: contacts.map(contactRecord),
    accountsByEntity: withAllEntities(groupBy(accounts.map(accountRecord), (account) => account.entityId)),
    fundsByEntity: withAllEntities(groupBy(funds.map(fundRecord), (fund) => fund.entityId)),
    projectsByEntity: withAllEntities(groupBy(projects.map(projectRecord), (project) => project.entityId)),
    documentsByEntity: withAllEntities(groupBy(documents.map(documentRecord), (document) => document.entityId)),
    filedPeriodsByEntity: Object.fromEntries(
      entityIds.map((id) => [id, (periodsByEntity[id] ?? []).map((filing) => filing.period)]),
    ),
    ratesByEntity: withAllEntities(groupBy(rates.map((row) => ({ entityId: row.entityId, ...exchangeRateRow(row) })), (row) => row.entityId)),
    bankAccountsByEntity: withAllEntities(groupBy(bankAccounts.map(bankAccountRecord), (account) => account.entityId)),
    revaluationsByEntity: withAllEntities(groupBy(revaluations.map((row) => ({ entityId: row.entityId, ...revaluationRecord(row) })), (row) => row.entityId)),
    ...sectionData,
  };
}
