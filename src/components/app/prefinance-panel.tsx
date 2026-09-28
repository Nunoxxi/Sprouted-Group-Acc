'use client';

/**
 * Pre-finance: the borrowed money, where it went, and how long it took to come
 * back.
 *
 * The language throughout is money in and money out. Nobody using this is an
 * accountant, and the questions they actually have are plain ones — how much
 * is still out there, who is late, what did wet nuts cost us this season, can
 * we go round again before the loan is due.
 *
 * Every change goes through src/app/actions/prefinance.ts. The arithmetic
 * shown here comes from src/lib/prefinance.ts, never from sums done in the
 * component, so a figure on this screen and the same figure in a report cannot
 * drift apart.
 */

import { useMemo, useState, useTransition } from 'react';

import {
  accrueTrancheInterest,
  closeFacility,
  drawTranche,
  repayTranche,
  recordDelivery,
  runAdvanceProvision,
  saveAdvance,
  saveCycle,
  saveFacility,
  savePreFinanceSettings,
  setExposureLimit,
  writeOffAdvance,
} from '@/app/actions/prefinance';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import type { Permission } from '@/lib/authz';
import type {
  AdvanceDeliveryRecord,
  AggregatorAdvanceRecord,
  BankAccountRecord,
  ContactRecord,
  EntityRecord,
  LoanFacilityRecord,
  LoanTrancheRecord,
  PreFinanceCycleRecord,
  PreFinanceSettingRecord,
} from '@/lib/data/types';
import {
  ageAdvances,
  averageCycleDays,
  dayCountBases,
  dayCountLabels,
  moistureMethodLabels,
  moistureMethods,
  outturnMethodLabels,
  outturnMethods,
  netWeight,
  provisionTotal,
  recycleMeasures,
  settleQuality,
  validateTicket,
  type Cycle,
  type DayCountBasis,
  type MoistureMethod,
  type OutturnMethod,
  type SettlementOutcome,
} from '@/lib/prefinance';

type Props = {
  entity: EntityRecord;
  settings: PreFinanceSettingRecord;
  facilities: LoanFacilityRecord[];
  tranches: LoanTrancheRecord[];
  advances: AggregatorAdvanceRecord[];
  deliveries: AdvanceDeliveryRecord[];
  cycles: PreFinanceCycleRecord[];
  contacts: ContactRecord[];
  bankAccounts: BankAccountRecord[];
  allowed: (permission: Permission) => boolean;
};

type Tab = 'Overview' | 'Borrowing' | 'Advances' | 'Deliveries' | 'Aggregators' | 'Cycles' | 'Terms';

const selectClass =
  'min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50';
const label = 'mb-1.5 block text-sm font-medium text-slate-700';
const todayIso = () => new Date().toISOString().slice(0, 10);
const toMinor = (text: string) => Math.round(Number(String(text).replace(/,/g, '')) * 100);
const addDays = (date: string, days: number) => new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

/**
 * A stored cycle as the arithmetic wants it.
 *
 * The two shapes differ on purpose. What is stored is the six dates a person
 * actually knows; what the domain measures from is when the money left and
 * when it came back. Money leaving means the advance going out, and only the
 * drawdown when nothing has been advanced yet — the loan sitting in the bank
 * is not money at work.
 */
function toDomainCycle(cycle: PreFinanceCycleRecord): Cycle {
  return {
    id: cycle.id,
    reference: cycle.reference,
    deployedOn: cycle.advancedOn ?? cycle.drawnOn,
    deployedMinor: cycle.advancedMinor > 0 ? cycle.advancedMinor : cycle.drawnMinor,
    drawnOn: cycle.drawnOn,
    firstDeliveryOn: cycle.deliveredOn,
    soldOn: cycle.soldOn,
    cashBackOn: cycle.cashBackOn,
    proceedsMinor: cycle.proceedsMinor,
    costOfGoodsMinor: cycle.costsMinor,
  };
}

/** Days, said the way a person would say them. */
function inWords(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return '1 day';
  if (days < 21) return `${days} days`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  return `${Math.round(days / 30)} months`;
}

