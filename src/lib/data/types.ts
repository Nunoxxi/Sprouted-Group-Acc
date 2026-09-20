/**
 * Plain data shapes shared by the server (readers, server functions, seed)
 * and the client shell. Everything here is JSON-safe: strings, numbers,
 * booleans — never bigint, never Date. Amounts are integer pesewas.
 */

import type { Permission, Role } from '../authz';
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

export type DocumentKind = 'invoice' | 'bill';
export type DocumentStatus = 'draft' | 'awaiting-payment' | 'paid' | 'voided';
export type VatTreatment = 'standard' | 'zero-rated' | 'exempt';

export type DocumentLineRecord = {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  accountCode: string;
  vatTreatment: VatTreatment;
  projectId: string | null;
  fundId: string | null;
};

export type PostedJournalLine = {
  accountCode: string;
  accountName: string;
  amount: number;
  type: 'debit' | 'credit';
};

export type PostedJournal = {
  id: string;
  kind: 'DOCUMENT' | 'REVERSAL' | 'MANUAL';
  postedAt: string; // YYYY-MM-DD
  lines: PostedJournalLine[];
};

export type DocumentRecord = {
  id: string;
  entityId: string;
  kind: DocumentKind;
  /** Empty while a draft; allocated by the server on posting. */
  docNumber: string;
  contactId: string;
  contactName: string;
  date: string;
  dueDate: string;
  status: DocumentStatus;
  lines: DocumentLineRecord[];
  evatClearanceNumber: string;
  evatQrCode: string;
  evatTimestamp: string;
  /** The persisted journal once posted; null for drafts. */
  journal: PostedJournal | null;
  /** The reversing journal once voided; null otherwise. */
  voidJournal: PostedJournal | null;
  updatedAt: string;
};

/**
 * The signed-in person as the browser may know them. `permissions` drives
 * what the UI offers; the server re-checks every one of them.
 */
export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  roleLabel: string;
  permissions: Permission[];
};

/** Everything the shell needs on first render, loaded once by the page. */
export type InitialData = {
  currentUser: CurrentUser;
  /** Only the entities the signed-in user may see. */
  entities: EntityRecord[];
  contacts: ContactRecord[];
  accountsByEntity: Record<string, AccountRecord[]>;
  fundsByEntity: Record<string, FundRecord[]>;
  projectsByEntity: Record<string, ProjectRecord[]>;
  documentsByEntity: Record<string, DocumentRecord[]>;
  filedPeriodsByEntity: Record<string, string[]>;
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
