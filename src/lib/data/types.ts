/**
 * Plain data shapes shared by the server (readers, server functions, seed)
 * and the client shell. Everything here is JSON-safe: strings, numbers,
 * booleans — never bigint, never Date. Amounts are integer pesewas.
 */

import type { ContactCategory, ContactType, FundClassification, WithholdingTaxStatus } from './enums';

export type { ContactCategory, ContactType, FundClassification, WithholdingTaxStatus };

export type EntityType = 'manufacturing' | 'programs';

export type EntityRecord = {
  id: string;
  code: string;
  name: string;
  type: EntityType;
  financialYearEnd: string;
  vatRegistered: boolean;
  tin: string;
  accent: string;
};

export type ContactRecord = {
  id: string;
  name: string;
  type: ContactType;
  category: ContactCategory;
  tin: string;
  phone: string;
  email: string;
  address: string;
  withholdingTaxStatus: WithholdingTaxStatus;
  isFarmerAggregator: boolean;
  isActive: boolean;
  /** Balance with each entity, keyed by entity id. Absent means no dealings. */
  balances: Record<string, number>;
};

export type AccountClass = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'COST_OF_SALES' | 'EXPENSE';

export type AccountRecord = {
  id: string;
  entityId: string;
  code: string;
  name: string;
  type: AccountClass;
  parentCode: string | null;
  isActive: boolean;
};

export type FundRecord = {
  id: string;
  entityId: string;
  code: string;
  name: string;
  classification: FundClassification;
  funder: string;
  isActive: boolean;
};

export type ProjectRecord = {
  id: string;
  entityId: string;
  code: string;
  name: string;
  funder: string;
  fundId: string | null;
  fundClassification: FundClassification | null;
  budget: number;
  isActive: boolean;
};

export type AuditEventRecord = {
  id: string;
  entityId: string;
  sequence: number;
  userName: string;
  action: string;
  resourceType: string;
  resourceRef: string;
  summary: string;
  createdAt: string;
};
