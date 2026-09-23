/**
 * Demo data for Sprouted Group. The seed script writes this to the database;
 * the app reads it back from there. This file is the only copy.
 *
 * Every amount is integer pesewas.
 */

import type { ContactRecord, EntityRecord, FundClassification } from './data/types';

export const accentPalette = ['#2F6F5A', '#A76A27', '#3E6EAC', '#8D4D7B', '#6C7F54', '#B34C4C'];

export const seedEntities: EntityRecord[] = [
  {
    id: 'sprouted-roots',
    code: 'SG001',
    name: 'Sprouted Roots',
    type: 'programs',
    financialYearEnd: '30 Sep',
    vatRegistered: false,
    vatRegisteredFrom: null,
    tin: 'GH-0001-ROOTS',
    emailFrom: '',
    accent: accentPalette[0],
    functionalCurrency: 'GHS',
    floatAgeLimitDays: 14,
    taxStatus: 'taxable' as const,
    payeDueDay: 15,
    ssnitDueDay: 14,
    lbcMode: false,
    revenuePresentation: 'gross',
    producerPriceMinorPerKg: null,
    buyerMarginMinorPerKg: null,
    haulageMinorPerKg: null,
    cutOverDate: null,
    liveAt: null,
  },
  {
    id: 'sprouted-crafts',
    code: 'SG002',
    name: 'Sprouted Crafts',
    type: 'manufacturing',
    financialYearEnd: '30 Jun',
    vatRegistered: false,
    vatRegisteredFrom: null,
    tin: 'GH-0002-CRAFTS',
    emailFrom: '',
    accent: accentPalette[1],
    functionalCurrency: 'GHS',
    floatAgeLimitDays: 14,
    taxStatus: 'taxable' as const,
    payeDueDay: 15,
    ssnitDueDay: 14,
    lbcMode: false,
    revenuePresentation: 'gross',
    producerPriceMinorPerKg: null,
    buyerMarginMinorPerKg: null,
    haulageMinorPerKg: null,
    cutOverDate: null,
    liveAt: null,
  },
  {
    id: 'oikazi',
    code: 'SG003',
    name: 'Oikazi',
    type: 'manufacturing',
    financialYearEnd: '31 Mar',
    vatRegistered: false,
    vatRegisteredFrom: null,
    tin: 'GH-0003-OIKAZI',
    emailFrom: '',
    accent: accentPalette[2],
    functionalCurrency: 'GHS',
    floatAgeLimitDays: 14,
    taxStatus: 'taxable' as const,
    payeDueDay: 15,
    ssnitDueDay: 14,
    lbcMode: false,
    revenuePresentation: 'gross',
    producerPriceMinorPerKg: null,
    buyerMarginMinorPerKg: null,
    haulageMinorPerKg: null,
    cutOverDate: null,
    liveAt: null,
  },
];

export const seedContacts: ContactRecord[] = [
  // The funders. They were rows in the old chart of accounts, which is not
  // what an account is for: money does not flow to a funder, it comes from
  // one. A funder may fund any programme, and the grant records which.
  {
    id: 'funder-tonys',
    name: 'Tony\'s Chocolonely',
    type: 'customer',
    category: 'customer',
    tin: '',
    phone: '',
    email: '',
    address: '',
    withholdingTaxStatus: 'exempt',
    isActive: true,
    balances: { 'sprouted-roots': 0, 'sprouted-crafts': 0, oikazi: 0 },
  },
  {
    id: 'funder-tcho',
    name: 'TCHO Chocolate',
    type: 'customer',
    category: 'customer',
    tin: '',
    phone: '',
    email: '',
    address: '',
    withholdingTaxStatus: 'exempt',
    isActive: true,
    balances: { 'sprouted-roots': 0, 'sprouted-crafts': 0, oikazi: 0 },
  },
  {
    id: 'funder-guittard',
    name: 'Guittard Chocolate Company',
    type: 'customer',
    category: 'customer',
    tin: '',
    phone: '',
    email: '',
    address: '',
    withholdingTaxStatus: 'exempt',
    isActive: true,
    balances: { 'sprouted-roots': 0, 'sprouted-crafts': 0, oikazi: 0 },
  },
  {
    id: 'funder-tachibana-intl',
    name: 'Tachibana International',
    type: 'customer',
    category: 'customer',
    tin: '',
    phone: '',
    email: '',
    address: '',
    withholdingTaxStatus: 'exempt',
    isActive: true,
    balances: { 'sprouted-roots': 0, 'sprouted-crafts': 0, oikazi: 0 },
  },
  {
    id: 'funder-tachibana-gh',
    name: 'Tachibana Ghana',
    type: 'customer',
    category: 'customer',
    tin: '',
    phone: '',
    email: '',
    address: '',
    withholdingTaxStatus: 'exempt',
    isActive: true,
    balances: { 'sprouted-roots': 0, 'sprouted-crafts': 0, oikazi: 0 },
  },
  {
    id: 'funder-vumbuzi',
    name: 'Vumbuzi Impact Africa (VIA) Foundation',
    type: 'customer',
    category: 'customer',
    tin: '',
    phone: '',
    email: '',
    address: '',
    withholdingTaxStatus: 'exempt',
    isActive: true,
    balances: { 'sprouted-roots': 0, 'sprouted-crafts': 0, oikazi: 0 },
  },
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
    isActive: true,
    balances: { 'sprouted-roots': 0, 'sprouted-crafts': -345000, oikazi: 185000 },
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
    isActive: true,
    balances: { 'sprouted-roots': 245000, 'sprouted-crafts': 0, oikazi: -68000 },
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
    isActive: true,
    balances: { 'sprouted-roots': -118000, 'sprouted-crafts': 42000, oikazi: 0 },
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
    isActive: true,
    balances: { 'sprouted-roots': 520000, 'sprouted-crafts': 160000, oikazi: 70000 },
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
    isActive: true,
    balances: { 'sprouted-roots': 160000, 'sprouted-crafts': 280000, oikazi: 340000 },
  },
];

