'use client';

/**
 * Cash flow forecasting: thirteen weeks or twelve months, for one entity or
 * the group, under whichever set of assumptions is chosen — and two or more
 * of those side by side. The forecast is computed here from what the server
 * read out of the books, so changing an assumption redraws it at once.
 *
 * Seasons, recurring costs and scenarios are saved through
 * src/app/actions/cashflow.ts. Nothing on this screen posts to the ledger.
 */

import { useMemo, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import {
  addScenarioLine,
  cashForecastSources,
  duplicateScenario,
  removeBuyingSeason,
  removeRecurringCost,
  removeScenario,
  removeScenarioLine,
  saveBuyingSeason,
  saveRecurringCost,
  saveScenario,
  setBaselineScenario,
} from '@/app/actions/cashflow';
import type { Permission } from '@/lib/authz';
import type { BuyingSeasonRecord, CashScenarioRecord, CashSourceRecord, CommodityRecord, EntityRecord, RecurringCostRecord } from '@/lib/data/types';
import {
  bucketsFor,
  buildForecast,
  buildGroupForecast,
  compareScenarios,
  defaultAssumptions,
  flowsFor,
  flowSourceLabels,
  horizonLabels,
  horizons,
  missingRates,
  recurringFrequencies,
  recurringFrequencyLabels,
  type Assumptions,
  type CashSources,
  type FlowSource,
  type Horizon,
  type RecurringFrequency,
} from '@/lib/cashflow';
import { currencies, type Currency } from '@/lib/fx';

type Props = {
  entity: EntityRecord;
  /** Every entity the signed-in person may see, for the group view. */
  entities: EntityRecord[];
  sources: Record<string, CashSourceRecord>;
  scenariosByEntity: Record<string, CashScenarioRecord[]>;
  seasons: BuyingSeasonRecord[];
  recurring: RecurringCostRecord[];
  commodities: CommodityRecord[];
  allowed: (permission: Permission) => boolean;
};

type Tab = 'Forecast' | 'Compare' | 'Assumptions' | 'Seasons' | 'Recurring';
const tabs: Tab[] = ['Forecast', 'Compare', 'Assumptions', 'Seasons', 'Recurring'];
const selectClass = 'min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50';
const label = 'mb-1.5 block text-sm font-medium text-slate-700';
const todayIso = () => new Date().toISOString().slice(0, 10);
const toMinor = (text: string) => Math.round(Number(String(text).replace(/,/g, '')) * 100);
const gramsOf = (tonnes: string) => Math.round(Number(String(tonnes).replace(/,/g, '')) * 1_000_000);

const sourceOrder: FlowSource[] = ['invoice', 'contract', 'grant', 'manual', 'bill', 'purchase', 'float', 'recurring'];

/** A scenario's stored assumptions in the shape the pure library wants. */
function assumptionsOf(scenario: CashScenarioRecord | undefined): Assumptions {
  if (!scenario) return defaultAssumptions;
  return {
    collectionDelayDays: scenario.collectionDelayDays,
    pricePct: scenario.pricePct,
    volumePct: scenario.volumePct,
    floatLeadDays: scenario.floatLeadDays,
    rates: scenario.rates as Partial<Record<Currency, string>>,
    minimumCashMinor: scenario.minimumCashMinor,
  };
}

function sourcesOf(source: CashSourceRecord | undefined, scenario: CashScenarioRecord | undefined): CashSources {
  return {
    openings: source?.openings ?? {},
    fixedFlows: source?.fixedFlows ?? [],
    seasons: (source?.seasons ?? []).map((season) => ({
      id: season.id,
      commodityName: season.commodityName,
      currency: season.currency,
      startDate: season.startDate,
      peakDate: season.peakDate,
      endDate: season.endDate,
      expectedGrams: season.expectedGrams,
      priceMinorPerKgMinor: season.priceMinorPerKg,
    })),
    recurring: (source?.recurring ?? []).map((cost) => ({ id: cost.id, name: cost.name, currency: cost.currency, amountMinor: cost.amountMinor, frequency: cost.frequency, startDate: cost.startDate, endDate: cost.endDate })),
    documents: source?.documents ?? [],
    contracts: source?.contracts ?? [],
    manual: (scenario?.lines ?? []).map((line) => ({ id: line.id, date: line.date, currency: line.currency, amountMinor: line.amountMinor, description: line.description })),
  };
}

export function CashflowPanel({ entity, entities, sources, scenariosByEntity, seasons, recurring, commodities, allowed }: Props) {
  const [tab, setTab] = useState<Tab>('Forecast');
  const [horizon, setHorizon] = useState<Horizon>('weekly-13');
  const [scope, setScope] = useState<'entity' | 'group'>('entity');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const today = todayIso();

  const scenarios = useMemo(() => scenariosByEntity[entity.id] ?? [], [scenariosByEntity, entity.id]);
  /** Sources re-read on demand; the page's own copy until then. */
  const [freshSources, setFreshSources] = useState<Record<string, CashSourceRecord>>({});
  const readSources = useMemo(() => ({ ...sources, ...freshSources }), [sources, freshSources]);
  const [scenarioId, setScenarioId] = useState(scenarios.find((row) => row.isBaseline)?.id ?? scenarios[0]?.id ?? '');
  const scenario = scenarios.find((row) => row.id === scenarioId) ?? scenarios[0];
  const assumptions = assumptionsOf(scenario);
  const buckets = useMemo(() => bucketsFor(horizon, today), [horizon, today]);

  const entityFlows = useMemo(() => flowsFor(sourcesOf(readSources[entity.id], scenario), assumptions, buckets), [readSources, entity.id, scenario, assumptions, buckets]);
  const forecast = useMemo(
    () => buildForecast(horizon, today, readSources[entity.id]?.openings ?? {}, entityFlows, assumptions, entity.functionalCurrency),
    [horizon, today, readSources, entity.id, entityFlows, assumptions, entity.functionalCurrency],
  );
  const unratedCurrencies = useMemo(() => missingRates(entityFlows, assumptions, entity.functionalCurrency), [entityFlows, assumptions, entity.functionalCurrency]);

  /**
   * The group: each entity forecast under the scenario of the same name when
   * it has one, and its own baseline when it does not, then added together.
   */
  const group = useMemo(() => {
    const parts = entities.map((row) => {
      const theirs = scenariosByEntity[row.id] ?? [];
      const matched = theirs.find((candidate) => candidate.name === scenario?.name) ?? theirs.find((candidate) => candidate.isBaseline) ?? theirs[0];
      const theirAssumptions = assumptionsOf(matched);
      const flows = flowsFor(sourcesOf(readSources[row.id], matched), theirAssumptions, buckets);
      return {
        entityId: row.id,
        entityName: row.name,
        functionalCurrency: row.functionalCurrency,
        forecast: buildForecast(horizon, today, readSources[row.id]?.openings ?? {}, flows, theirAssumptions, row.functionalCurrency),
        minimumCashMinor: theirAssumptions.minimumCashMinor,
      };
    });
    return buildGroupForecast(
      parts,
      assumptions.rates,
      entity.functionalCurrency,
      parts.reduce((total, part) => total + part.minimumCashMinor, 0),
    );
  }, [entities, scenariosByEntity, scenario?.name, readSources, buckets, horizon, today, assumptions.rates, entity.functionalCurrency]);

  const shown = scope === 'group' ? group.combined : forecast.combined;
  const shownBuckets = scope === 'group' ? group.buckets : forecast.buckets;
  const minimum = scope === 'group' ? group.minimumCashMinor : forecast.minimumCashMinor;

  function run(okText: string, action: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setMessage({ tone: 'ok', text: okText });
        after?.();
      } else setMessage({ tone: 'error', text: result.error ?? 'Something went wrong.' });
    });
  }

  // --- forms -----------------------------------------------------------------------

  const [assumptionForm, setAssumptionForm] = useState({ name: '', collectionDelayDays: '', pricePct: '', volumePct: '', floatLeadDays: '', minimumCash: '', note: '' });
  const [rateForm, setRateForm] = useState<Record<string, string>>({});
  const [copyName, setCopyName] = useState('');
  const [lineForm, setLineForm] = useState({ date: today, currency: entity.functionalCurrency as Currency, amount: '', description: '' });
  const [seasonForm, setSeasonForm] = useState({ id: '', commodityId: '', name: '', startDate: today, peakDate: today, endDate: today, tonnes: '', price: '', note: '' });
  const [costForm, setCostForm] = useState({ id: '', name: '', amount: '', frequency: 'monthly' as RecurringFrequency, startDate: today, endDate: '', note: '' });
  const [compareIds, setCompareIds] = useState<string[]>([]);

  function editAssumptions(row: CashScenarioRecord) {
    setAssumptionForm({
      name: row.name,
      collectionDelayDays: String(row.collectionDelayDays),
      pricePct: String(row.pricePct),
      volumePct: String(row.volumePct),
      floatLeadDays: String(row.floatLeadDays),
      minimumCash: (row.minimumCashMinor / 100).toFixed(2),
      note: row.note,
    });
    setRateForm({ ...row.rates });
  }

  const comparison = useMemo(() => {
    const chosen = compareIds.length ? compareIds : scenarios.slice(0, 2).map((row) => row.id);
    const parts = chosen
      .map((id) => scenarios.find((row) => row.id === id))
      .filter((row): row is CashScenarioRecord => !!row)
      .map((row) => {
        const theirAssumptions = assumptionsOf(row);
        const flows = flowsFor(sourcesOf(readSources[entity.id], row), theirAssumptions, buckets);
        return { name: row.name, forecast: buildForecast(horizon, today, readSources[entity.id]?.openings ?? {}, flows, theirAssumptions, entity.functionalCurrency) };
      });
    return compareScenarios(parts);
  }, [compareIds, scenarios, readSources, entity.id, entity.functionalCurrency, buckets, horizon, today]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{scope === 'group' ? 'Sprouted Group' : entity.name}</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-900">Cash flow forecast</h2>
          <p className="mt-1 text-sm text-slate-600">
            Built from what is already on the books, plus the buying seasons and anything added by hand. Nothing here is posted.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {tabs.map((name) => (
            <Button key={name} size="sm" variant={tab === name ? 'primary' : 'secondary'} onClick={() => setTab(name)}>
              {name}
            </Button>
          ))}
        </div>
      </div>

      {message ? (
        <div className={['rounded-xl border px-4 py-3 text-sm', message.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'].join(' ')}>{message.text}</div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {horizons.map((value) => (
            <button key={value} type="button" onClick={() => setHorizon(value)} className={['rounded-md px-3 py-1.5 text-sm font-medium', horizon === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'].join(' ')}>
              {horizonLabels[value]}
            </button>
          ))}
        </div>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {(['entity', 'group'] as const).map((value) => (
            <button key={value} type="button" onClick={() => setScope(value)} className={['rounded-md px-3 py-1.5 text-sm font-medium', scope === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'].join(' ')}>
              {value === 'entity' ? entity.name : 'Group combined'}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setMessage(null);
            startTransition(async () => {
              const next: Record<string, CashSourceRecord> = {};
              for (const row of entities) {
                const result = await cashForecastSources(row.id);
                if (result.ok) next[row.id] = result.value;
              }
              setFreshSources(next);
              setMessage({ tone: 'ok', text: 'Read again from the books.' });
            });
          }}
        >
          Re-read the books
        </Button>
        {scenarios.length ? (
          <select className="min-h-[40px] rounded-lg border border-slate-200 bg-white px-3 text-sm" value={scenario?.id ?? ''} onChange={(event) => setScenarioId(event.target.value)}>
            {scenarios.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
                {row.isBaseline ? ' (baseline)' : ''}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {scenarios.length === 0 ? (
        <Card className="rounded-2xl">
          <p className="text-sm text-slate-600">
            No assumptions set yet. A forecast needs at least one scenario — the baseline — to say how late customers pay and how much cash you want to keep.
          </p>
          {allowed('document:post') ? (
            <div className="mt-4">
              <Button size="sm" disabled={pending} onClick={() => run('Baseline created.', () => saveScenario(entity.id, { name: 'Baseline' }))}>
                Create the baseline
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}

      {unratedCurrencies.length && scenario ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          No rate set for {unratedCurrencies.join(', ')}. The combined view is treating {unratedCurrencies.length === 1 ? 'it' : 'them'} as one for one until you set one under Assumptions.
        </div>
      ) : null}

      {/* --- the forecast ------------------------------------------------------- */}
      {tab === 'Forecast' && scenario ? (
        <div className="space-y-6">
          <Card className="rounded-2xl">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h3 className="text-lg font-semibold text-slate-900">
                {scope === 'group' ? 'Group combined' : `${entity.name} — all currencies combined`}
                <span className="ml-3 text-sm font-normal text-slate-500">at {scenario.name}</span>
              </h3>
              <div className="text-sm text-slate-600">
                Lowest point <Money value={shown.lowestClosingMinor} className={shown.lowestClosingMinor < minimum ? 'text-rose-700 font-semibold' : ''} />
                {minimum > 0 ? (
                  <>
                    {' '}
                    against a minimum of <Money value={minimum} />
                  </>
                ) : null}
              </div>
            </div>

            {shown.firstShortfall ? (
              <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
                Cash falls below the minimum from <strong>{shown.firstShortfall.label}</strong>. {shown.buckets.filter((bucket) => bucket.belowMinimum).length} of {shown.buckets.length}{' '}
                {horizon === 'weekly-13' ? 'weeks' : 'months'} are short.
              </div>
            ) : (
              <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                Cash stays above the minimum across the whole {horizon === 'weekly-13' ? '13 weeks' : '12 months'}.
              </div>
            )}

            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="sticky left-0 bg-white py-2 pr-4">&nbsp;</th>
                    {shownBuckets.map((bucket) => (
                      <th key={bucket.index} className="py-2 text-right">
                        {bucket.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  <tr>
                    <td className="sticky left-0 bg-white py-2 pr-4 font-medium text-slate-900">Opening</td>
                    {shown.buckets.map((bucket, index) => (
                      <td key={bucket.bucket.index} className="py-2 text-right text-slate-600">
                        <Money value={index === 0 ? shown.openingMinor : shown.buckets[index - 1].closingMinor} />
                      </td>
                    ))}
                  </tr>
                  {sourceOrder.map((source) => {
                    const values = shown.buckets.map((bucket) => bucket.bySource[source] ?? 0);
                    if (values.every((value) => value === 0)) return null;
                    return (
                      <tr key={source}>
                        <td className="sticky left-0 bg-white py-2 pr-4 text-slate-700">{flowSourceLabels[source]}</td>
                        {values.map((value, index) => (
                          <td key={index} className={['py-2 text-right', value < 0 ? 'text-slate-600' : 'text-emerald-700'].join(' ')}>
                            {value === 0 ? <span className="text-slate-300">—</span> : <Money value={value} />}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                  <tr className="font-medium">
                    <td className="sticky left-0 bg-white py-2 pr-4 text-slate-900">Net for the {horizon === 'weekly-13' ? 'week' : 'month'}</td>
                    {shown.buckets.map((bucket) => (
                      <td key={bucket.bucket.index} className="py-2 text-right">
                        <Money value={bucket.netMinor} />
                      </td>
                    ))}
                  </tr>
                  <tr className="border-t-2 border-slate-300 font-semibold">
                    <td className="sticky left-0 bg-white py-2 pr-4 text-slate-900">Closing</td>
                    {shown.buckets.map((bucket) => (
                      <td key={bucket.bucket.index} className={['py-2 text-right', bucket.belowMinimum ? 'bg-rose-50 text-rose-800' : ''].join(' ')}>
                        <Money value={bucket.closingMinor} />
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            {shown.beyondMinor !== 0 ? (
              <p className="mt-3 text-xs text-slate-500">
                <Money value={shown.beyondMinor} /> falls beyond the {horizon === 'weekly-13' ? '13 weeks' : '12 months'} shown.
              </p>
            ) : null}
          </Card>

          {scope === 'entity' && forecast.byCurrency.length > 1 ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">Each currency on its own</h3>
              <p className="mt-1 text-sm text-slate-600">A healthy dollar balance does not pay a cedi wage bill until somebody sells the dollars.</p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                    <tr>
                      <th className="sticky left-0 bg-white py-2 pr-4">Closing balance</th>
                      {forecast.buckets.map((bucket) => (
                        <th key={bucket.index} className="py-2 text-right">
                          {bucket.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {forecast.byCurrency.map((row) => (
                      <tr key={row.currency}>
                        <td className="sticky left-0 bg-white py-2 pr-4 font-medium text-slate-900">{row.currency}</td>
                        {row.buckets.map((bucket) => (
                          <td key={bucket.bucket.index} className={['py-2 text-right', bucket.closingMinor < 0 ? 'bg-rose-50 text-rose-800' : ''].join(' ')}>
                            <Money value={bucket.closingMinor} currency={row.currency} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {scope === 'group' ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">By entity</h3>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                    <tr>
                      <th className="sticky left-0 bg-white py-2 pr-4">Closing balance</th>
                      {group.buckets.map((bucket) => (
                        <th key={bucket.index} className="py-2 text-right">
                          {bucket.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {group.entities.map((row) => (
                      <tr key={row.entityId}>
                        <td className="sticky left-0 bg-white py-2 pr-4 font-medium text-slate-900">{row.entityName}</td>
                        {row.forecast.combined.buckets.map((bucket) => (
                          <td key={bucket.bucket.index} className={['py-2 text-right', bucket.belowMinimum ? 'bg-rose-50 text-rose-800' : ''].join(' ')}>
                            <Money value={bucket.closingMinor} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {allowed('document:post') && scope === 'entity' ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">Add a line by hand</h3>
              <p className="mt-1 text-sm text-slate-600">Anything the books do not know about yet. Positive is money in, negative is money out.</p>
              <div className="mt-4 grid gap-4 md:grid-cols-4">
                <div>
                  <label className={label}>Date</label>
                  <Input type="date" value={lineForm.date} onChange={(e) => setLineForm((f) => ({ ...f, date: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Currency</label>
                  <select className={selectClass} value={lineForm.currency} onChange={(e) => setLineForm((f) => ({ ...f, currency: e.target.value as Currency }))}>
                    {currencies.map((currency) => (
                      <option key={currency} value={currency}>
                        {currency}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Amount</label>
                  <Input inputMode="decimal" value={lineForm.amount} onChange={(e) => setLineForm((f) => ({ ...f, amount: e.target.value }))} placeholder="-25000.00" />
                </div>
                <div>
                  <label className={label}>What it is</label>
                  <Input value={lineForm.description} onChange={(e) => setLineForm((f) => ({ ...f, description: e.target.value }))} placeholder="Vehicle purchase" />
                </div>
              </div>
              <div className="mt-4">
                <Button
                  size="sm"
                  disabled={pending || !lineForm.amount || !lineForm.description.trim()}
                  onClick={() =>
                    run('Line added.', () => addScenarioLine(entity.id, { scenarioId: scenario.id, date: lineForm.date, currency: lineForm.currency, amountMinor: toMinor(lineForm.amount), description: lineForm.description }), () =>
                      setLineForm((f) => ({ ...f, amount: '', description: '' })),
                    )
                  }
                >
                  Add
                </Button>
              </div>
              {scenario.lines.length ? (
                <table className="mt-4 w-full text-sm">
                  <tbody className="divide-y divide-slate-100">
                    {scenario.lines.map((line) => (
                      <tr key={line.id}>
                        <td className="py-2 text-slate-600">{line.date}</td>
                        <td className="py-2 text-slate-900">{line.description}</td>
                        <td className="py-2 text-right">
                          <Money value={line.amountMinor} currency={line.currency} />
                        </td>
                        <td className="py-2 text-right">
                          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run('Line removed.', () => removeScenarioLine(entity.id, line.id))}>
                            Remove
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* --- compare ------------------------------------------------------------- */}
      {tab === 'Compare' ? (
        <div className="space-y-6">
          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Scenarios side by side</h3>
            <p className="mt-1 text-sm text-slate-600">Closing balance in each {horizon === 'weekly-13' ? 'week' : 'month'}, and the difference from the first.</p>
            <div className="mt-4 flex flex-wrap gap-3">
              {scenarios.map((row) => (
                <label key={row.id} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={(compareIds.length ? compareIds : scenarios.slice(0, 2).map((s) => s.id)).includes(row.id)}
                    onChange={() =>
                      setCompareIds((current) => {
                        const base = current.length ? current : scenarios.slice(0, 2).map((s) => s.id);
                        return base.includes(row.id) ? base.filter((id) => id !== row.id) : [...base, row.id];
                      })
                    }
                  />
                  {row.name}
                </label>
              ))}
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="sticky left-0 bg-white py-2 pr-4">Scenario</th>
                    {buckets.map((bucket) => (
                      <th key={bucket.index} className="py-2 text-right">
                        {bucket.label}
                      </th>
                    ))}
                    <th className="py-2 text-right">Lowest</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {comparison.map((row, rowIndex) => (
                    <>
                      <tr key={row.name}>
                        <td className="sticky left-0 bg-white py-2 pr-4 font-medium text-slate-900">
                          {row.name}
                          {row.firstShortfallLabel ? <span className="ml-2 text-xs text-rose-700">short from {row.firstShortfallLabel}</span> : null}
                        </td>
                        {row.closingByBucket.map((value, index) => (
                          <td key={index} className={['py-2 text-right', value < minimum ? 'bg-rose-50 text-rose-800' : ''].join(' ')}>
                            <Money value={value} />
                          </td>
                        ))}
                        <td className="py-2 text-right font-semibold">
                          <Money value={row.lowestClosingMinor} />
                        </td>
                      </tr>
                      {rowIndex > 0 ? (
                        <tr key={`${row.name}-diff`} className="text-xs">
                          <td className="sticky left-0 bg-white py-1 pr-4 text-slate-500">difference</td>
                          {row.differenceFromFirst.map((value, index) => (
                            <td key={index} className={['py-1 text-right', value < 0 ? 'text-rose-700' : value > 0 ? 'text-emerald-700' : 'text-slate-400'].join(' ')}>
                              {value === 0 ? '—' : <Money value={value} />}
                            </td>
                          ))}
                          <td />
                        </tr>
                      ) : null}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
            {comparison.length < 2 ? <p className="mt-3 text-sm text-slate-500">Pick at least two scenarios, or copy one under Assumptions and change it.</p> : null}
          </Card>
        </div>
      ) : null}

      {/* --- assumptions ---------------------------------------------------------- */}
      {tab === 'Assumptions' ? (
        <div className="space-y-6">
          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Scenarios</h3>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="py-2">Name</th>
                    <th className="py-2 text-right">Collection delay</th>
                    <th className="py-2 text-right">Price</th>
                    <th className="py-2 text-right">Volume</th>
                    <th className="py-2 text-right">Float lead</th>
                    <th className="py-2 text-right">Minimum cash</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {scenarios.map((row) => (
                    <tr key={row.id}>
                      <td className="py-2 text-slate-900">
                        {row.name}
                        {row.isBaseline ? <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-slate-600">baseline</span> : null}
                      </td>
                      <td className="py-2 text-right text-slate-600">+{row.collectionDelayDays} days</td>
                      <td className="py-2 text-right text-slate-600">{row.pricePct}%</td>
                      <td className="py-2 text-right text-slate-600">{row.volumePct}%</td>
                      <td className="py-2 text-right text-slate-600">{row.floatLeadDays} days</td>
                      <td className="py-2 text-right">
                        <Money value={row.minimumCashMinor} />
                      </td>
                      <td className="py-2 text-right">
                        {allowed('document:post') ? (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => { setScenarioId(row.id); editAssumptions(row); }}>
                              Edit
                            </Button>
                            {!row.isBaseline ? (
                              <>
                                <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(`${row.name} is now the baseline.`, () => setBaselineScenario(entity.id, row.id))}>
                                  Make baseline
                                </Button>
                                <Button size="sm" variant="ghost" disabled={pending} onClick={() => run('Scenario removed.', () => removeScenario(entity.id, row.id))}>
                                  Remove
                                </Button>
                              </>
                            ) : null}
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {allowed('document:post') && scenario ? (
              <div className="mt-4 flex flex-wrap items-end gap-2">
                <div>
                  <label className={label}>Copy &ldquo;{scenario.name}&rdquo; as</label>
                  <Input value={copyName} onChange={(e) => setCopyName(e.target.value)} placeholder="Poor season" />
                </div>
                <Button size="sm" variant="secondary" disabled={pending || !copyName.trim()} onClick={() => run('Scenario copied.', () => duplicateScenario(entity.id, scenario.id, copyName), () => setCopyName(''))}>
                  Copy and change
                </Button>
              </div>
            ) : null}
          </Card>

          {allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">{assumptionForm.name && scenarios.some((row) => row.name === assumptionForm.name) ? `Assumptions for ${assumptionForm.name}` : 'New scenario'}</h3>
              <div className="mt-4 grid gap-4 md:grid-cols-3">
                <div>
                  <label className={label}>Name</label>
                  <Input value={assumptionForm.name} onChange={(e) => setAssumptionForm((f) => ({ ...f, name: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Customers pay this many days late</label>
                  <Input inputMode="numeric" value={assumptionForm.collectionDelayDays} onChange={(e) => setAssumptionForm((f) => ({ ...f, collectionDelayDays: e.target.value }))} placeholder="0" />
                </div>
                <div>
                  <label className={label}>Minimum cash to keep ({entity.functionalCurrency})</label>
                  <Input inputMode="decimal" value={assumptionForm.minimumCash} onChange={(e) => setAssumptionForm((f) => ({ ...f, minimumCash: e.target.value }))} placeholder="100000.00" />
                </div>
                <div>
                  <label className={label}>Commodity price</label>
                  <Input inputMode="numeric" value={assumptionForm.pricePct} onChange={(e) => setAssumptionForm((f) => ({ ...f, pricePct: e.target.value }))} placeholder="100" />
                  <p className="mt-1 text-xs text-slate-500">% of what the seasons say.</p>
                </div>
                <div>
                  <label className={label}>Volume bought</label>
                  <Input inputMode="numeric" value={assumptionForm.volumePct} onChange={(e) => setAssumptionForm((f) => ({ ...f, volumePct: e.target.value }))} placeholder="100" />
                </div>
                <div>
                  <label className={label}>Float ahead of buying, days</label>
                  <Input inputMode="numeric" value={assumptionForm.floatLeadDays} onChange={(e) => setAssumptionForm((f) => ({ ...f, floatLeadDays: e.target.value }))} placeholder="7" />
                </div>
              </div>
              <h4 className="mt-6 text-sm font-semibold uppercase tracking-[0.12em] text-slate-500">Exchange rates for the combined view</h4>
              <div className="mt-2 grid gap-4 md:grid-cols-4">
                {currencies
                  .filter((currency) => currency !== entity.functionalCurrency)
                  .map((currency) => (
                    <div key={currency}>
                      <label className={label}>
                        {entity.functionalCurrency} per 1 {currency}
                      </label>
                      <Input inputMode="decimal" value={rateForm[currency] ?? ''} onChange={(e) => setRateForm((f) => ({ ...f, [currency]: e.target.value }))} />
                    </div>
                  ))}
              </div>
              <div className="mt-4 flex gap-2">
                <Button
                  size="sm"
                  disabled={pending || !assumptionForm.name.trim()}
                  onClick={() => {
                    const existing = scenarios.find((row) => row.name === assumptionForm.name.trim());
                    run(
                      existing ? 'Assumptions saved.' : 'Scenario added.',
                      () =>
                        saveScenario(entity.id, {
                          id: existing?.id,
                          name: assumptionForm.name,
                          collectionDelayDays: Number(assumptionForm.collectionDelayDays || 0),
                          pricePct: Number(assumptionForm.pricePct || 100),
                          volumePct: Number(assumptionForm.volumePct || 100),
                          floatLeadDays: Number(assumptionForm.floatLeadDays || 7),
                          minimumCashMinor: assumptionForm.minimumCash ? toMinor(assumptionForm.minimumCash) : 0,
                          note: assumptionForm.note,
                          rates: rateForm,
                        }),
                      () => {
                        setAssumptionForm({ name: '', collectionDelayDays: '', pricePct: '', volumePct: '', floatLeadDays: '', minimumCash: '', note: '' });
                        setRateForm({});
                      },
                    );
                  }}
                >
                  Save
                </Button>
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* --- seasons ---------------------------------------------------------------- */}
      {tab === 'Seasons' ? (
        <div className="space-y-6">
          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Buying seasons</h3>
            <p className="mt-1 text-sm text-slate-600">
              Buying is not spread evenly: it rises to the peak and falls away. The forecast follows that curve, so the working capital needed before anything is sold is visible.
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="py-2">Season</th>
                    <th className="py-2">Commodity</th>
                    <th className="py-2">Runs</th>
                    <th className="py-2">Peak</th>
                    <th className="py-2 text-right">Volume</th>
                    <th className="py-2 text-right">Price a kilo</th>
                    <th className="py-2 text-right">Cost</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {seasons.map((row) => (
                    <tr key={row.id}>
                      <td className="py-2 text-slate-900">{row.name}</td>
                      <td className="py-2 text-slate-600">{row.commodityName}</td>
                      <td className="py-2 text-slate-600">
                        {row.startDate} to {row.endDate}
                      </td>
                      <td className="py-2 text-slate-600">{row.peakDate}</td>
                      <td className="py-2 text-right text-slate-600">{(row.expectedGrams / 1_000_000).toLocaleString('en-GH', { maximumFractionDigits: 1 })} t</td>
                      <td className="py-2 text-right">
                        <Money value={row.priceMinorPerKg} currency={row.currency} />
                      </td>
                      <td className="py-2 text-right font-medium">
                        <Money value={Math.round((row.expectedGrams / 1000) * row.priceMinorPerKg)} currency={row.currency} />
                      </td>
                      <td className="py-2 text-right">
                        {allowed('inventory:manage') ? (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => setSeasonForm({ id: row.id, commodityId: row.commodityId, name: row.name, startDate: row.startDate, peakDate: row.peakDate, endDate: row.endDate, tonnes: String(row.expectedGrams / 1_000_000), price: (row.priceMinorPerKg / 100).toFixed(2), note: row.note })}>
                              Edit
                            </Button>
                            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run('Season removed.', () => removeBuyingSeason(entity.id, row.id))}>
                              Remove
                            </Button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {seasons.length === 0 ? (
                    <tr>
                      <td className="py-2 text-slate-500" colSpan={8}>
                        No seasons yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>

          {allowed('inventory:manage') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">{seasonForm.id ? 'Edit season' : 'Add a season'}</h3>
              <div className="mt-4 grid gap-4 md:grid-cols-4">
                <div>
                  <label className={label}>Name</label>
                  <Input value={seasonForm.name} onChange={(e) => setSeasonForm((f) => ({ ...f, name: e.target.value }))} placeholder="2027 main crop" />
                </div>
                <div>
                  <label className={label}>Commodity</label>
                  <select className={selectClass} value={seasonForm.commodityId} onChange={(e) => setSeasonForm((f) => ({ ...f, commodityId: e.target.value }))}>
                    <option value="">Choose…</option>
                    {commodities.filter((row) => row.isActive).map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Volume, tonnes</label>
                  <Input inputMode="decimal" value={seasonForm.tonnes} onChange={(e) => setSeasonForm((f) => ({ ...f, tonnes: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Price a kilo</label>
                  <Input inputMode="decimal" value={seasonForm.price} onChange={(e) => setSeasonForm((f) => ({ ...f, price: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Starts</label>
                  <Input type="date" value={seasonForm.startDate} onChange={(e) => setSeasonForm((f) => ({ ...f, startDate: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Peak</label>
                  <Input type="date" value={seasonForm.peakDate} onChange={(e) => setSeasonForm((f) => ({ ...f, peakDate: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Ends</label>
                  <Input type="date" value={seasonForm.endDate} onChange={(e) => setSeasonForm((f) => ({ ...f, endDate: e.target.value }))} />
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <Button
                  size="sm"
                  disabled={pending || !seasonForm.name.trim() || !seasonForm.commodityId}
                  onClick={() =>
                    run(
                      'Season saved.',
                      () =>
                        saveBuyingSeason(entity.id, {
                          id: seasonForm.id || undefined,
                          commodityId: seasonForm.commodityId,
                          name: seasonForm.name,
                          startDate: seasonForm.startDate,
                          peakDate: seasonForm.peakDate,
                          endDate: seasonForm.endDate,
                          expectedGrams: gramsOf(seasonForm.tonnes || '0'),
                          priceMinorPerKg: toMinor(seasonForm.price || '0'),
                          note: seasonForm.note,
                        }),
                      () => setSeasonForm({ id: '', commodityId: '', name: '', startDate: today, peakDate: today, endDate: today, tonnes: '', price: '', note: '' }),
                    )
                  }
                >
                  Save
                </Button>
                {seasonForm.id ? (
                  <Button size="sm" variant="ghost" onClick={() => setSeasonForm({ id: '', commodityId: '', name: '', startDate: today, peakDate: today, endDate: today, tonnes: '', price: '', note: '' })}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* --- recurring ---------------------------------------------------------------- */}
      {tab === 'Recurring' ? (
        <div className="space-y-6">
          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Payroll, rent and the rest</h3>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="py-2">What</th>
                    <th className="py-2">How often</th>
                    <th className="py-2">From</th>
                    <th className="py-2">Until</th>
                    <th className="py-2 text-right">Each time</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {recurring.map((row) => (
                    <tr key={row.id}>
                      <td className="py-2 text-slate-900">{row.name}</td>
                      <td className="py-2 text-slate-600">{recurringFrequencyLabels[row.frequency]}</td>
                      <td className="py-2 text-slate-600">{row.startDate}</td>
                      <td className="py-2 text-slate-600">{row.endDate ?? '—'}</td>
                      <td className="py-2 text-right">
                        <Money value={row.amountMinor} currency={row.currency} />
                      </td>
                      <td className="py-2 text-right">
                        {allowed('document:post') ? (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => setCostForm({ id: row.id, name: row.name, amount: (row.amountMinor / 100).toFixed(2), frequency: row.frequency, startDate: row.startDate, endDate: row.endDate ?? '', note: row.note })}>
                              Edit
                            </Button>
                            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run('Removed.', () => removeRecurringCost(entity.id, row.id))}>
                              Remove
                            </Button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {recurring.length === 0 ? (
                    <tr>
                      <td className="py-2 text-slate-500" colSpan={6}>
                        Nothing recorded. Payroll and rent are usually the two that matter most.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>

          {allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">{costForm.id ? 'Edit cost' : 'Add a recurring cost'}</h3>
              <div className="mt-4 grid gap-4 md:grid-cols-5">
                <div>
                  <label className={label}>What</label>
                  <Input value={costForm.name} onChange={(e) => setCostForm((f) => ({ ...f, name: e.target.value }))} placeholder="Payroll" />
                </div>
                <div>
                  <label className={label}>Each time</label>
                  <Input inputMode="decimal" value={costForm.amount} onChange={(e) => setCostForm((f) => ({ ...f, amount: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>How often</label>
                  <select className={selectClass} value={costForm.frequency} onChange={(e) => setCostForm((f) => ({ ...f, frequency: e.target.value as RecurringFrequency }))}>
                    {recurringFrequencies.map((frequency) => (
                      <option key={frequency} value={frequency}>
                        {recurringFrequencyLabels[frequency]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>First one</label>
                  <Input type="date" value={costForm.startDate} onChange={(e) => setCostForm((f) => ({ ...f, startDate: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Until (optional)</label>
                  <Input type="date" value={costForm.endDate} onChange={(e) => setCostForm((f) => ({ ...f, endDate: e.target.value }))} />
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <Button
                  size="sm"
                  disabled={pending || !costForm.name.trim() || !costForm.amount}
                  onClick={() =>
                    run(
                      'Saved.',
                      () =>
                        saveRecurringCost(entity.id, {
                          id: costForm.id || undefined,
                          name: costForm.name,
                          amountMinor: toMinor(costForm.amount),
                          frequency: costForm.frequency,
                          startDate: costForm.startDate,
                          endDate: costForm.endDate || null,
                          note: costForm.note,
                        }),
                      () => setCostForm({ id: '', name: '', amount: '', frequency: 'monthly', startDate: today, endDate: '', note: '' }),
                    )
                  }
                >
                  Save
                </Button>
                {costForm.id ? (
                  <Button size="sm" variant="ghost" onClick={() => setCostForm({ id: '', name: '', amount: '', frequency: 'monthly', startDate: today, endDate: '', note: '' })}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
