import { describe, expect, it } from 'vitest';

import { journalEntriesBalance } from '@/lib/accounting-integrity';
import { journalLinesFor, makeDocument, type DocumentFormState } from '@/lib/documents';

/** The FX cases run as a VAT-registered entity so levy lines are converted too. */
const vatOn = { vatApplies: true };
import {
  convertJournal,
  convertMinor,
  foreignBalancesFrom,
  formatMoney,
  fxAccounts,
  intercompanyPairBalances,
  invertRate,
  journalBalances,
  monetaryControlCodes,
  normalizeRate,
  parseRate,
  revaluationFor,
  selectRate,
  settlementFor,
  type ExchangeRateRecord,
  type FxJournalLine,
} from '@/lib/fx';

/** The books-balance check the rest of the suite uses, applied to functional amounts. */
function balanced(lines: readonly FxJournalLine[]): boolean {
  return (
    journalBalances(lines) &&
    journalEntriesBalance([{ entityId: 'x', lines: lines.map((line) => ({ accountCode: line.accountCode, amount: line.functionalAmount, type: line.type })) }])
  );
}

function usdInvoice(unitPriceCents: number, quantity = 1): DocumentFormState {
  const document = makeDocument('invoice', 'customer');
  document.lines = [{ id: 'l1', description: 'Cocoa beans', quantity, unitPrice: unitPriceCents, accountCode: '4005', vatTreatment: 'zero-rated', itemId: null, locationId: null, landedCostKind: null, landedCostLotIds: [], lotRef: '', community: '', district: '', quality: {}, contractId: null, sellingCostKind: null, grantId: null, budgetLineId: null }];
  return document;
}

describe('rates are exact', () => {
  it('parses and normalises decimal rates without floating point', () => {
    expect(normalizeRate('12.50')).toBe('12.5');
    expect(normalizeRate('12')).toBe('12.0');
    expect(normalizeRate('0.0800000000')).toBe('0.08');
    expect(parseRate('12.5')).toBe(125000000000n);
    expect(() => parseRate('-1')).toThrow();
    expect(() => parseRate('0')).toThrow();
    expect(() => parseRate('1e3')).toThrow();
    expect(() => parseRate('12.12345678901')).toThrow(/decimal places/);
  });

  it('converts minor units with a single half-away-from-zero rounding', () => {
    expect(convertMinor(100000, '12.5')).toBe(1250000); // $1,000.00 → GH₵12,500.00
    expect(convertMinor(1, '12.5')).toBe(13); // 1 cent → 12.5 pesewas → 13
    expect(convertMinor(-1, '12.5')).toBe(-13);
    expect(convertMinor(33333, '1.1')).toBe(36666); // 36666.3
    expect(convertMinor(0, '99.9')).toBe(0);
    expect(() => convertMinor(1.5, '1.0')).toThrow();
  });

  it('inverts to ten places', () => {
    expect(invertRate('12.5')).toBe('0.08');
    expect(invertRate('3.0')).toBe('0.3333333333');
    expect(convertMinor(1250000, invertRate('12.5'))).toBe(100000);
  });
});

describe('selectRate: the day\'s rate, else the most recent prior with a warning', () => {
  const rates: ExchangeRateRecord[] = [
    { base: 'USD', quote: 'GHS', date: '2026-09-01', rate: '12.4' },
    { base: 'USD', quote: 'GHS', date: '2026-09-10', rate: '12.5' },
    { base: 'USD', quote: 'GHS', date: '2026-09-20', rate: '12.9' },
    { base: 'GHS', quote: 'EUR', date: '2026-09-05', rate: '0.07' },
  ];

  it('returns the exact date when it exists', () => {
    expect(selectRate(rates, 'USD', 'GHS', '2026-09-10')).toEqual({ rate: '12.5', rateDate: '2026-09-10', exact: true, inverted: false });
  });

  it('falls back to the most recent prior date and says so', () => {
    expect(selectRate(rates, 'USD', 'GHS', '2026-09-15')).toEqual({ rate: '12.5', rateDate: '2026-09-10', exact: false, inverted: false });
  });

  it('never uses a future rate', () => {
    expect(selectRate(rates, 'USD', 'GHS', '2026-08-31')).toBeNull();
  });

  it('inverts the reverse pair when only that is on file, and says so', () => {
    expect(selectRate(rates, 'EUR', 'GHS', '2026-09-30')).toEqual({ rate: invertRate('0.07'), rateDate: '2026-09-05', exact: false, inverted: true });
  });

  it('is the identity for the same currency', () => {
    expect(selectRate([], 'GHS', 'GHS', '2026-09-30')?.rate).toBe('1.0');
  });
});

