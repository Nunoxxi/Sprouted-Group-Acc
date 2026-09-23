'use client';

/**
 * The payroll import. There is no payroll engine here: payroll is run in a
 * Ghanaian payroll system or a spreadsheet, and this reads its summary
 * against a mapping the app remembers and posts it.
 *
 * Casual and seasonal labour paid by a buying agent is not payroll — it goes
 * through the agent float, on the Buying screen. The screen says so.
 */

import { useMemo, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import {
  importPayroll,
  payPayrollLiability,
  removePayrollAllocation,
  savePayrollAllocation,
  savePayrollDepartment,
  savePayrollMapping,
  setPayrollDueDays,
  type ImportResult,
} from '@/app/actions/payroll';
import type { Permission } from '@/lib/authz';
import type {
  AccountRecord,
  BankAccountRecord,
  EntityRecord,
  GrantRecord,
  PayrollAllocationRecord,
  PayrollDepartmentRecord,
  PayrollMappingRecord,
  PayrollRunRecord,
} from '@/lib/data/types';
import { allocationTotal, liabilityKindLabels, liabilityPosition, looksLikeCasualLabour } from '@/lib/payroll';

type Props = {
  entity: EntityRecord;
  runs: PayrollRunRecord[];
  mappings: PayrollMappingRecord[];
  departments: PayrollDepartmentRecord[];
  allocations: PayrollAllocationRecord[];
  grants: GrantRecord[];
  accounts: AccountRecord[];
  bankAccounts: BankAccountRecord[];
  allowed: (permission: Permission) => boolean;
};

type Tab = 'Import' | 'Liabilities' | 'Mapping' | 'Grant split';
const selectClass = 'min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50';
const label = 'mb-1.5 block text-sm font-medium text-slate-700';
const todayIso = () => new Date().toISOString().slice(0, 10);
const toMinor = (text: string) => Math.round(Number(String(text).replace(/,/g, '')) * 100);

const columnFields = [
  ['employeeNameColumn', 'Person', true],
  ['grossColumn', 'Gross pay', true],
  ['employeeRefColumn', 'Staff reference', false],
  ['departmentColumn', 'Department', false],
  ['payeColumn', 'PAYE', false],
  ['employeeSsnitColumn', "Employee's SSNIT", false],
  ['employerSsnitColumn', "Employer's SSNIT", false],
  ['ssnitTier2Column', 'SSNIT tier 2', false],
  ['otherDeductionsColumn', 'Other deductions', false],
  ['netColumn', 'Net pay', false],
] as const;

export function PayrollPanel({ entity, runs, mappings, departments, allocations, grants, accounts, bankAccounts, allowed }: Props) {
  const [tab, setTab] = useState<Tab>('Import');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const today = todayIso();

  const expenseAccounts = useMemo(() => accounts.filter((account) => account.type === 'EXPENSE' || account.type === 'COST_OF_SALES'), [accounts]);
  const activeGrants = useMemo(() => grants.filter((grant) => grant.status === 'active'), [grants]);

  /** Every liability across every month, for the position and the table. */
  const position = useMemo(() => {
    const rows = runs.flatMap((run) =>
      run.liabilities.map((liability) => ({
        id: liability.id,
        period: liability.period,
        kind: liability.kind,
        amountMinor: liability.amountMinor,
        settledMinor: liability.settledMinor,
        dueDate: liability.dueDate,
      })),
    );
    return liabilityPosition(rows, today);
  }, [runs, today]);
  const liabilityById = useMemo(() => new Map(runs.flatMap((run) => run.liabilities.map((liability) => [liability.id, liability]))), [runs]);

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

  // --- forms --------------------------------------------------------------------

  const [importForm, setImportForm] = useState({ period: today.slice(0, 7), payDate: today, mappingId: mappings[0]?.id ?? '', fileName: '', csv: '' });
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [mappingForm, setMappingForm] = useState<Record<string, string>>({ id: '', name: '', defaultAccountCode: '' });
  const [headers, setHeaders] = useState<string[]>([]);
  const [departmentForm, setDepartmentForm] = useState({ name: '', accountCode: '' });
  const [dueDays, setDueDays] = useState({ paye: String(entity.payeDueDay), ssnit: String(entity.ssnitDueDay) });
  const [splitForm, setSplitForm] = useState({ employeeKey: '', employeeName: '', grantId: '', budgetLineId: '', pct: '' });
  const [payForm, setPayForm] = useState({ liabilityId: '', date: today, amount: '', bankAccountId: bankAccounts[0]?.id ?? '', reference: '' });

  function editMapping(row: PayrollMappingRecord) {
    setMappingForm({
      id: row.id,
      name: row.name,
      employeeRefColumn: row.employeeRefColumn,
      employeeNameColumn: row.employeeNameColumn,
      departmentColumn: row.departmentColumn,
      grossColumn: row.grossColumn,
      payeColumn: row.payeColumn,
      employeeSsnitColumn: row.employeeSsnitColumn,
      employerSsnitColumn: row.employerSsnitColumn,
      ssnitTier2Column: row.ssnitTier2Column,
      otherDeductionsColumn: row.otherDeductionsColumn,
      netColumn: row.netColumn,
      defaultAccountCode: row.defaultAccountCode,
    });
  }

  /** The people in the most recent run, for setting a split against. */
  const people = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of runs) for (const line of row.lines) seen.set(line.employeeRef || line.employeeName, line.employeeName);
    return [...seen].map(([key, name]) => ({ key, name }));
  }, [runs]);

  const splitByPerson = useMemo(() => {
    const groups = new Map<string, PayrollAllocationRecord[]>();
    for (const row of allocations) groups.set(row.employeeKey, [...(groups.get(row.employeeKey) ?? []), row]);
    return [...groups].map(([key, rows]) => ({ key, name: rows[0].employeeName || key, rows, total: allocationTotal(rows) }));
  }, [allocations]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{entity.name}</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-900">Payroll</h2>
          <p className="mt-1 text-sm text-slate-600">
            Payroll is run in your payroll system or spreadsheet. Upload its monthly summary here and the app posts it — it never works out anybody&rsquo;s pay or tax.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(['Import', 'Liabilities', 'Mapping', 'Grant split'] as Tab[]).map((name) => (
            <Button key={name} size="sm" variant={tab === name ? 'primary' : 'secondary'} onClick={() => setTab(name)}>
              {name}
            </Button>
          ))}
        </div>
      </div>

      {message ? (
        <div className={['rounded-xl border px-4 py-3 text-sm', message.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'].join(' ')}>{message.text}</div>
      ) : null}

      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
        <span className="font-semibold">Casual and seasonal labour does not belong here.</span> Farm hands and pickers paid by a buying agent are recorded on the <span className="font-semibold">Buying</span> screen,
        against the agent&rsquo;s float, because that is where the money left.
      </div>

      {/* --- import ------------------------------------------------------------- */}
      {tab === 'Import' ? (
        <div className="space-y-6">
          {allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">Upload a month</h3>
              <p className="mt-1 text-sm text-slate-600">One file a month. Gross pay goes to each department&rsquo;s account; PAYE, SSNIT and net pay go up as liabilities until they are paid.</p>
              {mappings.length === 0 ? (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  No mapping yet. Set one up under <span className="font-semibold">Mapping</span> first — the columns are matched once and remembered.
                </div>
              ) : (
                <>
                  <div className="mt-4 grid gap-4 md:grid-cols-4">
                    <div>
                      <label className={label}>Month</label>
                      <Input value={importForm.period} onChange={(e) => setImportForm((f) => ({ ...f, period: e.target.value }))} placeholder="2026-09" />
                    </div>
                    <div>
                      <label className={label}>Pay date</label>
                      <Input type="date" value={importForm.payDate} onChange={(e) => setImportForm((f) => ({ ...f, payDate: e.target.value }))} />
                    </div>
                    <div>
                      <label className={label}>Mapping</label>
                      <select className={selectClass} value={importForm.mappingId} onChange={(e) => setImportForm((f) => ({ ...f, mappingId: e.target.value }))}>
                        {mappings.map((row) => (
                          <option key={row.id} value={row.id}>
                            {row.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className={label}>Payroll summary</label>
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        className="min-h-[44px] w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm"
                        onChange={async (event) => {
                          const file = event.target.files?.[0];
                          if (!file) return;
                          const csv = await file.text();
                          setImportForm((f) => ({ ...f, fileName: file.name, csv }));
                          setHeaders((csv.split(/\r?\n/)[0] ?? '').split(',').map((header) => header.trim().replace(/^"|"$/g, '')));
                        }}
                      />
                    </div>
                  </div>
                  {importForm.csv ? (
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <span className="text-sm text-slate-600">{importForm.fileName}</span>
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          setMessage(null);
                          setImported(null);
                          startTransition(async () => {
                            const result = await importPayroll(entity.id, importForm);
                            if (result.ok) {
                              setImported(result.value);
                              setMessage({ tone: 'ok', text: `${importForm.period} imported and posted: ${result.value.run.lines.length} people.` });
                              setImportForm((f) => ({ ...f, fileName: '', csv: '' }));
                            } else setMessage({ tone: 'error', text: result.error });
                          });
                        }}
                      >
                        Import and post
                      </Button>
                    </div>
                  ) : null}
                </>
              )}

              {imported ? (
                <div className="mt-4 space-y-2 text-sm">
                  {imported.unbalanced.length ? (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">
                      <p className="font-semibold">These rows did not add up, and were posted as the file stated them:</p>
                      <ul className="mt-1 space-y-0.5">
                        {imported.unbalanced.map((row) => (
                          <li key={row.row}>
                            Row {row.row}, {row.employeeName}: net pay is <Money value={row.statedMinor} /> but gross less the deductions comes to <Money value={row.expectedMinor} />.
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {imported.casualWarnings.length ? (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">
                      &ldquo;{imported.casualWarnings.join('&rdquo;, &ldquo;')}&rdquo; sounds like casual labour. If those people are paid by a buying agent, record them on the Buying screen instead and leave them out of payroll.
                    </div>
                  ) : null}
                  {imported.newDepartments.length ? (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-700">
                      New department{imported.newDepartments.length === 1 ? '' : 's'} {imported.newDepartments.join(', ')} charged to the mapping&rsquo;s default account. Change that under Mapping if it is wrong.
                    </div>
                  ) : null}
                  {imported.skipped.length ? <p className="text-slate-500">Passed over {imported.skipped.length} summary row{imported.skipped.length === 1 ? '' : 's'} in the file.</p> : null}
                  {imported.errors.length ? (
                    <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-rose-900">
                      <p className="font-semibold">These rows could not be read and were left out:</p>
                      <ul className="mt-1 space-y-0.5">
                        {imported.errors.map((error) => (
                          <li key={`${error.row}-${error.message}`}>
                            Row {error.row}: {error.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </Card>
          ) : null}

          {runs.map((row) => (
            <Card key={row.id} className="rounded-2xl">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">
                    {row.period}
                    <span className="ml-3 text-sm font-normal text-slate-500">
                      paid {row.payDate} · {row.lines.length} {row.lines.length === 1 ? 'person' : 'people'} · {row.fileName}
                    </span>
                  </h3>
                  <p className="text-sm text-slate-600">Posted by {row.postedByName}</p>
                </div>
                <div className="text-right text-sm">
                  <p className="text-slate-600">
                    Gross <Money value={row.grossMinor} />
                  </p>
                  <p className="font-semibold text-slate-900">
                    Cost to {entity.name} <Money value={row.employerCostMinor} />
                  </p>
                </div>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                    <tr>
                      <th className="py-2">Person</th>
                      <th className="py-2">Department</th>
                      <th className="py-2 text-right">Gross</th>
                      <th className="py-2 text-right">PAYE</th>
                      <th className="py-2 text-right">SSNIT (them)</th>
                      <th className="py-2 text-right">SSNIT (us)</th>
                      <th className="py-2 text-right">Net</th>
                      <th className="py-2">Grant split</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {row.lines.map((line) => {
                      const key = line.employeeRef || line.employeeName;
                      const theirs = allocations.filter((allocation) => allocation.employeeKey === key);
                      return (
                        <tr key={line.id} className={looksLikeCasualLabour(line.department) ? 'bg-amber-50' : ''}>
                          <td className="py-2 text-slate-900">
                            {line.employeeName}
                            {line.employeeRef ? <span className="ml-2 font-mono text-xs text-slate-500">{line.employeeRef}</span> : null}
                          </td>
                          <td className="py-2 text-slate-600">{line.department}</td>
                          <td className="py-2 text-right">
                            <Money value={line.grossMinor} />
                          </td>
                          <td className="py-2 text-right text-slate-600">
                            <Money value={line.payeMinor} />
                          </td>
                          <td className="py-2 text-right text-slate-600">
                            <Money value={line.employeeSsnitMinor} />
                          </td>
                          <td className="py-2 text-right text-slate-600">
                            <Money value={line.employerSsnitMinor + line.ssnitTier2Minor} />
                          </td>
                          <td className="py-2 text-right font-medium">
                            <Money value={line.netMinor} />
                          </td>
                          <td className="py-2 text-xs text-slate-500">{theirs.length ? theirs.map((allocation) => `${allocation.grantCode} ${allocation.pct}%`).join(', ') : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
          {runs.length === 0 ? (
            <Card className="rounded-2xl">
              <p className="text-sm text-slate-600">No payroll imported yet.</p>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* --- liabilities --------------------------------------------------------- */}
      {tab === 'Liabilities' ? (
        <div className="space-y-6">
          <Card className="rounded-2xl">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h3 className="text-lg font-semibold text-slate-900">What is still owed</h3>
              <div className="text-sm text-slate-600">
                Outstanding <Money value={position.outstandingMinor} />
                {position.overdueMinor > 0 ? (
                  <>
                    {' · '}
                    <span className="font-semibold text-rose-700">
                      <Money value={position.overdueMinor} /> past due
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            {position.next ? (
              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                Next: {liabilityKindLabels[position.next.kind]} for {position.next.period}, <Money value={position.next.outstandingMinor} /> by <span className="font-semibold">{position.next.dueDate}</span>.
              </div>
            ) : position.rows.length === 0 ? (
              <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">Nothing outstanding on payroll.</div>
            ) : null}
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="py-2">Month</th>
                    <th className="py-2">What</th>
                    <th className="py-2">Due</th>
                    <th className="py-2 text-right">Owed</th>
                    <th className="py-2 text-right">Paid</th>
                    <th className="py-2 text-right">Outstanding</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {position.rows.map((row) => (
                    <tr key={row.id} className={row.overdue ? 'bg-rose-50' : ''}>
                      <td className="py-2 text-slate-600">{row.period}</td>
                      <td className="py-2 text-slate-900">{liabilityKindLabels[row.kind]}</td>
                      <td className={['py-2', row.overdue ? 'font-medium text-rose-700' : 'text-slate-600'].join(' ')}>{row.dueDate}</td>
                      <td className="py-2 text-right">
                        <Money value={row.amountMinor} />
                      </td>
                      <td className="py-2 text-right text-slate-600">
                        <Money value={row.settledMinor} />
                      </td>
                      <td className="py-2 text-right font-medium">
                        <Money value={row.outstandingMinor} />
                      </td>
                      <td className="py-2 text-right">
                        {allowed('document:post') ? (
                          <Button size="sm" variant="ghost" onClick={() => setPayForm((f) => ({ ...f, liabilityId: row.id, amount: (row.outstandingMinor / 100).toFixed(2) }))}>
                            Pay
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {position.rows.length === 0 ? (
                    <tr>
                      <td className="py-2 text-slate-500" colSpan={7}>
                        Nothing outstanding.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>

          {payForm.liabilityId && allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">
                Pay {liabilityKindLabels[liabilityById.get(payForm.liabilityId)?.kind ?? 'paye']} for {liabilityById.get(payForm.liabilityId)?.period}
              </h3>
              <div className="mt-4 grid gap-4 md:grid-cols-4">
                <div>
                  <label className={label}>Date</label>
                  <Input type="date" value={payForm.date} onChange={(e) => setPayForm((f) => ({ ...f, date: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Amount</label>
                  <Input inputMode="decimal" value={payForm.amount} onChange={(e) => setPayForm((f) => ({ ...f, amount: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>From</label>
                  <select className={selectClass} value={payForm.bankAccountId} onChange={(e) => setPayForm((f) => ({ ...f, bankAccountId: e.target.value }))}>
                    {bankAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Reference</label>
                  <Input value={payForm.reference} onChange={(e) => setPayForm((f) => ({ ...f, reference: e.target.value }))} />
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <Button
                  size="sm"
                  disabled={pending || !payForm.amount || !payForm.bankAccountId}
                  onClick={() =>
                    run('Payment posted.', () => payPayrollLiability(entity.id, { liabilityId: payForm.liabilityId, date: payForm.date, amountMinor: toMinor(payForm.amount), bankAccountId: payForm.bankAccountId, reference: payForm.reference }), () =>
                      setPayForm((f) => ({ ...f, liabilityId: '', amount: '', reference: '' })),
                    )
                  }
                >
                  Post the payment
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPayForm((f) => ({ ...f, liabilityId: '' }))}>
                  Cancel
                </Button>
              </div>
            </Card>
          ) : null}

          {allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">When they fall due</h3>
              <p className="mt-1 text-sm text-slate-600">The day of the following month. Settings, because filing dates move.</p>
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <div>
                  <label className={label}>PAYE, day of the month</label>
                  <Input inputMode="numeric" value={dueDays.paye} onChange={(e) => setDueDays((f) => ({ ...f, paye: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>SSNIT, day of the month</label>
                  <Input inputMode="numeric" value={dueDays.ssnit} onChange={(e) => setDueDays((f) => ({ ...f, ssnit: e.target.value }))} />
                </div>
                <Button size="sm" disabled={pending} onClick={() => run('Due days saved.', () => setPayrollDueDays(entity.id, Number(dueDays.paye), Number(dueDays.ssnit)))}>
                  Save
                </Button>
                <p className="text-xs text-slate-500">Net pay is due on the pay date itself.</p>
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* --- mapping ------------------------------------------------------------- */}
      {tab === 'Mapping' ? (
        <div className="space-y-6">
          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Saved mappings</h3>
            <p className="mt-1 text-sm text-slate-600">Which column of your payroll file holds what. Matched once; the same shape imports every month after.</p>
            <div className="mt-4 space-y-2 text-sm">
              {mappings.map((row) => (
                <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3">
                  <div>
                    <p className="font-medium text-slate-900">{row.name}</p>
                    <p className="text-xs text-slate-600">
                      Person &ldquo;{row.employeeNameColumn}&rdquo; · gross &ldquo;{row.grossColumn}&rdquo;
                      {row.departmentColumn ? ` · department “${row.departmentColumn}”` : ''}
                      {row.payeColumn ? ` · PAYE “${row.payeColumn}”` : ''}
                      {row.defaultAccountCode ? ` · default account ${row.defaultAccountCode}` : ''}
                    </p>
                  </div>
                  {allowed('document:post') ? (
                    <Button size="sm" variant="ghost" onClick={() => editMapping(row)}>
                      Edit
                    </Button>
                  ) : null}
                </div>
              ))}
              {mappings.length === 0 ? <p className="text-slate-500">None yet.</p> : null}
            </div>
          </Card>

          {allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">{mappingForm.id ? `Edit ${mappingForm.name}` : 'Add a mapping'}</h3>
              {headers.length ? (
                <p className="mt-1 text-sm text-slate-600">Columns found in the file you chose: {headers.join(', ')}</p>
              ) : (
                <p className="mt-1 text-sm text-slate-600">Type each column heading exactly as it appears in your file, or choose a file on the Import tab first and pick from the list.</p>
              )}
              <div className="mt-4 grid gap-4 md:grid-cols-3">
                <div>
                  <label className={label}>Name for this mapping</label>
                  <Input value={mappingForm.name ?? ''} onChange={(e) => setMappingForm((f) => ({ ...f, name: e.target.value }))} placeholder="Monthly payroll summary" />
                </div>
                {columnFields.map(([field, text, required]) => (
                  <div key={field}>
                    <label className={label}>
                      {text}
                      {required ? '' : ' (optional)'}
                    </label>
                    {headers.length ? (
                      <select className={selectClass} value={mappingForm[field] ?? ''} onChange={(e) => setMappingForm((f) => ({ ...f, [field]: e.target.value }))}>
                        <option value="">{required ? 'Choose…' : 'Not in the file'}</option>
                        {headers.map((header) => (
                          <option key={header} value={header}>
                            {header}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Input value={mappingForm[field] ?? ''} onChange={(e) => setMappingForm((f) => ({ ...f, [field]: e.target.value }))} />
                    )}
                  </div>
                ))}
                <div>
                  <label className={label}>Default account for gross pay</label>
                  <select className={selectClass} value={mappingForm.defaultAccountCode ?? ''} onChange={(e) => setMappingForm((f) => ({ ...f, defaultAccountCode: e.target.value }))}>
                    <option value="">Choose…</option>
                    {expenseAccounts.map((account) => (
                      <option key={account.code} value={account.code}>
                        {account.code} {account.name}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-slate-500">Used for any department without its own account.</p>
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <Button
                  size="sm"
                  disabled={pending || !(mappingForm.name ?? '').trim() || !(mappingForm.employeeNameColumn ?? '').trim() || !(mappingForm.grossColumn ?? '').trim()}
                  onClick={() =>
                    run(
                      'Mapping saved.',
                      () =>
                        savePayrollMapping(entity.id, {
                          id: mappingForm.id || undefined,
                          name: mappingForm.name,
                          employeeRefColumn: mappingForm.employeeRefColumn,
                          employeeNameColumn: mappingForm.employeeNameColumn,
                          departmentColumn: mappingForm.departmentColumn,
                          grossColumn: mappingForm.grossColumn,
                          payeColumn: mappingForm.payeColumn,
                          employeeSsnitColumn: mappingForm.employeeSsnitColumn,
                          employerSsnitColumn: mappingForm.employerSsnitColumn,
                          ssnitTier2Column: mappingForm.ssnitTier2Column,
                          otherDeductionsColumn: mappingForm.otherDeductionsColumn,
                          netColumn: mappingForm.netColumn,
                          defaultAccountCode: mappingForm.defaultAccountCode,
                        }),
                      () => setMappingForm({ id: '', name: '', defaultAccountCode: '' }),
                    )
                  }
                >
                  Save
                </Button>
                {mappingForm.id ? (
                  <Button size="sm" variant="ghost" onClick={() => setMappingForm({ id: '', name: '', defaultAccountCode: '' })}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            </Card>
          ) : null}

          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Departments and their accounts</h3>
            <p className="mt-1 text-sm text-slate-600">Gross pay is charged to the account of the department the person is in.</p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-100">
                  {departments.map((row) => (
                    <tr key={row.id}>
                      <td className="py-2 text-slate-900">{row.name}</td>
                      <td className="py-2 text-slate-600">
                        {row.accountCode} {row.accountName}
                      </td>
                      <td className="py-2 text-right">
                        {allowed('document:post') ? (
                          <Button size="sm" variant="ghost" onClick={() => setDepartmentForm({ name: row.name, accountCode: row.accountCode })}>
                            Change
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {departments.length === 0 ? (
                    <tr>
                      <td className="py-2 text-slate-500">None yet — they appear as payroll is imported.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            {allowed('document:post') ? (
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <div>
                  <label className={label}>Department</label>
                  <Input value={departmentForm.name} onChange={(e) => setDepartmentForm((f) => ({ ...f, name: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Account</label>
                  <select className="min-h-[44px] rounded-lg border border-slate-200 bg-white px-3 text-sm" value={departmentForm.accountCode} onChange={(e) => setDepartmentForm((f) => ({ ...f, accountCode: e.target.value }))}>
                    <option value="">Choose…</option>
                    {expenseAccounts.map((account) => (
                      <option key={account.code} value={account.code}>
                        {account.code} {account.name}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  size="sm"
                  disabled={pending || !departmentForm.name.trim() || !departmentForm.accountCode}
                  onClick={() => run('Department saved.', () => savePayrollDepartment(entity.id, departmentForm.name, departmentForm.accountCode), () => setDepartmentForm({ name: '', accountCode: '' }))}
                >
                  Save
                </Button>
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}

      {/* --- the grant split ------------------------------------------------------- */}
      {tab === 'Grant split' ? (
        <div className="space-y-6">
          {activeGrants.length === 0 ? (
            <Card className="rounded-2xl">
              <p className="text-sm text-slate-600">
                {entity.name} has no active grants, so there is nothing to split staff costs across. Add a grant on the <span className="font-semibold">Grants</span> screen first.
              </p>
            </Card>
          ) : (
            <>
              <Card className="rounded-2xl">
                <h3 className="text-lg font-semibold text-slate-900">How each person&rsquo;s cost is split</h3>
                <p className="mt-1 text-sm text-slate-600">
                  Set once against the person and used by every payroll after it. Gross pay and the employer&rsquo;s SSNIT are both split, so a donor sees the whole cost. Anything under 100% is core-funded and stays uncoded.
                </p>
                <div className="mt-4 space-y-3">
                  {splitByPerson.map((person) => (
                    <div key={person.key} className="rounded-xl border border-slate-200 px-4 py-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="font-medium text-slate-900">
                          {person.name}
                          <span className="ml-2 font-mono text-xs text-slate-500">{person.key}</span>
                        </p>
                        <span className={['text-sm', person.total > 100 ? 'text-rose-700' : person.total === 100 ? 'text-emerald-700' : 'text-slate-600'].join(' ')}>{person.total}% allocated</span>
                      </div>
                      <table className="mt-2 w-full text-sm">
                        <tbody className="divide-y divide-slate-100">
                          {person.rows.map((row) => (
                            <tr key={row.id}>
                              <td className="py-1.5 text-slate-900">{row.grantCode}</td>
                              <td className="py-1.5 text-slate-600">{row.budgetLineName || 'no budget line'}</td>
                              <td className="py-1.5 text-right">{row.pct}%</td>
                              <td className="py-1.5 text-right">
                                {allowed('document:post') ? (
                                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => run('Removed.', () => removePayrollAllocation(entity.id, row.id))}>
                                    Remove
                                  </Button>
                                ) : null}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                  {splitByPerson.length === 0 ? <p className="text-sm text-slate-500">Nobody is split across grants yet.</p> : null}
                </div>
              </Card>

              {allowed('document:post') ? (
                <Card className="rounded-2xl">
                  <h3 className="text-lg font-semibold text-slate-900">Split someone&rsquo;s cost</h3>
                  <div className="mt-4 grid gap-4 md:grid-cols-4">
                    <div>
                      <label className={label}>Person</label>
                      {people.length ? (
                        <select
                          className={selectClass}
                          value={splitForm.employeeKey}
                          onChange={(e) => {
                            const person = people.find((row) => row.key === e.target.value);
                            setSplitForm((f) => ({ ...f, employeeKey: e.target.value, employeeName: person?.name ?? '' }));
                          }}
                        >
                          <option value="">Choose…</option>
                          {people.map((person) => (
                            <option key={person.key} value={person.key}>
                              {person.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Input value={splitForm.employeeKey} onChange={(e) => setSplitForm((f) => ({ ...f, employeeKey: e.target.value, employeeName: e.target.value }))} placeholder="Staff reference or name" />
                      )}
                      {people.length === 0 ? <p className="mt-1 text-xs text-slate-500">Import a payroll first and the names appear here.</p> : null}
                    </div>
                    <div>
                      <label className={label}>Grant</label>
                      <select className={selectClass} value={splitForm.grantId} onChange={(e) => setSplitForm((f) => ({ ...f, grantId: e.target.value, budgetLineId: '' }))}>
                        <option value="">Choose…</option>
                        {activeGrants.map((grant) => (
                          <option key={grant.id} value={grant.id}>
                            {grant.code} — {grant.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className={label}>Budget line</label>
                      <select className={selectClass} value={splitForm.budgetLineId} onChange={(e) => setSplitForm((f) => ({ ...f, budgetLineId: e.target.value }))}>
                        <option value="">None</option>
                        {(activeGrants.find((grant) => grant.id === splitForm.grantId)?.budgetLines ?? []).map((line) => (
                          <option key={line.id} value={line.id}>
                            {line.code} {line.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className={label}>Share of their cost, %</label>
                      <Input inputMode="decimal" value={splitForm.pct} onChange={(e) => setSplitForm((f) => ({ ...f, pct: e.target.value }))} placeholder="60" />
                    </div>
                  </div>
                  <div className="mt-4">
                    <Button
                      size="sm"
                      disabled={pending || !splitForm.employeeKey.trim() || !splitForm.grantId || !splitForm.pct}
                      onClick={() =>
                        run(
                          'Split saved.',
                          () => savePayrollAllocation(entity.id, { employeeKey: splitForm.employeeKey, employeeName: splitForm.employeeName, grantId: splitForm.grantId, budgetLineId: splitForm.budgetLineId || null, pct: splitForm.pct }),
                          () => setSplitForm((f) => ({ ...f, grantId: '', budgetLineId: '', pct: '' })),
                        )
                      }
                    >
                      Save
                    </Button>
                    <p className="mt-2 text-xs text-slate-500">It applies to every payroll imported after this, not to months already posted.</p>
                  </div>
                </Card>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
