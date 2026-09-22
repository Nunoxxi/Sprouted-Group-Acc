/**
 * Mobile money and farmer payments: statement parsing with the fee and levy
 * split off each line, the charges journal, advance recovery from what is
 * payable, batch settlement, the disbursement export and the farmer's
 * history. Pure.
 */

import { describe, expect, it } from 'vitest';

import {
  batchSettlementJournal,
  chargesJournal,
  defaultMappings,
  disbursementCsv,
  farmerStatement,
  matchBatch,
  momoAccounts,
  parseAmountMinor,
  parseStatement,
  parseStatementDate,
  payablePurchaseJournal,
  planRecovery,
  splitCsvLine,
  type StatementMapping,
} from '@/lib/momo';

const names: Record<string, string> = {
  '1001': 'Cash and Bank',
  '1030': 'Raw Material Inventory',
  '1070': 'Farmer Advances',
  '2060': 'Farmer Payables',
  '6050': 'Mobile Money Charges & Levies',
};

const mtn = defaultMappings[0];
const telecel = defaultMappings[1];

const balanced = (lines: { amount: number; type: 'debit' | 'credit' }[]) =>
  lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amount, 0) ===
  lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amount, 0);

describe('CSV reading', () => {
  it('splits quoted fields containing commas and escaped quotes', () => {
    expect(splitCsvLine('2026-09-01,"Payment to Kofi, Mensah",1000.00')).toEqual(['2026-09-01', 'Payment to Kofi, Mensah', '1000.00']);
    expect(splitCsvLine('a,"say ""hi""",b')).toEqual(['a', 'say "hi"', 'b']);
  });

  it('reads dates in each provider format', () => {
    expect(parseStatementDate('2026-09-15', 'YYYY-MM-DD')).toBe('2026-09-15');
    expect(parseStatementDate('15/09/2026', 'DD/MM/YYYY')).toBe('2026-09-15');
    expect(parseStatementDate('05-Sep-26', 'DD-MMM-YYYY')).toBe('2026-09-05');
    expect(parseStatementDate('not a date', 'DD/MM/YYYY')).toBeNull();
  });

  it('reads amounts as whole pesewas, blanks as zero, brackets and DR as negative', () => {
    expect(parseAmountMinor('1,234.56')).toBe(123456);
    expect(parseAmountMinor('GHS 40.00')).toBe(4000);
    expect(parseAmountMinor('')).toBe(0);
    expect(parseAmountMinor('(123.45)')).toBe(-12345);
    expect(parseAmountMinor('500.00 DR')).toBe(-50000);
    expect(parseAmountMinor('rubbish')).toBeNull();
  });
});

describe('statement parsing', () => {
  const mtnCsv = [
    'Date,Description,Transaction ID,Credit,Debit,Fee,E-Levy,Balance',
    '2026-09-01,Cash in from bank,TX001,"20,000.00",,0.00,0.00,"20,000.00"',
    '2026-09-02,Bulk payment BATCH-0001,TX002,,"12,000.00",25.00,60.00,"7,915.00"',
    '2026-09-03,Monthly service charge,TX003,,15.00,0.00,0.00,"7,900.00"',
    '',
  ].join('\n');

  it('splits the fee and levy off the line so the line still matches the payment', () => {
    const parsed = parseStatement(mtnCsv, mtn);
    expect(parsed.errors).toEqual([]);
    expect(parsed.lines).toHaveLength(3);

    const payment = parsed.lines[1];
    expect(payment.amountMinor).toBe(-1_200_000); // the payment itself, not 12,085
    expect(payment.feeMinor).toBe(2500);
    expect(payment.levyMinor).toBe(6000);
    expect(payment.reference).toBe('TX002');
    expect(payment.isCharge).toBe(false);
  });

  it('marks a line that is only a charge', () => {
    const parsed = parseStatement(mtnCsv, mtn);
    expect(parsed.lines[2].isCharge).toBe(true);
    // fees, levies and the charge line itself all go to the charges account
    expect(parsed.feeTotalMinor).toBe(2500 + 6000 + 1500);
  });

  it('reads a single signed amount column', () => {
    const csv = [
      'Transaction Date,Details,Reference,Amount,Charge,Levy,Running Balance',
      '01/09/2026,Payment to farmer,REF-1,-500.00,1.50,2.50,"1,000.00"',
    ].join('\n');
    const parsed = parseStatement(csv, telecel);
    expect(parsed.lines[0]).toMatchObject({ date: '2026-09-01', amountMinor: -50000, feeMinor: 150, levyMinor: 250 });
  });

  it('reports a bad date by row number and keeps the good rows', () => {
    const csv = ['Date,Description,Transaction ID,Credit,Debit,Fee,E-Levy,Balance', '2026-09-01,Good,TX1,100.00,,,,', 'yesterday,Bad,TX2,100.00,,,,'].join('\n');
    const parsed = parseStatement(csv, mtn);
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.errors).toEqual([{ row: 3, message: 'Could not read the date "yesterday".' }]);
  });

  it('refuses a file whose columns the mapping does not name', () => {
    const parsed = parseStatement('When,What,How much\n2026-09-01,x,1', mtn);
    expect(parsed.lines).toEqual([]);
    expect(parsed.errors.map((e) => e.message)).toContain('No "Date" column in the file.');
  });

  it('skips blank rows and zero-value rows rather than making empty lines', () => {
    const csv = ['Date,Description,Transaction ID,Credit,Debit,Fee,E-Levy,Balance', '2026-09-01,Balance brought forward,,0.00,0.00,0.00,0.00,"20,000.00"', ',,,,,,,'].join('\n');
    expect(parseStatement(csv, mtn).lines).toEqual([]);
  });
});

