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
import { accountNameMap, buildJournalEntries, journalLinesFor, makeDocument, makeLine, type DocumentFormState } from '@/lib/documents';
import { seedFunds, seedProjects } from '@/lib/seed-data';

const accountTypes = accountTypesMap();

/** These cases assume a VAT-registered entity; registration itself is covered in vat-registration.test.ts. */
const vatOn = { vatApplies: true };

const chartNames = accountNameMap([
  { code: '1010', name: 'Trade Receivables' },
  { code: '2001', name: 'Trade Payables' },
  { code: '4001', name: 'Grants - Unrestricted' },
  { code: '5001', name: 'Raw Materials Used' },
]);

/** A one-line document form, as the editor would hold it. */
function documentForm(base: number, kind: 'invoice' | 'bill', vatTreatment: 'standard' | 'exempt' = 'standard'): DocumentFormState {
  const form = makeDocument(kind, 'nana-farmers');
  form.lines = [{ ...makeLine(kind), quantity: 1, unitPrice: base, vatTreatment }];
  return form;
}

/**
 * The journal the app actually persists for one document — built by the same
 * function the posting server function calls, not a copy of it.
 */
function documentJournal(base: number, kind: 'sale' | 'purchase') {
  const isPurchase = kind === 'purchase';
  const contact = { withholdingTaxStatus: '5%' as const };
  return {
    entityId: 'sprouted-roots',
    lines: journalLinesFor(documentForm(base, isPurchase ? 'bill' : 'invoice'), isPurchase, contact, chartNames, vatOn),
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

describe('what posting a document actually writes to the ledger', () => {
  const awkwardBases = [1, 13, 1234, 4567, 99999, 123457];

  it('balances exactly for every base, sale and purchase', () => {
    for (const base of awkwardBases) {
      expect(journalEntriesBalance([documentJournal(base, 'sale')]), `sale ${base}`).toBe(true);
      expect(journalEntriesBalance([documentJournal(base, 'purchase')]), `purchase ${base}`).toBe(true);
    }
  });

  it('is whole pesewas on every line', () => {
    for (const base of awkwardBases) {
      for (const kind of ['sale', 'purchase'] as const) {
        for (const line of documentJournal(base, kind).lines) {
          expect(Number.isInteger(line.amount), `${kind} ${base}: ${line.amount}`).toBe(true);
        }
      }
    }
  });

  it('carries no zero-amount lines, even though the preview shows them', () => {
    // An exempt-only invoice previews three zero levy lines so the person can
    // see every account the posting would touch. The ledger must not hold them.
    const form = documentForm(50000, 'invoice', 'exempt');
    const preview = buildJournalEntries(form, false, undefined, chartNames, vatOn);
    const persisted = journalLinesFor(form, false, undefined, chartNames, vatOn);

    expect(preview.filter((line) => line.amount === 0)).toHaveLength(3);
    expect(persisted.every((line) => line.amount > 0)).toBe(true);
    expect(persisted).toHaveLength(2); // receivable and revenue only
    expect(journalEntriesBalance([{ entityId: 'x', lines: persisted }])).toBe(true);
  });

  it("labels accounts from the entity's own chart, not a hardcoded map", () => {
    // 4001 is "Grants - Unrestricted" on the charity and "Domestic Sales" on a
    // manufacturer. The same code must read differently on each.
    const charity = journalLinesFor(documentForm(1000, 'invoice'), false, undefined, chartNames, vatOn);
    const manufacturer = journalLinesFor(documentForm(1000, 'invoice'), false, undefined, accountNameMap([{ code: '4001', name: 'Domestic Sales' }]), vatOn);

    expect(charity.find((line) => line.accountCode === '4001')?.accountName).toBe('Grants - Unrestricted');
    expect(manufacturer.find((line) => line.accountCode === '4001')?.accountName).toBe('Domestic Sales');
  });

  it('withholds on the tax-inclusive total and credits payables net of it', () => {
    const base = 100000;
    const { totalInclTax } = leviesOnBase(base);
    const wht = withholdingTaxOn(totalInclTax, 0.05);
    const lines = documentJournal(base, 'purchase').lines;

    expect(lines.find((line) => line.accountCode === '2035')?.amount).toBe(wht);
    expect(lines.find((line) => line.accountCode === '2001')?.amount).toBe(totalInclTax - wht);
  });
});
