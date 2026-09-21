/**
 * Plain data shapes shared by the server (readers, server functions, seed)
 * and the client shell. Everything here is JSON-safe: strings, numbers,
 * booleans — never bigint, never Date. Amounts are integer pesewas.
 */

import type { Permission, Role } from '../authz';
import type { Currency } from '../fx';
import type { AdjustmentReason, ItemCategory, StockUnit } from '../inventory';
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
  /** YYYY-MM-DD from which VAT applies; null while unregistered. */
  vatRegisteredFrom: string | null;
  tin: string;
  /** Sender for this entity's invitations and resets; empty means the group default. */
  emailFrom: string;
  accent: string;
  /** The currency the books are kept in. Per entity. */
  functionalCurrency: Currency;
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
  /** Chart tag: 'tax', 'fx', 'inventory', 'inventory-adjustment', or null. */
  category: string | null;
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
export type SaleType = 'domestic' | 'export';

export type DocumentLineRecord = {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  accountCode: string;
  vatTreatment: VatTreatment;
  projectId: string | null;
  fundId: string | null;
  /** Bills: the stock item received by this line and where; quantity is then in the item's base unit. */
  itemId: string | null;
  locationId: string | null;
};

export type PostedJournalLine = {
  accountCode: string;
  accountName: string;
  /** Functional amount, minor units — what the ledger balances in. */
  amount: number;
  type: 'debit' | 'credit';
  currency: Currency;
  /** Amount in the transaction currency, minor units. */
  txnAmount: number;
  /** The rate that was applied at posting; '1.0' for functional-currency lines. */
  rate: string;
};

export type PostedJournal = {
  id: string;
  kind: 'DOCUMENT' | 'REVERSAL' | 'MANUAL' | 'PAYMENT' | 'REVALUATION' | 'STOCK';
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
  currency: Currency;
  /** Rate fixed at posting; while a draft, the last saved default/override. Null until a rate is chosen. */
  rate: string | null;
  rateDate: string | null;
  rateExact: boolean;
  /** Settled so far, in the document currency. */
  paidTxnMinor: number;
  /** Invoices: domestic or export. Bills are always 'domestic'. */
  saleType: SaleType;
  /** Bills: import VAT paid at the point of entry, document currency minor units. */
  importVat: number;
  /** Whether VAT was calculated on this document. Fixed at posting; while a draft, the current answer for its date. */
  vatApplied: boolean;
  lines: DocumentLineRecord[];
  payments: PaymentRecord[];
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

export type PaymentRecord = {
  id: string;
  date: string;
  bankAccountId: string;
  bankAccountName: string;
  bankCurrency: Currency;
  txnAmount: number;
  rate: string;
  bankAmount: number;
  bankFunctionalAmount: number;
  reliefAmount: number;
  /** Positive = realised gain, negative = loss, functional currency. */
  gainLoss: number;
  journal: PostedJournal | null;
};

export type ExchangeRateRow = {
  id: string;
  base: Currency;
  quote: Currency;
  date: string;
  rate: string;
  source: string;
};

export type BankAccountRecord = {
  id: string;
  entityId: string;
  name: string;
  currency: Currency;
  accountCode: string;
  accountName: string;
  isActive: boolean;
};

export type RevaluationRecord = {
  id: string;
  period: string;
  closingRates: Partial<Record<Currency, string>>;
  journal: PostedJournal;
  reversalJournal: PostedJournal | null;
  createdAt: string;
};

/** Everything the shell needs on first render, loaded once by the page. */
// --- inventory ---------------------------------------------------------------

export type ItemRecord = {
  id: string;
  entityId: string;
  code: string;
  name: string;
  category: ItemCategory;
  baseUnit: StockUnit;
  gramsPerBag: number | null;
  gramsPerCarton: number | null;
  accountCode: string;
  accountName: string;
  isActive: boolean;
};

export type StockLocationRecord = {
  id: string;
  entityId: string;
  code: string;
  name: string;
  /** Account override for stock held here, or null for the item's own. */
  accountCode: string | null;
  isActive: boolean;
};

export type StockBalanceRecord = {
  itemId: string;
  locationId: string;
  quantityGrams: number;
  valueMinor: number;
};

export type StockMovementRecord = {
  id: string;
  entityId: string;
  kind: 'receipt' | 'receipt-reversal' | 'transfer' | 'adjustment' | 'write-down';
  date: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  fromLocationId: string | null;
  toLocationId: string | null;
  quantityGrams: number;
  valueMinor: number;
  reason: AdjustmentReason | null;
  note: string;
  documentId: string | null;
  stockCountId: string | null;
  journal: PostedJournal | null;
  createdByName: string;
  createdAt: string;
};

export type StockCountLineRecord = {
  itemId: string;
  expectedGrams: number;
  countedGrams: number | null;
};

export type StockCountRecord = {
  id: string;
  entityId: string;
  locationId: string;
  date: string;
  status: 'draft' | 'posted';
  note: string;
  lines: StockCountLineRecord[];
  journal: PostedJournal | null;
  createdByName: string;
  postedByName: string | null;
  postedAt: string | null;
};

export type NrvPriceRecord = {
  itemId: string;
  period: string;
  sellingPriceMinorPerKg: number;
};

/** Ledger balance of one inventory account, from the real journal lines. */
export type InventoryLedgerRow = { accountCode: string; accountName: string; balanceMinor: number };

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
  ratesByEntity: Record<string, ExchangeRateRow[]>;
  bankAccountsByEntity: Record<string, BankAccountRecord[]>;
  revaluationsByEntity: Record<string, RevaluationRecord[]>;
  itemsByEntity: Record<string, ItemRecord[]>;
  locationsByEntity: Record<string, StockLocationRecord[]>;
  stockBalancesByEntity: Record<string, StockBalanceRecord[]>;
  stockMovementsByEntity: Record<string, StockMovementRecord[]>;
  stockCountsByEntity: Record<string, StockCountRecord[]>;
  nrvPricesByEntity: Record<string, NrvPriceRecord[]>;
  inventoryLedgerByEntity: Record<string, InventoryLedgerRow[]>;
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
