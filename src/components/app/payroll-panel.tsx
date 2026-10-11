'use client';

/**
 * Payroll, per entity: pay runs from draft to posted, payslips, what payroll
 * owes and when, employees and loans, the reports, and the entity's own
 * payroll settings. The statutory rates are under Settings → Payroll rates,
 * the same for every company in the group.
 *
 * Casual and seasonal labour paid through a buying agent is not payroll — it
 * is recorded against the agent's float on the Buying screen, and appears
 * beside payroll only in the labour cost report.
 */

import { Fragment, useMemo, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import {
  approvePayRun,
  createPayRun,
  downloadPayslip,
  emailPayslip,
  payRemittance,
  postPayRun,
  recalculatePayRun,
  reopenPayRun,
  reversePayRun,
  setPayLineInputs,
} from '@/app/actions/payroll';
import { savePayrollSettings } from '@/app/actions/payroll-settings';
import { PayrollPeople } from '@/components/app/payroll-people';
import { Banner, cedisOf, download, fieldLabel, minorOf, selectClass, todayIso, type Message } from '@/components/app/payroll-ui';
import { PayrollReports } from '@/components/app/payroll-reports-view';
import type { Permission } from '@/lib/authz';
import type { CasualLabourFact, EmployeeRecord, PayRunRecord, RemittanceRecord, StaffLoanRecord } from '@/lib/data/payroll';
import type { PayrollSettingRecord } from '@/lib/data/payroll-rates';
import type { AccountRecord, BankAccountRecord, EntityRecord, PostedJournal, ProjectRecord } from '@/lib/data/types';
import type { ProrationBasis } from '@/lib/payroll-engine';
import { lastDayOf, type StatutoryRateRow } from '@/lib/payroll-rates';
import type { PayLineFact } from '@/lib/payroll-reports';
import { approvalProblems, payRunJournal, remittanceLabels, remittancePosition, type PayJournalLine } from '@/lib/payroll-run';
import { buildPayslip, periodLabel, type Payslip } from '@/lib/payslip';

type Props = {
  entity: EntityRecord;
  entities: EntityRecord[];
  settings: PayrollSettingRecord;
  rates: StatutoryRateRow[];
  employees: EmployeeRecord[];
  runs: PayRunRecord[];
  loans: StaffLoanRecord[];
  remittances: RemittanceRecord[];
  factsByEntity: Record<string, PayLineFact[]>;
  casualByEntity: Record<string, CasualLabourFact[]>;
  ledger: Record<string, number>;
  accounts: AccountRecord[];
  projects: ProjectRecord[];
  bankAccounts: BankAccountRecord[];
  allowed: (permission: Permission) => boolean;
};

type Tab = 'Pay runs' | 'What payroll owes' | 'People' | 'Reports' | 'Settings';

const statusStyle: Record<PayRunRecord['status'], string> = {
  draft: 'bg-slate-100 text-slate-700',
  approved: 'bg-sky-100 text-sky-800',
  posted: 'bg-green-100 text-green-700',
  reversed: 'bg-rose-100 text-rose-700',
};
const statusWords: Record<PayRunRecord['status'], string> = { draft: 'Draft', approved: 'Approved', posted: 'Posted', reversed: 'Reversed' };

function StatusBadge({ status }: { status: PayRunRecord['status'] }) {
  return <span className={['inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]', statusStyle[status]].join(' ')}>{statusWords[status]}</span>;
}

export function PayrollPanel(props: Props) {
  const { entity, settings, employees, runs, allowed } = props;
  const [tab, setTab] = useState<Tab>(settings.payrollEnabled ? 'Pay runs' : 'Settings');
  const tabs: Tab[] = ['Pay runs', 'What payroll owes', 'People', 'Reports', 'Settings'];

  if (!allowed('payroll:view')) {
    return (
      <Card className="rounded-2xl">
        <h3 className="text-xl font-semibold text-slate-900">Payroll</h3>
        <p className="mt-2 text-sm text-slate-600">Your role does not show what named people are paid. Payroll totals are in the reports, through the ledger.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{entity.name}</p>
        <h3 className="mt-1 text-xl font-semibold text-slate-900">Payroll</h3>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Pay is worked out from the statutory rates under Settings → Payroll rates. Casual and seasonal labour paid through a buying agent is not payroll: it is recorded against the
          agent’s float on the Buying screen.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {tabs.map((name) => (
          <button key={name} type="button" onClick={() => setTab(name)} className={['rounded-lg px-3 py-1.5 text-sm font-medium', tab === name ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'].join(' ')}>
            {name}
          </button>
        ))}
      </div>

      {tab === 'Pay runs' ? <PayRuns {...props} /> : null}
      {tab === 'What payroll owes' ? <Remittances {...props} /> : null}
      {tab === 'People' ? <PayrollPeople entity={entity} employees={employees} loans={props.loans} accounts={props.accounts} projects={props.projects} bankAccounts={props.bankAccounts} allowed={allowed} /> : null}
      {tab === 'Reports' ? (
        <PayrollReports entity={entity} entities={props.entities} factsByEntity={props.factsByEntity} casualByEntity={props.casualByEntity} remittances={props.remittances} ledger={props.ledger} loans={props.loans} projects={props.projects} runs={runs} />
      ) : null}
      {tab === 'Settings' ? <PayrollSettingsCard entity={entity} settings={settings} rates={props.rates} allowed={allowed} /> : null}
    </div>
  );
}

// --- pay runs -----------------------------------------------------------------------------------

function PayRuns({ entity, settings, employees, runs, loans, factsByEntity, allowed }: Props) {
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  const [period, setPeriod] = useState(todayIso().slice(0, 7));
  const [selectedId, setSelectedId] = useState<string | null>(runs[0]?.id ?? null);
  const [reason, setReason] = useState('');
  const [openLine, setOpenLine] = useState<string | null>(null);
  const [slipLine, setSlipLine] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, { bonus: string; overtime: string }>>({});

  const run = runs.find((r) => r.id === selectedId) ?? null;
  const employeeById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);

  function act(okText: string, action: () => Promise<{ ok: true; value?: unknown } | { ok: false; error: string }>, after?: (value: unknown) => void) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setMessage({ tone: 'ok', text: okText });
        after?.(result.value);
      } else setMessage({ tone: 'error', text: result.error });
    });
  }

  const problems = run && run.status === 'draft' ? approvalProblems(run.lines.map((l) => ({ error: l.error, result: l.result }))) : [];
  // The journal a draft or approved run will post, from the same function posting uses.
  const previewLines = run && !run.journal ? run.lines.filter((l) => l.result && l.inputs) : [];
  const preview: PayJournalLine[] | null = previewLines.length
    ? payRunJournal(previewLines.map((l) => ({ expenseAccountCode: l.inputs!.expenseAccountCode, allocations: l.inputs!.allocations, result: l.result! })))
    : null;

  return (
    <div className="space-y-5">
      <Banner message={message} />
      {!settings.payrollEnabled ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">Payroll is switched off for {entity.name}. Switch it on under Settings on this screen to run payroll.</div>
      ) : allowed('payroll:prepare') ? (
        <Card className="rounded-2xl">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className={fieldLabel} htmlFor="pr-period">Pay period</label>
              <Input id="pr-period" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
            </div>
            <Button disabled={pending} onClick={() => act(`${periodLabel(period)} opened and worked out.`, () => createPayRun(entity.id, period), (value) => setSelectedId((value as PayRunRecord).id))}>
              Open the pay run
            </Button>
            <p className="text-xs text-slate-500">Everyone employed on any day of the month is worked out. Bonus and overtime are entered per person once it is open.</p>
          </div>
        </Card>
      ) : null}

      {runs.length === 0 ? (
        <p className="text-sm text-slate-500">No pay runs yet.</p>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
          <Card className="rounded-2xl p-0">
            <ul className="divide-y divide-slate-100">
              {runs.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => setSelectedId(r.id)} className={['w-full px-4 py-3 text-left', r.id === selectedId ? 'bg-brand-50' : 'hover:bg-slate-50'].join(' ')}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-900">{periodLabel(r.period)}{r.sequence > 1 ? ` (${r.sequence})` : ''}</span>
                      <StatusBadge status={r.status} />
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {r.totals.employees} paid · net <Money value={r.totals.netMinor} />
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          {run ? (
            <div className="space-y-5">
              <Card className="rounded-2xl">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="text-lg font-semibold text-slate-900">
                      {periodLabel(run.period)} <StatusBadge status={run.status} />
                    </h4>
                    <p className="mt-1 text-sm text-slate-600">
                      Paid on {run.payDate}.
                      {run.approvedAt ? ` Approved by ${run.approvedByName} on ${run.approvedAt.slice(0, 10)}.` : ''}
                      {run.postedAt ? ` Posted by ${run.postedByName} on ${run.postedAt.slice(0, 10)}.` : ''}
                      {run.reversedAt ? ` Reversed by ${run.reversedByName} on ${run.reversedAt.slice(0, 10)}: ${run.reversalReason}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {run.status === 'draft' && allowed('payroll:prepare') ? (
                      <Button size="sm" variant="secondary" disabled={pending} onClick={() => act('Worked out again from the employees, loans and rates as they stand.', () => recalculatePayRun(entity.id, run.id))}>
                        Recalculate
                      </Button>
                    ) : null}
                    {run.status === 'draft' && allowed('payroll:approve') ? (
                      <Button size="sm" disabled={pending || problems.length > 0} onClick={() => act('Approved. The figures are locked.', () => approvePayRun(entity.id, run.id))}>
                        Approve
                      </Button>
                    ) : null}
                    {run.status === 'approved' && allowed('payroll:approve') ? (
                      <Button size="sm" variant="secondary" disabled={pending} onClick={() => act('Back to draft.', () => reopenPayRun(entity.id, run.id))}>
                        Back to draft
                      </Button>
                    ) : null}
                    {run.status === 'approved' && allowed('payroll:post') ? (
                      <Button size="sm" disabled={pending} onClick={() => act('Posted. What it leaves owing is under “What payroll owes”.', () => postPayRun(entity.id, run.id))}>
                        Post the journal
                      </Button>
                    ) : null}
                  </div>
                </div>

                {problems.length ? (
                  <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    <p className="font-semibold">Not ready to approve</p>
                    <ul className="mt-1 list-disc pl-5">
                      {problems.map((problem) => (
                        <li key={problem}>{problem}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  {[
                    ['Gross pay', run.totals.grossMinor],
                    ['PAYE', run.totals.payeMinor],
                    ['SSNIT (employee + employer)', run.totals.employeeSsnitMinor + run.totals.employerSsnitMinor + run.totals.employerTier2Minor],
                    ['Net pay', run.totals.netMinor],
                    ['Cost to the company', run.totals.employerCostMinor],
                  ].map(([name, value]) => (
                    <div key={name as string} className="rounded-xl bg-slate-50 px-4 py-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">{name}</p>
                      <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900"><Money value={value as number} /></p>
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="rounded-2xl">
                <h4 className="text-base font-semibold text-slate-900">Who is paid what</h4>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[860px] text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                        <th className="pb-2 pr-3 font-medium">Employee</th>
                        <th className="pb-2 pr-3 text-right font-medium">Gross</th>
                        <th className="pb-2 pr-3 text-right font-medium">SSNIT</th>
                        <th className="pb-2 pr-3 text-right font-medium">PAYE</th>
                        <th className="pb-2 pr-3 text-right font-medium">Loans</th>
                        <th className="pb-2 pr-3 text-right font-medium">Net pay</th>
                        <th className="pb-2 pr-3 text-right font-medium">Cost</th>
                        <th className="pb-2 font-medium" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {run.lines.map((line) => {
                        const person = employeeById.get(line.employeeId);
                        const r = line.result;
                        const draft = inputs[line.id] ?? { bonus: line.bonusInputMinor ? cedisOf(line.bonusInputMinor) : '', overtime: line.overtimeInputMinor ? cedisOf(line.overtimeInputMinor) : '' };
                        return (
                          <Fragment key={line.id}>
                            <tr className={line.error ? 'bg-rose-50' : ''}>
                              <td className="py-2 pr-3">
                                <p className="font-medium text-slate-900">{person?.name ?? 'Unknown'}</p>
                                <p className="text-xs text-slate-500">{person?.staffNumber}{r && r.daysEmployed < r.daysInPeriod ? ` · ${r.daysEmployed} of ${r.daysInPeriod} days` : ''}</p>
                              </td>
                              {r ? (
                                <>
                                  <td className="py-2 pr-3 text-right tabular-nums"><Money value={r.grossMinor} /></td>
                                  <td className="py-2 pr-3 text-right tabular-nums"><Money value={r.employeeSsnitMinor} /></td>
                                  <td className="py-2 pr-3 text-right tabular-nums"><Money value={r.payeMinor} /></td>
                                  <td className="py-2 pr-3 text-right tabular-nums">{r.deductionsMinor ? <Money value={r.deductionsMinor} /> : '—'}</td>
                                  <td className="py-2 pr-3 text-right font-semibold tabular-nums"><Money value={r.netMinor} /></td>
                                  <td className="py-2 pr-3 text-right tabular-nums"><Money value={r.employerCostMinor} /></td>
                                </>
                              ) : (
                                <td colSpan={6} className="py-2 pr-3 text-sm text-rose-800">{line.error}</td>
                              )}
                              <td className="py-2 text-right">
                                <div className="flex justify-end gap-1">
                                  {r ? <Button size="sm" variant="ghost" onClick={() => setOpenLine(openLine === line.id ? null : line.id)}>{openLine === line.id ? 'Hide' : 'Working'}</Button> : null}
                                  {r ? <Button size="sm" variant="ghost" onClick={() => setSlipLine(slipLine === line.id ? null : line.id)}>Payslip</Button> : null}
                                </div>
                              </td>
                            </tr>
                            {run.status === 'draft' && allowed('payroll:prepare') && openLine === line.id ? (
                              <tr>
                                <td colSpan={8} className="pb-3">
                                  <div className="flex flex-wrap items-end gap-3 rounded-xl bg-slate-50 p-3">
                                    <div>
                                      <label className={fieldLabel} htmlFor={`b-${line.id}`}>Bonus this month (GHS)</label>
                                      <Input id={`b-${line.id}`} inputMode="decimal" value={draft.bonus} onChange={(e) => setInputs({ ...inputs, [line.id]: { ...draft, bonus: e.target.value } })} />
                                    </div>
                                    <div>
                                      <label className={fieldLabel} htmlFor={`o-${line.id}`}>Overtime this month (GHS)</label>
                                      <Input id={`o-${line.id}`} inputMode="decimal" value={draft.overtime} onChange={(e) => setInputs({ ...inputs, [line.id]: { ...draft, overtime: e.target.value } })} />
                                    </div>
                                    <Button
                                      size="sm"
                                      disabled={pending}
                                      onClick={() => {
                                        const bonusMinor = minorOf(draft.bonus);
                                        const overtimeMinor = minorOf(draft.overtime);
                                        if (Number.isNaN(bonusMinor) || Number.isNaN(overtimeMinor)) return setMessage({ tone: 'error', text: 'Bonus and overtime are amounts in cedis.' });
                                        act('Saved and worked out again.', () => setPayLineInputs(entity.id, line.id, { bonusMinor, overtimeMinor }));
                                      }}
                                    >
                                      Save and recalculate
                                    </Button>
                                  </div>
                                </td>
                              </tr>
                            ) : null}
                            {openLine === line.id && r ? (
                              <tr>
                                <td colSpan={8} className="pb-4">
                                  <Working result={r} />
                                </td>
                              </tr>
                            ) : null}
                            {slipLine === line.id && r && line.inputs && person ? (
                              <tr>
                                <td colSpan={8} className="pb-4">
                                  <PayslipView
                                    slip={buildPayslip({
                                      entityName: entity.name,
                                      period: run.period,
                                      payDate: run.payDate,
                                      posted: run.status === 'posted',
                                      employee: { name: person.name, staffNumber: person.staffNumber, department: person.department, tin: person.tin, ssnitNumber: person.ssnitNumber },
                                      result: r,
                                      deductions: line.inputs.deductions,
                                      loans: loans
                                        .filter((loan) => loan.employeeId === person.id)
                                        .map((loan) => ({
                                          id: loan.id,
                                          description: loan.description,
                                          outstandingBeforeMinor: loan.outstandingMinor + (run.status === 'posted' ? (line.inputs!.deductions.find((d) => d.loanId === loan.id)?.amountMinor ?? 0) : 0),
                                        })),
                                      earlierThisYear: (factsByEntity[entity.id] ?? []).filter((f) => f.employeeId === person.id && f.period.slice(0, 4) === run.period.slice(0, 4) && f.period < run.period),
                                    })}
                                    pending={pending}
                                    canEmail={allowed('payroll:prepare') && run.status === 'posted'}
                                    onDownload={() =>
                                      act('Payslip downloaded.', () => downloadPayslip(entity.id, line.id), (value) => {
                                        const file = value as { fileName: string; base64: string };
                                        download(file.fileName, file.base64, 'application/pdf');
                                      })
                                    }
                                    onEmail={() => act('Payslip emailed.', () => emailPayslip(entity.id, line.id), (value) => setMessage({ tone: 'ok', text: `Payslip emailed to ${(value as { to: string }).to}.` }))}
                                  />
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card className="rounded-2xl">
                <h4 className="text-base font-semibold text-slate-900">{run.journal ? 'The journal posted' : 'The journal it will post'}</h4>
                <p className="mt-1 text-sm text-slate-600">
                  Gross pay and the employer’s contributions are the cost, split by project where people are allocated. PAYE, SSNIT, tier 2, tier 3 and net pay are each money owed until
                  paid.
                </p>
                {run.journal ? <PostedJournalTable journal={run.journal} /> : preview ? <PreviewJournalTable lines={preview} /> : <p className="mt-3 text-sm text-slate-500">Nothing to post yet.</p>}
                {run.reversalJournal ? (
                  <>
                    <h5 className="mt-5 text-sm font-semibold text-slate-900">Reversed on {run.reversalJournal.postedAt}</h5>
                    <PostedJournalTable journal={run.reversalJournal} />
                  </>
                ) : null}
              </Card>

              {run.status === 'posted' && allowed('payroll:post') ? (
                <Card className="rounded-2xl">
                  <h4 className="text-base font-semibold text-slate-900">Reverse this pay run</h4>
                  <p className="mt-1 text-sm text-slate-600">A reversing entry dated today undoes the journal, recorded beside it. Only before anything it left owing has been paid. The month can then be run again.</p>
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <div className="min-w-[280px] flex-1">
                      <label className={fieldLabel} htmlFor="rev-reason">Why</label>
                      <Input id="rev-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong basic for two people" />
                    </div>
                    <Button variant="secondary" disabled={pending} onClick={() => act('Reversed.', () => reversePayRun(entity.id, run.id, reason), () => setReason(''))}>
                      Reverse it
                    </Button>
                  </div>
                </Card>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Working({ result }: { result: NonNullable<PayRunRecord['lines'][number]['result']> }) {
  const steps = [...new Set(result.working.map((line) => line.step))];
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      {result.ratesChangedWithin.length ? (
        <p className="mb-2 text-xs text-amber-800">Changed part way through the month, and applied to all of it: {result.ratesChangedWithin.map((c) => `${c.label} (from ${c.from})`).join(', ')}.</p>
      ) : null}
      <table className="w-full text-sm">
        <tbody>
          {steps.map((step) => (
            <Fragment key={step}>
              <tr>
                <th colSpan={3} className="pb-1 pt-3 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{step === 'Employer' ? 'Employer contributions (not taken from pay)' : step}</th>
              </tr>
              {result.working
                .filter((line) => line.step === step)
                .map((line, index) => (
                  <tr key={index} className={line.total ? 'border-t border-slate-200 font-semibold' : ''}>
                    <td className="py-0.5 pr-3 text-slate-800">{line.label}</td>
                    <td className="py-0.5 pr-3 text-xs text-slate-500">{line.detail ?? ''}</td>
                    <td className="py-0.5 text-right tabular-nums">{line.amountMinor === 0 && !line.total && !line.calc ? '' : <Money value={line.amountMinor} />}</td>
                  </tr>
                ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PayslipView({ slip, pending, canEmail, onDownload, onEmail }: { slip: Payslip; pending: boolean; canEmail: boolean; onDownload: () => void; onEmail: () => void }) {
  const rows = (items: { label: string; amountMinor: number; note?: string }[]) =>
    items.map((item) => (
      <div key={item.label} className="flex justify-between gap-3 py-0.5 text-sm">
        <span className="text-slate-700">
          {item.label}
          {item.note ? <span className="ml-2 text-xs text-slate-400">{item.note}</span> : null}
        </span>
        <span className="tabular-nums text-slate-900"><Money value={item.amountMinor} /></span>
      </div>
    ));
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">{slip.entityName} — payslip for {periodLabel(slip.period)}</p>
          <p className="text-xs text-slate-500">{slip.employee.name} · {slip.employee.staffNumber} · paid on {slip.payDate}</p>
          {slip.daysNote ? <p className="text-xs text-slate-500">{slip.daysNote}</p> : null}
          {slip.provisional ? <p className="mt-1 text-xs font-semibold text-amber-800">Provisional — the run is not posted and the figures may change.</p> : null}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={pending} onClick={onDownload}>Download PDF</Button>
          {canEmail ? <Button size="sm" variant="secondary" disabled={pending} onClick={onEmail}>Email it</Button> : null}
        </div>
      </div>
      <div className="mt-3 grid gap-5 md:grid-cols-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Earnings</p>
          {rows(slip.earnings)}
          <div className="mt-1 border-t border-slate-200 pt-1 font-semibold">{rows([{ label: 'Gross pay', amountMinor: slip.grossMinor }])}</div>
          <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Paid by the employer on top</p>
          {rows(slip.employer)}
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Deductions</p>
          {rows(slip.deductions)}
          <div className="mt-1 border-t border-slate-200 pt-1 font-semibold">{rows([{ label: 'Net pay', amountMinor: slip.netMinor }])}</div>
          <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Year to date</p>
          {rows(slip.yearToDate)}
          {slip.loans.length ? (
            <>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Loans and advances — still owed</p>
              {rows(slip.loans.map((loan) => ({ label: loan.description, amountMinor: loan.outstandingMinor })))}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PreviewJournalTable({ lines }: { lines: PayJournalLine[] }) {
  return (
    <table className="mt-3 w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
          <th className="pb-2 pr-3 font-medium">Account</th>
          <th className="pb-2 pr-3 font-medium">What</th>
          <th className="pb-2 pr-3 font-medium">Project</th>
          <th className="pb-2 pr-3 text-right font-medium">Money in</th>
          <th className="pb-2 text-right font-medium">Money out</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {lines.map((line, index) => (
          <tr key={index}>
            <td className="py-1.5 pr-3 tabular-nums">{line.accountCode}</td>
            <td className="py-1.5 pr-3">{line.memo}</td>
            <td className="py-1.5 pr-3 text-xs text-slate-500">{line.projectId ? 'Charged to a project' : ''}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums">{line.type === 'debit' ? <Money value={line.amount} /> : ''}</td>
            <td className="py-1.5 text-right tabular-nums">{line.type === 'credit' ? <Money value={line.amount} /> : ''}</td>
          </tr>
        ))}
        <tr className="font-semibold">
          <td className="py-1.5" colSpan={3}>Totals — they agree</td>
          <td className="py-1.5 pr-3 text-right tabular-nums"><Money value={lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amount, 0)} /></td>
          <td className="py-1.5 text-right tabular-nums"><Money value={lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amount, 0)} /></td>
        </tr>
      </tbody>
    </table>
  );
}

function PostedJournalTable({ journal }: { journal: PostedJournal }) {
  return (
    <table className="mt-3 w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
          <th className="pb-2 pr-3 font-medium">Account</th>
          <th className="pb-2 pr-3 text-right font-medium">Money in</th>
          <th className="pb-2 text-right font-medium">Money out</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {journal.lines.map((line, index) => (
          <tr key={index}>
            <td className="py-1.5 pr-3">{line.accountCode} · {line.accountName}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums">{line.type === 'debit' ? <Money value={line.amount} /> : ''}</td>
            <td className="py-1.5 text-right tabular-nums">{line.type === 'credit' ? <Money value={line.amount} /> : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --- what payroll owes ----------------------------------------------------------------------------

function Remittances({ entity, remittances, bankAccounts, allowed }: Props) {
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  const [paying, setPaying] = useState<{ id: string; paidOn: string; reference: string; bankAccountId: string } | null>(null);
  const today = todayIso();
  const position = remittancePosition(remittances.map((r) => ({ id: r.id, period: r.period, kind: r.kind, amountMinor: r.amountMinor, dueDate: r.dueDate, paidOn: r.paidOn, cancelled: r.cancelled })), today);
  const ordered = [...remittances].sort((a, b) => Number(Boolean(a.paidOn || a.cancelled)) - Number(Boolean(b.paidOn || b.cancelled)) || a.dueDate.localeCompare(b.dueDate));

  return (
    <div className="space-y-5">
      <Banner message={message} />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className={['rounded-xl px-4 py-3', position.overdueMinor > 0 ? 'bg-rose-50' : 'bg-slate-50'].join(' ')}>
          <p className="text-xs uppercase tracking-wide text-slate-500">Past its due date</p>
          <p className={['mt-1 text-lg font-semibold tabular-nums', position.overdueMinor > 0 ? 'text-rose-800' : 'text-slate-900'].join(' ')}><Money value={position.overdueMinor} /></p>
        </div>
        <div className="rounded-xl bg-slate-50 px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">Still to pay</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900"><Money value={position.outstandingMinor} /></p>
        </div>
        <div className="rounded-xl bg-slate-50 px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">Next due</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{position.next ? `${remittanceLabels[position.next.kind]} for ${periodLabel(position.next.period)} by ${position.next.dueDate}` : 'Nothing'}</p>
        </div>
      </div>
      <p className="text-sm text-slate-600">Due dates come from the payment deadline rules under Settings → Payroll rates, as they stood for each pay period. Paying one takes the money out of the bank against what is owed.</p>

      <Card className="rounded-2xl">
        {ordered.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing yet. A posted pay run puts what it leaves owing here.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="pb-2 pr-3 font-medium">Period</th>
                <th className="pb-2 pr-3 font-medium">Owed to</th>
                <th className="pb-2 pr-3 text-right font-medium">Amount</th>
                <th className="pb-2 pr-3 font-medium">Due</th>
                <th className="pb-2 font-medium">Paid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ordered.map((r) => {
                const overdue = !r.paidOn && !r.cancelled && r.dueDate < today;
                return (
                  <Fragment key={r.id}>
                    <tr className={overdue ? 'bg-rose-50' : ''}>
                      <td className="py-2 pr-3">{periodLabel(r.period)}</td>
                      <td className="py-2 pr-3">{remittanceLabels[r.kind]}</td>
                      <td className="py-2 pr-3 text-right tabular-nums"><Money value={r.amountMinor} /></td>
                      <td className={['py-2 pr-3 tabular-nums', overdue ? 'font-semibold text-rose-800' : ''].join(' ')}>{r.dueDate}{overdue ? ' — overdue' : ''}</td>
                      <td className="py-2">
                        {r.cancelled ? (
                          <span className="text-slate-500">Cancelled — the run was reversed</span>
                        ) : r.paidOn ? (
                          <span className="text-slate-700">{r.paidOn} · {r.reference} · {r.bankAccountName}</span>
                        ) : allowed('payroll:post') ? (
                          <Button size="sm" variant="secondary" onClick={() => setPaying({ id: r.id, paidOn: today, reference: '', bankAccountId: bankAccounts[0]?.id ?? '' })}>Mark paid</Button>
                        ) : (
                          <span className="text-slate-500">Not yet</span>
                        )}
                      </td>
                    </tr>
                    {paying?.id === r.id ? (
                      <tr>
                        <td colSpan={5} className="pb-3">
                          <div className="grid gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-4">
                            <div>
                              <label className={fieldLabel} htmlFor="pay-date">Paid on</label>
                              <Input id="pay-date" type="date" value={paying.paidOn} onChange={(e) => setPaying({ ...paying, paidOn: e.target.value })} />
                            </div>
                            <div>
                              <label className={fieldLabel} htmlFor="pay-ref">Reference</label>
                              <Input id="pay-ref" value={paying.reference} placeholder="GRA or SSNIT receipt, bank ref" onChange={(e) => setPaying({ ...paying, reference: e.target.value })} />
                            </div>
                            <div>
                              <label className={fieldLabel} htmlFor="pay-bank">From</label>
                              <select id="pay-bank" className={selectClass} value={paying.bankAccountId} onChange={(e) => setPaying({ ...paying, bankAccountId: e.target.value })}>
                                {bankAccounts.map((b) => (
                                  <option key={b.id} value={b.id}>{b.name}</option>
                                ))}
                              </select>
                            </div>
                            <div className="flex items-end gap-2">
                              <Button
                                size="sm"
                                disabled={pending}
                                onClick={() => {
                                  setMessage(null);
                                  startTransition(async () => {
                                    const result = await payRemittance(entity.id, paying.id, { paidOn: paying.paidOn, reference: paying.reference, bankAccountId: paying.bankAccountId });
                                    setMessage(result.ok ? { tone: 'ok', text: 'Marked paid, and the payment posted.' } : { tone: 'error', text: result.error });
                                    if (result.ok) setPaying(null);
                                  });
                                }}
                              >
                                Save
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setPaying(null)}>Cancel</Button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// --- settings -------------------------------------------------------------------------------------

function PayrollSettingsCard({ entity, settings, rates, allowed }: { entity: EntityRecord; settings: PayrollSettingRecord; rates: StatutoryRateRow[]; allowed: (p: Permission) => boolean }) {
  const may = allowed('settings:manage');
  const [form, setForm] = useState({ ...settings, payDay: String(settings.payDay) });
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  const monthEnd = lastDayOf(todayIso().slice(0, 7));
  const placeholders = rates.filter((row) => row.isPlaceholder && row.effectiveFrom <= monthEnd && (row.effectiveTo === null || row.effectiveTo >= monthEnd)).length;

  return (
    <div className="space-y-4">
      {placeholders > 0 ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {placeholders} of the statutory figures in force this month are placeholders nobody has checked yet. Pay can be worked out with them but not approved.
        </div>
      ) : null}
      <Banner message={message} />
      <Card className="rounded-2xl">
        <h4 className="text-base font-semibold text-slate-900">How {entity.name} runs payroll</h4>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-1" checked={form.payrollEnabled} disabled={!may} onChange={(e) => setForm({ ...form, payrollEnabled: e.target.checked })} />
            <span>
              <span className="font-medium text-slate-900">{entity.name} runs payroll</span>
              <span className="block text-xs text-slate-500">Off for a company with no staff on its own payroll.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-1" checked={form.tier3Offered} disabled={!may} onChange={(e) => setForm({ ...form, tier3Offered: e.target.checked })} />
            <span>
              <span className="font-medium text-slate-900">Staff may pay into tier 3 through payroll</span>
              <span className="block text-xs text-slate-500">A voluntary pension contribution, taken from pay.</span>
            </span>
          </label>
          <div>
            <label className={fieldLabel} htmlFor="ps-payday">Pay day (day of the month)</label>
            <Input id="ps-payday" inputMode="numeric" value={form.payDay} disabled={!may} onChange={(e) => setForm({ ...form, payDay: e.target.value })} />
            <p className="mt-1 text-xs text-slate-500">In a short month a day past its end means the last day. Net pay is due on it.</p>
          </div>
          <div>
            <label className={fieldLabel} htmlFor="ps-basis">Someone who joins or leaves part way through a month is paid for</label>
            <select id="ps-basis" className={selectClass} value={form.prorationBasis} disabled={!may} onChange={(e) => setForm({ ...form, prorationBasis: e.target.value as ProrationBasis })}>
              <option value="calendar-days">The calendar days they were employed</option>
              <option value="working-days">The working days (Monday to Friday) they were employed</option>
            </select>
            <p className="mt-1 text-xs text-slate-500">Working days do not yet allow for public holidays.</p>
          </div>
        </div>
        {may ? (
          <div className="mt-4">
            <Button
              size="sm"
              disabled={pending}
              onClick={() => {
                setMessage(null);
                startTransition(async () => {
                  const result = await savePayrollSettings(entity.id, { payrollEnabled: form.payrollEnabled, payDay: Number(form.payDay), tier3Offered: form.tier3Offered, prorationBasis: form.prorationBasis });
                  setMessage(result.ok ? { tone: 'ok', text: 'Payroll settings saved.' } : { tone: 'error', text: result.error });
                });
              }}
            >
              Save
            </Button>
          </div>
        ) : null}
        <p className="mt-4 text-xs text-slate-500">Payment deadlines for PAYE and SSNIT are national rules, under Settings → Payroll rates with the other statutory figures.</p>
      </Card>
    </div>
  );
}
