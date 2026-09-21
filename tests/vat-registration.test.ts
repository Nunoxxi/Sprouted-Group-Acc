/**
 * VAT is dormant but ready. These tests switch registration on for one
 * entity and prove that its invoices carry VAT from the registration date
 * onward, while the other two entities are completely unchanged — same
 * totals, same journals, same accounts, to the pesewa.
 *
 * Everything here is the pure logic the server function and the editor both
 * call: documentTaxFor decides the regime from the entity and the date;
 * buildTotals and journalLinesFor apply it. No database.
 */

import { describe, expect, it } from 'vitest';

import { journalEntriesBalance } from '@/lib/accounting-integrity';
import type { EntityRecord } from '@/lib/data/types';
import {
  buildJournalEntries,
  buildTotals,
  controlAccounts,
  documentTaxFor,
  journalLinesFor,
  makeDocument,
  makeLine,
  taxableSuppliesOf,
  type DocumentFormState,
  type JournalLineDraft,
} from '@/lib/documents';
import {
  leviesOnBase,
  rollingTaxableTurnover,
  rollingWindowStart,
  splitImportLevies,
  thresholdStatus,
  vatAppliesOn,
  VAT_REGISTRATION_THRESHOLD_MINOR,
} from '@/lib/ghana-tax';
import { seedEntities } from '@/lib/seed-data';

// --- fixtures --------------------------------------------------------------------

/** The three entities as seeded: none registered. */
function group(): Record<string, EntityRecord> {
  return Object.fromEntries(seedEntities.map((entity) => [entity.id, { ...entity }]));
}

const REGISTRATION_DATE = '2026-10-01';

/** Switch one entity on from a date; the returned group shares nothing with the input. */
function registered(entities: Record<string, EntityRecord>, entityId: string, from: string): Record<string, EntityRecord> {
  const copy = Object.fromEntries(Object.entries(entities).map(([id, entity]) => [id, { ...entity }]));
  copy[entityId] = { ...copy[entityId], vatRegistered: true, vatRegisteredFrom: from };
  return copy;
}

function invoice(date: string, lines: { base: number; account?: string; treatment?: 'standard' | 'zero-rated' | 'exempt' }[], saleType: 'domestic' | 'export' = 'domestic'): DocumentFormState {
  const form = makeDocument('invoice', 'customer');
  form.date = date;
  form.saleType = saleType;
  form.lines = lines.map((line, index) => ({
    ...makeLine('invoice'),
    id: `l${index}`,
    quantity: 1,
    unitPrice: line.base,
    accountCode: line.account ?? '4001',
    vatTreatment: line.treatment ?? 'standard',
  }));
  return form;
}

function bill(date: string, base: number, importVat = 0, account = '5001'): DocumentFormState {
  const form = makeDocument('bill', 'supplier');
  form.date = date;
  form.importVat = importVat;
  form.lines = [{ ...makeLine('bill'), id: 'l0', quantity: 1, unitPrice: base, accountCode: account, vatTreatment: 'standard' }];
  return form;
}

/** Post a document for an entity exactly as the server function does: regime from entity + date. */
function post(entity: EntityRecord, form: DocumentFormState, wht?: '5%' | '10%') {
  const isPurchase = form.kind === 'bill';
  const tax = documentTaxFor(entity, form.date);
  const totals = buildTotals(form, isPurchase ? wht : undefined, tax);
  const lines = journalLinesFor(form, isPurchase, wht ? { withholdingTaxStatus: wht } : undefined, {}, tax);
  return { tax, totals, lines };
}

function amount(lines: JournalLineDraft[], code: string): number {
  return lines.filter((line) => line.accountCode === code).reduce((sum, line) => sum + line.amount, 0);
}

const balanced = (lines: JournalLineDraft[]) => journalEntriesBalance([{ entityId: 'x', lines }]);

// A month of trading, the same for every entity, straddling the registration date.
const trading = [
  invoice('2026-09-15', [{ base: 100000 }]),
  invoice('2026-09-30', [{ base: 250000 }, { base: 50000, treatment: 'exempt' }]),
  invoice('2026-10-01', [{ base: 100000 }]),
  invoice('2026-10-20', [{ base: 333333 }, { base: 12345, treatment: 'zero-rated' }]),
  invoice('2026-11-02', [{ base: 99999 }], 'export'),
];

// --- the registration date ------------------------------------------------------------

