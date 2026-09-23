'use client';

import { ledgerLines, projects, reportAccounts, type AccountClass, type CashflowClass, type LedgerLine, type ReportFund } from '@/lib/report-data';
import { useEffect, useMemo, useRef, useState, useTransition, type ChangeEvent, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import type { ContactCategory, ContactRecord, ContactType, DocumentRecord, EntityRecord, EntityType, InitialData } from '@/lib/data/types';
import {
  accountNameMap,
  buildJournalEntries,
  buildTotals,
  controlAccounts,
  documentTaxFor,
  makeDocument,
  makeLine,
  periodOf,
  taxableSuppliesOf,
  type DocumentFormState,
  type DocumentTax,
  type SaleType,
  type DocumentKind,
  type DocumentLine,
  type DocumentStatus,
  type JournalLineDraft,
} from '@/lib/documents';
import {
  createContact,
  createEntity,
  fileTaxPeriod,
  postDocument,
  saveDocumentDraft,
  voidDocument,
} from '@/app/actions/documents';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { InventoryPanel } from '@/components/app/inventory-panel';
import { formatKg, inventoryAccountCategory, unitLabels } from '@/lib/inventory';
import { BuyingPanel } from '@/components/app/buying-panel';
import { ContractsPanel } from '@/components/app/contracts-panel';
import { OpeningPanel } from '@/components/app/opening-panel';
import { AssetsPanel } from '@/components/app/assets-panel';
import { PayrollPanel } from '@/components/app/payroll-panel';
import { Attachments } from '@/components/app/attachments';
import { InboxPanel } from '@/components/app/inbox-panel';
import { PrivacyPanel } from '@/components/app/privacy-panel';
import { MaskedDetail } from '@/components/app/reveal';
import { CashflowPanel } from '@/components/app/cashflow-panel';
import { GrantsPanel } from '@/components/app/grants-panel';
import { PaymentsPanel } from '@/components/app/payments-panel';
import { sellingCostKinds, sellingCostLabels, type SellingCostKind } from '@/lib/contracts';
import { instalments, isTaxed, monthOf, provisionalPosition } from '@/lib/assets';
import { liabilityKindLabels, liabilityPosition } from '@/lib/payroll';
import { runsGrants } from '@/lib/grants';
import { agentFloatSummaries, floatPosition, holdsStock, landedCostKinds, landedCostLabels, qualityFieldsFor, type LandedCostKind } from '@/lib/trading';
import { CurrencyProvider, ReportMoney, TranslationProvider } from '@/components/ui/money';
import type { Permission } from '@/lib/authz';
import { recordPayment as recordPaymentAction } from '@/app/actions/documents';
import { createBankAccount, previewRevaluation, reverseRevaluation, runRevaluation, setFunctionalCurrency, upsertExchangeRate, type RevaluationPreview } from '@/app/actions/fx';
import { setVatRegistration } from '@/app/actions/vat';
import { setEntitySender } from '@/app/actions/entities';
import {
  convertJournal,
  convertMinor,
  currencies,
  currencyNames,
  intercompanyPairBalances,
  selectRate,
  settlementFor,
  type Currency,
} from '@/lib/fx';
import {
  leviesOnBase,
  rollingTaxableTurnover,
  roundPesewas,
  thresholdStatus,
  VAT_REGISTRATION_THRESHOLD_MINOR,
  withholdingTaxOn,
  type VATTreatment,
  type WithholdingRate,
  type WithholdingTaxStatus,
} from '@/lib/ghana-tax';

const navigationItems = [
  'Dashboard',
  'Sales',
  'Purchases',
  'Bank',
  'Payments',
  'Inbox',
  'Cash flow',
  'Assets',
  'Payroll',
  'Grants',
  'Intercompany',
  'Tax',
  'Inventory',
  'Buying',
  'Contracts',
  'Reports',
  'Personal data',
  'Go-live',
  'Settings',
] as const;

type EntityMetrics = {
  cashPosition: number;
  moneyOwedToUs: number;
  moneyWeOwe: number;
  intercompanyBalance: number;
};


const metricsByEntity: Record<string, EntityMetrics> = {
  'sprouted-roots': {
    cashPosition: 2450000,
    moneyOwedToUs: 1345000,
    moneyWeOwe: 670000,
    intercompanyBalance: -84500,
  },
  'sprouted-crafts': {
    cashPosition: 1890000,
    moneyOwedToUs: 1112500,
    moneyWeOwe: 930000,
    intercompanyBalance: 220000,
  },
  'oikazi': {
    cashPosition: 3125000,
    moneyOwedToUs: 1675000,
    moneyWeOwe: 1184000,
    intercompanyBalance: -135000,
  },
};

const summaryRows = [
  { label: 'Cashew exports', status: 'Collected', value: 185000, tone: 'success' as const },
  { label: 'Farm inputs', status: 'Pending', value: -92000, tone: 'danger' as const },
  { label: 'Staff salaries', status: 'Cleared', value: -48000, tone: 'neutral' as const },
  { label: 'Donor disbursement', status: 'Scheduled', value: 250000, tone: 'success' as const },
];


const defaultFormValues = {
  name: '',
  type: 'manufacturing' as EntityType,
  financialYearEnd: '31 Dec',
  vatRegistered: false,
  vatRegisteredFrom: '',
  tin: '',
};

type IntercompanySide = {
  accountCode: string;
  accountName: string;
  amount: number;
  type: 'debit' | 'credit';
};

type IntercompanyTransaction = {
  id: string;
  reference: string;
  date: string;
  fromEntityId: string;
  toEntityId: string;
  amount: number;
  description: string;
  direction: 'sale' | 'purchase';
  journalEntries: {
    entityId: string;
    documentLabel: string;
    side: IntercompanySide[];
  }[];
};

type IntercompanyMatrixCell = {
  fromEntityId: string;
  toEntityId: string;
  balance: number;
  mirroredBalance: number;
  mismatch: boolean;
  balanceCurrency?: Currency;
  mirroredCurrency?: Currency;
  sameCurrency?: boolean;
  translatedMirror?: number | null;
  fxDifference?: number | null;
};

type TaxBucket = 'output' | 'input' | 'nhil' | 'getfund' | 'net';

type TaxTransaction = {
  id: string;
  entityId: string;
  date: string;
  document: string;
  contactName: string;
  contactTin: string;
  kind: 'sale' | 'purchase';
  base: number;
  vat: number;
  nhil: number;
  getFund: number;
  whtRate: WithholdingRate;
  whtAmount: number;
};

function periodKeyOf(date: string) {
  return date.slice(0, 7);
}

function periodLabelOf(key: string) {
  const [year, month] = key.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('en-GH', { month: 'long', year: 'numeric' });
}

function makeTaxEntry(entry: {
  id: string;
  entityId: string;
  date: string;
  document: string;
  contactName: string;
  contactTin: string;
  kind: 'sale' | 'purchase';
  base: number;
  whtRate?: WithholdingRate;
}): TaxTransaction {
  const { vat, nhil, getFund, totalInclTax } = leviesOnBase(entry.base);
  const whtRate = entry.whtRate ?? 0;
  const whtAmount = entry.kind === 'purchase' ? withholdingTaxOn(totalInclTax, whtRate) : 0;

  return { ...entry, vat, nhil, getFund, whtRate, whtAmount };
}

const taxTransactions: TaxTransaction[] = [
  makeTaxEntry({ id: 'tax-r-01', entityId: 'sprouted-roots', date: '2026-08-05', document: 'INV-0998', contactName: 'Cocoa Partners Limited', contactTin: 'GH-0204-CPL', kind: 'sale', base: 2000000 }),
  makeTaxEntry({ id: 'tax-r-02', entityId: 'sprouted-roots', date: '2026-08-12', document: 'BILL-3110', contactName: 'Nana Akua Farms', contactTin: 'GH-0101-NAF', kind: 'purchase', base: 1200000, whtRate: 0.05 }),
  makeTaxEntry({ id: 'tax-r-03', entityId: 'sprouted-roots', date: '2026-08-22', document: 'BILL-3118', contactName: 'Accra Packaging Co', contactTin: 'GH-0456-APC', kind: 'purchase', base: 350000, whtRate: 0.05 }),
  makeTaxEntry({ id: 'tax-r-04', entityId: 'sprouted-roots', date: '2026-09-02', document: 'INV-1042', contactName: 'Cocoa Partners Limited', contactTin: 'GH-0204-CPL', kind: 'sale', base: 1500000 }),
  makeTaxEntry({ id: 'tax-r-05', entityId: 'sprouted-roots', date: '2026-09-08', document: 'BILL-3155', contactName: 'Accra Packaging Co', contactTin: 'GH-0456-APC', kind: 'purchase', base: 400000, whtRate: 0.05 }),
  makeTaxEntry({ id: 'tax-r-06', entityId: 'sprouted-roots', date: '2026-09-15', document: 'BILL-3161', contactName: 'Nana Akua Farms', contactTin: 'GH-0101-NAF', kind: 'purchase', base: 800000, whtRate: 0.05 }),
  makeTaxEntry({ id: 'tax-c-01', entityId: 'sprouted-crafts', date: '2026-08-03', document: 'INV-2081', contactName: 'Cocoa Partners Limited', contactTin: 'GH-0204-CPL', kind: 'sale', base: 3000000 }),
  makeTaxEntry({ id: 'tax-c-02', entityId: 'sprouted-crafts', date: '2026-08-20', document: 'BILL-2190', contactName: 'Sprouted Roots', contactTin: 'GH-0001-ROOTS', kind: 'purchase', base: 1284000, whtRate: 0.05 }),
  makeTaxEntry({ id: 'tax-c-03', entityId: 'sprouted-crafts', date: '2026-09-05', document: 'INV-2102', contactName: 'Cocoa Partners Limited', contactTin: 'GH-0204-CPL', kind: 'sale', base: 2200000 }),
  makeTaxEntry({ id: 'tax-c-04', entityId: 'sprouted-crafts', date: '2026-09-10', document: 'BILL-2201', contactName: 'Akwasi Logistics', contactTin: 'GH-0311-AKL', kind: 'purchase', base: 456000, whtRate: 0.05 }),
  makeTaxEntry({ id: 'tax-c-05', entityId: 'sprouted-crafts', date: '2026-09-18', document: 'BILL-2210', contactName: 'Sprouted Roots', contactTin: 'GH-0001-ROOTS', kind: 'purchase', base: 1000000, whtRate: 0.05 }),
  makeTaxEntry({ id: 'tax-o-01', entityId: 'oikazi', date: '2026-08-08', document: 'INV-3011', contactName: 'Cocoa Partners Limited', contactTin: 'GH-0204-CPL', kind: 'sale', base: 1800000 }),
  makeTaxEntry({ id: 'tax-o-02', entityId: 'oikazi', date: '2026-08-25', document: 'BILL-4102', contactName: 'Tema Haulage', contactTin: 'GH-0522-THL', kind: 'purchase', base: 600000, whtRate: 0.1 }),
  makeTaxEntry({ id: 'tax-o-03', entityId: 'oikazi', date: '2026-09-04', document: 'INV-3026', contactName: 'Cocoa Partners Limited', contactTin: 'GH-0204-CPL', kind: 'sale', base: 2450000 }),
  makeTaxEntry({ id: 'tax-o-04', entityId: 'oikazi', date: '2026-09-11', document: 'BILL-4118', contactName: 'Tema Haulage', contactTin: 'GH-0522-THL', kind: 'purchase', base: 680000, whtRate: 0.1 }),
  makeTaxEntry({ id: 'tax-o-05', entityId: 'oikazi', date: '2026-09-19', document: 'BILL-4122', contactName: 'Accra Packaging Co', contactTin: 'GH-0456-APC', kind: 'purchase', base: 240000 }),
];

type ReportRange = { start: string; end: string };

type ReportRowData = {
  id: string;
  label: string;
  current: number;
  prior: number;
  kind: 'header' | 'line' | 'total';
  accountCodes?: string[];
  creditCurrent?: number;
  creditPrior?: number;
};

function codesOfType(type: AccountClass) {
  return Object.keys(reportAccounts).filter((code) => reportAccounts[code].type === type);
}

function codesOfCashflow(cashflow: CashflowClass) {
  return Object.keys(reportAccounts).filter((code) => reportAccounts[code].cashflow === cashflow);
}

function priorRangeOf(range: ReportRange): ReportRange {
  const start = new Date(`${range.start}T00:00:00`);
  const end = new Date(`${range.end}T00:00:00`);
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
  const priorEnd = new Date(start);
  priorEnd.setDate(priorEnd.getDate() - 1);
  const priorStart = new Date(priorEnd);
  priorStart.setDate(priorStart.getDate() - days + 1);
  return { start: priorStart.toISOString().slice(0, 10), end: priorEnd.toISOString().slice(0, 10) };
}

function csvEscape(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Money inputs: people type cedis (12.50), the ledger stores pesewas (1250).
 * The conversion rounds, because 12.34 * 100 is 1233.9999999999998 in
 * floating point and a ledger cannot carry that.
 */
function cedisInputToPesewas(raw: string): number {
  return roundPesewas(Number(raw) * 100) || 0;
}

function pesewasToCedisInput(pesewas: number): number {
  return pesewas / 100;
}

/** A short human-readable reference for a new intercompany entry. */
function newIntercompanyReference(): string {
  return `IC-${Date.now().toString().slice(-4)}`;
}

/** A unique id for a newly created intercompany transaction. */
function newIntercompanyTransactionId(reference: string): string {
  return `${reference.toLowerCase()}-${Date.now()}`;
}

type BankMatchStatus = 'unreconciled' | 'matched' | 'coded';

type BankLine = {
  id: string;
  date: string;
  amount: number;
  description: string;
  reference: string;
  bank: string;
  status: BankMatchStatus;
  matchedDocumentId?: string;
  matchedDocumentLabel?: string;
  matchedDocumentType?: 'invoice' | 'bill';
  matchedContact?: string;
  accountCode?: string;
  accountName?: string;
};

type CsvMapping = {
  date: string;
  amount: string;
  description: string;
  reference: string;
  bank: string;
};

type BankSuggestion = {
  id: string;
  type: 'invoice' | 'bill';
  label: string;
  contactName: string;
  amount: number;
  date: string;
  confidence: number;
};

function normalizeForMatch(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Demo documents the bank reconciliation matches against. Constant, so it lives
// here rather than being rebuilt on every render of the shell.
const bankDocuments = [
  { id: 'INV-1042', type: 'invoice' as const, contact: 'Cocoa Partners Limited', amount: 182500, date: '2026-09-10', reference: 'INV-1042' },
  { id: 'INV-1044', type: 'invoice' as const, contact: 'Nana Akua Farms', amount: 96000, date: '2026-09-11', reference: 'INV-1044' },
  { id: 'BILL-2198', type: 'bill' as const, contact: 'Sprouted Roots', amount: 128400, date: '2026-09-09', reference: 'BILL-2198' },
  { id: 'BILL-2201', type: 'bill' as const, contact: 'Akwasi Logistics', amount: 45600, date: '2026-09-12', reference: 'BILL-2201' },
  { id: 'INV-1046', type: 'invoice' as const, contact: 'Cocoa Partners Limited', amount: 245000, date: '2026-09-13', reference: 'INV-1046' },
];

function getSuggestionsForBankLine(line: BankLine): BankSuggestion[] {
  return bankDocuments
    .map((document) => {
      const amountDifference = Math.abs(line.amount - document.amount);
      const dateDifferenceDays = Math.abs(
        (new Date(line.date).getTime() - new Date(document.date).getTime()) / 86400000,
      );
      const contactMatch = normalizeForMatch(line.description).includes(normalizeForMatch(document.contact))
        || normalizeForMatch(document.contact).includes(normalizeForMatch(line.description));

      let score = 10;
      score += Math.max(0, 40 - amountDifference / 2000);
      score += dateDifferenceDays <= 3 ? 35 : dateDifferenceDays <= 10 ? 18 : 0;
      score += contactMatch ? 20 : 0;

      return {
        id: document.id,
        type: document.type,
        label: document.reference,
        contactName: document.contact,
        amount: document.amount,
        date: document.date,
        confidence: Math.min(95, Math.max(32, Math.round(score))),
      };
    })
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 3);
}

/** A persisted document as the editor holds it. */
function formFrom(record: DocumentRecord): DocumentFormState {
  return {
    id: record.id,
    kind: record.kind,
    docNumber: record.docNumber,
    contactId: record.contactId,
    date: record.date,
    dueDate: record.dueDate,
    status: record.status,
    currency: record.currency,
    rate: record.rate,
    rateDate: record.rateDate,
    rateExact: record.rateExact,
    saleType: record.saleType,
    importVat: record.importVat,
    lines: record.lines.map((line) => ({
      id: line.id,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      accountCode: line.accountCode,
      vatTreatment: line.vatTreatment,
      itemId: line.itemId,
      locationId: line.locationId,
      landedCostKind: line.landedCostKind,
      landedCostLotIds: line.landedCostLotIds,
      lotRef: line.lotRef,
      community: line.community,
      district: line.district,
      quality: line.quality,
      contractId: line.contractId,
      sellingCostKind: line.sellingCostKind,
      grantId: line.grantId,
      budgetLineId: line.budgetLineId,
    })),
    evatClearanceNumber: record.evatClearanceNumber,
    evatQrCode: record.evatQrCode,
    evatTimestamp: record.evatTimestamp,
  };
}

/** The document the editor should open for an entity and kind: its newest draft, else a fresh one. */
function initialDocumentFor(data: InitialData, entityId: string, kind: DocumentKind): DocumentFormState {
  const draft = (data.documentsByEntity[entityId] ?? []).find((document) => document.kind === kind && document.status === 'draft');
  if (draft) return formFrom(draft);
  const contact = data.contacts.find((candidate) => candidate.balances[entityId] !== undefined) ?? data.contacts[0];
  const functional = data.entities.find((entity) => entity.id === entityId)?.functionalCurrency ?? 'GHS';
  return makeDocument(kind, contact?.id ?? '', functional);
}

/** A foreign amount, prominent, with its functional equivalent in smaller text beneath. */
function FxAmount({ amount, currency, functional, functionalCurrency, large }: { amount: number; currency: Currency; functional: number | null; functionalCurrency: Currency; large?: boolean }) {
  return (
    <span className="flex flex-col items-end">
      <span className={['font-mono text-slate-900', large ? 'text-base font-semibold' : ''].join(' ')}><Money value={amount} currency={currency} /></span>
      {functional !== null && currency !== functionalCurrency ? (
        <span className="font-mono text-[11px] font-normal text-slate-500"><Money value={functional} currency={functionalCurrency} /></span>
      ) : null}
    </span>
  );
}

const statusLabels: Record<DocumentStatus, string> = {
  draft: 'Draft',
  'awaiting-payment': 'Awaiting payment',
  paid: 'Paid',
  voided: 'Voided',
};

export function AppShell({ initialData }: { initialData: InitialData }) {
  const [entities, setEntities] = useState<EntityRecord[]>(initialData.entities);
  const [selectedEntityId, setSelectedEntityId] = useState(initialData.entities[0]?.id ?? '');
  const [activeNav, setActiveNav] = useState<(typeof navigationItems)[number]>('Dashboard');
  const [entityMenuOpen, setEntityMenuOpen] = useState(false);
  const [showAddEntityForm, setShowAddEntityForm] = useState(false);
  const [showAddContactForm, setShowAddContactForm] = useState(false);
  // Where the contact dialog was opened from. Opened from a document, the new
  // contact is selected on it, so nobody has to go and find it again.
  const [contactFormTarget, setContactFormTarget] = useState<'list' | 'document'>('list');
  const [formValues, setFormValues] = useState(defaultFormValues);
  const [contacts, setContacts] = useState<ContactRecord[]>(initialData.contacts);
  const [contactFormValues, setContactFormValues] = useState({
    name: '',
    type: 'supplier' as ContactType,
    category: 'other' as ContactCategory,
    tin: '',
    phone: '',
    email: '',
    address: '',
    withholdingTaxStatus: 'none' as WithholdingTaxStatus,
  });
  const [salesDocument, setSalesDocument] = useState<DocumentFormState>(() => initialDocumentFor(initialData, initialData.entities[0]?.id ?? '', 'invoice'));
  const [purchaseDocument, setPurchaseDocument] = useState<DocumentFormState>(() => initialDocumentFor(initialData, initialData.entities[0]?.id ?? '', 'bill'));
  const [journalOpen, setJournalOpen] = useState(true);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  // Reports: functional by default; optionally translated to USD/EUR at a chosen closing rate.
  const [reportCurrency, setReportCurrency] = useState<'functional' | Currency>('functional');
  const [translationRate, setTranslationRate] = useState('');
  // Settings: rate table, bank accounts, functional currency, revaluation.
  const [rateForm, setRateForm] = useState({ base: 'USD' as Currency, quote: 'GHS' as Currency, date: new Date().toISOString().slice(0, 10), rate: '', source: '' });
  const [bankForm, setBankForm] = useState({ name: '', currency: 'USD' as Currency });
  const [revalForm, setRevalForm] = useState<{ period: string; rates: Partial<Record<Currency, string>> }>({ period: new Date().toISOString().slice(0, 7), rates: {} });
  const [revalPreview, setRevalPreview] = useState<RevaluationPreview | null>(null);
  const [settingsMessage, setSettingsMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [settingsPending, startSettingsTransition] = useTransition();
  const [paymentForm, setPaymentForm] = useState({ bankAccountId: '', date: '', amount: '', rate: '' });
  const [documentPending, startDocumentTransition] = useTransition();
  const autosaveTimer = useRef<number | null>(null);
  const [intercompanyTransactions, setIntercompanyTransactions] = useState<IntercompanyTransaction[]>([
    {
      id: 'ic-001',
      reference: 'IC-2026-001',
      date: '2026-09-11',
      fromEntityId: 'sprouted-roots',
      toEntityId: 'sprouted-crafts',
      amount: 128400,
      description: 'Raw cashew supply',
      direction: 'sale',
      journalEntries: [
        {
          entityId: 'sprouted-roots',
          documentLabel: 'INV-IC-001',
          side: [
            { accountCode: '1010', accountName: 'Trade Receivables', amount: 128400, type: 'debit' },
            { accountCode: '4001', accountName: 'Domestic Sales', amount: 128400, type: 'credit' },
          ],
        },
        {
          entityId: 'sprouted-crafts',
          documentLabel: 'BILL-IC-001',
          side: [
            { accountCode: '5001', accountName: 'Raw Materials Used', amount: 128400, type: 'debit' },
            { accountCode: '2001', accountName: 'Trade Payables', amount: 128400, type: 'credit' },
          ],
        },
      ],
    },
    {
      id: 'ic-002',
      reference: 'IC-2026-002',
      date: '2026-09-12',
      fromEntityId: 'sprouted-crafts',
      toEntityId: 'oikazi',
      amount: 68000,
      description: 'Packaging support',
      direction: 'sale',
      journalEntries: [
        {
          entityId: 'sprouted-crafts',
          documentLabel: 'INV-IC-002',
          side: [
            { accountCode: '1010', accountName: 'Trade Receivables', amount: 68000, type: 'debit' },
            { accountCode: '4005', accountName: 'Export Sales', amount: 68000, type: 'credit' },
          ],
        },
        {
          entityId: 'oikazi',
          documentLabel: 'BILL-IC-002',
          side: [
            { accountCode: '6001', accountName: 'Factory Utilities', amount: 68000, type: 'debit' },
            { accountCode: '2001', accountName: 'Trade Payables', amount: 68000, type: 'credit' },
          ],
        },
      ],
    },
  ]);

  const [intercompanyForm, setIntercompanyForm] = useState(() => ({
    reference: newIntercompanyReference(),
    date: new Date().toISOString().slice(0, 10),
    fromEntityId: initialData.entities[0]?.id ?? '',
    toEntityId: initialData.entities[1]?.id ?? initialData.entities[0]?.id ?? '',
    amount: 0,
    description: 'Raw material supply',
  }));

  const [filedPeriods, setFiledPeriods] = useState<Record<string, string[]>>(initialData.filedPeriodsByEntity);
  const [selectedTaxPeriod, setSelectedTaxPeriod] = useState('2026-09');
  const [taxDrilldown, setTaxDrilldown] = useState<TaxBucket | null>(null);

  type ReportType =
    | 'trial-balance'
    | 'profit-loss'
    | 'balance-sheet'
    | 'cash-flow'
    | 'aged-receivables'
    | 'aged-payables'
    | 'fund-report'
    | 'projects'
    | 'group-view';

  const [reportType, setReportType] = useState<ReportType>('trial-balance');
  const [reportStart, setReportStart] = useState('2026-09-01');
  const [reportEnd, setReportEnd] = useState('2026-09-30');
  const [reportDrilldown, setReportDrilldown] = useState<{
    title: string;
    entityId: string;
    accountCodes: string[];
    range: ReportRange;
    cumulative: boolean;
    contactName?: string;
    fund?: ReportFund;
    projectId?: string;
  } | null>(null);

  type BackupRunView = {
    id: string;
    fileName: string;
    sizeBytes: number;
    status: 'SUCCESS' | 'FAILED';
    checksum: string;
    createdAt: string;
    error: string | null;
    available: boolean;
  };

  type AuditEventView = {
    id: string;
    entityId: string;
    userName: string;
    action: string;
    resourceType: string;
    resourceRef: string;
    summary: string;
    createdAt: string;
  };

  const [backupRuns, setBackupRuns] = useState<BackupRunView[]>([]);
  const [lastSuccessfulBackup, setLastSuccessfulBackup] = useState<BackupRunView | null>(null);
  const [lastBackupFailed, setLastBackupFailed] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [auditEvents, setAuditEvents] = useState<AuditEventView[]>([]);
  const [auditChainIntact, setAuditChainIntact] = useState<boolean | null>(null);
  // Who is signed in, and what their role allows. The server re-checks every
  // one of these on every call; here they only decide what to show.
  const currentUser = initialData.currentUser;
  const allowed = (permission: Permission) => currentUser.permissions.includes(permission);

  const selectedEntity = useMemo(
    () => entities.find((entity) => entity.id === selectedEntityId) ?? entities[0],
    [entities, selectedEntityId],
  );

  const currentMetrics = metricsByEntity[selectedEntity.id] ?? {
    cashPosition: 0,
    moneyOwedToUs: 0,
    moneyWeOwe: 0,
    intercompanyBalance: 0,
  };

  // Everyone this company trades with. A contact gets a balance with every
  // entity the moment it is created, so the balance is what says the two of
  // them deal with each other; the type only says which way round.
  //
  // This used to also test the type and the category, which quietly hid any
  // contact typed Customer whose category was not Customer — added, then
  // missing from the list and from the picker, with nothing to explain it.
  //
  // It deliberately does not narrow to customers on invoices and suppliers on
  // bills. That would be truer, but a contact's type cannot be edited yet, so
  // a type set wrong once would hide the contact with no way to put it right.
  const entityContacts = useMemo(
    () => contacts.filter((contact) => contact.balances[selectedEntity.id] !== undefined),
    [contacts, selectedEntity.id],
  );

  const activeDocument = activeNav === 'Sales' ? salesDocument : purchaseDocument;
  const isPurchaseView = activeNav === 'Purchases';
  const activeKind: DocumentKind = isPurchaseView ? 'bill' : 'invoice';
  // The document's own contact by id first — a deactivated contact must still
  // resolve rather than the editor silently swapping to the first in the list.
  const activeContact =
    contacts.find((contact) => contact.id === activeDocument.contactId) ?? entityContacts[0] ?? contacts[0];
  const entityAccounts = useMemo(() => initialData.accountsByEntity[selectedEntity.id] ?? [], [initialData, selectedEntity.id]);
  const accountNames = useMemo(() => accountNameMap(entityAccounts), [entityAccounts]);
  const entityDocuments = useMemo(() => initialData.documentsByEntity[selectedEntity.id] ?? [], [initialData, selectedEntity.id]);
  const activeRecord = activeDocument.id ? entityDocuments.find((document) => document.id === activeDocument.id) : undefined;
  // VAT applies to a document only if the entity is registered and the document
  // is dated on or after the registration date. A posted document keeps the
  // answer it was posted with; a draft takes the current one for its date.
  const taxOf = (document: Pick<DocumentRecord, 'date' | 'vatApplied' | 'journal'>): DocumentTax =>
    document.journal ? { vatApplies: document.vatApplied } : documentTaxFor(selectedEntity, document.date);
  const documentTax: DocumentTax = activeRecord?.journal ? { vatApplies: activeRecord.vatApplied } : documentTaxFor(selectedEntity, activeDocument.date);
  const activeTotals = buildTotals(activeDocument, isPurchaseView ? activeContact?.withholdingTaxStatus : undefined, documentTax);
  const previewJournal: JournalLineDraft[] = buildJournalEntries(activeDocument, isPurchaseView, activeContact, accountNames, documentTax);
  const functionalCurrency: Currency = selectedEntity.functionalCurrency;
  const entityRates = initialData.ratesByEntity[selectedEntity.id] ?? [];
  const entityBankAccounts = initialData.bankAccountsByEntity[selectedEntity.id] ?? [];
  const entityRevaluations = initialData.revaluationsByEntity[selectedEntity.id] ?? [];
  const entityItems = initialData.itemsByEntity[selectedEntity.id] ?? [];
  const entityLocations = initialData.locationsByEntity[selectedEntity.id] ?? [];
  const entityCommodities = initialData.commoditiesByEntity[selectedEntity.id] ?? [];
  const entityLots = initialData.lotsByEntity[selectedEntity.id] ?? [];
  const entityHoldsStock = holdsStock(selectedEntity.type);
  // Bills can be charged to a grant that is open and running. A closed grant,
  // or one not yet active, is not offered.
  const entityGrants = useMemo(
    () => (initialData.grantsByEntity[selectedEntity.id] ?? []).filter((grant) => grant.status === 'active'),
    [initialData, selectedEntity.id],
  );
  /** What payroll still owes and when, for the dashboard. */
  const payrollOwed = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = (initialData.payrollRunsByEntity[selectedEntity.id] ?? []).flatMap((run) =>
      run.liabilities.map((liability) => ({
        id: liability.id,
        period: liability.period,
        kind: liability.kind,
        amountMinor: liability.amountMinor,
        settledMinor: liability.settledMinor,
        dueDate: liability.dueDate,
      })),
    );
    const position = liabilityPosition(rows, today);
    return position.rows.length ? position : null;
  }, [initialData, selectedEntity.id]);

  /**
   * Where the entity stands on its provisional tax, for the dashboard. The
   * year we are in is the one today falls inside; an exempt entity has none.
   */
  const provisionalTax = useMemo(() => {
    if (!isTaxed(selectedEntity.taxStatus)) return null;
    const today = new Date().toISOString().slice(0, 10);
    const years = initialData.taxYearsByEntity[selectedEntity.id] ?? [];
    const year = years.find((row) => today >= row.startDate && today <= row.endDate) ?? years[0];
    if (!year || year.estimatedLiabilityMinor <= 0) return null;
    const rows = instalments(
      monthOf(year.startDate),
      year.estimatedLiabilityMinor,
      year.provisional.map((payment) => ({ quarter: payment.quarter, paidMinor: payment.amountMinor, paidDate: payment.date })),
      today,
    );
    return { year, position: provisionalPosition(rows, today) };
  }, [initialData, selectedEntity.id, selectedEntity.taxStatus]);

  // Outstanding float per agent, for the dashboard: red when older than the entity's limit.
  const floatSummaries = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const floats = (initialData.floatsByEntity[selectedEntity.id] ?? []).map((f) => ({ agentId: f.agentId, status: f.status, position: floatPosition({ amountMinor: f.amountMinor, date: f.date }, f.purchasedMinor, f.returns.reduce((sum, r) => sum + r.amountMinor, 0), today, selectedEntity.floatAgeLimitDays) }));
    return agentFloatSummaries(initialData.agentsByEntity[selectedEntity.id] ?? [], floats).filter((summary) => summary.openFloats > 0 || summary.outstandingMinor !== 0);
  }, [initialData, selectedEntity.id, selectedEntity.floatAgeLimitDays]);
  // Rolling twelve-month taxable turnover against the registration threshold,
  // from posted invoices in the ledger. Shown for every entity, registered or
  // not: it is the number that decides whether registration is compulsory.
  const vatThreshold = useMemo(() => {
    const asOf = new Date().toISOString().slice(0, 10);
    const supplies = taxableSuppliesOf(entityDocuments, (minor, rate) => convertMinor(minor, rate));
    const turnover = rollingTaxableTurnover(supplies, asOf);
    return { asOf, turnover, ...thresholdStatus(turnover) };
  }, [entityDocuments]);
  const vatRegistrationLabel = selectedEntity.vatRegistered
    ? `Registered from ${selectedEntity.vatRegisteredFrom}`
    : 'Not VAT registered';
  const [vatForm, setVatForm] = useState({ registeredFrom: '' });
  // The entity's sender address, edited in place; keyed on the entity so
  // switching entities shows that entity's value, not the last one typed.
  const [senderForm, setSenderForm] = useState<{ entityId: string; value: string }>({ entityId: selectedEntity.id, value: selectedEntity.emailFrom });
  const senderValue = senderForm.entityId === selectedEntity.id ? senderForm.value : selectedEntity.emailFrom;
  // The Tax screen exists only for a registered entity. Choosing an
  // unregistered entity while on it lands on the dashboard (see the entity
  // menu); switching registration off happens from Settings, so the Tax
  // branch below only ever renders for a registered entity.
  const visibleNavigation = navigationItems.filter(
    (item) =>
      (item !== 'Tax' || selectedEntity.vatRegistered) &&
      ((item !== 'Inventory' && item !== 'Buying' && item !== 'Contracts') || holdsStock(selectedEntity.type)) &&
      (item !== 'Grants' || runsGrants(selectedEntity.type)),
  );
  // The table's default for this document's currency and date; the document may override it.
  const documentRateQuote = selectRate(entityRates, activeDocument.currency, functionalCurrency, activeDocument.date);
  const documentRate: string | null = activeDocument.currency === functionalCurrency ? '1.0' : (activeDocument.rate ?? documentRateQuote?.rate ?? null);
  const documentIsForeign = activeDocument.currency !== functionalCurrency;
  const documentRateWarning: string | null = !documentIsForeign
    ? null
    : activeRecord?.journal
      ? null
      : !documentRate
        ? `No ${activeDocument.currency}→${functionalCurrency} rate on file on or before ${activeDocument.date}. Enter one in Settings, or type a rate here.`
        : activeDocument.rate && !activeDocument.rateExact && activeDocument.rateDate === activeDocument.date
          ? 'Rate overridden by hand.'
          : documentRateQuote && !documentRateQuote.exact
            ? `No rate for ${activeDocument.date}; using the most recent prior rate, from ${documentRateQuote.rateDate}${documentRateQuote.inverted ? ' (inverse of the reverse pair)' : ''}.`
            : documentRateQuote?.inverted
              ? 'Derived from the reverse pair on file.'
              : null;
  const toFunctional = (minor: number) => (documentRate ? convertMinor(minor, documentRate) : null);
  // Once posted, the panel shows what the ledger actually holds, not a preview.
  const journalEntries: { accountCode: string; accountName: string; amount: number; type: 'debit' | 'credit'; currency: Currency; txnAmount: number; rate: string }[] =
    activeRecord?.journal
      ? activeRecord.journal.lines
      : documentRate
        ? convertJournal(previewJournal, activeDocument.currency, functionalCurrency, documentRate, isPurchaseView ? controlAccounts.payables : controlAccounts.receivables).map((line) => ({
            accountCode: line.accountCode, accountName: line.accountName, amount: line.functionalAmount, type: line.type, currency: line.currency, txnAmount: line.txnAmount, rate: line.rate,
          }))
        : previewJournal.map((line) => ({ ...line, currency: activeDocument.currency, txnAmount: line.amount, rate: '?' }));
  const groupEntityOptions = entities;

  const documentPeriodLocked = (filedPeriods[selectedEntity.id] ?? []).includes(periodOf(activeDocument.date));
  const documentReadOnly = activeDocument.status !== 'draft' || documentPeriodLocked || !allowed('document:draft');
  const filedPeriodKeys = filedPeriods[selectedEntity.id] ?? [];
  const isSelectedPeriodFiled = filedPeriodKeys.includes(selectedTaxPeriod);

  const entityTaxTransactions = useMemo(
    () => taxTransactions.filter((transaction) => transaction.entityId === selectedEntity.id),
    [selectedEntity.id],
  );

  const availableTaxPeriods = useMemo(
    () => Array.from(new Set(entityTaxTransactions.map((transaction) => periodKeyOf(transaction.date)))).sort().reverse(),
    [entityTaxTransactions],
  );

  const periodTransactions = useMemo(
    () => entityTaxTransactions.filter((transaction) => periodKeyOf(transaction.date) === selectedTaxPeriod),
    [entityTaxTransactions, selectedTaxPeriod],
  );

  const vatFigures = useMemo(() => {
    const sales = periodTransactions.filter((transaction) => transaction.kind === 'sale');
    const purchases = periodTransactions.filter((transaction) => transaction.kind === 'purchase');
    const sum = (rows: TaxTransaction[], field: 'vat' | 'nhil' | 'getFund') =>
      rows.reduce((total, transaction) => total + transaction[field], 0);

    const outputVat = sum(sales, 'vat');
    const outputNhil = sum(sales, 'nhil');
    const outputGetFund = sum(sales, 'getFund');
    const inputVat = sum(purchases, 'vat');
    const inputNhil = sum(purchases, 'nhil');
    const inputGetFund = sum(purchases, 'getFund');

    return {
      outputVat,
      outputNhil,
      outputGetFund,
      inputVat,
      inputNhil,
      inputGetFund,
      nhilNet: outputNhil - inputNhil,
      getFundNet: outputGetFund - inputGetFund,
      net: outputVat + outputNhil + outputGetFund - inputVat - inputNhil - inputGetFund,
    };
  }, [periodTransactions]);

  const drilldownRows = useMemo(() => {
    if (!taxDrilldown) {
      return [];
    }
    if (taxDrilldown === 'output') {
      return periodTransactions.filter((transaction) => transaction.kind === 'sale');
    }
    if (taxDrilldown === 'input') {
      return periodTransactions.filter((transaction) => transaction.kind === 'purchase');
    }
    return periodTransactions;
  }, [taxDrilldown, periodTransactions]);

  const whtRows = useMemo(() => {
    const byContact = new Map<
      string,
      { name: string; tin: string; rate: number; gross: number; withheld: number; documents: number }
    >();

    periodTransactions
      .filter((transaction) => transaction.kind === 'purchase' && transaction.whtAmount > 0)
      .forEach((transaction) => {
        const existing = byContact.get(transaction.contactName) ?? {
          name: transaction.contactName,
          tin: transaction.contactTin,
          rate: transaction.whtRate,
          gross: 0,
          withheld: 0,
          documents: 0,
        };
        existing.gross += transaction.base + transaction.vat + transaction.nhil + transaction.getFund;
        existing.withheld += transaction.whtAmount;
        existing.documents += 1;
        byContact.set(transaction.contactName, existing);
      });

    return Array.from(byContact.values());
  }, [periodTransactions]);

  const taxBucketLabels: Record<TaxBucket, string> = {
    output: 'Output VAT — sales in the period',
    input: 'Input VAT — purchases in the period',
    nhil: 'NHIL — all transactions in the period',
    getfund: 'GETFund — all transactions in the period',
    net: 'Net position — all transactions in the period',
  };

  const reportRange: ReportRange = useMemo(() => ({ start: reportStart, end: reportEnd }), [reportStart, reportEnd]);
  const priorReportRange = useMemo(() => priorRangeOf(reportRange), [reportRange]);

  function accountSum(entityId: string, codes: string[], range: ReportRange, cumulative = false) {
    const codeSet = new Set(codes);
    return ledgerLines
      .filter(
        (line) =>
          line.entityId === entityId &&
          codeSet.has(line.accountCode) &&
          (cumulative ? line.date <= range.end : line.date >= range.start && line.date <= range.end),
      )
      .reduce((total, line) => total + line.amount, 0);
  }

  const standardReport = useMemo<{ title: string; subtitle: string; columns: string[]; rows: ReportRowData[]; trialBalance?: boolean }>(() => {
    const entityId = selectedEntity.id;
    const range = reportRange;
    const prior = priorReportRange;
    const incomeCodes = codesOfType('INCOME');
    const cosCodes = codesOfType('COST_OF_SALES');
    const expenseCodes = codesOfType('EXPENSE');

    if (reportType === 'trial-balance') {
      const rows: ReportRowData[] = [];
      let debitCurrent = 0;
      let creditCurrent = 0;
      let debitPrior = 0;
      let creditPrior = 0;

      Object.keys(reportAccounts).forEach((code) => {
        const current = accountSum(entityId, [code], range, true);
        const priorSum = accountSum(entityId, [code], prior, true);
        if (current === 0 && priorSum === 0) {
          return;
        }
        debitCurrent += Math.max(current, 0);
        creditCurrent += Math.max(-current, 0);
        debitPrior += Math.max(priorSum, 0);
        creditPrior += Math.max(-priorSum, 0);
        rows.push({
          id: code,
          label: `${code} · ${reportAccounts[code].name}`,
          current,
          prior: priorSum,
          kind: 'line',
          accountCodes: [code],
        });
      });

      return {
        title: `Trial balance as at ${range.end}`,
        subtitle: `Money in shown positive · cumulative to report date · prior period ${prior.start} → ${prior.end}`,
        columns: ['Current debit', 'Current credit', 'Prior debit', 'Prior credit'],
        trialBalance: true,
        rows: [
          ...rows,
          { id: 'tb-total', label: 'Totals', current: debitCurrent, prior: debitPrior, creditCurrent, creditPrior, kind: 'total' },
        ],
      };
    }

    if (reportType === 'profit-loss') {
      const rows: ReportRowData[] = [{ id: 'pl-h1', label: 'Income', current: 0, prior: 0, kind: 'header' }];
      incomeCodes.forEach((code) => {
        const current = -accountSum(entityId, [code], range);
        const priorSum = -accountSum(entityId, [code], prior);
        if (current === 0 && priorSum === 0) return;
        rows.push({ id: `pl-${code}`, label: `${code} · ${reportAccounts[code].name}`, current, prior: priorSum, kind: 'line', accountCodes: [code] });
      });
      const totalIncome = -accountSum(entityId, incomeCodes, range);
      const totalIncomePrior = -accountSum(entityId, incomeCodes, prior);
      rows.push({ id: 'pl-ti', label: 'Total income', current: totalIncome, prior: totalIncomePrior, kind: 'total', accountCodes: incomeCodes });

      rows.push({ id: 'pl-h2', label: 'Cost of sales', current: 0, prior: 0, kind: 'header' });
      cosCodes.forEach((code) => {
        const current = accountSum(entityId, [code], range);
        const priorSum = accountSum(entityId, [code], prior);
        if (current === 0 && priorSum === 0) return;
        rows.push({ id: `pl-${code}`, label: `${code} · ${reportAccounts[code].name}`, current, prior: priorSum, kind: 'line', accountCodes: [code] });
      });
      const totalCos = accountSum(entityId, cosCodes, range);
      const totalCosPrior = accountSum(entityId, cosCodes, prior);
      rows.push({ id: 'pl-tc', label: 'Total cost of sales', current: totalCos, prior: totalCosPrior, kind: 'total', accountCodes: cosCodes });
      rows.push({ id: 'pl-gp', label: 'Gross profit', current: totalIncome - totalCos, prior: totalIncomePrior - totalCosPrior, kind: 'total' });

      rows.push({ id: 'pl-h3', label: 'Expenses', current: 0, prior: 0, kind: 'header' });
      expenseCodes.forEach((code) => {
        const current = accountSum(entityId, [code], range);
        const priorSum = accountSum(entityId, [code], prior);
        if (current === 0 && priorSum === 0) return;
        rows.push({ id: `pl-${code}`, label: `${code} · ${reportAccounts[code].name}`, current, prior: priorSum, kind: 'line', accountCodes: [code] });
      });
      const totalExpenses = accountSum(entityId, expenseCodes, range);
      const totalExpensesPrior = accountSum(entityId, expenseCodes, prior);
      rows.push({ id: 'pl-te', label: 'Total expenses', current: totalExpenses, prior: totalExpensesPrior, kind: 'total', accountCodes: expenseCodes });
      rows.push({ id: 'pl-net', label: 'Net surplus / (deficit)', current: totalIncome - totalCos - totalExpenses, prior: totalIncomePrior - totalCosPrior - totalExpensesPrior, kind: 'total' });

      return {
        title: `Profit & loss — ${range.start} → ${range.end}`,
        subtitle: `Compared with prior period ${prior.start} → ${prior.end}`,
        columns: ['Current period', 'Prior period', 'Variance'],
        rows,
      };
    }

    if (reportType === 'balance-sheet') {
      const assetCurrent = codesOfType('ASSET').filter((code) => code !== '1501');
      const rows: ReportRowData[] = [{ id: 'bs-h1', label: 'Current assets', current: 0, prior: 0, kind: 'header' }];
      assetCurrent.forEach((code) => {
        const current = accountSum(entityId, [code], range, true);
        const priorSum = accountSum(entityId, [code], prior, true);
        if (current === 0 && priorSum === 0) return;
        rows.push({ id: `bs-${code}`, label: `${code} · ${reportAccounts[code].name}`, current, prior: priorSum, kind: 'line', accountCodes: [code] });
      });
      rows.push({ id: 'bs-h2', label: 'Non-current assets', current: 0, prior: 0, kind: 'header' });
      ['1501'].forEach((code) => {
        const current = accountSum(entityId, [code], range, true);
        const priorSum = accountSum(entityId, [code], prior, true);
        if (current === 0 && priorSum === 0) return;
        rows.push({ id: `bs-${code}`, label: `${code} · ${reportAccounts[code].name}`, current, prior: priorSum, kind: 'line', accountCodes: [code] });
      });
      const totalAssets = accountSum(entityId, codesOfType('ASSET'), range, true);
      const totalAssetsPrior = accountSum(entityId, codesOfType('ASSET'), prior, true);
      rows.push({ id: 'bs-ta', label: 'Total assets', current: totalAssets, prior: totalAssetsPrior, kind: 'total', accountCodes: codesOfType('ASSET') });

      rows.push({ id: 'bs-h3', label: 'Liabilities', current: 0, prior: 0, kind: 'header' });
      codesOfType('LIABILITY').forEach((code) => {
        const current = -accountSum(entityId, [code], range, true);
        const priorSum = -accountSum(entityId, [code], prior, true);
        if (current === 0 && priorSum === 0) return;
        rows.push({ id: `bs-${code}`, label: `${code} · ${reportAccounts[code].name}`, current, prior: priorSum, kind: 'line', accountCodes: [code] });
      });
      const totalLiabilities = -accountSum(entityId, codesOfType('LIABILITY'), range, true);
      const totalLiabilitiesPrior = -accountSum(entityId, codesOfType('LIABILITY'), prior, true);
      rows.push({ id: 'bs-tl', label: 'Total liabilities', current: totalLiabilities, prior: totalLiabilitiesPrior, kind: 'total', accountCodes: codesOfType('LIABILITY') });

      rows.push({ id: 'bs-h4', label: 'Equity', current: 0, prior: 0, kind: 'header' });
      codesOfType('EQUITY').forEach((code) => {
        const current = -accountSum(entityId, [code], range, true);
        const priorSum = -accountSum(entityId, [code], prior, true);
        if (current === 0 && priorSum === 0) return;
        rows.push({ id: `bs-${code}`, label: `${code} · ${reportAccounts[code].name}`, current, prior: priorSum, kind: 'line', accountCodes: [code] });
      });
      const plCodes = [...incomeCodes, ...cosCodes, ...expenseCodes];
      const accumulated = -accountSum(entityId, plCodes, range, true);
      const accumulatedPrior = -accountSum(entityId, plCodes, prior, true);
      rows.push({ id: 'bs-result', label: 'Accumulated result', current: accumulated, prior: accumulatedPrior, kind: 'line', accountCodes: plCodes });
      const totalEquity = -accountSum(entityId, codesOfType('EQUITY'), range, true) + accumulated;
      const totalEquityPrior = -accountSum(entityId, codesOfType('EQUITY'), prior, true) + accumulatedPrior;
      rows.push({ id: 'bs-te', label: 'Total equity', current: totalEquity, prior: totalEquityPrior, kind: 'total', accountCodes: [...codesOfType('EQUITY'), ...plCodes] });
      rows.push({ id: 'bs-check', label: 'Check — assets less liabilities and equity (should be nil)', current: totalAssets - totalLiabilities - totalEquity, prior: totalAssetsPrior - totalLiabilitiesPrior - totalEquityPrior, kind: 'total' });

      return {
        title: `Balance sheet as at ${range.end}`,
        subtitle: `Cumulative balances · prior position as at ${prior.end}`,
        columns: [`As at ${range.end}`, `As at ${prior.end}`, 'Movement'],
        rows,
      };
    }

    // cash flow
    const cashCodes = codesOfCashflow('cash');
    const sections: { id: string; label: string; codes: string[] }[] = [
      { id: 'operating', label: 'Operating activities', codes: codesOfCashflow('operating') },
      { id: 'investing', label: 'Investing activities', codes: codesOfCashflow('investing') },
      { id: 'financing', label: 'Financing activities', codes: codesOfCashflow('financing') },
    ];
    const rows: ReportRowData[] = [];
    let netMovement = 0;
    let netMovementPrior = 0;

    sections.forEach((section) => {
      const current = -accountSum(entityId, section.codes, range);
      const priorSum = -accountSum(entityId, section.codes, prior);
      netMovement += current;
      netMovementPrior += priorSum;
      rows.push({
        id: `cf-${section.id}`,
        label: `Net cash from ${section.label.toLowerCase()}`,
        current,
        prior: priorSum,
        kind: 'line',
        accountCodes: section.codes,
      });
    });

    const opening = accountSum(entityId, cashCodes, { start: '1900-01-01', end: range.start }, false);
    const openingPrior = accountSum(entityId, cashCodes, { start: '1900-01-01', end: prior.start }, false);
    rows.push({ id: 'cf-net', label: 'Net cash movement', current: netMovement, prior: netMovementPrior, kind: 'total' });
    rows.push({ id: 'cf-open', label: 'Opening cash', current: opening, prior: openingPrior, kind: 'line', accountCodes: cashCodes });
    rows.push({ id: 'cf-close', label: 'Closing cash', current: opening + netMovement, prior: openingPrior + netMovementPrior, kind: 'total', accountCodes: cashCodes });

    return {
      title: `Cash flow — ${range.start} → ${range.end}`,
      subtitle: `Derived from account movements · prior period ${prior.start} → ${prior.end}`,
      columns: ['Current period', 'Prior period', 'Variance'],
      rows,
    };
  }, [reportType, selectedEntity.id, reportRange, priorReportRange]);

  type AgingRow = {
    contactName: string;
    buckets: [number, number, number, number, number];
    total: number;
    priorTotal: number;
    lines: LedgerLine[];
  };

  const agingRows = useMemo<AgingRow[]>(() => {
    if (reportType !== 'aged-receivables' && reportType !== 'aged-payables') {
      return [];
    }

    const isReceivable = reportType === 'aged-receivables';
    const accountCode = isReceivable ? '1010' : '2001';
    const asOf = new Date(`${reportEnd}T00:00:00`);
    const priorAsOf = new Date(`${priorReportRange.end}T00:00:00`);
    const byContact = new Map<string, AgingRow>();

    ledgerLines
      .filter(
        (line) =>
          line.entityId === selectedEntity.id &&
          line.accountCode === accountCode &&
          line.date <= reportEnd &&
          line.dueDate &&
          (isReceivable ? line.amount > 0 : line.amount < 0),
      )
      .forEach((line) => {
        const existing = byContact.get(line.contactName) ?? {
          contactName: line.contactName,
          buckets: [0, 0, 0, 0, 0] as [number, number, number, number, number],
          total: 0,
          priorTotal: 0,
          lines: [],
        };

        const displayAmount = isReceivable ? line.amount : -line.amount;
        const daysOverdue = Math.floor((asOf.getTime() - new Date(`${line.dueDate as string}T00:00:00`).getTime()) / 86400000);
        const bucketIndex = daysOverdue < 0 ? 0 : daysOverdue <= 30 ? 1 : daysOverdue <= 60 ? 2 : daysOverdue <= 90 ? 3 : 4;
        existing.buckets[bucketIndex] += displayAmount;
        existing.total += displayAmount;
        if (line.date <= priorReportRange.end) {
          const priorDays = Math.floor((priorAsOf.getTime() - new Date(`${line.dueDate as string}T00:00:00`).getTime()) / 86400000);
          if (priorDays < 0 || priorDays <= 90) {
            existing.priorTotal += displayAmount;
          }
        }
        existing.lines.push(line);
        byContact.set(line.contactName, existing);
      });

    return Array.from(byContact.values()).sort((left, right) => right.total - left.total);
  }, [reportType, selectedEntity.id, reportEnd, priorReportRange]);

  const fundReport = useMemo(() => {
    // Funds are derived from the distinct fund tags carried on Roots journal
    // lines (which the seeded Fund model mirrors), so the report reads from
    // actual fund records rather than a hardcoded list.
    const funds: ReportFund[] = Array.from(
      new Set(
        ledgerLines
          .filter((line) => line.entityId === 'sprouted-roots' && line.fund)
          .map((line) => line.fund as ReportFund),
      ),
    ).sort();

    const isIncome = (line: LedgerLine) => reportAccounts[line.accountCode]?.type === 'INCOME';
    const isExpenditure = (line: LedgerLine) => ['COST_OF_SALES', 'EXPENSE'].includes(reportAccounts[line.accountCode]?.type ?? '');

    return funds.map((fund) => {
      const fundLines = ledgerLines.filter((line) => line.entityId === 'sprouted-roots' && line.fund === fund);
      const beforeStart = fundLines.filter((line) => line.date < reportStart);
      const inRange = fundLines.filter((line) => line.date >= reportStart && line.date <= reportEnd);

      // Fund balance = cumulative income less expenditure (bank legs excluded — they net to zero within each entry)
      const opening = -beforeStart.filter(isIncome).reduce((total, line) => total + line.amount, 0)
        - beforeStart.filter(isExpenditure).reduce((total, line) => total + line.amount, 0);
      const income = -inRange.filter(isIncome).reduce((total, line) => total + line.amount, 0);
      const expenditure = inRange.filter(isExpenditure).reduce((total, line) => total + line.amount, 0);
      const closing = opening + income - expenditure;
      return { fund, opening, income, expenditure, closing };
    });
  }, [reportStart, reportEnd]);

  const groupReport = useMemo(() => {
    const sections = [
      { id: 'income', label: 'Income', codes: codesOfType('INCOME'), sign: -1 },
      { id: 'cos', label: 'Cost of sales', codes: codesOfType('COST_OF_SALES'), sign: 1 },
      { id: 'gross', label: 'Gross profit', codes: [] as string[], sign: 1 },
      { id: 'expenses', label: 'Expenses', codes: codesOfType('EXPENSE'), sign: 1 },
      { id: 'net', label: 'Net surplus / (deficit)', codes: [] as string[], sign: 1 },
    ];

    const incomeValues = entities.map((entity) => -accountSum(entity.id, codesOfType('INCOME'), reportRange));
    const cosValues = entities.map((entity) => accountSum(entity.id, codesOfType('COST_OF_SALES'), reportRange));
    const expenseValues = entities.map((entity) => accountSum(entity.id, codesOfType('EXPENSE'), reportRange));

    const priorIncome = entities.reduce((total, entity) => total + (-accountSum(entity.id, codesOfType('INCOME'), priorReportRange)), 0);
    const priorCos = entities.reduce((total, entity) => total + accountSum(entity.id, codesOfType('COST_OF_SALES'), priorReportRange), 0);
    const priorExpenses = entities.reduce((total, entity) => total + accountSum(entity.id, codesOfType('EXPENSE'), priorReportRange), 0);

    return sections.map((section) => {
      const values =
        section.id === 'income'
          ? incomeValues
          : section.id === 'cos'
            ? cosValues
            : section.id === 'expenses'
              ? expenseValues
              : section.id === 'gross'
                ? incomeValues.map((value, index) => value - cosValues[index])
                : incomeValues.map((value, index) => value - cosValues[index] - expenseValues[index]);
      const total = values.reduce((sum, value) => sum + value, 0);
      const priorTotal =
        section.id === 'income'
          ? priorIncome
          : section.id === 'cos'
            ? priorCos
            : section.id === 'expenses'
              ? priorExpenses
              : section.id === 'gross'
                ? priorIncome - priorCos
                : priorIncome - priorCos - priorExpenses;
      return { ...section, values, total, priorTotal };
    });
  }, [entities, reportRange, priorReportRange]);

  const projectReport = useMemo(() => {
    const isIncome = (line: LedgerLine) => reportAccounts[line.accountCode]?.type === 'INCOME';
    const isExpenditure = (line: LedgerLine) => ['COST_OF_SALES', 'EXPENSE'].includes(reportAccounts[line.accountCode]?.type ?? '');

    return projects
      .filter((project) => project.entityId === selectedEntity.id)
      .map((project) => {
        const lines = ledgerLines.filter((line) => line.entityId === project.entityId && line.projectId === project.id);
        const beforeStart = lines.filter((line) => line.date < reportStart);
        const inRange = lines.filter((line) => line.date >= reportStart && line.date <= reportEnd);
        const toDate = lines.filter((line) => line.date <= reportEnd);

        const opening = -beforeStart.filter(isIncome).reduce((total, line) => total + line.amount, 0)
          - beforeStart.filter(isExpenditure).reduce((total, line) => total + line.amount, 0);
        const received = -inRange.filter(isIncome).reduce((total, line) => total + line.amount, 0);
        const expenses = inRange.filter(isExpenditure).reduce((total, line) => total + line.amount, 0);
        const closing = opening + received - expenses;
        const spentToDate = toDate.filter(isExpenditure).reduce((total, line) => total + line.amount, 0);
        const budgetUsedPct = project.budget > 0 ? Math.round((spentToDate / project.budget) * 100) : null;

        return { project, opening, received, expenses, closing, spentToDate, budgetUsedPct };
      });
  }, [selectedEntity.id, reportStart, reportEnd]);

  const reportDrilldownRows = useMemo(() => {
    if (!reportDrilldown) {
      return [];
    }
    const codeSet = new Set(reportDrilldown.accountCodes);
    return ledgerLines.filter(
      (line) =>
        line.entityId === reportDrilldown.entityId &&
        codeSet.has(line.accountCode) &&
        (!reportDrilldown.contactName || line.contactName === reportDrilldown.contactName) &&
        (!reportDrilldown.fund || line.fund === reportDrilldown.fund) &&
        (!reportDrilldown.projectId || line.projectId === reportDrilldown.projectId) &&
        (reportDrilldown.cumulative
          ? line.date <= reportDrilldown.range.end
          : line.date >= reportDrilldown.range.start && line.date <= reportDrilldown.range.end),
    );
  }, [reportDrilldown]);

  const reportTabs: { id: ReportType; label: string }[] = [
    { id: 'trial-balance', label: 'Trial balance' },
    { id: 'profit-loss', label: 'Profit & loss' },
    { id: 'balance-sheet', label: 'Balance sheet' },
    { id: 'cash-flow', label: 'Cash flow' },
    { id: 'aged-receivables', label: 'Aged receivables' },
    { id: 'aged-payables', label: 'Aged payables' },
    { id: 'fund-report', label: 'Fund report' },
    { id: 'projects', label: 'Projects' },
    { id: 'group-view', label: 'Group view' },
  ];

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem('sprouted-vat-filed-periods', JSON.stringify(filedPeriods));
  }, [filedPeriods]);

  const intercompanyBalances = useMemo(() => {
    const matrix = new Map<string, IntercompanyMatrixCell>();

    entities.forEach((fromEntity) => {
      entities.forEach((toEntity) => {
        if (fromEntity.id === toEntity.id) {
          return;
        }

        const key = `${fromEntity.id}->${toEntity.id}`;
        const mirroredKey = `${toEntity.id}->${fromEntity.id}`;
        matrix.set(key, {
          fromEntityId: fromEntity.id,
          toEntityId: toEntity.id,
          balance: 0,
          mirroredBalance: 0,
          mismatch: false,
        });

        if (!matrix.has(mirroredKey)) {
          matrix.set(mirroredKey, {
            fromEntityId: toEntity.id,
            toEntityId: fromEntity.id,
            balance: 0,
            mirroredBalance: 0,
            mismatch: false,
          });
        }
      });
    });

    // Each side is summed in its own functional currency. Two entities with
    // the same functional currency must net to zero; two with different ones
    // cannot, so the mirror is translated at the latest rate on file and the
    // gap is shown as an FX difference, not flagged.
    const pairs = intercompanyPairBalances(
      entities.map((entity) => ({ id: entity.id, functionalCurrency: entity.functionalCurrency })),
      intercompanyTransactions.map((transaction) => ({
        fromEntityId: transaction.fromEntityId,
        toEntityId: transaction.toEntityId,
        sides: transaction.journalEntries.map((journal) => {
          const entity = entities.find((candidate) => candidate.id === journal.entityId);
          const receivable = journal.side.filter((line) => line.type === 'debit' && line.accountCode.startsWith('10')).reduce((sum, line) => sum + line.amount, 0);
          const payable = journal.side.filter((line) => line.type === 'credit' && line.accountCode.startsWith('20')).reduce((sum, line) => sum + line.amount, 0);
          return { entityId: journal.entityId, functionalCurrency: entity?.functionalCurrency ?? 'GHS', functionalMinor: receivable - payable };
        }),
      })),
      (from, to) => {
        const pool = Object.values(initialData.ratesByEntity).flat();
        return selectRate(pool, from, to, new Date().toISOString().slice(0, 10))?.rate ?? null;
      },
    );
    pairs.forEach((pair, key) => {
      const cell = matrix.get(key);
      if (!cell) return;
      cell.balance = pair.balanceMinor;
      cell.mirroredBalance = pair.mirroredMinor;
      cell.mismatch = pair.mismatch;
      cell.balanceCurrency = pair.balanceCurrency;
      cell.mirroredCurrency = pair.mirroredCurrency;
      cell.sameCurrency = pair.sameCurrency;
      cell.translatedMirror = pair.translatedMirrorMinor;
      cell.fxDifference = pair.fxDifferenceMinor;
    });

    return matrix;
  }, [entities, intercompanyTransactions, initialData.ratesByEntity]);

  const intercompanyMismatchCount = useMemo(
    () => Array.from(intercompanyBalances.values()).filter((cell) => cell.mismatch).length,
    [intercompanyBalances],
  );

  // Switching entity reloads that entity's newest drafts into both editors;
  // a refresh() after a server function reloads the open document from what
  // the server now holds (its status and number may have changed). Both are
  // syncs from the server's state into local editing state.
  const lastSyncedEntity = useRef(selectedEntity.id);
  useEffect(() => {
    if (lastSyncedEntity.current !== selectedEntity.id) {
      lastSyncedEntity.current = selectedEntity.id;
      setSalesDocument(initialDocumentFor(initialData, selectedEntity.id, 'invoice'));
      setPurchaseDocument(initialDocumentFor(initialData, selectedEntity.id, 'bill'));
      setDocumentError(null);
      return;
    }
    const sync = (setter: typeof setSalesDocument) =>
      setter((current) => {
        if (!current.id) return current;
        const record = (initialData.documentsByEntity[selectedEntity.id] ?? []).find((document) => document.id === current.id);
        // Only adopt the server copy when it has moved on (posted, voided); an
        // in-flight draft edit must not be clobbered by its own autosave echo.
        return record && record.status !== current.status ? formFrom(record) : current;
      });
    sync(setSalesDocument);
    sync(setPurchaseDocument);
    setFiledPeriods(initialData.filedPeriodsByEntity);
    setEntities(initialData.entities);
    setContacts(initialData.contacts);
  }, [initialData, selectedEntity.id]);

  // Debounced autosave to the server for drafts. Cancelled before any post or
  // void so a stale save cannot race the status change.
  useEffect(() => {
    if (activeDocument.status !== 'draft' || (activeNav !== 'Sales' && activeNav !== 'Purchases')) {
      return;
    }
    if (!allowed('document:draft')) {
      return; // viewers never autosave; the server would refuse anyway
    }
    const entityId = selectedEntity.id;
    const snapshot = activeDocument;
    const setter = activeNav === 'Sales' ? setSalesDocument : setPurchaseDocument;
    autosaveTimer.current = window.setTimeout(() => {
      autosaveTimer.current = null;
      void saveDocumentDraft(entityId, snapshot).then((result) => {
        if (!result.ok) {
          setDocumentError(result.error);
          return;
        }
        // Adopt the server id for a document that was new, so later saves update it.
        setter((current) => (current.id ? current : { ...current, id: result.value.id }));
      });
    }, 2500);

    return () => {
      if (autosaveTimer.current !== null) {
        window.clearTimeout(autosaveTimer.current);
        autosaveTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDocument, activeNav, selectedEntity.id]);

  // One-time import of filed periods that only exist in localStorage from
  // before they were persisted. Old document drafts are simply discarded.
  // Only someone who may file periods imports them; for anyone else the
  // key is left for a later, entitled sign-in on this browser.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('sprouted-vat-filed-periods');
      if (raw && allowed('period:file')) {
        const stored = JSON.parse(raw) as Record<string, string[]>;
        for (const [entityId, periods] of Object.entries(stored)) {
          if (!initialData.entities.some((entity) => entity.id === entityId)) continue;
          for (const period of periods) {
            if (!(initialData.filedPeriodsByEntity[entityId] ?? []).includes(period)) {
              void fileTaxPeriod(entityId, period);
            }
          }
        }
        window.localStorage.removeItem('sprouted-vat-filed-periods');
      }
      for (const key of Object.keys(window.localStorage)) {
        if (/^sprouted-.*-document$/.test(key)) window.localStorage.removeItem(key);
      }
    } catch {
      // storage unavailable — nothing to import
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const metricsCards = [
    {
      label: 'Cash position',
      value: currentMetrics.cashPosition,
      helper: 'Available liquidity',
      tone: 'text-slate-900',
    },
    {
      label: 'Money owed to us',
      value: currentMetrics.moneyOwedToUs,
      helper: 'Receivables',
      tone: 'text-emerald-700',
    },
    {
      label: 'Money we owe',
      value: currentMetrics.moneyWeOwe,
      helper: 'Payables',
      tone: 'text-red-700',
    },
    {
      label: 'Intercompany balances',
      value: currentMetrics.intercompanyBalance,
      helper: currentMetrics.intercompanyBalance >= 0 ? 'Due from group' : 'Due to group',
      tone: currentMetrics.intercompanyBalance >= 0 ? 'text-amber-700' : 'text-slate-900',
    },
  ];

  function handleAddEntity(event: FormEvent) {
    event.preventDefault();

    const trimmedName = formValues.name.trim();
    if (!trimmedName) {
      return;
    }

    startDocumentTransition(async () => {
      const result = await createEntity({
        name: trimmedName,
        type: formValues.type,
        financialYearEnd: formValues.financialYearEnd,
        vatRegistered: formValues.vatRegistered,
        vatRegisteredFrom: formValues.vatRegisteredFrom,
        tin: formValues.tin,
      });
      if (!result.ok) {
        setDocumentError(result.error);
        return;
      }
      setEntities((previous) => [...previous, result.value.entity]);
      setContacts((previous) => [...previous.map((contact) => ({ ...contact, balances: { ...contact.balances, [result.value.entity.id]: 0 } })), result.value.contact]);
      setSelectedEntityId(result.value.entity.id);
      setActiveNav('Dashboard');
      setShowAddEntityForm(false);
      setFormValues(defaultFormValues);
      setEntityMenuOpen(false);
    });
  }

  function handleAddContact(event: FormEvent) {
    event.preventDefault();

    const trimmedName = contactFormValues.name.trim();
    if (!trimmedName) {
      return;
    }

    // Read before the form is reset below, which happens straight away.
    const target = contactFormTarget;

    startDocumentTransition(async () => {
      const result = await createContact({ ...contactFormValues, name: trimmedName });
      if (!result.ok) {
        setDocumentError(result.error);
        return;
      }
      setContacts((previous) => [...previous, result.value]);
      if (target === 'document') {
        updateCurrentDocument({ contactId: result.value.id });
      }
    });
    setShowAddContactForm(false);
    setContactFormValues({
      name: '',
      type: 'supplier',
      category: 'other',
      tin: '',
      phone: '',
      email: '',
      address: '',
      withholdingTaxStatus: 'none',
    });
    setContactFormTarget('list');
  }

  // Status changes go through the server functions below, never through a patch.
  function updateCurrentDocument(patch: Partial<Omit<DocumentFormState, 'status' | 'id' | 'kind'>>) {
    if (documentReadOnly) return;
    const setter = activeNav === 'Sales' ? setSalesDocument : setPurchaseDocument;
    setter((current) => ({ ...current, ...patch }));
  }

  function cancelAutosave() {
    if (autosaveTimer.current !== null) {
      window.clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
  }

  /** Save the open draft now and return its server id, saving first if it has never been saved. */
  async function ensureSaved(): Promise<string | null> {
    if (activeDocument.status !== 'draft') return activeDocument.id;
    const result = await saveDocumentDraft(selectedEntity.id, activeDocument);
    if (!result.ok) {
      setDocumentError(result.error);
      return null;
    }
    const setter = activeNav === 'Sales' ? setSalesDocument : setPurchaseDocument;
    setter((current) => ({ ...current, id: result.value.id }));
    return result.value.id;
  }

  function runDocumentAction(action: (documentId: string) => Promise<{ ok: true; value: DocumentRecord } | { ok: false; error: string }>) {
    cancelAutosave();
    setDocumentError(null);
    startDocumentTransition(async () => {
      const documentId = await ensureSaved();
      if (!documentId) return;
      const result = await action(documentId);
      if (!result.ok) {
        setDocumentError(result.error);
        return;
      }
      const setter = activeNav === 'Sales' ? setSalesDocument : setPurchaseDocument;
      setter(formFrom(result.value));
    });
  }

  function postCurrentDocument() {
    runDocumentAction((documentId) => postDocument(selectedEntity.id, documentId));
  }

  // Settling a posted document: the amount, the bank it went through, and the
  // rate the bank actually gave. The realised FX difference is shown before
  // it is posted.
  const outstandingTxn = activeRecord
    ? (activeRecord.kind === 'invoice' ? buildTotals(activeRecord, undefined, taxOf(activeRecord)).total : buildTotals(activeRecord, activeContact?.withholdingTaxStatus, taxOf(activeRecord)).netPayable) - activeRecord.paidTxnMinor
    : 0;
  const paymentRateQuote = activeRecord ? selectRate(entityRates, activeRecord.currency, functionalCurrency, paymentForm.date) : null;
  const paymentRate = activeRecord && activeRecord.currency === functionalCurrency ? '1.0' : (paymentForm.rate || paymentRateQuote?.rate || '');
  const paymentBank = entityBankAccounts.find((bank) => bank.id === paymentForm.bankAccountId) ?? entityBankAccounts.find((bank) => activeRecord && (bank.currency === activeRecord.currency || bank.currency === functionalCurrency));
  const paymentAmountMinor = Math.round(Number(paymentForm.amount || '0') * 100);
  const paymentPreview = (() => {
    if (!activeRecord?.journal || !activeRecord.rate || !paymentBank || !paymentRate || !Number.isInteger(paymentAmountMinor) || paymentAmountMinor <= 0 || paymentAmountMinor > outstandingTxn) return null;
    const controlCode = activeRecord.kind === 'invoice' ? controlAccounts.receivables : controlAccounts.payables;
    const controlPosted = activeRecord.journal.lines.filter((line) => line.accountCode === controlCode).reduce((sum, line) => sum + line.amount, 0);
    const relieved = activeRecord.payments.reduce((sum, payment) => sum + payment.reliefAmount, 0);
    try {
      return settlementFor({
        kind: activeRecord.kind,
        documentCurrency: activeRecord.currency,
        functionalCurrency,
        documentRate: activeRecord.rate,
        txnAmount: paymentAmountMinor,
        settlementRate: paymentRate,
        bankCurrency: paymentBank.currency,
        remainingBookMinor: controlPosted - relieved,
        isFinal: paymentAmountMinor === outstandingTxn,
        controlAccountCode: controlCode,
        bankAccountCode: paymentBank.accountCode,
        names: accountNames,
      });
    } catch {
      return null;
    }
  })();

  function runSetting(label: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    startSettingsTransition(async () => {
      const result = await action();
      setSettingsMessage(result.ok ? { tone: 'ok', text: label } : { tone: 'error', text: result.error ?? 'Something went wrong.' });
    });
  }
  function revalClosingRates(): Partial<Record<string, string>> {
    const lastDay = new Date(Date.UTC(Number(revalForm.period.slice(0, 4)), Number(revalForm.period.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const rates: Partial<Record<string, string>> = {};
    for (const currency of currencies) {
      if (currency === functionalCurrency) continue;
      const typed = revalForm.rates[currency]?.trim();
      rates[currency] = typed || selectRate(entityRates, currency, functionalCurrency, lastDay)?.rate || '';
    }
    return rates;
  }

  function openPaymentPanel() {
    setPaymentForm({ bankAccountId: paymentBank?.id ?? '', date: new Date().toISOString().slice(0, 10), amount: (outstandingTxn / 100).toFixed(2), rate: '' });
    setPaymentOpen(true);
  }

  function submitPayment() {
    if (!activeRecord || !paymentBank) return;
    cancelAutosave();
    setDocumentError(null);
    startDocumentTransition(async () => {
      const result = await recordPaymentAction(selectedEntity.id, {
        documentId: activeRecord.id,
        bankAccountId: paymentBank.id,
        date: paymentForm.date,
        txnAmount: paymentAmountMinor,
        rate: paymentRate,
      });
      if (!result.ok) {
        setDocumentError(result.error);
        return;
      }
      const setter = activeNav === 'Sales' ? setSalesDocument : setPurchaseDocument;
      setter(formFrom(result.value));
      setPaymentOpen(false);
    });
  }

  function voidCurrentDocument() {
    runDocumentAction((documentId) => voidDocument(selectedEntity.id, documentId));
  }

  function startNewDocument() {
    cancelAutosave();
    setDocumentError(null);
    const contact = entityContacts[0] ?? contacts[0];
    const setter = activeNav === 'Sales' ? setSalesDocument : setPurchaseDocument;
    setter(makeDocument(activeKind, contact?.id ?? '', selectedEntity.functionalCurrency));
  }

  function openDocument(record: DocumentRecord) {
    cancelAutosave();
    setDocumentError(null);
    const setter = record.kind === 'invoice' ? setSalesDocument : setPurchaseDocument;
    setter(formFrom(record));
    setActiveNav(record.kind === 'invoice' ? 'Sales' : 'Purchases');
  }

  function updateLine(lineId: string, patch: Partial<DocumentLine>) {
    if (documentReadOnly) return;
    const setter = activeNav === 'Sales' ? setSalesDocument : setPurchaseDocument;
    setter((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.id === lineId ? { ...line, ...patch } : line)),
    }));
  }

  function addLine() {
    const setter = activeNav === 'Sales' ? setSalesDocument : setPurchaseDocument;
    setter((current) => ({ ...current, lines: [...current.lines, makeLine(activeKind)] }));
  }

  function removeLine(lineId: string) {
    if (documentReadOnly) return;
    const setter = activeNav === 'Sales' ? setSalesDocument : setPurchaseDocument;
    setter((current) => ({
      ...current,
      lines: current.lines.length > 1 ? current.lines.filter((line) => line.id !== lineId) : current.lines,
    }));
  }

  function handleCreateIntercompanyTransaction(event: FormEvent) {
    event.preventDefault();

    const fromEntity = entities.find((entity) => entity.id === intercompanyForm.fromEntityId);
    const toEntity = entities.find((entity) => entity.id === intercompanyForm.toEntityId);
    const amount = Number(intercompanyForm.amount);

    if (!fromEntity || !toEntity || fromEntity.id === toEntity.id || amount <= 0) {
      return;
    }

    const reference = intercompanyForm.reference.trim() || newIntercompanyReference();
    const documentLabelFrom = `INV-${reference}`;
    const documentLabelTo = `BILL-${reference}`;

    const nextTransaction: IntercompanyTransaction = {
      id: newIntercompanyTransactionId(reference),
      reference,
      date: intercompanyForm.date,
      fromEntityId: fromEntity.id,
      toEntityId: toEntity.id,
      amount,
      description: intercompanyForm.description,
      direction: 'sale',
      journalEntries: [
        {
          entityId: fromEntity.id,
          documentLabel: documentLabelFrom,
          side: [
            { accountCode: '1010', accountName: 'Trade Receivables', amount, type: 'debit' },
            { accountCode: '4001', accountName: 'Domestic Sales', amount, type: 'credit' },
          ],
        },
        {
          entityId: toEntity.id,
          documentLabel: documentLabelTo,
          side: [
            { accountCode: '5001', accountName: 'Raw Materials Used', amount, type: 'debit' },
            { accountCode: '2001', accountName: 'Trade Payables', amount, type: 'credit' },
          ],
        },
      ],
    };

    setIntercompanyTransactions((current) => [nextTransaction, ...current]);
    void auditEvent({
      entityId: fromEntity.id,
      action: 'POST',
      resourceType: 'intercompany',
      resourceRef: reference,
      summary: `Intercompany ${reference}: ${fromEntity.name} → ${toEntity.name}, GHS ${(amount / 100).toFixed(2)} (mirrored to ${toEntity.name})`,
    });
    setIntercompanyForm((current) => ({
      ...current,
      reference: `IC-${Date.now().toString().slice(-4)}`,
      amount: 0,
      description: 'Raw material supply',
    }));
  }

  function fileSelectedTaxPeriod() {
    if (isSelectedPeriodFiled) {
      return;
    }

    const entityId = selectedEntity.id;
    startDocumentTransition(async () => {
      const result = await fileTaxPeriod(entityId, selectedTaxPeriod);
      if (!result.ok) {
        setDocumentError(result.error);
        return;
      }
      setFiledPeriods((current) => ({ ...current, [entityId]: result.value }));
    });
  }

  function downloadWhtCsv() {
    if (whtRows.length === 0) {
      return;
    }

    const header = 'Supplier,TIN,WHT rate,Documents,Gross (GHS),WHT withheld (GHS)';
    const rows = whtRows.map((row) =>
      [
        `"${row.name.replace(/"/g, '""')}"`,
        row.tin,
        `${Math.round(row.rate * 100)}%`,
        row.documents,
        (row.gross / 100).toFixed(2),
        (row.withheld / 100).toFixed(2),
      ].join(','),
    );

    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `wht-${selectedEntity.id}-${selectedTaxPeriod}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function downloadCsvFileBase(filename: string, rows: string[]) {
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function openReportDrilldown(
    title: string,
    accountCodes: string[],
    range: ReportRange,
    cumulative: boolean,
    entityId?: string,
    contactName?: string,
    fund?: ReportFund,
    projectId?: string,
  ) {
    setReportDrilldown({
      title,
      entityId: entityId ?? selectedEntity.id,
      accountCodes,
      range,
      cumulative,
      contactName,
      fund,
      projectId,
    });
  }

  // Translation for reports: the functional figures converted at one chosen
  // rate. Presentation only — the books stay in the functional currency.
  const reportDisplayCurrency: Currency = reportCurrency === 'functional' ? functionalCurrency : reportCurrency;
  const translationQuote = reportCurrency === 'functional' ? null : selectRate(entityRates, functionalCurrency, reportCurrency, reportEnd);
  const effectiveTranslationRate = reportCurrency === 'functional' ? '1.0' : (translationRate.trim() || translationQuote?.rate || '');
  const translationActive = reportCurrency !== 'functional' && Boolean(effectiveTranslationRate);
  const reportTranslate = (minor: number) => (translationActive ? convertMinor(minor, effectiveTranslationRate) : minor);
  // Shadows the module helper for everything exportReportCsv writes.
  const pesewasToGhs = (value: number) => (reportTranslate(value) / 100).toFixed(2);
  const downloadCsvFile = (name: string, rows: string[]) =>
    downloadCsvFileBase(name, [
      translationActive
        ? `Amounts in ${reportDisplayCurrency} translated from ${functionalCurrency} at ${effectiveTranslationRate} (presentation only; the books are in ${functionalCurrency})`
        : `Amounts in ${functionalCurrency}`,
      ...rows,
    ]);

  function exportReportCsv() {
    const fileStem = `${reportType}-${selectedEntity.id}-${reportStart}-${reportEnd}`;

    if (reportType === 'aged-receivables' || reportType === 'aged-payables') {
      const label = reportType === 'aged-receivables' ? 'Aged receivables' : 'Aged payables';
      const header = `${csvEscape(label)} ${csvEscape(selectedEntity.name)} as at ${reportEnd},Current,1-30 days,31-60 days,61-90 days,90+ days,Total,Prior period total`;
      const rows = agingRows.map((row) =>
        [
          csvEscape(row.contactName),
          '',
          ...row.buckets.map(pesewasToGhs),
          pesewasToGhs(row.total),
          pesewasToGhs(row.priorTotal),
        ].join(','),
      );
      downloadCsvFile(`${fileStem}.csv`, [header, ...rows]);
      return;
    }

    if (reportType === 'fund-report') {
      const header = `Fund report Sprouted Roots ${reportStart} to ${reportEnd},Restricted,Unrestricted,Total`;
      const metricRow = (label: string, pick: (fund: (typeof fundReport)[number]) => number) =>
        [csvEscape(label), ...fundReport.map((fund) => pesewasToGhs(pick(fund))), pesewasToGhs(fundReport.reduce((sum, fund) => sum + pick(fund), 0))].join(',');
      downloadCsvFile(`${fileStem}.csv`, [
        header,
        metricRow('Opening balance', (fund) => fund.opening),
        metricRow('Income', (fund) => fund.income),
        metricRow('Expenditure', (fund) => fund.expenditure),
        metricRow('Closing balance', (fund) => fund.closing),
      ]);
      return;
    }

    if (reportType === 'projects') {
      const header = `Project report ${csvEscape(selectedEntity.name)} ${reportStart} to ${reportEnd},Funder,Fund,Opening,Funds received,Expenses,Closing balance,Budget,Spent to date,% budget used`;
      const rows = projectReport.map((row) =>
        [
          csvEscape(row.project.name),
          csvEscape(row.project.funder),
          row.project.fund,
          pesewasToGhs(row.opening),
          pesewasToGhs(row.received),
          pesewasToGhs(row.expenses),
          pesewasToGhs(row.closing),
          row.project.budget > 0 ? pesewasToGhs(row.project.budget) : '',
          pesewasToGhs(row.spentToDate),
          row.budgetUsedPct !== null ? `${row.budgetUsedPct}%` : '',
        ].join(','),
      );
      downloadCsvFile(`${fileStem}.csv`, [header, ...rows]);
      return;
    }

    if (reportType === 'group-view') {
      const header = ['Line', ...entities.map((entity) => csvEscape(entity.name)), 'Group total', 'Prior period total'].join(',');
      const rows = groupReport.map((section) =>
        [csvEscape(section.label), ...section.values.map(pesewasToGhs), pesewasToGhs(section.total), pesewasToGhs(section.priorTotal)].join(','),
      );
      downloadCsvFile(`${fileStem}.csv`, ['"MANAGEMENT SUMMARY ONLY - NOT STATUTORY CONSOLIDATED ACCOUNTS. No intercompany eliminations applied."', header, ...rows]);
      return;
    }

    const header = `${csvEscape(standardReport.title)},${standardReport.columns.join(',')}${standardReport.trialBalance ? '' : ',Variance'}`;
    const rows = standardReport.rows
      .filter((row) => row.kind !== 'header')
      .map((row) => {
        if (standardReport.trialBalance) {
          return [
            csvEscape(row.label),
            pesewasToGhs(Math.max(row.current, 0)),
            pesewasToGhs(row.creditCurrent ?? Math.max(-row.current, 0)),
            pesewasToGhs(Math.max(row.prior, 0)),
            pesewasToGhs(row.creditPrior ?? Math.max(-row.prior, 0)),
          ].join(',');
        }
        return [csvEscape(row.label), pesewasToGhs(row.current), pesewasToGhs(row.prior), pesewasToGhs(row.current - row.prior)].join(',');
      });
    downloadCsvFile(`${fileStem}.csv`, [header, ...rows]);
  }

  async function auditEvent(event: {
    entityId: string;
    action: 'POST' | 'EDIT' | 'VOID' | 'MATCH' | 'BACKUP' | 'FILE_PERIOD';
    resourceType: string;
    resourceRef: string;
    summary: string;
    metadata?: Record<string, unknown>;
  }) {
    try {
      await fetch('/api/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event), // the server records the session's user, not a name from the browser
      });
    } catch {
      // The audit API is best-effort while the app runs in demo mode without a live server session.
    }
  }

  async function loadSettingsData() {
    try {
      const [backupResponse, auditResponse] = await Promise.all([
        fetch(`/api/backups?entityId=${encodeURIComponent(selectedEntity.id)}`),
        fetch(`/api/audit?entityId=${encodeURIComponent(selectedEntity.id)}`),
      ]);

      if (backupResponse.ok) {
        const payload = (await backupResponse.json()) as {
          runs: BackupRunView[];
          lastSuccessful: BackupRunView | null;
          lastRunFailed: boolean;
        };
        setBackupRuns(payload.runs);
        setLastSuccessfulBackup(payload.lastSuccessful);
        setLastBackupFailed(payload.lastRunFailed);
      }

      if (auditResponse.ok) {
        const payload = (await auditResponse.json()) as { events: AuditEventView[]; chainIntact: boolean };
        setAuditEvents(payload.events);
        setAuditChainIntact(payload.chainIntact);
      }
    } catch {
      // Settings data is read-only; ignore transient failures in demo mode.
    }
  }

  async function triggerManualBackup() {
    setBackupBusy(true);
    setBackupError(null);
    try {
      const response = await fetch('/api/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId: selectedEntity.id }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string | null } | null;
        setBackupError(payload?.error ?? 'The export did not complete. No file was written.');
      }
      await loadSettingsData();
    } catch {
      setBackupError('Could not reach the server to run an export.');
    } finally {
      setBackupBusy(false);
    }
  }

  useEffect(() => {
    if (activeNav === 'Settings' && allowed('export:run')) {
      // loadSettingsData only sets state after its fetches resolve, so this is
      // the ordinary fetch-in-effect pattern, not a synchronous setState.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadSettingsData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNav, selectedEntity.id]);

  const documentTitle = isPurchaseView ? 'Purchase bill' : 'Sales invoice';

  const bankAccountOptions = [
    { code: '1010', name: 'Trade Receivables' },
    { code: '1101', name: 'VAT Input Tax Recoverable' },
    { code: '1102', name: 'NHIL Input Tax Recoverable' },
    { code: '1103', name: 'GETFund Input Tax Recoverable' },
    { code: '2001', name: 'Trade Payables' },
    { code: '2020', name: 'VAT Output Tax Payable' },
    { code: '2025', name: 'NHIL Payable' },
    { code: '2030', name: 'GETFund Payable' },
    { code: '2035', name: 'Withholding Tax Payable' },
    { code: '4001', name: 'Domestic Sales' },
    { code: '4005', name: 'Export Sales' },
    { code: '5001', name: 'Raw Materials Used' },
    { code: '6001', name: 'Factory Utilities' },
  ];

  const initialBankLines: BankLine[] = [
    {
      id: 'bank-001',
      date: '2026-09-10',
      amount: 182500,
      description: 'Cocoa Partners Limited',
      reference: 'INV-1042',
      bank: 'Ecobank',
      status: 'unreconciled',
    },
    {
      id: 'bank-002',
      date: '2026-09-09',
      amount: -128400,
      description: 'Sprouted Roots transfer',
      reference: 'BILL-2198',
      bank: 'Ecobank',
      status: 'unreconciled',
    },
    {
      id: 'bank-003',
      date: '2026-09-12',
      amount: -45600,
      description: 'Akwasi Logistics',
      reference: 'BILL-2201',
      bank: 'Ecobank',
      status: 'unreconciled',
    },
    {
      id: 'bank-004',
      date: '2026-09-11',
      amount: 96000,
      description: 'Nana Akua Farms',
      reference: 'INV-1044',
      bank: 'Ecobank',
      status: 'unreconciled',
    },
    {
      id: 'bank-005',
      date: '2026-09-13',
      amount: 245000,
      description: 'Cocoa Partners Limited',
      reference: 'INV-1046',
      bank: 'Ecobank',
      status: 'unreconciled',
    },
    {
      id: 'bank-006',
      date: '2026-09-13',
      amount: -24000,
      description: 'Staff transport allowance',
      reference: 'TX-9007',
      bank: 'Ecobank',
      status: 'unreconciled',
    },
  ];

  function parseCsvContent(csvText: string) {
    const rows: string[][] = [];
    let row: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let index = 0; index < csvText.length; index += 1) {
      const char = csvText[index];
      const nextChar = csvText[index + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (char === ',' && !inQuotes) {
        row.push(current);
        current = '';
        continue;
      }

      if ((char === '\n' || char === '\r') && !inQuotes) {
        if (char === '\r' && nextChar === '\n') {
          index += 1;
        }
        row.push(current);
        if (row.some((cell) => cell.trim().length > 0)) {
          rows.push(row);
        }
        row = [];
        current = '';
        continue;
      }

      current += char;
    }

    if (current.length > 0 || row.length > 0) {
      row.push(current);
      if (row.some((cell) => cell.trim().length > 0)) {
        rows.push(row);
      }
    }

    return rows.filter((values) => values.some((value) => value.trim().length > 0));
  }

  function parseAmount(value: string) {
    const cleaned = value.replace(/[^0-9,.-]/g, '').replace(/,/g, '');
    const parsed = Number.parseFloat(cleaned || '0');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const [bankMappings, setBankMappings] = useState<Record<string, CsvMapping>>(() => {
    if (typeof window === 'undefined') {
      return {};
    }

    try {
      const raw = window.localStorage.getItem('sprouted-bank-mappings');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  const [bankLines, setBankLines] = useState<BankLine[]>(initialBankLines);
  const [selectedBankIndex, setSelectedBankIndex] = useState(0);
  const [pendingCsvRows, setPendingCsvRows] = useState<string[][]>([]);
  const [pendingBankName, setPendingBankName] = useState('Ecobank');
  const [importMappingOpen, setImportMappingOpen] = useState(false);
  const [csvImportMap, setCsvImportMap] = useState<CsvMapping>({
    date: 'date',
    amount: 'amount',
    description: 'description',
    reference: 'reference',
    bank: 'bank',
  });
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedBankLine = bankLines[selectedBankIndex] ?? bankLines[0];
  const selectedSuggestions = useMemo(
    () => (selectedBankLine ? getSuggestionsForBankLine(selectedBankLine) : []),
    [selectedBankLine],
  );
  const unreconciledCount = bankLines.filter((line) => line.status === 'unreconciled').length;

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem('sprouted-bank-mappings', JSON.stringify(bankMappings));
  }, [bankMappings]);

  // When lines are removed the selection can point past the end. Adjusting
  // state during render (rather than in an effect) lets React re-render
  // immediately without committing the stale frame first.
  if (selectedBankIndex > bankLines.length - 1) {
    setSelectedBankIndex(Math.max(bankLines.length - 1, 0));
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) {
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedBankIndex((current) => Math.min(current + 1, Math.max(bankLines.length - 1, 0)));
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedBankIndex((current) => Math.max(current - 1, 0));
      }

      if (event.key === 'Enter' && bankLines.length > 0 && selectedBankLine) {
        const suggestion = selectedSuggestions[0];
        if (suggestion) {
          event.preventDefault();
          setBankLines((current) =>
            current.map((line) =>
              line.id === selectedBankLine.id
                ? {
                    ...line,
                    status: 'matched',
                    matchedDocumentId: suggestion.id,
                    matchedDocumentLabel: suggestion.label,
                    matchedDocumentType: suggestion.type,
                    matchedContact: suggestion.contactName,
                  }
                : line,
            ),
          );
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [bankLines.length, selectedBankLine, selectedSuggestions]);

  function applyBankMatch(lineId: string, suggestion: BankSuggestion) {
    const line = bankLines.find((entry) => entry.id === lineId);
    setBankLines((current) =>
      current.map((line) =>
        line.id === lineId
          ? {
              ...line,
              status: 'matched',
              matchedDocumentId: suggestion.id,
              matchedDocumentLabel: suggestion.label,
              matchedDocumentType: suggestion.type,
              matchedContact: suggestion.contactName,
            }
          : line,
      ),
    );
    if (line) {
      void auditEvent({
        entityId: selectedEntity.id,
        action: 'MATCH',
        resourceType: 'bank-line',
        resourceRef: line.reference,
        summary: `Bank line ${line.reference} matched to ${suggestion.label} (${suggestion.contactName})`,
      });
    }
  }

  function undoBankMatch(lineId: string) {
    const line = bankLines.find((entry) => entry.id === lineId);
    setBankLines((current) =>
      current.map((line) =>
        line.id === lineId
          ? {
              ...line,
              status: 'unreconciled',
              matchedDocumentId: undefined,
              matchedDocumentLabel: undefined,
              matchedDocumentType: undefined,
              matchedContact: undefined,
            }
          : line,
      ),
    );
    if (line) {
      void auditEvent({
        entityId: selectedEntity.id,
        action: 'EDIT',
        resourceType: 'bank-line',
        resourceRef: line.reference,
        summary: `Bank line ${line.reference} match undone (was ${line.matchedDocumentLabel ?? 'unmatched'})`,
      });
    }
  }

  function codeBankLineToAccount(lineId: string, accountCode: string) {
    const account = bankAccountOptions.find((entry) => entry.code === accountCode) ?? bankAccountOptions[0];
    const line = bankLines.find((entry) => entry.id === lineId);

    setBankLines((current) =>
      current.map((line) =>
        line.id === lineId
          ? {
              ...line,
              status: 'coded',
              accountCode: account.code,
              accountName: account.name,
            }
          : line,
      ),
    );
    if (line) {
      void auditEvent({
        entityId: selectedEntity.id,
        action: 'POST',
        resourceType: 'bank-line',
        resourceRef: line.reference,
        summary: `Bank line ${line.reference} coded to ${account.code} · ${account.name}`,
      });
    }
  }

  function applyRepeatedIdenticalMatch() {
    const grouped = new Map<string, BankLine[]>();

    bankLines.forEach((line) => {
      const key = `${Math.abs(line.amount)}-${normalizeForMatch(line.description)}`;
      const items = grouped.get(key) ?? [];
      items.push(line);
      grouped.set(key, items);
    });

    grouped.forEach((items) => {
      if (items.length < 2) {
        return;
      }

      const bestSuggestion = getSuggestionsForBankLine(items[0])[0];
      if (!bestSuggestion) {
        return;
      }

      items.forEach((line) => {
        if (line.status !== 'matched' && line.status !== 'coded') {
          applyBankMatch(line.id, bestSuggestion);
        }
      });
    });
  }

  function importCsvRows(bankName: string, rows: string[][], mapping: CsvMapping) {
    const columns = rows[0] ?? [];
    const dateIndex = columns.findIndex((column) => normalizeForMatch(column) === normalizeForMatch(mapping.date));
    const amountIndex = columns.findIndex((column) => normalizeForMatch(column) === normalizeForMatch(mapping.amount));
    const descriptionIndex = columns.findIndex((column) => normalizeForMatch(column) === normalizeForMatch(mapping.description));
    const referenceIndex = columns.findIndex((column) => normalizeForMatch(column) === normalizeForMatch(mapping.reference));
    const bankIndex = columns.findIndex((column) => normalizeForMatch(column) === normalizeForMatch(mapping.bank));

    const imported = rows.slice(1).map((row, index) => {
      const dateRaw = row[dateIndex] ?? new Date().toISOString().slice(0, 10);
      const amountRaw = row[amountIndex] ?? '0';
      const descriptionRaw = row[descriptionIndex] ?? `Imported ${bankName} ${index + 1}`;
      const referenceRaw = row[referenceIndex] ?? `CSV-${index + 1}`;
      const bankRaw = row[bankIndex] ?? bankName;

      return {
        id: `${bankName.toLowerCase()}-${Date.now()}-${index}`,
        date: dateRaw.trim() || new Date().toISOString().slice(0, 10),
        amount: parseAmount(amountRaw),
        description: descriptionRaw.trim() || `Imported ${bankName} ${index + 1}`,
        reference: referenceRaw.trim() || `CSV-${index + 1}`,
        bank: bankRaw.trim() || bankName,
        status: 'unreconciled' as const,
      };
    });

    setBankLines((current) => [...imported, ...current]);
    setSelectedBankIndex(0);
    setImportMappingOpen(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  function handleCsvImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const bankName = file.name.replace(/\.[^.]+$/, '') || 'Bank Feed';
    const reader = new FileReader();

    reader.onload = () => {
      const content = String(reader.result ?? '');
      const parsedRows = parseCsvContent(content);
      if (parsedRows.length === 0) {
        return;
      }

      const savedMapping = bankMappings[bankName];
      if (savedMapping) {
        importCsvRows(bankName, parsedRows, savedMapping);
        return;
      }

      const headerRow = parsedRows[0].map((entry, index) => entry.trim() || `Column ${index + 1}`);
      const fallbackMap: CsvMapping = {
        date: headerRow[0] ?? 'date',
        amount: headerRow[1] ?? 'amount',
        description: headerRow[2] ?? 'description',
        reference: headerRow[3] ?? 'reference',
        bank: headerRow[4] ?? 'bank',
      };

      setPendingCsvRows(parsedRows);
      setPendingBankName(bankName);
      setCsvImportMap(fallbackMap);
      setImportMappingOpen(true);
    };

    reader.readAsText(file);
    event.target.value = '';
  }

  function saveCsvMapping() {
    const nextMapping = {
      ...bankMappings,
      [pendingBankName]: csvImportMap,
    };
    setBankMappings(nextMapping);
    importCsvRows(pendingBankName, pendingCsvRows, csvImportMap);
  }

  return (
    <CurrencyProvider currency={functionalCurrency}>
    <div className="flex min-h-screen bg-sand-50 text-slate-900">
      <aside className="w-[280px] border-r border-slate-200 bg-white px-4 py-5">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
          <button
            type="button"
            onClick={() => setEntityMenuOpen((current) => !current)}
            className="flex w-full items-center justify-between gap-3 text-left"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span
                className="h-3.5 w-3.5 rounded-full ring-4 ring-white"
                style={{ backgroundColor: selectedEntity.accent }}
              />
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Current entity
                </div>
                <div className="truncate text-base font-semibold text-slate-900">
                  {selectedEntity.name}
                </div>
              </div>
            </div>
            <span className="text-lg text-slate-500">▾</span>
          </button>

          {entityMenuOpen ? (
            <div className="mt-3 space-y-1 rounded-xl border border-slate-200 bg-white p-1 shadow-soft">
              {entities.map((entity) => {
                const isSelected = entity.id === selectedEntity.id;

                return (
                  <button
                    key={entity.id}
                    type="button"
                    onClick={() => {
                      setSelectedEntityId(entity.id);
                      if ((activeNav === 'Tax' && !entity.vatRegistered) || ((activeNav === 'Inventory' || activeNav === 'Buying' || activeNav === 'Contracts') && !holdsStock(entity.type)) || (activeNav === 'Grants' && !runsGrants(entity.type))) {
                        setActiveNav('Dashboard');
                      }
                      setEntityMenuOpen(false);
                    }}
                    className={[
                      'flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm transition-colors duration-150 ease-out',
                      isSelected ? 'bg-slate-100 text-slate-900' : 'text-slate-700 hover:bg-slate-50',
                    ].join(' ')}
                  >
                    <span className="flex items-center gap-2.5">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: entity.accent }}
                      />
                      {entity.name}
                    </span>
                    {isSelected ? <span className="text-xs">✓</span> : null}
                  </button>
                );
              })}

              {allowed('entity:create') ? (
                <button
                  type="button"
                  onClick={() => {
                    setShowAddEntityForm(true);
                    setEntityMenuOpen(false);
                  }}
                  className="mt-1 flex w-full items-center justify-between rounded-lg border border-dashed border-brand-200 bg-brand-50 px-2.5 py-2 text-left text-sm font-medium text-brand-800 hover:bg-brand-100"
                >
                  <span>Add entity</span>
                  <span>＋</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <nav className="mt-6 space-y-1">
          {visibleNavigation.map((item) => {
            const active = item === activeNav;
            return (
              <button
                key={item}
                type="button"
                onClick={() => setActiveNav(item)}
                className={[
                  'flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors duration-150 ease-out',
                  active
                    ? 'bg-brand-50 text-brand-800 ring-1 ring-brand-100'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                ].join(' ')}
              >
                <span>{item}</span>
                {active ? <span className="h-2 w-2 rounded-full bg-brand-700" /> : null}
              </button>
            );
          })}
        </nav>

        {allowed('users:manage') ? (
          <nav className="mt-6 space-y-1 border-t border-slate-100 pt-4">
            <p className="px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Owner</p>
            <a href="/admin/users" className="block rounded-xl px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900">
              Users
            </a>
            <a href="/admin/sessions" className="block rounded-xl px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900">
              Sessions
            </a>
          </nav>
        ) : null}

        <div className="mt-6 border-t border-slate-100 pt-4">
          <p className="truncate px-3 text-sm font-medium text-slate-900">{currentUser.name}</p>
          <p className="truncate px-3 text-xs text-slate-500">{currentUser.roleLabel}</p>
          <div className="px-3 pt-2">
            <SignOutButton />
          </div>
        </div>
      </aside>

      <div className="flex-1">
        <header className="border-b border-slate-200 bg-white/80 px-6 py-4 backdrop-blur-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Workspace</p>
              <h1 className="mt-1 text-2xl font-semibold text-slate-900">{activeNav}</h1>
            </div>
            <div className="flex items-center gap-3">
              <Button variant="secondary" size="sm">
                Export
              </Button>
              <Button size="sm">Add transaction</Button>
            </div>
          </div>
        </header>

        <main className="space-y-6 p-6">
          {activeNav === 'Dashboard' ? (
            <>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                {metricsCards.map((card) => (
                  <Card key={card.label} className="rounded-2xl">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {card.label}
                    </p>
                    <div className="mt-3 flex items-end justify-between gap-3">
                      <div className={['font-mono text-3xl tabular-nums', card.tone].join(' ')}>
                        <Money value={card.value} />
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">{card.helper}</p>
                  </Card>
                ))}
              </div>

              {payrollOwed ? (
                <Card className={['rounded-2xl border', payrollOwed.overdueMinor > 0 ? 'border-red-300 bg-red-50' : 'border-slate-200'].join(' ')}>
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Payroll outstanding</p>
                      <p className="mt-2 text-sm text-slate-700">
                        <span className="font-semibold">
                          <Money value={payrollOwed.outstandingMinor} />
                        </span>{' '}
                        still to pay
                        {payrollOwed.overdueMinor > 0 ? (
                          <>
                            , of which{' '}
                            <span className="font-semibold text-red-800">
                              <Money value={payrollOwed.overdueMinor} /> is past due
                            </span>
                          </>
                        ) : null}
                        .
                        {payrollOwed.next ? (
                          <>
                            {' '}
                            Next: {liabilityKindLabels[payrollOwed.next.kind]} for {payrollOwed.next.period} by <span className="font-semibold">{payrollOwed.next.dueDate}</span>.
                          </>
                        ) : null}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {payrollOwed.rows.slice(0, 6).map((row) => (
                        <span
                          key={row.id}
                          className={['rounded-lg border px-2.5 py-1.5', row.overdue ? 'border-red-300 bg-red-100 text-red-900' : 'border-slate-200 bg-white text-slate-600'].join(' ')}
                        >
                          {liabilityKindLabels[row.kind]} · {row.dueDate}
                        </span>
                      ))}
                    </div>
                  </div>
                </Card>
              ) : null}

              {provisionalTax ? (
                <Card className={['rounded-2xl border', provisionalTax.position.overdueMinor > 0 ? 'border-red-300 bg-red-50' : 'border-slate-200'].join(' ')}>
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Provisional tax · {provisionalTax.year.label}</p>
                      <p className="mt-2 text-sm text-slate-700">
                        {provisionalTax.position.overdueMinor > 0 ? (
                          <>
                            <span className="font-semibold text-red-800">
                              <Money value={provisionalTax.position.overdueMinor} /> is past due.
                            </span>{' '}
                          </>
                        ) : null}
                        {provisionalTax.position.next ? (
                          <>
                            Quarter {provisionalTax.position.next.quarter} of <Money value={provisionalTax.position.next.outstandingMinor} /> falls due on{' '}
                            <span className="font-semibold">{provisionalTax.position.next.dueDate}</span>.
                          </>
                        ) : provisionalTax.position.outstandingMinor === 0 ? (
                          'All four instalments are settled.'
                        ) : (
                          'Every remaining instalment is past its date.'
                        )}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {provisionalTax.position.instalments.map((row) => (
                        <span
                          key={row.quarter}
                          className={[
                            'rounded-lg border px-2.5 py-1.5',
                            row.outstandingMinor === 0 ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : row.overdue ? 'border-red-300 bg-red-100 text-red-900' : 'border-slate-200 bg-white text-slate-600',
                          ].join(' ')}
                        >
                          Q{row.quarter} · {row.dueDate}
                        </span>
                      ))}
                    </div>
                  </div>
                </Card>
              ) : null}

              <Card
                className={[
                  'rounded-2xl border',
                  vatThreshold.level === 'exceeded' || vatThreshold.level === 'critical'
                    ? 'border-red-300 bg-red-50'
                    : vatThreshold.level === 'warning'
                      ? 'border-amber-300 bg-amber-50'
                      : 'border-slate-200',
                ].join(' ')}
              >
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">VAT registration threshold</p>
                    <h2 className="mt-1 text-xl font-semibold text-slate-900">
                      {vatThreshold.percent}% of GH₵750,000 · {vatRegistrationLabel}
                    </h2>
                    <p className="mt-1 text-sm text-slate-600">
                      Taxable supplies in the twelve months to {vatThreshold.asOf}: <Money value={vatThreshold.turnover} /> of <Money value={VAT_REGISTRATION_THRESHOLD_MINOR} currency="GHS" />. Posted invoices, standard and zero-rated lines; exempt supplies do not count.
                      {functionalCurrency !== 'GHS' ? ` The threshold is set in GHS; this figure is in ${functionalCurrency}.` : ''}
                    </p>
                    <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-white ring-1 ring-slate-200">
                      <div
                        className={[
                          'h-full rounded-full',
                          vatThreshold.level === 'clear' ? 'bg-emerald-500' : vatThreshold.level === 'warning' ? 'bg-amber-500' : 'bg-red-600',
                        ].join(' ')}
                        style={{ width: `${Math.min(vatThreshold.percent, 100)}%` }}
                      />
                    </div>
                  </div>
                  {vatThreshold.level !== 'clear' ? (
                    <div className={['max-w-sm rounded-xl px-4 py-3 text-sm font-medium', vatThreshold.level === 'warning' ? 'bg-amber-100 text-amber-900' : 'bg-red-100 text-red-900'].join(' ')}>
                      {vatThreshold.level === 'exceeded'
                        ? `${selectedEntity.name} has passed the GH₵750,000 threshold. Registration for VAT is compulsory — switch it on under Settings with the date GRA gives you.`
                        : vatThreshold.level === 'critical'
                          ? `Warning: ${selectedEntity.name} is above 90% of the VAT registration threshold. Prepare to register.`
                          : `Warning: ${selectedEntity.name} is above 75% of the VAT registration threshold.`}
                    </div>
                  ) : null}
                </div>
              </Card>

              {entityHoldsStock ? (
                <Card className={['rounded-2xl', floatSummaries.some((summary) => summary.overdue) ? 'border-red-300 bg-red-50' : ''].join(' ')}>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Buying agents</p>
                      <h2 className="mt-1 text-xl font-semibold text-slate-900">Outstanding float</h2>
                      <p className="mt-1 text-sm text-slate-600">Advanced less purchases posted less cash returned. Red after {selectedEntity.floatAgeLimitDays} days.</p>
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => setActiveNav('Buying')}>Open buying</Button>
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    {floatSummaries.map((summary) => (
                      <div key={summary.agentId} className={['rounded-xl border p-3', summary.overdue ? 'border-red-400 bg-white' : 'border-slate-200 bg-slate-50'].join(' ')}>
                        <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium text-slate-900">{summary.agentName}</span>{summary.overdue ? <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white">{summary.oldestAgeDays} days</span> : <span className="text-xs text-slate-500">{summary.oldestAgeDays} days</span>}</div>
                        <div className={['mt-1 font-mono text-xl tabular-nums', summary.overdue ? 'text-red-800' : 'text-slate-900'].join(' ')}><Money value={summary.outstandingMinor} /></div>
                      </div>
                    ))}
                    {floatSummaries.length === 0 ? <p className="text-sm text-slate-600">No float outstanding.</p> : null}
                  </div>
                </Card>
              ) : null}

              <Card className="rounded-2xl">
                <div className="flex items-start justify-between gap-4 pb-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Shared contacts</p>
                    <h2 className="mt-1 text-xl font-semibold text-slate-900">Contacts</h2>
                  </div>
                  {allowed('contact:create') ? (
                    <Button size="sm" onClick={() => { setContactFormTarget('list'); setShowAddContactForm(true); }}>Add contact</Button>
                  ) : null}
                </div>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {entityContacts.map((contact) => (
                    <div key={contact.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-base font-semibold text-slate-900">{contact.name}</div>
                          <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            {contact.category === 'group-entity' ? 'Group entity' : contact.category}
                          </div>
                        </div>
                        <span className="rounded-full bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-700">
                          {contact.type}
                        </span>
                      </div>

                      <div className="mt-3 space-y-2 text-sm text-slate-600">
                        <div><span className="font-medium text-slate-700">TIN:</span> {contact.tin}</div>
                        <div>
                          <span className="font-medium text-slate-700">Phone:</span>{' '}
                          <MaskedDetail entityId={selectedEntity.id} subjectKind="contact" subjectId={contact.id} field="Contact.phone" masked={contact.phone} allowed={allowed} />
                        </div>
                        <div>
                          <span className="font-medium text-slate-700">Email:</span>{' '}
                          <MaskedDetail entityId={selectedEntity.id} subjectKind="contact" subjectId={contact.id} field="Contact.email" masked={contact.email} allowed={allowed} />
                        </div>
                        <div><span className="font-medium text-slate-700">WHT:</span> {contact.withholdingTaxStatus}</div>
                      </div>

                      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Entity balance</div>
                        <div className="mt-2 font-mono text-lg tabular-nums text-slate-900">
                          <Money value={contact.balances[selectedEntity.id] ?? 0} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
                <Card className="rounded-2xl">
                  <div className="flex items-center justify-between gap-4 pb-4">
                    <h2 className="text-lg font-semibold text-slate-900">Recent activity</h2>
                    <Button variant="secondary" size="sm">
                      View all
                    </Button>
                  </div>

                  <div className="overflow-hidden rounded-xl border border-slate-200">
                    <div className="grid grid-cols-[1.4fr_0.8fr_0.8fr] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                      <span>Transaction</span>
                      <span>Status</span>
                      <span className="text-right">Amount</span>
                    </div>

                    {summaryRows.map((row) => (
                      <div
                        key={row.label}
                        className="grid grid-cols-[1.4fr_0.8fr_0.8fr] items-center gap-3 border-t border-slate-200 px-4 py-3"
                      >
                        <div>
                          <div className="text-sm font-medium text-slate-900">{row.label}</div>
                        </div>
                        <div>
                          <span
                            className={[
                              'inline-flex rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]',
                              row.tone === 'success'
                                ? 'bg-emerald-100 text-emerald-700'
                                : row.tone === 'danger'
                                  ? 'bg-red-100 text-red-700'
                                  : 'bg-slate-100 text-slate-700',
                            ].join(' ')}
                          >
                            {row.status}
                          </span>
                        </div>
                        <div className="text-right">
                          <span
                            className={[
                              'font-mono text-sm tabular-nums',
                              row.value >= 0 ? 'text-emerald-700' : 'text-red-700',
                            ].join(' ')}
                          >
                            <Money value={row.value} />
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>

                <Card className="rounded-2xl">
                  <h2 className="text-lg font-semibold text-slate-900">Intercompany</h2>
                  <div className="mt-4 space-y-3">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <div className="flex items-center justify-between text-sm text-slate-600">
                        <span>Sprouted Roots</span>
                        <span className="font-medium text-emerald-700">Due to us</span>
                      </div>
                      <div className="mt-2 font-mono text-xl tabular-nums text-slate-900">
                        <Money value={620000} />
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <div className="flex items-center justify-between text-sm text-slate-600">
                        <span>Sprouted Crafts</span>
                        <span className="font-medium text-red-700">We owe</span>
                      </div>
                      <div className="mt-2 font-mono text-xl tabular-nums text-slate-900">
                        <Money value={-380000} />
                      </div>
                    </div>

                    <div className="rounded-xl border border-brand-200 bg-brand-50 p-3">
                      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-700">Net group position</div>
                      <div className="mt-2 font-mono text-2xl tabular-nums text-brand-900">
                        <Money value={currentMetrics.intercompanyBalance} />
                      </div>
                    </div>
                  </div>
                </Card>
              </div>
            </>
          ) : activeNav === 'Bank' ? (
            <div className="space-y-6">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Bank feed</p>
                  <h2 className="mt-1 text-2xl font-semibold text-slate-900">Reconciliation</h2>
                </div>

                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={applyRepeatedIdenticalMatch}>
                    Apply repeated
                  </Button>
                  <Button size="sm" onClick={() => fileInputRef.current?.click()}>
                    Import CSV
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv"
                    hidden
                    onChange={handleCsvImport}
                  />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <Card className="rounded-2xl">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Unreconciled</p>
                  <div className="mt-3 font-mono text-3xl tabular-nums text-slate-900">{unreconciledCount}</div>
                  <p className="mt-2 text-xs text-slate-500">Needs action</p>
                </Card>
                <Card className="rounded-2xl">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Matched</p>
                  <div className="mt-3 font-mono text-3xl tabular-nums text-emerald-700">
                    {bankLines.filter((line) => line.status === 'matched').length}
                  </div>
                  <p className="mt-2 text-xs text-slate-500">Confirmed links</p>
                </Card>
                <Card className="rounded-2xl">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Coded to account</p>
                  <div className="mt-3 font-mono text-3xl tabular-nums text-brand-700">
                    {bankLines.filter((line) => line.status === 'coded').length}
                  </div>
                  <p className="mt-2 text-xs text-slate-500">Manual coding</p>
                </Card>
              </div>

              <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
                <Card className="rounded-2xl">
                  <div className="flex items-center justify-between gap-4 pb-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Imported bank lines</p>
                      <h3 className="mt-1 text-xl font-semibold text-slate-900">Feed review</h3>
                    </div>
                    <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">
                      {bankLines.length} rows
                    </span>
                  </div>

                  <div className="space-y-3">
                    {bankLines.map((line, index) => {
                      const isSelected = selectedBankIndex === index;
                      const suggestion = getSuggestionsForBankLine(line)[0];

                      return (
                        // A div, not a button: the row holds an Undo button, and a
                        // button inside a button is invalid HTML (hydration mismatch).
                        <div
                          key={line.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => setSelectedBankIndex(index)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setSelectedBankIndex(index);
                            }
                          }}
                          className={[
                            'w-full cursor-pointer rounded-2xl border p-3 text-left transition-colors duration-150 ease-out focus:outline-none focus:ring-2 focus:ring-brand-100',
                            isSelected
                              ? 'border-brand-200 bg-brand-50 shadow-soft'
                              : 'border-slate-200 bg-slate-50 hover:border-slate-300 hover:bg-white',
                          ].join(' ')}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-sm font-semibold text-slate-900">{line.description}</div>
                              <div className="mt-1 text-[11px] text-slate-500">
                                {line.date} • {line.reference} • {line.bank}
                              </div>
                            </div>
                            <div className={['font-mono text-base tabular-nums', line.amount >= 0 ? 'text-emerald-700' : 'text-red-700'].join(' ')}>
                              <Money value={line.amount} />
                            </div>
                          </div>

                          <div className="mt-3 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                              <span
                                className={[
                                  'rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]',
                                  line.status === 'matched'
                                    ? 'bg-emerald-100 text-emerald-700'
                                    : line.status === 'coded'
                                      ? 'bg-brand-100 text-brand-700'
                                      : 'bg-amber-100 text-amber-700',
                                ].join(' ')}
                              >
                                {line.status}
                              </span>
                              {line.matchedDocumentLabel ? (
                                <span className="text-[11px] text-slate-600">{line.matchedDocumentLabel}</span>
                              ) : null}
                            </div>

                            {line.status !== 'unreconciled' ? (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  undoBankMatch(line.id);
                                }}
                                className="text-[11px] font-medium text-slate-600 hover:text-slate-900"
                              >
                                Undo
                              </button>
                            ) : null}
                          </div>

                          {suggestion ? (
                            <div className="mt-3 flex items-center justify-between rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-[11px] text-slate-600">
                              <span>{suggestion.contactName}</span>
                              <span className="font-semibold text-brand-700">{suggestion.confidence}% match</span>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </Card>

                <Card className="rounded-2xl">
                  <div className="flex items-center justify-between gap-4 pb-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Suggested match</p>
                      <h3 className="mt-1 text-xl font-semibold text-slate-900">Candidate documents</h3>
                    </div>
                    {selectedBankLine ? (
                      <span className="rounded-full bg-brand-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-700">
                        {selectedBankLine.status}
                      </span>
                    ) : null}
                  </div>

                  {selectedBankLine ? (
                    <div className="space-y-4">
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-slate-900">{selectedBankLine.description}</div>
                            <div className="mt-1 text-[11px] text-slate-500">
                              {selectedBankLine.date} • {selectedBankLine.reference}
                            </div>
                          </div>
                          <div className={['font-mono text-lg tabular-nums', selectedBankLine.amount >= 0 ? 'text-emerald-700' : 'text-red-700'].join(' ')}>
                            <Money value={selectedBankLine.amount} />
                          </div>
                        </div>
                      </div>

                      {selectedSuggestions.length > 0 ? (
                        <div className="space-y-3">
                          {selectedSuggestions.map((suggestion) => (
                            <button
                              key={suggestion.id}
                              type="button"
                              onClick={() => applyBankMatch(selectedBankLine.id, suggestion)}
                              className="w-full rounded-2xl border border-slate-200 bg-white p-3 text-left transition-colors duration-150 ease-out hover:border-brand-200 hover:bg-brand-50"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <div className="text-sm font-semibold text-slate-900">{suggestion.label}</div>
                                  <div className="mt-1 text-[11px] text-slate-500">{suggestion.contactName}</div>
                                </div>
                                <span className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
                                  {suggestion.confidence}%
                                </span>
                              </div>
                              <div className="mt-3 flex items-center justify-between text-[11px] text-slate-600">
                                <span>{suggestion.type}</span>
                                <span className="font-mono text-slate-900">
                                  <Money value={suggestion.amount} />
                                </span>
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">
                          No strong match detected. Code the line straight to an account below.
                        </div>
                      )}

                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                          Code to account
                        </label>
                        <div className="flex gap-2">
                          <select
                            value={selectedBankLine.accountCode ?? '2001'}
                            onChange={(event) => {
                              const accountCode = event.target.value;
                              if (selectedBankLine) {
                                codeBankLineToAccount(selectedBankLine.id, accountCode);
                              }
                            }}
                            className="min-h-[44px] flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                          >
                            {bankAccountOptions.map((account) => (
                              <option key={account.code} value={account.code}>
                                {account.code} • {account.name}
                              </option>
                            ))}
                          </select>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              if (selectedBankLine) {
                                codeBankLineToAccount(selectedBankLine.id, selectedBankLine.accountCode ?? '2001');
                              }
                            }}
                          >
                            Code row
                          </Button>
                        </div>
                        {selectedBankLine.accountName ? (
                          <div className="mt-3 text-xs text-slate-600">Account: {selectedBankLine.accountName}</div>
                        ) : null}
                      </div>

                      {selectedBankLine.status !== 'unreconciled' ? (
                        <Button variant="secondary" className="w-full" onClick={() => undoBankMatch(selectedBankLine.id)}>
                          Undo match
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </Card>
              </div>

              {importMappingOpen ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4">
                  <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">CSV import</p>
                        <h3 className="mt-1 text-2xl font-semibold text-slate-900">Map {pendingBankName}</h3>
                      </div>
                      <button
                        type="button"
                        onClick={() => setImportMappingOpen(false)}
                        className="text-xl text-slate-500 hover:text-slate-700"
                      >
                        ×
                      </button>
                    </div>

                    <div className="mt-6 grid gap-4 md:grid-cols-2">
                      {([
                        ['date', 'Date'],
                        ['amount', 'Amount'],
                        ['description', 'Description'],
                        ['reference', 'Reference'],
                        ['bank', 'Bank'],
                      ] as const).map(([field, label]) => (
                        <div key={field}>
                          <label className="mb-1.5 block text-sm font-medium text-slate-700">{label}</label>
                          <select
                            value={csvImportMap[field]}
                            onChange={(event) =>
                              setCsvImportMap((current) => ({ ...current, [field]: event.target.value }))
                            }
                            className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                          >
                            {pendingCsvRows[0]?.map((header, index) => (
                              <option key={`${field}-${header}-${index}`} value={header.trim() || `Column ${index + 1}`}>
                                {header.trim() || `Column ${index + 1}`}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>

                    <div className="mt-6 flex items-center justify-end gap-3">
                      <Button type="button" variant="secondary" onClick={() => setImportMappingOpen(false)}>
                        Cancel
                      </Button>
                      <Button type="button" onClick={saveCsvMapping}>
                        Save mapping and import
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : activeNav === 'Tax' ? (
            <div className="space-y-6">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{selectedEntity.name}</p>
                  <h2 className="mt-1 text-2xl font-semibold text-slate-900">VAT return</h2>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={selectedTaxPeriod}
                    onChange={(event) => {
                      setSelectedTaxPeriod(event.target.value);
                      setTaxDrilldown(null);
                    }}
                    className="min-h-[44px] rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                  >
                    {availableTaxPeriods.length === 0 ? (
                      <option value={selectedTaxPeriod}>{periodLabelOf(selectedTaxPeriod)}</option>
                    ) : (
                      availableTaxPeriods.map((period) => (
                        <option key={period} value={period}>{periodLabelOf(period)}</option>
                      ))
                    )}
                  </select>
                  {isSelectedPeriodFiled ? (
                    <span className="rounded-full bg-emerald-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
                      Filed — locked
                    </span>
                  ) : allowed('period:file') ? (
                    <Button size="sm" onClick={fileSelectedTaxPeriod}>File this period</Button>
                  ) : null}
                </div>
              </div>

              {isSelectedPeriodFiled ? (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                  {periodLabelOf(selectedTaxPeriod)} has been filed and is locked for {selectedEntity.name}. Nothing can be posted into this period — later corrections must be entered as an adjustment dated in the current open period.
                </div>
              ) : (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                  {periodLabelOf(selectedTaxPeriod)} is still open. Filing locks the period; after that, corrections must go through an adjustment in the current period.
                </div>
              )}

              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                {([
                  { bucket: 'output' as TaxBucket, label: 'Output VAT', value: vatFigures.outputVat, helper: '15% on sales' },
                  { bucket: 'input' as TaxBucket, label: 'Input VAT', value: vatFigures.inputVat, helper: 'Recoverable on purchases' },
                  { bucket: 'nhil' as TaxBucket, label: 'NHIL', value: vatFigures.nhilNet, helper: `Out ${(vatFigures.outputNhil / 100).toFixed(2)} − In ${(vatFigures.inputNhil / 100).toFixed(2)}` },
                  { bucket: 'getfund' as TaxBucket, label: 'GETFund', value: vatFigures.getFundNet, helper: `Out ${(vatFigures.outputGetFund / 100).toFixed(2)} − In ${(vatFigures.inputGetFund / 100).toFixed(2)}` },
                  { bucket: 'net' as TaxBucket, label: 'Net position', value: vatFigures.net, helper: vatFigures.net >= 0 ? 'Payable to GRA' : 'Refund due' },
                ]).map((card) => (
                  <button
                    key={card.bucket}
                    type="button"
                    onClick={() => setTaxDrilldown(card.bucket)}
                    className="text-left"
                  >
                    <Card
                      className={[
                        'h-full rounded-2xl transition-colors duration-150 ease-out',
                        taxDrilldown === card.bucket
                          ? 'border-brand-200 bg-brand-50 ring-2 ring-brand-500'
                          : 'hover:border-brand-200 hover:bg-brand-50/40',
                      ].join(' ')}
                    >
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{card.label}</p>
                      <div className={[
                        'mt-3 font-mono text-2xl tabular-nums',
                        card.bucket === 'net' ? (card.value >= 0 ? 'text-red-700' : 'text-emerald-700') : 'text-slate-900',
                      ].join(' ')}>
                        <Money value={card.value} />
                      </div>
                      <p className="mt-2 text-xs text-slate-500">{card.helper}</p>
                      <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-700">Click to drill down</p>
                    </Card>
                  </button>
                ))}
              </div>

              {taxDrilldown ? (
                <Card className="rounded-2xl">
                  <div className="flex items-center justify-between gap-4 pb-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{periodLabelOf(selectedTaxPeriod)}</p>
                      <h3 className="mt-1 text-xl font-semibold text-slate-900">{taxBucketLabels[taxDrilldown]}</h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTaxDrilldown(null)}
                      className="text-xl text-slate-500 hover:text-slate-700"
                    >
                      ×
                    </button>
                  </div>

                  <div className="overflow-hidden rounded-xl border border-slate-200">
                    <div className="grid grid-cols-[0.8fr_0.9fr_1.2fr_0.9fr_0.8fr_0.8fr_0.8fr] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                      <span>Date</span>
                      <span>Document</span>
                      <span>Contact</span>
                      <span className="text-right">Base</span>
                      <span className="text-right">VAT</span>
                      <span className="text-right">NHIL</span>
                      <span className="text-right">GETFund</span>
                    </div>

                    {drilldownRows.map((row) => (
                      <div
                        key={row.id}
                        className="grid grid-cols-[0.8fr_0.9fr_1.2fr_0.9fr_0.8fr_0.8fr_0.8fr] gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-700"
                      >
                        <span>{row.date}</span>
                        <span className="font-medium text-slate-900">{row.document}</span>
                        <span>{row.contactName}</span>
                        <span className="text-right"><Money value={row.base} /></span>
                        <span className="text-right"><Money value={row.vat} /></span>
                        <span className="text-right"><Money value={row.nhil} /></span>
                        <span className="text-right"><Money value={row.getFund} /></span>
                      </div>
                    ))}

                    {drilldownRows.length === 0 ? (
                      <div className="border-t border-slate-200 px-4 py-6 text-sm text-slate-500">
                        No transactions in this bucket for {periodLabelOf(selectedTaxPeriod)}.
                      </div>
                    ) : null}
                  </div>
                </Card>
              ) : null}

              <Card className="rounded-2xl">
                <div className="flex items-center justify-between gap-4 pb-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Withholding tax</p>
                    <h3 className="mt-1 text-xl font-semibold text-slate-900">{periodLabelOf(selectedTaxPeriod)} — per supplier</h3>
                  </div>
                  <Button variant="secondary" size="sm" onClick={downloadWhtCsv} disabled={whtRows.length === 0}>
                    Download CSV
                  </Button>
                </div>
                <p className="pb-4 text-sm text-slate-600">
                  Amounts withheld per supplier with their TINs — ready for GRA submission.
                </p>

                <div className="overflow-hidden rounded-xl border border-slate-200">
                  <div className="grid grid-cols-[1.4fr_1fr_0.6fr_0.7fr_1fr_1fr] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    <span>Supplier</span>
                    <span>TIN</span>
                    <span>Rate</span>
                    <span>Documents</span>
                    <span className="text-right">Gross</span>
                    <span className="text-right">WHT withheld</span>
                  </div>

                  {whtRows.map((row) => (
                    <div
                      key={row.name}
                      className="grid grid-cols-[1.4fr_1fr_0.6fr_0.7fr_1fr_1fr] gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-700"
                    >
                      <span className="font-medium text-slate-900">{row.name}</span>
                      <span className="font-mono text-slate-600">{row.tin}</span>
                      <span>{Math.round(row.rate * 100)}%</span>
                      <span>{row.documents}</span>
                      <span className="text-right"><Money value={row.gross} /></span>
                      <span className="text-right font-semibold"><Money value={row.withheld} /></span>
                    </div>
                  ))}

                  {whtRows.length > 0 ? (
                    <div className="grid grid-cols-[1.4fr_1fr_0.6fr_0.7fr_1fr_1fr] gap-3 border-t-2 border-slate-300 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-900">
                      <span>Total</span>
                      <span />
                      <span />
                      <span>{whtRows.reduce((total, row) => total + row.documents, 0)}</span>
                      <span className="text-right"><Money value={whtRows.reduce((total, row) => total + row.gross, 0)} /></span>
                      <span className="text-right"><Money value={whtRows.reduce((total, row) => total + row.withheld, 0)} /></span>
                    </div>
                  ) : (
                    <div className="border-t border-slate-200 px-4 py-6 text-sm text-slate-500">
                      No withholding tax withheld in {periodLabelOf(selectedTaxPeriod)} for {selectedEntity.name}.
                    </div>
                  )}
                </div>
              </Card>
            </div>
          ) : activeNav === 'Intercompany' ? (
            <div className="space-y-6">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Group controls</p>
                  <h2 className="mt-1 text-2xl font-semibold text-slate-900">Intercompany</h2>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setIntercompanyForm((current) => ({ ...current, reference: `IC-${Date.now().toString().slice(-4)}` }))}>
                    New reference
                  </Button>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <Card className="rounded-2xl">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Transactions</p>
                  <div className="mt-3 font-mono text-3xl tabular-nums text-slate-900">{intercompanyTransactions.length}</div>
                  <p className="mt-2 text-xs text-slate-500">Mirrored entries</p>
                </Card>
                <Card className="rounded-2xl">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Balance pairs</p>
                  <div className="mt-3 font-mono text-3xl tabular-nums text-brand-700">
                    {Array.from(intercompanyBalances.values()).length}
                  </div>
                  <p className="mt-2 text-xs text-slate-500">Across all entities</p>
                </Card>
                <Card className="rounded-2xl">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Mismatches</p>
                  <div className="mt-3 font-mono text-3xl tabular-nums text-red-700">{intercompanyMismatchCount}</div>
                  <p className="mt-2 text-xs text-slate-500">Disagreements flagged</p>
                </Card>
              </div>

              <div className="grid gap-6 xl:grid-cols-[0.8fr_1.2fr]">
                <Card className="rounded-2xl">
                  <div className="border-b border-slate-200 pb-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">New mirrored transaction</p>
                    <h3 className="mt-1 text-xl font-semibold text-slate-900">Post both sides</h3>
                  </div>

                  <form className="mt-5 space-y-4" onSubmit={handleCreateIntercompanyTransaction}>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-slate-700">Reference</label>
                      <Input
                        value={intercompanyForm.reference}
                        onChange={(event) => setIntercompanyForm((current) => ({ ...current, reference: event.target.value }))}
                      />
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <label className="mb-1.5 block text-sm font-medium text-slate-700">From entity</label>
                        <select
                          value={intercompanyForm.fromEntityId}
                          onChange={(event) => setIntercompanyForm((current) => ({ ...current, fromEntityId: event.target.value }))}
                          className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                        >
                          {groupEntityOptions.map((entity) => (
                            <option key={entity.id} value={entity.id}>{entity.name}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-1.5 block text-sm font-medium text-slate-700">To entity</label>
                        <select
                          value={intercompanyForm.toEntityId}
                          onChange={(event) => setIntercompanyForm((current) => ({ ...current, toEntityId: event.target.value }))}
                          className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                        >
                          {groupEntityOptions.map((entity) => (
                            <option key={entity.id} value={entity.id}>{entity.name}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <label className="mb-1.5 block text-sm font-medium text-slate-700">Date</label>
                        <Input
                          type="date"
                          value={intercompanyForm.date}
                          onChange={(event) => setIntercompanyForm((current) => ({ ...current, date: event.target.value }))}
                        />
                      </div>

                      <div>
                        <label className="mb-1.5 block text-sm font-medium text-slate-700">Amount (GHS)</label>
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          value={pesewasToCedisInput(intercompanyForm.amount)}
                          onChange={(event) => setIntercompanyForm((current) => ({ ...current, amount: cedisInputToPesewas(event.target.value) }))}
                        />
                      </div>
                    </div>

                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-slate-700">Description</label>
                      <Input
                        value={intercompanyForm.description}
                        onChange={(event) => setIntercompanyForm((current) => ({ ...current, description: event.target.value }))}
                        placeholder="Raw cashew supply"
                      />
                    </div>

                    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                      Editing one side without the other is intentionally blocked. The shared reference keeps the invoice and bill linked.
                    </div>

                    <div className="flex items-center justify-end gap-3">
                      <Button type="submit">Create mirrored entry</Button>
                    </div>
                  </form>
                </Card>

                <div className="space-y-6">
                  <Card className="rounded-2xl">
                    <div className="flex items-center justify-between gap-4 pb-4">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Group matrix</p>
                        <h3 className="mt-1 text-xl font-semibold text-slate-900">Balances between entities</h3>
                      </div>
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">
                        Scales to more entities
                      </span>
                    </div>

                    <div className="overflow-hidden rounded-2xl border border-slate-200">
                      <div className="grid" style={{ gridTemplateColumns: `180px repeat(${entities.length}, minmax(140px, 1fr))` }}>
                        <div className="bg-slate-50 px-3 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Entity</div>
                        {entities.map((entity) => (
                          <div key={entity.id} className="bg-slate-50 px-3 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            {entity.name}
                          </div>
                        ))}

                        {entities.map((fromEntity) => (
                          <div key={fromEntity.id} className="contents">
                            <div className="border-t border-slate-200 bg-white px-3 py-3 text-sm font-semibold text-slate-900">
                              {fromEntity.name}
                            </div>
                            {entities.map((toEntity) => {
                              if (fromEntity.id === toEntity.id) {
                                return (
                                  <div key={toEntity.id} className="border-t border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-400">
                                    —
                                  </div>
                                );
                              }

                              const cell = intercompanyBalances.get(`${fromEntity.id}->${toEntity.id}`);
                              return (
                                <div
                                  key={toEntity.id}
                                  className={[
                                    'border-t border-slate-200 px-3 py-3 text-sm',
                                    cell?.mismatch ? 'bg-red-50' : 'bg-white',
                                  ].join(' ')}
                                >
                                  <div className="font-medium text-slate-900">
                                    <Money value={cell?.balance ?? 0} currency={cell?.balanceCurrency ?? functionalCurrency} />
                                  </div>
                                  <div className="mt-1 text-[11px] text-slate-500">
                                    Mirror: <Money value={cell?.mirroredBalance ?? 0} currency={cell?.mirroredCurrency ?? functionalCurrency} />
                                  </div>
                                  {cell && cell.sameCurrency === false ? (
                                    <div className="mt-2 rounded-lg bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
                                      {cell.fxDifference !== null && cell.fxDifference !== undefined ? (
                                        <>
                                          Different functional currencies. Mirror at today&rsquo;s rate: <Money value={cell.translatedMirror ?? 0} currency={cell.balanceCurrency} />.{' '}
                                          <span className="font-semibold">FX difference <Money value={cell.fxDifference} currency={cell.balanceCurrency} /></span> — not a mismatch.
                                        </>
                                      ) : (
                                        <>Different functional currencies; no {cell.mirroredCurrency}→{cell.balanceCurrency} rate on file to show the FX difference.</>
                                      )}
                                    </div>
                                  ) : cell?.mismatch ? (
                                    <div className="mt-2 rounded-full bg-red-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-red-700">
                                      Mismatch
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </div>
                  </Card>

                  <Card className="rounded-2xl">
                    <div className="flex items-center justify-between gap-4 pb-4">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Related-party report</p>
                        <h3 className="mt-1 text-xl font-semibold text-slate-900">Journal comparison</h3>
                      </div>
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">
                        Disclosure-ready
                      </span>
                    </div>

                    <div className="space-y-4">
                      {intercompanyTransactions.map((transaction) => (
                        <div key={transaction.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                            <div>
                              <div className="text-sm font-semibold text-slate-900">{transaction.reference}</div>
                              <div className="mt-1 text-[11px] text-slate-500">
                                {transaction.date} • {transaction.description}
                              </div>
                            </div>
                            <div className="font-mono text-lg tabular-nums text-slate-900">
                              <Money value={transaction.amount} />
                            </div>
                          </div>

                          <div className="mt-4 grid gap-4 xl:grid-cols-2">
                            {transaction.journalEntries.map((journal) => (
                              <div key={`${transaction.id}-${journal.entityId}`} className="rounded-2xl border border-slate-200 bg-white p-4">
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <div className="text-sm font-semibold text-slate-900">{journal.documentLabel}</div>
                                    <div className="mt-1 text-[11px] text-slate-500">{journal.entityId}</div>
                                  </div>
                                  <span className="rounded-full bg-brand-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-700">
                                    Balanced
                                  </span>
                                </div>

                                <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
                                  <div className="grid grid-cols-[1.2fr_0.6fr_0.6fr] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                                    <span>Account</span>
                                    <span>Money in</span>
                                    <span>Money out</span>
                                  </div>
                                  {journal.side.map((entry) => (
                                    <div key={`${journal.documentLabel}-${entry.accountCode}-${entry.type}`} className="grid grid-cols-[1.2fr_0.6fr_0.6fr] gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-700">
                                      <div>{entry.accountName}</div>
                                      <div className="font-mono text-slate-900">{entry.type === 'debit' ? <Money value={entry.amount} /> : '—'}</div>
                                      <div className="font-mono text-slate-900">{entry.type === 'credit' ? <Money value={entry.amount} /> : '—'}</div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </Card>
                </div>
              </div>
            </div>
          ) : activeNav === 'Reports' ? (
            <div className="space-y-6">
              <div className="no-print flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {reportType === 'group-view' ? 'All entities' : selectedEntity.name}
                  </p>
                  <h2 className="mt-1 text-2xl font-semibold text-slate-900">Reports</h2>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-slate-600">From</label>
                    <Input
                      type="date"
                      value={reportStart}
                      onChange={(event) => {
                        setReportStart(event.target.value);
                        setReportDrilldown(null);
                      }}
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-slate-600">To</label>
                    <Input
                      type="date"
                      value={reportEnd}
                      onChange={(event) => {
                        setReportEnd(event.target.value);
                        setReportDrilldown(null);
                      }}
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-slate-600">Show in</label>
                    <select
                      value={reportCurrency}
                      onChange={(event) => { setReportCurrency(event.target.value as 'functional' | Currency); setTranslationRate(''); }}
                      className="min-h-[44px] rounded-lg border border-slate-200 bg-white px-3 text-sm"
                    >
                      <option value="functional">{functionalCurrency} (functional)</option>
                      {currencies.filter((currency) => currency !== functionalCurrency).map((currency) => (
                        <option key={currency} value={currency}>{currency} (translated)</option>
                      ))}
                    </select>
                  </div>
                  {reportCurrency !== 'functional' ? (
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-600">Closing rate ({reportCurrency} per 1 {functionalCurrency})</label>
                      <Input inputMode="decimal" className="w-40" value={translationRate || translationQuote?.rate || ''} onChange={(event) => setTranslationRate(event.target.value)} placeholder="e.g. 0.08" />
                    </div>
                  ) : null}
                  <Button variant="secondary" size="sm" onClick={exportReportCsv}>Export Excel</Button>
                  <Button variant="secondary" size="sm" onClick={() => window.print()}>Export PDF</Button>
                </div>
              </div>

              {reportCurrency !== 'functional' ? (
                <div className={['rounded-2xl border p-3 text-sm', translationActive ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-red-200 bg-red-50 text-red-800'].join(' ')}>
                  {translationActive ? (
                    <>
                      <strong>Translation, not the books.</strong> Every figure below is the {functionalCurrency} amount converted to {reportCurrency} at {effectiveTranslationRate}
                      {translationQuote && !translationRate ? (translationQuote.exact ? ` (rate on file for ${reportEnd})` : ` (most recent rate on file, from ${translationQuote.rateDate})`) : ' (rate you entered)'}.
                      The ledger is kept in {functionalCurrency}.
                    </>
                  ) : (
                    <>No {functionalCurrency}→{reportCurrency} rate on file on or before {reportEnd}. Enter a closing rate above to translate.</>
                  )}
                </div>
              ) : null}

              <TranslationProvider currency={translationActive ? reportDisplayCurrency : functionalCurrency} rate={translationActive ? effectiveTranslationRate : '1.0'}>
              <div className="no-print flex flex-wrap gap-2">
                {reportTabs.map((tab) => {
                  const active = reportType === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => {
                        setReportType(tab.id);
                        setReportDrilldown(null);
                      }}
                      className={[
                        'rounded-full px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out',
                        active
                          ? 'bg-brand-700 text-white'
                          : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 hover:text-slate-900',
                      ].join(' ')}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>

              {['trial-balance', 'profit-loss', 'balance-sheet', 'cash-flow'].includes(reportType) ? (
                <Card className="rounded-2xl">
                  <div className="flex flex-col gap-1 pb-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{selectedEntity.name}</p>
                    <h3 className="text-xl font-semibold text-slate-900">{standardReport.title}</h3>
                    <p className="text-xs text-slate-500">{standardReport.subtitle}</p>
                  </div>

                  {standardReport.trialBalance ? (
                    <div className="overflow-hidden rounded-xl border border-slate-200">
                      <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                        <span>Account</span>
                        {standardReport.columns.map((column) => (
                          <span key={column} className="text-right">{column}</span>
                        ))}
                      </div>
                      {standardReport.rows.map((row) => {
                        const debitCurrent = Math.max(row.current, 0);
                        const creditCurrent = row.creditCurrent ?? Math.max(-row.current, 0);
                        const debitPrior = Math.max(row.prior, 0);
                        const creditPrior = row.creditPrior ?? Math.max(-row.prior, 0);
                        const isTotal = row.kind === 'total';
                        const cellClass = isTotal
                          ? 'grid grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-3 border-t-2 border-slate-300 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-900'
                          : 'grid grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-700';

                        return (
                          <div key={row.id} className={cellClass}>
                            <span>{row.label}</span>
                            {row.accountCodes && !isTotal ? (
                              <button type="button" className="text-right font-mono text-brand-700 hover:underline" onClick={() => openReportDrilldown(row.label, row.accountCodes as string[], reportRange, true)}>
                                {debitCurrent !== 0 ? <ReportMoney value={debitCurrent} /> : '—'}
                              </button>
                            ) : (
                              <span className="text-right font-mono">{debitCurrent !== 0 ? <ReportMoney value={debitCurrent} /> : '—'}</span>
                            )}
                            <span className="text-right font-mono">{creditCurrent !== 0 ? <ReportMoney value={creditCurrent} /> : '—'}</span>
                            {row.accountCodes && !isTotal ? (
                              <button type="button" className="text-right font-mono text-brand-700 hover:underline" onClick={() => openReportDrilldown(`${row.label} — prior period`, row.accountCodes as string[], priorReportRange, true)}>
                                {debitPrior !== 0 ? <ReportMoney value={debitPrior} /> : '—'}
                              </button>
                            ) : (
                              <span className="text-right font-mono">{debitPrior !== 0 ? <ReportMoney value={debitPrior} /> : '—'}</span>
                            )}
                            <span className="text-right font-mono">{creditPrior !== 0 ? <ReportMoney value={creditPrior} /> : '—'}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-xl border border-slate-200">
                      <div className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                        <span>Line</span>
                        {standardReport.columns.map((column) => (
                          <span key={column} className="text-right">{column}</span>
                        ))}
                      </div>
                      {standardReport.rows.map((row) => {
                        if (row.kind === 'header') {
                          return (
                            <div key={row.id} className="border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600">
                              {row.label}
                            </div>
                          );
                        }

                        const variance = row.current - row.prior;
                        const isTotal = row.kind === 'total';

                        return (
                          <div
                            key={row.id}
                            className={[
                              'grid grid-cols-[2fr_1fr_1fr_1fr] gap-3 px-4 py-3 text-sm',
                              isTotal ? 'border-t-2 border-slate-300 bg-slate-50 font-semibold text-slate-900' : 'border-t border-slate-200 text-slate-700',
                            ].join(' ')}
                          >
                            <span>{row.label}</span>
                            {row.accountCodes ? (
                              <button
                                type="button"
                                className="text-right font-mono text-brand-700 hover:underline"
                                onClick={() =>
                                  openReportDrilldown(
                                    row.label,
                                    row.accountCodes as string[],
                                    reportRange,
                                    reportType === 'balance-sheet',
                                  )
                                }
                              >
                                <ReportMoney value={row.current} />
                              </button>
                            ) : (
                              <span className="text-right font-mono"><ReportMoney value={row.current} /></span>
                            )}
                            {row.accountCodes ? (
                              <button
                                type="button"
                                className="text-right font-mono text-brand-700 hover:underline"
                                onClick={() =>
                                  openReportDrilldown(
                                    `${row.label} — prior period`,
                                    row.accountCodes as string[],
                                    priorReportRange,
                                    reportType === 'balance-sheet',
                                  )
                                }
                              >
                                <ReportMoney value={row.prior} />
                              </button>
                            ) : (
                              <span className="text-right font-mono"><ReportMoney value={row.prior} /></span>
                            )}
                            <span className={['text-right font-mono', variance >= 0 ? 'text-slate-700' : 'text-red-700'].join(' ')}>
                              <ReportMoney value={variance} />
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Card>
              ) : null}

              {reportType === 'aged-receivables' || reportType === 'aged-payables' ? (
                <Card className="rounded-2xl">
                  <div className="flex flex-col gap-1 pb-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{selectedEntity.name}</p>
                    <h3 className="text-xl font-semibold text-slate-900">
                      {reportType === 'aged-receivables' ? 'Aged receivables' : 'Aged payables'} as at {reportEnd}
                    </h3>
                    <p className="text-xs text-slate-500">Open items by days overdue · prior column shows the position as at {priorReportRange.end}</p>
                  </div>

                  <div className="overflow-hidden rounded-xl border border-slate-200">
                    <div className="grid grid-cols-[1.6fr_repeat(7,minmax(0,1fr))] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                      <span>{reportType === 'aged-receivables' ? 'Customer' : 'Supplier'}</span>
                      <span className="text-right">Not due</span>
                      <span className="text-right">1–30</span>
                      <span className="text-right">31–60</span>
                      <span className="text-right">61–90</span>
                      <span className="text-right">90+</span>
                      <span className="text-right">Total</span>
                      <span className="text-right">Prior</span>
                    </div>

                    {agingRows.map((row) => (
                      <div key={row.contactName} className="grid grid-cols-[1.6fr_repeat(7,minmax(0,1fr))] gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-700">
                        <span className="font-medium text-slate-900">{row.contactName}</span>
                        {row.buckets.map((bucket, index) => (
                          <span key={index} className="text-right font-mono">{bucket !== 0 ? <ReportMoney value={bucket} /> : '—'}</span>
                        ))}
                        <button
                          type="button"
                          className="text-right font-mono font-semibold text-brand-700 hover:underline"
                          onClick={() =>
                            openReportDrilldown(
                              `${row.contactName} — open items`,
                              [reportType === 'aged-receivables' ? '1010' : '2001'],
                              { start: '1900-01-01', end: reportEnd },
                              true,
                              selectedEntity.id,
                              row.contactName,
                            )
                          }
                        >
                          <ReportMoney value={row.total} />
                        </button>
                        <span className="text-right font-mono text-slate-500">{row.priorTotal !== 0 ? <ReportMoney value={row.priorTotal} /> : '—'}</span>
                      </div>
                    ))}

                    <div className="grid grid-cols-[1.6fr_repeat(7,minmax(0,1fr))] gap-3 border-t-2 border-slate-300 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-900">
                      <span>Total</span>
                      {[0, 1, 2, 3, 4].map((bucketIndex) => (
                        <span key={bucketIndex} className="text-right font-mono">
                          <ReportMoney value={agingRows.reduce((total, row) => total + row.buckets[bucketIndex], 0)} />
                        </span>
                      ))}
                      <span className="text-right font-mono"><ReportMoney value={agingRows.reduce((total, row) => total + row.total, 0)} /></span>
                      <span className="text-right font-mono"><ReportMoney value={agingRows.reduce((total, row) => total + row.priorTotal, 0)} /></span>
                    </div>
                  </div>
                </Card>
              ) : null}

              {reportType === 'fund-report' ? (
                selectedEntity.id === 'sprouted-roots' ? (
                  <Card className="rounded-2xl">
                    <div className="flex flex-col gap-1 pb-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Sprouted Roots</p>
                      <h3 className="text-xl font-semibold text-slate-900">Fund report — {reportStart} → {reportEnd}</h3>
                      <p className="text-xs text-slate-500">Income and expenditure split by restricted and unrestricted funds, with a closing balance per fund</p>
                    </div>

                    <div className="overflow-hidden rounded-xl border border-slate-200">
                      <div className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                        <span>Fund movement</span>
                        <span className="text-right">Restricted</span>
                        <span className="text-right">Unrestricted</span>
                        <span className="text-right">Total</span>
                      </div>
                      {([
                        { id: 'opening', label: 'Opening balance', pick: (fund: (typeof fundReport)[number]) => fund.opening, drill: undefined as string[] | undefined },
                        { id: 'income', label: 'Income', pick: (fund: (typeof fundReport)[number]) => fund.income, drill: codesOfType('INCOME') },
                        { id: 'expenditure', label: 'Expenditure', pick: (fund: (typeof fundReport)[number]) => fund.expenditure, drill: [...codesOfType('COST_OF_SALES'), ...codesOfType('EXPENSE')] },
                        { id: 'closing', label: 'Closing balance', pick: (fund: (typeof fundReport)[number]) => fund.closing, drill: undefined },
                      ]).map((metric) => (
                        <div
                          key={metric.id}
                          className={[
                            'grid grid-cols-[2fr_1fr_1fr_1fr] gap-3 px-4 py-3 text-sm',
                            metric.id === 'closing' ? 'border-t-2 border-slate-300 bg-slate-50 font-semibold text-slate-900' : 'border-t border-slate-200 text-slate-700',
                          ].join(' ')}
                        >
                          <span>{metric.label}</span>
                          {fundReport.map((fund) => (
                            metric.drill ? (
                              <button
                                key={fund.fund}
                                type="button"
                                className="text-right font-mono text-brand-700 hover:underline"
                                onClick={() =>
                                  openReportDrilldown(
                                    `${metric.label} — ${fund.fund} fund`,
                                    metric.drill as string[],
                                    reportRange,
                                    false,
                                    'sprouted-roots',
                                    undefined,
                                    fund.fund,
                                  )
                                }
                              >
                                <ReportMoney value={metric.pick(fund)} />
                              </button>
                            ) : (
                              <span key={fund.fund} className="text-right font-mono"><ReportMoney value={metric.pick(fund)} /></span>
                            )
                          ))}
                          <span className="text-right font-mono">
                            <ReportMoney value={fundReport.reduce((total, fund) => total + metric.pick(fund), 0)} />
                          </span>
                        </div>
                      ))}
                    </div>
                  </Card>
                ) : (
                  <Card className="rounded-2xl">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
                      Fund reporting applies to <span className="font-semibold text-slate-900">Sprouted Roots</span> only — it is the entity that manages restricted donor programmes. Switch the entity selector to Sprouted Roots to view this report.
                    </div>
                  </Card>
                )
              ) : null}

              {reportType === 'projects' ? (
                <Card className="rounded-2xl">
                  <div className="flex flex-col gap-1 pb-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{selectedEntity.name}</p>
                    <h3 className="text-xl font-semibold text-slate-900">Project tracking — {reportStart} → {reportEnd}</h3>
                    <p className="text-xs text-slate-500">Funds received and expenses per project, with budget usage and closing balance per project</p>
                  </div>

                  {projectReport.length > 0 ? (
                    <div className="space-y-4">
                      {projectReport.map((row) => (
                        <div key={row.project.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                            <div>
                              <div className="text-sm font-semibold text-slate-900">{row.project.name}</div>
                              <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                                <span>{row.project.funder}</span>
                                <span
                                  className={[
                                    'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]',
                                    row.project.fund === 'restricted' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600',
                                  ].join(' ')}
                                >
                                  {row.project.fund}
                                </span>
                              </div>
                            </div>
                            {row.budgetUsedPct !== null ? (
                              <div className="min-w-[220px]">
                                <div className="flex items-center justify-between text-[11px] text-slate-500">
                                  <span>Budget used</span>
                                  <span className={row.budgetUsedPct > 90 ? 'font-semibold text-red-700' : 'font-semibold text-slate-700'}>
                                    {row.budgetUsedPct}%
                                  </span>
                                </div>
                                <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-200">
                                  <div
                                    className={row.budgetUsedPct > 90 ? 'h-full bg-red-500' : 'h-full bg-brand-700'}
                                    style={{ width: `${Math.min(row.budgetUsedPct, 100)}%` }}
                                  />
                                </div>
                                <div className="mt-1 text-[11px] text-slate-500">
                                  <ReportMoney value={row.spentToDate} /> of <ReportMoney value={row.project.budget} />
                                </div>
                              </div>
                            ) : null}
                          </div>

                          <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
                            <div className="grid grid-cols-[1.2fr_1fr_1fr_1fr_1fr] gap-3 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                              <span>Movement</span>
                              <span className="text-right">Opening</span>
                              <span className="text-right">Funds received</span>
                              <span className="text-right">Expenses</span>
                              <span className="text-right">Closing balance</span>
                            </div>
                            <div className="grid grid-cols-[1.2fr_1fr_1fr_1fr_1fr] gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-700">
                              <span className="font-medium text-slate-900">{row.project.name}</span>
                              <button
                                type="button"
                                className="text-right font-mono text-brand-700 hover:underline"
                                onClick={() =>
                                  openReportDrilldown(
                                    `${row.project.name} — opening position`,
                                    [...codesOfType('INCOME'), ...codesOfType('COST_OF_SALES'), ...codesOfType('EXPENSE')],
                                    { start: '1900-01-01', end: reportStart },
                                    true,
                                    row.project.entityId,
                                    undefined,
                                    undefined,
                                    row.project.id,
                                  )
                                }
                              >
                                <ReportMoney value={row.opening} />
                              </button>
                              <button
                                type="button"
                                className="text-right font-mono text-brand-700 hover:underline"
                                onClick={() =>
                                  openReportDrilldown(
                                    `${row.project.name} — funds received`,
                                    codesOfType('INCOME'),
                                    reportRange,
                                    false,
                                    row.project.entityId,
                                    undefined,
                                    undefined,
                                    row.project.id,
                                  )
                                }
                              >
                                <ReportMoney value={row.received} />
                              </button>
                              <button
                                type="button"
                                className="text-right font-mono text-brand-700 hover:underline"
                                onClick={() =>
                                  openReportDrilldown(
                                    `${row.project.name} — expenses`,
                                    [...codesOfType('COST_OF_SALES'), ...codesOfType('EXPENSE')],
                                    reportRange,
                                    false,
                                    row.project.entityId,
                                    undefined,
                                    undefined,
                                    row.project.id,
                                  )
                                }
                              >
                                <ReportMoney value={row.expenses} />
                              </button>
                              <span className="text-right font-mono font-semibold text-slate-900">
                                <ReportMoney value={row.closing} />
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
                      No projects are set up for <span className="font-semibold text-slate-900">{selectedEntity.name}</span> yet. Projects track funds received and expenses per programme — they are currently defined for Sprouted Roots, the charity entity.
                    </div>
                  )}
                </Card>
              ) : null}

              {reportType === 'group-view' ? (
                <Card className="rounded-2xl">
                  <div className="flex flex-col gap-1 pb-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Sprouted Group</p>
                    <h3 className="text-xl font-semibold text-slate-900">Group management summary — {reportStart} → {reportEnd}</h3>
                  </div>

                  <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                    Management summary only — this is <span className="font-semibold">not</span> a set of statutory consolidated accounts. Intercompany balances and transactions have not been eliminated.
                  </div>

                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    <div
                      className="grid min-w-[720px] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500"
                      style={{ gridTemplateColumns: `180px repeat(${entities.length}, minmax(120px, 1fr)) 140px 140px` }}
                    >
                      <span>Line</span>
                      {entities.map((entity) => (
                        <span key={entity.id} className="text-right">{entity.name}</span>
                      ))}
                      <span className="text-right">Group total</span>
                      <span className="text-right">Prior total</span>
                    </div>

                    {groupReport.map((section) => {
                      const isComputed = section.id === 'gross' || section.id === 'net';
                      return (
                        <div
                          key={section.id}
                          className={[
                            'grid min-w-[720px] gap-3 px-4 py-3 text-sm',
                            isComputed ? 'border-t-2 border-slate-300 bg-slate-50 font-semibold text-slate-900' : 'border-t border-slate-200 text-slate-700',
                          ].join(' ')}
                          style={{ gridTemplateColumns: `180px repeat(${entities.length}, minmax(120px, 1fr)) 140px 140px` }}
                        >
                          <span>{section.label}</span>
                          {section.values.map((value, index) => (
                            isComputed || section.codes.length === 0 ? (
                              <span key={entities[index].id} className="text-right font-mono"><ReportMoney value={value} /></span>
                            ) : (
                              <button
                                key={entities[index].id}
                                type="button"
                                className="text-right font-mono text-brand-700 hover:underline"
                                onClick={() =>
                                  openReportDrilldown(
                                    `${section.label} — ${entities[index].name}`,
                                    section.codes,
                                    reportRange,
                                    false,
                                    entities[index].id,
                                  )
                                }
                              >
                                <ReportMoney value={value} />
                              </button>
                            )
                          ))}
                          <span className="text-right font-mono font-semibold"><ReportMoney value={section.total} /></span>
                          <span className="text-right font-mono text-slate-500"><ReportMoney value={section.priorTotal} /></span>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              ) : null}

              {reportDrilldown ? (
                <Card className="rounded-2xl">
                  <div className="flex items-center justify-between gap-4 pb-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        {reportDrilldown.cumulative ? `Cumulative to ${reportDrilldown.range.end}` : `${reportDrilldown.range.start} → ${reportDrilldown.range.end}`}
                      </p>
                      <h3 className="mt-1 text-xl font-semibold text-slate-900">{reportDrilldown.title}</h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => setReportDrilldown(null)}
                      className="text-xl text-slate-500 hover:text-slate-700"
                    >
                      ×
                    </button>
                  </div>

                  <div className="overflow-hidden rounded-xl border border-slate-200">
                    <div className="grid grid-cols-[0.8fr_1fr_1.2fr_1.4fr_0.8fr_0.8fr] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                      <span>Date</span>
                      <span>Document</span>
                      <span>Contact</span>
                      <span>Account</span>
                      <span className="text-right">Money in</span>
                      <span className="text-right">Money out</span>
                    </div>
                    {reportDrilldownRows.map((line) => (
                      <div key={line.id} className="grid grid-cols-[0.8fr_1fr_1.2fr_1.4fr_0.8fr_0.8fr] gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-700">
                        <span>{line.date}</span>
                        <span className="font-medium text-slate-900">{line.document}</span>
                        <span>{line.contactName}</span>
                        <span>{line.accountCode} · {reportAccounts[line.accountCode]?.name ?? ''}</span>
                        <span className="text-right font-mono">{line.amount > 0 ? <ReportMoney value={line.amount} /> : '—'}</span>
                        <span className="text-right font-mono">{line.amount < 0 ? <ReportMoney value={-line.amount} /> : '—'}</span>
                      </div>
                    ))}
                    {reportDrilldownRows.length === 0 ? (
                      <div className="border-t border-slate-200 px-4 py-6 text-sm text-slate-500">No transactions behind this figure in the selected period.</div>
                    ) : null}
                  </div>
                </Card>
              ) : null}
            </TranslationProvider>
            </div>
          ) : activeNav === 'Settings' && !allowed('export:run') ? (
            <Card className="rounded-2xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">System</p>
              <h2 className="mt-1 text-2xl font-semibold text-slate-900">Settings</h2>
              <p className="mt-3 text-sm text-slate-600">
                Ledger exports and the audit trail are available to Owners and Accountants. Your role is {currentUser.roleLabel}.
              </p>
            </Card>
          ) : activeNav === 'Settings' ? (
            <div className="space-y-6">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">System</p>
                  <h2 className="mt-1 text-2xl font-semibold text-slate-900">Settings</h2>
                </div>
              </div>

              {settingsMessage ? (
                <p className={['rounded-lg border px-3 py-2 text-sm', settingsMessage.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800'].join(' ')}>
                  {settingsMessage.text}
                </p>
              ) : null}

              <Card className="rounded-2xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Currency</p>
                <h3 className="mt-1 text-xl font-semibold text-slate-900">Functional currency: {functionalCurrency} · {currencyNames[functionalCurrency]}</h3>
                <p className="mt-1 text-sm text-slate-600">
                  The currency {selectedEntity.name}&rsquo;s books are kept and reported in. Every journal line stores its transaction currency, the amount in it, the rate used and the {functionalCurrency} result — fixed at posting, never recalculated.
                </p>
                {allowed('entity:configure') ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {currencies.filter((currency) => currency !== functionalCurrency).map((currency) => (
                      <Button key={currency} size="sm" variant="secondary" disabled={settingsPending} onClick={() => runSetting(`Functional currency set to ${currency}.`, () => setFunctionalCurrency(selectedEntity.id, currency))}>
                        Switch to {currency}
                      </Button>
                    ))}
                    <span className="text-xs text-slate-500">Only possible while nothing has been posted.</span>
                  </div>
                ) : null}
              </Card>

              <Card className="rounded-2xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">VAT</p>
                <h3 className="mt-1 text-xl font-semibold text-slate-900">{vatRegistrationLabel}</h3>
                <p className="mt-1 text-sm text-slate-600">
                  {selectedEntity.vatRegistered
                    ? `VAT is calculated on ${selectedEntity.name}'s invoices and bills dated on or after ${selectedEntity.vatRegisteredFrom}: 15% VAT, 2.5% NHIL and 2.5% GETFund on the same base. Documents dated earlier, and anything already posted, are not touched. Input tax on purchases and import VAT are recoverable from that date. The VAT return is under Tax.`
                    : `No VAT is calculated for ${selectedEntity.name}. Invoices and bills are gross, VAT a supplier charges is part of the cost of the item, import VAT paid at the port is part of the cost of the goods, and there is no VAT return. Switching registration on applies VAT to documents dated on or after the date you enter — never to earlier ones.`}
                </p>
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  <span className="font-semibold">Check the category.</span> Suppliers of goods must register once taxable supplies pass GH₵750,000 in any twelve months (tracked on the dashboard). <span className="font-semibold">Suppliers of services are required to register regardless of turnover.</span> If {selectedEntity.name} supplies services — programmes delivered for a fee, processing for others — the threshold does not apply and it should be registered now.
                </div>
                {allowed('entity:configure') ? (
                  selectedEntity.vatRegistered ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="secondary" disabled={settingsPending} onClick={() => runSetting(`VAT registration switched off for ${selectedEntity.name}.`, () => setVatRegistration(selectedEntity.id, { registered: false }))}>
                        Switch VAT off
                      </Button>
                      <span className="text-xs text-slate-500">Posted documents keep the VAT they were posted with.</span>
                    </div>
                  ) : (
                    <div className="mt-3 flex flex-wrap items-end gap-3">
                      <div>
                        <label className="mb-1.5 block text-sm font-medium text-slate-700">Registration effective from</label>
                        <Input type="date" value={vatForm.registeredFrom} onChange={(event) => setVatForm({ registeredFrom: event.target.value })} />
                      </div>
                      <Button
                        size="sm"
                        disabled={settingsPending || !vatForm.registeredFrom}
                        onClick={() => runSetting(`VAT registration switched on for ${selectedEntity.name} from ${vatForm.registeredFrom}.`, () => setVatRegistration(selectedEntity.id, { registered: true, registeredFrom: vatForm.registeredFrom }))}
                      >
                        Switch VAT on
                      </Button>
                      <span className="text-xs text-slate-500">Applies to documents dated on or after this date only.</span>
                    </div>
                  )
                ) : null}
              </Card>

              <Card className="rounded-2xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Email</p>
                <h3 className="mt-1 text-xl font-semibold text-slate-900">
                  {selectedEntity.emailFrom ? `Sender: ${selectedEntity.emailFrom}` : 'Sender: the group default'}
                </h3>
                <p className="mt-1 text-sm text-slate-600">
                  Invitations and password resets for people whose first entity is {selectedEntity.name} are sent from this address. It must be on the domain verified with the email provider — the same domain as the group default. Leave it empty to use the group default.
                </p>
                {allowed('entity:configure') ? (
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <div className="min-w-[320px] flex-1">
                      <label className="mb-1.5 block text-sm font-medium text-slate-700">Sender</label>
                      <Input
                        value={senderValue}
                        placeholder={`${selectedEntity.name} <${selectedEntity.id.replace(/^sprouted-/, '')}@yourdomain.com>`}
                        onChange={(event) => setSenderForm({ entityId: selectedEntity.id, value: event.target.value })}
                      />
                    </div>
                    <Button
                      size="sm"
                      disabled={settingsPending || senderValue.trim() === selectedEntity.emailFrom}
                      onClick={() => runSetting(senderValue.trim() ? `Sender for ${selectedEntity.name} set to ${senderValue.trim()}.` : `Sender for ${selectedEntity.name} cleared; the group default applies.`, () => setEntitySender(selectedEntity.id, senderValue))}
                    >
                      Save sender
                    </Button>
                  </div>
                ) : null}
              </Card>

              <Card className="rounded-2xl">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Exchange rates</p>
                    <h3 className="mt-1 text-xl font-semibold text-slate-900">Rate table</h3>
                    <p className="mt-1 text-sm text-slate-600">
                      One rate per currency pair per date, entered by hand. A document dated on a day with no rate takes the most recent earlier one and says so; you can always type over it.
                    </p>
                  </div>
                </div>
                {allowed('rates:manage') ? (
                  <form
                    className="mt-4 grid gap-3 md:grid-cols-6"
                    onSubmit={(event) => {
                      event.preventDefault();
                      runSetting(`Rate ${rateForm.base}→${rateForm.quote} for ${rateForm.date} saved.`, () => upsertExchangeRate(selectedEntity.id, rateForm));
                    }}
                  >
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-600">1 unit of</label>
                      <select value={rateForm.base} onChange={(event) => setRateForm((c) => ({ ...c, base: event.target.value as Currency }))} className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 text-sm">
                        {currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-600">equals (in)</label>
                      <select value={rateForm.quote} onChange={(event) => setRateForm((c) => ({ ...c, quote: event.target.value as Currency }))} className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 text-sm">
                        {currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-600">Rate</label>
                      <Input inputMode="decimal" required value={rateForm.rate} placeholder="12.5" onChange={(event) => setRateForm((c) => ({ ...c, rate: event.target.value }))} />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-600">Date</label>
                      <Input type="date" required value={rateForm.date} onChange={(event) => setRateForm((c) => ({ ...c, date: event.target.value }))} />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-600">Source</label>
                      <Input value={rateForm.source} placeholder="BoG, bank advice…" onChange={(event) => setRateForm((c) => ({ ...c, source: event.target.value }))} />
                    </div>
                    <div className="flex items-end">
                      <Button type="submit" size="sm" disabled={settingsPending || rateForm.base === rateForm.quote}>Save rate</Button>
                    </div>
                  </form>
                ) : null}
                <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
                  <div className="grid grid-cols-[1fr_1fr_1fr_1.5fr] gap-3 bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    <span>Date</span><span>Pair</span><span className="text-right">Rate</span><span>Source</span>
                  </div>
                  {entityRates.slice(0, 20).map((rate) => (
                    <div key={rate.id} className="grid grid-cols-[1fr_1fr_1fr_1.5fr] gap-3 border-t border-slate-200 px-4 py-2 text-sm text-slate-700">
                      <span>{rate.date}</span><span>1 {rate.base} = {rate.quote}</span><span className="text-right font-mono">{rate.rate}</span><span className="truncate text-slate-500">{rate.source || '—'}</span>
                    </div>
                  ))}
                  {entityRates.length === 0 ? <div className="border-t border-slate-200 px-4 py-4 text-sm text-slate-500">No rates yet. Foreign-currency documents cannot be posted until one exists.</div> : null}
                </div>
              </Card>

              <Card className="rounded-2xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Bank accounts</p>
                <h3 className="mt-1 text-xl font-semibold text-slate-900">One currency each</h3>
                <p className="mt-1 text-sm text-slate-600">A USD account holds USD. Its balance is translated for reports and revalued at period end, but never stored converted.</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {entityBankAccounts.map((bank) => (
                    <span key={bank.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                      <span className="font-medium text-slate-900">{bank.name}</span> <span className="text-slate-500">· {bank.currency} · {bank.accountCode}</span>
                    </span>
                  ))}
                </div>
                {allowed('rates:manage') ? (
                  <form
                    className="mt-4 flex flex-wrap items-end gap-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      runSetting(`Bank account "${bankForm.name}" added.`, () => createBankAccount(selectedEntity.id, bankForm));
                      setBankForm({ name: '', currency: 'USD' });
                    }}
                  >
                    <div className="min-w-[220px]">
                      <label className="mb-1.5 block text-xs font-medium text-slate-600">Name</label>
                      <Input required value={bankForm.name} placeholder="Stanbic USD account" onChange={(event) => setBankForm((c) => ({ ...c, name: event.target.value }))} />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-600">Currency</label>
                      <select value={bankForm.currency} onChange={(event) => setBankForm((c) => ({ ...c, currency: event.target.value as Currency }))} className="min-h-[44px] rounded-lg border border-slate-200 bg-white px-3 text-sm">
                        {currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                      </select>
                    </div>
                    <Button type="submit" size="sm" disabled={settingsPending}>Add bank account</Button>
                  </form>
                ) : null}
              </Card>

              {allowed('revaluation:run') ? (
                <Card className="rounded-2xl">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Period end</p>
                  <h3 className="mt-1 text-xl font-semibold text-slate-900">Unrealised FX revaluation</h3>
                  <p className="mt-1 text-sm text-slate-600">
                    Revalues every foreign-currency monetary balance — bank accounts, receivables, payables — at the closing rate and posts the difference to 7020. Inventory and fixed assets are never touched. Reverse it on the first day of the next period.
                  </p>
                  <div className="mt-4 flex flex-wrap items-end gap-3">
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-slate-600">Period</label>
                      <Input type="month" value={revalForm.period} onChange={(event) => { setRevalForm((c) => ({ ...c, period: event.target.value })); setRevalPreview(null); }} />
                    </div>
                    {currencies.filter((currency) => currency !== functionalCurrency).map((currency) => {
                      const closing = selectRate(entityRates, currency, functionalCurrency, `${revalForm.period}-${new Date(Date.UTC(Number(revalForm.period.slice(0, 4)), Number(revalForm.period.slice(5, 7)), 0)).getUTCDate()}`);
                      return (
                        <div key={currency}>
                          <label className="mb-1.5 block text-xs font-medium text-slate-600">{currency} closing rate</label>
                          <Input inputMode="decimal" className="w-36" value={revalForm.rates[currency] ?? closing?.rate ?? ''} placeholder="none on file" onChange={(event) => { setRevalForm((c) => ({ ...c, rates: { ...c.rates, [currency]: event.target.value } })); setRevalPreview(null); }} />
                          {closing && !revalForm.rates[currency] ? <p className="mt-1 text-[11px] text-slate-500">{closing.exact ? 'On file for period end' : `From ${closing.rateDate}`}</p> : null}
                        </div>
                      );
                    })}
                    <Button size="sm" variant="secondary" disabled={settingsPending} onClick={() => startSettingsTransition(async () => {
                      const result = await previewRevaluation(selectedEntity.id, revalForm.period, revalClosingRates());
                      if (result.ok) { setRevalPreview(result.value); setSettingsMessage(null); } else { setSettingsMessage({ tone: 'error', text: result.error }); }
                    })}>Preview</Button>
                    <Button size="sm" disabled={settingsPending || !revalPreview || revalPreview.adjustments.length === 0} onClick={() => runSetting(`Revaluation ${revalForm.period} posted.`, async () => { const r = await runRevaluation(selectedEntity.id, revalForm.period, revalClosingRates()); if (r.ok) setRevalPreview(null); return r; })}>Post revaluation</Button>
                  </div>
                  {revalPreview ? (
                    <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
                      <div className="grid grid-cols-[1.4fr_0.6fr_1fr_1fr_0.7fr_1fr_1fr] gap-3 bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                        <span>Account</span><span>Ccy</span><span className="text-right">Foreign balance</span><span className="text-right">Book ({revalPreview.functionalCurrency})</span><span className="text-right">Closing</span><span className="text-right">Revalued</span><span className="text-right">Gain / (loss)</span>
                      </div>
                      {revalPreview.adjustments.map((a) => (
                        <div key={a.accountCode + a.currency} className="grid grid-cols-[1.4fr_0.6fr_1fr_1fr_0.7fr_1fr_1fr] gap-3 border-t border-slate-200 px-4 py-2 text-sm text-slate-700">
                          <span>{a.accountCode} · {a.accountName}</span><span>{a.currency}</span>
                          <span className="text-right font-mono"><Money value={a.foreignMinor} currency={a.currency} /></span>
                          <span className="text-right font-mono"><Money value={a.bookMinor} /></span>
                          <span className="text-right font-mono text-xs">{a.closingRate}</span>
                          <span className="text-right font-mono"><Money value={a.revaluedMinor} /></span>
                          <span className={['text-right font-mono', a.differenceMinor >= 0 ? 'text-emerald-700' : 'text-red-700'].join(' ')}><Money value={a.differenceMinor} /></span>
                        </div>
                      ))}
                      {revalPreview.adjustments.length === 0 ? <div className="border-t border-slate-200 px-4 py-3 text-sm text-slate-500">Nothing to revalue for {revalPreview.period}.</div> : null}
                      <div className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-right text-sm font-semibold">Net unrealised {revalPreview.totalMinor >= 0 ? 'gain' : 'loss'}: <Money value={Math.abs(revalPreview.totalMinor)} /> · dated {revalPreview.closingDate}</div>
                    </div>
                  ) : null}
                  {entityRevaluations.length > 0 ? (
                    <div className="mt-4 space-y-2">
                      {entityRevaluations.map((revaluation) => (
                        <div key={revaluation.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 px-4 py-2 text-sm">
                          <span>
                            <span className="font-medium text-slate-900">{revaluation.period}</span> · posted {revaluation.journal.postedAt} at {Object.entries(revaluation.closingRates).map(([c, r]) => `${c} ${r}`).join(', ')}
                            {revaluation.reversalJournal ? <span className="text-slate-500"> · reversed {revaluation.reversalJournal.postedAt}</span> : null}
                          </span>
                          {!revaluation.reversalJournal ? (
                            <Button size="sm" variant="secondary" disabled={settingsPending} onClick={() => runSetting(`Revaluation ${revaluation.period} reversed.`, () => reverseRevaluation(selectedEntity.id, revaluation.period))}>Reverse into next period</Button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </Card>
              ) : null}

              <Card className="rounded-2xl">
                <div className="flex items-start justify-between gap-4 pb-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Data protection</p>
                    <h3 className="mt-1 text-xl font-semibold text-slate-900">Ledger exports</h3>
                    <p className="mt-1 text-sm text-slate-600">
                      A JSON export of {selectedEntity.name}&rsquo;s books &mdash; accounts, contacts, funds, projects and the audit
                      trail &mdash; runs automatically every night, is checked against its SHA-256 before you download it, and the
                      most recent 14 are kept. Database backups themselves are handled by the database platform.
                    </p>
                  </div>
                  <Button size="sm" onClick={triggerManualBackup} disabled={backupBusy}>
                    {backupBusy ? 'Exporting…' : 'Export now'}
                  </Button>
                </div>

                {(backupError || lastBackupFailed) ? (
                  <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-red-700">Last export failed</p>
                    <p className="mt-1 text-sm font-semibold text-red-900">
                      {backupError ?? backupRuns[0]?.error ?? 'The most recent export did not complete.'}
                    </p>
                    <p className="mt-0.5 text-xs text-red-700">
                      No file was written. Run an export now, and check that the export location is writable.
                    </p>
                  </div>
                ) : null}

                {lastSuccessfulBackup ? (
                  <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-700">Last successful export</p>
                        <p className="mt-1 text-sm font-semibold text-emerald-900">
                          {new Date(lastSuccessfulBackup.createdAt).toLocaleString('en-GH')}
                        </p>
                        <p className="mt-0.5 text-xs text-emerald-700">
                          {(lastSuccessfulBackup.sizeBytes / 1024).toFixed(1)} KB · SHA-256 {lastSuccessfulBackup.checksum.slice(0, 16)}…
                        </p>
                      </div>
                      {lastSuccessfulBackup.available ? (
                        <a
                          href={`/api/backups?entityId=${encodeURIComponent(selectedEntity.id)}&download=${encodeURIComponent(lastSuccessfulBackup.fileName)}`}
                          className="inline-flex min-h-[36px] items-center justify-center rounded-lg border border-brand-200 bg-white px-3 py-2 text-sm font-medium text-brand-800 transition-colors duration-150 ease-out hover:bg-brand-50"
                        >
                          Download latest
                        </a>
                      ) : (
                        <span className="text-xs text-emerald-700">File no longer kept on disk</span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                    No export has completed successfully yet for {selectedEntity.name}. The nightly export runs automatically,
                    or use &ldquo;Export now&rdquo;.
                  </div>
                )}

                <div className="overflow-hidden rounded-xl border border-slate-200">
                  <div className="grid grid-cols-[1.4fr_1fr_0.7fr_0.8fr_0.8fr] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    <span>File</span>
                    <span>When</span>
                    <span>Size</span>
                    <span>Status</span>
                    <span className="text-right">Download</span>
                  </div>
                  {backupRuns.map((run) => (
                    <div key={run.id} className="grid grid-cols-[1.4fr_1fr_0.7fr_0.8fr_0.8fr] gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-700">
                      <span className="truncate font-mono text-xs">{run.fileName}</span>
                      <span>{new Date(run.createdAt).toLocaleString('en-GH')}</span>
                      <span>{(run.sizeBytes / 1024).toFixed(1)} KB</span>
                      <span>
                        <span
                          className={[
                            'rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]',
                            run.status === 'SUCCESS' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700',
                          ].join(' ')}
                        >
                          {run.status}
                        </span>
                      </span>
                      <span className="text-right">
                        {run.status !== 'SUCCESS' ? (
                          <span className="text-xs text-red-600">{run.error ?? 'Failed'}</span>
                        ) : run.available ? (
                          <a
                            href={`/api/backups?entityId=${encodeURIComponent(selectedEntity.id)}&download=${encodeURIComponent(run.fileName)}`}
                            className="text-sm font-medium text-brand-700 hover:underline"
                          >
                            Download
                          </a>
                        ) : (
                          <span className="text-xs text-slate-400">Not kept</span>
                        )}
                      </span>
                    </div>
                  ))}
                  {backupRuns.length === 0 ? (
                    <div className="border-t border-slate-200 px-4 py-6 text-sm text-slate-500">No backups recorded yet.</div>
                  ) : null}
                </div>
              </Card>

              <Card className="rounded-2xl">
                <div className="flex items-start justify-between gap-4 pb-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Audit log</p>
                    <h3 className="mt-1 text-xl font-semibold text-slate-900">{selectedEntity.name}</h3>
                    <p className="mt-1 text-sm text-slate-600">
                      Every posting, edit and void with user and timestamp. This log is append-only — it cannot be edited or deleted from the interface.
                    </p>
                  </div>
                  {auditChainIntact === null ? null : auditChainIntact ? (
                    <span className="rounded-full bg-emerald-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
                      Chain verified
                    </span>
                  ) : (
                    <span className="rounded-full bg-red-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-red-700">
                      Tampering detected
                    </span>
                  )}
                </div>

                <div className="overflow-hidden rounded-xl border border-slate-200">
                  <div className="grid grid-cols-[1fr_0.7fr_0.7fr_0.8fr_1.8fr] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    <span>When</span>
                    <span>User</span>
                    <span>Action</span>
                    <span>Reference</span>
                    <span>Summary</span>
                  </div>
                  {auditEvents.map((event) => (
                    <div key={event.id} className="grid grid-cols-[1fr_0.7fr_0.7fr_0.8fr_1.8fr] gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-700">
                      <span>{new Date(event.createdAt).toLocaleString('en-GH')}</span>
                      <span>{event.userName}</span>
                      <span>
                        <span
                          className={[
                            'rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]',
                            event.action === 'VOID'
                              ? 'bg-red-100 text-red-700'
                              : event.action === 'POST'
                                ? 'bg-emerald-100 text-emerald-700'
                                : event.action === 'EDIT'
                                  ? 'bg-amber-100 text-amber-700'
                                  : 'bg-slate-100 text-slate-700',
                          ].join(' ')}
                        >
                          {event.action}
                        </span>
                      </span>
                      <span className="font-mono text-xs">{event.resourceRef}</span>
                      <span>{event.summary}</span>
                    </div>
                  ))}
                  {auditEvents.length === 0 ? (
                    <div className="border-t border-slate-200 px-4 py-6 text-sm text-slate-500">
                      No audit events recorded for {selectedEntity.name} yet. Postings, edits and voids will appear here automatically.
                    </div>
                  ) : null}
                </div>
              </Card>
            </div>
          ) : activeNav === 'Inventory' ? (
            <InventoryPanel
              key={selectedEntity.id}
              entity={selectedEntity}
              accounts={entityAccounts}
              items={entityItems}
              commodities={entityCommodities}
              lots={entityLots}
              locations={entityLocations}
              balances={initialData.stockBalancesByEntity[selectedEntity.id] ?? []}
              movements={initialData.stockMovementsByEntity[selectedEntity.id] ?? []}
              counts={initialData.stockCountsByEntity[selectedEntity.id] ?? []}
              nrvPrices={initialData.nrvPricesByEntity[selectedEntity.id] ?? []}
              ledger={initialData.inventoryLedgerByEntity[selectedEntity.id] ?? []}
              allowed={allowed}
            />
          ) : activeNav === 'Buying' ? (
            <BuyingPanel
              key={selectedEntity.id}
              entity={selectedEntity}
              agents={initialData.agentsByEntity[selectedEntity.id] ?? []}
              floats={initialData.floatsByEntity[selectedEntity.id] ?? []}
              purchases={initialData.agentPurchasesByEntity[selectedEntity.id] ?? []}
              items={entityItems}
              commodities={entityCommodities}
              locations={entityLocations}
              bankAccounts={entityBankAccounts}
              allowed={allowed}
            />
          ) : activeNav === 'Contracts' ? (
            <ContractsPanel
              key={selectedEntity.id}
              entity={selectedEntity}
              contracts={initialData.contractsByEntity[selectedEntity.id] ?? []}
              contacts={contacts}
              items={entityItems}
              commodities={entityCommodities}
              locations={entityLocations}
              balances={initialData.stockBalancesByEntity[selectedEntity.id] ?? []}
              rates={entityRates}
              bankAccounts={entityBankAccounts}
              seedFunds={initialData.seedFundsByEntity[selectedEntity.id] ?? []}
              allowed={allowed}
            />
          ) : activeNav === 'Payments' ? (
            <PaymentsPanel
              key={selectedEntity.id}
              entity={selectedEntity}
              bankAccounts={entityBankAccounts}
              farmers={initialData.farmersByEntity[selectedEntity.id] ?? []}
              advances={initialData.farmerAdvancesByEntity[selectedEntity.id] ?? []}
              batches={initialData.paymentBatchesByEntity[selectedEntity.id] ?? []}
              mappings={initialData.statementMappingsByEntity[selectedEntity.id] ?? []}
              statements={initialData.statementImportsByEntity[selectedEntity.id] ?? []}
              purchases={initialData.agentPurchasesByEntity[selectedEntity.id] ?? []}
              agents={initialData.agentsByEntity[selectedEntity.id] ?? []}
              items={entityItems}
              allowed={allowed}
            />
          ) : activeNav === 'Cash flow' ? (
            <CashflowPanel
              key={selectedEntity.id}
              entity={selectedEntity}
              entities={entities}
              sources={initialData.cashSourcesByEntity}
              scenariosByEntity={initialData.scenariosByEntity}
              seasons={initialData.seasonsByEntity[selectedEntity.id] ?? []}
              recurring={initialData.recurringByEntity[selectedEntity.id] ?? []}
              commodities={entityCommodities}
              allowed={allowed}
            />
          ) : activeNav === 'Assets' ? (
            <AssetsPanel
              key={selectedEntity.id}
              entity={selectedEntity}
              assets={initialData.assetsByEntity[selectedEntity.id] ?? []}
              runs={initialData.depreciationRunsByEntity[selectedEntity.id] ?? []}
              classes={initialData.allowanceClassesByEntity[selectedEntity.id] ?? []}
              taxYears={initialData.taxYearsByEntity[selectedEntity.id] ?? []}
              contacts={contacts}
              bankAccounts={entityBankAccounts}
              allowed={allowed}
            />
          ) : activeNav === 'Personal data' ? (
            <PrivacyPanel
              key={selectedEntity.id}
              entity={selectedEntity}
              counts={initialData.personalDataCountsByEntity[selectedEntity.id] ?? []}
              requests={initialData.dataRequestsByEntity[selectedEntity.id] ?? []}
              access={initialData.piiAccessByEntity[selectedEntity.id] ?? []}
              allowed={allowed}
            />
          ) : activeNav === 'Inbox' ? (
            <InboxPanel
              key={selectedEntity.id}
              entity={selectedEntity}
              attachments={initialData.attachmentsByEntity[selectedEntity.id] ?? []}
              rules={initialData.attachmentRulesByEntity[selectedEntity.id] ?? []}
              documents={entityDocuments}
              allowed={allowed}
              currentUserId={initialData.currentUser.id}
            />
          ) : activeNav === 'Payroll' ? (
            <PayrollPanel
              key={selectedEntity.id}
              entity={selectedEntity}
              runs={initialData.payrollRunsByEntity[selectedEntity.id] ?? []}
              mappings={initialData.payrollMappingsByEntity[selectedEntity.id] ?? []}
              departments={initialData.payrollDepartmentsByEntity[selectedEntity.id] ?? []}
              allocations={initialData.payrollAllocationsByEntity[selectedEntity.id] ?? []}
              grants={initialData.grantsByEntity[selectedEntity.id] ?? []}
              accounts={entityAccounts}
              bankAccounts={entityBankAccounts}
              allowed={allowed}
            />
          ) : activeNav === 'Grants' ? (
            <GrantsPanel
              key={selectedEntity.id}
              entity={selectedEntity}
              grants={initialData.grantsByEntity[selectedEntity.id] ?? []}
              actuals={initialData.grantActualsByEntity[selectedEntity.id] ?? []}
              inKind={initialData.inKindByEntity[selectedEntity.id] ?? []}
              staffTime={initialData.staffTimeByEntity[selectedEntity.id] ?? []}
              contacts={contacts}
              accounts={entityAccounts}
              funds={initialData.fundsByEntity[selectedEntity.id] ?? []}
              bankAccounts={entityBankAccounts}
              allowed={allowed}
            />
          ) : activeNav === 'Go-live' ? (
            <OpeningPanel key={selectedEntity.id} entity={selectedEntity} opening={initialData.openingByEntity[selectedEntity.id]} allowed={allowed} />
          ) : (
            <Card className="rounded-2xl">
              <div className="border-b border-slate-200 pb-4">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{isPurchaseView ? 'Purchase' : 'Sales'}</p>
                    <h2 className="mt-1 text-2xl font-semibold text-slate-900">
                      {documentTitle}
                      {activeDocument.docNumber ? <span className="ml-3 font-mono text-lg text-slate-500">{activeDocument.docNumber}</span> : null}
                    </h2>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={[
                      'rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]',
                      activeDocument.status === 'draft' ? 'bg-slate-100 text-slate-700' : activeDocument.status === 'voided' ? 'bg-red-100 text-red-700' : activeDocument.status === 'paid' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800',
                    ].join(' ')}>
                      {statusLabels[activeDocument.status]}
                    </span>
                    {allowed('document:draft') ? (
                      <Button variant="secondary" size="sm" disabled={documentPending} onClick={startNewDocument}>New {isPurchaseView ? 'bill' : 'invoice'}</Button>
                    ) : null}
                    {activeDocument.status === 'draft' && allowed('document:post') ? (
                      <Button size="sm" disabled={documentPending || documentPeriodLocked} onClick={postCurrentDocument}>
                        {documentPending ? 'Posting…' : 'Post'}
                      </Button>
                    ) : null}
                    {activeDocument.status === 'awaiting-payment' && allowed('document:mark-paid') ? (
                      <Button size="sm" disabled={documentPending} onClick={() => (paymentOpen ? setPaymentOpen(false) : openPaymentPanel())}>
                        {paymentOpen ? 'Cancel payment' : 'Record payment'}
                      </Button>
                    ) : null}
                    {(activeDocument.status === 'awaiting-payment' || activeDocument.status === 'paid') && allowed('document:void') ? (
                      <Button variant="danger" size="sm" disabled={documentPending} onClick={voidCurrentDocument}>Void</Button>
                    ) : null}
                  </div>
                </div>
              </div>

              {documentError ? (
                <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{documentError}</div>
              ) : null}

              {documentPeriodLocked && activeDocument.status === 'draft' ? (
                <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                  The VAT period for this document date has been filed and locked for {selectedEntity.name}. Date the document in an open period, or post a reversing adjustment dated in the current one.
                </div>
              ) : null}

              {activeDocument.status === 'voided' && activeRecord?.voidJournal ? (
                <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                  Voided. A reversing journal dated {activeRecord.voidJournal.postedAt} cancels the original posting; both remain in the ledger.
                </div>
              ) : null}

              {entityDocuments.filter((document) => document.kind === activeKind).length > 0 ? (
                <div className="mt-5 overflow-hidden rounded-xl border border-slate-200">
                  <div className="grid grid-cols-[1fr_1.6fr_1fr_1fr_1fr] gap-3 bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    <span>Number</span>
                    <span>Contact</span>
                    <span>Date</span>
                    <span>Status</span>
                    <span className="text-right">Total</span>
                  </div>
                  {entityDocuments
                    .filter((document) => document.kind === activeKind)
                    .slice(0, 8)
                    .map((document) => (
                      <button
                        key={document.id}
                        type="button"
                        onClick={() => openDocument(document)}
                        className={[
                          'grid w-full grid-cols-[1fr_1.6fr_1fr_1fr_1fr] gap-3 border-t border-slate-200 px-4 py-2 text-left text-sm hover:bg-brand-50',
                          document.id === activeDocument.id ? 'bg-brand-50 text-slate-900' : 'text-slate-700',
                        ].join(' ')}
                      >
                        <span className="font-mono text-xs">{document.docNumber || '(draft)'}</span>
                        <span className="truncate">{document.contactName}</span>
                        <span>{document.date}</span>
                        <span>{statusLabels[document.status]}</span>
                        <span className="text-right font-mono"><Money value={buildTotals(document, undefined, taxOf(document)).total} currency={document.currency} /></span>
                      </button>
                    ))}
                </div>
              ) : null}

              <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Document no.</label>
                  <Input value={activeDocument.docNumber || 'Allocated on posting'} readOnly disabled />
                </div>

                <div>
                  <div className="mb-1.5 flex items-baseline justify-between gap-2">
                    <label className="block text-sm font-medium text-slate-700">Contact</label>
                    {allowed('contact:create') && !documentReadOnly ? (
                      <button
                        type="button"
                        onClick={() => {
                          // A customer on an invoice, a supplier on a bill —
                          // the usual case, and still editable in the form.
                          setContactFormValues((current) => ({
                            ...current,
                            type: isPurchaseView ? 'supplier' : 'customer',
                            category: isPurchaseView ? 'supplier' : 'customer',
                          }));
                          setContactFormTarget('document');
                          setShowAddContactForm(true);
                        }}
                        className="text-xs font-medium text-brand-700 underline-offset-2 hover:underline"
                      >
                        ＋ New contact
                      </button>
                    ) : null}
                  </div>
                  <select
                    value={activeDocument.contactId}
                    disabled={documentReadOnly}
                    onChange={(event) => updateCurrentDocument({ contactId: event.target.value })}
                    className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50"
                  >
                    {entityContacts.map((contact) => (
                      <option key={contact.id} value={contact.id}>{contact.name}</option>
                    ))}
                    {activeContact && !entityContacts.some((contact) => contact.id === activeContact.id) ? (
                      <option value={activeContact.id}>{activeContact.name}</option>
                    ) : null}
                  </select>
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Date</label>
                  <Input
                    type="date"
                    value={activeDocument.date}
                    disabled={documentReadOnly}
                    onChange={(event) => {
                      const date = event.target.value;
                      const quote = selectRate(entityRates, activeDocument.currency, functionalCurrency, date);
                      // A new date takes the table's rate for that date; type over it again to override.
                      updateCurrentDocument({ date, rate: quote?.rate ?? null, rateDate: quote?.rateDate ?? null, rateExact: quote ? quote.exact && !quote.inverted : true });
                    }}
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Due date</label>
                  <Input
                    type="date"
                    value={activeDocument.dueDate}
                    disabled={documentReadOnly}
                    onChange={(event) => updateCurrentDocument({ dueDate: event.target.value })}
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Currency</label>
                  <select
                    value={activeDocument.currency}
                    disabled={documentReadOnly}
                    onChange={(event) => {
                      const currency = event.target.value as Currency;
                      const quote = selectRate(entityRates, currency, functionalCurrency, activeDocument.date);
                      updateCurrentDocument({ currency, rate: quote?.rate ?? null, rateDate: quote?.rateDate ?? null, rateExact: quote ? quote.exact && !quote.inverted : true });
                    }}
                    className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50"
                  >
                    {currencies.map((currency) => (
                      <option key={currency} value={currency}>{currency} · {currencyNames[currency]}</option>
                    ))}
                  </select>
                </div>

                {documentIsForeign ? (
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-700">Rate ({functionalCurrency} per 1 {activeDocument.currency})</label>
                    <Input
                      inputMode="decimal"
                      value={documentReadOnly ? (activeDocument.rate ?? documentRate ?? '') : (activeDocument.rate ?? documentRate ?? '')}
                      disabled={documentReadOnly}
                      placeholder="e.g. 12.5"
                      onChange={(event) => updateCurrentDocument({ rate: event.target.value || null, rateDate: activeDocument.date, rateExact: false })}
                    />
                    {documentRateWarning ? (
                      <p className={['mt-1 text-xs', documentRateWarning.startsWith('No ') ? 'font-medium text-amber-700' : 'text-slate-500'].join(' ')}>{documentRateWarning}</p>
                    ) : (
                      <p className="mt-1 text-xs text-slate-500">Rate on file for {activeDocument.date}. Type over it if the bank&rsquo;s rate differs.</p>
                    )}
                  </div>
                ) : (
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-700">Status</label>
                    <Input value={statusLabels[activeDocument.status]} readOnly disabled />
                  </div>
                )}

                {!isPurchaseView ? (
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-700">Sale</label>
                    <select
                      value={activeDocument.saleType}
                      disabled={documentReadOnly}
                      onChange={(event) => updateCurrentDocument({ saleType: event.target.value as SaleType })}
                      className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50"
                    >
                      <option value="domestic">Domestic</option>
                      <option value="export">Export</option>
                    </select>
                    <p className="mt-1 text-xs text-slate-500">
                      {documentTax.vatApplies
                        ? activeDocument.saleType === 'export' ? 'Export: zero-rated.' : 'Domestic: VAT charged per line.'
                        : 'Exports will be zero-rated once registered; nothing changes yet.'}
                    </p>
                  </div>
                ) : (
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-700">Import VAT paid at entry ({activeDocument.currency})</label>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={pesewasToCedisInput(activeDocument.importVat)}
                      disabled={documentReadOnly}
                      onChange={(event) => updateCurrentDocument({ importVat: cedisInputToPesewas(event.target.value) })}
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      {documentTax.vatApplies ? 'Recoverable: posted to input tax.' : 'Not recoverable while unregistered: posted to the cost of the goods.'}
                    </p>
                  </div>
                )}
              </div>

              {!documentTax.vatApplies ? (
                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                  <span className="font-medium text-slate-900">No VAT on this {isPurchaseView ? 'bill' : 'invoice'}.</span>{' '}
                  {selectedEntity.vatRegistered
                    ? `${selectedEntity.name} is VAT registered from ${selectedEntity.vatRegisteredFrom}; this document is dated before that, so it is not taxed.`
                    : `${selectedEntity.name} is not VAT registered. Amounts are gross${isPurchaseView ? ' — any VAT the supplier charged is part of the cost' : ''}. The supply type per line only feeds the registration threshold tracker.`}
                </div>
              ) : null}

              <div className="mt-6 rounded-2xl border border-slate-200 overflow-hidden">
                <div className="grid grid-cols-[1.6fr_0.7fr_0.9fr_1fr_1.1fr_56px] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                  <span>Description</span>
                  <span>Qty</span>
                  <span>Unit price ({activeDocument.currency})</span>
                  <span>Account</span>
                  <span>{documentTax.vatApplies ? 'VAT' : 'Supply type'}</span>
                  <span />
                </div>

                {activeDocument.lines.map((line) => (
                  <div key={line.id} className="grid grid-cols-[1.6fr_0.7fr_0.9fr_1fr_1.1fr_56px] gap-3 border-t border-slate-200 px-4 py-3">
                    <Input
                      value={line.description}
                      disabled={documentReadOnly}
                      onChange={(event) => updateLine(line.id, { description: event.target.value })}
                      placeholder="Cashew bags"
                    />
                    <Input
                      type="number"
                      min={0}
                      step="any"
                      value={line.quantity}
                      disabled={documentReadOnly}
                      onChange={(event) => updateLine(line.id, { quantity: Number(event.target.value) || 0 })}
                    />
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={pesewasToCedisInput(line.unitPrice)}
                      disabled={documentReadOnly}
                      onChange={(event) => updateLine(line.id, { unitPrice: cedisInputToPesewas(event.target.value) })}
                    />
                    <select
                      value={line.accountCode}
                      disabled={documentReadOnly}
                      onChange={(event) => updateLine(line.id, { accountCode: event.target.value })}
                      className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50"
                    >
                      {entityAccounts
                        .filter((account) => account.isActive && (isPurchaseView ? account.type === 'COST_OF_SALES' || account.type === 'EXPENSE' || account.type === 'ASSET' : account.type === 'INCOME'))
                        .map((account) => (
                          <option key={account.code} value={account.code}>{account.code} · {account.name}</option>
                        ))}
                    </select>
                    <select
                      value={line.vatTreatment}
                      disabled={documentReadOnly}
                      onChange={(event) =>
                        updateLine(line.id, { vatTreatment: event.target.value as VATTreatment })
                      }
                      className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50"
                    >
                      <option value="standard">{documentTax.vatApplies ? 'Standard 20%' : 'Taxable'}</option>
                      <option value="zero-rated">Zero-rated</option>
                      <option value="exempt">Exempt</option>
                    </select>
                    <button
                      type="button"
                      disabled={documentReadOnly}
                      onClick={() => removeLine(line.id)}
                      className="text-slate-400 hover:text-red-600 disabled:invisible"
                    >
                      ×
                    </button>
                    {isPurchaseView && entityHoldsStock ? (
                      <div className="col-span-6 -mt-1 space-y-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-2">
                        <div className="grid gap-3 md:grid-cols-[1.4fr_1fr_1.6fr]">
                          <div>
                            <label className="mb-1 block text-xs font-medium text-slate-600">Stock</label>
                            <select
                              value={line.itemId ? `item:${line.itemId}` : line.landedCostKind ? `landed:${line.landedCostKind}` : line.contractId ? `contract:${line.contractId}` : ''}
                              disabled={documentReadOnly}
                              onChange={(event) => {
                                const [mode, value] = event.target.value.split(':');
                                if (mode === 'item') {
                                  const item = entityItems.find((candidate) => candidate.id === value);
                                  // The grade decides the account: the line posts where the stock is carried.
                                  if (item) updateLine(line.id, { itemId: item.id, accountCode: item.accountCode, locationId: line.locationId ?? entityLocations.find((location) => location.isActive)?.id ?? null, landedCostKind: null, landedCostLotIds: [], contractId: null, sellingCostKind: null });
                                } else if (mode === 'landed') {
                                  // A landed cost posts to the account the lots are carried in; the server checks each lot.
                                  updateLine(line.id, { landedCostKind: value as LandedCostKind, itemId: null, locationId: null, accountCode: entityItems.find((item) => item.isActive)?.accountCode ?? '1030', lotRef: '', community: '', district: '', quality: {}, contractId: null, sellingCostKind: null });
                                } else if (mode === 'contract') {
                                  // A selling cost keeps its expense account; it is attributed to the contract for its margin.
                                  updateLine(line.id, { contractId: value, sellingCostKind: line.sellingCostKind ?? 'transport-to-buyer', itemId: null, locationId: null, landedCostKind: null, landedCostLotIds: [], lotRef: '', community: '', district: '', quality: {} });
                                } else {
                                  updateLine(line.id, { itemId: null, locationId: null, landedCostKind: null, landedCostLotIds: [], lotRef: '', community: '', district: '', quality: {}, contractId: null, sellingCostKind: null });
                                }
                              }}
                              className="min-h-[40px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50"
                            >
                              <option value="">Not stock — expense only</option>
                              <optgroup label="Receive a grade (creates a lot)">
                                {entityItems.filter((item) => item.isActive).map((item) => (
                                  <option key={item.id} value={`item:${item.id}`}>{item.name} ({unitLabels[item.baseUnit]})</option>
                                ))}
                              </optgroup>
                              <optgroup label="Capitalise into stock (landed cost)">
                                {landedCostKinds.map((kind) => <option key={kind} value={`landed:${kind}`}>{landedCostLabels[kind]}</option>)}
                              </optgroup>
                              <optgroup label="Selling cost of a sales contract">
                                {(initialData.contractsByEntity[selectedEntity.id] ?? []).filter((contract) => contract.status !== 'cancelled').map((contract) => <option key={contract.id} value={`contract:${contract.id}`}>{contract.contractNo} · {contract.buyerName}</option>)}
                              </optgroup>
                            </select>
                          </div>
                          {line.contractId ? (
                            <div>
                              <label className="mb-1 block text-xs font-medium text-slate-600">Kind of selling cost</label>
                              <select
                                value={line.sellingCostKind ?? 'transport-to-buyer'}
                                disabled={documentReadOnly}
                                onChange={(event) => updateLine(line.id, { sellingCostKind: event.target.value as SellingCostKind })}
                                className="min-h-[40px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50"
                              >
                                {sellingCostKinds.map((kind) => <option key={kind} value={kind}>{sellingCostLabels[kind]}</option>)}
                              </select>
                            </div>
                          ) : line.itemId ? (
                            <div>
                              <label className="mb-1 block text-xs font-medium text-slate-600">Received at</label>
                              <select
                                value={line.locationId ?? ''}
                                disabled={documentReadOnly}
                                onChange={(event) => updateLine(line.id, { locationId: event.target.value || null })}
                                className="min-h-[40px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50"
                              >
                                <option value="">Choose…</option>
                                {entityLocations.filter((location) => location.isActive).map((location) => (
                                  <option key={location.id} value={location.id}>{location.name}</option>
                                ))}
                              </select>
                            </div>
                          ) : <div />}
                          <p className="self-end pb-2 text-xs text-slate-500">
                            {line.itemId
                              ? `Qty in ${unitLabels[entityItems.find((item) => item.id === line.itemId)?.baseUnit ?? 'kg']}; price per ${unitLabels[entityItems.find((item) => item.id === line.itemId)?.baseUnit ?? 'kg'].replace(/s$/, '')}. Posting receives the stock at this cost and records the lot.`
                              : line.contractId
                                ? 'Posted to the expense account chosen; attributed to the contract for its margin per kg.'
                                : line.landedCostKind
                                ? 'Spread per kilogram over the lots ticked below; their value rises, quantity does not.'
                                : entityAccounts.find((account) => account.code === line.accountCode)?.category === inventoryAccountCategory
                                  ? 'This account holds stock. Name the grade, or the ledger will carry value that stock does not.'
                                  : ''}
                          </p>
                        </div>
                        {entityGrants.length > 0 ? (
                          <div className="grid gap-3 md:grid-cols-[2fr_2fr_3fr]">
                            <div>
                              <label className="mb-1 block text-xs font-medium text-slate-600">Grant</label>
                              <select
                                value={line.grantId ?? ''}
                                disabled={documentReadOnly}
                                onChange={(event) => updateLine(line.id, { grantId: event.target.value || null, budgetLineId: null })}
                                className="min-h-[40px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50"
                              >
                                <option value="">Not a grant cost</option>
                                {entityGrants.map((grant) => <option key={grant.id} value={grant.id}>{grant.code} · {grant.name}</option>)}
                              </select>
                            </div>
                            {line.grantId ? (
                              <div>
                                <label className="mb-1 block text-xs font-medium text-slate-600">Budget line</label>
                                <select
                                  value={line.budgetLineId ?? ''}
                                  disabled={documentReadOnly}
                                  onChange={(event) => updateLine(line.id, { budgetLineId: event.target.value || null })}
                                  className="min-h-[40px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50"
                                >
                                  <option value="">Choose…</option>
                                  {(entityGrants.find((grant) => grant.id === line.grantId)?.budgetLines ?? []).map((budgetLine) => (
                                    <option key={budgetLine.id} value={budgetLine.id}>{budgetLine.code} · {budgetLine.name}</option>
                                  ))}
                                </select>
                              </div>
                            ) : <div />}
                            <p className="self-end pb-2 text-xs text-slate-500">
                              {line.grantId
                                ? line.budgetLineId
                                  ? 'Counts against this budget line in the donor report, and against the grant\u2019s fund.'
                                  : 'Money charged to a grant always comes out of a budget line. Choose one, or the bill will not post.'
                                : ''}
                            </p>
                          </div>
                        ) : null}
                        {line.itemId ? (
                          <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_2fr]">
                            <div><label className="mb-1 block text-xs font-medium text-slate-600">Lot ref (optional)</label><Input className="min-h-[40px]" value={line.lotRef} disabled={documentReadOnly} placeholder="auto if blank" onChange={(event) => updateLine(line.id, { lotRef: event.target.value })} /></div>
                            <div><label className="mb-1 block text-xs font-medium text-slate-600">Community</label><Input className="min-h-[40px]" value={line.community} disabled={documentReadOnly} onChange={(event) => updateLine(line.id, { community: event.target.value })} /></div>
                            <div><label className="mb-1 block text-xs font-medium text-slate-600">District</label><Input className="min-h-[40px]" value={line.district} disabled={documentReadOnly} onChange={(event) => updateLine(line.id, { district: event.target.value })} /></div>
                            <div className="grid grid-cols-3 gap-2">
                              {qualityFieldsFor(entityCommodities.find((commodity) => commodity.id === entityItems.find((item) => item.id === line.itemId)?.commodityId)?.kind ?? 'other').map((field) => (
                                <div key={field.key}>
                                  <label className="mb-1 block text-xs font-medium text-slate-600">{field.label}{field.unit ? ` (${field.unit})` : ''}</label>
                                  <Input
                                    className="min-h-[40px]"
                                    type={field.kind === 'number' ? 'number' : 'text'}
                                    inputMode={field.kind === 'number' ? 'decimal' : undefined}
                                    step="any"
                                    value={line.quality[field.key] ?? ''}
                                    disabled={documentReadOnly}
                                    onChange={(event) => {
                                      const raw = event.target.value;
                                      const next = { ...line.quality };
                                      if (raw === '') delete next[field.key];
                                      else if (field.kind === 'number') (next as Record<string, unknown>)[field.key] = Number(raw);
                                      else (next as Record<string, unknown>)[field.key] = raw;
                                      updateLine(line.id, { quality: next });
                                    }}
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {line.landedCostKind ? (
                          <div>
                            <label className="mb-1 block text-xs font-medium text-slate-600">Relates to these lots</label>
                            <div className="grid gap-1 md:grid-cols-2 xl:grid-cols-3">
                              {entityLots.slice(0, 60).map((lot) => (
                                <label key={lot.id} className="flex items-center gap-2 text-xs text-slate-700">
                                  <input
                                    type="checkbox"
                                    disabled={documentReadOnly}
                                    checked={line.landedCostLotIds.includes(lot.id)}
                                    onChange={(event) => updateLine(line.id, { landedCostLotIds: event.target.checked ? [...line.landedCostLotIds, lot.id] : line.landedCostLotIds.filter((id) => id !== lot.id) })}
                                  />
                                  <span className="font-mono">{lot.lotRef}</span> {lot.date} · {entityItems.find((item) => item.id === lot.itemId)?.name} · {formatKg(lot.gramsIn)}
                                </label>
                              ))}
                              {entityLots.length === 0 ? <span className="text-xs text-slate-500">No lots yet to spread this over.</span> : null}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>

              {!documentReadOnly ? (
                <div className="mt-4 flex justify-end">
                  <Button variant="secondary" size="sm" onClick={addLine}>Add line</Button>
                </div>
              ) : null}

              <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_320px]">
                <div className="space-y-3">
                  <Attachments
                    entityId={selectedEntity.id}
                    target={isPurchaseView ? 'bill' : 'invoice'}
                    targetId={activeDocument.id}
                    attachments={initialData.attachmentsByEntity[selectedEntity.id] ?? []}
                    rules={initialData.attachmentRulesByEntity[selectedEntity.id] ?? []}
                    amountMinor={activeTotals.total}
                    posted={documentReadOnly}
                    currentUserId={initialData.currentUser.id}
                    canEdit={allowed('document:draft')}
                  />
                  {isPurchaseView && activeContact ? (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Supplier details</div>
                      <div className="mt-2 space-y-1 text-sm text-slate-700">
                        <div><span className="font-medium text-slate-900">{activeContact.name}</span></div>
                        <div>TIN: {activeContact.tin}</div>
                        <div>WHT status: {activeContact.withholdingTaxStatus}</div>
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="space-y-2 text-sm text-slate-700">
                    {(documentTax.vatApplies
                      ? [
                          ['Subtotal', activeTotals.subtotal],
                          ['VAT (15%)', activeTotals.vat],
                          ['NHIL (2.5%)', activeTotals.nhil],
                          ['GETFund (2.5%)', activeTotals.getFund],
                        ]
                      : [['Subtotal (gross)', activeTotals.subtotal]]
                    ).map(([label, amount]) => (
                      <div key={label as string} className="flex items-start justify-between">
                        <span>{label}</span>
                        <FxAmount amount={amount as number} currency={activeDocument.currency} functional={documentIsForeign ? toFunctional(amount as number) : null} functionalCurrency={functionalCurrency} />
                      </div>
                    ))}
                    <div className="flex items-start justify-between border-t border-slate-200 pt-2 text-base font-semibold text-slate-900">
                      <span>Total</span>
                      <FxAmount amount={activeTotals.total} currency={activeDocument.currency} functional={documentIsForeign ? toFunctional(activeTotals.total) : null} functionalCurrency={functionalCurrency} large />
                    </div>
                    {isPurchaseView ? (
                      <>
                        <div className="flex items-start justify-between border-t border-slate-200 pt-2">
                          <span>Withholding tax</span>
                          <FxAmount amount={activeTotals.withholdingTax} currency={activeDocument.currency} functional={documentIsForeign ? toFunctional(activeTotals.withholdingTax) : null} functionalCurrency={functionalCurrency} />
                        </div>
                        {activeTotals.importVat > 0 ? (
                          <div className="flex items-start justify-between">
                            <span>Import VAT at entry{documentTax.vatApplies ? '' : ' (to cost)'}</span>
                            <FxAmount amount={activeTotals.importVat} currency={activeDocument.currency} functional={documentIsForeign ? toFunctional(activeTotals.importVat) : null} functionalCurrency={functionalCurrency} />
                          </div>
                        ) : null}
                        <div className="flex items-start justify-between text-base font-semibold text-slate-900">
                          <span>Net payable</span>
                          <FxAmount amount={activeTotals.netPayable} currency={activeDocument.currency} functional={documentIsForeign ? toFunctional(activeTotals.netPayable) : null} functionalCurrency={functionalCurrency} large />
                        </div>
                      </>
                    ) : null}
                    {documentIsForeign ? (
                      <p className="pt-1 text-[11px] text-slate-500">
                        {documentRate ? `Functional amounts at ${documentRate} ${functionalCurrency} per ${activeDocument.currency}${activeRecord?.journal ? ' — fixed at posting' : ''}.` : 'Functional amounts need a rate.'}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>

              {!isPurchaseView ? (
                <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">GRA E-VAT — placeholder</p>
                    <span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-700">Integration pending</span>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    Reserved for the future GRA E-VAT integration. Nothing is transmitted yet — these fields will be auto-populated with the clearance number, QR code and timestamp returned by GRA. Manual entry is allowed until then.
                  </p>
                  <div className="mt-3 grid gap-4 md:grid-cols-3">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-slate-700">Clearance number</label>
                      <Input
                        value={activeDocument.evatClearanceNumber}
                        onChange={(event) => updateCurrentDocument({ evatClearanceNumber: event.target.value })}
                        placeholder="Pending GRA integration"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-slate-700">QR code</label>
                      <Input
                        value={activeDocument.evatQrCode}
                        onChange={(event) => updateCurrentDocument({ evatQrCode: event.target.value })}
                        placeholder="Pending GRA integration"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-slate-700">Timestamp</label>
                      <Input
                        value={activeDocument.evatTimestamp}
                        onChange={(event) => updateCurrentDocument({ evatTimestamp: event.target.value })}
                        placeholder="Pending GRA integration"
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              {paymentOpen && activeRecord && activeRecord.status === 'awaiting-payment' ? (
                <div className="mt-6 rounded-2xl border border-brand-200 bg-brand-50/40 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Record payment</p>
                  <p className="mt-1 text-sm text-slate-600">
                    Outstanding: <Money value={outstandingTxn} currency={activeRecord.currency} />
                    {activeRecord.currency !== functionalCurrency && activeRecord.rate ? <> · booked at {activeRecord.rate} on {activeRecord.rateDate ?? activeRecord.date}</> : null}
                  </p>
                  <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-slate-700">Bank account</label>
                      <select
                        value={paymentBank?.id ?? ''}
                        onChange={(event) => setPaymentForm((current) => ({ ...current, bankAccountId: event.target.value }))}
                        className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900"
                      >
                        {entityBankAccounts
                          .filter((bank) => bank.currency === activeRecord.currency || bank.currency === functionalCurrency)
                          .map((bank) => (
                            <option key={bank.id} value={bank.id}>{bank.name} · {bank.currency}</option>
                          ))}
                      </select>
                      <p className="mt-1 text-xs text-slate-500">Only accounts in {activeRecord.currency}{activeRecord.currency !== functionalCurrency ? ` or ${functionalCurrency}` : ''} can settle this document.</p>
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-slate-700">Date</label>
                      <Input type="date" value={paymentForm.date} onChange={(event) => setPaymentForm((current) => ({ ...current, date: event.target.value, rate: '' }))} />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-slate-700">Amount ({activeRecord.currency})</label>
                      <Input inputMode="decimal" value={paymentForm.amount} onChange={(event) => setPaymentForm((current) => ({ ...current, amount: event.target.value }))} />
                    </div>
                    {activeRecord.currency !== functionalCurrency ? (
                      <div>
                        <label className="mb-1.5 block text-sm font-medium text-slate-700">Bank rate ({functionalCurrency} per 1 {activeRecord.currency})</label>
                        <Input inputMode="decimal" value={paymentForm.rate || paymentRateQuote?.rate || ''} onChange={(event) => setPaymentForm((current) => ({ ...current, rate: event.target.value }))} />
                        <p className={['mt-1 text-xs', !paymentRateQuote ? 'font-medium text-amber-700' : 'text-slate-500'].join(' ')}>
                          {paymentForm.rate
                            ? 'Overridden — use the rate on the bank credit or debit advice.'
                            : paymentRateQuote
                              ? paymentRateQuote.exact
                                ? `Rate on file for ${paymentForm.date}. Type over it with the bank&apos;s actual rate.`
                                : `No rate for ${paymentForm.date}; using ${paymentRateQuote.rateDate}. Type the bank's actual rate.`
                              : 'No rate on file. Type the rate the bank applied.'}
                        </p>
                      </div>
                    ) : null}
                  </div>

                  {paymentPreview ? (
                    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">The calculation</p>
                      <div className="mt-2 grid gap-2 md:grid-cols-3">
                        <div>
                          <p className="text-xs text-slate-500">{activeRecord.kind === 'invoice' ? 'Receivable cleared' : 'Payable cleared'} (at {activeRecord.rate})</p>
                          <p className="font-mono text-slate-900"><Money value={paymentAmountMinor} currency={activeRecord.currency} /> → <Money value={paymentPreview.reliefMinor} currency={functionalCurrency} /></p>
                        </div>
                        <div>
                          <p className="text-xs text-slate-500">Bank {activeRecord.kind === 'invoice' ? 'received' : 'paid'} (at {paymentRate})</p>
                          <p className="font-mono text-slate-900"><Money value={paymentPreview.bankAmountMinor} currency={paymentBank?.currency} /> = <Money value={paymentPreview.bankFunctionalMinor} currency={functionalCurrency} /></p>
                        </div>
                        <div>
                          <p className="text-xs text-slate-500">Realised FX {paymentPreview.gainLossMinor >= 0 ? 'gain' : 'loss'}</p>
                          <p className={['font-mono font-semibold', paymentPreview.gainLossMinor >= 0 ? 'text-emerald-700' : 'text-red-700'].join(' ')}>
                            <Money value={Math.abs(paymentPreview.gainLossMinor)} currency={functionalCurrency} />
                            {paymentPreview.gainLossMinor === 0 ? ' (none)' : ''}
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
                        {paymentPreview.lines.map((line) => (
                          <div key={line.accountCode + line.type} className="grid grid-cols-[1fr_0.8fr_0.8fr] gap-3 border-t border-slate-100 px-3 py-2 text-xs first:border-t-0">
                            <span>{line.accountName}</span>
                            <span className="font-mono">{line.type === 'debit' ? <Money value={line.functionalAmount} currency={functionalCurrency} /> : '—'}</span>
                            <span className="font-mono">{line.type === 'credit' ? <Money value={line.functionalAmount} currency={functionalCurrency} /> : '—'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-amber-700">Enter an amount up to the outstanding balance{activeRecord.currency !== functionalCurrency ? ' and a rate' : ''} to see the calculation.</p>
                  )}
                  <div className="mt-4">
                    <Button size="sm" disabled={documentPending || !paymentPreview} onClick={submitPayment}>
                      {documentPending ? 'Posting…' : 'Post payment'}
                    </Button>
                  </div>
                </div>
              ) : null}

              {activeRecord && activeRecord.payments.length > 0 ? (
                <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200">
                  <div className="grid grid-cols-[1fr_1.2fr_1fr_0.7fr_1fr_1fr] gap-3 bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    <span>Paid on</span><span>Bank</span><span className="text-right">Amount</span><span className="text-right">Rate</span><span className="text-right">In {functionalCurrency}</span><span className="text-right">Realised FX</span>
                  </div>
                  {activeRecord.payments.map((payment) => (
                    <div key={payment.id} className="grid grid-cols-[1fr_1.2fr_1fr_0.7fr_1fr_1fr] gap-3 border-t border-slate-200 px-4 py-2 text-sm text-slate-700">
                      <span>{payment.date}</span>
                      <span className="truncate">{payment.bankAccountName}</span>
                      <span className="text-right font-mono"><Money value={payment.txnAmount} currency={activeRecord.currency} /></span>
                      <span className="text-right font-mono text-xs">{payment.rate}</span>
                      <span className="text-right font-mono"><Money value={payment.bankFunctionalAmount} currency={functionalCurrency} /></span>
                      <span className={['text-right font-mono', payment.gainLoss > 0 ? 'text-emerald-700' : payment.gainLoss < 0 ? 'text-red-700' : ''].join(' ')}>
                        {payment.gainLoss === 0 ? '—' : <Money value={payment.gainLoss} currency={functionalCurrency} />}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="mt-6 rounded-2xl border border-slate-200 bg-white">
                <button
                  type="button"
                  onClick={() => setJournalOpen((current) => !current)}
                  className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-slate-700"
                >
                  <span>{activeRecord?.journal ? `Posted journal · ${activeRecord.journal.postedAt}` : 'Journal preview'}</span>
                  <span>{journalOpen ? 'Hide' : 'Show'}</span>
                </button>

                {journalOpen ? (
                  <div className="border-t border-slate-200 p-4">
                    <div className="overflow-hidden rounded-xl border border-slate-200">
                      <div className="grid grid-cols-[1fr_0.8fr_0.5fr_0.7fr_0.7fr] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                        <span>Account</span>
                        <span className="text-right">Transaction</span>
                        <span className="text-right">Rate</span>
                        <span className="text-right">Money in ({functionalCurrency})</span>
                        <span className="text-right">Money out ({functionalCurrency})</span>
                      </div>

                      {journalEntries.map((entry) => (
                        <div key={`${entry.accountCode}-${entry.type}`} className="grid grid-cols-[1fr_0.8fr_0.5fr_0.7fr_0.7fr] gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-700">
                          <div>{entry.accountName}</div>
                          <div className="text-right font-mono text-slate-600">{entry.currency === functionalCurrency && entry.txnAmount === entry.amount ? '—' : <Money value={entry.txnAmount} currency={entry.currency} />}</div>
                          <div className="text-right font-mono text-xs text-slate-500">{entry.rate === '1.0' ? '—' : entry.rate}</div>
                          <div className="text-right font-mono text-slate-900">{entry.type === 'debit' ? <Money value={entry.amount} currency={functionalCurrency} /> : '—'}</div>
                          <div className="text-right font-mono text-slate-900">{entry.type === 'credit' ? <Money value={entry.amount} currency={functionalCurrency} /> : '—'}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </Card>
          )}
        </main>
      </div>

      {showAddEntityForm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">New entity</p>
                <h2 className="mt-1 text-2xl font-semibold text-slate-900">Add company</h2>
              </div>
              <button
                type="button"
                onClick={() => setShowAddEntityForm(false)}
                className="text-xl text-slate-500 hover:text-slate-700"
              >
                ×
              </button>
            </div>

            <form className="mt-6 space-y-4" onSubmit={handleAddEntity}>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">Company name</label>
                <Input
                  value={formValues.name}
                  onChange={(event) => setFormValues((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Sprouted Foods"
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Type</label>
                  <select
                    value={formValues.type}
                    onChange={(event) =>
                      setFormValues((current) => ({
                        ...current,
                        type: event.target.value as EntityType,
                      }))
                    }
                    className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                  >
                    <option value="manufacturing">Manufacturing</option>
                    <option value="programs">Programs</option>
                  </select>
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Financial year end</label>
                  <Input
                    value={formValues.financialYearEnd}
                    onChange={(event) =>
                      setFormValues((current) => ({ ...current, financialYearEnd: event.target.value }))
                    }
                    placeholder="31 Dec"
                  />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">VAT registration</label>
                  <select
                    value={formValues.vatRegistered ? 'registered' : 'unregistered'}
                    onChange={(event) =>
                      setFormValues((current) => ({
                        ...current,
                        vatRegistered: event.target.value === 'registered',
                      }))
                    }
                    className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                  >
                    <option value="unregistered">Unregistered</option>
                    <option value="registered">Registered</option>
                  </select>
                  {formValues.vatRegistered ? (
                    <div className="mt-2">
                      <label className="mb-1.5 block text-sm font-medium text-slate-700">Registered from</label>
                      <Input
                        type="date"
                        value={formValues.vatRegisteredFrom}
                        onChange={(event) => setFormValues((current) => ({ ...current, vatRegisteredFrom: event.target.value }))}
                      />
                    </div>
                  ) : null}
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">TIN</label>
                  <Input
                    value={formValues.tin}
                    onChange={(event) => setFormValues((current) => ({ ...current, tin: event.target.value }))}
                    placeholder="GH-0004-NEW"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <Button type="button" variant="secondary" onClick={() => setShowAddEntityForm(false)}>
                  Cancel
                </Button>
                <Button type="submit">Create entity</Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {showAddContactForm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Shared contact</p>
                <h2 className="mt-1 text-2xl font-semibold text-slate-900">Add contact</h2>
                {contactFormTarget === 'document' ? (
                  <p className="mt-1 text-sm text-slate-600">
                    It will be selected on the {activeKind === 'bill' ? 'bill' : 'invoice'} you are editing, and available to every company in the group.
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setShowAddContactForm(false)}
                className="text-xl text-slate-500 hover:text-slate-700"
              >
                ×
              </button>
            </div>

            <form className="mt-6 space-y-4" onSubmit={handleAddContact}>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Name</label>
                  <Input
                    value={contactFormValues.name}
                    onChange={(event) =>
                      setContactFormValues((current) => ({ ...current, name: event.target.value }))
                    }
                    placeholder="Akwasi Farms"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Type</label>
                  <select
                    value={contactFormValues.type}
                    onChange={(event) =>
                      setContactFormValues((current) => ({
                        ...current,
                        type: event.target.value as ContactType,
                      }))
                    }
                    className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                  >
                    <option value="customer">Customer</option>
                    <option value="supplier">Supplier</option>
                    <option value="both">Both</option>
                  </select>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Category</label>
                  <select
                    value={contactFormValues.category}
                    onChange={(event) =>
                      setContactFormValues((current) => ({
                        ...current,
                        category: event.target.value as ContactCategory,
                      }))
                    }
                    className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                  >
                    <option value="customer">Customer</option>
                    <option value="supplier">Supplier</option>
                    <option value="farmer">Farmer</option>
                    <option value="group-entity">Group entity</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">TIN</label>
                  <Input
                    value={contactFormValues.tin}
                    onChange={(event) =>
                      setContactFormValues((current) => ({ ...current, tin: event.target.value }))
                    }
                    placeholder="GH-0909-NEW"
                  />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Phone</label>
                  <Input
                    value={contactFormValues.phone}
                    onChange={(event) =>
                      setContactFormValues((current) => ({ ...current, phone: event.target.value }))
                    }
                    placeholder="+233 20 000 0000"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Email</label>
                  <Input
                    value={contactFormValues.email}
                    onChange={(event) =>
                      setContactFormValues((current) => ({ ...current, email: event.target.value }))
                    }
                    placeholder="hello@example.com"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">Address</label>
                <Input
                  value={contactFormValues.address}
                  onChange={(event) =>
                    setContactFormValues((current) => ({ ...current, address: event.target.value }))
                  }
                  placeholder="Accra, Ghana"
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Withholding tax</label>
                  <select
                    value={contactFormValues.withholdingTaxStatus}
                    onChange={(event) =>
                      setContactFormValues((current) => ({
                        ...current,
                        withholdingTaxStatus: event.target.value as WithholdingTaxStatus,
                      }))
                    }
                    className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                  >
                    <option value="none">None</option>
                    <option value="5%">5%</option>
                    <option value="10%">10%</option>
                    <option value="exempt">Exempt</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <Button type="button" variant="secondary" onClick={() => setShowAddContactForm(false)}>
                  Cancel
                </Button>
                <Button type="submit">Create contact</Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
    </CurrencyProvider>
  );
}