describe('journals', () => {
  it('posts fees and levies to charges out of the wallet', () => {
    const lines = chargesJournal(10_000, '1001', names);
    expect(balanced(lines)).toBe(true);
    expect(lines.find((l) => l.type === 'debit')?.accountCode).toBe(momoAccounts.charges);
    expect(chargesJournal(0, '1001', names)).toEqual([]);
  });

  it('a payable purchase credits the farmer and clears the advance it recovers', () => {
    const lines = payablePurchaseJournal(500_00, 200_00, '1030', names);
    expect(balanced(lines)).toBe(true);
    expect(lines.find((l) => l.accountCode === momoAccounts.farmerAdvances)).toMatchObject({ amount: 200_00, type: 'credit' });
    expect(lines.find((l) => l.accountCode === momoAccounts.farmerPayables)).toMatchObject({ amount: 300_00, type: 'credit' });
  });

  it('a purchase fully absorbed by an advance leaves nothing payable', () => {
    const lines = payablePurchaseJournal(200_00, 200_00, '1030', names);
    expect(balanced(lines)).toBe(true);
    expect(lines.some((l) => l.accountCode === momoAccounts.farmerPayables)).toBe(false);
  });

  it('settling a batch clears the payables and charges the fee', () => {
    const lines = batchSettlementJournal(12_000_00, 85_00, '1001', names);
    expect(balanced(lines)).toBe(true);
    expect(lines.find((l) => l.accountCode === '1001')).toMatchObject({ amount: 12_085_00, type: 'credit' });
  });
});

describe('advance recovery', () => {
  const advances = [
    { id: 'a2', date: '2026-04-01', amountMinor: 300_00, settledMinor: 0 },
    { id: 'a1', date: '2026-02-01', amountMinor: 200_00, settledMinor: 50_00 },
  ];

  it('recovers the oldest advance first, up to what is payable', () => {
    const plan = planRecovery(400_00, advances);
    expect(plan.recoveries).toEqual([
      { advanceId: 'a1', amountMinor: 150_00 },
      { advanceId: 'a2', amountMinor: 250_00 },
    ]);
    expect(plan.recoveredMinor).toBe(400_00);
    expect(plan.payableMinor).toBe(0);
    expect(plan.remainingAdvanceMinor).toBe(50_00);
  });

  it('never recovers more than the purchase is worth, so a payment cannot go negative', () => {
    const plan = planRecovery(100_00, advances);
    expect(plan.recoveredMinor).toBe(100_00);
    expect(plan.payableMinor).toBe(0);
    expect(plan.remainingAdvanceMinor).toBe(350_00);
  });

  it('pays in full when the farmer owes nothing', () => {
    const plan = planRecovery(500_00, []);
    expect(plan).toMatchObject({ recoveries: [], recoveredMinor: 0, payableMinor: 500_00, remainingAdvanceMinor: 0 });
  });

  it('ignores advances already settled', () => {
    const plan = planRecovery(500_00, [{ id: 'a1', date: '2026-01-01', amountMinor: 200_00, settledMinor: 200_00 }]);
    expect(plan.recoveredMinor).toBe(0);
    expect(plan.payableMinor).toBe(500_00);
  });

  it('the recovery and what is left always add back to the price', () => {
    for (const price of [1_23, 999_99, 1_000_00]) {
      const plan = planRecovery(price, advances);
      expect(plan.recoveredMinor + plan.payableMinor).toBe(price);
    }
  });
});