describe('vatAppliesOn', () => {
  it('is off for every seeded entity', () => {
    for (const entity of seedEntities) {
      expect(entity.vatRegistered).toBe(false);
      expect(vatAppliesOn(entity, '2026-09-21')).toBe(false);
      expect(vatAppliesOn(entity, '2099-12-31')).toBe(false);
    }
  });

  it('applies from the registration date onward, never before', () => {
    const entity = { vatRegistered: true, vatRegisteredFrom: REGISTRATION_DATE };
    expect(vatAppliesOn(entity, '2026-09-30')).toBe(false);
    expect(vatAppliesOn(entity, '2026-10-01')).toBe(true);
    expect(vatAppliesOn(entity, '2027-01-01')).toBe(true);
  });

  it('a registered flag without a date applies nothing (fail closed)', () => {
    expect(vatAppliesOn({ vatRegistered: true, vatRegisteredFrom: null }, '2026-12-01')).toBe(false);
  });
});

// --- the required proof ---------------------------------------------------------------

describe('switching VAT on for Sprouted Crafts only', () => {
  const before = group();
  const after = registered(before, 'sprouted-crafts', REGISTRATION_DATE);

  it('Crafts invoices dated on or after the registration date carry 15% + 2.5% + 2.5% on the same base', () => {
    const crafts = after['sprouted-crafts'];

    for (const form of trading.filter((f) => f.date >= REGISTRATION_DATE && f.saleType === 'domestic')) {
      const { tax, totals, lines } = post(crafts, form);
      expect(tax.vatApplies).toBe(true);

      // Levies per line, rounded independently, summed — exactly the statutory rule.
      const expected = form.lines.map((line) => leviesOnBase(line.unitPrice, line.vatTreatment));
      const sum = (key: 'vat' | 'nhil' | 'getFund') => expected.reduce((s, e) => s + e[key], 0);
      expect(totals.vat).toBe(sum('vat'));
      expect(totals.nhil).toBe(sum('nhil'));
      expect(totals.getFund).toBe(sum('getFund'));
      expect(totals.total).toBe(totals.subtotal + totals.vat + totals.nhil + totals.getFund);

      // The journal carries the levies to the three output accounts, and balances.
      expect(amount(lines, controlAccounts.vatOutput)).toBe(totals.vat);
      expect(amount(lines, controlAccounts.nhilOutput)).toBe(totals.nhil);
      expect(amount(lines, controlAccounts.getFundOutput)).toBe(totals.getFund);
      expect(amount(lines, controlAccounts.receivables)).toBe(totals.total);
      expect(balanced(lines)).toBe(true);
    }

    // Concretely: GH₵1,000.00 standard-rated → 150.00 + 25.00 + 25.00, total 1,200.00.
    const oneThousand = post(crafts, invoice('2026-10-01', [{ base: 100000 }]));
    expect(oneThousand.totals).toMatchObject({ subtotal: 100000, vat: 15000, nhil: 2500, getFund: 2500, total: 120000 });
    // And an awkward base is rounded per levy, not carved out of 20%.
    const awkward = post(crafts, invoice('2026-10-20', [{ base: 333333 }]));
    expect(awkward.totals).toMatchObject({ vat: 50000, nhil: 8333, getFund: 8333, total: 399999 });
  });

  it('Crafts invoices dated before the registration date are unchanged — never retrospective', () => {
    const craftsBefore = before['sprouted-crafts'];
    const craftsAfter = after['sprouted-crafts'];

    for (const form of trading.filter((f) => f.date < REGISTRATION_DATE)) {
      const was = post(craftsBefore, form);
      const now = post(craftsAfter, form);
      expect(now.tax.vatApplies).toBe(false);
      expect(now.totals).toEqual(was.totals);
      expect(now.lines).toEqual(was.lines);
      expect(now.totals.totalTax).toBe(0);
      expect(now.lines.some((line) => [controlAccounts.vatOutput, controlAccounts.nhilOutput, controlAccounts.getFundOutput].includes(line.accountCode as never))).toBe(false);
    }
  });

  it('Sprouted Roots and Oikazi are completely unchanged: same totals, same journals, before and after', () => {
    for (const entityId of ['sprouted-roots', 'oikazi']) {
      expect(after[entityId]).toEqual(before[entityId]);

      for (const form of trading) {
        const was = post(before[entityId], form);
        const now = post(after[entityId], form);

        expect(now.tax).toEqual({ vatApplies: false });
        expect(now.totals).toEqual(was.totals);
        expect(now.lines).toEqual(was.lines);

        // And what those journals are: gross to receivables, gross to revenue, nothing else.
        expect(now.totals.totalTax).toBe(0);
        expect(now.totals.total).toBe(now.totals.subtotal);
        expect(now.lines.map((line) => line.accountCode).sort()).toEqual([controlAccounts.receivables, '4001'].sort());
        expect(balanced(now.lines)).toBe(true);
      }
    }
  });

  it('the same invoice on the same day differs between Crafts and the others only by the levies', () => {
    const form = invoice('2026-10-15', [{ base: 100000 }]);
    const crafts = post(after['sprouted-crafts'], form);
    const roots = post(after['sprouted-roots'], form);
    const oikazi = post(after['oikazi'], form);

    expect(roots.totals).toEqual(oikazi.totals);
    expect(roots.totals.total).toBe(100000);
    expect(crafts.totals.total).toBe(120000);
    expect(crafts.totals.total - roots.totals.total).toBe(crafts.totals.totalTax);
    expect(amount(crafts.lines, '4001')).toBe(amount(roots.lines, '4001'));
  });

  it('the editor preview shows no VAT lines at all for an unregistered entity — not even zero ones', () => {
    const form = invoice('2026-10-15', [{ base: 100000 }]);
    const preview = buildJournalEntries(form, false, undefined, {}, documentTaxFor(after['oikazi'], form.date));
    expect(preview).toHaveLength(2);
    const registeredPreview = buildJournalEntries(form, false, undefined, {}, documentTaxFor(after['sprouted-crafts'], form.date));
    expect(registeredPreview).toHaveLength(5);
  });
});

