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
    financialYearEnd: '31 Dec',
    vatRegistered: true,
    tin: 'GH-0001-ROOTS',
    accent: accentPalette[0],
  },
  {
    id: 'sprouted-crafts',
    code: 'SG002',
    name: 'Sprouted Crafts',
    type: 'manufacturing',
    financialYearEnd: '30 Jun',
    vatRegistered: true,
    tin: 'GH-0002-CRAFTS',
    accent: accentPalette[1],
  },
  {
    id: 'oikazi',
    code: 'SG003',
    name: 'Oikazi',
    type: 'manufacturing',
    financialYearEnd: '31 Mar',
    vatRegistered: false,
    tin: 'GH-0003-OIKAZI',
    accent: accentPalette[2],
  },
];

export const seedContacts: ContactRecord[] = [
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
    isFarmerAggregator: false,
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
    isFarmerAggregator: false,
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
    isFarmerAggregator: true,
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
    isFarmerAggregator: false,
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
  { entityId: 'sprouted-roots', code: 'FUND-RES', name: 'Restricted Funds', classification: 'restricted', funder: '' },
  { entityId: 'sprouted-roots', code: 'FUND-UNRES', name: 'Unrestricted Funds', classification: 'unrestricted', funder: '' },
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
  {
    id: 'farmer-training',
    entityId: 'sprouted-roots',
    code: 'PROJ-TRAINING',
    name: 'Farmer Training Programme',
    funder: 'EDA Foundation',
    fundCode: 'FUND-RES',
    budget: 2000000,
  },
  {
    id: 'cashew-aggregation',
    entityId: 'sprouted-roots',
    code: 'PROJ-AGGREGATION',
    name: 'Cashew Aggregation Project',
    funder: 'GIZ Ghana',
    fundCode: 'FUND-RES',
    budget: 3000000,
  },
  {
    id: 'general-operations',
    entityId: 'sprouted-roots',
    code: 'PROJ-OPS',
    name: 'General Operations',
    funder: 'Mastercard Foundation',
    fundCode: 'FUND-UNRES',
    budget: 1000000,
  },
];
