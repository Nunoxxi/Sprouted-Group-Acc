'use client';

/**
 * Payroll → People: employees, their pay structure, how their cost is split
 * across projects, and staff loans with what is left to repay.
 */

import { useMemo, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { endAllowance, issueStaffLoan, saveAllowance, saveEmployee, setAllocations, type EmployeeInput } from '@/app/actions/payroll';
import { Banner, cedisOf, fieldLabel, minorOf, selectClass, todayIso } from '@/components/app/payroll-ui';
import type { Permission } from '@/lib/authz';
import type { EmployeeRecord, StaffLoanRecord } from '@/lib/data/payroll';
import type { AccountRecord, BankAccountRecord, EntityRecord, ProjectRecord } from '@/lib/data/types';
import type { BenefitKind } from '@/lib/payroll-engine';
import { allocationProblem, loanSchedule } from '@/lib/payroll-run';
import { periodLabel } from '@/lib/payslip';

type Props = {
  entity: EntityRecord;
  employees: EmployeeRecord[];
  loans: StaffLoanRecord[];
  accounts: AccountRecord[];
  projects: ProjectRecord[];
  bankAccounts: BankAccountRecord[];
  allowed: (permission: Permission) => boolean;
};

type Message = { tone: 'ok' | 'error'; text: string } | null;

const benefitLabels: Record<BenefitKind, string> = {
  vehicle: 'Vehicle',
  'vehicle-fuel': 'Vehicle with fuel',
  accommodation: 'Accommodation',
  'accommodation-furnished': 'Furnished accommodation',
};

type Form = {
  id?: string;
  staffNumber: string;
  name: string;
  email: string;
  tin: string;
  ssnitNumber: string;
  startDate: string;
  endDate: string;
  employmentType: EmployeeInput['employmentType'];
  residency: EmployeeInput['residency'];
  department: string;
  expenseAccountCode: string;
  payMethod: EmployeeInput['payMethod'];
  bankName: string;
  bankAccountNumber: string;
  momoNumber: string;
  basic: string;
  juniorStaffOvertime: boolean;
  tier3: string;
  vehicle: '' | 'vehicle' | 'vehicle-fuel';
  accommodation: '' | 'accommodation' | 'accommodation-furnished';
  marriage: boolean;
  children: string;
  aged: string;
  disability: boolean;
  oldAge: boolean;
};

function blankForm(defaultAccount: string): Form {
  return {
    staffNumber: '',
    name: '',
    email: '',
    tin: '',
    ssnitNumber: '',
    startDate: todayIso(),
    endDate: '',
    employmentType: 'permanent',
    residency: 'resident',
    department: '',
    expenseAccountCode: defaultAccount,
    payMethod: 'bank',
    bankName: '',
    bankAccountNumber: '',
    momoNumber: '',
    basic: '',
    juniorStaffOvertime: false,
    tier3: '',
    vehicle: '',
    accommodation: '',
    marriage: false,
    children: '0',
    aged: '0',
    disability: false,
    oldAge: false,
  };
}

/**
 * The form for an existing employee. The numbers that reach a person arrive
 * masked, so they start blank: leaving one blank on save would clear it,
 * which saveEmployee refuses for the account pay goes to — re-enter it to change it.
 */
function formOf(e: EmployeeRecord): Form {
  return {
    id: e.id,
    staffNumber: e.staffNumber,
    name: e.name,
    email: '',
    tin: '',
    ssnitNumber: '',
    startDate: e.startDate,
    endDate: e.endDate ?? '',
    employmentType: e.employmentType,
    residency: e.residency,
    department: e.department,
    expenseAccountCode: e.expenseAccountCode,
    payMethod: e.payMethod,
    bankName: e.bankName,
    bankAccountNumber: '',
    momoNumber: '',
    basic: cedisOf(e.basicMinor),
    juniorStaffOvertime: e.juniorStaffOvertime,
    tier3: e.tier3Minor ? cedisOf(e.tier3Minor) : '',
    vehicle: e.benefitsInKind.includes('vehicle-fuel') ? 'vehicle-fuel' : e.benefitsInKind.includes('vehicle') ? 'vehicle' : '',
    accommodation: e.benefitsInKind.includes('accommodation-furnished') ? 'accommodation-furnished' : e.benefitsInKind.includes('accommodation') ? 'accommodation' : '',
    marriage: e.reliefs.marriage,
    children: String(e.reliefs.childrenInEducation),
    aged: String(e.reliefs.agedDependants),
    disability: e.reliefs.disability,
    oldAge: e.reliefs.oldAge,
  };
}

export function PayrollPeople({ entity, employees, loans, accounts, projects, bankAccounts, allowed }: Props) {
  const may = allowed('payroll:prepare');
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  const costAccounts = useMemo(() => accounts.filter((a) => a.type === 'EXPENSE' || a.type === 'COST_OF_SALES'), [accounts]);
  const defaultAccount = costAccounts.find((a) => /salar/i.test(a.name))?.code ?? costAccounts[0]?.code ?? '';
  const [form, setForm] = useState<Form | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(employees[0]?.id ?? null);
  const selected = employees.find((e) => e.id === selectedId) ?? null;
  const openProjects = projects.filter((p) => p.isActive);

  function act(okText: string, action: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setMessage({ tone: 'ok', text: okText });
        after?.();
      } else setMessage({ tone: 'error', text: result.error });
    });
  }

  function save() {
    if (!form) return;
    const basicMinor = minorOf(form.basic);
    const tier3Minor = minorOf(form.tier3);
    if (Number.isNaN(basicMinor) || Number.isNaN(tier3Minor)) return setMessage({ tone: 'error', text: 'Amounts are in cedis, e.g. 4000.00.' });
    const existing = form.id ? employees.find((e) => e.id === form.id) : null;
    // A masked number left blank keeps what is held: it is sent only when re-entered.
    const keep = (typed: string, held: string | undefined) => (typed.trim() ? typed : held && existing ? undefined : null);
    const input: EmployeeInput = {
      id: form.id,
      staffNumber: form.staffNumber,
      name: form.name,
      email: keep(form.email, existing?.email),
      tin: keep(form.tin, existing?.tin),
      ssnitNumber: keep(form.ssnitNumber, existing?.ssnitNumber),
      startDate: form.startDate,
      endDate: form.endDate || null,
      employmentType: form.employmentType,
      residency: form.residency,
      department: form.department,
      expenseAccountCode: form.expenseAccountCode,
      payMethod: form.payMethod,
      bankName: form.bankName,
      bankAccountNumber: keep(form.bankAccountNumber, existing?.bankAccountNumber),
      momoNumber: keep(form.momoNumber, existing?.momoNumber),
      basicMinor,
      juniorStaffOvertime: form.juniorStaffOvertime,
      tier3Minor,
      benefitsInKind: [form.vehicle, form.accommodation].filter((b): b is BenefitKind => Boolean(b)),
      reliefs: { marriage: form.marriage, childrenInEducation: Number(form.children) || 0, agedDependants: Number(form.aged) || 0, disability: form.disability, oldAge: form.oldAge },
    };
    act(form.id ? 'Saved.' : `${form.name} added.`, () => saveEmployee(entity.id, input), () => setForm(null));
  }

  const field = (key: keyof Form, text: string, placeholder?: string, type = 'text') => (
    <div>
      <label className={fieldLabel} htmlFor={`emp-${key}`}>{text}</label>
      <Input id={`emp-${key}`} type={type} placeholder={placeholder} value={String(form?.[key] ?? '')} onChange={(e) => form && setForm({ ...form, [key]: e.target.value })} />
    </div>
  );

  return (
    <div className="space-y-5">
      <Banner message={message} />
      {may && !form ? <Button onClick={() => setForm(blankForm(defaultAccount))}>Add an employee</Button> : null}

      {form ? (
        <Card className="rounded-2xl">
          <h4 className="text-base font-semibold text-slate-900">{form.id ? `Edit ${form.name}` : 'New employee'}</h4>
          {form.id ? <p className="mt-1 text-xs text-slate-500">Numbers held about them are hidden; leave those boxes blank to keep what is held, or type a new one to replace it.</p> : null}
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {field('staffNumber', 'Staff number')}
            {field('name', 'Name')}
            {field('department', 'Department')}
            <div>
              <label className={fieldLabel} htmlFor="emp-account">Pay charged to</label>
              <select id="emp-account" className={selectClass} value={form.expenseAccountCode} onChange={(e) => setForm({ ...form, expenseAccountCode: e.target.value })}>
                {costAccounts.map((a) => (
                  <option key={a.code} value={a.code}>{a.code} · {a.name}</option>
                ))}
              </select>
            </div>
            {field('startDate', 'Started', undefined, 'date')}
            {field('endDate', 'Left (blank while employed)', undefined, 'date')}
            <div>
              <label className={fieldLabel} htmlFor="emp-type">Employed as</label>
              <select id="emp-type" className={selectClass} value={form.employmentType} onChange={(e) => setForm({ ...form, employmentType: e.target.value as Form['employmentType'] })}>
                <option value="permanent">Permanent</option>
                <option value="contract">Contract</option>
                <option value="casual">Casual (cannot be paid yet)</option>
              </select>
            </div>
            <div>
              <label className={fieldLabel} htmlFor="emp-res">Tax residency</label>
              <select id="emp-res" className={selectClass} value={form.residency} onChange={(e) => setForm({ ...form, residency: e.target.value as Form['residency'] })}>
                <option value="resident">Resident</option>
                <option value="non-resident">Non-resident</option>
              </select>
            </div>
            {field('tin', 'TIN', form.id ? 'hidden — blank keeps it' : '')}
            {field('ssnitNumber', 'SSNIT number', form.id ? 'hidden — blank keeps it' : '')}
            {field('email', 'Email for payslips', form.id ? 'hidden — blank keeps it' : '')}
            <div>
              <label className={fieldLabel} htmlFor="emp-method">Paid by</label>
              <select id="emp-method" className={selectClass} value={form.payMethod} onChange={(e) => setForm({ ...form, payMethod: e.target.value as Form['payMethod'] })}>
                <option value="bank">Bank transfer</option>
                <option value="mobile-money">Mobile money</option>
              </select>
            </div>
            {form.payMethod === 'bank' ? (
              <>
                {field('bankName', 'Bank')}
                {field('bankAccountNumber', 'Account number', form.id ? 'hidden — blank keeps it' : '')}
              </>
            ) : (
              field('momoNumber', 'Mobile money number', form.id ? 'hidden — blank keeps it' : '')
            )}
            {field('basic', 'Basic salary a month (GHS)')}
            {field('tier3', 'Tier 3 a month (GHS), if offered')}
            <div>
              <label className={fieldLabel} htmlFor="emp-vehicle">Vehicle</label>
              <select id="emp-vehicle" className={selectClass} value={form.vehicle} onChange={(e) => setForm({ ...form, vehicle: e.target.value as Form['vehicle'] })}>
                <option value="">None</option>
                <option value="vehicle">{benefitLabels.vehicle}</option>
                <option value="vehicle-fuel">{benefitLabels['vehicle-fuel']}</option>
              </select>
            </div>
            <div>
              <label className={fieldLabel} htmlFor="emp-accom">Accommodation</label>
              <select id="emp-accom" className={selectClass} value={form.accommodation} onChange={(e) => setForm({ ...form, accommodation: e.target.value as Form['accommodation'] })}>
                <option value="">None</option>
                <option value="accommodation">{benefitLabels.accommodation}</option>
                <option value="accommodation-furnished">{benefitLabels['accommodation-furnished']}</option>
              </select>
            </div>
          </div>
          <p className="mt-4 text-sm font-medium text-slate-900">Reliefs they have registered</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                ['marriage', 'Marriage or dependent spouse'],
                ['disability', 'Disability'],
                ['oldAge', 'Old age'],
                ['juniorStaffOvertime', 'Qualifying junior staff (overtime)'],
              ] as const
            ).map(([key, text]) => (
              <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} />
                {text}
              </label>
            ))}
            {field('children', 'Children in education')}
            {field('aged', 'Aged dependants')}
          </div>
          <div className="mt-4 flex gap-2">
            <Button size="sm" disabled={pending} onClick={save}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
        <Card className="rounded-2xl p-0">
          {employees.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No employees yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {employees.map((e) => (
                <li key={e.id}>
                  <button type="button" onClick={() => setSelectedId(e.id)} className={['w-full px-4 py-3 text-left', e.id === selectedId ? 'bg-brand-50' : 'hover:bg-slate-50'].join(' ')}>
                    <p className="font-medium text-slate-900">{e.name}</p>
                    <p className="text-xs text-slate-500">
                      {e.staffNumber}{e.department ? ` · ${e.department}` : ''}{e.endDate ? ` · left ${e.endDate}` : ''}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {selected ? (
          <EmployeeDetail
            key={selected.id}
            entity={entity}
            employee={selected}
            loans={loans.filter((l) => l.employeeId === selected.id)}
            projects={openProjects}
            allProjects={projects}
            bankAccounts={bankAccounts}
            allowed={allowed}
            pending={pending}
            act={act}
            onEdit={() => setForm(formOf(selected))}
          />
        ) : null}
      </div>
    </div>
  );
}

function EmployeeDetail({
  entity,
  employee,
  loans,
  projects,
  allProjects,
  bankAccounts,
  allowed,
  pending,
  act,
  onEdit,
}: {
  entity: EntityRecord;
  employee: EmployeeRecord;
  loans: StaffLoanRecord[];
  projects: ProjectRecord[];
  allProjects: ProjectRecord[];
  bankAccounts: BankAccountRecord[];
  allowed: (p: Permission) => boolean;
  pending: boolean;
  act: (okText: string, action: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) => void;
  onEdit: () => void;
}) {
  const may = allowed('payroll:prepare');
  const [allowance, setAllowance] = useState<{ id?: string; name: string; amount: string; taxable: boolean; pensionable: boolean } | null>(null);
  const [shares, setShares] = useState(employee.allocations.map((a) => ({ projectId: a.projectId, pct: (a.shareBasisPoints / 100).toString() })));
  const [loan, setLoan] = useState<{ kind: 'loan' | 'advance'; description: string; principal: string; instalment: string; issuedOn: string; firstPeriod: string; bankAccountId: string } | null>(null);
  const projectName = (id: string) => {
    const p = allProjects.find((project) => project.id === id);
    return p ? `${p.code} · ${p.name}` : id;
  };
  const shareBasisPoints = shares.map((s) => ({ projectId: s.projectId, shareBasisPoints: Math.round(Number(s.pct) * 100) }));
  const splitProblem = allocationProblem(shareBasisPoints);

  return (
    <div className="space-y-5">
      <Card className="rounded-2xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="text-lg font-semibold text-slate-900">{employee.name}</h4>
            <p className="text-sm text-slate-600">
              {employee.staffNumber} · {employee.employmentType} · {employee.residency} · from {employee.startDate}{employee.endDate ? ` to ${employee.endDate}` : ''}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              TIN {employee.tin || 'not held'} · SSNIT {employee.ssnitNumber || 'not held'} · paid by {employee.payMethod === 'bank' ? `${employee.bankName || 'bank'} ${employee.bankAccountNumber}` : `mobile money ${employee.momoNumber}`}
            </p>
            {employee.employmentType === 'casual' ? <p className="mt-1 text-xs font-semibold text-amber-800">Casual workers cannot be paid through payroll until their SSNIT and tax treatment is confirmed.</p> : null}
          </div>
          {may ? <Button size="sm" variant="secondary" onClick={onEdit}>Edit</Button> : null}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl bg-slate-50 px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Basic a month (pensionable)</p>
            <p className="mt-1 text-lg font-semibold tabular-nums"><Money value={employee.basicMinor} /></p>
          </div>
          <div className="rounded-xl bg-slate-50 px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Allowances a month</p>
            <p className="mt-1 text-lg font-semibold tabular-nums"><Money value={employee.allowances.reduce((s, a) => s + a.amountMinor, 0)} /></p>
          </div>
          <div className="rounded-xl bg-slate-50 px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Tier 3 a month</p>
            <p className="mt-1 text-lg font-semibold tabular-nums"><Money value={employee.tier3Minor} /></p>
          </div>
        </div>
      </Card>

      <Card className="rounded-2xl">
        <h4 className="text-base font-semibold text-slate-900">Allowances</h4>
        <p className="mt-1 text-sm text-slate-600">Each is taxable or not, and pensionable or not. Pensionable puts it in the SSNIT base with basic salary; that is off unless their contract says so.</p>
        <table className="mt-3 w-full text-sm">
          <tbody className="divide-y divide-slate-100">
            {employee.allowances.map((a) => (
              <tr key={a.id}>
                <td className="py-2 pr-3">{a.name}</td>
                <td className="py-2 pr-3 text-xs text-slate-500">{a.taxable ? 'Taxable' : 'Not taxable'} · {a.pensionable ? 'Pensionable' : 'Not pensionable'}</td>
                <td className="py-2 pr-3 text-right tabular-nums"><Money value={a.amountMinor} /></td>
                <td className="py-2 text-right">
                  {may ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setAllowance({ id: a.id, name: a.name, amount: cedisOf(a.amountMinor), taxable: a.taxable, pensionable: a.pensionable })}>Change</Button>
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(`${a.name} taken off their pay.`, () => endAllowance(entity.id, a.id))}>Stop it</Button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
            {employee.allowances.length === 0 ? (
              <tr>
                <td className="py-2 text-slate-500">None.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {may && !allowance ? <Button size="sm" variant="secondary" className="mt-3" onClick={() => setAllowance({ name: '', amount: '', taxable: true, pensionable: false })}>Add an allowance</Button> : null}
        {allowance ? (
          <div className="mt-3 grid gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-4">
            <div>
              <label className={fieldLabel} htmlFor="al-name">Name</label>
              <Input id="al-name" value={allowance.name} onChange={(e) => setAllowance({ ...allowance, name: e.target.value })} />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="al-amount">A month (GHS)</label>
              <Input id="al-amount" inputMode="decimal" value={allowance.amount} onChange={(e) => setAllowance({ ...allowance, amount: e.target.value })} />
            </div>
            <div className="flex flex-col justify-end gap-1 text-sm text-slate-700">
              <label className="flex items-center gap-2"><input type="checkbox" checked={allowance.taxable} onChange={(e) => setAllowance({ ...allowance, taxable: e.target.checked })} /> Taxable</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={allowance.pensionable} onChange={(e) => setAllowance({ ...allowance, pensionable: e.target.checked })} /> Pensionable</label>
            </div>
            <div className="flex items-end gap-2">
              <Button
                size="sm"
                disabled={pending}
                onClick={() => {
                  const amountMinor = minorOf(allowance.amount);
                  act('Allowance saved.', () => saveAllowance(entity.id, { employeeId: employee.id, id: allowance.id, name: allowance.name, amountMinor, taxable: allowance.taxable, pensionable: allowance.pensionable }), () => setAllowance(null));
                }}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAllowance(null)}>Cancel</Button>
            </div>
          </div>
        ) : null}
      </Card>

      <Card className="rounded-2xl">
        <h4 className="text-base font-semibold text-slate-900">Cost split across projects</h4>
        <p className="mt-1 text-sm text-slate-600">
          Gross pay and the employer’s contributions are charged to each project by its share, so the cost reaches the project’s budget against actual. The shares add up to 100%, or there is
          no split.
        </p>
        <div className="mt-3 space-y-2">
          {shares.map((share, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px_auto]">
              <select className={selectClass} value={share.projectId} disabled={!may} onChange={(e) => setShares(shares.map((s, i) => (i === index ? { ...s, projectId: e.target.value } : s)))}>
                {!projects.some((p) => p.id === share.projectId) ? <option value={share.projectId}>{projectName(share.projectId)}</option> : null}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
                ))}
              </select>
              <Input inputMode="decimal" value={share.pct} disabled={!may} onChange={(e) => setShares(shares.map((s, i) => (i === index ? { ...s, pct: e.target.value } : s)))} />
              {may ? <Button size="sm" variant="ghost" onClick={() => setShares(shares.filter((_, i) => i !== index))}>Remove</Button> : null}
            </div>
          ))}
          {shares.length === 0 ? <p className="text-sm text-slate-500">Not split: the whole cost is charged without a project.</p> : null}
        </div>
        {splitProblem && shares.length ? <p className="mt-2 text-sm text-amber-800">{splitProblem}</p> : null}
        {may ? (
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="secondary" disabled={projects.length === 0} onClick={() => setShares([...shares, { projectId: projects[0]?.id ?? '', pct: '' }])}>Add a project</Button>
            <Button size="sm" disabled={pending || Boolean(splitProblem && shares.length)} onClick={() => act('Split saved. It applies from the next pay run worked out.', () => setAllocations(entity.id, employee.id, shareBasisPoints))}>Save the split</Button>
          </div>
        ) : null}
      </Card>

      <Card className="rounded-2xl">
        <h4 className="text-base font-semibold text-slate-900">Loans and advances</h4>
        {loans.length === 0 ? <p className="mt-2 text-sm text-slate-500">None.</p> : null}
        {loans.map((l) => (
          <div key={l.id} className="mt-3 rounded-xl border border-slate-200 p-3">
            <div className="flex flex-wrap justify-between gap-2 text-sm">
              <span className="font-medium text-slate-900">{l.description} <span className="text-xs text-slate-500">({l.kind}, {l.issuedOn})</span></span>
              <span>
                <Money value={l.outstandingMinor} /> left of <Money value={l.principalMinor} />
              </span>
            </div>
            {l.outstandingMinor > 0 ? (
              <p className="mt-1 text-xs text-slate-500">
                {cedisOf(l.instalmentMinor)} a month. Still to come:{' '}
                {loanSchedule(l.outstandingMinor, l.instalmentMinor, l.repayments.length ? nextPeriod(l.repayments[l.repayments.length - 1].period) : l.firstPeriod)
                  .map((row) => `${periodLabel(row.period)} ${cedisOf(row.amountMinor)}`)
                  .join(' · ')}
              </p>
            ) : (
              <p className="mt-1 text-xs text-green-700">Repaid.</p>
            )}
          </div>
        ))}
        {allowed('payroll:post') && !loan ? (
          <Button size="sm" variant="secondary" className="mt-3" onClick={() => setLoan({ kind: 'loan', description: '', principal: '', instalment: '', issuedOn: todayIso(), firstPeriod: todayIso().slice(0, 7), bankAccountId: bankAccounts[0]?.id ?? '' })}>
            Lend or advance
          </Button>
        ) : null}
        {loan ? (
          <div className="mt-3 grid gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-4">
            <div>
              <label className={fieldLabel} htmlFor="ln-kind">Kind</label>
              <select id="ln-kind" className={selectClass} value={loan.kind} onChange={(e) => setLoan({ ...loan, kind: e.target.value as 'loan' | 'advance' })}>
                <option value="loan">Loan</option>
                <option value="advance">Salary advance</option>
              </select>
            </div>
            <div>
              <label className={fieldLabel} htmlFor="ln-desc">What for</label>
              <Input id="ln-desc" value={loan.description} onChange={(e) => setLoan({ ...loan, description: e.target.value })} />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="ln-amount">Amount (GHS)</label>
              <Input id="ln-amount" inputMode="decimal" value={loan.principal} onChange={(e) => setLoan({ ...loan, principal: e.target.value })} />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="ln-inst">Taken from pay each month (GHS)</label>
              <Input id="ln-inst" inputMode="decimal" value={loan.instalment} onChange={(e) => setLoan({ ...loan, instalment: e.target.value })} />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="ln-date">Paid out on</label>
              <Input id="ln-date" type="date" value={loan.issuedOn} onChange={(e) => setLoan({ ...loan, issuedOn: e.target.value })} />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="ln-first">First taken from the pay of</label>
              <Input id="ln-first" type="month" value={loan.firstPeriod} onChange={(e) => setLoan({ ...loan, firstPeriod: e.target.value })} />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="ln-bank">Paid from</label>
              <select id="ln-bank" className={selectClass} value={loan.bankAccountId} onChange={(e) => setLoan({ ...loan, bankAccountId: e.target.value })}>
                {bankAccounts.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end gap-2">
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  act(
                    'Recorded, and the money paid out posted.',
                    () => issueStaffLoan(entity.id, { employeeId: employee.id, kind: loan.kind, description: loan.description, principalMinor: minorOf(loan.principal), instalmentMinor: minorOf(loan.instalment), issuedOn: loan.issuedOn, firstPeriod: loan.firstPeriod, bankAccountId: loan.bankAccountId }),
                    () => setLoan(null),
                  )
                }
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setLoan(null)}>Cancel</Button>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function nextPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
