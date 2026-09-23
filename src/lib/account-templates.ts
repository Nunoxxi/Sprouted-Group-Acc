export type AccountType =
  | 'ASSET'
  | 'LIABILITY'
  | 'EQUITY'
  | 'INCOME'
  | 'COST_OF_SALES'
  | 'EXPENSE';

export type AccountTemplate = {
  code: string;
  name: string;
  type: AccountType;
  parentCode?: string;
  category?: string;
};

export const sharedTaxAccounts: AccountTemplate[] = [
  { code: '1101', name: 'VAT Input Tax Recoverable', type: 'ASSET', parentCode: '1000', category: 'tax' },
  { code: '1102', name: 'NHIL Input Tax Recoverable', type: 'ASSET', parentCode: '1000', category: 'tax' },
  { code: '1103', name: 'GETFund Input Tax Recoverable', type: 'ASSET', parentCode: '1000', category: 'tax' },
  { code: '1105', name: 'Withholding Tax Receivable', type: 'ASSET', parentCode: '1000', category: 'tax' },
  { code: '2020', name: 'VAT Output Tax Payable', type: 'LIABILITY', parentCode: '2000', category: 'tax' },
  { code: '2025', name: 'NHIL Payable', type: 'LIABILITY', parentCode: '2000', category: 'tax' },
  { code: '2030', name: 'GETFund Payable', type: 'LIABILITY', parentCode: '2000', category: 'tax' },
  { code: '2035', name: 'Withholding Tax Payable', type: 'LIABILITY', parentCode: '2000', category: 'tax' },
  { code: '2040', name: 'PAYE Payable', type: 'LIABILITY', parentCode: '2000', category: 'tax' },
  { code: '2045', name: 'SSNIT Tier 1 Payable', type: 'LIABILITY', parentCode: '2000', category: 'tax' },
];

/** Stock adjustments, NRV write-downs and shrinkage beyond tolerance post here; see src/lib/inventory.ts and trading.ts. */
export const sharedInventoryAccounts: AccountTemplate[] = [
  { code: '5030', name: 'Inventory Adjustments', type: 'COST_OF_SALES', parentCode: '5000', category: 'inventory-adjustment' },
  { code: '5035', name: 'Inventory Write-downs (NRV)', type: 'COST_OF_SALES', parentCode: '5000', category: 'inventory-adjustment' },
  { code: '5045', name: 'Stock Loss (beyond shrinkage tolerance)', type: 'COST_OF_SALES', parentCode: '5000', category: 'inventory-adjustment' },
];

/** Cash advanced to buying agents: a receivable until produce or cash comes back. Traders only. */
export const agentFloatAccounts: AccountTemplate[] = [
  { code: '1060', name: 'Agent Float Advances', type: 'ASSET', parentCode: '1000', category: 'agent-float' },
];

/** Sales contracts and COCOBOD Licensed Buying Company mode; see src/lib/contracts.ts. Traders only. */
export const contractAccounts: AccountTemplate[] = [
  { code: '1065', name: 'COCOBOD Receivable', type: 'ASSET', parentCode: '1000', category: 'lbc' },
  { code: '2050', name: 'COCOBOD Seed Fund Payable', type: 'LIABILITY', parentCode: '2000', category: 'lbc' },
  { code: '4020', name: "Buyer's Margin (COCOBOD)", type: 'INCOME', parentCode: '4000', category: 'lbc' },
  { code: '4025', name: 'Haulage Allowance (COCOBOD)', type: 'INCOME', parentCode: '4000', category: 'lbc' },
  { code: '4030', name: 'Cocoa Pass-through (net presentation)', type: 'INCOME', parentCode: '4000', category: 'lbc' },
  { code: '6045', name: 'Export Permits & Levies', type: 'EXPENSE', parentCode: '6000' },
];

// Foreign exchange. Realised: the difference between what a foreign document
// was booked at and what the bank actually gave on settlement. Unrealised:
// period-end revaluation of open foreign monetary balances at the closing
// rate. Both are expense-type accounts where a credit balance is a net gain.
/**
 * Grant management, on the programme chart only: deferred grant income for
 * the policy that holds money until it is earned, and the two sides of a
 * donated good or service, grossed up. See src/lib/grants.ts.
 */