describe('bulk disbursement export', () => {
  it('writes wallet, plain amount, reference and name', () => {
    const csv = disbursementCsv('BATCH-0001', [
      { farmerName: 'Kofi Mensah', walletNumber: '0244000111', amountMinor: 1_250_50, reference: '' },
      { farmerName: 'Ama, Serwaa', walletNumber: '0201234567', amountMinor: 40_000_00, reference: 'PAY-9' },
    ]);
    expect(csv.split('\n')).toEqual([
      'MSISDN,Amount,Reference,Name',
      '0244000111,1250.50,BATCH-0001-001,Kofi Mensah',
      '0201234567,40000.00,PAY-9,Ama  Serwaa',
    ]);
  });
});

describe('matching a batch to a statement line', () => {
  const candidates = [
    { id: 'b1', reference: 'BATCH-0001', date: '2026-09-02', totalMinor: 1_200_000, feeMinor: 8500 },
    { id: 'b2', reference: 'BATCH-0002', date: '2026-09-02', totalMinor: 500_000, feeMinor: 2000 },
  ];

  it('matches on the batch reference in the description', () => {
    expect(matchBatch({ date: '2026-09-02', description: 'Bulk payment BATCH-0001', reference: 'TX002', amountMinor: -1_200_000 }, candidates)?.id).toBe('b1');
  });

  it('matches on the amount within three days when there is no reference', () => {
    expect(matchBatch({ date: '2026-09-04', description: 'Bulk disbursement', reference: null, amountMinor: -500_000 }, candidates)?.id).toBe('b2');
  });

  it('leaves it unmatched when two batches would fit, or nothing does', () => {
    const twins = [candidates[1], { ...candidates[1], id: 'b3', reference: 'BATCH-0003' }];
    expect(matchBatch({ date: '2026-09-02', description: 'Bulk disbursement', reference: null, amountMinor: -500_000 }, twins)).toBeNull();
    expect(matchBatch({ date: '2026-09-20', description: 'Bulk disbursement', reference: null, amountMinor: -500_000 }, candidates)).toBeNull();
  });
});

describe("the farmer's history", () => {
  const statement = farmerStatement(
    [
      { date: '2026-09-10', description: 'Cashew 500 kg', grams: 500_000, grossMinor: 5_000_00, recoveredMinor: 200_00, payableMinor: 4_800_00, paidMinor: 4_800_00, reference: 'TX002', evidence: 'Mobile money' },
      { date: '2026-09-18', description: 'Cashew 200 kg', grams: 200_000, grossMinor: 2_000_00, recoveredMinor: 100_00, payableMinor: 1_900_00, paidMinor: 0, reference: '', evidence: 'Thumbprint' },
    ],
    [{ date: '2026-04-01', description: 'Pre-season advance', amountMinor: 500_00 }],
    [],
  );

  it('totals the deliveries, weight and gross value', () => {
    expect(statement.deliveries).toBe(2);
    expect(statement.gramsTotal).toBe(700_000);
    expect(statement.grossMinor).toBe(7_000_00);
  });

  it('shows what the farmer still owes and what is still owed to the farmer', () => {
    expect(statement.advanceOutstandingMinor).toBe(200_00); // 500 advanced less 300 recovered
    expect(statement.payableOutstandingMinor).toBe(1_900_00); // the unpaid delivery
  });

  it('lists every event newest first', () => {
    expect(statement.events.map((e) => [e.date, e.kind])).toEqual([
      ['2026-09-18', 'delivery'],
      ['2026-09-10', 'delivery'],
      ['2026-04-01', 'advance'],
    ]);
  });
});

describe('the provider mappings supplied', () => {
  it('every one names a date, a description and some amount column', () => {
    for (const mapping of defaultMappings as StatementMapping[]) {
      expect(mapping.dateColumn).toBeTruthy();
      expect(mapping.descriptionColumn).toBeTruthy();
      expect(mapping.amountColumn || mapping.moneyInColumn || mapping.moneyOutColumn).toBeTruthy();
    }
  });
});
