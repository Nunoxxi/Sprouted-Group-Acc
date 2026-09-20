'use client';

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';

const navigationItems = [
  'Dashboard',
  'Sales',
  'Purchases',
  'Bank',
  'Intercompany',
  'Inventory',
  'Reports',
  'Settings',
] as const;

type EntityType = 'manufacturing' | 'programs';

type EntityRecord = {
  id: string;
  name: string;
  type: EntityType;
  financialYearEnd: string;
  vatRegistered: boolean;
  tin: string;
  accent: string;
};

type EntityMetrics = {
  cashPosition: number;
  moneyOwedToUs: number;
  moneyWeOwe: number;
  intercompanyBalance: number;
};

type ContactType = 'customer' | 'supplier' | 'both';
type ContactCategory = 'customer' | 'supplier' | 'farmer' | 'group-entity' | 'other';
type WithholdingTaxStatus = 'none' | '5%' | '10%' | 'exempt';

type ContactRecord = {
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
  balances: Record<string, number>;
};

const accentPalette = ['#2F6F5A', '#A76A27', '#3E6EAC', '#8D4D7B', '#6C7F54', '#B34C4C'];

const defaultEntities: EntityRecord[] = [
  {
    id: 'sprouted-roots',
    name: 'Sprouted Roots',
    type: 'programs',
    financialYearEnd: '31 Dec',
    vatRegistered: true,
    tin: 'GH-0001-ROOTS',
    accent: accentPalette[0],
  },
  {
    id: 'sprouted-crafts',
    name: 'Sprouted Crafts',
    type: 'manufacturing',
    financialYearEnd: '30 Jun',
    vatRegistered: true,
    tin: 'GH-0002-CRAFTS',
    accent: accentPalette[1],
  },
  {
    id: 'oikazi',
    name: 'Oikazi',
    type: 'manufacturing',
    financialYearEnd: '31 Mar',
    vatRegistered: false,
    tin: 'GH-0003-OIKAZI',
    accent: accentPalette[2],
  },
];

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

const defaultContacts: ContactRecord[] = [
  {
    id: 'roots-contact',
    name: 'Sprouted Roots',
    type: 'supplier',
    category: 'group-entity',
    tin: 'GH-0001-ROOTS',
    phone: '+233 20 111 0001',
    email: 'ops@sproutedroots.com',
    address: 'Kumasi, Ghana',
    withholdingTaxStatus: '5%',
    isFarmerAggregator: true,
    balances: {
      'sprouted-roots': 0,
      'sprouted-crafts': -345000,
      'oikazi': 185000,
    },
  },
  {
    id: 'crafts-contact',
    name: 'Sprouted Crafts',
    type: 'supplier',
    category: 'group-entity',
    tin: 'GH-0002-CRAFTS',
    phone: '+233 20 111 0002',
    email: 'ops@sproutedcrafts.com',
    address: 'Accra, Ghana',
    withholdingTaxStatus: '5%',
    isFarmerAggregator: false,
    balances: {
      'sprouted-roots': 245000,
      'sprouted-crafts': 0,
      'oikazi': -68000,
    },
  },
  {
    id: 'oikazi-contact',
    name: 'Oikazi',
    type: 'supplier',
    category: 'group-entity',
    tin: 'GH-0003-OIKAZI',
    phone: '+233 20 111 0003',
    email: 'ops@oikazi.com',
    address: 'Tema, Ghana',
    withholdingTaxStatus: '10%',
    isFarmerAggregator: false,
    balances: {
      'sprouted-roots': -118000,
      'sprouted-crafts': 42000,
      'oikazi': 0,
    },
  },
  {
    id: 'nana-farmers',
    name: 'Nana Akua Farms',
    type: 'supplier',
    category: 'farmer',
    tin: 'GH-0101-NAF',
    phone: '+233 20 555 0140',
    email: 'nana@farms.gh',
    address: 'Bia, Western North',
    withholdingTaxStatus: '5%',
    isFarmerAggregator: true,
    balances: {
      'sprouted-roots': 520000,
      'sprouted-crafts': 160000,
      'oikazi': 70000,
    },
  },
  {
    id: 'cocoa-partners',
    name: 'Cocoa Partners Limited',
    type: 'both',
    category: 'customer',
    tin: 'GH-0204-CPL',
    phone: '+233 20 555 0999',
    email: 'sales@cocoapartners.gh',
    address: 'Tema, Ghana',
    withholdingTaxStatus: 'exempt',
    isFarmerAggregator: false,
    balances: {
      'sprouted-roots': 160000,
      'sprouted-crafts': 280000,
      'oikazi': 340000,
    },
  },
];

