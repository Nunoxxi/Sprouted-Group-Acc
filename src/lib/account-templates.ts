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
  { code: '2045', name: 'SSNIT Payable', type: 'LIABILITY', parentCode: '2000', category: 'tax' },
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
  { code: '1030', name: 'Raw Materials Inventory', type: 'ASSET', parentCode: '1000' },
  { code: '1035', name: 'Packaging Materials Inventory', type: 'ASSET', parentCode: '1000' },
  { code: '1040', name: 'Work in Progress Inventory', type: 'ASSET', parentCode: '1000' },
  { code: '1045', name: 'Finished Goods Inventory', type: 'ASSET', parentCode: '1000' },
  { code: '1050', name: 'Goods in Transit', type: 'ASSET', parentCode: '1000' },
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
  { code: '6040', name: 'Depreciation', type: 'EXPENSE', parentCode: '6000' },
  ...sharedTaxAccounts,
];

export const ngoAccounts: AccountTemplate[] = [
  { code: '1001', name: 'Cash and Bank', type: 'ASSET', parentCode: '1000' },
  { code: '1005', name: 'Petty Cash', type: 'ASSET', parentCode: '1000' },
  { code: '1010', name: 'Trade Receivables', type: 'ASSET', parentCode: '1000' },
  { code: '1015', name: 'Grants Receivable', type: 'ASSET', parentCode: '1010' },
  { code: '1020', name: 'Donations Receivable', type: 'ASSET', parentCode: '1010' },
  { code: '1025', name: 'Intercompany Receivable - Sprouted Crafts', type: 'ASSET', parentCode: '1010' },
  { code: '1026', name: 'Intercompany Receivable - Oikazi', type: 'ASSET', parentCode: '1010' },
  { code: '1030', name: 'Aggregation Inventory', type: 'ASSET', parentCode: '1000' },
  { code: '1035', name: 'Farm Inputs Inventory', type: 'ASSET', parentCode: '1000' },
  { code: '1040', name: 'Program Advances', type: 'ASSET', parentCode: '1000' },
  { code: '2001', name: 'Trade Payables', type: 'LIABILITY', parentCode: '2000' },
  { code: '2005', name: 'Supplier Payables', type: 'LIABILITY', parentCode: '2001' },
  { code: '2010', name: 'Intercompany Payable - Sprouted Crafts', type: 'LIABILITY', parentCode: '2001' },
  { code: '2011', name: 'Intercompany Payable - Oikazi', type: 'LIABILITY', parentCode: '2001' },
  { code: '3001', name: 'Net Assets', type: 'EQUITY', parentCode: '3000' },
  { code: '3005', name: 'Restricted Funds', type: 'EQUITY', parentCode: '3001' },
  { code: '3010', name: 'Unrestricted Funds', type: 'EQUITY', parentCode: '3001' },
  { code: '3015', name: 'Accumulated Surplus', type: 'EQUITY', parentCode: '3001' },
  { code: '4001', name: 'Grants - Unrestricted', type: 'INCOME', parentCode: '4000' },
  { code: '4005', name: 'Grants - Restricted', type: 'INCOME', parentCode: '4000' },
  { code: '4010', name: 'Donations - General', type: 'INCOME', parentCode: '4000' },
  { code: '4015', name: 'Donations - Restricted', type: 'INCOME', parentCode: '4000' },
  { code: '4020', name: 'Program Service Income', type: 'INCOME', parentCode: '4000' },
  { code: '4025', name: 'Aggregation & Sourcing Income', type: 'INCOME', parentCode: '4000' },
  { code: '4030', name: 'Other Income', type: 'INCOME', parentCode: '4000' },
  { code: '5001', name: 'Aggregation Purchase Cost', type: 'COST_OF_SALES', parentCode: '5000' },
  { code: '5005', name: 'Sourcing & Procurement Cost', type: 'COST_OF_SALES', parentCode: '5000' },
  { code: '5010', name: 'Program Materials Consumed', type: 'COST_OF_SALES', parentCode: '5000' },
  { code: '5015', name: 'Direct Program Delivery Cost', type: 'COST_OF_SALES', parentCode: '5000' },
  { code: '5020', name: 'Farmer Support & Inputs', type: 'COST_OF_SALES', parentCode: '5000' },
  { code: '6001', name: 'Program Expenditure', type: 'EXPENSE', parentCode: '6000' },
  { code: '6005', name: 'Support Costs', type: 'EXPENSE', parentCode: '6000' },
  { code: '6010', name: 'Governance Costs', type: 'EXPENSE', parentCode: '6000' },
  { code: '6015', name: 'Fundraising Costs', type: 'EXPENSE', parentCode: '6000' },
  { code: '6020', name: 'Staff Salaries', type: 'EXPENSE', parentCode: '6000' },
  { code: '6025', name: 'Travel & Transport', type: 'EXPENSE', parentCode: '6000' },
  { code: '6030', name: 'Office & Administration', type: 'EXPENSE', parentCode: '6000' },
  { code: '6035', name: 'Audit & Compliance', type: 'EXPENSE', parentCode: '6000' },
  { code: '6040', name: 'Volunteer & Community Support', type: 'EXPENSE', parentCode: '6000' },
  ...sharedTaxAccounts,
];

export const allSeedTemplates = {
  manufacturing: manufacturingAccounts,
  ngo: ngoAccounts,
  tax: sharedTaxAccounts,
};
