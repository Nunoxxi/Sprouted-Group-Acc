/**
 * Plain data shapes shared by the server (readers, server functions, seed)
 * and the client shell. Everything here is JSON-safe: strings, numbers,
 * booleans — never bigint, never Date. Amounts are integer pesewas.
 */

import type { Permission, Role } from '../authz';
import type { Currency } from '../fx';
import type { AdjustmentReason, ItemCategory, StockUnit } from '../inventory';
import type { CommodityKind, LandedCostKind, Quality } from '../trading';
import type { PriceUnit, SellingCostKind } from '../contracts';
import type { ControlReconciliation, OpeningSection } from '../opening';
import type { BankAccountKind } from '../momo';
import type { GrantActual, InKindKind, IncomePolicy, ReportingFrequency } from '../grants';
import type { Flow, RecurringFrequency } from '../cashflow';
import type { AdjustmentKind, AllowanceMethod, DepreciationMethod, TaxStatus } from '../assets';
import type { LiabilityKind } from '../payroll';
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
  /** An agent's open float older than this many days is flagged. */
  floatAgeLimitDays: number;
  /** Whether this entity has a tax computation at all, and at whose rate. */
  taxStatus: TaxStatus;
  /** The day of the following month PAYE and SSNIT fall due. Settings. */
  payeDueDay: number;
  ssnitDueDay: number;
  /** COCOBOD Licensed Buying Company mode and its settings. */
  lbcMode: boolean;
  revenuePresentation: 'gross' | 'net';
  producerPriceMinorPerKg: number | null;
  buyerMarginMinorPerKg: number | null;
  haulageMinorPerKg: number | null;
  /** Opening balances are dated here; null until chosen. */
  cutOverDate: string | null;
  /** Set when the entity goes live; imports are refused after it. */
  liveAt: string | null;
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
  /** Bills: a charge capitalised into stock, spread per kg over the lots listed. */
  landedCostKind: LandedCostKind | null;
  landedCostLotIds: string[];
  /** Bills: origin and quality of the lot a stock line creates. */
  lotRef: string;
  community: string;
  district: string;
  quality: Quality;
  /** Bills: a selling cost attributed to a sales contract. */
  contractId: string | null;
  sellingCostKind: SellingCostKind | null;
  /** Bills: expenditure charged to a grant, always with the budget line it comes out of. */
  grantId: string | null;
  budgetLineId: string | null;
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
  kind: 'DOCUMENT' | 'REVERSAL' | 'MANUAL' | 'PAYMENT' | 'REVALUATION' | 'STOCK' | 'CONTRACT' | 'OPENING';
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
  /** A mobile money wallet is a bank account; it reconciles the same way. */
  kind: BankAccountKind;
  provider: string;
  number: string;
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
  /** The commodity this item is a grade of, for trading entities. */
  commodityId: string | null;
  grade: string;
  isActive: boolean;
};

export type CommodityRecord = {
  id: string;
  entityId: string;
  code: string;
  name: string;
  kind: CommodityKind;
  gramsPerBag: number;
  shrinkageTolerancePct: number;
  isActive: boolean;
};

export type LotRecord = {
  id: string;
  entityId: string;
  commodityId: string;
  itemId: string;
  locationId: string;
  lotRef: string;
  date: string;
  supplierContactId: string | null;
  supplierName: string;
  farmerName: string;
  community: string;
  district: string;
  quality: Quality;
  gramsIn: number;
  gramsShrunk: number;
  landedCostMinor: number;
  documentId: string | null;
  agentPurchaseId: string | null;
  note: string;
  createdByName: string;
};

export type BuyingAgentRecord = {
  id: string;
  entityId: string;
  name: string;
  phone: string;
  defaultLocationId: string | null;
  isActive: boolean;
};

export type FloatReturnRecord = { id: string; date: string; amountMinor: number; bankAccountId: string; journal: PostedJournal | null };

export type FloatAdvanceRecord = {
  id: string;
  entityId: string;
  agentId: string;
  date: string;
  amountMinor: number;
  bankAccountId: string | null;
  /** True for an opening balance: the cash left before the cut-over date, so there is no bank movement. */
  isOpening: boolean;
  status: 'open' | 'reconciled';
  journal: PostedJournal | null;
  returns: FloatReturnRecord[];
  /** Posted purchases charged to this float, minor units. */
  purchasedMinor: number;
  reconciledAt: string | null;
  reconciledByName: string | null;
  createdByName: string;
};