const defaultFormValues = {
  name: '',
  type: 'manufacturing' as EntityType,
  financialYearEnd: '31 Dec',
  vatRegistered: true,
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
};

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'new-entity';
}

type VATTreatment = 'standard' | 'zero-rated' | 'exempt';
type DocumentStatus = 'draft' | 'awaiting-payment' | 'paid' | 'voided';

type DocumentLine = {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  accountCode: string;
  vatTreatment: VATTreatment;
};

type DocumentFormState = {
  docNumber: string;
  contactId: string;
  date: string;
  dueDate: string;
  status: DocumentStatus;
  lines: DocumentLine[];
};

type JournalEntry = {
  accountCode: string;
  accountName: string;
  amount: number;
  type: 'debit' | 'credit';
};

const documentAccountOptions = [
  '1010',
  '1101',
  '1102',
  '1103',
  '2001',
  '2020',
  '2025',
  '2030',
  '2035',
  '4001',
  '4005',
  '5001',
  '5010',
  '6001',
  '6005',
  '6010',
];

const accountNames: Record<string, string> = {
  '1010': 'Trade Receivables',
  '1101': 'VAT Input Tax Recoverable',
  '1102': 'NHIL Input Tax Recoverable',
  '1103': 'GETFund Input Tax Recoverable',
  '2001': 'Trade Payables',
  '2020': 'VAT Output Tax Payable',
  '2025': 'NHIL Payable',
  '2030': 'GETFund Payable',
  '2035': 'Withholding Tax Payable',
  '4001': 'Domestic Sales',
  '4005': 'Export Sales',
  '5001': 'Raw Materials Used',
  '5010': 'Production Labour Allocation',
  '6001': 'Factory Utilities',
  '6005': 'Factory Repairs & Maintenance',
  '6010': 'Production Salaries',
};