describe('a foreign invoice posted at one rate', () => {
  const functional = 'GHS';
  const lines = journalLinesFor(usdInvoice(100000), false, undefined, {}, vatOn);

  it('stores both currencies on every line and balances in both', () => {
    const converted = convertJournal(lines, 'USD', functional, '12.5', '1010');
    for (const line of converted) {
      expect(line.currency).toBe('USD');
      expect(line.rate).toBe('12.5');
      expect(line.functionalAmount).toBe(convertMinor(line.txnAmount, '12.5'));
    }
    expect(balanced(converted)).toBe(true);
    expect(converted.reduce((s, l) => s + (l.type === 'debit' ? l.txnAmount : -l.txnAmount), 0)).toBe(0);
  });

  it('puts any rounding difference on the control line so the journal still balances', () => {
    // 3 × $333.33 standard-rated: base 99999, levies 15000/2500/2500 — each
    // line rounds on its own at 12.345678 and the total drifts by a pesewa.
    const document = makeDocument('invoice', 'c');
    document.lines = [{ id: 'a', description: 'x', quantity: 3, unitPrice: 33333, accountCode: '4005', vatTreatment: 'standard', itemId: null, locationId: null, landedCostKind: null, landedCostLotIds: [], lotRef: '', community: '', district: '', quality: {}, contractId: null, sellingCostKind: null, grantId: null, budgetLineId: null }];
    const raw = journalLinesFor(document, false, undefined, {}, vatOn);
    const naive = raw.map((line) => ({ ...line, functional: convertMinor(line.amount, '12.345678') }));
    const naiveImbalance = naive.reduce((s, l) => s + (l.type === 'debit' ? l.functional : -l.functional), 0);
    expect(naiveImbalance).not.toBe(0); // the case is real

    const converted = convertJournal(raw, 'USD', 'GHS', '12.345678', '1010');
    expect(balanced(converted)).toBe(true);
    const control = converted.find((l) => l.accountCode === '1010')!;
    expect(Math.abs(control.functionalAmount - convertMinor(control.txnAmount, '12.345678'))).toBeLessThanOrEqual(Math.abs(naiveImbalance));
  });

  it('a functional-currency document is rate 1.0 with identical amounts', () => {
    const converted = convertJournal(lines, 'GHS', 'GHS', '999', '1010');
    for (const line of converted) {
      expect(line.rate).toBe('1.0');
      expect(line.functionalAmount).toBe(line.txnAmount);
    }
  });
});

