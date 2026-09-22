'use client';

/**
 * Grants: the award and its terms, the donor's budget, what has been spent
 * against it in both currencies, money in and how it is recognised, the
 * conditions attached, and the in-kind and staff-time contributions donors
 * ask about. Every change goes through src/app/actions/grants.ts.
 */

import { useMemo, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import {
  donorReport,
  donorReportWorkbook,
  type DonorReport,
  recordGrantReceipt,
  recordInKind,
  recordStaffTime,
  releaseGrantIncome,
  removeBudgetLine,
  saveBudgetLine,
  saveCondition,
  saveGrant,
  setConditionMet,
  setGrantStatus,
} from '@/app/actions/grants';
import type { Permission } from '@/lib/authz';
import type {
  AccountRecord,
  BankAccountRecord,
  ContactRecord,
  EntityRecord,
  FundRecord,
  GrantRecord,
  InKindRecord,
  StaffTimeRecord,
} from '@/lib/data/types';
import { currencies, type Currency } from '@/lib/fx';
import {
  budgetVsActual,
  conditionSummary,
  grantPosition,
  incomePolicies,
  incomePolicyLabels,
  inKindKinds,
  inKindKindLabels,
  reportingFrequencies,
  reportingFrequencyLabels,
  reportingPeriods,
  spendingRelease,
  toDonor,
  type GrantActual,
  type IncomePolicy,
  type InKindKind,
  type ReportingFrequency,
} from '@/lib/grants';

type Props = {
  entity: EntityRecord;
  grants: GrantRecord[];
  actuals: (GrantActual & { grantId: string })[];
  inKind: InKindRecord[];
  staffTime: StaffTimeRecord[];
  contacts: ContactRecord[];
  accounts: AccountRecord[];
  funds: FundRecord[];
  bankAccounts: BankAccountRecord[];
  allowed: (permission: Permission) => boolean;
};

type Tab = 'Overview' | 'Budget' | 'Money in' | 'Conditions' | 'In kind & time';
const tabs: Tab[] = ['Overview', 'Budget', 'Money in', 'Conditions', 'In kind & time'];
const selectClass = 'min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50';
const label = 'mb-1.5 block text-sm font-medium text-slate-700';
const todayIso = () => new Date().toISOString().slice(0, 10);
const toMinor = (text: string) => Math.round(Number(String(text).replace(/,/g, '')) * 100);

const statusTone: Record<string, string> = {
  'on-track': 'bg-slate-100 text-slate-700',
  over: 'bg-rose-100 text-rose-800',
  under: 'bg-amber-100 text-amber-900',
  unbudgeted: 'bg-rose-100 text-rose-800',
};
const statusWords: Record<string, string> = {
  'on-track': 'On track',
  over: 'Overspent',
  under: 'Well behind',
  unbudgeted: 'Not budgeted',
};

const emptyGrant = {
  id: '',
  code: '',
  name: '',
  donorContactId: '',
  fundId: '',
  currency: 'USD' as Currency,
  amount: '',
  rate: '',
  startDate: todayIso(),
  endDate: todayIso(),
  restricted: true,
  incomePolicy: 'on-receipt' as IncomePolicy,
  reportingFrequency: 'quarterly' as ReportingFrequency,
  reportingStartDate: '',
  reportingDueDays: '30',
  underspendThresholdPct: '75',
  note: '',
};

export function GrantsPanel({ entity, grants, actuals, inKind, staffTime, contacts, accounts, funds, bankAccounts, allowed }: Props) {
  const [tab, setTab] = useState<Tab>('Overview');
  const [selectedId, setSelectedId] = useState(grants[0]?.id ?? '');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const today = todayIso();

  const grant = grants.find((row) => row.id === selectedId) ?? grants[0] ?? null;
  const expenseAccounts = useMemo(() => accounts.filter((account) => account.type === 'EXPENSE' || account.type === 'COST_OF_SALES'), [accounts]);
  const donors = useMemo(() => contacts.filter((contact) => contact.category !== 'group-entity'), [contacts]);

  const grantActuals = useMemo(() => (grant ? actuals.filter((actual) => actual.grantId === grant.id) : []), [actuals, grant]);
  const comparison = useMemo(
    () =>
      grant
        ? budgetVsActual(
            grant,
            grant.budgetLines.map((line) => ({ id: line.id, code: line.code, name: line.name, accountCode: line.accountCode, budgetDonorMinor: line.budgetMinor })),
            grantActuals,
            { rate: grant.rate, asOf: today, underspendThresholdPct: grant.underspendThresholdPct },
          )
        : null,
    [grant, grantActuals, today],
  );
  const position = grant ? grantPosition(grant.amountMinor, grant.rate, grant.receivedMinor, grant.releasedMinor, grant.spentMinor, grant.incomePolicy) : null;
  const release = grant ? spendingRelease(grant.receivedMinor, grant.releasedMinor, grant.spentMinor) : null;
  const conditions = grant ? conditionSummary(grant.conditions, today) : null;
  const periods = grant ? reportingPeriods(grant) : [];

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

  // --- forms -----------------------------------------------------------------

  const [grantForm, setGrantForm] = useState(emptyGrant);
  const [editing, setEditing] = useState(false);
  const [budgetForm, setBudgetForm] = useState({ id: '', code: '', name: '', accountCode: '', budget: '', note: '' });
  const [receiptForm, setReceiptForm] = useState({ date: today, amount: '', bankAccountId: bankAccounts[0]?.id ?? '', reference: '' });
  const [releaseForm, setReleaseForm] = useState({ date: today, basis: 'spending' as 'spending' | 'condition', conditionId: '', amount: '', note: '' });
  const [conditionForm, setConditionForm] = useState({ id: '', description: '', dueDate: '', note: '' });
  const [inKindForm, setInKindForm] = useState({ date: today, description: '', kind: 'goods' as InKindKind, value: '', basis: '', donorContactId: '', budgetLineId: '' });
  const [timeForm, setTimeForm] = useState({ personName: '', role: '', periodStart: today, periodEnd: today, hours: '', rate: '', accountCode: '', budgetLineId: '', post: true, note: '' });
  const [reportWindow, setReportWindow] = useState({ from: '', to: '' });
  /** The server's own figures for a chosen window — what the Excel export will say. */
  const [serverReport, setServerReport] = useState<DonorReport | null>(null);

  function editGrant(row: GrantRecord) {
    setGrantForm({
      id: row.id,
      code: row.code,
      name: row.name,
      donorContactId: row.donorContactId,
      fundId: row.fundId ?? '',
      currency: row.currency,
      amount: (row.amountMinor / 100).toFixed(2),
      rate: row.rate,
      startDate: row.startDate,
      endDate: row.endDate,
      restricted: row.restricted,
      incomePolicy: row.incomePolicy,
      reportingFrequency: row.reportingFrequency,
      reportingStartDate: row.reportingStartDate ?? '',
      reportingDueDays: String(row.reportingDueDays),
      underspendThresholdPct: String(row.underspendThresholdPct),
      note: row.note,
    });
    setEditing(true);
  }

  function saveGrantForm() {
    run(
      grantForm.id ? 'Grant updated.' : 'Grant added.',
      () =>
        saveGrant(entity.id, {
          id: grantForm.id || undefined,
          code: grantForm.code,
          name: grantForm.name,
          donorContactId: grantForm.donorContactId,
          fundId: grantForm.fundId || null,
          currency: grantForm.currency,
          amountMinor: toMinor(grantForm.amount),
          rate: grantForm.rate || '1.0',
          startDate: grantForm.startDate,
          endDate: grantForm.endDate,
          restricted: grantForm.restricted,
          incomePolicy: grantForm.incomePolicy,
          reportingFrequency: grantForm.reportingFrequency,
          reportingStartDate: grantForm.reportingStartDate || null,
          reportingDueDays: Number(grantForm.reportingDueDays || 30),
          underspendThresholdPct: Number(grantForm.underspendThresholdPct || 75),
          note: grantForm.note,
        }),
      () => {
        setEditing(false);
        setGrantForm(emptyGrant);
      },
    );
  }

  function downloadReport() {
    if (!grant) return;
    setMessage(null);
    startTransition(async () => {
      const result = await donorReportWorkbook(entity.id, grant.id, reportWindow.from || undefined, reportWindow.to || undefined);
      if (!result.ok) {
        setMessage({ tone: 'error', text: result.error });
        return;
      }
      const bytes = Uint8Array.from(atob(result.value.base64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.value.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage({ tone: 'ok', text: `${result.value.fileName} downloaded.` });
    });
  }

  const donorMoney = (minor: number) => <Money value={minor} currency={grant?.currency ?? entity.functionalCurrency} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{entity.name}</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-900">Grants</h2>
          <p className="mt-1 text-sm text-slate-600">
            The donor&rsquo;s budget, what has gone against it, and how their money is recognised — in their currency and in {entity.functionalCurrency}.
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

      {grants.length > 1 || grant ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-slate-600">Grant</label>
          <select className="min-h-[40px] rounded-lg border border-slate-200 bg-white px-3 text-sm" value={grant?.id ?? ''} onChange={(event) => setSelectedId(event.target.value)}>
            {grants.map((row) => (
              <option key={row.id} value={row.id}>
                {row.code} — {row.name} ({row.status})
              </option>
            ))}
          </select>
          {allowed('document:post') ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => { setGrantForm(emptyGrant); setEditing(true); }}>
                New grant
              </Button>
              {grant ? (
                <Button size="sm" variant="ghost" onClick={() => editGrant(grant)}>
                  Edit terms
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {/* --- the grant form -------------------------------------------------- */}
      {editing ? (
        <Card className="rounded-2xl">
          <h3 className="text-lg font-semibold text-slate-900">{grantForm.id ? 'Grant terms' : 'New grant'}</h3>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div>
              <label className={label}>Reference</label>
              <Input value={grantForm.code} onChange={(e) => setGrantForm((f) => ({ ...f, code: e.target.value }))} placeholder="GRT-2026-01" />
            </div>
            <div className="md:col-span-2">
              <label className={label}>Name</label>
              <Input value={grantForm.name} onChange={(e) => setGrantForm((f) => ({ ...f, name: e.target.value }))} placeholder="Cashew farmer livelihoods" />
            </div>
            <div>
              <label className={label}>Donor</label>
              <select className={selectClass} value={grantForm.donorContactId} onChange={(e) => setGrantForm((f) => ({ ...f, donorContactId: e.target.value }))}>
                <option value="">Choose…</option>
                {donors.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={label}>Fund</label>
              <select className={selectClass} value={grantForm.fundId} onChange={(e) => setGrantForm((f) => ({ ...f, fundId: e.target.value }))}>
                <option value="">None</option>
                {funds.map((fund) => (
                  <option key={fund.id} value={fund.id}>
                    {fund.code} — {fund.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500">Everything coded to this grant is coded to its fund as well.</p>
            </div>
            <div>
              <label className={label}>Restricted?</label>
              <select className={selectClass} value={grantForm.restricted ? 'yes' : 'no'} onChange={(e) => setGrantForm((f) => ({ ...f, restricted: e.target.value === 'yes' }))}>
                <option value="yes">Restricted — for this purpose only</option>
                <option value="no">Unrestricted</option>
              </select>
            </div>
            <div>
              <label className={label}>Donor currency</label>
              <select className={selectClass} value={grantForm.currency} onChange={(e) => setGrantForm((f) => ({ ...f, currency: e.target.value as Currency }))}>
                {currencies.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={label}>Award</label>
              <Input inputMode="decimal" value={grantForm.amount} onChange={(e) => setGrantForm((f) => ({ ...f, amount: e.target.value }))} placeholder="80000.00" />
            </div>
            <div>
              <label className={label}>Rate ({entity.functionalCurrency} per 1 {grantForm.currency})</label>
              <Input inputMode="decimal" value={grantForm.rate} onChange={(e) => setGrantForm((f) => ({ ...f, rate: e.target.value }))} placeholder="15.0" />
            </div>
            <div>
              <label className={label}>Starts</label>
              <Input type="date" value={grantForm.startDate} onChange={(e) => setGrantForm((f) => ({ ...f, startDate: e.target.value }))} />
            </div>
            <div>
              <label className={label}>Ends</label>
              <Input type="date" value={grantForm.endDate} onChange={(e) => setGrantForm((f) => ({ ...f, endDate: e.target.value }))} />
            </div>
            <div>
              <label className={label}>Income recognition</label>
              <select className={selectClass} value={grantForm.incomePolicy} onChange={(e) => setGrantForm((f) => ({ ...f, incomePolicy: e.target.value as IncomePolicy }))}>
                {incomePolicies.map((policy) => (
                  <option key={policy} value={policy}>
                    {incomePolicyLabels[policy]}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500">Your decision. It cannot be changed once money has come in under it.</p>
            </div>
            <div>
              <label className={label}>Reporting</label>
              <select className={selectClass} value={grantForm.reportingFrequency} onChange={(e) => setGrantForm((f) => ({ ...f, reportingFrequency: e.target.value as ReportingFrequency }))}>
                {reportingFrequencies.map((frequency) => (
                  <option key={frequency} value={frequency}>
                    {reportingFrequencyLabels[frequency]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={label}>Their periods start</label>
              <Input type="date" value={grantForm.reportingStartDate} onChange={(e) => setGrantForm((f) => ({ ...f, reportingStartDate: e.target.value }))} />
              <p className="mt-1 text-xs text-slate-500">Leave blank to run from the grant start. Never our year end.</p>
            </div>
            <div>
              <label className={label}>Report due, days after</label>
              <Input inputMode="numeric" value={grantForm.reportingDueDays} onChange={(e) => setGrantForm((f) => ({ ...f, reportingDueDays: e.target.value }))} />
            </div>
            <div>
              <label className={label}>Flag underspend below</label>
              <Input inputMode="numeric" value={grantForm.underspendThresholdPct} onChange={(e) => setGrantForm((f) => ({ ...f, underspendThresholdPct: e.target.value }))} />
              <p className="mt-1 text-xs text-slate-500">% of what the elapsed time suggests should have been spent.</p>
            </div>
            <div className="md:col-span-3">
              <label className={label}>Note</label>
              <Input value={grantForm.note} onChange={(e) => setGrantForm((f) => ({ ...f, note: e.target.value }))} />
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <Button size="sm" disabled={pending || !grantForm.code.trim() || !grantForm.name.trim() || !grantForm.donorContactId} onClick={saveGrantForm}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setGrantForm(emptyGrant); }}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}

      {!grant ? (
        <Card className="rounded-2xl">
          <p className="text-sm text-slate-600">No grants yet. Add the first one to start tracking a donor&rsquo;s budget.</p>
        </Card>
      ) : null}

      {/* --- overview --------------------------------------------------------- */}
      {grant && position && comparison && conditions && tab === 'Overview' ? (
        <div className="space-y-6">
          <Card className="rounded-2xl">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">
                  {grant.code} — {grant.name}
                </h3>
                <p className="text-sm text-slate-600">
                  {grant.donorName} · {grant.startDate} to {grant.endDate} · {grant.restricted ? 'Restricted' : 'Unrestricted'}
                  {grant.fundName ? ` · ${grant.fundName}` : ''} · {reportingFrequencyLabels[grant.reportingFrequency]}
                </p>
                <p className="mt-1 text-sm text-slate-600">{incomePolicyLabels[grant.incomePolicy]}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-700">{grant.status}</span>
                {allowed('document:post') && grant.status !== 'closed' ? (
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => run('Grant updated.', () => setGrantStatus(entity.id, grant.id, grant.status === 'draft' ? 'active' : 'closed'))}>
                    {grant.status === 'draft' ? 'Make active' : 'Close grant'}
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-slate-200 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.12em] text-slate-600">Award</p>
                <p className="text-lg font-semibold">{donorMoney(grant.amountMinor)}</p>
                <p className="text-xs text-slate-500">
                  <Money value={position.awardFunctionalMinor} /> at {grant.rate}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.12em] text-slate-600">Received</p>
                <p className="text-lg font-semibold">
                  <Money value={position.receivedFunctionalMinor} />
                </p>
                <p className="text-xs text-slate-500">
                  Still to come: <Money value={position.outstandingFunctionalMinor} />
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.12em] text-slate-600">Recognised as income</p>
                <p className="text-lg font-semibold">
                  <Money value={position.recognisedFunctionalMinor} />
                </p>
                {grant.incomePolicy === 'deferred' ? (
                  <p className="text-xs text-slate-500">
                    Held deferred: <Money value={position.deferredFunctionalMinor} />
                  </p>
                ) : null}
              </div>
              <div className="rounded-xl border border-slate-200 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.12em] text-slate-600">Spent</p>
                <p className="text-lg font-semibold">
                  <Money value={comparison.totals.actualFunctionalMinor} />
                </p>
                <p className="text-xs text-slate-500">
                  {donorMoney(comparison.totals.actualDonorMinor)} · {Math.round(comparison.elapsedFraction * 100)}% of the period elapsed
                </p>
              </div>
            </div>

            {comparison.overspent.length || comparison.underspent.length || conditions.overdue ? (
              <div className="mt-4 space-y-2">
                {comparison.overspent.length ? (
                  <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
                    Overspent or unbudgeted: {comparison.overspent.map((line) => `${line.code} ${line.name}`).join('; ')}
                  </div>
                ) : null}
                {comparison.underspent.length ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    Well behind for the time elapsed: {comparison.underspent.map((line) => `${line.code} ${line.name}`).join('; ')}
                  </div>
                ) : null}
                {conditions.overdue ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    {conditions.overdue} condition{conditions.overdue === 1 ? '' : 's'} past due.
                  </div>
                ) : null}
              </div>
            ) : null}
          </Card>

          <Card className="rounded-2xl">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Donor report</h3>
                <p className="text-sm text-slate-600">Their periods, their currency, their budget lines. Exports to Excel.</p>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label className={label}>From</label>
                  <Input type="date" value={reportWindow.from} onChange={(e) => setReportWindow((w) => ({ ...w, from: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>To</label>
                  <Input type="date" value={reportWindow.to} onChange={(e) => setReportWindow((w) => ({ ...w, to: e.target.value }))} />
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    setMessage(null);
                    setServerReport(null);
                    startTransition(async () => {
                      const result = await donorReport(entity.id, grant.id, reportWindow.from || undefined, reportWindow.to || undefined);
                      if (result.ok) setServerReport(result.value);
                      else setMessage({ tone: 'error', text: result.error });
                    });
                  }}
                >
                  Show
                </Button>
                <Button size="sm" disabled={pending} onClick={downloadReport}>
                  Export to Excel
                </Button>
              </div>
            </div>
            {serverReport ? (
              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                {reportWindow.from || reportWindow.to ? `${reportWindow.from || 'the start'} to ${reportWindow.to || 'the end'}` : 'Whole grant'}: spent{' '}
                {donorMoney(serverReport.comparison.totals.actualDonorMinor)} (<Money value={serverReport.comparison.totals.actualFunctionalMinor} />), in-kind{' '}
                <Money value={serverReport.inKind.reduce((total, row) => total + row.valueMinor, 0)} />, staff time{' '}
                <Money value={serverReport.staffTime.reduce((total, row) => total + row.valueMinor, 0)} />.
              </div>
            ) : null}
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="py-2">Reporting period</th>
                    <th className="py-2">Report due</th>
                    <th className="py-2 text-right">Spent ({grant.currency})</th>
                    <th className="py-2 text-right">Spent ({entity.functionalCurrency})</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {periods.map((period) => {
                    const spent = grantActuals.filter((actual) => actual.date >= period.start && actual.date <= period.end).reduce((total, actual) => total + actual.functionalMinor, 0);
                    return (
                      <tr key={period.index}>
                        <td className="py-2 text-slate-900">
                          {period.start} to {period.end}
                        </td>
                        <td className="py-2 text-slate-600">{period.dueDate}</td>
                        <td className="py-2 text-right">{donorMoney(toDonor(spent, grant.rate))}</td>
                        <td className="py-2 text-right">
                          <Money value={spent} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}

      {/* --- budget ------------------------------------------------------------ */}
      {grant && comparison && tab === 'Budget' ? (
        <div className="space-y-6">
          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Budget against actual</h3>
            <p className="mt-1 text-sm text-slate-600">
              Budgets are in {grant.currency} as the donor agreed them; actuals come from the ledger in {entity.functionalCurrency} and are shown in {grant.currency} at {grant.rate}.
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="py-2">Line</th>
                    <th className="py-2">Description</th>
                    <th className="py-2 text-right">Budget ({grant.currency})</th>
                    <th className="py-2 text-right">Actual ({grant.currency})</th>
                    <th className="py-2 text-right">Variance</th>
                    <th className="py-2 text-right">Actual ({entity.functionalCurrency})</th>
                    <th className="py-2">Status</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {comparison.lines.map((line) => (
                    <tr key={line.budgetLineId || 'loose'}>
                      <td className="py-2 font-mono text-xs text-slate-600">{line.code}</td>
                      <td className="py-2 text-slate-900">
                        {line.name}
                        {line.accountCode ? <span className="ml-2 text-xs text-slate-500">{line.accountCode}</span> : null}
                      </td>
                      <td className="py-2 text-right">{donorMoney(line.budgetDonorMinor)}</td>
                      <td className="py-2 text-right">{donorMoney(line.actualDonorMinor)}</td>
                      <td className="py-2 text-right">{donorMoney(line.varianceDonorMinor)}</td>
                      <td className="py-2 text-right">
                        <Money value={line.actualFunctionalMinor} />
                      </td>
                      <td className="py-2">
                        <span className={['rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]', statusTone[line.status]].join(' ')}>{statusWords[line.status]}</span>
                      </td>
                      <td className="py-2 text-right">
                        {line.budgetLineId && allowed('document:post') ? (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                const source = grant.budgetLines.find((row) => row.id === line.budgetLineId);
                                if (source) setBudgetForm({ id: source.id, code: source.code, name: source.name, accountCode: source.accountCode, budget: (source.budgetMinor / 100).toFixed(2), note: source.note });
                              }}
                            >
                              Edit
                            </Button>
                            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run('Budget line removed.', () => removeBudgetLine(entity.id, line.budgetLineId))}>
                              Remove
                            </Button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="py-2" />
                    <td className="py-2">Total</td>
                    <td className="py-2 text-right">{donorMoney(comparison.totals.budgetDonorMinor)}</td>
                    <td className="py-2 text-right">{donorMoney(comparison.totals.actualDonorMinor)}</td>
                    <td className="py-2 text-right">{donorMoney(comparison.totals.varianceDonorMinor)}</td>
                    <td className="py-2 text-right">
                      <Money value={comparison.totals.actualFunctionalMinor} />
                    </td>
                    <td className="py-2" colSpan={2} />
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          {allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">{budgetForm.id ? 'Edit budget line' : 'Add a budget line'}</h3>
              <div className="mt-4 grid gap-4 md:grid-cols-5">
                <div>
                  <label className={label}>Reference</label>
                  <Input value={budgetForm.code} onChange={(e) => setBudgetForm((f) => ({ ...f, code: e.target.value }))} placeholder="B1" />
                </div>
                <div className="md:col-span-2">
                  <label className={label}>Description</label>
                  <Input value={budgetForm.name} onChange={(e) => setBudgetForm((f) => ({ ...f, name: e.target.value }))} placeholder="Farmer training" />
                </div>
                <div>
                  <label className={label}>Account</label>
                  <select className={selectClass} value={budgetForm.accountCode} onChange={(e) => setBudgetForm((f) => ({ ...f, accountCode: e.target.value }))}>
                    <option value="">Choose…</option>
                    {expenseAccounts.map((account) => (
                      <option key={account.code} value={account.code}>
                        {account.code} {account.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Budget ({grant.currency})</label>
                  <Input inputMode="decimal" value={budgetForm.budget} onChange={(e) => setBudgetForm((f) => ({ ...f, budget: e.target.value }))} />
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <Button
                  size="sm"
                  disabled={pending || !budgetForm.code.trim() || !budgetForm.name.trim() || !budgetForm.accountCode}
                  onClick={() =>
                    run(
                      'Budget line saved.',
                      () => saveBudgetLine(entity.id, { id: budgetForm.id || undefined, grantId: grant.id, code: budgetForm.code, name: budgetForm.name, accountCode: budgetForm.accountCode, budgetMinor: toMinor(budgetForm.budget || '0'), note: budgetForm.note }),
                      () => setBudgetForm({ id: '', code: '', name: '', accountCode: '', budget: '', note: '' }),
                    )
                  }
                >
                  Save
                </Button>
                {budgetForm.id ? (
                  <Button size="sm" variant="ghost" onClick={() => setBudgetForm({ id: '', code: '', name: '', accountCode: '', budget: '', note: '' })}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* --- money in ----------------------------------------------------------- */}
      {grant && position && release && tab === 'Money in' ? (
        <div className="space-y-6">
          {allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">Record money from the donor</h3>
              <p className="mt-1 text-sm text-slate-600">{incomePolicyLabels[grant.incomePolicy]}.</p>
              <div className="mt-4 grid gap-4 md:grid-cols-4">
                <div>
                  <label className={label}>Date</label>
                  <Input type="date" value={receiptForm.date} onChange={(e) => setReceiptForm((f) => ({ ...f, date: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Amount</label>
                  <Input inputMode="decimal" value={receiptForm.amount} onChange={(e) => setReceiptForm((f) => ({ ...f, amount: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Into</label>
                  <select className={selectClass} value={receiptForm.bankAccountId} onChange={(e) => setReceiptForm((f) => ({ ...f, bankAccountId: e.target.value }))}>
                    {bankAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name} ({account.currency})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Reference</label>
                  <Input value={receiptForm.reference} onChange={(e) => setReceiptForm((f) => ({ ...f, reference: e.target.value }))} />
                </div>
              </div>
              <p className="mt-2 text-xs text-slate-500">The amount is in the account&rsquo;s own currency; it converts at the grant&rsquo;s rate.</p>
              <div className="mt-4">
                <Button
                  size="sm"
                  disabled={pending || !receiptForm.amount || !receiptForm.bankAccountId}
                  onClick={() =>
                    run('Receipt recorded.', () => recordGrantReceipt(entity.id, { grantId: grant.id, date: receiptForm.date, txnAmountMinor: toMinor(receiptForm.amount), bankAccountId: receiptForm.bankAccountId, reference: receiptForm.reference }), () =>
                      setReceiptForm((f) => ({ ...f, amount: '', reference: '' })),
                    )
                  }
                >
                  Record receipt
                </Button>
              </div>
            </Card>
          ) : null}

          {grant.incomePolicy === 'deferred' && allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">Recognise deferred income</h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-slate-200 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.12em] text-slate-600">Held as deferred income</p>
                  <Money value={release.heldMinor} className="text-lg font-semibold" />
                </div>
                <div className="rounded-xl border border-slate-200 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.12em] text-slate-600">Spending still to recognise</p>
                  <Money value={release.earnedNotReleasedMinor} className="text-lg font-semibold" />
                </div>
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.12em] text-emerald-800">Releasable now</p>
                  <Money value={release.releasableMinor} className="text-lg font-semibold" />
                </div>
              </div>
              <div className="mt-4 grid gap-4 md:grid-cols-4">
                <div>
                  <label className={label}>Date</label>
                  <Input type="date" value={releaseForm.date} onChange={(e) => setReleaseForm((f) => ({ ...f, date: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Because</label>
                  <select className={selectClass} value={releaseForm.basis} onChange={(e) => setReleaseForm((f) => ({ ...f, basis: e.target.value as 'spending' | 'condition' }))}>
                    <option value="spending">Eligible spending happened</option>
                    <option value="condition">A condition was met</option>
                  </select>
                </div>
                {releaseForm.basis === 'condition' ? (
                  <>
                    <div>
                      <label className={label}>Condition</label>
                      <select className={selectClass} value={releaseForm.conditionId} onChange={(e) => setReleaseForm((f) => ({ ...f, conditionId: e.target.value }))}>
                        <option value="">Choose…</option>
                        {grant.conditions.filter((condition) => condition.metAt).map((condition) => (
                          <option key={condition.id} value={condition.id}>
                            {condition.description.slice(0, 60)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className={label}>Amount ({entity.functionalCurrency})</label>
                      <Input inputMode="decimal" value={releaseForm.amount} onChange={(e) => setReleaseForm((f) => ({ ...f, amount: e.target.value }))} />
                    </div>
                  </>
                ) : (
                  <div className="md:col-span-2 self-end text-sm text-slate-600">The amount is worked out from the spending: no need to type one.</div>
                )}
              </div>
              <div className="mt-4">
                <Button
                  size="sm"
                  disabled={pending || (releaseForm.basis === 'spending' ? release.releasableMinor <= 0 : !releaseForm.conditionId || !releaseForm.amount)}
                  onClick={() =>
                    run('Income recognised.', () => releaseGrantIncome(entity.id, { grantId: grant.id, date: releaseForm.date, basis: releaseForm.basis, conditionId: releaseForm.conditionId || null, amountMinor: releaseForm.amount ? toMinor(releaseForm.amount) : undefined, note: releaseForm.note }), () =>
                      setReleaseForm((f) => ({ ...f, amount: '', conditionId: '' })),
                    )
                  }
                >
                  Recognise
                </Button>
              </div>
            </Card>
          ) : null}

          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Money in</h3>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="py-2">Date</th>
                    <th className="py-2">Into</th>
                    <th className="py-2">Reference</th>
                    <th className="py-2 text-right">Amount</th>
                    <th className="py-2 text-right">In {entity.functionalCurrency}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {grant.receipts.map((receipt) => (
                    <tr key={receipt.id}>
                      <td className="py-2 text-slate-600">{receipt.date}</td>
                      <td className="py-2 text-slate-900">{receipt.bankAccountName}</td>
                      <td className="py-2 font-mono text-xs text-slate-500">{receipt.reference}</td>
                      <td className="py-2 text-right">
                        <Money value={receipt.txnAmountMinor} currency={receipt.txnCurrency} />
                      </td>
                      <td className="py-2 text-right">
                        <Money value={receipt.amountMinor} />
                      </td>
                    </tr>
                  ))}
                  {grant.receipts.length === 0 ? (
                    <tr>
                      <td className="py-2 text-slate-500" colSpan={5}>
                        Nothing received yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            {grant.releases.length ? (
              <>
                <h4 className="mt-6 text-sm font-semibold uppercase tracking-[0.12em] text-slate-500">Recognised from deferred income</h4>
                <table className="mt-2 w-full text-sm">
                  <tbody className="divide-y divide-slate-100">
                    {grant.releases.map((row) => (
                      <tr key={row.id}>
                        <td className="py-2 text-slate-600">{row.date}</td>
                        <td className="py-2 text-slate-900">{row.basis === 'spending' ? 'Eligible spending' : 'Condition met'}</td>
                        <td className="py-2 text-right">
                          <Money value={row.amountMinor} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : null}
          </Card>
        </div>
      ) : null}

      {/* --- conditions ---------------------------------------------------------- */}
      {grant && conditions && tab === 'Conditions' ? (
        <div className="space-y-6">
          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">
              Conditions
              <span className="ml-3 text-sm font-normal text-slate-500">
                {conditions.met} of {conditions.total} met{conditions.overdue ? `, ${conditions.overdue} overdue` : ''}
              </span>
            </h3>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="py-2">Condition</th>
                    <th className="py-2">Due</th>
                    <th className="py-2">Met</th>
                    <th className="py-2 text-right">Income released</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {grant.conditions.map((condition) => {
                    const overdue = !condition.metAt && condition.dueDate && condition.dueDate < today;
                    return (
                      <tr key={condition.id}>
                        <td className="py-2 text-slate-900">{condition.description}</td>
                        <td className={['py-2', overdue ? 'text-rose-700' : 'text-slate-600'].join(' ')}>{condition.dueDate ?? '—'}</td>
                        <td className="py-2 text-slate-600">{condition.metAt ? `${condition.metAt.slice(0, 10)}${condition.metByName ? ` by ${condition.metByName}` : ''}` : 'Outstanding'}</td>
                        <td className="py-2 text-right">
                          <Money value={condition.releasedMinor} />
                        </td>
                        <td className="py-2 text-right">
                          {allowed('document:post') ? (
                            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run('Condition updated.', () => setConditionMet(entity.id, condition.id, !condition.metAt))}>
                              {condition.metAt ? 'Reopen' : 'Mark met'}
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                  {grant.conditions.length === 0 ? (
                    <tr>
                      <td className="py-2 text-slate-500" colSpan={5}>
                        No conditions recorded.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>

          {allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">Add a condition</h3>
              <div className="mt-4 grid gap-4 md:grid-cols-4">
                <div className="md:col-span-2">
                  <label className={label}>What the donor requires</label>
                  <Input value={conditionForm.description} onChange={(e) => setConditionForm((f) => ({ ...f, description: e.target.value }))} placeholder="Baseline survey delivered" />
                </div>
                <div>
                  <label className={label}>Due</label>
                  <Input type="date" value={conditionForm.dueDate} onChange={(e) => setConditionForm((f) => ({ ...f, dueDate: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Note</label>
                  <Input value={conditionForm.note} onChange={(e) => setConditionForm((f) => ({ ...f, note: e.target.value }))} />
                </div>
              </div>
              <div className="mt-4">
                <Button
                  size="sm"
                  disabled={pending || !conditionForm.description.trim()}
                  onClick={() =>
                    run('Condition added.', () => saveCondition(entity.id, { grantId: grant.id, description: conditionForm.description, dueDate: conditionForm.dueDate || null, note: conditionForm.note }), () =>
                      setConditionForm({ id: '', description: '', dueDate: '', note: '' }),
                    )
                  }
                >
                  Add
                </Button>
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* --- in kind and staff time ------------------------------------------------ */}
      {grant && tab === 'In kind & time' ? (
        <div className="space-y-6">
          {allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">Record an in-kind contribution</h3>
              <p className="mt-1 text-sm text-slate-600">Income for what it was worth and expenditure for its use, so the surplus does not move.</p>
              <div className="mt-4 grid gap-4 md:grid-cols-3">
                <div>
                  <label className={label}>Date</label>
                  <Input type="date" value={inKindForm.date} onChange={(e) => setInKindForm((f) => ({ ...f, date: e.target.value }))} />
                </div>
                <div className="md:col-span-2">
                  <label className={label}>What was given</label>
                  <Input value={inKindForm.description} onChange={(e) => setInKindForm((f) => ({ ...f, description: e.target.value }))} placeholder="200 seedling trays from the district assembly" />
                </div>
                <div>
                  <label className={label}>Kind</label>
                  <select className={selectClass} value={inKindForm.kind} onChange={(e) => setInKindForm((f) => ({ ...f, kind: e.target.value as InKindKind }))}>
                    {inKindKinds.map((kind) => (
                      <option key={kind} value={kind}>
                        {inKindKindLabels[kind]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Value ({entity.functionalCurrency})</label>
                  <Input inputMode="decimal" value={inKindForm.value} onChange={(e) => setInKindForm((f) => ({ ...f, value: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Budget line</label>
                  <select className={selectClass} value={inKindForm.budgetLineId} onChange={(e) => setInKindForm((f) => ({ ...f, budgetLineId: e.target.value }))}>
                    <option value="">None</option>
                    {grant.budgetLines.map((line) => (
                      <option key={line.id} value={line.id}>
                        {line.code} {line.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Given by</label>
                  <select className={selectClass} value={inKindForm.donorContactId} onChange={(e) => setInKindForm((f) => ({ ...f, donorContactId: e.target.value }))}>
                    <option value="">Not recorded</option>
                    {donors.map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className={label}>How it was valued</label>
                  <Input value={inKindForm.basis} onChange={(e) => setInKindForm((f) => ({ ...f, basis: e.target.value }))} placeholder="Local market price, three quotes" />
                </div>
              </div>
              <div className="mt-4">
                <Button
                  size="sm"
                  disabled={pending || !inKindForm.description.trim() || !inKindForm.value}
                  onClick={() =>
                    run(
                      'In-kind contribution recorded.',
                      () => recordInKind(entity.id, { grantId: grant.id, budgetLineId: inKindForm.budgetLineId || null, date: inKindForm.date, description: inKindForm.description, kind: inKindForm.kind, valueMinor: toMinor(inKindForm.value), basis: inKindForm.basis, donorContactId: inKindForm.donorContactId || null }),
                      () => setInKindForm((f) => ({ ...f, description: '', value: '', basis: '' })),
                    )
                  }
                >
                  Record
                </Button>
              </div>
            </Card>
          ) : null}

          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">In-kind contributions</h3>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="py-2">Date</th>
                    <th className="py-2">What was given</th>
                    <th className="py-2">Kind</th>
                    <th className="py-2">By</th>
                    <th className="py-2 text-right">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {inKind.filter((row) => row.grantId === grant.id).map((row) => (
                    <tr key={row.id}>
                      <td className="py-2 text-slate-600">{row.date}</td>
                      <td className="py-2 text-slate-900">{row.description}</td>
                      <td className="py-2 text-slate-600">{inKindKindLabels[row.kind]}</td>
                      <td className="py-2 text-slate-600">{row.donorName}</td>
                      <td className="py-2 text-right">
                        <Money value={row.valueMinor} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">Allocate staff time</h3>
              <p className="mt-1 text-sm text-slate-600">Charging it to the grant moves the cost onto it without changing what {entity.name} spent in total.</p>
              <div className="mt-4 grid gap-4 md:grid-cols-4">
                <div>
                  <label className={label}>Person</label>
                  <Input value={timeForm.personName} onChange={(e) => setTimeForm((f) => ({ ...f, personName: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Role</label>
                  <Input value={timeForm.role} onChange={(e) => setTimeForm((f) => ({ ...f, role: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>From</label>
                  <Input type="date" value={timeForm.periodStart} onChange={(e) => setTimeForm((f) => ({ ...f, periodStart: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>To</label>
                  <Input type="date" value={timeForm.periodEnd} onChange={(e) => setTimeForm((f) => ({ ...f, periodEnd: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Hours</label>
                  <Input inputMode="decimal" value={timeForm.hours} onChange={(e) => setTimeForm((f) => ({ ...f, hours: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Rate per hour ({entity.functionalCurrency})</label>
                  <Input inputMode="decimal" value={timeForm.rate} onChange={(e) => setTimeForm((f) => ({ ...f, rate: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Salary account</label>
                  <select className={selectClass} value={timeForm.accountCode} onChange={(e) => setTimeForm((f) => ({ ...f, accountCode: e.target.value }))}>
                    <option value="">Choose…</option>
                    {expenseAccounts.map((account) => (
                      <option key={account.code} value={account.code}>
                        {account.code} {account.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Budget line</label>
                  <select className={selectClass} value={timeForm.budgetLineId} onChange={(e) => setTimeForm((f) => ({ ...f, budgetLineId: e.target.value }))}>
                    <option value="">None</option>
                    {grant.budgetLines.map((line) => (
                      <option key={line.id} value={line.id}>
                        {line.code} {line.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Put it in the accounts?</label>
                  <select className={selectClass} value={timeForm.post ? 'yes' : 'no'} onChange={(e) => setTimeForm((f) => ({ ...f, post: e.target.value === 'yes' }))}>
                    <option value="yes">Charge it to the grant</option>
                    <option value="no">Report it only</option>
                  </select>
                </div>
              </div>
              <div className="mt-4">
                <Button
                  size="sm"
                  disabled={pending || !timeForm.personName.trim() || !timeForm.hours || !timeForm.rate || !timeForm.accountCode}
                  onClick={() =>
                    run(
                      'Staff time recorded.',
                      () =>
                        recordStaffTime(entity.id, {
                          grantId: grant.id,
                          budgetLineId: timeForm.budgetLineId || null,
                          personName: timeForm.personName,
                          role: timeForm.role,
                          periodStart: timeForm.periodStart,
                          periodEnd: timeForm.periodEnd,
                          hours: Number(timeForm.hours),
                          rateMinorPerHour: toMinor(timeForm.rate),
                          accountCode: timeForm.accountCode,
                          note: timeForm.note,
                          post: timeForm.post,
                        }),
                      () => setTimeForm((f) => ({ ...f, personName: '', role: '', hours: '' })),
                    )
                  }
                >
                  Record
                </Button>
              </div>
            </Card>
          ) : null}

          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Staff time</h3>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="py-2">Person</th>
                    <th className="py-2">Period</th>
                    <th className="py-2 text-right">Hours</th>
                    <th className="py-2 text-right">Value</th>
                    <th className="py-2">In the accounts</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {staffTime.filter((row) => row.grantId === grant.id).map((row) => (
                    <tr key={row.id}>
                      <td className="py-2 text-slate-900">
                        {row.personName}
                        {row.role ? <span className="ml-2 text-xs text-slate-500">{row.role}</span> : null}
                      </td>
                      <td className="py-2 text-slate-600">
                        {row.periodStart} to {row.periodEnd}
                      </td>
                      <td className="py-2 text-right text-slate-600">{row.hours}</td>
                      <td className="py-2 text-right">
                        <Money value={row.valueMinor} />
                      </td>
                      <td className="py-2 text-slate-600">{row.posted ? 'Charged to the grant' : 'Reported only'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
