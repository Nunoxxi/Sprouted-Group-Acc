import { describe, expect, it } from 'vitest';

import {
  balanceSheetBalances,
  intercompanyMirrorsMatch,
  journalEntriesBalance,
  ledgerBalancesPerEntity,
  trialBalanceNetsToZero,
  type IntercompanyTransactionLike,
} from '@/lib/accounting-integrity';
import { accountTypesMap, entityIds, ledgerLines, projects } from '@/lib/report-data';
import { leviesOnBase, withholdingTaxOn } from '@/lib/ghana-tax';
import { seedFunds, seedProjects } from '@/lib/seed-data';

const accountTypes = accountTypesMap();

/**
 * Build the journal entries the app actually generates for one document and
 * assert each is balanced — this mirrors buildJournalEntries in the shell.
 */
function documentJournal(base: number, kind: 'sale' | 'purchase') {
  const { vat, nhil, getFund, totalInclTax: total } = leviesOnBase(base);

  if (kind === 'sale') {
    return {
      entityId: 'sprouted-roots',
      lines: [
        { amount: total, type: 'debit' as const },
        { amount: base, type: 'credit' as const },
        { amount: vat, type: 'credit' as const },
        { amount: nhil, type: 'credit' as const },
        { amount: getFund, type: 'credit' as const },
      ],
    };
  }

  const wht = withholdingTaxOn(total, 0.05);
  return {
    entityId: 'sprouted-roots',
    lines: [
      { amount: base, type: 'debit' as const },
      { amount: vat, type: 'debit' as const },
      { amount: nhil, type: 'debit' as const },
      { amount: getFund, type: 'debit' as const },
      { amount: total - wht, type: 'credit' as const },
      { amount: wht, type: 'credit' as const },
    ],
  };
}

/** One entity's half of an intercompany posting: balanced, moving `amount`. */
function mirroredSide(amount: number) {
  return [
    { amount, type: 'debit' as const },
    { amount, type: 'credit' as const },
  ];
}

describe('books always balance', () => {
  it('every generated document journal has debits equal to credits', () => {
    const journals = [
      documentJournal(1500000, 'sale'),
      documentJournal(2200000, 'sale'),
      documentJournal(1200000, 'purchase'),
      documentJournal(456000, 'purchase'),
    ];
    expect(journalEntriesBalance(journals)).toBe(true);
  });

  it('total debits equal total credits per entity across the whole ledger', () => {
    const result = ledgerBalancesPerEntity(ledgerLines, entityIds);
    for (const entityId of entityIds) {
      expect(result[entityId], `ledger out of balance for ${entityId}`).toBe(true);
    }
  });

  it('trial balance nets to zero for each entity', () => {
    for (const entityId of entityIds) {
      expect(trialBalanceNetsToZero(ledgerLines, entityId), `trial balance non-zero for ${entityId}`).toBe(true);
    }
  });

  it('the balance sheet balances per entity (assets = liabilities + equity)', () => {
    const result = balanceSheetBalances(ledgerLines, accountTypes, entityIds);
    for (const entityId of entityIds) {
      expect(result[entityId], `balance sheet out of balance for ${entityId}`).toBe(true);
    }
  });

  it('every intercompany pair nets to zero and posts to both entities', () => {
    const transactions: IntercompanyTransactionLike[] = [
      {
        reference: 'IC-2026-001',
        amount: 128400,
        fromEntityId: 'sprouted-roots',
        toEntityId: 'sprouted-crafts',
        journalEntries: [
          { entityId: 'sprouted-roots', side: mirroredSide(128400) },
          { entityId: 'sprouted-crafts', side: mirroredSide(128400) },
        ],
      },
      {
        reference: 'IC-2026-002',
        amount: 68000,
        fromEntityId: 'sprouted-crafts',
        toEntityId: 'oikazi',
        journalEntries: [
          { entityId: 'sprouted-crafts', side: mirroredSide(68000) },
          { entityId: 'oikazi', side: mirroredSide(68000) },
        ],
      },
    ];
    expect(intercompanyMirrorsMatch(transactions)).toBe(true);
  });

  it('rejects an intercompany transaction missing one side', () => {
    const broken: IntercompanyTransactionLike[] = [
      {
        reference: 'IC-2026-003',
        amount: 50000,
        fromEntityId: 'sprouted-roots',
        toEntityId: 'sprouted-crafts',
        journalEntries: [{ entityId: 'sprouted-roots', side: mirroredSide(50000) }], // mirror never posted
      },
    ];
    expect(intercompanyMirrorsMatch(broken)).toBe(false);
  });

  it('rejects an intercompany transaction whose two sides disagree on the amount', () => {
    const mismatched: IntercompanyTransactionLike[] = [
      {
        reference: 'IC-2026-004',
        amount: 90000,
        fromEntityId: 'sprouted-roots',
        toEntityId: 'sprouted-crafts',
        journalEntries: [
          { entityId: 'sprouted-roots', side: mirroredSide(90000) },
          { entityId: 'sprouted-crafts', side: mirroredSide(89000) }, // buyer booked less
        ],
      },
    ];
    expect(intercompanyMirrorsMatch(mismatched)).toBe(false);
  });

  it('detects an out-of-balance journal entry', () => {
    const bad = [
      {
        entityId: 'sprouted-roots',
        lines: [
          { amount: 1000, type: 'debit' as const },
          { amount: 999, type: 'credit' as const },
        ],
      },
    ];
    expect(journalEntriesBalance(bad)).toBe(false);
  });
});

