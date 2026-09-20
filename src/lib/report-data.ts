/** Shared report dataset: account classifications and demo ledger lines. */

export type AccountClass = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'COST_OF_SALES' | 'EXPENSE';
export type CashflowClass = 'operating' | 'investing' | 'financing' | 'cash';
export type ReportFund = 'restricted' | 'unrestricted';

export type LedgerLine = {
  id: string;
  entityId: string;
  date: string;
  document: string;
  contactName: string;
  accountCode: string;
  amount: number; // pesewas, debit positive / credit negative
  fund?: ReportFund;
  dueDate?: string;
};

export const reportAccounts: Record<string, { name: string; type: AccountClass; cashflow: CashflowClass }> = {
  '1001': { name: 'Bank — Ecobank Current', type: 'ASSET', cashflow: 'cash' },
  '1010': { name: 'Trade Receivables', type: 'ASSET', cashflow: 'operating' },
  '1020': { name: 'Inventory', type: 'ASSET', cashflow: 'operating' },
  '1101': { name: 'VAT Input Tax Recoverable', type: 'ASSET', cashflow: 'operating' },
  '1102': { name: 'NHIL Input Tax Recoverable', type: 'ASSET', cashflow: 'operating' },
  '1103': { name: 'GETFund Input Tax Recoverable', type: 'ASSET', cashflow: 'operating' },
  '1501': { name: 'Plant & Machinery', type: 'ASSET', cashflow: 'investing' },
  '2001': { name: 'Trade Payables', type: 'LIABILITY', cashflow: 'operating' },
  '2020': { name: 'VAT Output Tax Payable', type: 'LIABILITY', cashflow: 'operating' },
  '2025': { name: 'NHIL Payable', type: 'LIABILITY', cashflow: 'operating' },
  '2030': { name: 'GETFund Payable', type: 'LIABILITY', cashflow: 'operating' },
  '2035': { name: 'Withholding Tax Payable', type: 'LIABILITY', cashflow: 'operating' },
  '3001': { name: 'Retained Earnings', type: 'EQUITY', cashflow: 'financing' },
  '3010': { name: 'Share Capital', type: 'EQUITY', cashflow: 'financing' },
  '4001': { name: 'Domestic Sales', type: 'INCOME', cashflow: 'operating' },
  '4005': { name: 'Export Sales', type: 'INCOME', cashflow: 'operating' },
  '4010': { name: 'Grant Income — Restricted', type: 'INCOME', cashflow: 'operating' },
  '4015': { name: 'Grant Income — Unrestricted', type: 'INCOME', cashflow: 'operating' },
  '5001': { name: 'Raw Materials Used', type: 'COST_OF_SALES', cashflow: 'operating' },
  '5010': { name: 'Production Labour Allocation', type: 'COST_OF_SALES', cashflow: 'operating' },
  '6001': { name: 'Factory Utilities', type: 'EXPENSE', cashflow: 'operating' },
  '6005': { name: 'Factory Repairs & Maintenance', type: 'EXPENSE', cashflow: 'operating' },
  '6010': { name: 'Production Salaries', type: 'EXPENSE', cashflow: 'operating' },
  '7001': { name: 'Farmer Training Programme', type: 'EXPENSE', cashflow: 'operating' },
};

function ll(
  id: string,
  entityId: string,
  date: string,
  document: string,
  contactName: string,
  accountCode: string,
  amount: number,
  extra?: { fund?: ReportFund; dueDate?: string },
): LedgerLine {
  return { id, entityId, date, document, contactName, accountCode, amount, ...extra };
}