export const grantManagementAccounts: AccountTemplate[] = [
  { code: '2070', name: 'Deferred Grant Income', type: 'LIABILITY', parentCode: '2000', category: 'grant' },
  { code: '4035', name: 'Donated Goods & Services (in kind)', type: 'INCOME', parentCode: '4000', category: 'in-kind' },
  { code: '6055', name: 'In-kind Goods & Services Used', type: 'EXPENSE', parentCode: '6000', category: 'in-kind' },
];

/** Opening balances: the trial balance's control accounts land here until the detail imports clear it. Every chart. */
export const openingAccounts: AccountTemplate[] = [
  { code: '3090', name: 'Opening Balance Suspense', type: 'EQUITY', parentCode: '3000', category: 'opening' },
];

/** Advances to farmers, and what is owed to them for produce already received. Traders only. */
export const farmerAdvanceAccounts: AccountTemplate[] = [
  { code: '1070', name: 'Farmer Advances', type: 'ASSET', parentCode: '1000', category: 'farmer-advance' },
  { code: '2060', name: 'Farmer Payables', type: 'LIABILITY', parentCode: '2000', category: 'farmer-payable' },
];

/**
 * Mobile money wallets are ordinary bank accounts; their transaction fees and
 * levies go here rather than being left as unmatched differences on the
 * statement. Every chart — all three entities hold wallets.
 */
/**
 * Fixed assets and company tax. Every chart: all three entities own things
 * that wear out, and an exempt entity still depreciates them — it simply has
 * no computation. The depreciation *expense* is found by category, because
 * the two charts number it differently.
 */
/**
 * Payroll. There is no payroll engine: the summary is imported and posted.
 * PAYE and SSNIT tier 1 already exist among the tax accounts; tier 2, net pay
 * and the employer's own contribution are added here. Every chart.
 */
export const payrollAccounts: AccountTemplate[] = [
  { code: '2046', name: 'SSNIT Tier 2 Payable', type: 'LIABILITY', parentCode: '2000', category: 'payroll-liability' },
  { code: '2047', name: 'Net Pay Payable', type: 'LIABILITY', parentCode: '2000', category: 'payroll-liability' },
  { code: '6065', name: 'Employer SSNIT Contributions', type: 'EXPENSE', parentCode: '6000', category: 'employer-ssnit' },
];

export const fixedAssetAccounts: AccountTemplate[] = [
  { code: '1200', name: 'Fixed Assets at Cost', type: 'ASSET', parentCode: '1000', category: 'fixed-asset' },
  { code: '1205', name: 'Accumulated Depreciation', type: 'ASSET', parentCode: '1200', category: 'accumulated-depreciation' },
  { code: '7030', name: 'Gain or Loss on Asset Disposal', type: 'EXPENSE', category: 'asset-disposal' },
  { code: '2055', name: 'Corporate Income Tax Payable', type: 'LIABILITY', parentCode: '2000', category: 'income-tax' },
  { code: '7040', name: 'Corporate Income Tax', type: 'EXPENSE', category: 'income-tax' },
];

export const mobileMoneyAccounts: AccountTemplate[] = [
  { code: '6050', name: 'Mobile Money Charges & Levies', type: 'EXPENSE', parentCode: '6000', category: 'momo-charges' },
];

/**
 * Exchange differences, split by which way they went rather than by realised
 * and unrealised. A gain is income; a loss is a finance cost in the 8000s, the
 * same numbering on every entity. Whether a difference was realised on
 * settlement or is still only on paper is carried by the journal that made it
 * - a revaluation entry, which reverses - not by a separate account.
 */
export const sharedFxAccounts: AccountTemplate[] = [
  { code: '4015', name: 'Foreign Exchange Gain', type: 'INCOME', category: 'fx-gain' },
  { code: '8001', name: 'Foreign Exchange Loss', type: 'EXPENSE', category: 'fx-loss' },
];

