'use client';

/**
 * Settings → Payroll rates: the statutory figures every payroll is
 * calculated from, each dated, and a place to check a calculation against
 * them before any payroll is run.
 *
 * National law, so one set for every company in the group — the screen sits
 * under Settings like the rest, but nothing on it belongs to the entity that
 * happens to be selected. Every figure here was entered by a person; the app
 * holds none of its own.
 */

import { Fragment, useMemo, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { addRateVersion, correctPlaceholderRates, endRates, verifyRates, type RateVersionSave } from '@/app/actions/payroll-rates';
import type { Permission } from '@/lib/authz';
import { calculatePay, reliefLabels, type EmploymentType, type PayResult, type Residency } from '@/lib/payroll-engine';
import {
  basisPointsFrom,
  lastDayOf,
  percent,
  PayrollRefusal,
  RateBook,
  rateCatalogue,
  rateGroups,
  type RateDefinition,
  type StatutoryRateRow,
} from '@/lib/payroll-rates';

type Props = { rows: StatutoryRateRow[]; allowed: (permission: Permission) => boolean };
type Message = { tone: 'ok' | 'error'; text: string } | null;

const label = 'mb-1.5 block text-sm font-medium text-slate-700';
const selectClass = 'min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100';
const thisMonth = () => new Date().toISOString().slice(0, 7);
const cedisText = (minor: number | null) => (minor === null ? '' : (minor / 100).toFixed(2));
const minorFrom = (text: string): number | null => {
  const trimmed = text.replace(/,/g, '').trim();
  if (trimmed === '') return null;
  return /^\d+(\.\d{1,2})?$/.test(trimmed) ? Math.round(Number(trimmed) * 100) : Number.NaN;
};
/** The first of the month after a YYYY-MM month: what a new set defaults to. */
const firstOfNextMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

type DraftRow = { rate: string; amount: string; maxCount: string; choice: string };
type Draft = { key: string; mode: 'new' | 'correct'; effectiveFrom: string; rows: DraftRow[]; verified: boolean; source: string };

/** The versions of one key: rows grouped by the date they start, newest first. */
function versionsOf(rows: StatutoryRateRow[], key: string): StatutoryRateRow[][] {
  const groups = new Map<string, StatutoryRateRow[]>();
  for (const row of rows.filter((r) => r.key === key)) {
    const group = groups.get(row.effectiveFrom) ?? [];
    group.push(row);
    groups.set(row.effectiveFrom, group);
  }
  return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([, group]) => group.sort((a, b) => a.sequence - b.sequence));
}

const inForce = (version: StatutoryRateRow[], date: string) => version[0].effectiveFrom <= date && (version[0].effectiveTo === null || version[0].effectiveTo >= date);

function Status({ version }: { version: StatutoryRateRow[] }) {
  return version.some((row) => row.isPlaceholder) ? (
    <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-800">Placeholder — not verified</span>
  ) : (
    <span className="inline-flex flex-col gap-0.5">
      <span className="inline-flex w-fit items-center rounded-full bg-green-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-green-700">Verified</span>
      {version[0].source ? <span className="text-xs text-slate-500">{version[0].source}</span> : null}
    </span>
  );
}