describe('settled at a different rate: realised FX', () => {
  const base = {
    functionalCurrency: 'GHS' as const,
    documentCurrency: 'USD' as const,
    controlAccountCode: '1010',
    bankAccountCode: '1002',
  };

  it('invoice: $1,000 raised at 12.50, received at 13.00 is a GH₵500 realised gain and the books balance', () => {
    const s = settlementFor({
      ...base,
      kind: 'invoice',
      documentRate: '12.5',
      settlementRate: '13.0',
      txnAmount: 100000,
      bankCurrency: 'USD',
      remainingBookMinor: 1250000,
      isFinal: true,
    });
    expect(s.reliefMinor).toBe(1250000);
    expect(s.bankFunctionalMinor).toBe(1300000);
    expect(s.gainLossMinor).toBe(50000);
    const fx = s.lines.find((l) => l.accountCode === fxAccounts.gain)!;
    expect(fx.type).toBe('credit');
    expect(fx.functionalAmount).toBe(50000);
    expect(s.lines.find((l) => l.accountCode === '1010')!.type).toBe('credit');
    expect(s.lines.find((l) => l.accountCode === '1002')!.type).toBe('debit');
    expect(balanced(s.lines)).toBe(true);
  });

  it('invoice: received at 12.10 is a GH₵400 realised loss, debited, and still balances', () => {
    const s = settlementFor({ ...base, kind: 'invoice', documentRate: '12.5', settlementRate: '12.1', txnAmount: 100000, bankCurrency: 'USD', remainingBookMinor: 1250000, isFinal: true });
    expect(s.gainLossMinor).toBe(-40000);
    const fx = s.lines.find((l) => l.accountCode === fxAccounts.loss)!;
    expect(fx.type).toBe('debit');
    expect(fx.functionalAmount).toBe(40000);
    expect(balanced(s.lines)).toBe(true);
  });

  it('bill: $1,000 booked at 12.50, paid at 13.00 is a GH₵500 loss (we paid more cedis)', () => {
    const s = settlementFor({ ...base, kind: 'bill', controlAccountCode: '2001', documentRate: '12.5', settlementRate: '13.0', txnAmount: 100000, bankCurrency: 'USD', remainingBookMinor: 1250000, isFinal: true });
    expect(s.gainLossMinor).toBe(-50000);
    expect(s.lines.find((l) => l.accountCode === '2001')!.type).toBe('debit');
    expect(s.lines.find((l) => l.accountCode === '1002')!.type).toBe('credit');
    expect(s.lines.find((l) => l.accountCode === fxAccounts.loss)!.type).toBe('debit');
    expect(balanced(s.lines)).toBe(true);
  });

  it('settling through a functional-currency bank: the bank line is the cedis actually received', () => {
    const s = settlementFor({ ...base, kind: 'invoice', documentRate: '12.5', settlementRate: '13.0', txnAmount: 100000, bankCurrency: 'GHS', bankAccountCode: '1001', remainingBookMinor: 1250000, isFinal: true });
    const bank = s.lines.find((l) => l.accountCode === '1001')!;
    expect(bank.currency).toBe('GHS');
    expect(bank.txnAmount).toBe(1300000);
    expect(bank.rate).toBe('1.0');
    expect(s.gainLossMinor).toBe(50000);
    expect(balanced(s.lines)).toBe(true);
  });

  it('same rate both times: no FX line at all', () => {
    const s = settlementFor({ ...base, kind: 'invoice', documentRate: '12.5', settlementRate: '12.5', txnAmount: 100000, bankCurrency: 'USD', remainingBookMinor: 1250000, isFinal: true });
    expect(s.gainLossMinor).toBe(0);
    expect(s.lines).toHaveLength(2);
    expect(balanced(s.lines)).toBe(true);
  });

  it('partial then final: the reliefs add up to exactly the original book value', () => {
    const first = settlementFor({ ...base, kind: 'invoice', documentRate: '12.345678', settlementRate: '12.9', txnAmount: 33333, bankCurrency: 'USD', remainingBookMinor: 1234568, isFinal: false });
    expect(first.reliefMinor).toBe(convertMinor(33333, '12.345678'));
    const remaining = 1234568 - first.reliefMinor;
    const second = settlementFor({ ...base, kind: 'invoice', documentRate: '12.345678', settlementRate: '12.7', txnAmount: 66667, bankCurrency: 'USD', remainingBookMinor: remaining, isFinal: true });
    expect(first.reliefMinor + second.reliefMinor).toBe(1234568);
    expect(balanced(first.lines) && balanced(second.lines)).toBe(true);
  });

  it('full cycle: invoice journal + settlement journal leave the receivable at zero in both currencies', () => {
    const invoice = convertJournal(journalLinesFor(usdInvoice(100000), false, undefined, {}, vatOn), 'USD', 'GHS', '12.5', '1010');
    const receivableBook = invoice.find((l) => l.accountCode === '1010')!.functionalAmount;
    const s = settlementFor({ ...base, kind: 'invoice', documentRate: '12.5', settlementRate: '13.0', txnAmount: 100000, bankCurrency: 'USD', remainingBookMinor: receivableBook, isFinal: true });
    const all = [...invoice, ...s.lines];
    const net = (code: string, pick: (l: FxJournalLine) => number) => all.filter((l) => l.accountCode === code).reduce((sum, l) => sum + (l.type === 'debit' ? pick(l) : -pick(l)), 0);
    expect(net('1010', (l) => l.txnAmount)).toBe(0);
    expect(net('1010', (l) => l.functionalAmount)).toBe(0);
    expect(net('1002', (l) => l.functionalAmount)).toBe(1300000);
    expect(net(fxAccounts.gain, (l) => l.functionalAmount)).toBe(-50000); // credit = gain
    expect(balanced(all)).toBe(true);
  });

  it('refuses a bank in a third currency', () => {
    expect(() => settlementFor({ ...base, kind: 'invoice', documentRate: '12.5', settlementRate: '13.0', txnAmount: 1, bankCurrency: 'EUR', remainingBookMinor: 13, isFinal: true })).toThrow(/EUR bank/);
  });
});