export type AgentPurchaseRecord = {
  id: string;
  entityId: string;
  agentId: string;
  floatId: string | null;
  clientRef: string;
  date: string;
  farmerName: string;
  community: string;
  district: string;
  itemId: string;
  locationId: string;
  bags: number | null;
  grams: number;
  priceMinor: number;
  paymentMethod: 'cash' | 'mobile-money';
  /** Paid by the agent from the float now, or payable to the farmer and settled in a batch later. */
  settlement: 'float' | 'payable';
  farmerId: string | null;
  /** Fixed at posting: advance recovered here, and the net due to the farmer. */
  recoveredMinor: number;
  payableMinor: number;
  /** Paid so far against this purchase: the whole net when the agent paid it, otherwise what batches have cleared. */
  paidMinor: number;
  /** What the farmer still owes on their advances after this purchase's recovery. */
  advanceRemainingMinor: number;
  paymentRef: string;
  evidenceKind: 'signature' | 'thumbprint' | 'reference' | null;
  evidenceAt: string | null;
  quality: Quality;
  note: string;
  status: 'pending' | 'posted' | 'rejected';
  rejectReason: string;
  lotId: string | null;
  journal: PostedJournal | null;
  syncedAt: string;
  createdByName: string;
  postedByName: string | null;
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
  kind: 'receipt' | 'receipt-reversal' | 'transfer' | 'adjustment' | 'write-down' | 'landed-cost' | 'shrinkage' | 'delivery';
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
  lotId: string | null;
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

// --- sales contracts ----------------------------------------------------------

export type ContractDeliveryRecord = {
  id: string;
  contractId: string;
  deliveryNo: number;
  date: string;
  locationId: string;
  grams: number;
  destination: string;
  rate: string;
  revenueTxnMinor: number;
  revenueMinor: number;
  costMinor: number;
  marginMinor: number;
  haulageMinor: number;
  status: 'delivered' | 'awaiting-acceptance' | 'accepted' | 'before-cutover';
  journal: PostedJournal | null;
  acceptanceJournal: PostedJournal | null;
  acceptedAt: string | null;
  note: string;
  createdByName: string;
};

export type ContractSellingCostRecord = { id: string; kind: SellingCostKind; description: string; date: string; amountMinor: number; documentId: string | null };

export type SalesContractRecord = {
  id: string;
  entityId: string;
  contractNo: string;
  buyerContactId: string;
  buyerName: string;
  commodityId: string;
  itemId: string;
  quantityGrams: number;
  priceMinor: number;
  priceUnit: PriceUnit;
  currency: Currency;
  contractRate: string | null;
  deliveryTerms: string;
  deliveryFrom: string;
  deliveryTo: string;
  recognizeOn: 'delivery' | 'acceptance';
  saleType: 'domestic' | 'export';
  isCmc: boolean;
  status: 'open' | 'closed' | 'cancelled';
  note: string;
  deliveries: ContractDeliveryRecord[];
  sellingCosts: ContractSellingCostRecord[];
  createdByName: string;
};

export type SeedFundRecord = { id: string; kind: 'received' | 'repaid' | 'offset'; date: string; amountMinor: number; bankAccountId: string | null; journal: PostedJournal | null; note: string };

// --- opening balances -----------------------------------------------------------

export type OpeningBatchRecord = {
  id: string;
  section: OpeningSection;
  fileName: string;
  rowCount: number;
  status: 'draft' | 'posted';
  postedAt: string | null;
  createdByName: string;
  createdAt: string;
  /** The parsed rows, for the preview. */
  rows: unknown[];
};

export type OpeningStatusRecord = {
  cutOverDate: string | null;
  liveAt: string | null;
  batches: OpeningBatchRecord[];
  controls: ControlReconciliation[];
  trialBalancePosted: boolean;
  suspenseMinor: number;
  contractsPosted: boolean;
  contractsCount: number;
};

/** Ledger balance of one inventory account, from the real journal lines. */
export type InventoryLedgerRow = { accountCode: string; accountName: string; balanceMinor: number };

export type FarmerRecord = {
  id: string;
  entityId: string;
  name: string;
  phone: string;
  community: string;
  district: string;
  walletNumber: string;
  isActive: boolean;
  /** Advanced less recovered: what the farmer owes. */
  advanceOutstandingMinor: number;
  /** Payable less paid: what is owed to the farmer. */
  payableOutstandingMinor: number;
  deliveries: number;
  gramsTotal: number;
  grossMinor: number;
};

export type FarmerAdvanceRecord = {
  id: string;
  entityId: string;
  farmerId: string | null;
  farmerName: string;
  community: string;
  district: string;
  date: string;
  amountMinor: number;
  settledMinor: number;
  status: 'open' | 'settled';
  note: string;
  journal: PostedJournal | null;
};

export type FarmerPaymentRecord = {
  id: string;
  farmerId: string;
  farmerName: string;
  purchaseId: string | null;
  amountMinor: number;
  walletNumber: string;
  paymentRef: string;
};

export type PaymentBatchRecord = {
  id: string;
  entityId: string;
  reference: string;
  date: string;
  bankAccountId: string;
  bankAccountName: string;
  status: 'draft' | 'exported' | 'paid';
  totalMinor: number;
  feeMinor: number;
  exportedAt: string | null;
  paidAt: string | null;
  note: string;
  payments: FarmerPaymentRecord[];
  journal: PostedJournal | null;
  createdByName: string;
};

export type StatementMappingRecord = {
  id: string;
  entityId: string;
  name: string;
  dateColumn: string;
  descriptionColumn: string;
  referenceColumn: string;
  amountColumn: string;
  moneyInColumn: string;
  moneyOutColumn: string;
  feeColumn: string;
  levyColumn: string;
  balanceColumn: string;
  chargeKeywords: string;
  dateFormat: string;
};

export type StatementLineRecord = {
  id: string;
  entityId: string;
  importId: string;
  bankAccountId: string;
  date: string;
  description: string;
  reference: string;
  /** Signed, net of the fee and levy, which went to charges. */
  amountMinor: number;
  feeMinor: number;
  levyMinor: number;
  balanceMinor: number | null;
  status: 'unmatched' | 'matched' | 'charge';
  matchedBatchId: string | null;
  note: string;
};

export type StatementImportRecord = {
  id: string;
  entityId: string;
  bankAccountId: string;
  bankAccountName: string;
  mappingName: string;
  fileName: string;
  fromDate: string | null;
  toDate: string | null;
  lineCount: number;
  feeMinor: number;
  createdAt: string;
  createdByName: string;
  lines: StatementLineRecord[];
};

export type GrantBudgetLineRecord = {
  id: string;
  grantId: string;
  code: string;
  name: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  /** In the donor's currency. */
  budgetMinor: number;
  note: string;
};

export type GrantConditionRecord = {
  id: string;
  grantId: string;
  description: string;
  dueDate: string | null;
  metAt: string | null;
  metByName: string;
  note: string;
  /** Deferred income released because this condition was met. */
  releasedMinor: number;
};

export type GrantReceiptRecord = {
  id: string;
  grantId: string;
  date: string;
  txnCurrency: Currency;
  txnAmountMinor: number;
  rate: string;
  /** In our functional currency: what actually reached the books. */
  amountMinor: number;
  bankAccountId: string;
  bankAccountName: string;
  reference: string;
  journal: PostedJournal | null;
};

export type GrantReleaseRecord = {
  id: string;
  grantId: string;
  date: string;
  amountMinor: number;
  basis: 'spending' | 'condition';
  conditionId: string | null;
  note: string;
  journal: PostedJournal | null;
};

export type GrantRecord = {
  id: string;
  entityId: string;
  code: string;
  name: string;
  donorContactId: string;
  donorName: string;
  fundId: string | null;
  fundName: string;
  projectId: string | null;
  /** The donor's currency: the award and every budget line are in it. */
  currency: Currency;
  amountMinor: number;
  /** Functional units per one unit of the donor's currency, fixed at award. */
  rate: string;
  startDate: string;
  endDate: string;
  restricted: boolean;
  incomePolicy: IncomePolicy;
  reportingFrequency: ReportingFrequency;
  reportingStartDate: string | null;
  reportingDueDays: number;
  underspendThresholdPct: number;
  status: 'draft' | 'active' | 'closed';
  note: string;
  budgetLines: GrantBudgetLineRecord[];
  conditions: GrantConditionRecord[];
  receipts: GrantReceiptRecord[];
  releases: GrantReleaseRecord[];
  /** Totals read from the ledger and the detail, in functional currency. */
  receivedMinor: number;
  releasedMinor: number;
  spentMinor: number;
  inKindMinor: number;
  staffTimeMinor: number;
  createdByName: string;
};

export type InKindRecord = {
  id: string;
  entityId: string;
  grantId: string | null;
  budgetLineId: string | null;
  date: string;
  description: string;
  kind: InKindKind;
  valueMinor: number;
  basis: string;
  donorContactId: string | null;
  donorName: string;
  journal: PostedJournal | null;
};

export type StaffTimeRecord = {
  id: string;
  entityId: string;
  grantId: string;
  budgetLineId: string | null;
  personName: string;
  role: string;
  periodStart: string;
  periodEnd: string;
  hours: number;
  rateMinorPerHour: number;
  valueMinor: number;
  accountCode: string;
  note: string;
  posted: boolean;
};

export type BuyingSeasonRecord = {
  id: string;
  entityId: string;
  commodityId: string;
  commodityName: string;
  name: string;
  startDate: string;
  peakDate: string;
  endDate: string;
  expectedGrams: number;
  priceMinorPerKg: number;
  currency: Currency;
  note: string;
  isActive: boolean;
};

export type RecurringCostRecord = {
  id: string;
  entityId: string;
  name: string;
  currency: Currency;
  amountMinor: number;
  frequency: RecurringFrequency;
  startDate: string;
  endDate: string | null;
  accountCode: string;
  note: string;
  isActive: boolean;
};

export type CashScenarioLineRecord = {
  id: string;
  scenarioId: string;
  date: string;
  currency: Currency;
  amountMinor: number;
  description: string;
};

export type CashScenarioRecord = {
  id: string;
  entityId: string;
  name: string;
  isBaseline: boolean;
  collectionDelayDays: number;
  pricePct: number;
  volumePct: number;
  floatLeadDays: number;
  minimumCashMinor: number;
  note: string;
  /** Currency → functional units per one unit of it. */
  rates: Record<string, string>;
  lines: CashScenarioLineRecord[];
};

/**
 * Everything a forecast is built from, for one entity: the cash it starts
 * with and every flow the records already imply. The forecast itself is
 * computed in the browser from these, so changing a scenario's assumptions
 * redraws it without another round trip.
 */
export type CashSourceRecord = {
  entityId: string;
  entityName: string;
  functionalCurrency: Currency;
  /** Bank and cash balances now, per currency. */
  openings: Record<string, number>;
  /** Flows that do not depend on a scenario's assumptions. */
  fixedFlows: Flow[];
  /** Seasons, as records: their flows depend on the price and volume assumed. */
  seasons: BuyingSeasonRecord[];
  recurring: RecurringCostRecord[];
  /** Open invoices and bills, and undelivered contracts: the dates shift with the collection delay. */
  documents: { id: string; kind: 'invoice' | 'bill'; number: string; contactName: string; currency: Currency; outstandingMinor: number; dueDate: string }[];
  contracts: { id: string; contractNo: string; buyerName: string; currency: Currency; undeliveredMinor: number; deliveryDate: string; paymentTermsDays: number }[];
};

export type FixedAssetRecord = {
  id: string;
  entityId: string;
  code: string;
  description: string;
  category: string;
  purchaseDate: string;
  inServiceDate: string;
  costMinor: number;
  residualMinor: number;
  usefulLifeMonths: number;
  method: DepreciationMethod;
  supplierContactId: string | null;
  supplierName: string;
  location: string;
  custodian: string;
  serialNumber: string;
  allowanceClassId: string | null;
  allowanceClassName: string;
  note: string;
  status: 'in-use' | 'disposed';
  /** Opening plus everything posted since. */
  accumulatedMinor: number;
  bookValueMinor: number;
  /** Set once the asset has gone. */
  disposal: { date: string; proceedsMinor: number; bookValueMinor: number; gainLossMinor: number; note: string } | null;
};

export type DepreciationRunRecord = {
  id: string;
  entityId: string;
  period: string;
  totalMinor: number;
  postedAt: string;
  postedByName: string;
  journal: PostedJournal | null;
  lines: { assetId: string; assetCode: string; description: string; amountMinor: number }[];
};

export type AllowanceClassRecord = {
  id: string;
  entityId: string;
  code: string;
  name: string;
  ratePct: string;
  method: AllowanceMethod;
  note: string;
  isActive: boolean;
};

export type TaxAdjustmentRecord = { id: string; kind: AdjustmentKind; description: string; amountMinor: number; note: string };

export type ProvisionalPaymentRecord = { id: string; quarter: number; date: string; amountMinor: number; bankAccountId: string; bankAccountName: string; reference: string; journal: PostedJournal | null };

export type TaxYearRecord = {
  id: string;
  entityId: string;
  label: string;
  startDate: string;
  endDate: string;
  ratePct: string;
  lossBroughtForwardMinor: number;
  estimatedLiabilityMinor: number;
  taxChargeMinor: number | null;
  postedAt: string | null;
  note: string;
  adjustments: TaxAdjustmentRecord[];
  /** Written-down value brought into the year, per class. */
  pools: { classId: string; openingMinor: number }[];
  provisional: ProvisionalPaymentRecord[];
  /** Read from the ledger for the year: the surplus, and the depreciation in it. */
  accountingProfitMinor: number;
  depreciationMinor: number;
  /** Read from the register for the year. */
  additionsByClass: Record<string, number>;
  disposalProceedsByClass: Record<string, number>;
  straightLineCostByClass: Record<string, number>;
};

export type PayrollMappingRecord = {
  id: string;
  entityId: string;
  name: string;
  employeeRefColumn: string;
  employeeNameColumn: string;
  departmentColumn: string;
  grossColumn: string;
  payeColumn: string;
  employeeSsnitColumn: string;
  employerSsnitColumn: string;
  ssnitTier2Column: string;
  otherDeductionsColumn: string;
  netColumn: string;
  defaultAccountCode: string;
};

export type PayrollDepartmentRecord = { id: string; entityId: string; name: string; accountCode: string; accountName: string };

export type PayrollLineRecord = {
  id: string;
  employeeRef: string;
  employeeName: string;
  department: string;
  grossMinor: number;
  payeMinor: number;
  employeeSsnitMinor: number;
  employerSsnitMinor: number;
  ssnitTier2Minor: number;
  otherDeductionsMinor: number;
  netMinor: number;
};

export type PayrollLiabilityRecord = {
  id: string;
  runId: string;
  period: string;
  kind: LiabilityKind;
  amountMinor: number;
  settledMinor: number;
  dueDate: string;
  payments: { id: string; date: string; amountMinor: number; bankAccountName: string; reference: string }[];
};

export type PayrollRunRecord = {
  id: string;
  entityId: string;
  period: string;
  payDate: string;
  mappingName: string;
  fileName: string;
  grossMinor: number;
  payeMinor: number;
  employeeSsnitMinor: number;
  employerSsnitMinor: number;
  ssnitTier2Minor: number;
  otherDeductionsMinor: number;
  netMinor: number;
  employerCostMinor: number;
  status: 'draft' | 'posted';
  note: string;
  postedAt: string | null;
  postedByName: string;
  journal: PostedJournal | null;
  lines: PayrollLineRecord[];
  liabilities: PayrollLiabilityRecord[];
};

/** How much of one person's cost each grant carries. Set once, used every month. */
export type PayrollAllocationRecord = {
  id: string;
  entityId: string;
  employeeKey: string;
  employeeName: string;
  grantId: string;
  grantCode: string;
  budgetLineId: string | null;
  budgetLineName: string;
  pct: string;
};

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
  commoditiesByEntity: Record<string, CommodityRecord[]>;
  lotsByEntity: Record<string, LotRecord[]>;
  agentsByEntity: Record<string, BuyingAgentRecord[]>;
  floatsByEntity: Record<string, FloatAdvanceRecord[]>;
  agentPurchasesByEntity: Record<string, AgentPurchaseRecord[]>;
  contractsByEntity: Record<string, SalesContractRecord[]>;
  seedFundsByEntity: Record<string, SeedFundRecord[]>;
  openingByEntity: Record<string, OpeningStatusRecord>;
  farmersByEntity: Record<string, FarmerRecord[]>;
  farmerAdvancesByEntity: Record<string, FarmerAdvanceRecord[]>;
  paymentBatchesByEntity: Record<string, PaymentBatchRecord[]>;
  statementMappingsByEntity: Record<string, StatementMappingRecord[]>;
  statementImportsByEntity: Record<string, StatementImportRecord[]>;
  grantsByEntity: Record<string, GrantRecord[]>;
  /** Every posting attributed to a grant, for budget against actual. */
  grantActualsByEntity: Record<string, (GrantActual & { grantId: string })[]>;
  inKindByEntity: Record<string, InKindRecord[]>;
  staffTimeByEntity: Record<string, StaffTimeRecord[]>;
  seasonsByEntity: Record<string, BuyingSeasonRecord[]>;
  recurringByEntity: Record<string, RecurringCostRecord[]>;
  scenariosByEntity: Record<string, CashScenarioRecord[]>;
  cashSourcesByEntity: Record<string, CashSourceRecord>;
  assetsByEntity: Record<string, FixedAssetRecord[]>;
  depreciationRunsByEntity: Record<string, DepreciationRunRecord[]>;
  allowanceClassesByEntity: Record<string, AllowanceClassRecord[]>;
  taxYearsByEntity: Record<string, TaxYearRecord[]>;
  payrollMappingsByEntity: Record<string, PayrollMappingRecord[]>;
  payrollDepartmentsByEntity: Record<string, PayrollDepartmentRecord[]>;
  payrollRunsByEntity: Record<string, PayrollRunRecord[]>;
  payrollAllocationsByEntity: Record<string, PayrollAllocationRecord[]>;
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
