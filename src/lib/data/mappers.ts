/**
 * Prisma rows → plain records. The only place a Prisma row is turned into
 * something the rest of the app may hold, and the only place bigint becomes
 * number (via toMinor).
 */

import type { Account, AuditEvent, Contact, ContactEntityBalance, Entity, Fund, Project } from '@prisma/client';

import {
  contactCategoryToPrisma,
  contactCategoryToRecord,
  contactTypeToPrisma,
  contactTypeToRecord,
  fundClassToPrisma,
  fundClassToRecord,
  whtToPrisma,
  whtToRecord,
} from './enums';
import { normalizeRate } from '../fx';
import { decryptField } from '../pii-crypto';
import { toMinor } from './money';
import type {
  AccountRecord,
  AuditEventRecord,
  ContactRecord,
  EntityRecord,
  EntityType,
  FundRecord,
  ProjectRecord,
} from './types';

export const toPrismaEnum = {
  contactType: contactTypeToPrisma,
  contactCategory: contactCategoryToPrisma,
  withholdingTaxStatus: whtToPrisma,
  fundClassification: fundClassToPrisma,
} as const;

export function entityTypeOf(raw: string): EntityType {
  return raw === 'programs' ? 'programs' : 'manufacturing';
}

export function entityRecord(row: Entity): EntityRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: entityTypeOf(row.type),
    financialYearEnd: row.financialYearEnd ?? '',
    vatRegistered: row.vatRegistered,
    vatRegisteredFrom: row.vatRegisteredFrom ? row.vatRegisteredFrom.toISOString().slice(0, 10) : null,
    tin: row.tin ?? '',
    emailFrom: row.emailFrom ?? '',
    accent: row.accent ?? '',
    functionalCurrency: row.functionalCurrency,
    floatAgeLimitDays: row.floatAgeLimitDays,
    taxStatus: row.taxStatus === 'EXEMPT' ? 'exempt' : row.taxStatus === 'SPECIAL_RATE' ? 'special-rate' : 'taxable',
    payeDueDay: row.payeDueDay,
    ssnitDueDay: row.ssnitDueDay,
    lbcMode: row.lbcMode,
    revenuePresentation: row.revenuePresentation === 'NET' ? 'net' : 'gross',
    producerPriceMinorPerKg: row.producerPriceMinorPerKg === null ? null : toMinor(row.producerPriceMinorPerKg),
    buyerMarginMinorPerKg: row.buyerMarginMinorPerKg === null ? null : toMinor(row.buyerMarginMinorPerKg),
    haulageMinorPerKg: row.haulageMinorPerKg === null ? null : toMinor(row.haulageMinorPerKg),
    cutOverDate: row.cutOverDate ? row.cutOverDate.toISOString().slice(0, 10) : null,
    liveAt: row.liveAt ? row.liveAt.toISOString() : null,
  };
}

/** Prisma Decimal → the canonical rate string the app uses everywhere. */
export function rateText(value: { toString(): string } | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return normalizeRate(value.toString());
}

export function contactRecord(row: Contact & { balances: ContactEntityBalance[] }): ContactRecord {
  const balances: Record<string, number> = {};
  for (const balance of row.balances) {
    balances[balance.entityId] = toMinor(balance.balanceMinor);
  }

  return {
    id: row.id,
    name: row.name,
    type: contactTypeToRecord[row.type],
    category: contactCategoryToRecord[row.category],
    tin: row.tin ?? '',
    phone: decryptField('Contact.phone', row.phone) ?? '',
    email: decryptField('Contact.email', row.email) ?? '',
    address: decryptField('Contact.address', row.address) ?? '',
    withholdingTaxStatus: whtToRecord[row.withholdingTaxStatus],
    isActive: row.isActive,
    balances,
  };
}

export function accountRecord(row: Account & { parent?: Pick<Account, 'code'> | null }): AccountRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    code: row.code,
    name: row.name,
    type: row.type,
    parentCode: row.parent?.code ?? null,
    category: row.category ?? null,
    isActive: row.isActive,
  };
}

export function fundRecord(row: Fund): FundRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    code: row.code,
    name: row.name,
    classification: fundClassToRecord[row.classification],
    funder: row.funder ?? '',
    isActive: row.isActive,
  };
}

export function projectRecord(row: Project & { fund?: Pick<Fund, 'classification'> | null }): ProjectRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    code: row.code,
    name: row.name,
    funder: row.funder ?? '',
    funderContactId: row.funderContactId,
    fundId: row.fundId,
    fundClassification: row.fund ? fundClassToRecord[row.fund.classification] : null,
    kind: row.kind === 'SERVICE_CONTRACT' ? 'service-contract' : 'grant-funded',
    currency: row.currency,
    fundingMinor: toMinor(row.fundingMinor),
    startDate: row.startDate ? row.startDate.toISOString().slice(0, 10) : null,
    endDate: row.endDate ? row.endDate.toISOString().slice(0, 10) : null,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    budget: toMinor(row.budgetMinor),
    isActive: row.isActive,
  };
}

export function auditEventRecord(row: AuditEvent): AuditEventRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    sequence: row.sequence,
    userName: row.userName,
    action: row.action,
    resourceType: row.resourceType,
    resourceRef: row.resourceRef,
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
  };
}
