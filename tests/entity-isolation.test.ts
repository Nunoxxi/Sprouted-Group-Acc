/**
 * Proof that a user without access to an entity cannot read or write that
 * entity's data through any route.
 *
 * The authorization layer is the real one (src/lib/dal.ts + src/lib/authz.ts).
 * What is faked is underneath it: the session Better Auth would return, and
 * the database. The database fake answers exactly one query — the
 * principal's own entity-access rows — and records every other call, so a
 * test can assert not only that a request was refused but that nothing was
 * read or written on the way to refusing it.
 *
 * Every exported Server Function in src/app/actions/*.ts and every Route
 * Handler under src/app/api must appear in the tables below; a new export
 * without a case fails the suite.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- fakes -----------------------------------------------------------------------

type FakeUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  banned?: boolean;
  twoFactorEnabled?: boolean;
  deactivatedAt?: Date | null;
};

const { state, dbCalls, scopeProbe, UnexpectedDatabaseAccess, prismaFake } = vi.hoisted(() => {
  const state: { user: FakeUser | null; access: string[] } = { user: null, access: [] };
  const dbCalls: string[] = [];
  const scopeProbe: { call: string; args: unknown }[] = [];

  class UnexpectedDatabaseAccess extends Error {
    constructor(call: string) {
      super(`unexpected database access: ${call}`);
    }
  }

  /** prisma.<model>.<method>(...) → recorded; only userEntityAccess.findMany answers. */
  const prismaFake: Record<string, unknown> = new Proxy(
  {},
  {
    get(_target, model: string) {
      if (model === '$transaction') {
        return async (arg: unknown) => {
          dbCalls.push('$transaction');
          if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(prismaFake);
          throw new UnexpectedDatabaseAccess('$transaction([])');
        };
      }
      if (typeof model !== 'string' || model.startsWith('$') || model === 'then') {
        return undefined;
      }
      return new Proxy(
        {},
        {
          get(_m, method: string) {
            return async (args: unknown) => {
              const call = `${model}.${method}`;
              dbCalls.push(call);
              if (call === 'userEntityAccess.findMany') {
                return state.access.map((entityId) => ({ entityId }));
              }
              // Used by the read-only positive control on loadInitialData.
              if (state.user?.id === 'scope-probe' && method === 'findMany') {
                scopeProbe.push({ call, args });
                return [];
              }
              throw new UnexpectedDatabaseAccess(call);
            };
          },
        },
      );
    },
  },
  );

  return { state, dbCalls, scopeProbe, UnexpectedDatabaseAccess, prismaFake };
});