export const manufacturingAccounts: AccountTemplate[] = [
  { code: '1001', name: 'Cash and Bank', type: 'ASSET', parentCode: '1000' },
  { code: '1005', name: 'Petty Cash', type: 'ASSET', parentCode: '1000' },
  { code: '1010', name: 'Trade Receivables', type: 'ASSET', parentCode: '1000' },
  { code: '1015', name: 'Domestic Receivables', type: 'ASSET', parentCode: '1010' },
  { code: '1020', name: 'Export Receivables', type: 'ASSET', parentCode: '1010' },
  { code: '1025', name: 'Intercompany Receivable - Sprouted Roots', type: 'ASSET', parentCode: '1010' },
  { code: '1026', name: 'Intercompany Receivable - Sprouted Crafts', type: 'ASSET', parentCode: '1010' },
  { code: '1027', name: 'Intercompany Receivable - Oikazi', type: 'ASSET', parentCode: '1010' },
  { code: '1030', name: 'Raw Materials Inventory', type: 'ASSET', parentCode: '1000', category: 'inventory' },
  { code: '1035', name: 'Packaging Materials Inventory', type: 'ASSET', parentCode: '1000', category: 'inventory' },
  { code: '1040', name: 'Work in Progress Inventory', type: 'ASSET', parentCode: '1000', category: 'inventory' },
  { code: '1045', name: 'Finished Goods Inventory', type: 'ASSET', parentCode: '1000', category: 'inventory' },
  { code: '1050', name: 'Goods in Transit', type: 'ASSET', parentCode: '1000', category: 'inventory' },
  { code: '2001', name: 'Trade Payables', type: 'LIABILITY', parentCode: '2000' },
  { code: '2005', name: 'Domestic Payables', type: 'LIABILITY', parentCode: '2001' },
  { code: '2010', name: 'Export Payables', type: 'LIABILITY', parentCode: '2001' },
  { code: '2015', name: 'Intercompany Payable - Sprouted Roots', type: 'LIABILITY', parentCode: '2001' },
  { code: '2016', name: 'Intercompany Payable - Sprouted Crafts', type: 'LIABILITY', parentCode: '2001' },
  { code: '2017', name: 'Intercompany Payable - Oikazi', type: 'LIABILITY', parentCode: '2001' },
  { code: '3001', name: 'Share Capital', type: 'EQUITY', parentCode: '3000' },
  { code: '3005', name: 'Retained Earnings', type: 'EQUITY', parentCode: '3000' },
  { code: '4001', name: 'Domestic Sales', type: 'INCOME', parentCode: '4000' },
  { code: '4005', name: 'Export Sales', type: 'INCOME', parentCode: '4000' },
  { code: '4010', name: 'Other Operating Income', type: 'INCOME', parentCode: '4000' },
  { code: '5001', name: 'Raw Materials Used', type: 'COST_OF_SALES', parentCode: '5000' },
  { code: '5005', name: 'Direct Labour', type: 'COST_OF_SALES', parentCode: '5000' },
  { code: '5010', name: 'Factory Overhead', type: 'COST_OF_SALES', parentCode: '5000' },
  { code: '5015', name: 'Production Labour Allocation', type: 'COST_OF_SALES', parentCode: '5000' },
  { code: '5020', name: 'Finished Goods Movement Adjustment', type: 'COST_OF_SALES', parentCode: '5000' },
  { code: '5025', name: 'Cost of Goods Sold', type: 'COST_OF_SALES', parentCode: '5000' },
  { code: '6001', name: 'Factory Utilities', type: 'EXPENSE', parentCode: '6000' },
  { code: '6005', name: 'Factory Repairs & Maintenance', type: 'EXPENSE', parentCode: '6000' },
  { code: '6010', name: 'Production Salaries', type: 'EXPENSE', parentCode: '6000' },
  { code: '6015', name: 'Staff Welfare', type: 'EXPENSE', parentCode: '6000' },
  { code: '6020', name: 'Transport & Logistics', type: 'EXPENSE', parentCode: '6000' },
  { code: '6025', name: 'Freight & Clearing', type: 'EXPENSE', parentCode: '6000' },
  { code: '6030', name: 'Administration', type: 'EXPENSE', parentCode: '6000' },
  { code: '6035', name: 'Bank Charges', type: 'EXPENSE', parentCode: '6000' },
  { code: '6040', name: 'Depreciation', type: 'EXPENSE', parentCode: '6000', category: 'depreciation' },
  ...sharedTaxAccounts,
  ...sharedInventoryAccounts,
  ...agentFloatAccounts,
  ...farmerAdvanceAccounts,
  ...contractAccounts,
  ...mobileMoneyAccounts,
  ...fixedAssetAccounts,
  ...payrollAccounts,
  ...openingAccounts,
  ...sharedFxAccounts,
];

