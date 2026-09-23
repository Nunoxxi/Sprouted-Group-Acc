'use client';

/**
 * The Settings screens other than the chart of accounts: projects and their
 * budgets, funds, contacts, this company's own details, fixed asset classes
 * and the tax rates.
 *
 * Wherever a change would reach something already reported, the screen asks
 * the server what it would do and shows that before saving, rather than
 * saving and letting somebody find out from a report later.
 */

import { useMemo, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import {
  deleteProject,
  removeAssetCategory,
  removeProjectBudgetLine,
  resetTaxRates,
  reviseProjectBudgetLine,
  saveAssetCategory,
  saveProjectBudgetLine,
  saveFund,
  saveProject,
  saveTaxRates,
  setContactActive,
  setFundActive,
  setProjectClosed,
  updateContact,
  updateEntity,
} from '@/app/actions/settings';
import type { Permission } from '@/lib/authz';
import { currencies, type Currency } from '@/lib/fx';
import {
  budgetTotals,
  compareBudget,
  depreciationMethodLabels,
  depreciationMethods,
  lifeMonthsFromRate,
  projectKindLabels,
  projectKinds,
  statutoryTaxRates,
  type DepreciationMethod,
  type ProjectKind,
  type TaxRates,
} from '@/lib/settings';
import type {
  AssetCategoryRecord,
  ContactRecord,
  EntityRecord,
  FundRecord,
  ProjectBudgetLineRecord,
  ProjectRecord,
} from '@/lib/data/types';

const label = 'mb-1.5 block text-sm font-medium text-slate-700';
const select = 'min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 disabled:bg-slate-50';
const cedis = (minor: number) => (minor / 100).toFixed(2);

type Message = { tone: 'ok' | 'error'; text: string } | null;

function Banner({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <div className={['rounded-xl border px-4 py-3 text-sm', message.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'].join(' ')}>
      {message.text}
    </div>
  );
}

function Confirm({ note, onConfirm, onCancel, pending }: { note: string; onConfirm: () => void; onCancel: () => void; pending: boolean }) {
  return (
    <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
      <p className="text-sm font-medium text-amber-900">Before you save</p>
      <p className="mt-1 text-sm text-amber-900">{note}</p>
      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={pending} onClick={onConfirm}>I understand — save it</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Go back</Button>
      </div>
    </div>
  );
}

// --- projects ------------------------------------------------------------------------------------

const blankProject = { id: '', code: '', name: '', kind: 'grant-funded' as ProjectKind, currency: 'GHS' as Currency, funding: '', startDate: '', endDate: '', fundCode: '', funderContactId: '' };

export function ProjectsSettings({
  entity, projects, funds, contacts, budgetLines, accountCodes, allowed,
}: {
  entity: EntityRecord;
  projects: ProjectRecord[];
  funds: FundRecord[];
  contacts: ContactRecord[];
  budgetLines: ProjectBudgetLineRecord[];
  accountCodes: { code: string; name: string }[];
  allowed: (permission: Permission) => boolean;
}) {
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState(blankProject);
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [lineForm, setLineForm] = useState({ name: '', amount: '', accountCode: '' });
  const [revising, setRevising] = useState<{ id: string; amount: string; note: string | null } | null>(null);
  const may = allowed('settings:manage');

  const linesFor = (projectId: string) => budgetLines.filter((line) => line.projectId === projectId);

  function run(okText: string, action: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) { setMessage({ tone: 'ok', text: okText }); after?.(); }
      else setMessage({ tone: 'error', text: result.error ?? 'Something went wrong.' });
    });
  }

  function revise(lineId: string, amountMinor: number, acknowledged: boolean) {
    setMessage(null);
    startTransition(async () => {
      const result = await reviseProjectBudgetLine(entity.id, lineId, amountMinor, acknowledged);
      if (!result.ok) { setMessage({ tone: 'error', text: result.error }); return; }
      if (result.value.warning && !acknowledged) { setRevising({ id: lineId, amount: cedis(amountMinor), note: result.value.warning }); return; }
      setMessage({ tone: 'ok', text: 'Budget revised. The figure first agreed is kept.' });
      setRevising(null);
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{entity.name}</p>
        <h3 className="mt-1 text-xl font-semibold text-slate-900">Projects</h3>
        <p className="mt-1 text-sm text-slate-600">
          A closed project leaves the coding lists and stays in every report. Budget lines keep the figure first agreed, so a report can show both.
        </p>
      </div>

      <Banner message={message} />

      {may ? (
        <Card className="rounded-2xl">
          <h4 className="text-base font-semibold text-slate-900">{form.id ? `Project ${form.code}` : 'New project'}</h4>
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div>
              <label className={label} htmlFor="p-code">Code</label>
              <Input id="p-code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="PROJ-HRC" />
            </div>
            <div>
              <label className={label} htmlFor="p-name">Name</label>
              <Input id="p-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="p-kind">How it is paid for</label>
              <select id="p-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ProjectKind })} className={select}>
                {projectKinds.map((kind) => <option key={kind} value={kind}>{projectKindLabels[kind]}</option>)}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="p-funder">Funder</label>
              <select id="p-funder" value={form.funderContactId} onChange={(e) => setForm({ ...form, funderContactId: e.target.value })} className={select}>
                <option value="">Not set</option>
                {contacts.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="p-currency">Currency of the award</label>
              <select id="p-currency" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value as Currency })} className={select}>
                {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="p-funding">Amount funded</label>
              <Input id="p-funding" inputMode="decimal" value={form.funding} onChange={(e) => setForm({ ...form, funding: e.target.value })} placeholder="0.00" />
            </div>
            <div>
              <label className={label} htmlFor="p-fund">Fund it belongs to</label>
              <select id="p-fund" value={form.fundCode} onChange={(e) => setForm({ ...form, fundCode: e.target.value })} className={select}>
                <option value="">Not set</option>
                {funds.filter((f) => f.isActive).map((f) => <option key={f.id} value={f.code}>{f.code} {f.name}</option>)}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="p-start">Starts</label>
              <Input id="p-start" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="p-end">Ends</label>
              <Input id="p-end" type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={pending || !form.code.trim() || !form.name.trim()}
              onClick={() => run(form.id ? 'Project saved.' : 'Project added.', () => saveProject(entity.id, {
                id: form.id || undefined,
                code: form.code,
                name: form.name,
                kind: form.kind,
                currency: form.currency,
                fundingMinor: Math.round(Number(form.funding || 0) * 100),
                startDate: form.startDate || null,
                endDate: form.endDate || null,
                fundCode: form.fundCode || null,
                funderContactId: form.funderContactId || null,
              }), () => setForm(blankProject))}
            >
              {form.id ? 'Save changes' : 'Add project'}
            </Button>
            {form.id ? <Button size="sm" variant="ghost" onClick={() => setForm(blankProject)}>Cancel</Button> : null}
          </div>
        </Card>
      ) : null}

      <Card className="rounded-2xl">
        <h4 className="text-base font-semibold text-slate-900">All projects</h4>
        <ul className="mt-4 divide-y divide-slate-100">
          {projects.map((project) => {
            const lines = linesFor(project.id);
            const totals = budgetTotals(lines.map((l) => ({ id: l.id, name: l.name, originalMinor: l.originalMinor, revisedMinor: l.revisedMinor })));
            const closed = !!project.closedAt;
            return (
              <li key={project.id} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className={['font-medium', closed ? 'text-slate-400' : 'text-slate-900'].join(' ')}>
                      {project.code} · {project.name}{closed ? ' (closed)' : ''}
                    </p>
                    <p className="text-xs text-slate-500">
                      {projectKindLabels[project.kind]}
                      {project.fundingMinor ? ` · ${project.currency} ${cedis(project.fundingMinor)}` : ''}
                      {project.startDate ? ` · ${project.startDate}${project.endDate ? ` to ${project.endDate}` : ''}` : ''}
                      {lines.length ? ` · budget ${cedis(totals.originalMinor)} agreed` : ''}
                      {totals.revisedLines ? `, ${cedis(totals.currentMinor)} revised` : ''}
                    </p>
                  </div>
                  {may ? (
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setOpenProject(openProject === project.id ? null : project.id)}>
                        {openProject === project.id ? 'Hide budget' : 'Budget'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setForm({
                        id: project.id, code: project.code, name: project.name, kind: project.kind, currency: project.currency,
                        funding: project.fundingMinor ? cedis(project.fundingMinor) : '',
                        startDate: project.startDate ?? '', endDate: project.endDate ?? '',
                        fundCode: funds.find((f) => f.id === project.fundId)?.code ?? '',
                        funderContactId: project.funderContactId ?? '',
                      })}>Edit</Button>
                      <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(closed ? 'Project reopened.' : 'Project closed.', () => setProjectClosed(entity.id, project.id, !closed))}>
                        {closed ? 'Reopen' : 'Close'}
                      </Button>
                      <Button size="sm" variant="danger" disabled={pending} onClick={() => run('Project deleted.', () => deleteProject(entity.id, project.id))}>Delete</Button>
                    </div>
                  ) : null}
                </div>

                {openProject === project.id ? (
                  <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <p className="text-sm font-medium text-slate-900">Budget lines</p>
                    {lines.length === 0 ? (
                      <p className="mt-1 text-sm text-slate-500">Nothing budgeted yet.</p>
                    ) : (
                      <table className="mt-2 w-full text-left text-sm">
                        <thead>
                          <tr className="text-xs uppercase tracking-wide text-slate-500">
                            <th className="py-1 pr-3 font-medium">Line</th>
                            <th className="py-1 pr-3 text-right font-medium">As agreed</th>
                            <th className="py-1 pr-3 text-right font-medium">As it stands</th>
                            <th className="py-1 pr-3 text-right font-medium">Movement</th>
                            <th className="py-1 font-medium" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200">
                          {compareBudget(lines.map((l) => ({ id: l.id, name: l.name, originalMinor: l.originalMinor, revisedMinor: l.revisedMinor }))).map((row, index) => (
                            <tr key={lines[index].id}>
                              <td className="py-1.5 pr-3 text-slate-900">{row.name}</td>
                              <td className="py-1.5 pr-3 text-right"><Money value={row.originalMinor} /></td>
                              <td className="py-1.5 pr-3 text-right"><Money value={row.currentMinor} className={row.revised ? 'font-medium text-brand-700' : ''} /></td>
                              <td className="py-1.5 pr-3 text-right">{row.movementMinor === 0 ? '—' : <Money value={row.movementMinor} className={row.movementMinor > 0 ? 'text-emerald-700' : 'text-rose-700'} />}</td>
                              <td className="py-1.5 text-right">
                                <input
                                  className="w-24 rounded border border-slate-300 px-1.5 py-0.5 text-right text-xs"
                                  placeholder="Revise to"
                                  inputMode="decimal"
                                  onKeyDown={(e) => {
                                    if (e.key !== 'Enter') return;
                                    const value = Math.round(Number((e.target as HTMLInputElement).value || 0) * 100);
                                    if (value > 0) revise(lines[index].id, value, false);
                                  }}
                                />
                                <Button size="sm" variant="ghost" disabled={pending} onClick={() => run('Budget line removed.', () => removeProjectBudgetLine(entity.id, lines[index].id))}>Remove</Button>
                              </td>
                            </tr>
                          ))}
                          <tr className="font-medium">
                            <td className="py-1.5 pr-3">Total</td>
                            <td className="py-1.5 pr-3 text-right"><Money value={totals.originalMinor} /></td>
                            <td className="py-1.5 pr-3 text-right"><Money value={totals.currentMinor} /></td>
                            <td className="py-1.5 pr-3 text-right">{totals.movementMinor === 0 ? '—' : <Money value={totals.movementMinor} />}</td>
                            <td />
                          </tr>
                        </tbody>
                      </table>
                    )}

                    {revising ? <Confirm note={revising.note ?? ''} pending={pending} onConfirm={() => revise(revising.id, Math.round(Number(revising.amount) * 100), true)} onCancel={() => setRevising(null)} /> : null}

                    <div className="mt-4 flex flex-wrap items-end gap-3">
                      <div className="min-w-[12rem] flex-1">
                        <label className={label} htmlFor="bl-name">New line</label>
                        <Input id="bl-name" value={lineForm.name} onChange={(e) => setLineForm({ ...lineForm, name: e.target.value })} placeholder="Training" />
                      </div>
                      <div className="w-32">
                        <label className={label} htmlFor="bl-amount">Amount</label>
                        <Input id="bl-amount" inputMode="decimal" value={lineForm.amount} onChange={(e) => setLineForm({ ...lineForm, amount: e.target.value })} placeholder="0.00" />
                      </div>
                      <div className="w-56">
                        <label className={label} htmlFor="bl-account">Spent through</label>
                        <select id="bl-account" value={lineForm.accountCode} onChange={(e) => setLineForm({ ...lineForm, accountCode: e.target.value })} className={select}>
                          <option value="">Any account</option>
                          {accountCodes.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                        </select>
                      </div>
                      <Button
                        size="sm"
                        disabled={pending || !lineForm.name.trim()}
                        onClick={() => run('Budget line added.', () => saveProjectBudgetLine(entity.id, {
                          projectId: project.id,
                          name: lineForm.name,
                          amountMinor: Math.round(Number(lineForm.amount || 0) * 100),
                          accountCode: lineForm.accountCode || null,
                        }), () => setLineForm({ name: '', amount: '', accountCode: '' }))}
                      >
                        Add line
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

// --- funds ---------------------------------------------------------------------------------------

export function FundsSettings({ entity, funds, allowed }: { entity: EntityRecord; funds: FundRecord[]; allowed: (p: Permission) => boolean }) {
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({ id: '', code: '', name: '', classification: 'restricted' as 'restricted' | 'unrestricted', funder: '' });
  const [warning, setWarning] = useState<string | null>(null);
  const may = allowed('settings:manage');

  function save(acknowledged: boolean) {
    setMessage(null);
    startTransition(async () => {
      const result = await saveFund(entity.id, { id: form.id || undefined, code: form.code, name: form.name, classification: form.classification, funder: form.funder }, acknowledged);
      if (!result.ok) { setMessage({ tone: 'error', text: result.error }); return; }
      if (result.value.warning && !acknowledged) { setWarning(result.value.warning); return; }
      setMessage({ tone: 'ok', text: form.id ? 'Fund saved.' : 'Fund added.' });
      setForm({ id: '', code: '', name: '', classification: 'restricted', funder: '' });
      setWarning(null);
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{entity.name}</p>
        <h3 className="mt-1 text-xl font-semibold text-slate-900">Funds</h3>
        <p className="mt-1 text-sm text-slate-600">Restriction is a property of the fund. Moving a fund between restricted and unrestricted moves everything that went through it.</p>
      </div>

      <Banner message={message} />

      {may ? (
        <Card className="rounded-2xl">
          <h4 className="text-base font-semibold text-slate-900">{form.id ? `Fund ${form.code}` : 'New fund'}</h4>
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div>
              <label className={label} htmlFor="f-code">Code</label>
              <Input id="f-code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="FUND-HRC" />
            </div>
            <div>
              <label className={label} htmlFor="f-name">Name</label>
              <Input id="f-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="f-class">Restriction</label>
              <select id="f-class" value={form.classification} onChange={(e) => setForm({ ...form, classification: e.target.value as 'restricted' | 'unrestricted' })} className={select}>
                <option value="restricted">Restricted — only for what the funder agreed</option>
                <option value="unrestricted">Unrestricted — ours to use</option>
              </select>
            </div>
            <div>
              <label className={label} htmlFor="f-funder">Funder</label>
              <Input id="f-funder" value={form.funder} onChange={(e) => setForm({ ...form, funder: e.target.value })} placeholder="Optional" />
            </div>
          </div>
          {warning ? <Confirm note={warning} pending={pending} onConfirm={() => save(true)} onCancel={() => setWarning(null)} /> : (
            <div className="mt-4 flex gap-2">
              <Button size="sm" disabled={pending || !form.code.trim() || !form.name.trim()} onClick={() => save(false)}>{form.id ? 'Save changes' : 'Add fund'}</Button>
              {form.id ? <Button size="sm" variant="ghost" onClick={() => setForm({ id: '', code: '', name: '', classification: 'restricted', funder: '' })}>Cancel</Button> : null}
            </div>
          )}
        </Card>
      ) : null}

      <Card className="rounded-2xl">
        <ul className="divide-y divide-slate-100">
          {funds.map((fund) => (
            <li key={fund.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <p className={['font-medium', fund.isActive ? 'text-slate-900' : 'text-slate-400'].join(' ')}>{fund.code} · {fund.name}{fund.isActive ? '' : ' (closed)'}</p>
                <p className="text-xs text-slate-500">{fund.classification === 'restricted' ? 'Restricted' : 'Unrestricted'}{fund.funder ? ` · ${fund.funder}` : ''}</p>
              </div>
              {may ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setForm({ id: fund.id, code: fund.code, name: fund.name, classification: fund.classification, funder: fund.funder ?? '' })}>Edit</Button>
                  <Button size="sm" variant="secondary" disabled={pending} onClick={() => {
                    setMessage(null);
                    startTransition(async () => {
                      const result = await setFundActive(entity.id, fund.id, !fund.isActive);
                      setMessage(result.ok ? { tone: 'ok', text: fund.isActive ? 'Fund closed.' : 'Fund reopened.' } : { tone: 'error', text: result.error });
                    });
                  }}>{fund.isActive ? 'Close' : 'Reopen'}</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

// --- contacts -------------------------------------------------------------------------------------

export function ContactsSettings({ entity, contacts, allowed }: { entity: EntityRecord; contacts: ContactRecord[]; allowed: (p: Permission) => boolean }) {
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState<ContactRecord | null>(null);
  const [filter, setFilter] = useState('');
  const mayEdit = allowed('contact:create');
  const mayDeactivate = allowed('settings:manage');

  const rows = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return contacts.filter((c) => !term || c.name.toLowerCase().includes(term));
  }, [contacts, filter]);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Shared across the group</p>
        <h3 className="mt-1 text-xl font-semibold text-slate-900">Contacts and funders</h3>
        <p className="mt-1 text-sm text-slate-600">
          Contacts are shared by all three companies, so a correction here is a correction everywhere. Telephone numbers and the rest are hidden until asked for.
        </p>
      </div>

      <Banner message={message} />

      {form && mayEdit ? (
        <Card className="rounded-2xl">
          <h4 className="text-base font-semibold text-slate-900">{form.name}</h4>
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div>
              <label className={label} htmlFor="c-name">Name</label>
              <Input id="c-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="c-tin">TIN</label>
              <Input id="c-tin" value={form.tin} onChange={(e) => setForm({ ...form, tin: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="c-type">Type</label>
              <select id="c-type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ContactRecord['type'] })} className={select}>
                <option value="customer">Customer</option>
                <option value="supplier">Supplier</option>
                <option value="both">Both</option>
              </select>
            </div>
            <div>
              <label className={label} htmlFor="c-category">Category</label>
              <select id="c-category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as ContactRecord['category'] })} className={select}>
                <option value="customer">Customer</option>
                <option value="supplier">Supplier</option>
                <option value="farmer">Farmer</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className={label} htmlFor="c-phone">Phone</label>
              <Input id="c-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Type to replace" />
            </div>
            <div>
              <label className={label} htmlFor="c-email">Email</label>
              <Input id="c-email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="c-address">Address</label>
              <Input id="c-address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="c-wht">Withholding tax</label>
              <select id="c-wht" value={form.withholdingTaxStatus} onChange={(e) => setForm({ ...form, withholdingTaxStatus: e.target.value as ContactRecord['withholdingTaxStatus'] })} className={select}>
                <option value="none">None</option>
                <option value="5%">5%</option>
                <option value="10%">10%</option>
                <option value="exempt">Exempt</option>
              </select>
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            The telephone number, email and address show masked. Typing over one replaces it; leaving the dots as they are writes the dots, so clear the box first if you mean to empty it.
          </p>
          <div className="mt-4 flex gap-2">
            <Button size="sm" disabled={pending || !form.name.trim()} onClick={() => {
              setMessage(null);
              startTransition(async () => {
                const result = await updateContact(entity.id, {
                  id: form.id, name: form.name, type: form.type, category: form.category === 'group-entity' ? 'other' : form.category,
                  tin: form.tin, phone: form.phone, email: form.email, address: form.address, withholdingTaxStatus: form.withholdingTaxStatus,
                });
                if (result.ok) { setMessage({ tone: 'ok', text: 'Contact saved.' }); setForm(null); }
                else setMessage({ tone: 'error', text: result.error });
              });
            }}>Save changes</Button>
            <Button size="sm" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
          </div>
        </Card>
      ) : null}

      <Card className="rounded-2xl">
        <div className="max-w-sm">
          <label className={label} htmlFor="c-filter">Find a contact</label>
          <Input id="c-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name" />
        </div>
        <ul className="mt-4 divide-y divide-slate-100">
          {rows.map((contact) => (
            <li key={contact.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <p className={['font-medium', contact.isActive ? 'text-slate-900' : 'text-slate-400'].join(' ')}>{contact.name}{contact.isActive ? '' : ' (off)'}</p>
                <p className="text-xs text-slate-500">{contact.category} · {contact.type} · WHT {contact.withholdingTaxStatus}{contact.tin ? ` · ${contact.tin}` : ''}</p>
              </div>
              <div className="flex gap-2">
                {mayEdit ? <Button size="sm" variant="ghost" onClick={() => setForm(contact)}>Edit</Button> : null}
                {mayDeactivate && contact.category !== 'group-entity' ? (
                  <Button size="sm" variant="secondary" disabled={pending} onClick={() => {
                    setMessage(null);
                    startTransition(async () => {
                      const result = await setContactActive(entity.id, contact.id, !contact.isActive);
                      setMessage(result.ok ? { tone: 'ok', text: contact.isActive ? 'Contact switched off.' : 'Contact switched on.' } : { tone: 'error', text: result.error });
                    });
                  }}>{contact.isActive ? 'Switch off' : 'Switch on'}</Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

// --- this company ----------------------------------------------------------------------------------

export function CompanySettings({ entity, allowed }: { entity: EntityRecord; allowed: (p: Permission) => boolean }) {
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({ name: entity.name, tin: entity.tin ?? '', financialYearEnd: entity.financialYearEnd ?? '' });
  const may = allowed('settings:manage');

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">This company</p>
        <h3 className="mt-1 text-xl font-semibold text-slate-900">{entity.name}</h3>
      </div>

      <Banner message={message} />

      <Card className="rounded-2xl">
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label className={label} htmlFor="e-name">Name</label>
            <Input id="e-name" value={form.name} disabled={!may} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className={label} htmlFor="e-tin">TIN</label>
            <Input id="e-tin" value={form.tin} disabled={!may} onChange={(e) => setForm({ ...form, tin: e.target.value })} />
          </div>
          <div>
            <label className={label} htmlFor="e-ye">Financial year ends</label>
            <Input id="e-ye" value={form.financialYearEnd} disabled={!may} onChange={(e) => setForm({ ...form, financialYearEnd: e.target.value })} placeholder="30 Sep" />
          </div>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          What kind of company this is — a programme or a trading company — is not editable. It decides which chart of accounts and which screens it gets, and
          changing it once the books are running would leave the accounts it has and the accounts its type expects out of step.
        </p>
        {may ? (
          <div className="mt-4">
            <Button size="sm" disabled={pending || !form.name.trim()} onClick={() => {
              setMessage(null);
              startTransition(async () => {
                const result = await updateEntity(entity.id, form);
                setMessage(result.ok ? { tone: 'ok', text: 'Company details saved.' } : { tone: 'error', text: result.error });
              });
            }}>Save changes</Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

// --- fixed asset classes ------------------------------------------------------------------------------

export function AssetClassSettings({ entity, categories, accountCodes, allowed }: {
  entity: EntityRecord;
  categories: AssetCategoryRecord[];
  accountCodes: { code: string; name: string }[];
  allowed: (p: Permission) => boolean;
}) {
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({ id: '', name: '', ratePct: '', method: 'straight-line' as DepreciationMethod, accountCode: '' });
  const may = allowed('settings:manage');

  function run(okText: string, action: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) { setMessage({ tone: 'ok', text: okText }); after?.(); }
      else setMessage({ tone: 'error', text: result.error ?? 'Something went wrong.' });
    });
  }

  const life = lifeMonthsFromRate(Number(form.ratePct || 0));

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{entity.name}</p>
        <h3 className="mt-1 text-xl font-semibold text-slate-900">Fixed asset classes</h3>
        <p className="mt-1 text-sm text-slate-600">
          What each kind of asset depreciates at, so adding one does not mean remembering the rate. An asset keeps whatever terms it was given, so changing a
          rate here never restates anything already depreciated.
        </p>
      </div>

      <Banner message={message} />

      {may ? (
        <Card className="rounded-2xl">
          <h4 className="text-base font-semibold text-slate-900">{form.id ? form.name : 'New class'}</h4>
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div>
              <label className={label} htmlFor="ac-name">Name</label>
              <Input id="ac-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Computers & accessories" />
            </div>
            <div>
              <label className={label} htmlFor="ac-rate">Rate a year</label>
              <Input id="ac-rate" inputMode="decimal" value={form.ratePct} onChange={(e) => setForm({ ...form, ratePct: e.target.value })} placeholder="25" />
              {life ? <p className="mt-1 text-xs text-slate-500">{life} months — {(life / 12).toFixed(1)} years</p> : null}
            </div>
            <div>
              <label className={label} htmlFor="ac-method">How</label>
              <select id="ac-method" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value as DepreciationMethod })} className={select}>
                {depreciationMethods.map((m) => <option key={m} value={m}>{depreciationMethodLabels[m]}</option>)}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="ac-account">Cost sits in</label>
              <select id="ac-account" value={form.accountCode} onChange={(e) => setForm({ ...form, accountCode: e.target.value })} className={select}>
                <option value="">Not set</option>
                {accountCodes.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
              </select>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <Button size="sm" disabled={pending || !form.name.trim() || !form.ratePct} onClick={() => run(form.id ? 'Class saved.' : 'Class added.', () => saveAssetCategory(entity.id, {
              id: form.id || undefined, name: form.name, ratePct: Number(form.ratePct), method: form.method, accountCode: form.accountCode || null,
            }), () => setForm({ id: '', name: '', ratePct: '', method: 'straight-line', accountCode: '' }))}>
              {form.id ? 'Save changes' : 'Add class'}
            </Button>
            {form.id ? <Button size="sm" variant="ghost" onClick={() => setForm({ id: '', name: '', ratePct: '', method: 'straight-line', accountCode: '' })}>Cancel</Button> : null}
          </div>
        </Card>
      ) : null}

      <Card className="rounded-2xl">
        {categories.length === 0 ? (
          <p className="text-sm text-slate-500">No classes set up yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {categories.map((category) => (
              <li key={category.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className={['font-medium', category.isActive ? 'text-slate-900' : 'text-slate-400'].join(' ')}>{category.name}{category.isActive ? '' : ' (off)'}</p>
                  <p className="text-xs text-slate-500">
                    {category.ratePct}% a year · {depreciationMethodLabels[category.method]}
                    {category.accountCode ? ` · cost in ${category.accountCode}` : ''}
                  </p>
                </div>
                {may ? (
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setForm({ id: category.id, name: category.name, ratePct: String(category.ratePct), method: category.method, accountCode: category.accountCode ?? '' })}>Edit</Button>
                    <Button size="sm" variant="secondary" disabled={pending} onClick={() => run('Class removed.', () => removeAssetCategory(entity.id, category.id))}>Remove</Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// --- tax rates ----------------------------------------------------------------------------------------

export function TaxRateSettings({ entity, rates, allowed }: { entity: EntityRecord; rates: TaxRates; allowed: (p: Permission) => boolean }) {
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({
    vatPct: String(rates.vatPct),
    nhilPct: String(rates.nhilPct),
    getFundPct: String(rates.getFundPct),
    threshold: cedis(rates.registrationThresholdMinor),
  });
  const [warning, setWarning] = useState<string | null>(null);
  const may = allowed('settings:manage');

  const draft: TaxRates = {
    vatPct: Number(form.vatPct || 0),
    nhilPct: Number(form.nhilPct || 0),
    getFundPct: Number(form.getFundPct || 0),
    registrationThresholdMinor: Math.round(Number(form.threshold || 0) * 100),
  };
  const effective = draft.vatPct + draft.nhilPct + draft.getFundPct;
  const standard = JSON.stringify(rates) === JSON.stringify(statutoryTaxRates);

  function save(acknowledged: boolean) {
    setMessage(null);
    startTransition(async () => {
      const result = await saveTaxRates(entity.id, draft, acknowledged);
      if (!result.ok) { setMessage({ tone: 'error', text: result.error }); return; }
      if (result.value.warning && !acknowledged) { setWarning(result.value.warning); return; }
      setMessage({ tone: 'ok', text: 'Tax rates saved. Nothing already posted has changed.' });
      setWarning(null);
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{entity.name}</p>
        <h3 className="mt-1 text-xl font-semibold text-slate-900">Tax rates and the registration threshold</h3>
        <p className="mt-1 text-sm text-slate-600">
          All three levies are charged on the same base and all three are recoverable as input tax. {standard ? 'These are the Ghanaian rates.' : 'These have been changed from the Ghanaian rates.'}
        </p>
      </div>

      <Banner message={message} />

      <Card className="rounded-2xl">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div>
            <label className={label} htmlFor="t-vat">VAT</label>
            <Input id="t-vat" inputMode="decimal" value={form.vatPct} disabled={!may} onChange={(e) => setForm({ ...form, vatPct: e.target.value })} />
          </div>
          <div>
            <label className={label} htmlFor="t-nhil">NHIL</label>
            <Input id="t-nhil" inputMode="decimal" value={form.nhilPct} disabled={!may} onChange={(e) => setForm({ ...form, nhilPct: e.target.value })} />
          </div>
          <div>
            <label className={label} htmlFor="t-gf">GETFund</label>
            <Input id="t-gf" inputMode="decimal" value={form.getFundPct} disabled={!may} onChange={(e) => setForm({ ...form, getFundPct: e.target.value })} />
          </div>
          <div>
            <label className={label} htmlFor="t-threshold">Registration threshold</label>
            <Input id="t-threshold" inputMode="decimal" value={form.threshold} disabled={!may} onChange={(e) => setForm({ ...form, threshold: e.target.value })} />
          </div>
        </div>
        <p className="mt-2 text-sm text-slate-600">Together that is <span className="font-medium">{effective}%</span> on the same base.</p>

        {warning ? <Confirm note={warning} pending={pending} onConfirm={() => save(true)} onCancel={() => setWarning(null)} /> : may ? (
          <div className="mt-4 flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => save(false)}>Save rates</Button>
            {!standard ? (
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => {
                setMessage(null);
                startTransition(async () => {
                  const result = await resetTaxRates(entity.id);
                  setMessage(result.ok ? { tone: 'ok', text: 'Put back to the Ghanaian rates.' } : { tone: 'error', text: result.error });
                });
              }}>Put back to the Ghanaian rates</Button>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