describe('period-end revaluation: unrealised FX', () => {
  it('revalues a USD receivable at the closing rate and posts the gain to 4015', () => {
    const [adj] = revaluationFor([{ accountCode: '1010', currency: 'USD', foreignMinor: 100000, bookMinor: 1250000 }], { USD: '12.8' }, 'GHS');
    expect(adj.revaluedMinor).toBe(1280000);
    expect(adj.differenceMinor).toBe(30000);
    expect(adj.lines[0]).toMatchObject({ accountCode: '1010', type: 'debit', currency: 'USD', txnAmount: 0, functionalAmount: 30000 });
    expect(adj.lines[1]).toMatchObject({ accountCode: fxAccounts.gain, type: 'credit', functionalAmount: 30000 });
    expect(balanced(adj.lines)).toBe(true);
  });

  it('a USD payable that grew in cedis is a loss', () => {
    const [adj] = revaluationFor([{ accountCode: '2001', currency: 'USD', foreignMinor: -100000, bookMinor: -1250000 }], { USD: '12.8' }, 'GHS');
    expect(adj.differenceMinor).toBe(-30000);
    expect(adj.lines[0]).toMatchObject({ accountCode: '2001', type: 'credit', functionalAmount: 30000 });
    expect(adj.lines[1]).toMatchObject({ accountCode: fxAccounts.loss, type: 'debit', functionalAmount: 30000 });
    expect(balanced(adj.lines)).toBe(true);
  });

  it('the adjustment leaves the foreign balance untouched, so a later revaluation is right', () => {
    const invoice = convertJournal(journalLinesFor(usdInvoice(100000), false, undefined, {}, vatOn), 'USD', 'GHS', '12.5', '1010');
    const monetary = new Set(monetaryControlCodes);
    const before = foreignBalancesFrom(invoice, monetary, 'GHS');
    const [first] = revaluationFor(before, { USD: '12.8' }, 'GHS');
    const after = foreignBalancesFrom([...invoice, ...first.lines], monetary, 'GHS');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ accountCode: '1010', currency: 'USD', foreignMinor: 100000, bookMinor: 1280000 });
    const [second] = revaluationFor(after, { USD: '12.6' }, 'GHS');
    expect(second.differenceMinor).toBe(-20000); // from 12,800 down to 12,600
  });

  it('never revalues non-monetary or functional-currency balances', () => {
    const balances = foreignBalancesFrom(
      [
        { accountCode: '1030', currency: 'USD', txnAmount: 5000, functionalAmount: 62500, type: 'debit' }, // inventory
        { accountCode: '1010', currency: 'GHS', txnAmount: 100, functionalAmount: 100, type: 'debit' }, // functional
        { accountCode: '1010', currency: 'EUR', txnAmount: 100, functionalAmount: 1400, type: 'debit' },
      ],
      new Set(monetaryControlCodes),
      'GHS',
    );
    expect(balances).toEqual([{ accountCode: '1010', accountName: undefined, currency: 'EUR', foreignMinor: 100, bookMinor: 1400 }]);
    expect(revaluationFor(balances, { USD: '13' }, 'GHS')).toEqual([]); // no EUR closing rate → skipped, not guessed
  });

  it('bank accounts are revalued when the caller adds their codes', () => {
    const balances = foreignBalancesFrom([{ accountCode: '1002', currency: 'USD', txnAmount: 100000, functionalAmount: 1300000, type: 'debit' }], new Set(['1002']), 'GHS');
    const [adj] = revaluationFor(balances, { USD: '12.5' }, 'GHS');
    expect(adj.differenceMinor).toBe(-50000);
  });
});