export const ngoAccounts: AccountTemplate[] = [
  // --- assets -------------------------------------------------------------
  // 1001 is the default bank account every entity starts with, and 1010 is
  // the receivables control every invoice debits; both are fixed by code
  // elsewhere, so they keep their numbers.
  { code: '1001', name: 'Bank - Operating Account (GHS)', type: 'ASSET' },
  { code: '1005', name: 'Cash on Hand / Petty Cash', type: 'ASSET' },
  { code: '1008', name: 'Bank - Foreign Currency (USD)', type: 'ASSET' },
  { code: '1009', name: 'Bank - Foreign Currency (EUR)', type: 'ASSET' },
  { code: '1010', name: 'Grants & Contracts Receivable', type: 'ASSET' },
  { code: '1012', name: 'Mobile Money Account', type: 'ASSET' },
  { code: '1015', name: 'Other Receivables', type: 'ASSET' },
  { code: '1025', name: 'Intercompany Receivable - Sprouted Crafts', type: 'ASSET' },
  { code: '1026', name: 'Intercompany Receivable - Oikazi', type: 'ASSET' },
  { code: '1040', name: 'Staff Advances', type: 'ASSET' },
  { code: '1045', name: 'Prepayments', type: 'ASSET' },
  // Asset classes hang off 1200 Fixed Assets at Cost. The audited register
  // holds no vehicles: they are hired, so vehicle spend is an expense.
  { code: '1210', name: 'Computers & Accessories', type: 'ASSET', parentCode: '1200' },
  { code: '1215', name: 'Furniture & Fittings', type: 'ASSET', parentCode: '1200' },
  { code: '1220', name: 'Office Equipment', type: 'ASSET', parentCode: '1200' },

  // --- liabilities --------------------------------------------------------
  { code: '2001', name: 'Accounts Payable', type: 'LIABILITY' },
  { code: '2005', name: 'Accrued Expenses', type: 'LIABILITY' },
  { code: '2010', name: 'Intercompany Payable - Sprouted Crafts', type: 'LIABILITY' },
  { code: '2011', name: 'Intercompany Payable - Oikazi', type: 'LIABILITY' },
  { code: '2015', name: 'Other Payables', type: 'LIABILITY' },
  { code: '2048', name: 'Provident Fund Payable', type: 'LIABILITY' },
  { code: '2075', name: 'Funds Repayable to Donors', type: 'LIABILITY' },

  // --- funds --------------------------------------------------------------
  // Restriction is a property of the fund, never of an expense account.
  { code: '3001', name: 'Unrestricted Accumulated Fund', type: 'EQUITY' },
  { code: '3020', name: 'Restricted Fund - Human Rights & Communities', type: 'EQUITY' },
  { code: '3021', name: 'Restricted Fund - Productivity, Environment, Health & Safety', type: 'EQUITY' },
  { code: '3022', name: 'Restricted Fund - Traceability + Data', type: 'EQUITY' },
  { code: '3023', name: 'Restricted Fund - Strong Coops', type: 'EQUITY' },
  { code: '3024', name: 'Restricted Fund - Bridge Fund', type: 'EQUITY' },

  // --- income -------------------------------------------------------------
  { code: '4001', name: 'Unrestricted Grant Income', type: 'INCOME' },
  { code: '4005', name: 'Restricted Grant Income', type: 'INCOME' },
  { code: '4010', name: 'Service Contract Revenue', type: 'INCOME' },
  { code: '4020', name: 'Other Income', type: 'INCOME' },

  // --- direct project costs -----------------------------------------------
  // The nature of the cost only. Which programme it belongs to is the project
  // on the transaction line, so there is one Training account, not one per
  // programme area.
  { code: '5001', name: 'Training & Capacity Building', type: 'EXPENSE' },
  { code: '5005', name: 'Community & Cooperative Support', type: 'EXPENSE' },
  { code: '5010', name: 'Field Data Collection', type: 'EXPENSE' },
  { code: '5015', name: 'Mapping & Survey', type: 'EXPENSE' },
  { code: '5020', name: 'Inputs & Seedlings', type: 'EXPENSE' },
  { code: '5025', name: 'Equipment for Partners', type: 'EXPENSE' },
  { code: '5040', name: 'Consultants & Subcontractors', type: 'EXPENSE' },
  { code: '5050', name: 'Stakeholder Events', type: 'EXPENSE' },
  { code: '5055', name: 'Participant Costs', type: 'EXPENSE' },
  { code: '5060', name: 'Project Travel', type: 'EXPENSE' },

  // --- staff costs ---------------------------------------------------------
  // People are records, not accounts: no account per named role. The employer
  // SSNIT Tier 1 charge is 6065, shared with the other entities.
  { code: '6001', name: 'Salaries & Wages', type: 'EXPENSE' },
  { code: '6005', name: 'Per Diems', type: 'EXPENSE' },
  { code: '6010', name: 'Employer SSNIT Tier 2', type: 'EXPENSE' },
  { code: '6015', name: 'Provident Fund', type: 'EXPENSE' },
  { code: '6020', name: 'Staff Health Insurance', type: 'EXPENSE' },
  { code: '6025', name: 'Stipends & Interns', type: 'EXPENSE' },
  { code: '6030', name: 'Recruitment & Onboarding', type: 'EXPENSE' },
  { code: '6035', name: 'Staff Training & Development', type: 'EXPENSE' },

  // --- operating and administrative ----------------------------------------
  { code: '7001', name: 'Vehicle Running & Maintenance', type: 'EXPENSE' },
  { code: '7005', name: 'Fuel', type: 'EXPENSE' },
  { code: '7008', name: 'Vehicle Hire', type: 'EXPENSE' },
  { code: '7012', name: 'Office Rent', type: 'EXPENSE' },
  { code: '7015', name: 'Utilities', type: 'EXPENSE' },
  { code: '7018', name: 'Internet & Communications', type: 'EXPENSE' },
  { code: '7022', name: 'Office Supplies & Stationery', type: 'EXPENSE' },
  { code: '7025', name: 'Repairs & Maintenance', type: 'EXPENSE' },
  { code: '7028', name: 'Software & IT Subscriptions', type: 'EXPENSE' },
  { code: '7032', name: 'Regulatory & Compliance', type: 'EXPENSE' },
  { code: '7035', name: 'Legal & Professional Fees', type: 'EXPENSE' },
  { code: '7038', name: 'Audit & Accounting Fees', type: 'EXPENSE' },
  { code: '7045', name: 'Business Promotion', type: 'EXPENSE' },
  // Found by category, not by code: the two charts number it differently.
  { code: '7048', name: 'Depreciation', type: 'EXPENSE', category: 'depreciation' },
  { code: '7050', name: 'General Expenses', type: 'EXPENSE' },

  // --- finance --------------------------------------------------------------
  { code: '8005', name: 'Bank Interest & Charges', type: 'EXPENSE' },

  ...sharedTaxAccounts,
  ...sharedInventoryAccounts,
  ...mobileMoneyAccounts,
  ...fixedAssetAccounts,
  ...payrollAccounts,
  ...grantManagementAccounts,
  ...openingAccounts,
  ...sharedFxAccounts,
];

export const allSeedTemplates = {
  manufacturing: manufacturingAccounts,
  ngo: ngoAccounts,
  tax: sharedTaxAccounts,
  fx: sharedFxAccounts,
};