// --- exports ------------------------------------------------------------------------------

describe('export sales', () => {
  const crafts = registered(group(), 'sprouted-crafts', REGISTRATION_DATE)['sprouted-crafts'];

  it('are zero-rated once registered, whatever the lines say', () => {
    const { totals, lines } = post(crafts, invoice('2026-11-02', [{ base: 99999 }], 'export'));
    expect(totals.totalTax).toBe(0);
    expect(totals.total).toBe(99999);
    expect(lines).toHaveLength(2);
    expect(balanced(lines)).toBe(true);
  });

  it('change nothing while unregistered — the flag simply exists', () => {
    const oikazi = group()['oikazi'];
    const domestic = post(oikazi, invoice('2026-11-02', [{ base: 99999 }], 'domestic'));
    const exported = post(oikazi, invoice('2026-11-02', [{ base: 99999 }], 'export'));
    expect(exported.totals).toEqual(domestic.totals);
    expect(exported.lines).toEqual(domestic.lines);
  });
});

// --- purchases: gross to cost while unregistered, input tax once registered ---------------

describe('purchases', () => {
  const unregistered = group()['oikazi'];
  const crafts = registered(group(), 'sprouted-crafts', REGISTRATION_DATE)['sprouted-crafts'];

  it('unregistered: the gross amount goes to the expense or inventory account, nothing to VAT input', () => {
    const { totals, lines } = post(unregistered, bill('2026-10-15', 120000), '5%');
    expect(totals.totalTax).toBe(0);
    expect(totals.total).toBe(120000);
    expect(amount(lines, '5001')).toBe(120000);
    expect(amount(lines, controlAccounts.vatInput)).toBe(0);
    expect(amount(lines, controlAccounts.nhilInput)).toBe(0);
    expect(amount(lines, controlAccounts.getFundInput)).toBe(0);
    // Withholding is still on the supplier's total.
    expect(totals.withholdingTax).toBe(6000);
    expect(amount(lines, controlAccounts.payables)).toBe(114000);
    expect(amount(lines, controlAccounts.withholdingPayable)).toBe(6000);
    expect(balanced(lines)).toBe(true);
  });

  it('registered: the levies are input tax', () => {
    const { totals, lines } = post(crafts, bill('2026-10-15', 100000), '5%');
    expect(totals).toMatchObject({ subtotal: 100000, vat: 15000, nhil: 2500, getFund: 2500, total: 120000, withholdingTax: 6000 });
    expect(amount(lines, '5001')).toBe(100000);
    expect(amount(lines, controlAccounts.vatInput)).toBe(15000);
    expect(amount(lines, controlAccounts.nhilInput)).toBe(2500);
    expect(amount(lines, controlAccounts.getFundInput)).toBe(2500);
    expect(amount(lines, controlAccounts.payables)).toBe(114000);
    expect(balanced(lines)).toBe(true);
  });

  it('import VAT paid at entry is cost while unregistered, on the same accounts as the goods, pro rata', () => {
    const form = bill('2026-10-15', 100000, 20000, '1030');
    form.lines.push({ ...makeLine('bill'), id: 'l1', quantity: 1, unitPrice: 300000, accountCode: '1035', vatTreatment: 'standard' });
    const { totals, lines } = post(unregistered, form);
    expect(totals.importVat).toBe(20000);
    expect(totals.total).toBe(400000);
    expect(totals.netPayable).toBe(420000);
    expect(amount(lines, '1030')).toBe(100000 + 5000);
    expect(amount(lines, '1035')).toBe(300000 + 15000);
    expect(amount(lines, controlAccounts.vatInput)).toBe(0);
    expect(amount(lines, controlAccounts.payables)).toBe(420000);
    expect(balanced(lines)).toBe(true);
  });

  it('import VAT is recoverable input tax once registered, split 15 / 2.5 / 2.5', () => {
    const { lines } = post(crafts, bill('2026-10-15', 100000, 20000, '1030'));
    expect(amount(lines, '1030')).toBe(100000);
    expect(amount(lines, controlAccounts.vatInput)).toBe(15000 + 15000);
    expect(amount(lines, controlAccounts.nhilInput)).toBe(2500 + 2500);
    expect(amount(lines, controlAccounts.getFundInput)).toBe(2500 + 2500);
    expect(amount(lines, controlAccounts.payables)).toBe(120000 + 20000);
    expect(balanced(lines)).toBe(true);
  });

  it('splitImportLevies always sums to what was paid', () => {
    for (const paid of [1, 3, 7, 20000, 12345, 99999]) {
      const split = splitImportLevies(paid);
      expect(split.vat + split.nhil + split.getFund).toBe(paid);
    }
    expect(splitImportLevies(20000)).toEqual({ vat: 15000, nhil: 2500, getFund: 2500 });
  });

  it('withholding is never charged on import VAT', () => {
    const { totals } = post(unregistered, bill('2026-10-15', 100000, 20000), '5%');
    expect(totals.withholdingTax).toBe(5000);
    expect(totals.netPayable).toBe(95000 + 20000);
  });

  it('import VAT is ignored on an invoice', () => {
    const form = invoice('2026-10-15', [{ base: 100000 }]);
    (form as { importVat: number }).importVat = 5000;
    expect(post(unregistered, form).totals.importVat).toBe(0);
  });
});