export function PreFinancePanel({
  entity,
  settings,
  facilities,
  tranches,
  advances,
  deliveries,
  cycles,
  contacts,
  bankAccounts,
  allowed,
}: Props) {
  const [tab, setTab] = useState<Tab>('Overview');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const today = todayIso();

  const canManage = allowed('prefinance:manage');
  const openAdvances = advances.filter((advance) => advance.status === 'open');
  const activeFacilities = facilities.filter((facility) => facility.status === 'active');

  /** Ageing, from the entity's own thresholds. */
  const aged = useMemo(
    () =>
      ageAdvances(
        openAdvances.map((advance) => ({
          id: advance.id,
          aggregatorId: advance.aggregatorId,
          aggregatorName: advance.aggregatorName,
          amountMinor: advance.outstandingMinor,
          advancedOn: advance.advancedOn,
          expectedOn: advance.expectedOn,
        })),
        { flagAfterDays: settings.flagAfterDays, provisionAfterDays: settings.provisionAfterDays, provisionPct: settings.provisionPct },
        today,
      ),
    [openAdvances, settings.flagAfterDays, settings.provisionAfterDays, settings.provisionPct, today],
  );

  const outstandingAdvances = openAdvances.reduce((sum, advance) => sum + advance.outstandingMinor, 0);
  const borrowed = facilities.reduce((sum, facility) => sum + facility.outstandingMinor, 0);
  const headroom = activeFacilities.reduce((sum, facility) => sum + facility.headroomMinor, 0);
  const interestSoFar = facilities.reduce((sum, facility) => sum + facility.accruedInterestMinor, 0);
  const lateCount = aged.filter((advance) => advance.flagged).length;
  const provision = provisionTotal(aged);

  /** What quality has cost, or earned, across every load this season. */
  const qualityEffect = useMemo(
    () => ({
      total: deliveries.reduce((sum, delivery) => sum + delivery.varianceMinor, 0),
      moisture: deliveries.reduce((sum, delivery) => sum + delivery.moistureVarianceMinor, 0),
      outturn: deliveries.reduce((sum, delivery) => sum + delivery.outturnVarianceMinor, 0),
    }),
    [deliveries],
  );

  const completeCycles = cycles.filter((cycle) => cycle.isComplete);
  const asCycles = useMemo(() => cycles.map(toDomainCycle), [cycles]);
  const averageDays = useMemo(() => averageCycleDays(asCycles), [asCycles]);

  const recycle = useMemo(() => {
    const limit = activeFacilities.reduce((sum, facility) => sum + facility.limitMinor, 0);
    if (limit === 0) return null;
    return recycleMeasures({ limitMinor: limit }, asCycles);
  }, [activeFacilities, asCycles]);

  function run(action: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      setMessage(result.ok ? { tone: 'ok', text: success } : { tone: 'error', text: result.error ?? 'That did not work.' });
    });
  }

  // --- forms ---------------------------------------------------------------

  const [facilityForm, setFacilityForm] = useState({
    reference: '',
    lenderId: '',
    limit: '',
    ratePct: '',
    basis: 'actual/365' as DayCountBasis,
    startsOn: today,
    endsOn: '',
  });

  const [drawForm, setDrawForm] = useState({ facilityId: '', drawnOn: today, amount: '', bankAccountId: '' });

  const [advanceForm, setAdvanceForm] = useState({
    reference: '',
    aggregatorId: '',
    advancedOn: today,
    expectedOn: addDays(today, 14),
    amount: '',
    pricePerKg: '',
    bankAccountId: '',
    facilityId: '',
    outturn: String(settings.defaultOutturn),
    moisturePct: String(settings.defaultMoisturePct),
    moistureMethod: settings.defaultMoistureMethod,
    moisturePctPerPoint: settings.defaultMoisturePctPerPoint === null ? '' : String(settings.defaultMoisturePctPerPoint),
    outturnMethod: settings.defaultOutturnMethod,
    outturnPerPoint: settings.defaultOutturnMinorPerPoint === null ? '' : String(settings.defaultOutturnMinorPerPoint / 100),
    notes: '',
    acknowledged: false,
  });

  const [termsForm, setTermsForm] = useState({
    outturn: String(settings.defaultOutturn),
    moisturePct: String(settings.defaultMoisturePct),
    moistureMethod: settings.defaultMoistureMethod,
    moisturePctPerPoint: settings.defaultMoisturePctPerPoint === null ? '' : String(settings.defaultMoisturePctPerPoint),
    outturnMethod: settings.defaultOutturnMethod,
    outturnPerPoint: settings.defaultOutturnMinorPerPoint === null ? '' : String(settings.defaultOutturnMinorPerPoint / 100),
    flagAfterDays: String(settings.flagAfterDays),
    provisionAfterDays: String(settings.provisionAfterDays),
    provisionPct: String(settings.provisionPct),
  });

  const [deliveryForm, setDeliveryForm] = useState({
    advanceId: '',
    deliveredOn: today,
    vehicle: '',
    waybill: '',
    grossKg: '',
    tareKg: '',
    netKg: '',
    bags: '',
    outturn: '',
    moisturePct: '',
    assayedBy: '',
    outcome: 'carry-forward' as SettlementOutcome,
  });

  const chosenAdvance = openAdvances.find((advance) => advance.id === deliveryForm.advanceId) ?? null;
  const ticket = useMemo(
    () => ({
      grossGrams: deliveryForm.grossKg ? Math.round(Number(deliveryForm.grossKg) * 1000) : null,
      tareGrams: deliveryForm.tareKg ? Math.round(Number(deliveryForm.tareKg) * 1000) : null,
      netGrams: deliveryForm.netKg ? Math.round(Number(deliveryForm.netKg) * 1000) : null,
      bags: deliveryForm.bags ? Number(deliveryForm.bags) : null,
    }),
    [deliveryForm.grossKg, deliveryForm.tareKg, deliveryForm.netKg, deliveryForm.bags],
  );
  const ticketGrams = useMemo(() => netWeight(ticket), [ticket]);
  // Only complain once there is something to complain about; an empty form is
  // not a mistake, it is somebody who has not started.
  const ticketProblems = deliveryForm.grossKg || deliveryForm.tareKg || deliveryForm.netKg ? validateTicket(ticket) : [];

  /**
   * What the load settles at, worked out as the fields are filled in.
   *
   * The same function the server will use, so what is shown before saving and
   * what is posted after cannot differ.
   */
  const preview = useMemo(() => {
    if (!chosenAdvance || ticketGrams === null || ticketGrams <= 0) return null;
    const outturn = Number(deliveryForm.outturn);
    const moisturePct = Number(deliveryForm.moisturePct);
    if (!Number.isFinite(outturn) || outturn <= 0) return null;
    if (!Number.isFinite(moisturePct) || moisturePct < 0 || moisturePct >= 100) return null;
    return settleQuality(
      {
        outturn: chosenAdvance.terms.outturn,
        moisturePct: chosenAdvance.terms.moisturePct,
        moistureMethod: chosenAdvance.terms.moistureMethod,
        moisturePctPerPoint: chosenAdvance.terms.moisturePctPerPoint ?? undefined,
        outturnMethod: chosenAdvance.terms.outturnMethod,
        outturnMinorPerPoint: chosenAdvance.terms.outturnMinorPerPoint ?? undefined,
        outturnBonus: chosenAdvance.terms.outturnBonus ?? undefined,
      },
      chosenAdvance.pricePerKgMinor,
      { grams: ticketGrams, outturn, moisturePct },
    );
  }, [chosenAdvance, ticketGrams, deliveryForm.outturn, deliveryForm.moisturePct]);

  const aggregators = useMemo(() => contacts.filter((contact) => contact.category !== 'group-entity' && contact.isActive), [contacts]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {(['Overview', 'Borrowing', 'Advances', 'Deliveries', 'Aggregators', 'Cycles', 'Terms'] as Tab[]).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={`min-h-[44px] rounded-lg px-4 py-2 text-sm font-medium ${
              tab === name ? 'bg-brand-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            {name}
          </button>
        ))}
      </div>

      {message && (
        <div className={`rounded-lg px-4 py-3 text-sm ${message.tone === 'ok' ? 'bg-emerald-50 text-emerald-900' : 'bg-rose-50 text-rose-900'}`}>
          {message.text}
        </div>
      )}

      {/* --- Overview ------------------------------------------------------ */}
      {tab === 'Overview' && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <p className="text-sm text-slate-500">Money out with aggregators</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">
                <Money value={outstandingAdvances} currency={entity.functionalCurrency} />
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {openAdvances.length} advance{openAdvances.length === 1 ? '' : 's'} still owed, in nuts or in cash
              </p>
            </Card>
            <Card>
              <p className="text-sm text-slate-500">Money we owe the lender</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">
                <Money value={borrowed} currency={entity.functionalCurrency} />
              </p>
              <p className="mt-1 text-xs text-slate-500">
                <Money value={headroom} currency={entity.functionalCurrency} /> still available to draw
              </p>
            </Card>
            <Card>
              <p className="text-sm text-slate-500">Interest so far</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">
                <Money value={interestSoFar} currency={entity.functionalCurrency} />
              </p>
              <p className="mt-1 text-xs text-slate-500">Charged as it builds up, not when the lender collects</p>
            </Card>
            <Card className={lateCount > 0 ? 'border-amber-300 bg-amber-50' : ''}>
              <p className="text-sm text-slate-500">Late</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{lateCount}</p>
              <p className="mt-1 text-xs text-slate-500">
                {provision > 0 ? (
                  <>
                    <Money value={provision} currency={entity.functionalCurrency} /> set aside against them
                  </>
                ) : (
                  `Flagged after ${settings.flagAfterDays} days past the promised date`
                )}
              </p>
            </Card>
          </div>

          <Card>
            <h3 className="text-base font-semibold text-slate-900">What quality has cost this season</h3>
            <p className="mt-1 text-sm text-slate-600">
              The difference between what loads were worth at the quality agreed, and what they were actually worth.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">Altogether</p>
                <p className={`mt-1 text-xl font-semibold ${qualityEffect.total < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                  <Money value={qualityEffect.total} currency={entity.functionalCurrency} />
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">Because loads were wet</p>
                <p className="mt-1 text-xl font-semibold text-slate-900">
                  <Money value={qualityEffect.moisture} currency={entity.functionalCurrency} />
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">Because of outturn</p>
                <p className={`mt-1 text-xl font-semibold ${qualityEffect.outturn < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                  <Money value={qualityEffect.outturn} currency={entity.functionalCurrency} />
                </p>
              </div>
            </div>
            {deliveries.length === 0 && <p className="mt-3 text-sm text-slate-500">Nothing delivered yet.</p>}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h3 className="text-base font-semibold text-slate-900">How fast the money comes back</h3>
              {completeCycles.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">No cycle has finished yet, so there is nothing to average.</p>
              ) : (
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-slate-600">Average time round</dt>
                    <dd className="font-medium text-slate-900">{averageDays === null ? '—' : inWords(averageDays)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-600">Cycles finished</dt>
                    <dd className="font-medium text-slate-900">{completeCycles.length}</dd>
                  </div>
                  {recycle && (
                    <>
                      <div className="flex justify-between">
                        <dt className="text-slate-600">Bought per cedi borrowed</dt>
                        <dd className="font-medium text-slate-900">{recycle.cashBasedTimes === null ? '—' : `${recycle.cashBasedTimes.toFixed(2)}×`}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-600">Times the same money went round</dt>
                        <dd className="font-medium text-slate-900">{recycle.completedCycles}</dd>
                      </div>
                    </>
                  )}
                </dl>
              )}
            </Card>

            <Card className={lateCount > 0 ? 'border-amber-300' : ''}>
              <h3 className="text-base font-semibold text-slate-900">Who is late</h3>
              {aged.filter((advance) => advance.flagged).length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">Nobody. Every advance is inside the agreed time.</p>
              ) : (
                <ul className="mt-3 space-y-2 text-sm">
                  {aged
                    .filter((advance) => advance.flagged)
                    .slice(0, 6)
                    .map((advance) => (
                      <li key={advance.id} className="flex items-baseline justify-between gap-3">
                        <span className="text-slate-900">{advance.aggregatorName}</span>
                        <span className="text-right">
                          <Money value={advance.amountMinor} currency={entity.functionalCurrency} />
                          <span className="ml-2 text-xs text-amber-700">{inWords(advance.daysOverdue)} late</span>
                        </span>
                      </li>
                    ))}
                </ul>
              )}
              {canManage && aged.length > 0 && (
                <Button
                  className="mt-4"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => run(() => runAdvanceProvision(entity.id, today), 'Provision brought up to date.')}
                >
                  Set money aside against the late ones
                </Button>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* --- Borrowing ----------------------------------------------------- */}
      {tab === 'Borrowing' && (
        <div className="space-y-5">
          <Card>
            <h3 className="text-base font-semibold text-slate-900">Facilities</h3>
            {facilities.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">Nothing borrowed yet.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="pb-2 pr-3">Reference</th>
                      <th className="pb-2 pr-3">Lender</th>
                      <th className="pb-2 pr-3 text-right">Limit</th>
                      <th className="pb-2 pr-3 text-right">Owed now</th>
                      <th className="pb-2 pr-3 text-right">Left to draw</th>
                      <th className="pb-2 pr-3 text-right">Rate</th>
                      <th className="pb-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {facilities.map((facility) => (
                      <tr key={facility.id} className="border-b border-slate-100">
                        <td className="py-2 pr-3 font-medium text-slate-900">{facility.reference}</td>
                        <td className="py-2 pr-3 text-slate-600">{facility.lenderName || '—'}</td>
                        <td className="py-2 pr-3 text-right">
                          <Money value={facility.limitMinor} currency={entity.functionalCurrency} />
                        </td>
                        <td className="py-2 pr-3 text-right">
                          <Money value={facility.outstandingMinor} currency={entity.functionalCurrency} />
                        </td>
                        <td className="py-2 pr-3 text-right">
                          <Money value={facility.headroomMinor} currency={entity.functionalCurrency} />
                        </td>
                        <td className="py-2 pr-3 text-right text-slate-600">{facility.ratePct}%</td>
                        <td className="py-2 text-right">
                          {canManage && facility.status === 'active' && facility.outstandingMinor === 0 && (
                            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => closeFacility(entity.id, facility.id), 'Facility closed.')}>
                              Close
                            </Button>
                          )}
                          {facility.status === 'closed' && <span className="text-xs text-slate-400">Closed</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {canManage && (
            <Card>
              <h3 className="text-base font-semibold text-slate-900">Add a facility</h3>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label className={label} htmlFor="pf-ref">
                    Reference
                  </label>
                  <Input id="pf-ref" value={facilityForm.reference} onChange={(event) => setFacilityForm({ ...facilityForm, reference: event.target.value })} />
                </div>
                <div>
                  <label className={label} htmlFor="pf-lender">
                    Lender
                  </label>
                  <select id="pf-lender" className={selectClass} value={facilityForm.lenderId} onChange={(event) => setFacilityForm({ ...facilityForm, lenderId: event.target.value })}>
                    <option value="">Not recorded</option>
                    {aggregators.map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label} htmlFor="pf-limit">
                    Most we may borrow
                  </label>
                  <Input id="pf-limit" inputMode="decimal" value={facilityForm.limit} onChange={(event) => setFacilityForm({ ...facilityForm, limit: event.target.value })} />
                </div>
                <div>
                  <label className={label} htmlFor="pf-rate">
                    Interest a year (%)
                  </label>
                  <Input id="pf-rate" inputMode="decimal" value={facilityForm.ratePct} onChange={(event) => setFacilityForm({ ...facilityForm, ratePct: event.target.value })} />
                </div>
                <div>
                  <label className={label} htmlFor="pf-basis">
                    How the year is counted
                  </label>
                  <select id="pf-basis" className={selectClass} value={facilityForm.basis} onChange={(event) => setFacilityForm({ ...facilityForm, basis: event.target.value as DayCountBasis })}>
                    {dayCountBases.map((basis) => (
                      <option key={basis} value={basis}>
                        {dayCountLabels[basis]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label} htmlFor="pf-start">
                    Starts
                  </label>
                  <Input id="pf-start" type="date" value={facilityForm.startsOn} onChange={(event) => setFacilityForm({ ...facilityForm, startsOn: event.target.value })} />
                </div>
              </div>
              <Button
                className="mt-4"
                disabled={pending}
                onClick={() =>
                  run(
                    () =>
                      saveFacility(entity.id, {
                        reference: facilityForm.reference,
                        lenderId: facilityForm.lenderId || null,
                        limitMinor: toMinor(facilityForm.limit),
                        ratePct: facilityForm.ratePct,
                        basis: facilityForm.basis,
                        startsOn: facilityForm.startsOn,
                        endsOn: facilityForm.endsOn || null,
                      }),
                    'Facility added.',
                  )
                }
              >
                Add facility
              </Button>
            </Card>
          )}

          <Card>
            <h3 className="text-base font-semibold text-slate-900">Drawdowns</h3>
            {tranches.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">Nothing drawn yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-slate-100 text-sm">
                {tranches.map((tranche) => (
                  <li key={tranche.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium text-slate-900">
                        <Money value={tranche.amountMinor} currency={entity.functionalCurrency} />
                      </span>
                      <span className="ml-2 text-slate-500">
                        {tranche.facilityReference} · drawn {tranche.drawnOn}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      {tranche.interestMinor > 0 && (
                        <span className="text-xs text-slate-500">
                          interest <Money value={tranche.interestMinor} currency={entity.functionalCurrency} />
                        </span>
                      )}
                      {tranche.repaidOn ? (
                        <span className="text-xs text-emerald-700">repaid {tranche.repaidOn}</span>
                      ) : (
                        canManage && (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={pending}
                              onClick={() => run(() => accrueTrancheInterest(entity.id, tranche.id, today), 'Interest brought up to date.')}
                            >
                              Charge interest
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={pending || !drawForm.bankAccountId}
                              onClick={() => run(() => repayTranche(entity.id, tranche.id, { repaidOn: today, bankAccountId: drawForm.bankAccountId }), 'Repayment recorded.')}
                            >
                              Repay
                            </Button>
                          </>
                        )
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {canManage && activeFacilities.length > 0 && (
            <Card>
              <h3 className="text-base font-semibold text-slate-900">Draw money</h3>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label className={label} htmlFor="pf-draw-facility">
                    From which facility
                  </label>
                  <select id="pf-draw-facility" className={selectClass} value={drawForm.facilityId} onChange={(event) => setDrawForm({ ...drawForm, facilityId: event.target.value })}>
                    <option value="">Choose…</option>
                    {activeFacilities.map((facility) => (
                      <option key={facility.id} value={facility.id}>
                        {facility.reference}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label} htmlFor="pf-draw-amount">
                    How much
                  </label>
                  <Input id="pf-draw-amount" inputMode="decimal" value={drawForm.amount} onChange={(event) => setDrawForm({ ...drawForm, amount: event.target.value })} />
                </div>
                <div>
                  <label className={label} htmlFor="pf-draw-date">
                    Date
                  </label>
                  <Input id="pf-draw-date" type="date" value={drawForm.drawnOn} onChange={(event) => setDrawForm({ ...drawForm, drawnOn: event.target.value })} />
                </div>
                <div>
                  <label className={label} htmlFor="pf-draw-bank">
                    Into which account
                  </label>
                  <select id="pf-draw-bank" className={selectClass} value={drawForm.bankAccountId} onChange={(event) => setDrawForm({ ...drawForm, bankAccountId: event.target.value })}>
                    <option value="">Choose…</option>
                    {bankAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <Button
                className="mt-4"
                disabled={pending || !drawForm.facilityId || !drawForm.bankAccountId}
                onClick={() =>
                  run(
                    () => drawTranche(entity.id, { facilityId: drawForm.facilityId, drawnOn: drawForm.drawnOn, amountMinor: toMinor(drawForm.amount), bankAccountId: drawForm.bankAccountId }),
                    'Money drawn.',
                  )
                }
              >
                Draw
              </Button>
            </Card>
          )}
        </div>
      )}

      {/* --- Advances ------------------------------------------------------ */}
      {tab === 'Advances' && (
        <div className="space-y-5">
          <Card>
            <h3 className="text-base font-semibold text-slate-900">Money out with aggregators</h3>
            {advances.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">Nothing advanced yet.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="pb-2 pr-3">Who</th>
                      <th className="pb-2 pr-3">Promised by</th>
                      <th className="pb-2 pr-3 text-right">Advanced</th>
                      <th className="pb-2 pr-3 text-right">Delivered</th>
                      <th className="pb-2 pr-3 text-right">Still owed</th>
                      <th className="pb-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {advances.map((advance) => {
                      const age = aged.find((row) => row.id === advance.id);
                      return (
                        <tr key={advance.id} className={`border-b border-slate-100 ${age?.flagged ? 'bg-amber-50' : ''}`}>
                          <td className="py-2 pr-3">
                            <span className="font-medium text-slate-900">{advance.aggregatorName}</span>
                            <span className="ml-2 text-xs text-slate-500">{advance.reference}</span>
                          </td>
                          <td className="py-2 pr-3 text-slate-600">
                            {advance.expectedOn}
                            {age?.flagged && <span className="ml-2 text-xs text-amber-700">{inWords(age.daysOverdue)} late</span>}
                          </td>
                          <td className="py-2 pr-3 text-right">
                            <Money value={advance.amountMinor} currency={entity.functionalCurrency} />
                          </td>
                          <td className="py-2 pr-3 text-right">
                            <Money value={advance.deliveredValueMinor} currency={entity.functionalCurrency} />
                          </td>
                          <td className="py-2 pr-3 text-right font-medium">
                            <Money value={advance.outstandingMinor} currency={entity.functionalCurrency} />
                          </td>
                          <td className="py-2 text-right">
                            {advance.status === 'open' && canManage && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={pending}
                                onClick={() => {
                                  const reason = window.prompt(`Why is the money owed by ${advance.aggregatorName} being given up on? This stays on the record.`);
                                  if (reason) run(() => writeOffAdvance(entity.id, advance.id, { onDate: today, reason }), 'Written off.');
                                }}
                              >
                                Give up on it
                              </Button>
                            )}
                            {advance.status === 'settled' && <span className="text-xs text-emerald-700">Settled</span>}
                            {advance.status === 'written-off' && <span className="text-xs text-rose-700">Written off</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {canManage && (
            <Card>
              <h3 className="text-base font-semibold text-slate-900">Advance money to an aggregator</h3>
              <p className="mt-1 text-sm text-slate-600">
                The quality below is what the price assumes. It is written onto this advance and never changed afterwards, so when the
                load arrives it is settled against what was actually agreed today.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label className={label} htmlFor="pf-adv-ref">
                    Reference
                  </label>
                  <Input id="pf-adv-ref" value={advanceForm.reference} onChange={(event) => setAdvanceForm({ ...advanceForm, reference: event.target.value })} />
                </div>
                <div>
                  <label className={label} htmlFor="pf-adv-who">
                    Who
                  </label>
                  <select id="pf-adv-who" className={selectClass} value={advanceForm.aggregatorId} onChange={(event) => setAdvanceForm({ ...advanceForm, aggregatorId: event.target.value })}>
                    <option value="">Choose…</option>
                    {aggregators.map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label} htmlFor="pf-adv-amount">
                    How much
                  </label>
                  <Input id="pf-adv-amount" inputMode="decimal" value={advanceForm.amount} onChange={(event) => setAdvanceForm({ ...advanceForm, amount: event.target.value })} />
                </div>
                <div>
                  <label className={label} htmlFor="pf-adv-price">
                    Agreed price a kilo
                  </label>
                  <Input id="pf-adv-price" inputMode="decimal" value={advanceForm.pricePerKg} onChange={(event) => setAdvanceForm({ ...advanceForm, pricePerKg: event.target.value })} />
                </div>
                <div>
                  <label className={label} htmlFor="pf-adv-date">
                    Money out on
                  </label>
                  <Input id="pf-adv-date" type="date" value={advanceForm.advancedOn} onChange={(event) => setAdvanceForm({ ...advanceForm, advancedOn: event.target.value })} />
                </div>
                <div>
                  <label className={label} htmlFor="pf-adv-expected">
                    Nuts promised by
                  </label>
                  <Input id="pf-adv-expected" type="date" value={advanceForm.expectedOn} onChange={(event) => setAdvanceForm({ ...advanceForm, expectedOn: event.target.value })} />
                </div>
                <div>
                  <label className={label} htmlFor="pf-adv-bank">
                    Paid from
                  </label>
                  <select id="pf-adv-bank" className={selectClass} value={advanceForm.bankAccountId} onChange={(event) => setAdvanceForm({ ...advanceForm, bankAccountId: event.target.value })}>
                    <option value="">Choose…</option>
                    {bankAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label} htmlFor="pf-adv-outturn">
                    Outturn the price assumes
                  </label>
                  <Input id="pf-adv-outturn" inputMode="decimal" value={advanceForm.outturn} onChange={(event) => setAdvanceForm({ ...advanceForm, outturn: event.target.value })} />
                </div>
                <div>
                  <label className={label} htmlFor="pf-adv-moisture">
                    Moisture the price assumes (%)
                  </label>
                  <Input id="pf-adv-moisture" inputMode="decimal" value={advanceForm.moisturePct} onChange={(event) => setAdvanceForm({ ...advanceForm, moisturePct: event.target.value })} />
                </div>
                <div>
                  <label className={label} htmlFor="pf-adv-mm">
                    If the load is wet
                  </label>
                  <select id="pf-adv-mm" className={selectClass} value={advanceForm.moistureMethod} onChange={(event) => setAdvanceForm({ ...advanceForm, moistureMethod: event.target.value as MoistureMethod })}>
                    {moistureMethods.map((method) => (
                      <option key={method} value={method}>
                        {moistureMethodLabels[method]}
                      </option>
                    ))}
                  </select>
                </div>
                {advanceForm.moistureMethod === 'price-deduction' && (
                  <div>
                    <label className={label} htmlFor="pf-adv-mpp">
                      Price cut per point of moisture (%)
                    </label>
                    <Input id="pf-adv-mpp" inputMode="decimal" value={advanceForm.moisturePctPerPoint} onChange={(event) => setAdvanceForm({ ...advanceForm, moisturePctPerPoint: event.target.value })} />
                  </div>
                )}
                <div>
                  <label className={label} htmlFor="pf-adv-om">
                    If the outturn differs
                  </label>
                  <select id="pf-adv-om" className={selectClass} value={advanceForm.outturnMethod} onChange={(event) => setAdvanceForm({ ...advanceForm, outturnMethod: event.target.value as OutturnMethod })}>
                    {outturnMethods.map((method) => (
                      <option key={method} value={method}>
                        {outturnMethodLabels[method]}
                      </option>
                    ))}
                  </select>
                </div>
                {advanceForm.outturnMethod === 'per-point' && (
                  <div>
                    <label className={label} htmlFor="pf-adv-opp">
                      Off the price per point of outturn
                    </label>
                    <Input id="pf-adv-opp" inputMode="decimal" value={advanceForm.outturnPerPoint} onChange={(event) => setAdvanceForm({ ...advanceForm, outturnPerPoint: event.target.value })} />
                  </div>
                )}
              </div>
              <Button
                className="mt-4"
                disabled={pending || !advanceForm.aggregatorId || !advanceForm.bankAccountId}
                onClick={() =>
                  run(
                    () =>
                      saveAdvance(entity.id, {
                        reference: advanceForm.reference,
                        aggregatorId: advanceForm.aggregatorId,
                        advancedOn: advanceForm.advancedOn,
                        expectedOn: advanceForm.expectedOn,
                        amountMinor: toMinor(advanceForm.amount),
                        pricePerKgMinor: toMinor(advanceForm.pricePerKg),
                        bankAccountId: advanceForm.bankAccountId,
                        facilityId: advanceForm.facilityId || null,
                        notes: advanceForm.notes,
                        acknowledgedExposure: advanceForm.acknowledged,
                        terms: {
                          outturn: Number(advanceForm.outturn),
                          moisturePct: Number(advanceForm.moisturePct),
                          moistureMethod: advanceForm.moistureMethod,
                          moisturePctPerPoint: advanceForm.moisturePctPerPoint ? Number(advanceForm.moisturePctPerPoint) : undefined,
                          outturnMethod: advanceForm.outturnMethod,
                          outturnMinorPerPoint: advanceForm.outturnPerPoint ? toMinor(advanceForm.outturnPerPoint) : undefined,
                        },
                      }),
                    'Advance recorded.',
                  )
                }
              >
                Send the money
              </Button>
              {message?.tone === 'error' && message.text.includes('limit') && (
                <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={advanceForm.acknowledged} onChange={(event) => setAdvanceForm({ ...advanceForm, acknowledged: event.target.checked })} />
                  I have read the warning and want to go ahead anyway
                </label>
              )}
            </Card>
          )}
        </div>
      )}

      {/* --- Deliveries ---------------------------------------------------- */}
      {tab === 'Deliveries' && (
        <div className="space-y-5">
          {allowed('prefinance:deliver') && openAdvances.length > 0 && (
            <Card>
              <h3 className="text-base font-semibold text-slate-900">A load has arrived</h3>
              <p className="mt-1 text-sm text-slate-600">
                Fill this in the order the ticket reads: which advance it is against, then the weighbridge, then the lab. The
                settlement works itself out at the bottom before anything is saved.
              </p>

              {/* 1 — which advance */}
              <fieldset className="mt-5 border-t border-slate-200 pt-4">
                <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">1 · Against which advance</legend>
                <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="sm:col-span-2">
                    <label className={label} htmlFor="pf-del-advance">
                      Advance
                    </label>
                    <select id="pf-del-advance" className={selectClass} value={deliveryForm.advanceId} onChange={(event) => setDeliveryForm({ ...deliveryForm, advanceId: event.target.value })}>
                      <option value="">Choose…</option>
                      {openAdvances.map((advance) => (
                        <option key={advance.id} value={advance.id}>
                          {advance.aggregatorName} — {advance.reference} (owes {(advance.outstandingMinor / 100).toLocaleString()})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={label} htmlFor="pf-del-date">
                      Date in
                    </label>
                    <Input id="pf-del-date" type="date" value={deliveryForm.deliveredOn} onChange={(event) => setDeliveryForm({ ...deliveryForm, deliveredOn: event.target.value })} />
                  </div>
                  <div>
                    <label className={label} htmlFor="pf-del-waybill">
                      Waybill number
                    </label>
                    <Input id="pf-del-waybill" value={deliveryForm.waybill} onChange={(event) => setDeliveryForm({ ...deliveryForm, waybill: event.target.value })} />
                  </div>
                </div>
                {chosenAdvance && (
                  <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
                    Agreed {(chosenAdvance.pricePerKgMinor / 100).toFixed(2)} a kilo, assuming {chosenAdvance.terms.outturn} outturn and{' '}
                    {chosenAdvance.terms.moisturePct}% moisture. If it is wet: {moistureMethodLabels[chosenAdvance.terms.moistureMethod].toLowerCase()}.
                  </p>
                )}
              </fieldset>

              {/* 2 — the weighbridge */}
              <fieldset className="mt-5 border-t border-slate-200 pt-4">
                <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">2 · On the weighbridge</legend>
                <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <label className={label} htmlFor="pf-del-vehicle">
                      Vehicle
                    </label>
                    <Input id="pf-del-vehicle" placeholder="GT 1234-24" value={deliveryForm.vehicle} onChange={(event) => setDeliveryForm({ ...deliveryForm, vehicle: event.target.value })} />
                  </div>
                  <div>
                    <label className={label} htmlFor="pf-del-gross">
                      Loaded (kg)
                    </label>
                    <Input id="pf-del-gross" inputMode="decimal" value={deliveryForm.grossKg} onChange={(event) => setDeliveryForm({ ...deliveryForm, grossKg: event.target.value })} />
                  </div>
                  <div>
                    <label className={label} htmlFor="pf-del-tare">
                      Empty (kg)
                    </label>
                    <Input id="pf-del-tare" inputMode="decimal" value={deliveryForm.tareKg} onChange={(event) => setDeliveryForm({ ...deliveryForm, tareKg: event.target.value })} />
                  </div>
                  <div>
                    <label className={label} htmlFor="pf-del-bags">
                      Bags
                    </label>
                    <Input id="pf-del-bags" inputMode="numeric" value={deliveryForm.bags} onChange={(event) => setDeliveryForm({ ...deliveryForm, bags: event.target.value })} />
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
                  <span className="text-slate-600">
                    Net weight:{' '}
                    <span className="font-semibold text-slate-900">{ticketGrams === null ? '—' : `${(ticketGrams / 1000).toLocaleString()} kg`}</span>
                  </span>
                  {!deliveryForm.grossKg && !deliveryForm.tareKg && (
                    <label className="flex items-center gap-2 text-slate-600">
                      no weighbridge — weighed directly (kg)
                      <Input className="w-32" inputMode="decimal" value={deliveryForm.netKg} onChange={(event) => setDeliveryForm({ ...deliveryForm, netKg: event.target.value })} />
                    </label>
                  )}
                </div>
                {ticketProblems.length > 0 && (
                  <ul className="mt-2 space-y-1 text-sm text-amber-800">
                    {ticketProblems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                )}
              </fieldset>

              {/* 3 — the lab */}
              <fieldset className="mt-5 border-t border-slate-200 pt-4">
                <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">3 · What the sample said</legend>
                <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <label className={label} htmlFor="pf-del-outturn">
                      Outturn
                    </label>
                    <Input id="pf-del-outturn" inputMode="decimal" value={deliveryForm.outturn} onChange={(event) => setDeliveryForm({ ...deliveryForm, outturn: event.target.value })} />
                  </div>
                  <div>
                    <label className={label} htmlFor="pf-del-moisture">
                      Moisture (%)
                    </label>
                    <Input id="pf-del-moisture" inputMode="decimal" value={deliveryForm.moisturePct} onChange={(event) => setDeliveryForm({ ...deliveryForm, moisturePct: event.target.value })} />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={label} htmlFor="pf-del-assayed">
                      Checked by
                    </label>
                    <Input id="pf-del-assayed" value={deliveryForm.assayedBy} onChange={(event) => setDeliveryForm({ ...deliveryForm, assayedBy: event.target.value })} />
                  </div>
                </div>
              </fieldset>

              {/* 4 — what it settles at */}
              {preview && chosenAdvance && (
                <fieldset className="mt-5 border-t border-slate-200 pt-4">
                  <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">4 · What this load is worth</legend>
                  <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <p className="text-xs text-slate-500">At the quality agreed</p>
                      <p className="mt-1 text-lg font-semibold text-slate-900">
                        <Money value={preview.valueAtBasisMinor} currency={entity.functionalCurrency} />
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Because it was wet</p>
                      <p className="mt-1 text-lg font-semibold text-slate-700">
                        <Money value={preview.moistureVarianceMinor} currency={entity.functionalCurrency} />
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Because of outturn</p>
                      <p className={`mt-1 text-lg font-semibold ${preview.outturnVarianceMinor < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                        <Money value={preview.outturnVarianceMinor} currency={entity.functionalCurrency} />
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">We pay</p>
                      <p className="mt-1 text-lg font-semibold text-slate-900">
                        <Money value={preview.settledValueMinor} currency={entity.functionalCurrency} />
                      </p>
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-slate-600">
                    Paid for {(preview.adjustedGrams / 1000).toLocaleString()}kg at {(preview.adjustedPricePerKgMinor / 100).toFixed(2)} a kilo.{' '}
                    {preview.settledValueMinor >= chosenAdvance.outstandingMinor ? (
                      <>
                        That clears the advance
                        {preview.settledValueMinor > chosenAdvance.outstandingMinor && (
                          <>
                            {' '}
                            and leaves <Money value={preview.settledValueMinor - chosenAdvance.outstandingMinor} currency={entity.functionalCurrency} /> owed to{' '}
                            {chosenAdvance.aggregatorName}
                          </>
                        )}
                        .
                      </>
                    ) : (
                      <>
                        {chosenAdvance.aggregatorName} would still owe{' '}
                        <Money value={chosenAdvance.outstandingMinor - preview.settledValueMinor} currency={entity.functionalCurrency} /> after this load.
                      </>
                    )}
                  </p>

                  {preview.settledValueMinor < chosenAdvance.outstandingMinor && (
                    <div className="mt-4">
                      <label className={label} htmlFor="pf-del-outcome">
                        What happens to the rest
                      </label>
                      <select id="pf-del-outcome" className={`${selectClass} max-w-md`} value={deliveryForm.outcome} onChange={(event) => setDeliveryForm({ ...deliveryForm, outcome: event.target.value as SettlementOutcome })}>
                        <option value="carry-forward">They still owe it — against the next load</option>
                        <option value="collect-shortfall">They will pay it back in cash</option>
                        <option value="square">Let it go — charge it to the season and close the advance</option>
                      </select>
                    </div>
                  )}
                </fieldset>
              )}

              <Button
                className="mt-5"
                disabled={pending || !deliveryForm.advanceId || ticketGrams === null || ticketProblems.length > 0 || !preview}
                onClick={() =>
                  run(
                    () =>
                      recordDelivery(entity.id, {
                        advanceId: deliveryForm.advanceId,
                        deliveredOn: deliveryForm.deliveredOn,
                        vehicle: deliveryForm.vehicle,
                        waybill: deliveryForm.waybill,
                        assayedBy: deliveryForm.assayedBy,
                        grossGrams: deliveryForm.grossKg ? Math.round(Number(deliveryForm.grossKg) * 1000) : null,
                        tareGrams: deliveryForm.tareKg ? Math.round(Number(deliveryForm.tareKg) * 1000) : null,
                        netGrams: deliveryForm.netKg ? Math.round(Number(deliveryForm.netKg) * 1000) : null,
                        bags: deliveryForm.bags ? Number(deliveryForm.bags) : null,
                        outturn: Number(deliveryForm.outturn),
                        moisturePct: Number(deliveryForm.moisturePct),
                        outcome: deliveryForm.outcome,
                      }),
                    'Load recorded and settled.',
                  )
                }
              >
                Record this load
              </Button>
            </Card>
          )}

          <Card>
            <h3 className="text-base font-semibold text-slate-900">Loads received</h3>
            {deliveries.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">Nothing received yet.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="pb-2 pr-3">In</th>
                      <th className="pb-2 pr-3">From</th>
                      <th className="pb-2 pr-3">Vehicle</th>
                      <th className="pb-2 pr-3 text-right">Weight</th>
                      <th className="pb-2 pr-3 text-right">Outturn</th>
                      <th className="pb-2 pr-3 text-right">Moisture</th>
                      <th className="pb-2 pr-3 text-right">We paid</th>
                      <th className="pb-2 pr-3 text-right">Against agreed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deliveries.map((delivery) => (
                      <tr key={delivery.id} className="border-b border-slate-100">
                        <td className="py-2 pr-3 text-slate-600">{delivery.deliveredOn}</td>
                        <td className="py-2 pr-3 font-medium text-slate-900">{delivery.aggregatorName}</td>
                        <td className="py-2 pr-3 text-slate-500">{delivery.vehicle || '—'}</td>
                        <td className="py-2 pr-3 text-right">{(delivery.grams / 1000).toLocaleString()} kg</td>
                        <td className="py-2 pr-3 text-right">{delivery.outturn}</td>
                        <td className="py-2 pr-3 text-right">{delivery.moisturePct}%</td>
                        <td className="py-2 pr-3 text-right">
                          <Money value={delivery.settledValueMinor} currency={entity.functionalCurrency} />
                        </td>
                        <td className={`py-2 pr-3 text-right ${delivery.varianceMinor < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                          <Money value={delivery.varianceMinor} currency={entity.functionalCurrency} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* --- Aggregators --------------------------------------------------- */}
      {tab === 'Aggregators' && (
        <Card>
          <h3 className="text-base font-semibold text-slate-900">Who we advance to, and how much they may owe at once</h3>
          <p className="mt-1 text-sm text-slate-600">
            A limit is about how much is at risk today, not how much has ever been handed over. Leaving it blank means no limit.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="pb-2 pr-3">Who</th>
                  <th className="pb-2 pr-3 text-right">Owes now</th>
                  <th className="pb-2 pr-3 text-right">Limit</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {aggregators.map((contact) => {
                  const theirs = openAdvances.filter((advance) => advance.aggregatorId === contact.id);
                  const owes = theirs.reduce((sum, advance) => sum + advance.outstandingMinor, 0);
                  const limit = theirs[0]?.exposureLimitMinor ?? null;
                  if (owes === 0 && limit === null) return null;
                  return (
                    <tr key={contact.id} className="border-b border-slate-100">
                      <td className="py-2 pr-3 font-medium text-slate-900">{contact.name}</td>
                      <td className="py-2 pr-3 text-right">
                        <Money value={owes} currency={entity.functionalCurrency} />
                      </td>
                      <td className={`py-2 pr-3 text-right ${limit !== null && owes > limit ? 'text-rose-700' : ''}`}>
                        {limit === null ? <span className="text-slate-400">none set</span> : <Money value={limit} currency={entity.functionalCurrency} />}
                      </td>
                      <td className="py-2 text-right">
                        {canManage && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            onClick={() => {
                              const answer = window.prompt(`Most ${contact.name} may owe at once, in cedis. Leave blank for no limit.`, limit === null ? '' : String(limit / 100));
                              if (answer !== null) run(() => setExposureLimit(entity.id, contact.id, answer.trim() === '' ? null : toMinor(answer)), 'Limit set.');
                            }}
                          >
                            Set limit
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* --- Cycles -------------------------------------------------------- */}
      {tab === 'Cycles' && (
        <Card>
          <h3 className="text-base font-semibold text-slate-900">One loop of the money</h3>
          <p className="mt-1 text-sm text-slate-600">
            Drawn, advanced, delivered, processed, sold, paid. A loop counts as finished when the cash is actually back, not when the
            sale was made.
          </p>
          {cycles.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No cycle recorded yet.</p>
          ) : (
            <ul className="mt-4 divide-y divide-slate-100 text-sm">
              {cycles.map((cycle) => (
                <li key={cycle.id} className="py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium text-slate-900">{cycle.reference}</span>
                    <span className={cycle.isComplete ? 'text-xs text-emerald-700' : 'text-xs text-slate-500'}>
                      {cycle.isComplete ? `cash back ${cycle.cashBackOn}` : 'still going round'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    drawn {cycle.drawnOn} · <Money value={cycle.drawnMinor} currency={entity.functionalCurrency} />
                    {cycle.proceedsMinor > 0 && (
                      <>
                        {' '}
                        · sold for <Money value={cycle.proceedsMinor} currency={entity.functionalCurrency} />
                      </>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {canManage && (
            <Button
              className="mt-4"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                const reference = window.prompt('A name for this loop, e.g. "Cycle 1 2026"');
                if (!reference) return;
                const amount = window.prompt('How much was drawn to start it, in cedis?');
                if (!amount) return;
                run(() => saveCycle(entity.id, { reference, drawnOn: today, drawnMinor: toMinor(amount) }), 'Cycle started.');
              }}
            >
              Start a cycle
            </Button>
          )}
        </Card>
      )}

      {/* --- Terms --------------------------------------------------------- */}
      {tab === 'Terms' && (
        <Card>
          <h3 className="text-base font-semibold text-slate-900">What a new advance starts with</h3>
          <p className="mt-1 text-sm text-slate-600">
            These fill in a new advance so nobody types them every time. Changing them here affects the next advance and never one
            already agreed.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className={label} htmlFor="pf-t-outturn">
                Outturn the price assumes
              </label>
              <Input id="pf-t-outturn" inputMode="decimal" value={termsForm.outturn} onChange={(event) => setTermsForm({ ...termsForm, outturn: event.target.value })} disabled={!canManage} />
            </div>
            <div>
              <label className={label} htmlFor="pf-t-moisture">
                Moisture the price assumes (%)
              </label>
              <Input id="pf-t-moisture" inputMode="decimal" value={termsForm.moisturePct} onChange={(event) => setTermsForm({ ...termsForm, moisturePct: event.target.value })} disabled={!canManage} />
            </div>
            <div>
              <label className={label} htmlFor="pf-t-mm">
                If the load is wet
              </label>
              <select id="pf-t-mm" className={selectClass} value={termsForm.moistureMethod} onChange={(event) => setTermsForm({ ...termsForm, moistureMethod: event.target.value as MoistureMethod })} disabled={!canManage}>
                {moistureMethods.map((method) => (
                  <option key={method} value={method}>
                    {moistureMethodLabels[method]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="pf-t-om">
                If the outturn differs
              </label>
              <select id="pf-t-om" className={selectClass} value={termsForm.outturnMethod} onChange={(event) => setTermsForm({ ...termsForm, outturnMethod: event.target.value as OutturnMethod })} disabled={!canManage}>
                {outturnMethods.map((method) => (
                  <option key={method} value={method}>
                    {outturnMethodLabels[method]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="pf-t-flag">
                Flag an advance this many days late
              </label>
              <Input id="pf-t-flag" inputMode="numeric" value={termsForm.flagAfterDays} onChange={(event) => setTermsForm({ ...termsForm, flagAfterDays: event.target.value })} disabled={!canManage} />
            </div>
            <div>
              <label className={label} htmlFor="pf-t-prov">
                Set money aside after this many days
              </label>
              <Input id="pf-t-prov" inputMode="numeric" value={termsForm.provisionAfterDays} onChange={(event) => setTermsForm({ ...termsForm, provisionAfterDays: event.target.value })} disabled={!canManage} />
            </div>
            <div>
              <label className={label} htmlFor="pf-t-provpct">
                How much of it to set aside (%)
              </label>
              <Input id="pf-t-provpct" inputMode="decimal" value={termsForm.provisionPct} onChange={(event) => setTermsForm({ ...termsForm, provisionPct: event.target.value })} disabled={!canManage} />
            </div>
          </div>
          {canManage && (
            <Button
              className="mt-4"
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    savePreFinanceSettings(entity.id, {
                      defaultOutturn: Number(termsForm.outturn),
                      defaultMoisturePct: Number(termsForm.moisturePct),
                      defaultMoistureMethod: termsForm.moistureMethod,
                      defaultMoisturePctPerPoint: termsForm.moisturePctPerPoint ? Number(termsForm.moisturePctPerPoint) : null,
                      defaultOutturnMethod: termsForm.outturnMethod,
                      defaultOutturnMinorPerPoint: termsForm.outturnPerPoint ? toMinor(termsForm.outturnPerPoint) : null,
                      flagAfterDays: Number(termsForm.flagAfterDays),
                      provisionAfterDays: Number(termsForm.provisionAfterDays),
                      provisionPct: Number(termsForm.provisionPct),
                    }),
                  'Saved.',
                )
              }
            >
              Save
            </Button>
          )}
          {settings.updatedAt && (
            <p className="mt-3 text-xs text-slate-500">
              Last changed {settings.updatedAt.slice(0, 10)}
              {settings.updatedByName ? ` by ${settings.updatedByName}` : ''}.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
