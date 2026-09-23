'use client';

/**
 * The chart of accounts, editable.
 *
 * What can be changed depends on what has happened to the account, so the
 * form asks the server before it opens: an account with postings cannot
 * change its kind or be deleted, and an account the software posts to by
 * number can only be renamed. Whatever is not allowed is said in plain words
 * rather than shown as a disabled control with no explanation.
 */

import { useMemo, useRef, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  accountEditState,
  deleteAccount,
  exportChart,
  importChart,
  mergeAccounts,
  reorderAccounts,
  saveAccount,
  setAccountActive,
  type AccountEditState,
  type ImportPreview,
} from '@/app/actions/chart';
import type { Permission } from '@/lib/authz';
import { accountTypeLabels, accountTypes, isProtected, sortAccounts, type AccountType } from '@/lib/chart-edit';
import type { AccountRecord, EntityRecord } from '@/lib/data/types';

const label = 'mb-1.5 block text-sm font-medium text-slate-700';
const blank = { id: '', code: '', name: '', type: 'EXPENSE' as AccountType, category: '', parentCode: '' };

type Props = {
  entity: EntityRecord;
  accounts: AccountRecord[];
  allowed: (permission: Permission) => boolean;
};

export function ChartPanel({ entity, accounts, allowed }: Props) {
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState(blank);
  const [state, setState] = useState<AccountEditState | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [filter, setFilter] = useState('');
  const [mergeInto, setMergeInto] = useState('');
  const [mergeWarning, setMergeWarning] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [pendingCsv, setPendingCsv] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  // An Accountant adds and corrects; an Owner may also switch off, delete,
  // merge, import and reorder.
  const may = allowed('chart:edit');
  const ownerPowers = allowed('settings:manage');

  const rows = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return sortAccounts(accounts.map((a) => ({ ...a, sortOrder: 0 })))
      .filter((a) => (showInactive ? true : a.isActive))
      .filter((a) => !term || a.code.includes(term) || a.name.toLowerCase().includes(term));
  }, [accounts, showInactive, filter]);

  function open(account: AccountRecord) {
    setMessage(null);
    setWarning(null);
    setMergeInto('');
    setMergeWarning(null);
    setForm({
      id: account.id,
      code: account.code,
      name: account.name,
      type: account.type as AccountType,
      category: account.category ?? '',
      parentCode: account.parentCode ?? '',
    });
    startTransition(async () => {
      const result = await accountEditState(entity.id, account.id);
      if (result.ok) setState(result.value);
      else setMessage({ tone: 'error', text: result.error });
    });
  }

  function save(acknowledged = false) {
    setMessage(null);
    startTransition(async () => {
      const result = await saveAccount(
        entity.id,
        { id: form.id || undefined, code: form.code, name: form.name, type: form.type, category: form.category, parentCode: form.parentCode },
        acknowledged,
      );
      if (!result.ok) { setMessage({ tone: 'error', text: result.error }); return; }
      if (result.value.warning) { setWarning(result.value.warning); return; }
      setMessage({ tone: 'ok', text: form.id ? 'Account saved.' : 'Account added.' });
      setForm(blank);
      setState(null);
      setWarning(null);
    });
  }

  function run(okText: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) { setMessage({ tone: 'ok', text: okText }); setForm(blank); setState(null); }
      else setMessage({ tone: 'error', text: result.error ?? 'Something went wrong.' });
    });
  }

  function merge(acknowledged: boolean) {
    const into = accounts.find((a) => a.code === mergeInto);
    if (!into || !state) return;
    setMessage(null);
    startTransition(async () => {
      const result = await mergeAccounts(entity.id, state.id, into.id, acknowledged);
      if (!result.ok) { setMessage({ tone: 'error', text: result.error }); return; }
      if (result.value.warning && !acknowledged) { setMergeWarning(result.value.warning); return; }
      setMessage({ tone: 'ok', text: `Merged into ${into.code} ${into.name}: ${result.value.moved} transaction${result.value.moved === 1 ? '' : 's'} moved.` });
      setForm(blank); setState(null); setMergeInto(''); setMergeWarning(null);
    });
  }

  function download() {
    startTransition(async () => {
      const result = await exportChart(entity.id);
      if (!result.ok) { setMessage({ tone: 'error', text: result.error }); return; }
      const blob = new Blob([result.value.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.value.fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    });
  }

  function readFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setMessage(null);
    void file.text().then((csv) => {
      setPendingCsv(csv);
      startTransition(async () => {
        const result = await importChart(entity.id, csv, false);
        if (result.ok) setPreview(result.value);
        else setMessage({ tone: 'error', text: result.error });
      });
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{entity.name}</p>
          <h3 className="mt-1 text-xl font-semibold text-slate-900">Chart of accounts</h3>
          <p className="mt-1 text-sm text-slate-600">
            {accounts.filter((a) => a.isActive).length} in use, {accounts.filter((a) => !a.isActive).length} switched off. An account with transactions on it is
            never deleted — switch it off and it leaves the lists while staying in the reports.
          </p>
        </div>
        {may ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => { setForm(blank); setState(null); setWarning(null); setMessage(null); }}>Add an account</Button>
            <Button size="sm" variant="secondary" disabled={pending} onClick={download}>Export</Button>
            {ownerPowers ? (
              <>
                <input ref={fileInput} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { readFile(e.target.files); e.target.value = ''; }} />
                <Button size="sm" variant="secondary" disabled={pending} onClick={() => fileInput.current?.click()}>Import</Button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {message ? (
        <div className={['rounded-xl border px-4 py-3 text-sm', message.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'].join(' ')}>{message.text}</div>
      ) : null}

      {preview ? (
        <Card className="rounded-2xl border-amber-200 bg-amber-50/50">
          <h4 className="text-base font-semibold text-slate-900">This is what the file would do</h4>
          <ul className="mt-2 space-y-1 text-sm text-slate-700">
            <li>{preview.add.length} account{preview.add.length === 1 ? '' : 's'} added{preview.add.length ? `: ${preview.add.slice(0, 8).map((a) => `${a.code} ${a.name}`).join(', ')}${preview.add.length > 8 ? '…' : ''}` : ''}</li>
            <li>{preview.rename.length} renamed{preview.rename.length ? `: ${preview.rename.slice(0, 6).map((a) => `${a.code} ${a.from} → ${a.to}`).join(', ')}${preview.rename.length > 6 ? '…' : ''}` : ''}</li>
            <li>{preview.unchanged} already the same</li>
            {preview.blocked.length ? <li className="text-amber-800">{preview.blocked.length} left alone: {preview.blocked.slice(0, 4).map((b) => b.code).join(', ')} — an import never changes an account&rsquo;s kind</li> : null}
            {preview.rejected.length ? <li className="text-rose-700">{preview.rejected.length} line{preview.rejected.length === 1 ? '' : 's'} could not be read: {preview.rejected.slice(0, 3).map((r) => `line ${r.line} (${r.reason})`).join('; ')}</li> : null}
          </ul>
          <p className="mt-2 text-sm text-slate-600">Nothing is deleted or switched off by an import.</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => run('Chart imported.', async () => { const r = await importChart(entity.id, pendingCsv, true); setPreview(null); return r; })}>
              Apply it
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setPreview(null); setPendingCsv(''); }}>Cancel</Button>
          </div>
        </Card>
      ) : null}

      {may ? (
        <Card className="rounded-2xl">
          <h4 className="text-base font-semibold text-slate-900">{form.id ? `Account ${form.code}` : 'New account'}</h4>
          {state?.permissions.reasons.length ? (
            <ul className="mt-2 space-y-1 text-sm text-amber-800">
              {state.permissions.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          ) : null}

          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div>
              <label className={label} htmlFor="acct-code">Number</label>
              <Input id="acct-code" value={form.code} disabled={!!state && !state.permissions.changeCode} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="7060" />
            </div>
            <div>
              <label className={label} htmlFor="acct-name">Name</label>
              <Input id="acct-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Cleaning" />
            </div>
            <div>
              <label className={label} htmlFor="acct-type">What kind of account</label>
              <select
                id="acct-type"
                value={form.type}
                disabled={!!state && !state.permissions.changeType}
                onChange={(e) => setForm({ ...form, type: e.target.value as AccountType })}
                className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 disabled:bg-slate-50"
              >
                {accountTypes.map((type) => <option key={type} value={type}>{accountTypeLabels[type]}</option>)}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="acct-group">Sub-group</label>
              <Input id="acct-group" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Optional" />
            </div>
            <div>
              <label className={label} htmlFor="acct-parent">Sits beneath</label>
              <select
                id="acct-parent"
                value={form.parentCode}
                disabled={!!state && !state.permissions.changeParent}
                onChange={(e) => setForm({ ...form, parentCode: e.target.value })}
                className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 disabled:bg-slate-50"
              >
                <option value="">Nothing — top level</option>
                {accounts.filter((a) => a.isActive && a.code !== form.code && a.type === form.type).map((a) => (
                  <option key={a.id} value={a.code}>{a.code} {a.name}</option>
                ))}
              </select>
            </div>
          </div>

          {warning ? (
            <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
              <p className="text-sm font-medium text-amber-900">Before you save</p>
              <p className="mt-1 text-sm text-amber-900">{warning}</p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" disabled={pending} onClick={() => save(true)}>I understand — save it</Button>
                <Button size="sm" variant="ghost" onClick={() => setWarning(null)}>Go back</Button>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" disabled={pending || !form.code.trim() || !form.name.trim()} onClick={() => save(false)}>
                {form.id ? 'Save changes' : 'Add account'}
              </Button>
              {form.id ? <Button size="sm" variant="ghost" onClick={() => { setForm(blank); setState(null); }}>Cancel</Button> : null}
              {state?.permissions.deactivate && state.isActive ? (
                <Button size="sm" variant="secondary" disabled={pending} onClick={() => run('Account switched off.', () => setAccountActive(entity.id, state.id, false))}>Switch off</Button>
              ) : null}
              {state && !state.isActive ? (
                <Button size="sm" variant="secondary" disabled={pending} onClick={() => run('Account switched on.', () => setAccountActive(entity.id, state.id, true))}>Switch on</Button>
              ) : null}
              {state?.permissions.remove ? (
                <Button size="sm" variant="danger" disabled={pending} onClick={() => run('Account deleted.', () => deleteAccount(entity.id, state.id))}>Delete</Button>
              ) : null}
            </div>
          )}

          {state?.permissions.mergeAway ? (
            <div className="mt-5 border-t border-slate-200 pt-4">
              <p className="text-sm font-medium text-slate-900">Merge this account into another</p>
              <p className="mt-1 text-sm text-slate-600">Every transaction moves across and this account is switched off. Dates, amounts and journals do not change.</p>
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <div className="min-w-[18rem]">
                  <label className={label} htmlFor="merge-into">Into</label>
                  <select id="merge-into" value={mergeInto} onChange={(e) => { setMergeInto(e.target.value); setMergeWarning(null); }} className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm">
                    <option value="">Choose an account…</option>
                    {accounts.filter((a) => a.isActive && a.type === state.type && a.code !== state.code).map((a) => (
                      <option key={a.id} value={a.code}>{a.code} {a.name}</option>
                    ))}
                  </select>
                </div>
                <Button size="sm" variant="secondary" disabled={pending || !mergeInto} onClick={() => merge(false)}>Check what this does</Button>
              </div>
              {mergeWarning ? (
                <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
                  <p className="text-sm text-amber-900">{mergeWarning}</p>
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" disabled={pending} onClick={() => merge(true)}>I understand — merge them</Button>
                    <Button size="sm" variant="ghost" onClick={() => setMergeWarning(null)}>Go back</Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card className="rounded-2xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-[14rem] flex-1">
            <label className={label} htmlFor="acct-filter">Find an account</label>
            <Input id="acct-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Number or name" />
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show switched-off accounts
          </label>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[46rem] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-3 font-medium">Number</th>
                <th className="py-2 pr-3 font-medium">Name</th>
                <th className="py-2 pr-3 font-medium">Kind</th>
                <th className="py-2 pr-3 font-medium">Sub-group</th>
                <th className="py-2 pr-3 font-medium">Beneath</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((account) => {
                const locked = isProtected({ code: account.code, type: account.type as AccountType });
                return (
                  <tr key={account.id} className={account.isActive ? '' : 'text-slate-400'}>
                    <td className="py-2 pr-3 font-mono text-xs">{account.code}</td>
                    <td className="py-2 pr-3">
                      {account.name}
                      {locked ? <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500">system</span> : null}
                      {!account.isActive ? <span className="ml-2 text-xs">(off)</span> : null}
                    </td>
                    <td className="py-2 pr-3 text-slate-600">{accountTypeLabels[account.type as AccountType]}</td>
                    <td className="py-2 pr-3 text-slate-600">{account.category ?? ''}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-slate-500">{account.parentCode ?? ''}</td>
                    <td className="py-2 text-right">
                      {may ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => open(account)}>Edit</Button> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {ownerPowers && rows.length > 1 ? (
          <div className="mt-4 border-t border-slate-200 pt-3">
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => run('Chart reordered by account number.', () => reorderAccounts(entity.id, rows.map((a) => a.code)))}
            >
              Save this order
            </Button>
            <span className="ml-2 text-xs text-slate-500">Stores the order shown above, so the chart reads the way you want it rather than by number alone.</span>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