vi.mock('@/lib/prisma', () => ({ prisma: prismaFake }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/cache', () => ({ refresh: () => undefined }));
vi.mock('@/lib/auth', () => {
  const refuse = (name: string) => async () => {
    throw new UnexpectedDatabaseAccess(name);
  };
  return {
    auth: {
      api: {
        getSession: async () => (state.user ? { user: state.user, session: { token: 'tok' } } : null),
        createUser: refuse('auth.createUser'),
        requestPasswordReset: refuse('auth.requestPasswordReset'),
        setRole: refuse('auth.setRole'),
        banUser: refuse('auth.banUser'),
        unbanUser: refuse('auth.unbanUser'),
        revokeUserSession: refuse('auth.revokeUserSession'),
        revokeUserSessions: refuse('auth.revokeUserSessions'),
      },
    },
  };
});

import * as documentActions from '@/app/actions/documents';
import * as fxActions from '@/app/actions/fx';
import * as vatActions from '@/app/actions/vat';
import * as entityActions from '@/app/actions/entities';
import * as inventoryActions from '@/app/actions/inventory';
import * as tradingActions from '@/app/actions/trading';
import * as contractActions from '@/app/actions/contracts';
import * as openingActions from '@/app/actions/opening';
import * as momoActions from '@/app/actions/momo';
import * as grantActions from '@/app/actions/grants';
import * as cashflowActions from '@/app/actions/cashflow';
import * as assetActions from '@/app/actions/assets';
import * as userActions from '@/app/actions/users';
import * as auditRoute from '@/app/api/audit/route';
import * as backupsRoute from '@/app/api/backups/route';
import { getPrincipal } from '@/lib/dal';
import { loadInitialData } from '@/lib/data/documents';

const FORBIDDEN_ENTITY = 'oikazi';
const GRANTED_ENTITY = 'sprouted-roots';

function signIn(user: Partial<FakeUser> & { role: string }, access: string[]) {
  state.user = { id: 'user-1', name: 'Test User', email: 'test@example.com', twoFactorEnabled: true, ...user };
  state.access = access;
}

beforeEach(() => {
  state.user = null;
  state.access = [];
  dbCalls.length = 0;
  scopeProbe.length = 0;
});

// --- the call tables ---------------------------------------------------------------

type Call = () => Promise<unknown>;

/** Every document Server Function, invoked against the forbidden entity. */
const documentCalls: Record<keyof typeof documentActions, Call | null> = {
  saveDocumentDraft: () => documentActions.saveDocumentDraft(FORBIDDEN_ENTITY, { kind: 'invoice' }),
  postDocument: () => documentActions.postDocument(FORBIDDEN_ENTITY, 'doc-1'),
  recordPayment: () => documentActions.recordPayment(FORBIDDEN_ENTITY, { documentId: 'doc-1', bankAccountId: 'bank-1', date: '2026-09-20', txnAmount: 100, rate: '12.5' }),
  voidDocument: () => documentActions.voidDocument(FORBIDDEN_ENTITY, 'doc-1'),
  fileTaxPeriod: () => documentActions.fileTaxPeriod(FORBIDDEN_ENTITY, '2026-08'),
  // Not entity-scoped (contacts are group-wide; entities are created by Owners);
  // covered by the role tests below instead.
  createContact: null,
  createEntity: null,
};

/** Every multi-currency Server Function, invoked against the forbidden entity. */
const fxCalls: Record<keyof typeof fxActions, Call> = {
  upsertExchangeRate: () => fxActions.upsertExchangeRate(FORBIDDEN_ENTITY, { base: 'USD', quote: 'GHS', date: '2026-09-20', rate: '12.5' }),
  setFunctionalCurrency: () => fxActions.setFunctionalCurrency(FORBIDDEN_ENTITY, 'USD'),
  createBankAccount: () => fxActions.createBankAccount(FORBIDDEN_ENTITY, { name: 'USD account', currency: 'USD' }),
  previewRevaluation: () => fxActions.previewRevaluation(FORBIDDEN_ENTITY, '2026-09', { USD: '12.8' }),
  runRevaluation: () => fxActions.runRevaluation(FORBIDDEN_ENTITY, '2026-09', { USD: '12.8' }),
  reverseRevaluation: () => fxActions.reverseRevaluation(FORBIDDEN_ENTITY, '2026-09'),
  listExchangeRates: () => fxActions.listExchangeRates(FORBIDDEN_ENTITY),
};

/** Every VAT-registration Server Function, invoked against the forbidden entity. */
const vatCalls: Record<keyof typeof vatActions, Call> = {
  setVatRegistration: () => vatActions.setVatRegistration(FORBIDDEN_ENTITY, { registered: true, registeredFrom: '2026-10-01' }),
};

/** Every entity-settings Server Function, invoked against the forbidden entity. */
const entityCalls: Record<keyof typeof entityActions, Call> = {
  setEntitySender: () => entityActions.setEntitySender(FORBIDDEN_ENTITY, 'Oikazi <oikazi@example.com>'),
};

/** Every inventory Server Function, invoked against the forbidden entity. */
const inventoryCalls: Record<keyof typeof inventoryActions, Call> = {
  saveItem: () => inventoryActions.saveItem(FORBIDDEN_ENTITY, { code: 'RCN', name: 'Raw cashew', category: 'raw-material', baseUnit: 'bag', gramsPerBag: 80000, gramsPerCarton: null }),
  saveLocation: () => inventoryActions.saveLocation(FORBIDDEN_ENTITY, { code: 'WH1', name: 'Warehouse', accountCode: null }),
  transferStock: () => inventoryActions.transferStock(FORBIDDEN_ENTITY, { itemId: 'item-1', fromLocationId: 'loc-1', toLocationId: 'loc-2', quantity: 1, unit: 'kg', date: '2026-09-21' }),
  adjustStock: () => inventoryActions.adjustStock(FORBIDDEN_ENTITY, { itemId: 'item-1', locationId: 'loc-1', quantity: -1, unit: 'kg', reason: 'damage', date: '2026-09-21' }),
  saveStockCount: () => inventoryActions.saveStockCount(FORBIDDEN_ENTITY, { locationId: 'loc-1', date: '2026-09-21', lines: [] }),
  postStockCount: () => inventoryActions.postStockCount(FORBIDDEN_ENTITY, 'count-1'),
  setNrvPrice: () => inventoryActions.setNrvPrice(FORBIDDEN_ENTITY, { itemId: 'item-1', period: '2026-09', sellingPriceMinorPerKg: 1000 }),
  writeDownToNrv: () => inventoryActions.writeDownToNrv(FORBIDDEN_ENTITY, { itemId: 'item-1', period: '2026-09', date: '2026-09-30' }),
};

/** Every trading Server Function, invoked against the forbidden entity. */
const tradingCalls: Record<keyof typeof tradingActions, Call> = {
  saveCommodity: () => tradingActions.saveCommodity(FORBIDDEN_ENTITY, { code: 'RCN', name: 'Raw cashew', kind: 'cashew', gramsPerBag: 80000, shrinkageTolerancePct: 2 }),
  saveGrade: () => tradingActions.saveGrade(FORBIDDEN_ENTITY, { commodityId: 'c', grade: 'Standard' }),
  saveAgent: () => tradingActions.saveAgent(FORBIDDEN_ENTITY, { name: 'Ama' }),
  setFloatAgeLimit: () => tradingActions.setFloatAgeLimit(FORBIDDEN_ENTITY, 14),
  advanceFloat: () => tradingActions.advanceFloat(FORBIDDEN_ENTITY, { agentId: 'a', date: '2026-09-21', amountMinor: 100, bankAccountId: 'b' }),
  returnFloatCash: () => tradingActions.returnFloatCash(FORBIDDEN_ENTITY, { floatId: 'f', date: '2026-09-21', amountMinor: 100, bankAccountId: 'b' }),
  reconcileFloat: () => tradingActions.reconcileFloat(FORBIDDEN_ENTITY, 'f'),
  syncAgentPurchases: () => tradingActions.syncAgentPurchases(FORBIDDEN_ENTITY, [{ clientRef: 'x', agentId: 'a', date: '2026-09-21', farmerName: 'F', itemId: 'i', grams: 1, priceMinor: 1, paymentMethod: 'cash' }]),
  postAgentPurchases: () => tradingActions.postAgentPurchases(FORBIDDEN_ENTITY, ['p']),
  rejectAgentPurchase: () => tradingActions.rejectAgentPurchase(FORBIDDEN_ENTITY, 'p', 'no'),
  assignPurchaseFloat: () => tradingActions.assignPurchaseFloat(FORBIDDEN_ENTITY, 'p', 'f'),
  recordWeighOut: () => tradingActions.recordWeighOut(FORBIDDEN_ENTITY, { lotId: 'l', date: '2026-09-21', gramsOut: 1 }),
};

/** Every sales-contract Server Function, invoked against the forbidden entity. */
const contractCalls: Record<keyof typeof contractActions, Call> = {
  saveContract: () => contractActions.saveContract(FORBIDDEN_ENTITY, { buyerContactId: 'c', itemId: 'i', quantity: 1, quantityUnit: 'kg', priceMinor: 100, priceUnit: 'kg', currency: 'GHS', deliveryTerms: 'EXW', deliveryFrom: '2026-09-01', deliveryTo: '2026-09-30', recognizeOn: 'delivery', saleType: 'domestic' }),
  setContractStatus: () => contractActions.setContractStatus(FORBIDDEN_ENTITY, 'sc', 'closed'),
  recordDelivery: () => contractActions.recordDelivery(FORBIDDEN_ENTITY, { contractId: 'sc', date: '2026-09-21', locationId: 'l', quantity: 1, unit: 'kg' }),
  acceptDelivery: () => contractActions.acceptDelivery(FORBIDDEN_ENTITY, 'd', '2026-09-21'),
  setLbcSettings: () => contractActions.setLbcSettings(FORBIDDEN_ENTITY, { lbcMode: true, revenuePresentation: 'gross', producerPriceMinorPerKg: null, buyerMarginMinorPerKg: null, haulageMinorPerKg: null }),
  recordSeedFund: () => contractActions.recordSeedFund(FORBIDDEN_ENTITY, { kind: 'received', date: '2026-09-21', amountMinor: 100, bankAccountId: 'b' }),
  recordCmcReceipt: () => contractActions.recordCmcReceipt(FORBIDDEN_ENTITY, { date: '2026-09-21', amountMinor: 100, bankAccountId: 'b' }),
};

/** Every opening-balance Server Function, invoked against the forbidden entity. */
const openingCalls: Record<keyof typeof openingActions, Call> = {
  setCutOverDate: () => openingActions.setCutOverDate(FORBIDDEN_ENTITY, '2026-10-01'),
  openingTemplate: () => openingActions.openingTemplate(FORBIDDEN_ENTITY),
  uploadOpeningWorkbook: () => openingActions.uploadOpeningWorkbook(FORBIDDEN_ENTITY, 'x.xlsx', ''),
  discardOpeningBatch: () => openingActions.discardOpeningBatch(FORBIDDEN_ENTITY, 'b'),
  postOpeningBatch: () => openingActions.postOpeningBatch(FORBIDDEN_ENTITY, 'b'),
  openingChecklist: () => openingActions.openingChecklist(FORBIDDEN_ENTITY),
  goLive: () => openingActions.goLive(FORBIDDEN_ENTITY),
};
/** The one opening read a Viewer may make on their own entity. */
const openingReads = new Set(['openingChecklist']);

/** Every mobile money and farmer payment Server Function. */
const momoCalls: Record<keyof typeof momoActions, Call> = {
  saveFarmer: () => momoActions.saveFarmer(FORBIDDEN_ENTITY, { name: 'Kofi Mensah' }),
  recordFarmerAdvance: () => momoActions.recordFarmerAdvance(FORBIDDEN_ENTITY, { farmerId: 'f', date: '2026-09-21', amountMinor: 100, bankAccountId: 'b' }),
  createPaymentBatch: () => momoActions.createPaymentBatch(FORBIDDEN_ENTITY, { date: '2026-09-21', bankAccountId: 'b', purchaseIds: ['p'] }),
  exportPaymentBatch: () => momoActions.exportPaymentBatch(FORBIDDEN_ENTITY, 'batch'),
  markBatchPaid: () => momoActions.markBatchPaid(FORBIDDEN_ENTITY, 'batch', { date: '2026-09-21' }),
  saveStatementMapping: () => momoActions.saveStatementMapping(FORBIDDEN_ENTITY, { name: 'MTN', dateColumn: 'Date', descriptionColumn: 'Description', amountColumn: 'Amount' }),
  addDefaultStatementMappings: () => momoActions.addDefaultStatementMappings(FORBIDDEN_ENTITY),
  importStatement: () => momoActions.importStatement(FORBIDDEN_ENTITY, { bankAccountId: 'b', mappingId: 'm', fileName: 'x.csv', csv: 'Date,Description,Amount\n2026-09-01,x,1.00' }),
  matchStatementLine: () => momoActions.matchStatementLine(FORBIDDEN_ENTITY, 'line', 'batch'),
  noteStatementLine: () => momoActions.noteStatementLine(FORBIDDEN_ENTITY, 'line', 'ours'),
  createWallet: () => momoActions.createWallet(FORBIDDEN_ENTITY, { name: 'MoMo', provider: 'MTN', number: '0244000111', currency: 'GHS' }),
  farmerHistoryReport: () => momoActions.farmerHistoryReport(FORBIDDEN_ENTITY, 'f'),
};
/** The one farmer read a Viewer may make on their own entity. */
const momoReads = new Set(['farmerHistoryReport']);

/** Every grant Server Function. */
const grantCalls: Record<keyof typeof grantActions, Call> = {
  saveGrant: () =>
    grantActions.saveGrant(FORBIDDEN_ENTITY, {
      code: 'GRT-1',
      name: 'Livelihoods',
      donorContactId: 'donor',
      currency: 'USD',
      amountMinor: 100_000,
      rate: '15.0',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      restricted: true,
      incomePolicy: 'deferred',
      reportingFrequency: 'quarterly',
    }),
  setGrantStatus: () => grantActions.setGrantStatus(FORBIDDEN_ENTITY, 'grant', 'active'),
  saveBudgetLine: () => grantActions.saveBudgetLine(FORBIDDEN_ENTITY, { grantId: 'grant', code: 'B1', name: 'Training', accountCode: '6001', budgetMinor: 1000 }),
  removeBudgetLine: () => grantActions.removeBudgetLine(FORBIDDEN_ENTITY, 'budget-line'),
  saveCondition: () => grantActions.saveCondition(FORBIDDEN_ENTITY, { grantId: 'grant', description: 'Baseline survey' }),
  setConditionMet: () => grantActions.setConditionMet(FORBIDDEN_ENTITY, 'condition', true),
  recordGrantReceipt: () => grantActions.recordGrantReceipt(FORBIDDEN_ENTITY, { grantId: 'grant', date: '2026-02-01', txnAmountMinor: 1000, bankAccountId: 'bank' }),
  releaseGrantIncome: () => grantActions.releaseGrantIncome(FORBIDDEN_ENTITY, { grantId: 'grant', date: '2026-02-01', basis: 'spending' }),
  recordInKind: () => grantActions.recordInKind(FORBIDDEN_ENTITY, { grantId: 'grant', date: '2026-02-01', description: 'Seedlings', kind: 'goods', valueMinor: 1000 }),
  recordStaffTime: () =>
    grantActions.recordStaffTime(FORBIDDEN_ENTITY, { grantId: 'grant', personName: 'Ama', periodStart: '2026-02-01', periodEnd: '2026-02-28', hours: 10, rateMinorPerHour: 250, accountCode: '6020' }),
  donorReport: () => grantActions.donorReport(FORBIDDEN_ENTITY, 'grant'),
  donorReportWorkbook: () => grantActions.donorReportWorkbook(FORBIDDEN_ENTITY, 'grant'),
};
/** The two grant reads a Viewer may make on their own entity. */
const grantReads = new Set(['donorReport', 'donorReportWorkbook']);

/** Every cash flow Server Function. */
const cashflowCalls: Record<keyof typeof cashflowActions, Call> = {
  saveBuyingSeason: () =>
    cashflowActions.saveBuyingSeason(FORBIDDEN_ENTITY, { commodityId: 'c', name: 'Main crop', startDate: '2027-02-01', peakDate: '2027-03-15', endDate: '2027-04-30', expectedGrams: 1_000_000, priceMinorPerKg: 1200 }),
  removeBuyingSeason: () => cashflowActions.removeBuyingSeason(FORBIDDEN_ENTITY, 'season'),
  saveRecurringCost: () => cashflowActions.saveRecurringCost(FORBIDDEN_ENTITY, { name: 'Payroll', amountMinor: 100_000, frequency: 'monthly', startDate: '2026-10-31' }),
  removeRecurringCost: () => cashflowActions.removeRecurringCost(FORBIDDEN_ENTITY, 'cost'),
  saveScenario: () => cashflowActions.saveScenario(FORBIDDEN_ENTITY, { name: 'Baseline' }),
  duplicateScenario: () => cashflowActions.duplicateScenario(FORBIDDEN_ENTITY, 'scenario', 'Poor season'),
  setBaselineScenario: () => cashflowActions.setBaselineScenario(FORBIDDEN_ENTITY, 'scenario'),
  removeScenario: () => cashflowActions.removeScenario(FORBIDDEN_ENTITY, 'scenario'),
  addScenarioLine: () => cashflowActions.addScenarioLine(FORBIDDEN_ENTITY, { scenarioId: 'scenario', date: '2026-10-01', amountMinor: -1000, description: 'Vehicle' }),
  removeScenarioLine: () => cashflowActions.removeScenarioLine(FORBIDDEN_ENTITY, 'line'),
  cashForecastSources: () => cashflowActions.cashForecastSources(FORBIDDEN_ENTITY),
};

/** The one cash flow read a Viewer may make on their own entity. */
const cashflowReads = new Set(['cashForecastSources']);

/** Every fixed asset and tax Server Function. */
const assetCalls: Record<keyof typeof assetActions, Call> = {
  setEntityTaxStatus: () => assetActions.setEntityTaxStatus(FORBIDDEN_ENTITY, 'exempt'),
  saveAsset: () => assetActions.saveAsset(FORBIDDEN_ENTITY, { code: 'VEH-1', description: 'Pickup', purchaseDate: '2026-01-05', costMinor: 100_000, usefulLifeMonths: 60, method: 'straight-line' }),
  runDepreciation: () => assetActions.runDepreciation(FORBIDDEN_ENTITY, '2026-09'),
  disposeAsset: () => assetActions.disposeAsset(FORBIDDEN_ENTITY, { assetId: 'asset', date: '2026-09-01', proceedsMinor: 0 }),
  saveAllowanceClass: () => assetActions.saveAllowanceClass(FORBIDDEN_ENTITY, { code: '1', name: 'Computers', ratePct: '40', method: 'reducing-balance' }),
  removeAllowanceClass: () => assetActions.removeAllowanceClass(FORBIDDEN_ENTITY, 'class'),
  saveTaxYear: () => assetActions.saveTaxYear(FORBIDDEN_ENTITY, { label: '2026', startDate: '2026-01-01', endDate: '2026-12-31', ratePct: '25' }),
  saveTaxAdjustment: () => assetActions.saveTaxAdjustment(FORBIDDEN_ENTITY, { taxYearId: 'year', kind: 'add-back', description: 'Entertainment', amountMinor: 1000 }),
  removeTaxAdjustment: () => assetActions.removeTaxAdjustment(FORBIDDEN_ENTITY, 'adjustment'),
  postTaxCharge: () => assetActions.postTaxCharge(FORBIDDEN_ENTITY, 'year', 1000),
  recordProvisionalPayment: () => assetActions.recordProvisionalPayment(FORBIDDEN_ENTITY, { taxYearId: 'year', quarter: 1, date: '2026-03-31', amountMinor: 1000, bankAccountId: 'bank' }),
  taxWorksheet: () => assetActions.taxWorksheet(FORBIDDEN_ENTITY, 'year'),
};
/** The one asset read a Viewer may make on their own entity. */
const assetReads = new Set(['taxWorksheet']);

/** Every user-management Server Function. Owner-only, so any other role is refused. */
const userCalls: Record<keyof typeof userActions, Call> = {
  listUsers: () => userActions.listUsers(),
  listSessions: () => userActions.listSessions(),
  inviteUser: () => userActions.inviteUser({ name: 'X', email: 'x@example.com', role: 'viewer', entityIds: [FORBIDDEN_ENTITY] }),
  resendInvite: () => userActions.resendInvite('user-2'),
  updateUserAccess: () => userActions.updateUserAccess({ userId: 'user-2', role: 'viewer', entityIds: [FORBIDDEN_ENTITY] }),
  deactivateUser: () => userActions.deactivateUser('user-2'),
  reactivateUser: () => userActions.reactivateUser('user-2'),
  unlockUser: () => userActions.unlockUser('user-2'),
  revokeSession: () => userActions.revokeSession('tok-2'),
};

/** Every Route Handler, invoked against the forbidden entity. */
const routeCalls: Record<string, () => Promise<Response>> = {
  'GET /api/audit': () => auditRoute.GET(new Request(`http://app/api/audit?entityId=${FORBIDDEN_ENTITY}`)),
  'POST /api/audit': () =>
    auditRoute.POST(
      new Request('http://app/api/audit', {
        method: 'POST',
        body: JSON.stringify({ entityId: FORBIDDEN_ENTITY, action: 'MATCH', resourceRef: 'x', summary: 'x' }),
      }),
    ),
  'GET /api/backups': () => backupsRoute.GET(new Request(`http://app/api/backups?entityId=${FORBIDDEN_ENTITY}`)),
  'GET /api/backups download': () =>
    backupsRoute.GET(new Request(`http://app/api/backups?entityId=${FORBIDDEN_ENTITY}&download=sprouted-oikazi.json`)),
  'POST /api/backups': () =>
    backupsRoute.POST(new Request('http://app/api/backups', { method: 'POST', body: JSON.stringify({ entityId: FORBIDDEN_ENTITY }) })),
};

function isRefusal(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { ok?: boolean }).ok === false;
}

function errorOf(result: unknown): string {
  return (result as { error: string }).error;
}

function onlyAccessLookup() {
  // The principal's own access rows are the one permitted read. Nothing
  // belonging to any entity was touched.
  expect(dbCalls.filter((call) => call !== 'userEntityAccess.findMany')).toEqual([]);
}

// --- coverage guard ----------------------------------------------------------------

describe('coverage', () => {
  it('every exported Server Function has a case', () => {
    const exportedDocs = Object.keys(documentActions).filter((k) => typeof (documentActions as Record<string, unknown>)[k] === 'function');
    expect(exportedDocs.sort()).toEqual(Object.keys(documentCalls).sort());
    const exportedUsers = Object.keys(userActions).filter((k) => typeof (userActions as Record<string, unknown>)[k] === 'function');
    expect(exportedUsers.sort()).toEqual(Object.keys(userCalls).sort());
    const exportedFx = Object.keys(fxActions).filter((k) => typeof (fxActions as Record<string, unknown>)[k] === 'function');
    expect(exportedFx.sort()).toEqual(Object.keys(fxCalls).sort());
    const exportedVat = Object.keys(vatActions).filter((k) => typeof (vatActions as Record<string, unknown>)[k] === 'function');
    expect(exportedVat.sort()).toEqual(Object.keys(vatCalls).sort());
    const exportedEntity = Object.keys(entityActions).filter((k) => typeof (entityActions as Record<string, unknown>)[k] === 'function');
    expect(exportedEntity.sort()).toEqual(Object.keys(entityCalls).sort());
    const exportedInventory = Object.keys(inventoryActions).filter((k) => typeof (inventoryActions as Record<string, unknown>)[k] === 'function');
    expect(exportedInventory.sort()).toEqual(Object.keys(inventoryCalls).sort());
    const exportedTrading = Object.keys(tradingActions).filter((k) => typeof (tradingActions as Record<string, unknown>)[k] === 'function');
    expect(exportedTrading.sort()).toEqual(Object.keys(tradingCalls).sort());
    const exportedContracts = Object.keys(contractActions).filter((k) => typeof (contractActions as Record<string, unknown>)[k] === 'function');
    expect(exportedContracts.sort()).toEqual(Object.keys(contractCalls).sort());
    const exportedOpening = Object.keys(openingActions).filter((k) => typeof (openingActions as Record<string, unknown>)[k] === 'function');
    expect(exportedOpening.sort()).toEqual(Object.keys(openingCalls).sort());
    const exportedMomo = Object.keys(momoActions).filter((k) => typeof (momoActions as Record<string, unknown>)[k] === 'function');
    expect(exportedMomo.sort()).toEqual(Object.keys(momoCalls).sort());
    const exportedGrants = Object.keys(grantActions).filter((k) => typeof (grantActions as Record<string, unknown>)[k] === 'function');
    expect(exportedGrants.sort()).toEqual(Object.keys(grantCalls).sort());
    const exportedCashflow = Object.keys(cashflowActions).filter((k) => typeof (cashflowActions as Record<string, unknown>)[k] === 'function');
    expect(exportedCashflow.sort()).toEqual(Object.keys(cashflowCalls).sort());
    const exportedAssets = Object.keys(assetActions).filter((k) => typeof (assetActions as Record<string, unknown>)[k] === 'function');
    expect(exportedAssets.sort()).toEqual(Object.keys(assetCalls).sort());
  });

  it('every Route Handler method has a case', () => {
    expect(Object.keys(auditRoute).filter((k) => /^[A-Z]+$/.test(k)).sort()).toEqual(['GET', 'POST']);
    expect(Object.keys(backupsRoute).filter((k) => /^[A-Z]+$/.test(k)).sort()).toEqual(['GET', 'POST']);
  });
});

// --- signed out --------------------------------------------------------------------

describe('signed out', () => {
  for (const [name, call] of Object.entries({ ...documentCalls, ...fxCalls, ...vatCalls, ...entityCalls, ...inventoryCalls, ...tradingCalls, ...contractCalls, ...openingCalls, ...momoCalls, ...grantCalls, ...cashflowCalls, ...assetCalls, ...userCalls })) {
    if (!call) continue;
    it(`${name} is refused without touching the database`, async () => {
      expect(isRefusal(await call())).toBe(true);
      expect(dbCalls).toEqual([]);
    });
  }
  for (const [name, call] of Object.entries(routeCalls)) {
    it(`${name} answers 401 without touching the database`, async () => {
      expect((await call()).status).toBe(401);
      expect(dbCalls).toEqual([]);
    });
  }
});

// --- signed in, wrong entity -------------------------------------------------------

describe('an Accountant on Sprouted Roots asking for Oikazi', () => {
  beforeEach(() => signIn({ role: 'accountant' }, [GRANTED_ENTITY]));

  for (const [name, call] of Object.entries({ ...documentCalls, ...fxCalls, ...vatCalls, ...entityCalls, ...inventoryCalls, ...tradingCalls, ...contractCalls, ...openingCalls, ...momoCalls, ...grantCalls, ...cashflowCalls, ...assetCalls })) {
    if (!call) continue;
    it(`${name} is refused and reads nothing`, async () => {
      const result = await call();
      expect(isRefusal(result)).toBe(true);
      expect(errorOf(result)).toBe('You do not have access to this entity.');
      onlyAccessLookup();
    });
  }

  for (const [name, call] of Object.entries(routeCalls)) {
    it(`${name} answers 403 and reads nothing`, async () => {
      expect((await call()).status).toBe(403);
      onlyAccessLookup();
    });
  }

  it('sees only Sprouted Roots in the initial data — in the query itself, not after', async () => {
    signIn({ id: 'scope-probe', role: 'accountant' }, [GRANTED_ENTITY]);
    const principal = await getPrincipal();
    expect(principal).not.toBeNull();
    await loadInitialData(principal!);

    const entityScoped = scopeProbe.filter((probe) => probe.call !== 'contact.findMany');
    expect(entityScoped.length).toBeGreaterThanOrEqual(6);
    for (const probe of entityScoped) {
      const where = (probe.args as { where: { entityId?: { in: string[] }; id?: { in: string[] } } }).where;
      const scope = where.entityId?.in ?? where.id?.in;
      expect(scope, probe.call).toEqual([GRANTED_ENTITY]);
    }
    const contacts = scopeProbe.find((probe) => probe.call === 'contact.findMany');
    const balanceScope = (contacts?.args as { include: { balances: { where: { entityId: { in: string[] } } } } }).include.balances.where;
    expect(balanceScope.entityId.in).toEqual([GRANTED_ENTITY]);
  });

  it('an entity that does not exist is refused identically to one not granted', async () => {
    const notGranted = await documentActions.postDocument(FORBIDDEN_ENTITY, 'doc-1');
    const unknown = await documentActions.postDocument('no-such-entity', 'doc-1');
    expect(notGranted).toEqual(unknown);
  });
});

describe('a Viewer with access to Oikazi', () => {
  beforeEach(() => signIn({ role: 'viewer' }, [FORBIDDEN_ENTITY]));

  for (const [name, call] of Object.entries(documentCalls)) {
    if (!call) continue;
    it(`${name} is refused by role, and reads nothing`, async () => {
      const result = await call();
      expect(isRefusal(result)).toBe(true);
      expect(errorOf(result)).toMatch(/cannot do that/);
      onlyAccessLookup();
    });
  }

  it('cannot touch rates, banks, the functional currency, revaluation or VAT registration, even on their own entity', async () => {
    for (const [name, call] of Object.entries({ ...fxCalls, ...vatCalls, ...entityCalls, ...inventoryCalls, ...tradingCalls, ...contractCalls, ...openingCalls, ...momoCalls, ...grantCalls, ...cashflowCalls, ...assetCalls })) {
      if (name === 'listExchangeRates' || openingReads.has(name) || momoReads.has(name) || grantReads.has(name) || cashflowReads.has(name) || assetReads.has(name)) continue; // reads are reports:view
      dbCalls.length = 0;
      const result = await call();
      expect(isRefusal(result), name).toBe(true);
      expect(errorOf(result), name).toMatch(/cannot do that/);
      onlyAccessLookup();
    }
  });

  it('cannot run an export or read the audit trail', async () => {
    expect((await routeCalls['GET /api/backups']()).status).toBe(403);
    expect((await routeCalls['GET /api/audit']()).status).toBe(403);
    onlyAccessLookup();
  });
});

describe('roles that are not Owner', () => {
  for (const role of ['accountant', 'data-entry', 'viewer']) {
    for (const [name, call] of Object.entries(userCalls)) {
      it(`${role}: ${name} is refused and reads nothing`, async () => {
        signIn({ role }, [GRANTED_ENTITY, FORBIDDEN_ENTITY]);
        expect(isRefusal(await call())).toBe(true);
        onlyAccessLookup();
      });
    }
    it(`${role}: cannot create an entity`, async () => {
      signIn({ role }, [GRANTED_ENTITY]);
      const result = await documentActions.createEntity({ name: 'X', type: 'manufacturing', financialYearEnd: '', vatRegistered: false, tin: '' });
      expect(isRefusal(result)).toBe(true);
      onlyAccessLookup();
    });
    it(`${role}: cannot switch VAT registration on an entity they can see`, async () => {
      signIn({ role }, [GRANTED_ENTITY]);
      const result = await vatActions.setVatRegistration(GRANTED_ENTITY, { registered: true, registeredFrom: '2026-10-01' });
      expect(isRefusal(result)).toBe(true);
      onlyAccessLookup();
    });
  }

  it('viewer: cannot create a contact', async () => {
    signIn({ role: 'viewer' }, [GRANTED_ENTITY]);
    const result = await documentActions.createContact({
      name: 'X',
      type: 'supplier',
      category: 'supplier',
      tin: '',
      phone: '',
      email: '',
      address: '',
      withholdingTaxStatus: 'none',
      isFarmerAggregator: false,
    });
    expect(isRefusal(result)).toBe(true);
    onlyAccessLookup();
  });
});

// --- sessions that should be worthless ---------------------------------------------

describe('stale sessions', () => {
  it('a deactivated user with a surviving session is treated as signed out', async () => {
    signIn({ role: 'owner', deactivatedAt: new Date() }, []);
    expect(isRefusal(await documentActions.postDocument(GRANTED_ENTITY, 'doc-1'))).toBe(true);
    expect((await routeCalls['GET /api/audit']()).status).toBe(401);
    expect(dbCalls).toEqual([]);
  });

  it('a locked user with a surviving session is treated as signed out', async () => {
    signIn({ role: 'accountant', banned: true }, [GRANTED_ENTITY]);
    expect(isRefusal(await documentActions.postDocument(GRANTED_ENTITY, 'doc-1'))).toBe(true);
    expect(dbCalls).toEqual([]);
  });

  it('an Accountant who has not set up TOTP can do nothing, even on their own entity', async () => {
    signIn({ role: 'accountant', twoFactorEnabled: false }, [GRANTED_ENTITY]);
    const result = await documentActions.postDocument(GRANTED_ENTITY, 'doc-1');
    expect(isRefusal(result)).toBe(true);
    expect(errorOf(result)).toMatch(/two-factor/);
    onlyAccessLookup();
  });

  it('a Viewer without TOTP is not blocked by it (their role cannot post)', async () => {
    signIn({ role: 'viewer', twoFactorEnabled: false }, [GRANTED_ENTITY]);
    const result = await documentActions.postDocument(GRANTED_ENTITY, 'doc-1');
    expect(errorOf(result)).toMatch(/cannot do that/);
  });
});

// --- positive control ----------------------------------------------------------------

describe('positive control: the guard is what stopped the calls above', () => {
  it('an Accountant on Oikazi posting to Oikazi gets past the guard to the document lookup', async () => {
    signIn({ role: 'accountant' }, [FORBIDDEN_ENTITY]);
    // The fake database refuses the first real read, so the call throws — and
    // the name of that read is the proof the guard let it through.
    await expect(documentActions.postDocument(FORBIDDEN_ENTITY, 'doc-1')).rejects.toThrow('unexpected database access: entity.findUnique');
    expect(dbCalls).toEqual(['userEntityAccess.findMany', 'entity.findUnique']);
  });

  it('an Owner reaches the audit trail of any entity', async () => {
    signIn({ role: 'owner' }, []);
    await expect(routeCalls['GET /api/audit']()).rejects.toThrow('unexpected database access: entity.count');
    // Owners hold every entity implicitly: no access rows were even read.
    expect(dbCalls).toEqual(['entity.count']);
  });

  it('an Owner reaches the user list', async () => {
    signIn({ role: 'owner' }, []);
    await expect(userActions.listUsers()).rejects.toThrow('unexpected database access: user.findMany');
  });
});