/** The figures of one version, in words a person reads. */
function Figures({ definition, version }: { definition: RateDefinition; version: StatutoryRateRow[] }) {
  if (definition.choices) {
    const chosen = definition.choices.find((option) => option.value === version[0].choice);
    return <span className="text-sm font-medium text-slate-900">{chosen?.label ?? 'Not chosen'}</span>;
  }
  if (definition.multiRow) {
    // Where each band starts: the widths of every band below it added up.
    const starts = version.map((_, index) => version.slice(0, index).reduce((sum, band) => sum + (band.amountMinor ?? 0), 0));
    return (
      <table className="text-sm">
        <tbody>
          {version.map((band, index) => (
            <tr key={band.id}>
              <td className="pr-3 text-slate-600">
                {band.amountMinor === null ? (
                  <>Above <Money value={starts[index]} /></>
                ) : (
                  <>
                    <Money value={starts[index]} /> – <Money value={starts[index] + band.amountMinor} />
                  </>
                )}
              </td>
              <td className="font-medium tabular-nums text-slate-900">{band.rateBasisPoints === null ? '—' : percent(band.rateBasisPoints)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  const row = version[0];
  return (
    <span className="text-sm font-medium tabular-nums text-slate-900">
      {row.rateBasisPoints !== null ? percent(row.rateBasisPoints) : null}
      {row.amountMinor !== null ? (
        <>
          {row.rateBasisPoints !== null ? ', up to ' : ''}
          <Money value={row.amountMinor} /> a month{definition.maxCount !== 'none' ? ' each' : ''}
        </>
      ) : null}
      {row.maxCount !== null ? `, no more than ${row.maxCount}` : null}
    </span>
  );
}

export function PayrollRatesSettings({ rows, allowed }: Props) {
  const may = allowed('payroll-rates:manage');
  const [month, setMonth] = useState(thisMonth());
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [verifying, setVerifying] = useState<{ key: string; effectiveFrom: string; source: string } | null>(null);
  const [ending, setEnding] = useState<{ key: string; effectiveFrom: string; lastDay: string } | null>(null);
  const [history, setHistory] = useState<string | null>(null);

  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : thisMonth();
  // A month's payroll uses the figures in force on its last day.
  const date = lastDayOf(validMonth);
  const versionsByKey = useMemo(() => new Map(rateCatalogue.map((definition) => [definition.key, versionsOf(rows, definition.key)])), [rows]);
  const current = (key: string) => versionsByKey.get(key)?.find((version) => inForce(version, date)) ?? null;
  const placeholdersInForce = rateCatalogue.filter((definition) => current(definition.key)?.some((row) => row.isPlaceholder)).length;
  const missing = rateCatalogue.filter((definition) => !current(definition.key) && definition.key !== 'ssnit.max-insurable').length;
  const changedThisMonth = rateCatalogue.filter((definition) => {
    const version = current(definition.key);
    return version && version[0].effectiveFrom > `${validMonth}-01`;
  });
  const nonResidentBasis = current('paye.non-resident-basis');

  function act(okText: string, action: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setMessage({ tone: 'ok', text: okText });
        after?.();
      } else setMessage({ tone: 'error', text: result.error ?? 'Something went wrong.' });
    });
  }

  function startDraft(definition: RateDefinition, mode: Draft['mode'], version: StatutoryRateRow[] | null) {
    setVerifying(null);
    setEnding(null);
    const draftRows: DraftRow[] = version?.length
      ? version.map((row) => ({
          rate: row.rateBasisPoints === null ? '' : String(row.rateBasisPoints / 100),
          amount: cedisText(row.amountMinor),
          maxCount: row.maxCount === null ? '' : String(row.maxCount),
          choice: row.choice ?? '',
        }))
      : [{ rate: '', amount: '', maxCount: '', choice: definition.choices?.[0].value ?? '' }];
    setDraft({
      key: definition.key,
      mode,
      effectiveFrom: mode === 'correct' && version ? version[0].effectiveFrom : version ? firstOfNextMonth(validMonth) : `${validMonth}-01`,
      rows: draftRows,
      verified: false,
      source: version?.[0].source ?? '',
    });
  }

  function saveDraft(definition: RateDefinition) {
    if (!draft) return;
    const input: RateVersionSave = {
      key: draft.key,
      effectiveFrom: draft.effectiveFrom,
      rows: draft.rows.map((row) => ({
        rateBasisPoints: definition.rate === 'none' ? null : basisPointsFrom(row.rate),
        amountMinor: definition.amount === 'none' ? null : minorFrom(row.amount),
        maxCount: definition.maxCount === 'none' || row.maxCount.trim() === '' ? null : Number(row.maxCount),
        choice: definition.choices ? row.choice : null,
      })),
      verified: draft.verified,
      source: draft.source,
    };
    act(
      draft.mode === 'correct' ? `${definition.label} corrected.` : `${definition.label} saved from ${input.effectiveFrom}.`,
      () => (draft.mode === 'correct' ? correctPlaceholderRates(input) : addRateVersion(input)),
      () => setDraft(null),
    );
  }

  const setRow = (index: number, change: Partial<DraftRow>) => draft && setDraft({ ...draft, rows: draft.rows.map((r, i) => (i === index ? { ...r, ...change } : r)) });

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Every company in the group</p>
        <h3 className="mt-1 text-xl font-semibold text-slate-900">Payroll rates</h3>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          PAYE bands, SSNIT, reliefs and the concessionary rates, each with the date it takes effect. These are national law, so there is one set for the whole group. A
          month’s payroll uses the figures in force on its last day, so an old month worked out again comes to exactly what it did the first time. When the law changes,
          enter the new figures from the date they take effect — the old ones end the day before and stay as they were.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className={label} htmlFor="pr-month">Show the figures for the payroll of</label>
          <Input id="pr-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
      </div>

      {nonResidentBasis?.some((row) => row.isPlaceholder) ? (
        <div className="rounded-xl border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <span className="font-semibold">A decision for you:</span> whether non-resident employees are taxed on the resident bands or at one flat rate. It is set to{' '}
          <span className="font-semibold">the resident bands</span> until you choose — see “Non-resident basis” under PAYE.
        </div>
      ) : null}

      {placeholdersInForce > 0 || missing > 0 || changedThisMonth.length > 0 ? (
        <div className="space-y-1 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {placeholdersInForce > 0 ? (
            <p>
              <span className="font-semibold">{placeholdersInForce} of these figures are placeholders</span> that nobody has checked yet. Pay can be worked out with them, but
              not approved until each one is checked against GRA or SSNIT and marked verified.
            </p>
          ) : null}
          {missing > 0 ? <p>{missing} have nothing in force for {validMonth}. An employee who needs one cannot be paid until it is entered.</p> : null}
          {changedThisMonth.length > 0 ? (
            <p>
              Changed part way through {validMonth}: {changedThisMonth.map((definition) => `${definition.label} (from ${current(definition.key)![0].effectiveFrom})`).join(', ')}.
              The new figures apply to the whole of that month’s payroll.
            </p>
          ) : null}
        </div>
      ) : null}

      {message ? (
        <div className={['rounded-xl border px-4 py-3 text-sm', message.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'].join(' ')}>{message.text}</div>
      ) : null}

      {rateGroups.map((group) => (
        <Card key={group} className="rounded-2xl">
          <h4 className="text-base font-semibold text-slate-900">{group}</h4>
          <div className="mt-3 divide-y divide-slate-100">
            {rateCatalogue
              .filter((definition) => definition.group === group)
              .map((definition) => {
                const version = current(definition.key);
                const versions = versionsByKey.get(definition.key) ?? [];
                return (
                  <div key={definition.key} className="py-4">
                    <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1.3fr)]">
                      <div>
                        <p className="text-sm font-medium text-slate-900">{definition.label}</p>
                        <p className="mt-0.5 text-xs text-slate-500">{definition.help}</p>
                      </div>
                      <div>
                        {version ? (
                          <>
                            <Figures definition={definition} version={version} />
                            <p className="mt-1 text-xs text-slate-500">
                              From {version[0].effectiveFrom}
                              {version[0].effectiveTo ? ` to ${version[0].effectiveTo}` : ', still in force'}
                            </p>
                          </>
                        ) : (
                          <p className="text-sm text-slate-500">Nothing in force for {validMonth}.</p>
                        )}
                      </div>
                      <div className="flex flex-col items-start gap-2">
                        {version ? <Status version={version} /> : null}
                        {may ? (
                          <div className="flex flex-wrap gap-1.5">
                            <Button size="sm" variant="secondary" disabled={pending} onClick={() => startDraft(definition, 'new', version)}>
                              {version ? 'New figures from…' : 'Enter figures'}
                            </Button>
                            {version?.some((row) => row.isPlaceholder) ? (
                              <>
                                <Button size="sm" variant="ghost" disabled={pending} onClick={() => startDraft(definition, 'correct', version)}>Correct</Button>
                                <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setDraft(null); setEnding(null); setVerifying({ key: definition.key, effectiveFrom: version[0].effectiveFrom, source: '' }); }}>
                                  Mark verified
                                </Button>
                              </>
                            ) : null}
                            {version && !version[0].effectiveTo ? (
                              <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setDraft(null); setVerifying(null); setEnding({ key: definition.key, effectiveFrom: version[0].effectiveFrom, lastDay: date }); }}>
                                End…
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                        {versions.length > 1 || (versions.length === 1 && !version) ? (
                          <button type="button" className="text-xs font-medium text-brand-700 underline" onClick={() => setHistory(history === definition.key ? null : definition.key)}>
                            {history === definition.key ? 'Hide history' : `History (${versions.length})`}
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {history === definition.key ? (
                      <div className="mt-3 rounded-xl bg-slate-50 p-3">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                              <th className="pb-2 pr-3 font-medium">From</th>
                              <th className="pb-2 pr-3 font-medium">To</th>
                              <th className="pb-2 pr-3 font-medium">Figures</th>
                              <th className="pb-2 font-medium">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {versions.map((v) => (
                              <tr key={v[0].id} className="align-top">
                                <td className="py-1.5 pr-3 tabular-nums">{v[0].effectiveFrom}</td>
                                <td className="py-1.5 pr-3 tabular-nums">{v[0].effectiveTo ?? '—'}</td>
                                <td className="py-1.5 pr-3"><Figures definition={definition} version={v} /></td>
                                <td className="py-1.5"><Status version={v} /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}

                    {verifying?.key === definition.key ? (
                      <div className="mt-3 rounded-xl border border-slate-200 p-3">
                        <label className={label} htmlFor={`v-${definition.key}`}>Where did you check these figures?</label>
                        <Input id={`v-${definition.key}`} placeholder="e.g. GRA practice note, January 2026" value={verifying.source} onChange={(e) => setVerifying({ ...verifying, source: e.target.value })} />
                        <div className="mt-3 flex gap-2">
                          <Button size="sm" disabled={pending} onClick={() => act(`${definition.label} marked verified.`, () => verifyRates(verifying.key, verifying.effectiveFrom, verifying.source), () => setVerifying(null))}>
                            They are right — mark verified
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setVerifying(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : null}

                    {ending?.key === definition.key ? (
                      <div className="mt-3 rounded-xl border border-slate-200 p-3">
                        <label className={label} htmlFor={`e-${definition.key}`}>Last day these figures apply</label>
                        <Input id={`e-${definition.key}`} type="date" value={ending.lastDay} onChange={(e) => setEnding({ ...ending, lastDay: e.target.value })} />
                        <p className="mt-1 text-xs text-slate-500">Use this when something is abolished. When it is replaced, enter the new figures instead — the old ones end by themselves.</p>
                        <div className="mt-3 flex gap-2">
                          <Button size="sm" disabled={pending} onClick={() => act(`${definition.label} now ends on ${ending.lastDay}.`, () => endRates(ending.key, ending.effectiveFrom, ending.lastDay), () => setEnding(null))}>
                            End them
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEnding(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : null}

                    {draft?.key === definition.key ? (
                      <div className="mt-3 rounded-xl border border-slate-200 p-4">
                        <p className="text-sm font-medium text-slate-900">
                          {draft.mode === 'correct' ? `Correct the placeholder from ${draft.effectiveFrom}` : `New ${definition.label.toLowerCase()}`}
                        </p>
                        {draft.mode === 'new' ? (
                          <div className="mt-3 max-w-xs">
                            <label className={label} htmlFor={`f-${definition.key}`}>Takes effect on</label>
                            <Input id={`f-${definition.key}`} type="date" value={draft.effectiveFrom} onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })} />
                            <p className="mt-1 text-xs text-slate-500">Usually the first of a month, but any date the law says. Whatever is in force now ends the day before.</p>
                          </div>
                        ) : null}

                        <div className="mt-3 space-y-2">
                          {draft.rows.map((row, index) => (
                            <div key={index} className="grid gap-2 sm:grid-cols-3">
                              {definition.choices ? (
                                <div className="sm:col-span-2">
                                  <label className={label} htmlFor={`ch-${index}`}>Choose</label>
                                  <select id={`ch-${index}`} className={selectClass} value={row.choice} onChange={(e) => setRow(index, { choice: e.target.value })}>
                                    {definition.choices.map((option) => (
                                      <option key={option.value} value={option.value}>{option.label}</option>
                                    ))}
                                  </select>
                                </div>
                              ) : null}
                              {definition.amount !== 'none' ? (
                                <div>
                                  <label className={label} htmlFor={`a-${index}`}>
                                    {definition.multiRow ? `Band ${index + 1} width (GHS a month)` : definition.rate !== 'none' ? 'Monthly cap (GHS)' : 'Amount (GHS a month)'}
                                    {definition.amount === 'optional' ? <span className="font-normal text-slate-400"> — optional</span> : null}
                                  </label>
                                  <Input id={`a-${index}`} inputMode="decimal" placeholder={definition.multiRow && index === draft.rows.length - 1 ? 'blank: everything above' : ''} value={row.amount} onChange={(e) => setRow(index, { amount: e.target.value })} />
                                </div>
                              ) : null}
                              {definition.rate !== 'none' ? (
                                <div>
                                  <label className={label} htmlFor={`r-${index}`}>{definition.multiRow ? `Band ${index + 1} rate (%)` : 'Rate (%)'}</label>
                                  <Input id={`r-${index}`} inputMode="decimal" value={row.rate} onChange={(e) => setRow(index, { rate: e.target.value })} />
                                </div>
                              ) : null}
                              {definition.maxCount !== 'none' ? (
                                <div>
                                  <label className={label} htmlFor={`c-${index}`}>Most that may be claimed</label>
                                  <Input id={`c-${index}`} inputMode="numeric" value={row.maxCount} onChange={(e) => setRow(index, { maxCount: e.target.value })} />
                                </div>
                              ) : null}
                            </div>
                          ))}
                          {definition.multiRow ? (
                            <div className="flex gap-2">
                              <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, rows: [...draft.rows, { rate: '', amount: '', maxCount: '', choice: '' }] })}>Add a band</Button>
                              {draft.rows.length > 1 ? (
                                <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, rows: draft.rows.slice(0, -1) })}>Remove the last band</Button>
                              ) : null}
                            </div>
                          ) : null}
                        </div>

                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          <label className="flex items-start gap-2 text-sm text-slate-700">
                            <input type="checkbox" className="mt-1" checked={draft.verified} onChange={(e) => setDraft({ ...draft, verified: e.target.checked })} />
                            <span>I have checked these against GRA or SSNIT</span>
                          </label>
                          <div>
                            <label className={label} htmlFor={`s-${definition.key}`}>Where {draft.verified ? '' : <span className="font-normal text-slate-400">— needed to mark verified</span>}</label>
                            <Input id={`s-${definition.key}`} placeholder="e.g. GRA practice note, January 2026" value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} />
                          </div>
                        </div>

                        <div className="mt-4 flex gap-2">
                          <Button size="sm" disabled={pending} onClick={() => saveDraft(definition)}>{draft.mode === 'correct' ? 'Save the correction' : 'Save'}</Button>
                          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
          </div>
        </Card>
      ))}

      <CheckCalculation rows={rows} defaultMonth={validMonth} />
    </div>
  );
}

// --- check a calculation ---------------------------------------------------------------------------

/**
 * One made-up employee worked through the real calculation against the
 * figures above, line by line. Nothing is saved; it is for checking the rates
 * against a GRA calculator before any payroll is run.
 */
function CheckCalculation({ rows, defaultMonth }: { rows: StatutoryRateRow[]; defaultMonth: string }) {
  const [form, setForm] = useState({
    period: defaultMonth,
    basic: '4000.00',
    taxable: '500.00',
    pensionable: '',
    nonTaxable: '200.00',
    tier3: '',
    bonus: '',
    loan: '150.00',
    employmentType: 'permanent' as EmploymentType,
    residency: 'resident' as Residency,
    marriage: true,
    children: '0',
  });

  const outcome = useMemo((): { result: PayResult } | { error: string } => {
    try {
      const minor = (text: string) => {
        const value = minorFrom(text);
        if (value === null) return 0;
        if (Number.isNaN(value)) throw new PayrollRefusal(`“${text}” is not an amount.`);
        return value;
      };
      const children = Number(form.children) || 0;
      const result = calculatePay(
        {
          period: form.period,
          settings: { prorationBasis: 'calendar-days', tier3Offered: true },
          employee: { name: 'The example employee', employmentType: form.employmentType, residency: form.residency, startDate: '2000-01-01', endDate: null, juniorStaffOvertime: false },
          basicMinor: minor(form.basic),
          allowances: [
            ...(minor(form.taxable) ? [{ name: 'Taxable allowances', amountMinor: minor(form.taxable), taxable: true, pensionable: false }] : []),
            ...(minor(form.pensionable) ? [{ name: 'Pensionable allowance', amountMinor: minor(form.pensionable), taxable: true, pensionable: true }] : []),
            ...(minor(form.nonTaxable) ? [{ name: 'Allowances that are not taxable', amountMinor: minor(form.nonTaxable), taxable: false, pensionable: false }] : []),
          ],
          bonusMinor: minor(form.bonus),
          tier3Minor: minor(form.tier3),
          reliefs: [...(form.marriage ? [{ kind: 'marriage' as const }] : []), ...(children > 0 ? [{ kind: 'child-education' as const, count: children }] : [])],
          deductions: minor(form.loan) ? [{ name: 'Staff loan instalment', amountMinor: minor(form.loan) }] : [],
        },
        new RateBook(rows, form.period),
      );
      return { result };
    } catch (error) {
      if (error instanceof PayrollRefusal || error instanceof RangeError) return { error: error.message };
      throw error;
    }
  }, [form, rows]);

  const field = (key: keyof typeof form, text: string) => (
    <div>
      <label className={label} htmlFor={`cc-${key}`}>{text}</label>
      <Input id={`cc-${key}`} inputMode="decimal" value={String(form[key])} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </div>
  );

  return (
    <Card className="rounded-2xl">
      <h4 className="text-base font-semibold text-slate-900">Check a calculation</h4>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">
        Work one made-up employee through the payroll calculation with the figures above, step by step, and compare it with a GRA calculator. Nothing is saved.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className={label} htmlFor="cc-period">Month</label>
          <Input id="cc-period" type="month" value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} />
        </div>
        {field('basic', 'Basic salary (GHS)')}
        {field('taxable', 'Taxable allowances (GHS)')}
        {field('pensionable', 'Pensionable allowance (GHS)')}
        {field('nonTaxable', 'Allowances not taxable (GHS)')}
        {field('tier3', 'Tier 3 contribution (GHS)')}
        {field('bonus', 'Bonus (GHS)')}
        {field('loan', 'Loan instalment (GHS)')}
        {field('children', 'Children in education')}
        <div>
          <label className={label} htmlFor="cc-type">Employed as</label>
          <select id="cc-type" className={selectClass} value={form.employmentType} onChange={(e) => setForm({ ...form, employmentType: e.target.value as EmploymentType })}>
            <option value="permanent">Permanent</option>
            <option value="contract">Contract</option>
            <option value="casual">Casual</option>
          </select>
        </div>
        <div>
          <label className={label} htmlFor="cc-res">Tax residency</label>
          <select id="cc-res" className={selectClass} value={form.residency} onChange={(e) => setForm({ ...form, residency: e.target.value as Residency })}>
            <option value="resident">Resident</option>
            <option value="non-resident">Non-resident</option>
          </select>
        </div>
        <label className="flex items-center gap-2 self-end pb-3 text-sm text-slate-700">
          <input type="checkbox" checked={form.marriage} onChange={(e) => setForm({ ...form, marriage: e.target.checked })} />
          {reliefLabels.marriage} relief
        </label>
      </div>

      {'error' in outcome ? (
        <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">{outcome.error}</p>
      ) : (
        <Working result={outcome.result} />
      )}
    </Card>
  );
}

function Working({ result }: { result: PayResult }) {
  const steps = [...new Set(result.working.map((line) => line.step))];
  const placeholders = result.ratesUsed.filter((used) => used.isPlaceholder).length;
  return (
    <div className="mt-5 space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ['Gross pay', result.grossMinor],
          ['PAYE', result.payeMinor],
          ['Net pay', result.netMinor],
          ['Cost to the employer', result.employerCostMinor],
        ].map(([name, value]) => (
          <div key={name as string} className="rounded-xl bg-slate-50 px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">{name}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900"><Money value={value as number} /></p>
          </div>
        ))}
      </div>

      {placeholders > 0 ? <p className="text-sm text-amber-800">{placeholders} of the {result.ratesUsed.length} figures used are placeholders, so this is only as good as they are.</p> : null}
      {result.ratesChangedWithin.length > 0 ? (
        <p className="text-sm text-amber-800">Changed part way through this month, and applied to all of it: {result.ratesChangedWithin.map((change) => `${change.label} (from ${change.from})`).join(', ')}.</p>
      ) : null}

      <table className="w-full text-sm">
        <tbody>
          {steps.map((step) => (
            <Fragment key={step}>
              <tr>
                <th colSpan={3} className="pb-1 pt-4 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{step === 'Employer' ? 'Employer contributions (not taken from pay)' : step}</th>
              </tr>
              {result.working
                .filter((line) => line.step === step)
                .map((line, index) => (
                  <tr key={index} className={line.total ? 'border-t border-slate-200 font-semibold' : ''}>
                    <td className="py-1 pr-3 text-slate-800">{line.label}</td>
                    <td className="py-1 pr-3 text-xs text-slate-500">{line.detail ?? ''}</td>
                    <td className="py-1 text-right tabular-nums text-slate-900">{line.amountMinor === 0 && !line.total && !line.calc ? '' : <Money value={line.amountMinor} />}</td>
                  </tr>
                ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