export const ledgerLines: LedgerLine[] = [
  // Sprouted Roots — opening balances
  ll('r-ob-1', 'sprouted-roots', '2026-07-31', 'OPEN-BAL', 'Opening balance', '1001', 8000000),
  ll('r-ob-2', 'sprouted-roots', '2026-07-31', 'OPEN-BAL', 'Opening balance', '1010', 2000000, { dueDate: '2026-08-30' }),
  ll('r-ob-3', 'sprouted-roots', '2026-07-31', 'OPEN-BAL', 'Opening balance', '2001', -1500000, { dueDate: '2026-08-29' }),
  ll('r-ob-4', 'sprouted-roots', '2026-07-31', 'OPEN-BAL', 'Opening balance', '3001', -8500000),
  // Sprouted Roots — August
  ll('r-01a', 'sprouted-roots', '2026-08-05', 'INV-0998', 'Cocoa Partners Limited', '1010', 2400000, { dueDate: '2026-09-04' }),
  ll('r-01b', 'sprouted-roots', '2026-08-05', 'INV-0998', 'Cocoa Partners Limited', '4001', -2000000),
  ll('r-01c', 'sprouted-roots', '2026-08-05', 'INV-0998', 'Cocoa Partners Limited', '2020', -300000),
  ll('r-01d', 'sprouted-roots', '2026-08-05', 'INV-0998', 'Cocoa Partners Limited', '2025', -50000),
  ll('r-01e', 'sprouted-roots', '2026-08-05', 'INV-0998', 'Cocoa Partners Limited', '2030', -50000),
  ll('r-02a', 'sprouted-roots', '2026-08-12', 'BILL-3110', 'Nana Akua Farms', '5001', 1200000),
  ll('r-02b', 'sprouted-roots', '2026-08-12', 'BILL-3110', 'Nana Akua Farms', '1101', 180000),
  ll('r-02c', 'sprouted-roots', '2026-08-12', 'BILL-3110', 'Nana Akua Farms', '1102', 30000),
  ll('r-02d', 'sprouted-roots', '2026-08-12', 'BILL-3110', 'Nana Akua Farms', '1103', 30000),
  ll('r-02e', 'sprouted-roots', '2026-08-12', 'BILL-3110', 'Nana Akua Farms', '2001', -1368000, { dueDate: '2026-09-11' }),
  ll('r-02f', 'sprouted-roots', '2026-08-12', 'BILL-3110', 'Nana Akua Farms', '2035', -72000),
  ll('r-03a', 'sprouted-roots', '2026-08-15', 'GRANT-015', 'EDA Foundation', '1001', 5000000, { fund: 'restricted' }),
  ll('r-03b', 'sprouted-roots', '2026-08-15', 'GRANT-015', 'EDA Foundation', '4010', -5000000, { fund: 'restricted' }),
  ll('r-04a', 'sprouted-roots', '2026-08-20', 'GRANT-016', 'Mastercard Foundation', '1001', 3000000, { fund: 'unrestricted' }),
  ll('r-04b', 'sprouted-roots', '2026-08-20', 'GRANT-016', 'Mastercard Foundation', '4015', -3000000, { fund: 'unrestricted' }),
  ll('r-05a', 'sprouted-roots', '2026-08-25', 'PROG-045', 'Farmer training cohort 4', '7001', 700000, { fund: 'restricted' }),
  ll('r-05b', 'sprouted-roots', '2026-08-25', 'PROG-045', 'Farmer training cohort 4', '1001', -700000, { fund: 'restricted' }),
  // Sprouted Roots — September
  ll('r-06a', 'sprouted-roots', '2026-09-02', 'INV-1042', 'Cocoa Partners Limited', '1010', 1800000, { dueDate: '2026-10-02' }),
  ll('r-06b', 'sprouted-roots', '2026-09-02', 'INV-1042', 'Cocoa Partners Limited', '4001', -1500000),
  ll('r-06c', 'sprouted-roots', '2026-09-02', 'INV-1042', 'Cocoa Partners Limited', '2020', -225000),
  ll('r-06d', 'sprouted-roots', '2026-09-02', 'INV-1042', 'Cocoa Partners Limited', '2025', -37500),
  ll('r-06e', 'sprouted-roots', '2026-09-02', 'INV-1042', 'Cocoa Partners Limited', '2030', -37500),
  ll('r-07a', 'sprouted-roots', '2026-09-08', 'BILL-3155', 'Accra Packaging Co', '5001', 400000),
  ll('r-07b', 'sprouted-roots', '2026-09-08', 'BILL-3155', 'Accra Packaging Co', '1101', 60000),
  ll('r-07c', 'sprouted-roots', '2026-09-08', 'BILL-3155', 'Accra Packaging Co', '1102', 10000),
  ll('r-07d', 'sprouted-roots', '2026-09-08', 'BILL-3155', 'Accra Packaging Co', '1103', 10000),
  ll('r-07e', 'sprouted-roots', '2026-09-08', 'BILL-3155', 'Accra Packaging Co', '2001', -456000, { dueDate: '2026-10-08' }),
  ll('r-07f', 'sprouted-roots', '2026-09-08', 'BILL-3155', 'Accra Packaging Co', '2035', -24000),
  ll('r-08a', 'sprouted-roots', '2026-09-12', 'PROG-052', 'Farmer training cohort 5', '7001', 900000, { fund: 'restricted' }),
  ll('r-08b', 'sprouted-roots', '2026-09-12', 'PROG-052', 'Farmer training cohort 5', '1001', -900000, { fund: 'restricted' }),
  ll('r-09a', 'sprouted-roots', '2026-09-15', 'BILL-3161', 'Nana Akua Farms', '5001', 800000),
  ll('r-09b', 'sprouted-roots', '2026-09-15', 'BILL-3161', 'Nana Akua Farms', '1101', 120000),
  ll('r-09c', 'sprouted-roots', '2026-09-15', 'BILL-3161', 'Nana Akua Farms', '1102', 20000),
  ll('r-09d', 'sprouted-roots', '2026-09-15', 'BILL-3161', 'Nana Akua Farms', '1103', 20000),
  ll('r-09e', 'sprouted-roots', '2026-09-15', 'BILL-3161', 'Nana Akua Farms', '2001', -912000, { dueDate: '2026-10-15' }),
  ll('r-09f', 'sprouted-roots', '2026-09-15', 'BILL-3161', 'Nana Akua Farms', '2035', -48000),
  ll('r-10a', 'sprouted-roots', '2026-09-18', 'ADMIN-031', 'Office utilities', '6001', 150000, { fund: 'unrestricted' }),
  ll('r-10b', 'sprouted-roots', '2026-09-18', 'ADMIN-031', 'Office utilities', '1001', -150000, { fund: 'unrestricted' }),
  // Sprouted Crafts — opening balances
  ll('c-ob-1', 'sprouted-crafts', '2026-07-31', 'OPEN-BAL', 'Opening balance', '1001', 12000000),
  ll('c-ob-2', 'sprouted-crafts', '2026-07-31', 'OPEN-BAL', 'Opening balance', '1501', 6000000),
  ll('c-ob-3', 'sprouted-crafts', '2026-07-31', 'OPEN-BAL', 'Opening balance', '2001', -2000000, { dueDate: '2026-08-27' }),
  ll('c-ob-4', 'sprouted-crafts', '2026-07-31', 'OPEN-BAL', 'Opening balance', '3001', -16000000),
  // Sprouted Crafts — August
  ll('c-01a', 'sprouted-crafts', '2026-08-03', 'INV-2081', 'Cocoa Partners Limited', '1010', 3600000, { dueDate: '2026-09-02' }),
  ll('c-01b', 'sprouted-crafts', '2026-08-03', 'INV-2081', 'Cocoa Partners Limited', '4001', -3000000),
  ll('c-01c', 'sprouted-crafts', '2026-08-03', 'INV-2081', 'Cocoa Partners Limited', '2020', -450000),
  ll('c-01d', 'sprouted-crafts', '2026-08-03', 'INV-2081', 'Cocoa Partners Limited', '2025', -75000),
  ll('c-01e', 'sprouted-crafts', '2026-08-03', 'INV-2081', 'Cocoa Partners Limited', '2030', -75000),
  ll('c-02a', 'sprouted-crafts', '2026-08-10', 'CAPEX-014', 'Ghana Machinery Ltd', '1501', 4000000),
  ll('c-02b', 'sprouted-crafts', '2026-08-10', 'CAPEX-014', 'Ghana Machinery Ltd', '1001', -4000000),
  ll('c-03a', 'sprouted-crafts', '2026-08-20', 'BILL-2190', 'Sprouted Roots', '5001', 1284000),
  ll('c-03b', 'sprouted-crafts', '2026-08-20', 'BILL-2190', 'Sprouted Roots', '1101', 192600),
  ll('c-03c', 'sprouted-crafts', '2026-08-20', 'BILL-2190', 'Sprouted Roots', '1102', 32100),
  ll('c-03d', 'sprouted-crafts', '2026-08-20', 'BILL-2190', 'Sprouted Roots', '1103', 32100),
  ll('c-03e', 'sprouted-crafts', '2026-08-20', 'BILL-2190', 'Sprouted Roots', '2001', -1463760, { dueDate: '2026-09-19' }),
  ll('c-03f', 'sprouted-crafts', '2026-08-20', 'BILL-2190', 'Sprouted Roots', '2035', -77040),
  // Sprouted Crafts — September
  ll('c-04a', 'sprouted-crafts', '2026-09-05', 'INV-2102', 'Cocoa Partners Limited', '1010', 2640000, { dueDate: '2026-10-05' }),
  ll('c-04b', 'sprouted-crafts', '2026-09-05', 'INV-2102', 'Cocoa Partners Limited', '4001', -2200000),
  ll('c-04c', 'sprouted-crafts', '2026-09-05', 'INV-2102', 'Cocoa Partners Limited', '2020', -330000),
  ll('c-04d', 'sprouted-crafts', '2026-09-05', 'INV-2102', 'Cocoa Partners Limited', '2025', -55000),
  ll('c-04e', 'sprouted-crafts', '2026-09-05', 'INV-2102', 'Cocoa Partners Limited', '2030', -55000),
  ll('c-05a', 'sprouted-crafts', '2026-09-10', 'BILL-2201', 'Akwasi Logistics', '6001', 456000),
  ll('c-05b', 'sprouted-crafts', '2026-09-10', 'BILL-2201', 'Akwasi Logistics', '1101', 68400),
  ll('c-05c', 'sprouted-crafts', '2026-09-10', 'BILL-2201', 'Akwasi Logistics', '1102', 11400),
  ll('c-05d', 'sprouted-crafts', '2026-09-10', 'BILL-2201', 'Akwasi Logistics', '1103', 11400),
  ll('c-05e', 'sprouted-crafts', '2026-09-10', 'BILL-2201', 'Akwasi Logistics', '2001', -519840, { dueDate: '2026-10-10' }),
  ll('c-05f', 'sprouted-crafts', '2026-09-10', 'BILL-2201', 'Akwasi Logistics', '2035', -27360),
  ll('c-06a', 'sprouted-crafts', '2026-09-18', 'BILL-2210', 'Sprouted Roots', '5001', 1000000),
  ll('c-06b', 'sprouted-crafts', '2026-09-18', 'BILL-2210', 'Sprouted Roots', '1101', 150000),
  ll('c-06c', 'sprouted-crafts', '2026-09-18', 'BILL-2210', 'Sprouted Roots', '1102', 25000),
  ll('c-06d', 'sprouted-crafts', '2026-09-18', 'BILL-2210', 'Sprouted Roots', '1103', 25000),
  ll('c-06e', 'sprouted-crafts', '2026-09-18', 'BILL-2210', 'Sprouted Roots', '2001', -1140000, { dueDate: '2026-10-18' }),
  ll('c-06f', 'sprouted-crafts', '2026-09-18', 'BILL-2210', 'Sprouted Roots', '2035', -60000),
  ll('c-07a', 'sprouted-crafts', '2026-09-25', 'SAL-0905', 'September payroll', '6010', 2500000),
  ll('c-07b', 'sprouted-crafts', '2026-09-25', 'SAL-0905', 'September payroll', '1001', -2500000),
  // Oikazi — opening balances
  ll('o-ob-1', 'oikazi', '2026-07-31', 'OPEN-BAL', 'Opening balance', '1001', 10000000),
  ll('o-ob-2', 'oikazi', '2026-07-31', 'OPEN-BAL', 'Opening balance', '1020', 3000000),
  ll('o-ob-3', 'oikazi', '2026-07-31', 'OPEN-BAL', 'Opening balance', '3001', -13000000),
  // Oikazi — August
  ll('o-01a', 'oikazi', '2026-08-08', 'INV-3011', 'Cocoa Partners Limited', '1010', 2160000, { dueDate: '2026-09-07' }),
  ll('o-01b', 'oikazi', '2026-08-08', 'INV-3011', 'Cocoa Partners Limited', '4005', -1800000),
  ll('o-01c', 'oikazi', '2026-08-08', 'INV-3011', 'Cocoa Partners Limited', '2020', -270000),
  ll('o-01d', 'oikazi', '2026-08-08', 'INV-3011', 'Cocoa Partners Limited', '2025', -45000),
  ll('o-01e', 'oikazi', '2026-08-08', 'INV-3011', 'Cocoa Partners Limited', '2030', -45000),
  ll('o-02a', 'oikazi', '2026-08-25', 'BILL-4102', 'Tema Haulage', '6001', 600000),
  ll('o-02b', 'oikazi', '2026-08-25', 'BILL-4102', 'Tema Haulage', '1101', 90000),
  ll('o-02c', 'oikazi', '2026-08-25', 'BILL-4102', 'Tema Haulage', '1102', 15000),
  ll('o-02d', 'oikazi', '2026-08-25', 'BILL-4102', 'Tema Haulage', '1103', 15000),
  ll('o-02e', 'oikazi', '2026-08-25', 'BILL-4102', 'Tema Haulage', '2001', -648000, { dueDate: '2026-09-24' }),
  ll('o-02f', 'oikazi', '2026-08-25', 'BILL-4102', 'Tema Haulage', '2035', -72000),
  // Oikazi — September
  ll('o-03a', 'oikazi', '2026-09-04', 'INV-3026', 'Cocoa Partners Limited', '1010', 2940000, { dueDate: '2026-10-04' }),
  ll('o-03b', 'oikazi', '2026-09-04', 'INV-3026', 'Cocoa Partners Limited', '4005', -2450000),
  ll('o-03c', 'oikazi', '2026-09-04', 'INV-3026', 'Cocoa Partners Limited', '2020', -367500),
  ll('o-03d', 'oikazi', '2026-09-04', 'INV-3026', 'Cocoa Partners Limited', '2025', -61250),
  ll('o-03e', 'oikazi', '2026-09-04', 'INV-3026', 'Cocoa Partners Limited', '2030', -61250),
  ll('o-04a', 'oikazi', '2026-09-11', 'BILL-4118', 'Tema Haulage', '6001', 680000),
  ll('o-04b', 'oikazi', '2026-09-11', 'BILL-4118', 'Tema Haulage', '1101', 102000),
  ll('o-04c', 'oikazi', '2026-09-11', 'BILL-4118', 'Tema Haulage', '1102', 17000),
  ll('o-04d', 'oikazi', '2026-09-11', 'BILL-4118', 'Tema Haulage', '1103', 17000),
  ll('o-04e', 'oikazi', '2026-09-11', 'BILL-4118', 'Tema Haulage', '2001', -734400, { dueDate: '2026-10-11' }),
  ll('o-04f', 'oikazi', '2026-09-11', 'BILL-4118', 'Tema Haulage', '2035', -81600),
  ll('o-05a', 'oikazi', '2026-09-19', 'BILL-4122', 'Accra Packaging Co', '5001', 240000),
  ll('o-05b', 'oikazi', '2026-09-19', 'BILL-4122', 'Accra Packaging Co', '1101', 36000),
  ll('o-05c', 'oikazi', '2026-09-19', 'BILL-4122', 'Accra Packaging Co', '1102', 6000),
  ll('o-05d', 'oikazi', '2026-09-19', 'BILL-4122', 'Accra Packaging Co', '1103', 6000),
  ll('o-05e', 'oikazi', '2026-09-19', 'BILL-4122', 'Accra Packaging Co', '2001', -288000, { dueDate: '2026-10-19' }),
  ll('o-06a', 'oikazi', '2026-09-25', 'SAL-0910', 'September payroll', '6010', 1800000),
  ll('o-06b', 'oikazi', '2026-09-25', 'SAL-0910', 'September payroll', '1001', -1800000),
];

export function accountTypesMap(): Record<string, AccountClass> {
  return Object.fromEntries(
    Object.entries(reportAccounts).map(([code, account]) => [code, account.type]),
  );
}

export const entityIds = ['sprouted-roots', 'sprouted-crafts', 'oikazi'];