export type SeedFund = {
  entityId: string;
  code: string;
  name: string;
  classification: FundClassification;
  funder: string;
};

export const seedFunds: SeedFund[] = [
  // Restriction is a property of the fund. There is one restricted fund per
  // programme, so a programme's unspent balance is a real number rather than
  // a share of one pooled figure. No funder is named on a fund: a funder can
  // fund any programme, and which one it chose is recorded on its grant.
  { entityId: 'sprouted-roots', code: 'FUND-UNRES', name: 'Unrestricted Funds', classification: 'unrestricted', funder: '' },
  { entityId: 'sprouted-roots', code: 'FUND-HRC', name: 'Human Rights and Communities', classification: 'restricted', funder: '' },
  { entityId: 'sprouted-roots', code: 'FUND-PEHS', name: 'Productivity, Environment, Health and Safety', classification: 'restricted', funder: '' },
  { entityId: 'sprouted-roots', code: 'FUND-TD', name: 'Traceability + Data', classification: 'restricted', funder: '' },
  { entityId: 'sprouted-roots', code: 'FUND-SC', name: 'Strong Coops', classification: 'restricted', funder: '' },
  { entityId: 'sprouted-roots', code: 'FUND-BRIDGE', name: 'Bridge Fund', classification: 'restricted', funder: '' },
];

export type SeedProject = {
  /** Stable id, so report drilldowns and links survive a reseed. */
  id: string;
  entityId: string;
  code: string;
  name: string;
  funder: string;
  fundCode: string;
  budget: number;
};

export const seedProjects: SeedProject[] = [
  // The programme is a dimension on the transaction line, which is why the
  // expense accounts no longer name one. Budgets are not seeded: they belong
  // to a grant, in the donor's own currency, and are entered when the award
  // is recorded. Travel, running costs and staff costs are general expenses,
  // not restricted programmes, so they are not projects.
  { id: 'human-rights-communities', entityId: 'sprouted-roots', code: 'PROJ-HRC', name: 'Human Rights and Communities', funder: '', fundCode: 'FUND-HRC', budget: 0 },
  { id: 'productivity-environment', entityId: 'sprouted-roots', code: 'PROJ-PEHS', name: 'Productivity, Environment, Health and Safety', funder: '', fundCode: 'FUND-PEHS', budget: 0 },
  { id: 'traceability-data', entityId: 'sprouted-roots', code: 'PROJ-TD', name: 'Traceability + Data', funder: '', fundCode: 'FUND-TD', budget: 0 },
  { id: 'strong-coops', entityId: 'sprouted-roots', code: 'PROJ-SC', name: 'Strong Coops', funder: '', fundCode: 'FUND-SC', budget: 0 },
  { id: 'bridge-fund', entityId: 'sprouted-roots', code: 'PROJ-BRIDGE', name: 'Bridge Fund', funder: '', fundCode: 'FUND-BRIDGE', budget: 0 },
];