// --- the threshold tracker -------------------------------------------------------------

describe('registration threshold', () => {
  it('is GHS 750,000 and warns at 75% and 90%', () => {
    expect(VAT_REGISTRATION_THRESHOLD_MINOR).toBe(75_000_000);
    expect(thresholdStatus(0)).toEqual({ percent: 0, level: 'clear' });
    expect(thresholdStatus(56_249_999).level).toBe('clear');
    expect(thresholdStatus(56_250_000)).toEqual({ percent: 75, level: 'warning' });
    expect(thresholdStatus(67_499_999).level).toBe('warning');
    expect(thresholdStatus(67_500_000)).toEqual({ percent: 90, level: 'critical' });
    expect(thresholdStatus(75_000_000)).toEqual({ percent: 100, level: 'exceeded' });
    expect(thresholdStatus(90_000_000).percent).toBe(120);
  });

  it('counts the twelve months ending today, inclusive, and nothing older', () => {
    expect(rollingWindowStart('2026-09-21')).toBe('2025-09-21');
    expect(rollingWindowStart('2028-02-29')).toBe('2027-02-28');
    const supplies = [
      { date: '2025-09-21', baseMinor: 1 }, // exactly a year ago: outside
      { date: '2025-09-22', baseMinor: 10 }, // first day inside
      { date: '2026-09-21', baseMinor: 100 }, // today
      { date: '2026-09-22', baseMinor: 1000 }, // tomorrow: outside
    ];
    expect(rollingTaxableTurnover(supplies, '2026-09-21')).toBe(110);
  });

  it('takes posted invoices only, standard and zero-rated lines, in functional currency', () => {
    const posted = { ...invoice('2026-09-01', [{ base: 100000 }, { base: 40000, treatment: 'zero-rated' }, { base: 999999, treatment: 'exempt' }]), status: 'awaiting-payment' as const };
    const draft = { ...invoice('2026-09-02', [{ base: 500000 }]), status: 'draft' as const };
    const voided = { ...invoice('2026-09-03', [{ base: 500000 }]), status: 'voided' as const };
    const paidUsd = { ...invoice('2026-09-04', [{ base: 10000 }]), status: 'paid' as const, currency: 'USD' as const, rate: '12.5' };
    const purchase = { ...bill('2026-09-05', 500000), status: 'paid' as const };

    const supplies = taxableSuppliesOf([posted, draft, voided, paidUsd, purchase], (minor, rate) => Math.round(minor * Number(rate)));
    expect(supplies).toEqual([
      { date: '2026-09-01', baseMinor: 140000 },
      { date: '2026-09-04', baseMinor: 125000 },
    ]);
  });

  it('is tracked whether or not the entity is registered', () => {
    // The tracker reads the lines' own classification, not whether VAT was charged.
    const unregisteredInvoice = { ...invoice('2026-09-01', [{ base: 100000 }]), status: 'paid' as const };
    expect(taxableSuppliesOf([unregisteredInvoice], (m) => m)).toEqual([{ date: '2026-09-01', baseMinor: 100000 }]);
  });
});