describe('intercompany across functional currencies', () => {
  const entities = [
    { id: 'roots', functionalCurrency: 'GHS' as const },
    { id: 'crafts', functionalCurrency: 'GHS' as const },
    { id: 'oikazi', functionalCurrency: 'USD' as const },
  ];

  it('same currency: a faithful mirror nets to zero; an unfaithful one is a mismatch', () => {
    const ok = intercompanyPairBalances(entities, [{ fromEntityId: 'roots', toEntityId: 'crafts', sides: [{ entityId: 'roots', functionalCurrency: 'GHS', functionalMinor: 128400 }, { entityId: 'crafts', functionalCurrency: 'GHS', functionalMinor: -128400 }] }], () => null);
    expect(ok.get('roots->crafts')).toMatchObject({ balanceMinor: 128400, mirroredMinor: -128400, sameCurrency: true, mismatch: false });
    const bad = intercompanyPairBalances(entities, [{ fromEntityId: 'roots', toEntityId: 'crafts', sides: [{ entityId: 'roots', functionalCurrency: 'GHS', functionalMinor: 128400 }, { entityId: 'crafts', functionalCurrency: 'GHS', functionalMinor: -120000 }] }], () => null);
    expect(bad.get('roots->crafts')!.mismatch).toBe(true);
  });

  it('different currencies: no mismatch flag; the FX difference is shown explicitly', () => {
    // Crafts (GHS) sells $1,000 to Oikazi (USD). Crafts books GH₵12,500 at 12.5; Oikazi books $1,000.
    const matrix = intercompanyPairBalances(
      entities,
      [{ fromEntityId: 'crafts', toEntityId: 'oikazi', sides: [{ entityId: 'crafts', functionalCurrency: 'GHS', functionalMinor: 1250000 }, { entityId: 'oikazi', functionalCurrency: 'USD', functionalMinor: -100000 }] }],
      (from, to) => (from === 'USD' && to === 'GHS' ? '12.9' : from === 'GHS' && to === 'USD' ? invertRate('12.9') : null),
    );
    const cell = matrix.get('crafts->oikazi')!;
    expect(cell.sameCurrency).toBe(false);
    expect(cell.mismatch).toBe(false);
    expect(cell.balanceCurrency).toBe('GHS');
    expect(cell.mirroredCurrency).toBe('USD');
    expect(cell.translatedMirrorMinor).toBe(-1290000); // $1,000 at today's 12.9
    expect(cell.fxDifferenceMinor).toBe(-40000); // GH₵400 difference, explained by the rate move
  });

  it('without a rate the difference is unknown rather than wrong', () => {
    const matrix = intercompanyPairBalances(entities, [], () => null);
    expect(matrix.get('crafts->oikazi')!.fxDifferenceMinor).toBeNull();
  });
});

describe('formatMoney never shows a bare number', () => {
  it('prefixes the symbol and brackets negatives', () => {
    expect(formatMoney(1250000, 'GHS')).toBe('GH₵ 12,500.00');
    expect(formatMoney(-100, 'USD')).toBe('($ 1.00)');
    expect(formatMoney(5, 'EUR')).toBe('€ 0.05');
  });
});
