/**
 * The app's screens, and which data each one reads.
 *
 * The page loads the shared basics (entities, contacts, the chart, documents,
 * bank accounts and the like) on every request, plus only the sections the
 * screen being shown reads. Saving anything re-renders the page, so a save on
 * Payroll reloads payroll, not cash flow, privacy and the rest.
 *
 * The screen comes from the address (?screen=Payroll). The shell shows the
 * screen the server loaded data for, never one it did not, so a screen cannot
 * appear with its data missing. When a screen starts reading another section,
 * it is added here; tests/screens.test.ts checks every screen and section is
 * accounted for.
 */

export const screens = [
  'Dashboard',
  'Sales',
  'Purchases',
  'Bank',
  'Payments',
  'Inbox',
  'Cash flow',
  'Assets',
  'Payroll',
  'Grants',
  'Intercompany',
  'Tax',
  'Inventory',
  'Buying',
  'Pre-finance',
  'Contracts',
  'Reports',
  'Personal data',
  'Go-live',
  'Settings',
] as const;

export type Screen = (typeof screens)[number];

export const sections = ['inventory', 'trading', 'contracts', 'opening', 'momo', 'grants', 'cashflow', 'assets', 'attachments', 'privacy', 'settings', 'prefinance', 'payroll'] as const;

export type Section = (typeof sections)[number];

/** What each screen reads beyond the shared basics. */
export const sectionsByScreen: Record<Screen, readonly Section[]> = {
  // Provisional tax (assets), what payroll owes (payroll), agents' floats (trading).
  Dashboard: ['assets', 'payroll', 'trading'],
  // The document editor: items and locations, lots and commodities, grants to
  // charge, contracts for selling costs, and the document's attachments.
  Sales: ['inventory', 'trading', 'grants', 'contracts', 'attachments'],
  Purchases: ['inventory', 'trading', 'grants', 'contracts', 'attachments'],
  Bank: [],
  Payments: ['momo', 'trading', 'inventory'],
  Inbox: ['attachments'],
  'Cash flow': ['cashflow', 'trading'],
  Assets: ['assets'],
  Payroll: ['payroll', 'settings'],
  Grants: ['grants'],
  Intercompany: [],
  Tax: [],
  Inventory: ['inventory', 'trading'],
  Buying: ['trading', 'inventory'],
  'Pre-finance': ['prefinance'],
  Contracts: ['contracts', 'inventory', 'trading'],
  Reports: [],
  'Personal data': ['privacy'],
  'Go-live': ['opening'],
  Settings: ['settings'],
};

/** The screen named in the address, or the dashboard for anything else. */
export function screenOf(value: string | string[] | undefined): Screen {
  return (screens as readonly string[]).includes(value as string) ? (value as Screen) : 'Dashboard';
}