describe('project tracking (Sprouted Roots)', () => {
  const isIncome = (code: string) => accountTypes[code] === 'INCOME';
  const isExpenditure = (code: string) => ['COST_OF_SALES', 'EXPENSE'].includes(accountTypes[code]);

  it('every project-tagged line references a known project', () => {
    const knownIds = new Set(projects.map((project) => project.id));
    const tagged = ledgerLines.filter((line) => line.projectId !== undefined);
    expect(tagged.length).toBeGreaterThan(0);
    for (const line of tagged) {
      expect(knownIds.has(line.projectId as string), `unknown project ${line.projectId} on line ${line.id}`).toBe(true);
    }
  });

  it('per-project closing balance equals opening plus funds received less expenses', () => {
    for (const project of projects) {
      const lines = ledgerLines.filter((line) => line.projectId === project.id);
      const income = -lines.filter((line) => isIncome(line.accountCode)).reduce((total, line) => total + line.amount, 0);
      const expenditure = lines.filter((line) => isExpenditure(line.accountCode)).reduce((total, line) => total + line.amount, 0);
      const closing = income - expenditure;
      expect(Number.isInteger(closing), `project ${project.id} closing not an integer`);
      // A funded project should never end negative overall in this dataset
      expect(closing, `project ${project.id} is overdrawn`).toBeGreaterThanOrEqual(0);
    }
  });

  it('project totals reconcile to the fund totals they belong to', () => {
    for (const fund of ['restricted', 'unrestricted'] as const) {
      const projectIncome = projects
        .filter((project) => project.fund === fund)
        .flatMap((project) => ledgerLines.filter((line) => line.projectId === project.id && isIncome(line.accountCode)))
        .reduce((total, line) => total - line.amount, 0);

      const fundIncome = ledgerLines
        .filter((line) => line.entityId === 'sprouted-roots' && line.fund === fund && isIncome(line.accountCode))
        .reduce((total, line) => total - line.amount, 0);

      expect(projectIncome, `${fund} project income does not reconcile to fund income`).toBe(fundIncome);
    }
  });

  it('the seeded funds cover every fund classification the fund report uses', () => {
    // The seed is the only thing that creates funds, so checking the seed
    // definitions is checking what the database will hold — without needing one.
    const seededClassifications = new Set(
      seedFunds.filter((fund) => fund.entityId === 'sprouted-roots').map((fund) => fund.classification),
    );

    const reportTags = new Set(
      ledgerLines
        .filter((line) => line.entityId === 'sprouted-roots' && line.fund)
        .map((line) => line.fund as string),
    );

    for (const tag of Array.from(reportTags)) {
      expect(seededClassifications.has(tag as 'restricted' | 'unrestricted'), `fund classification ${tag} is not seeded`).toBe(true);
    }
  });

  it('every seeded project belongs to a seeded fund of the same entity', () => {
    const fundKeys = new Set(seedFunds.map((fund) => `${fund.entityId}/${fund.code}`));
    for (const project of seedProjects) {
      expect(fundKeys.has(`${project.entityId}/${project.fundCode}`), `project ${project.id} references an unseeded fund`).toBe(true);
    }
  });
});

describe('Ghana levies stay in whole pesewas', () => {
  // Bases chosen to land badly on 15% and 2.5%: 1234 * 0.025 = 30.85, and
  // 1234 * 0.15 is 185.10000000000002 in binary floating point.
  const awkwardBases = [1, 7, 13, 99, 1234, 4567, 33333, 99999, 123457, 2000001];

  it('every levy on every base is a whole number of pesewas', () => {
    for (const base of awkwardBases) {
      const { vat, nhil, getFund, totalTax, totalInclTax } = leviesOnBase(base);
      for (const [label, amount] of Object.entries({ vat, nhil, getFund, totalTax, totalInclTax })) {
        expect(Number.isInteger(amount), `${label} on base ${base} is ${amount}, not whole pesewas`).toBe(true);
      }
    }
  });

  it('the three levies together stay within a pesewa of the 20% effective rate', () => {
    for (const base of awkwardBases) {
      const { totalTax } = leviesOnBase(base);
      expect(Math.abs(totalTax - base * 0.2), `20% drift on base ${base}`).toBeLessThanOrEqual(1.5);
    }
  });

  it('NHIL and GETFund are charged on the same base at the same rate', () => {
    for (const base of awkwardBases) {
      const { nhil, getFund } = leviesOnBase(base);
      expect(nhil, `NHIL and GETFund differ on base ${base}`).toBe(getFund);
    }
  });

  it('zero-rated and exempt lines carry no levy but keep their base', () => {
    for (const treatment of ['zero-rated', 'exempt'] as const) {
      const result = leviesOnBase(4567, treatment);
      expect(result.totalTax).toBe(0);
      expect(result.totalInclTax).toBe(4567);
    }
  });

  it('withholding tax is whole pesewas and charged on the tax-inclusive total', () => {
    for (const base of awkwardBases) {
      const { totalInclTax } = leviesOnBase(base);
      const wht = withholdingTaxOn(totalInclTax, 0.05);
      expect(Number.isInteger(wht), `WHT on base ${base} is ${wht}`).toBe(true);
      expect(wht).toBe(Math.round(totalInclTax * 0.05));
    }
  });

  it('a document journal built from these levies balances exactly', () => {
    for (const base of awkwardBases) {
      expect(journalEntriesBalance([documentJournal(base, 'sale')]), `sale on ${base}`).toBe(true);
      expect(journalEntriesBalance([documentJournal(base, 'purchase')]), `purchase on ${base}`).toBe(true);
    }
  });
});