function makeLine(): DocumentLine {
  return {
    id: `line-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    description: '',
    quantity: 1,
    unitPrice: 0,
    accountCode: '4001',
    vatTreatment: 'standard',
  };
}

function makeDocument(kind: 'invoice' | 'bill'): DocumentFormState {
  const prefix = kind === 'invoice' ? 'INV' : 'BILL';
  const today = new Date().toISOString().slice(0, 10);

  return {
    docNumber: `${prefix}-${String(Date.now()).slice(-4)}`,
    contactId: defaultContacts[0]?.id ?? 'nana-farmers',
    date: today,
    dueDate: today,
    status: 'draft',
    lines: [makeLine()],
  };
}

function lineTaxBreakdown(line: DocumentLine) {
  const base = line.quantity * line.unitPrice;

  if (line.vatTreatment === 'zero-rated' || line.vatTreatment === 'exempt') {
    return {
      base,
      vat: 0,
      nhil: 0,
      getFund: 0,
      totalTax: 0,
      totalInclTax: base,
    };
  }

  const vat = base * 0.15;
  const nhil = base * 0.025;
  const getFund = base * 0.025;
  const totalTax = vat + nhil + getFund;

  return {
    base,
    vat,
    nhil,
    getFund,
    totalTax,
    totalInclTax: base + totalTax,
  };
}

function buildTotals(lines: DocumentLine[], withholdingTaxStatus?: WithholdingTaxStatus) {
  const lineSummaries = lines.map(lineTaxBreakdown);
  const subtotal = lineSummaries.reduce((sum, line) => sum + line.base, 0);
  const vat = lineSummaries.reduce((sum, line) => sum + line.vat, 0);
  const nhil = lineSummaries.reduce((sum, line) => sum + line.nhil, 0);
  const getFund = lineSummaries.reduce((sum, line) => sum + line.getFund, 0);
  const totalTax = vat + nhil + getFund;
  const total = subtotal + totalTax;

  const withheldRate =
    withholdingTaxStatus === '5%' ? 0.05 : withholdingTaxStatus === '10%' ? 0.1 : 0;

  const withholdingTax = withheldRate > 0 ? total * withheldRate : 0;
  const netPayable = Math.max(total - withholdingTax, 0);

  return {
    subtotal,
    vat,
    nhil,
    getFund,
    totalTax,
    total,
    withholdingTax,
    netPayable,
  };
}

function buildJournalEntries(documentState: DocumentFormState, isPurchase: boolean, contact?: ContactRecord) {
  const totals = buildTotals(documentState.lines, isPurchase ? contact?.withholdingTaxStatus : undefined);
  const groupedEntries: JournalEntry[] = [];

  if (!documentState.lines.length) {
    return groupedEntries;
  }

  if (!isPurchase) {
    groupedEntries.push({
      accountCode: '1010',
      accountName: accountNames['1010'],
      amount: totals.total,
      type: 'debit',
    });

    const revenueAccounts = documentState.lines.reduce(
      (accumulator, line) => {
        const summary = lineTaxBreakdown(line);
        const existing = accumulator[line.accountCode] ?? 0;
        accumulator[line.accountCode] = existing + summary.base;
        return accumulator;
      },
      {} as Record<string, number>,
    );

    Object.entries(revenueAccounts).forEach(([accountCode, amount]) => {
      groupedEntries.push({
        accountCode,
        accountName: accountNames[accountCode] ?? 'Revenue',
        amount,
        type: 'credit',
      });
    });

    groupedEntries.push({
      accountCode: '2020',
      accountName: accountNames['2020'],
      amount: totals.vat,
      type: 'credit',
    });
    groupedEntries.push({
      accountCode: '2025',
      accountName: accountNames['2025'],
      amount: totals.nhil,
      type: 'credit',
    });
    groupedEntries.push({
      accountCode: '2030',
      accountName: accountNames['2030'],
      amount: totals.getFund,
      type: 'credit',
    });
  } else {
    const purchaseAccounts = documentState.lines.reduce(
      (accumulator, line) => {
        const summary = lineTaxBreakdown(line);
        const existing = accumulator[line.accountCode] ?? 0;
        accumulator[line.accountCode] = existing + summary.base;
        return accumulator;
      },
      {} as Record<string, number>,
    );

    Object.entries(purchaseAccounts).forEach(([accountCode, amount]) => {
      groupedEntries.push({
        accountCode,
        accountName: accountNames[accountCode] ?? 'Expense',
        amount,
        type: 'debit',
      });
    });

    groupedEntries.push({
      accountCode: '1101',
      accountName: accountNames['1101'],
      amount: totals.vat,
      type: 'debit',
    });
    groupedEntries.push({
      accountCode: '1102',
      accountName: accountNames['1102'],
      amount: totals.nhil,
      type: 'debit',
    });
    groupedEntries.push({
      accountCode: '1103',
      accountName: accountNames['1103'],
      amount: totals.getFund,
      type: 'debit',
    });

    groupedEntries.push({
      accountCode: '2001',
      accountName: accountNames['2001'],
      amount: Math.max(totals.total - totals.withholdingTax, 0),
      type: 'credit',
    });

    if (totals.withholdingTax > 0) {
      groupedEntries.push({
        accountCode: '2035',
        accountName: accountNames['2035'],
        amount: totals.withholdingTax,
        type: 'credit',
      });
    }
  }

  return groupedEntries;
}

export function AppShell() {
  const [entities, setEntities] = useState<EntityRecord[]>(defaultEntities);
  const [selectedEntityId, setSelectedEntityId] = useState(defaultEntities[0].id);
  const [activeNav, setActiveNav] = useState<(typeof navigationItems)[number]>('Dashboard');
  const [entityMenuOpen, setEntityMenuOpen] = useState(false);
  const [showAddEntityForm, setShowAddEntityForm] = useState(false);
  const [showAddContactForm, setShowAddContactForm] = useState(false);
  const [formValues, setFormValues] = useState(defaultFormValues);
  const [contacts, setContacts] = useState<ContactRecord[]>(defaultContacts);
  const [contactFormValues, setContactFormValues] = useState({
    name: '',
    type: 'supplier' as ContactType,
    category: 'other' as ContactCategory,
    tin: '',
    phone: '',
    email: '',
    address: '',
    withholdingTaxStatus: 'none' as WithholdingTaxStatus,
    isFarmerAggregator: false,
  });
  const [salesDocument, setSalesDocument] = useState<DocumentFormState>(() => makeDocument('invoice'));
  const [purchaseDocument, setPurchaseDocument] = useState<DocumentFormState>(() => makeDocument('bill'));
  const [journalOpen, setJournalOpen] = useState(true);
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

  const [intercompanyForm, setIntercompanyForm] = useState({
    reference: `IC-${Date.now().toString().slice(-4)}`,
    date: new Date().toISOString().slice(0, 10),
    fromEntityId: defaultEntities[0].id,
    toEntityId: defaultEntities[1].id,
    amount: 0,
    description: 'Raw material supply',
  });

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

  const entityContacts = useMemo(
    () =>
      contacts.filter((contact) => {
        const hasSelectedEntityBalance = contact.balances[selectedEntity.id] !== undefined;
        const isSupplierVisible = contact.type === 'supplier' || contact.type === 'both';
        const isGroupEntityVisible = contact.category === 'group-entity' && contact.balances[selectedEntity.id] !== undefined;
        return hasSelectedEntityBalance && (isSupplierVisible || isGroupEntityVisible || contact.category === 'customer');
      }),
    [contacts, selectedEntity.id],
  );

  const activeDocument = activeNav === 'Sales' ? salesDocument : purchaseDocument;
  const isPurchaseView = activeNav === 'Purchases';
  const activeContact = entityContacts.find((contact) => contact.id === activeDocument.contactId) ?? entityContacts[0] ?? defaultContacts[0];
  const activeTotals = buildTotals(activeDocument.lines, isPurchaseView ? activeContact.withholdingTaxStatus : undefined);
  const journalEntries = buildJournalEntries(activeDocument, isPurchaseView, activeContact);
  const groupEntityOptions = entities;

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

    intercompanyTransactions.forEach((transaction) => {
      const forwardKey = `${transaction.fromEntityId}->${transaction.toEntityId}`;
      const reverseKey = `${transaction.toEntityId}->${transaction.fromEntityId}`;
      const forward = matrix.get(forwardKey);
      const reverse = matrix.get(reverseKey);

      if (!forward || !reverse) {
        return;
      }

      if (transaction.direction === 'sale') {
        forward.balance += transaction.amount;
        reverse.mirroredBalance -= transaction.amount;
      } else {
        forward.balance -= transaction.amount;
        reverse.mirroredBalance += transaction.amount;
      }
    });

    matrix.forEach((cell) => {
      cell.mismatch = Math.abs(cell.balance + cell.mirroredBalance) > 0.01;
    });

    return matrix;
  }, [entities, intercompanyTransactions]);

  const intercompanyMismatchCount = useMemo(
    () => Array.from(intercompanyBalances.values()).filter((cell) => cell.mismatch).length,
    [intercompanyBalances],
  );

  useEffect(() => {
    const key = `sprouted-${selectedEntity.id}-${activeNav.toLowerCase()}-document`;
    const stringValue = localStorage.getItem(key);

    if (!stringValue) {
      return;
    }

    try {
      const parsed = JSON.parse(stringValue) as DocumentFormState;
      if (activeNav === 'Sales') {
        setSalesDocument(parsed);
      } else if (activeNav === 'Purchases') {
        setPurchaseDocument(parsed);
      }
    } catch {
      // ignore invalid storage payloads and keep the fresh default form
    }
  }, [activeNav, selectedEntity.id]);

  useEffect(() => {
    const key = `sprouted-${selectedEntity.id}-${activeNav.toLowerCase()}-document`;
    const timer = window.setTimeout(() => {
      localStorage.setItem(key, JSON.stringify(activeDocument));
    }, 2500);

    return () => window.clearTimeout(timer);
  }, [activeDocument, activeNav, selectedEntity.id]);

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

    const nextEntity: EntityRecord = {
      id: `${slugify(trimmedName)}-${Date.now()}`,
      name: trimmedName,
      type: formValues.type,
      financialYearEnd: formValues.financialYearEnd,
      vatRegistered: formValues.vatRegistered,
      tin: formValues.tin.trim() || 'TIN pending',
      accent: accentPalette[entities.length % accentPalette.length],
    };

    setEntities((previous) => [...previous, nextEntity]);
    setSelectedEntityId(nextEntity.id);
    setActiveNav('Dashboard');
    setShowAddEntityForm(false);
    setFormValues(defaultFormValues);
    setEntityMenuOpen(false);

    setContacts((previous) => {
      const groupBalances = Object.fromEntries(
        [...entities, nextEntity].map((entity) => [entity.id, 0]),
      );

      const nextGroupContact: ContactRecord = {
        id: `${slugify(trimmedName)}-group`,
        name: trimmedName,
        type: 'supplier',
        category: 'group-entity',
        tin: formValues.tin.trim() || 'TIN pending',
        phone: '',
        email: '',
        address: '',
        withholdingTaxStatus: '5%',
        isFarmerAggregator: false,
        balances: groupBalances,
      };

      return [...previous, nextGroupContact];
    });
  }

  function handleAddContact(event: FormEvent) {
    event.preventDefault();

    const trimmedName = contactFormValues.name.trim();
    if (!trimmedName) {
      return;
    }

    const nextContact: ContactRecord = {
      id: `${slugify(trimmedName)}-${Date.now()}`,
      name: trimmedName,
      type: contactFormValues.type,
      category: contactFormValues.category,
      tin: contactFormValues.tin.trim() || 'TIN pending',
      phone: contactFormValues.phone.trim(),
      email: contactFormValues.email.trim(),
      address: contactFormValues.address.trim(),
      withholdingTaxStatus: contactFormValues.withholdingTaxStatus,
      isFarmerAggregator: contactFormValues.isFarmerAggregator,
      balances: Object.fromEntries(
        entities.map((entity) => [entity.id, 0]),
      ),
    };

    setContacts((previous) => [...previous, nextContact]);
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
      isFarmerAggregator: false,
    });
  }

  function updateCurrentDocument(patch: Partial<DocumentFormState>) {
    if (activeNav === 'Sales') {
      setSalesDocument((current) => ({ ...current, ...patch }));
      return;
    }

    setPurchaseDocument((current) => ({ ...current, ...patch }));
  }

  function updateLine(lineId: string, patch: Partial<DocumentLine>) {
    const setter = activeNav === 'Sales' ? setSalesDocument : setPurchaseDocument;
    setter((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.id === lineId ? { ...line, ...patch } : line)),
    }));
  }

  function addLine() {
    const setter = activeNav === 'Sales' ? setSalesDocument : setPurchaseDocument;
    setter((current) => ({ ...current, lines: [...current.lines, makeLine()] }));
  }

  function removeLine(lineId: string) {
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

    const reference = intercompanyForm.reference.trim() || `IC-${Date.now().toString().slice(-4)}`;
    const documentLabelFrom = `INV-${reference}`;
    const documentLabelTo = `BILL-${reference}`;

    const nextTransaction: IntercompanyTransaction = {
      id: `${reference.toLowerCase()}-${Date.now()}`,
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
    setIntercompanyForm((current) => ({
      ...current,
      reference: `IC-${Date.now().toString().slice(-4)}`,
      amount: 0,
      description: 'Raw material supply',
    }));
  }

  const documentTitle = isPurchaseView ? 'Purchase bill' : 'Sales invoice';

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

  const bankDocuments = [
    { id: 'INV-1042', type: 'invoice' as const, contact: 'Cocoa Partners Limited', amount: 182500, date: '2026-09-10', reference: 'INV-1042' },
    { id: 'INV-1044', type: 'invoice' as const, contact: 'Nana Akua Farms', amount: 96000, date: '2026-09-11', reference: 'INV-1044' },
    { id: 'BILL-2198', type: 'bill' as const, contact: 'Sprouted Roots', amount: 128400, date: '2026-09-09', reference: 'BILL-2198' },
    { id: 'BILL-2201', type: 'bill' as const, contact: 'Akwasi Logistics', amount: 45600, date: '2026-09-12', reference: 'BILL-2201' },
    { id: 'INV-1046', type: 'invoice' as const, contact: 'Cocoa Partners Limited', amount: 245000, date: '2026-09-13', reference: 'INV-1046' },
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

  function normalizeForMatch(value: string) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

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
  const selectedSuggestions = selectedBankLine ? getSuggestionsForBankLine(selectedBankLine) : [];
  const unreconciledCount = bankLines.filter((line) => line.status === 'unreconciled').length;

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem('sprouted-bank-mappings', JSON.stringify(bankMappings));
  }, [bankMappings]);

  useEffect(() => {
    if (selectedBankIndex > bankLines.length - 1) {
      setSelectedBankIndex(Math.max(bankLines.length - 1, 0));
    }
  }, [bankLines.length, selectedBankIndex]);

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
  }

  function undoBankMatch(lineId: string) {
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
  }

  function codeBankLineToAccount(lineId: string, accountCode: string) {
    const account = bankAccountOptions.find((entry) => entry.code === accountCode) ?? bankAccountOptions[0];

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
            </div>
          ) : null}
        </div>

        <nav className="mt-6 space-y-1">
          {navigationItems.map((item) => {
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

              <Card className="rounded-2xl">
                <div className="flex items-start justify-between gap-4 pb-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Shared contacts</p>
                    <h2 className="mt-1 text-xl font-semibold text-slate-900">Contacts</h2>
                  </div>
                  <Button size="sm" onClick={() => setShowAddContactForm(true)}>Add contact</Button>
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
                        <div><span className="font-medium text-slate-700">Phone:</span> {contact.phone || '—'}</div>
                        <div><span className="font-medium text-slate-700">Email:</span> {contact.email || '—'}</div>
                        <div><span className="font-medium text-slate-700">WHT:</span> {contact.withholdingTaxStatus}</div>
                        {contact.isFarmerAggregator ? (
                          <div className="font-medium text-emerald-700">Farmer / aggregation buyer</div>
                        ) : null}
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
                        <button
                          key={line.id}
                          type="button"
                          onClick={() => setSelectedBankIndex(index)}
                          className={[
                            'w-full rounded-2xl border p-3 text-left transition-colors duration-150 ease-out',
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
                        </button>
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
                        <label className="mb-1.5 block text-sm font-medium text-slate-700">Amount</label>
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          value={intercompanyForm.amount}
                          onChange={(event) => setIntercompanyForm((current) => ({ ...current, amount: Number(event.target.value) || 0 }))}
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
                                    <Money value={cell?.balance ?? 0} />
                                  </div>
                                  <div className="mt-1 text-[11px] text-slate-500">
                                    Mirror: <Money value={cell?.mirroredBalance ?? 0} />
                                  </div>
                                  {cell?.mismatch ? (
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
                                    <span>Debit</span>
                                    <span>Credit</span>
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
          ) : (
            <Card className="rounded-2xl">
              <div className="border-b border-slate-200 pb-4">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{isPurchaseView ? 'Purchase' : 'Sales'}</p>
                    <h2 className="mt-1 text-2xl font-semibold text-slate-900">{documentTitle}</h2>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => updateCurrentDocument({ status: 'draft' })}>Draft</Button>
                    <Button variant="secondary" size="sm" onClick={() => updateCurrentDocument({ status: 'awaiting-payment' })}>Awaiting payment</Button>
                    <Button size="sm" onClick={() => updateCurrentDocument({ status: isPurchaseView ? 'paid' : 'paid' })}>Mark paid</Button>
                    <Button variant="danger" size="sm" onClick={() => updateCurrentDocument({ status: 'voided' })}>Void</Button>
                  </div>
                </div>
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Document no.</label>
                  <Input
                    value={activeDocument.docNumber}
                    onChange={(event) => updateCurrentDocument({ docNumber: event.target.value })}
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Contact</label>
                  <select
                    value={activeDocument.contactId}
                    onChange={(event) => updateCurrentDocument({ contactId: event.target.value })}
                    className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                  >
                    {entityContacts.map((contact) => (
                      <option key={contact.id} value={contact.id}>{contact.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Date</label>
                  <Input
                    type="date"
                    value={activeDocument.date}
                    onChange={(event) => updateCurrentDocument({ date: event.target.value })}
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Due date</label>
                  <Input
                    type="date"
                    value={activeDocument.dueDate}
                    onChange={(event) => updateCurrentDocument({ dueDate: event.target.value })}
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Status</label>
                  <select
                    value={activeDocument.status}
                    onChange={(event) => updateCurrentDocument({ status: event.target.value as DocumentStatus })}
                    className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                  >
                    <option value="draft">Draft</option>
                    <option value="awaiting-payment">Awaiting payment</option>
                    <option value="paid">Paid</option>
                    <option value="voided">Voided</option>
                  </select>
                </div>
              </div>

              <div className="mt-6 rounded-2xl border border-slate-200 overflow-hidden">
                <div className="grid grid-cols-[1.6fr_0.7fr_0.9fr_1fr_1.1fr_56px] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                  <span>Description</span>
                  <span>Qty</span>
                  <span>Unit price</span>
                  <span>Account</span>
                  <span>VAT</span>
                  <span />
                </div>

                {activeDocument.lines.map((line) => (
                  <div key={line.id} className="grid grid-cols-[1.6fr_0.7fr_0.9fr_1fr_1.1fr_56px] gap-3 border-t border-slate-200 px-4 py-3">
                    <Input
                      value={line.description}
                      onChange={(event) => updateLine(line.id, { description: event.target.value })}
                      placeholder="Cashew bags"
                    />
                    <Input
                      type="number"
                      min={0}
                      step="1"
                      value={line.quantity}
                      onChange={(event) => updateLine(line.id, { quantity: Number(event.target.value) || 0 })}
                    />
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.unitPrice}
                      onChange={(event) => updateLine(line.id, { unitPrice: Number(event.target.value) || 0 })}
                    />
                    <select
                      value={line.accountCode}
                      onChange={(event) => updateLine(line.id, { accountCode: event.target.value })}
                      className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                    >
                      {documentAccountOptions.map((accountCode) => (
                        <option key={accountCode} value={accountCode}>{accountCode}</option>
                      ))}
                    </select>
                    <select
                      value={line.vatTreatment}
                      onChange={(event) =>
                        updateLine(line.id, { vatTreatment: event.target.value as VATTreatment })
                      }
                      className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                    >
                      <option value="standard">Standard 20%</option>
                      <option value="zero-rated">Zero-rated</option>
                      <option value="exempt">Exempt</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => removeLine(line.id)}
                      className="text-slate-400 hover:text-red-600"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex justify-end">
                <Button variant="secondary" size="sm" onClick={addLine}>Add line</Button>
              </div>

              <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_320px]">
                <div className="space-y-3">
                  {isPurchaseView && activeContact ? (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Supplier details</div>
                      <div className="mt-2 space-y-1 text-sm text-slate-700">
                        <div><span className="font-medium text-slate-900">{activeContact.name}</span></div>
                        <div>TIN: {activeContact.tin}</div>
                        <div>WHT status: {activeContact.withholdingTaxStatus}</div>
                        {activeContact.isFarmerAggregator ? <div>Farmer / aggregation buyer</div> : null}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="space-y-2 text-sm text-slate-700">
                    <div className="flex items-center justify-between">
                      <span>Subtotal</span>
                      <span className="font-mono text-slate-900"><Money value={activeTotals.subtotal} /></span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>VAT (15%)</span>
                      <span className="font-mono text-slate-900"><Money value={activeTotals.vat} /></span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>NHIL (2.5%)</span>
                      <span className="font-mono text-slate-900"><Money value={activeTotals.nhil} /></span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>GETFund (2.5%)</span>
                      <span className="font-mono text-slate-900"><Money value={activeTotals.getFund} /></span>
                    </div>
                    <div className="flex items-center justify-between border-t border-slate-200 pt-2 text-base font-semibold text-slate-900">
                      <span>Total</span>
                      <span className="font-mono"><Money value={activeTotals.total} /></span>
                    </div>
                    {isPurchaseView ? (
                      <>
                        <div className="flex items-center justify-between border-t border-slate-200 pt-2">
                          <span>Withholding tax</span>
                          <span className="font-mono text-slate-900"><Money value={activeTotals.withholdingTax} /></span>
                        </div>
                        <div className="flex items-center justify-between text-base font-semibold text-slate-900">
                          <span>Net payable</span>
                          <span className="font-mono"><Money value={activeTotals.netPayable} /></span>
                        </div>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="mt-6 rounded-2xl border border-slate-200 bg-white">
                <button
                  type="button"
                  onClick={() => setJournalOpen((current) => !current)}
                  className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-slate-700"
                >
                  <span>Journal entry</span>
                  <span>{journalOpen ? 'Hide' : 'Show'}</span>
                </button>

                {journalOpen ? (
                  <div className="border-t border-slate-200 p-4">
                    <div className="overflow-hidden rounded-xl border border-slate-200">
                      <div className="grid grid-cols-[1fr_0.7fr_0.7fr] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                        <span>Account</span>
                        <span>Debit</span>
                        <span>Credit</span>
                      </div>

                      {journalEntries.map((entry) => (
                        <div key={`${entry.accountCode}-${entry.type}`} className="grid grid-cols-[1fr_0.7fr_0.7fr] gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-700">
                          <div>{entry.accountName}</div>
                          <div className="font-mono text-slate-900">{entry.type === 'debit' ? <Money value={entry.amount} /> : '—'}</div>
                          <div className="font-mono text-slate-900">{entry.type === 'credit' ? <Money value={entry.amount} /> : '—'}</div>
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
                    <option value="registered">Registered</option>
                    <option value="unregistered">Unregistered</option>
                  </select>
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

                <div className="flex items-end pb-1.5">
                  <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={contactFormValues.isFarmerAggregator}
                      onChange={(event) =>
                        setContactFormValues((current) => ({
                          ...current,
                          isFarmerAggregator: event.target.checked,
                        }))
                      }
                    />
                    Farmer / aggregation flag
                  </label>
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
  );
}
