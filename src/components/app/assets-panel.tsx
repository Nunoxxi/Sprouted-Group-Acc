'use client';

/**
 * The fixed asset register and the tax computation beside it: what the entity
 * owns and what it has written off, the monthly depreciation run, disposals,
 * the capital allowance classes and rates the person maintains, the
 * computation worksheet, and the quarterly provisional instalments.
 *
 * Every change goes through src/app/actions/assets.ts. An entity marked
 * exempt shows the register and nothing about tax.
 */

import { useMemo, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import {
  disposeAsset,
  postTaxCharge,
  recordProvisionalPayment,
  removeAllowanceClass,
  removeTaxAdjustment,
  runDepreciation,
  saveAllowanceClass,
  saveAsset,
  saveTaxAdjustment,
  saveTaxYear,
  setEntityTaxStatus,
  taxWorksheet,
} from '@/app/actions/assets';
import type { Permission } from '@/lib/authz';
import type { AllowanceClassRecord, BankAccountRecord, ContactRecord, DepreciationRunRecord, EntityRecord, FixedAssetRecord, TaxYearRecord } from '@/lib/data/types';
import type { Worksheet } from '@/lib/data/tax';
import {
  adjustmentKindLabels,
  adjustmentKinds,
  depreciationMethodLabels,
  depreciationMethods,
  depreciationSchedule,
  instalments,
  isTaxed,
  monthOf,
  provisionalPosition,
  taxStatusLabels,
  taxStatuses,
  type AdjustmentKind,
  type DepreciationMethod,
  type TaxStatus,
} from '@/lib/assets';

type Props = {
  entity: EntityRecord;
  assets: FixedAssetRecord[];
  runs: DepreciationRunRecord[];
  classes: AllowanceClassRecord[];
  taxYears: TaxYearRecord[];
  contacts: ContactRecord[];
  bankAccounts: BankAccountRecord[];
  allowed: (permission: Permission) => boolean;
};

type Tab = 'Register' | 'Depreciation' | 'Tax classes' | 'Computation' | 'Provisional';
const selectClass = 'min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50';
const label = 'mb-1.5 block text-sm font-medium text-slate-700';
const todayIso = () => new Date().toISOString().slice(0, 10);
const toMinor = (text: string) => Math.round(Number(String(text).replace(/,/g, '')) * 100);

const emptyAsset = {
  id: '',
  code: '',
  description: '',
  category: '',
  purchaseDate: todayIso(),
  inServiceDate: '',
  cost: '',
  residual: '',
  usefulLifeMonths: '60',
  method: 'straight-line' as DepreciationMethod,
  supplierContactId: '',
  location: '',
  custodian: '',
  serialNumber: '',
  allowanceClassId: '',
  openingAccumulated: '',
  note: '',
};

export function AssetsPanel({ entity, assets, runs, classes, taxYears, contacts, bankAccounts, allowed }: Props) {
  const taxed = isTaxed(entity.taxStatus);
  const tabs: Tab[] = taxed ? ['Register', 'Depreciation', 'Tax classes', 'Computation', 'Provisional'] : ['Register', 'Depreciation'];
  const [tab, setTab] = useState<Tab>('Register');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const today = todayIso();

  const inUse = assets.filter((asset) => asset.status === 'in-use');
  const totals = useMemo(
    () => ({
      costMinor: inUse.reduce((total, asset) => total + asset.costMinor, 0),
      accumulatedMinor: inUse.reduce((total, asset) => total + asset.accumulatedMinor, 0),
      bookValueMinor: inUse.reduce((total, asset) => total + asset.bookValueMinor, 0),
    }),
    [inUse],
  );
  const suppliers = useMemo(() => contacts.filter((contact) => contact.category !== 'group-entity'), [contacts]);

  const [yearId, setYearId] = useState(taxYears[0]?.id ?? '');
  const year = taxYears.find((row) => row.id === yearId) ?? taxYears[0];
  const [worksheet, setWorksheet] = useState<Worksheet | null>(null);

  const provisional = useMemo(() => {
    if (!year) return null;
    const rows = instalments(
      monthOf(year.startDate),
      year.estimatedLiabilityMinor,
      year.provisional.map((payment) => ({ quarter: payment.quarter, paidMinor: payment.amountMinor, paidDate: payment.date })),
      today,
    );
    return provisionalPosition(rows, today);
  }, [year, today]);

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

  function loadWorksheet(id: string) {
    setMessage(null);
    setWorksheet(null);
    startTransition(async () => {
      const result = await taxWorksheet(entity.id, id);
      if (result.ok) setWorksheet(result.value);
      else setMessage({ tone: 'error', text: result.error });
    });
  }

  // --- forms ---------------------------------------------------------------------

  const [assetForm, setAssetForm] = useState(emptyAsset);
  const [period, setPeriod] = useState(monthOf(today));
  const [disposalForm, setDisposalForm] = useState({ assetId: '', date: today, proceeds: '', bankAccountId: bankAccounts[0]?.id ?? '', note: '' });
  const [classForm, setClassForm] = useState({ id: '', code: '', name: '', ratePct: '', method: 'reducing-balance' as DepreciationMethod, note: '' });
  const [yearForm, setYearForm] = useState({ id: '', label: '', startDate: '', endDate: '', ratePct: '', lossBroughtForward: '', estimatedLiability: '', note: '' });
  const [poolForm, setPoolForm] = useState<Record<string, string>>({});
  const [adjustmentForm, setAdjustmentForm] = useState({ kind: 'add-back' as AdjustmentKind, description: '', amount: '' });
  const [paymentForm, setPaymentForm] = useState({ quarter: '1', date: today, amount: '', bankAccountId: bankAccounts[0]?.id ?? '', reference: '' });
  const [previewId, setPreviewId] = useState('');

  const preview = useMemo(() => {
    const asset = assets.find((row) => row.id === previewId);
    if (!asset) return [];
    return depreciationSchedule({
      costMinor: asset.costMinor,
      residualMinor: asset.residualMinor,
      usefulLifeMonths: asset.usefulLifeMonths,
      method: asset.method,
      inServiceMonth: monthOf(asset.inServiceDate),
    });
  }, [assets, previewId]);

  function editAsset(asset: FixedAssetRecord) {
    setAssetForm({
      id: asset.id,
      code: asset.code,
      description: asset.description,
      category: asset.category,
      purchaseDate: asset.purchaseDate,
      inServiceDate: asset.inServiceDate,
      cost: (asset.costMinor / 100).toFixed(2),
      residual: (asset.residualMinor / 100).toFixed(2),
      usefulLifeMonths: String(asset.usefulLifeMonths),
      method: asset.method,
      supplierContactId: asset.supplierContactId ?? '',
      location: asset.location,
      custodian: asset.custodian,
      serialNumber: asset.serialNumber,
      allowanceClassId: asset.allowanceClassId ?? '',
      openingAccumulated: '',
      note: asset.note,
    });
  }

  function editYear(row: TaxYearRecord) {
    setYearForm({
      id: row.id,
      label: row.label,
      startDate: row.startDate,
      endDate: row.endDate,
      ratePct: row.ratePct,
      lossBroughtForward: (row.lossBroughtForwardMinor / 100).toFixed(2),
      estimatedLiability: (row.estimatedLiabilityMinor / 100).toFixed(2),
      note: row.note,
    });
    setPoolForm(Object.fromEntries(row.pools.map((pool) => [pool.classId, (pool.openingMinor / 100).toFixed(2)])));
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{entity.name}</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-900">Fixed assets{taxed ? ' & tax' : ''}</h2>
          <p className="mt-1 text-sm text-slate-600">
            What the entity owns and what it has written off. {taxed ? 'Tax is kept separate: depreciation is added back and capital allowances taken off.' : `${entity.name} is marked exempt from company tax, so there is no computation.`}
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

      {/* --- register ----------------------------------------------------------- */}
      {tab === 'Register' ? (
        <div className="space-y-6">
          <Card className="rounded-2xl">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-200 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.12em] text-slate-600">At cost</p>
                <Money value={totals.costMinor} className="text-lg font-semibold" />
              </div>
              <div className="rounded-xl border border-slate-200 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.12em] text-slate-600">Written off so far</p>
                <Money value={totals.accumulatedMinor} className="text-lg font-semibold" />
              </div>
              <div className="rounded-xl border border-slate-200 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.12em] text-slate-600">Book value</p>
                <Money value={totals.bookValueMinor} className="text-lg font-semibold" />
              </div>
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="py-2">Reference</th>
                    <th className="py-2">What it is</th>
                    <th className="py-2">Where and with whom</th>
                    <th className="py-2">How it is written down</th>
                    <th className="py-2 text-right">Cost</th>
                    <th className="py-2 text-right">Written off</th>
                    <th className="py-2 text-right">Book value</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {assets.map((asset) => (
                    <tr key={asset.id} className={asset.status === 'disposed' ? 'text-slate-400' : ''}>
                      <td className="py-2 font-mono text-xs">{asset.code}</td>
                      <td className="py-2 text-slate-900">
                        {asset.description}
                        {asset.category ? <span className="ml-2 text-xs text-slate-500">{asset.category}</span> : null}
                        {asset.status === 'disposed' && asset.disposal ? (
                          <span className="ml-2 text-xs">
                            — sold {asset.disposal.date}, {asset.disposal.gainLossMinor >= 0 ? 'gain' : 'loss'} of <Money value={Math.abs(asset.disposal.gainLossMinor)} />
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 text-slate-600">{[asset.location, asset.custodian].filter(Boolean).join(' · ')}</td>
                      <td className="py-2 text-slate-600">
                        {asset.method === 'straight-line' ? 'Straight line' : 'Reducing balance'} over {asset.usefulLifeMonths} months
                        {asset.allowanceClassName ? <span className="ml-2 text-xs text-slate-500">tax class: {asset.allowanceClassName}</span> : null}
                      </td>
                      <td className="py-2 text-right">
                        <Money value={asset.costMinor} />
                      </td>
                      <td className="py-2 text-right text-slate-600">
                        <Money value={asset.accumulatedMinor} />
                      </td>
                      <td className="py-2 text-right font-medium">
                        <Money value={asset.bookValueMinor} />
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <Button size="sm" variant="ghost" onClick={() => setPreviewId(previewId === asset.id ? '' : asset.id)}>
                          Schedule
                        </Button>
                        {asset.status === 'in-use' && allowed('document:post') ? (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => editAsset(asset)}>
                              Edit
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setDisposalForm((f) => ({ ...f, assetId: asset.id }))}>
                              Dispose
                            </Button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {assets.length === 0 ? (
                    <tr>
                      <td className="py-2 text-slate-500" colSpan={8}>
                        Nothing in the register yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>

          {preview.length ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">Depreciation schedule — {assets.find((a) => a.id === previewId)?.description}</h3>
              <p className="mt-1 text-sm text-slate-600">What it will be written down by, month by month, over its whole life.</p>
              <div className="mt-4 max-h-80 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                    <tr>
                      <th className="py-2">Month</th>
                      <th className="py-2 text-right">Opening</th>
                      <th className="py-2 text-right">Charge</th>
                      <th className="py-2 text-right">Closing</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {preview.map((row) => (
                      <tr key={row.period}>
                        <td className="py-1.5 text-slate-600">{row.period}</td>
                        <td className="py-1.5 text-right text-slate-600">
                          <Money value={row.openingMinor} />
                        </td>
                        <td className="py-1.5 text-right">
                          <Money value={row.chargeMinor} />
                        </td>
                        <td className="py-1.5 text-right">
                          <Money value={row.closingMinor} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {disposalForm.assetId && allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">Dispose of {assets.find((a) => a.id === disposalForm.assetId)?.description}</h3>
              <p className="mt-1 text-sm text-slate-600">
                Book value today: <Money value={assets.find((a) => a.id === disposalForm.assetId)?.bookValueMinor ?? 0} />. Anything above it is a gain, anything below a loss.
              </p>
              <div className="mt-4 grid gap-4 md:grid-cols-4">
                <div>
                  <label className={label}>Date</label>
                  <Input type="date" value={disposalForm.date} onChange={(e) => setDisposalForm((f) => ({ ...f, date: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Proceeds</label>
                  <Input inputMode="decimal" value={disposalForm.proceeds} onChange={(e) => setDisposalForm((f) => ({ ...f, proceeds: e.target.value }))} placeholder="0.00 if scrapped" />
                </div>
                <div>
                  <label className={label}>Into</label>
                  <select className={selectClass} value={disposalForm.bankAccountId} onChange={(e) => setDisposalForm((f) => ({ ...f, bankAccountId: e.target.value }))}>
                    {bankAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Note</label>
                  <Input value={disposalForm.note} onChange={(e) => setDisposalForm((f) => ({ ...f, note: e.target.value }))} />
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    run(
                      'Disposal posted.',
                      () =>
                        disposeAsset(entity.id, {
                          assetId: disposalForm.assetId,
                          date: disposalForm.date,
                          proceedsMinor: disposalForm.proceeds ? toMinor(disposalForm.proceeds) : 0,
                          bankAccountId: disposalForm.proceeds && toMinor(disposalForm.proceeds) > 0 ? disposalForm.bankAccountId : null,
                          note: disposalForm.note,
                        }),
                      () => setDisposalForm((f) => ({ ...f, assetId: '', proceeds: '', note: '' })),
                    )
                  }
                >
                  Post the disposal
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDisposalForm((f) => ({ ...f, assetId: '' }))}>
                  Cancel
                </Button>
              </div>
            </Card>
          ) : null}

          {allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">{assetForm.id ? `Edit ${assetForm.code}` : 'Add an asset'}</h3>
              <div className="mt-4 grid gap-4 md:grid-cols-4">
                <div>
                  <label className={label}>Reference</label>
                  <Input value={assetForm.code} onChange={(e) => setAssetForm((f) => ({ ...f, code: e.target.value }))} placeholder="VEH-001" />
                </div>
                <div className="md:col-span-2">
                  <label className={label}>What it is</label>
                  <Input value={assetForm.description} onChange={(e) => setAssetForm((f) => ({ ...f, description: e.target.value }))} placeholder="Toyota Hilux, GR-1234-26" />
                </div>
                <div>
                  <label className={label}>Category</label>
                  <Input value={assetForm.category} onChange={(e) => setAssetForm((f) => ({ ...f, category: e.target.value }))} placeholder="Vehicles" />
                </div>
                <div>
                  <label className={label}>Bought on</label>
                  <Input type="date" value={assetForm.purchaseDate} onChange={(e) => setAssetForm((f) => ({ ...f, purchaseDate: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>In service from</label>
                  <Input type="date" value={assetForm.inServiceDate} onChange={(e) => setAssetForm((f) => ({ ...f, inServiceDate: e.target.value }))} />
                  <p className="mt-1 text-xs text-slate-500">Blank means the day it was bought.</p>
                </div>
                <div>
                  <label className={label}>Cost</label>
                  <Input inputMode="decimal" value={assetForm.cost} onChange={(e) => setAssetForm((f) => ({ ...f, cost: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Supplier</label>
                  <select className={selectClass} value={assetForm.supplierContactId} onChange={(e) => setAssetForm((f) => ({ ...f, supplierContactId: e.target.value }))}>
                    <option value="">Not recorded</option>
                    {suppliers.map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>How it is written down</label>
                  <select className={selectClass} value={assetForm.method} onChange={(e) => setAssetForm((f) => ({ ...f, method: e.target.value as DepreciationMethod }))}>
                    {depreciationMethods.map((method) => (
                      <option key={method} value={method}>
                        {depreciationMethodLabels[method]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Useful life, months</label>
                  <Input inputMode="numeric" value={assetForm.usefulLifeMonths} onChange={(e) => setAssetForm((f) => ({ ...f, usefulLifeMonths: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Residual value</label>
                  <Input inputMode="decimal" value={assetForm.residual} onChange={(e) => setAssetForm((f) => ({ ...f, residual: e.target.value }))} placeholder="0.00" />
                  {assetForm.method === 'reducing-balance' ? <p className="mt-1 text-xs text-slate-500">Reducing balance needs one above zero.</p> : null}
                </div>
                <div>
                  <label className={label}>Where it is</label>
                  <Input value={assetForm.location} onChange={(e) => setAssetForm((f) => ({ ...f, location: e.target.value }))} placeholder="Wenchi depot" />
                </div>
                <div>
                  <label className={label}>Who has it</label>
                  <Input value={assetForm.custodian} onChange={(e) => setAssetForm((f) => ({ ...f, custodian: e.target.value }))} placeholder="Kwesi Mensah" />
                </div>
                <div>
                  <label className={label}>Serial or registration</label>
                  <Input value={assetForm.serialNumber} onChange={(e) => setAssetForm((f) => ({ ...f, serialNumber: e.target.value }))} />
                </div>
                {taxed ? (
                  <div>
                    <label className={label}>Capital allowance class</label>
                    <select className={selectClass} value={assetForm.allowanceClassId} onChange={(e) => setAssetForm((f) => ({ ...f, allowanceClassId: e.target.value }))}>
                      <option value="">Not in a class</option>
                      {classes.filter((row) => row.isActive).map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.code} — {row.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                {!assetForm.id ? (
                  <div>
                    <label className={label}>Already written off</label>
                    <Input inputMode="decimal" value={assetForm.openingAccumulated} onChange={(e) => setAssetForm((f) => ({ ...f, openingAccumulated: e.target.value }))} placeholder="0.00" />
                    <p className="mt-1 text-xs text-slate-500">For an asset that came in with the opening balances.</p>
                  </div>
                ) : null}
              </div>
              <div className="mt-4 flex gap-2">
                <Button
                  size="sm"
                  disabled={pending || !assetForm.code.trim() || !assetForm.description.trim() || !assetForm.cost}
                  onClick={() =>
                    run(
                      'Asset saved.',
                      () =>
                        saveAsset(entity.id, {
                          id: assetForm.id || undefined,
                          code: assetForm.code,
                          description: assetForm.description,
                          category: assetForm.category,
                          purchaseDate: assetForm.purchaseDate,
                          inServiceDate: assetForm.inServiceDate || undefined,
                          costMinor: toMinor(assetForm.cost),
                          residualMinor: assetForm.residual ? toMinor(assetForm.residual) : 0,
                          usefulLifeMonths: Number(assetForm.usefulLifeMonths || 0),
                          method: assetForm.method,
                          supplierContactId: assetForm.supplierContactId || null,
                          location: assetForm.location,
                          custodian: assetForm.custodian,
                          serialNumber: assetForm.serialNumber,
                          allowanceClassId: assetForm.allowanceClassId || null,
                          openingAccumulated: assetForm.openingAccumulated ? toMinor(assetForm.openingAccumulated) : 0,
                          note: assetForm.note,
                        }),
                      () => setAssetForm(emptyAsset),
                    )
                  }
                >
                  Save
                </Button>
                {assetForm.id ? (
                  <Button size="sm" variant="ghost" onClick={() => setAssetForm(emptyAsset)}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* --- depreciation ------------------------------------------------------- */}
      {tab === 'Depreciation' ? (
        <div className="space-y-6">
          {allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">Run a month</h3>
              <p className="mt-1 text-sm text-slate-600">Every asset in service is written down and the whole month posts as one journal. A month can only be run once.</p>
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <div>
                  <label className={label}>Month</label>
                  <Input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-09" />
                </div>
                <Button size="sm" disabled={pending} onClick={() => run(`Depreciation posted for ${period}.`, () => runDepreciation(entity.id, period))}>
                  Run and post
                </Button>
              </div>
            </Card>
          ) : null}

          {runs.map((row) => (
            <Card key={row.id} className="rounded-2xl">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h3 className="text-lg font-semibold text-slate-900">
                  {row.period}
                  <span className="ml-3 text-sm font-normal text-slate-500">
                    posted by {row.postedByName} · {row.lines.length} asset{row.lines.length === 1 ? '' : 's'}
                  </span>
                </h3>
                <Money value={row.totalMinor} className="text-base font-semibold" />
              </div>
              <table className="mt-3 w-full text-sm">
                <tbody className="divide-y divide-slate-100">
                  {row.lines.map((line) => (
                    <tr key={line.assetId}>
                      <td className="py-1.5 font-mono text-xs text-slate-500">{line.assetCode}</td>
                      <td className="py-1.5 text-slate-700">{line.description}</td>
                      <td className="py-1.5 text-right">
                        <Money value={line.amountMinor} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
          {runs.length === 0 ? (
            <Card className="rounded-2xl">
              <p className="text-sm text-slate-600">No month has been depreciated yet.</p>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* --- allowance classes --------------------------------------------------- */}
      {tab === 'Tax classes' && taxed ? (
        <div className="space-y-6">
          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Capital allowance classes</h3>
            <p className="mt-1 text-sm text-slate-600">
              The classes and rates the Revenue applies. They are yours to keep current — nothing here assumes what they are, so when the budget moves a rate you change it here.
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="py-2">Class</th>
                    <th className="py-2">What it covers</th>
                    <th className="py-2 text-right">Rate</th>
                    <th className="py-2">How it is written down</th>
                    <th className="py-2 text-right">Assets</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {classes.map((row) => (
                    <tr key={row.id}>
                      <td className="py-2 font-mono text-xs">{row.code}</td>
                      <td className="py-2 text-slate-900">{row.name}</td>
                      <td className="py-2 text-right">{row.ratePct}%</td>
                      <td className="py-2 text-slate-600">{row.method === 'reducing-balance' ? 'Reducing balance on the pool' : 'Straight line on cost'}</td>
                      <td className="py-2 text-right text-slate-600">{assets.filter((asset) => asset.allowanceClassId === row.id).length}</td>
                      <td className="py-2 text-right">
                        {allowed('document:post') ? (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => setClassForm({ id: row.id, code: row.code, name: row.name, ratePct: row.ratePct, method: row.method, note: row.note })}>
                              Edit
                            </Button>
                            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run('Class removed.', () => removeAllowanceClass(entity.id, row.id))}>
                              Remove
                            </Button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {classes.length === 0 ? (
                    <tr>
                      <td className="py-2 text-slate-500" colSpan={6}>
                        None entered yet. Add the classes and rates from the Act, as they stand this year.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>

          {allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">{classForm.id ? `Edit class ${classForm.code}` : 'Add a class'}</h3>
              <div className="mt-4 grid gap-4 md:grid-cols-4">
                <div>
                  <label className={label}>Class</label>
                  <Input value={classForm.code} onChange={(e) => setClassForm((f) => ({ ...f, code: e.target.value }))} placeholder="1" />
                </div>
                <div className="md:col-span-2">
                  <label className={label}>What it covers</label>
                  <Input value={classForm.name} onChange={(e) => setClassForm((f) => ({ ...f, name: e.target.value }))} placeholder="Computers and data handling equipment" />
                </div>
                <div>
                  <label className={label}>Rate, % a year</label>
                  <Input inputMode="decimal" value={classForm.ratePct} onChange={(e) => setClassForm((f) => ({ ...f, ratePct: e.target.value }))} placeholder="40" />
                </div>
                <div className="md:col-span-2">
                  <label className={label}>How it is written down</label>
                  <select className={selectClass} value={classForm.method} onChange={(e) => setClassForm((f) => ({ ...f, method: e.target.value as DepreciationMethod }))}>
                    <option value="reducing-balance">Reducing balance on the pool</option>
                    <option value="straight-line">Straight line on cost</option>
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className={label}>Note</label>
                  <Input value={classForm.note} onChange={(e) => setClassForm((f) => ({ ...f, note: e.target.value }))} />
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <Button
                  size="sm"
                  disabled={pending || !classForm.code.trim() || !classForm.name.trim() || !classForm.ratePct}
                  onClick={() =>
                    run('Class saved.', () => saveAllowanceClass(entity.id, { id: classForm.id || undefined, code: classForm.code, name: classForm.name, ratePct: classForm.ratePct, method: classForm.method, note: classForm.note }), () =>
                      setClassForm({ id: '', code: '', name: '', ratePct: '', method: 'reducing-balance', note: '' }),
                    )
                  }
                >
                  Save
                </Button>
                {classForm.id ? (
                  <Button size="sm" variant="ghost" onClick={() => setClassForm({ id: '', code: '', name: '', ratePct: '', method: 'reducing-balance', note: '' })}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            </Card>
          ) : null}

          {allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">Tax status</h3>
              <p className="mt-1 text-sm text-slate-600">An exempt entity keeps its register and its depreciation, but has no computation.</p>
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <select className="min-h-[44px] rounded-lg border border-slate-200 bg-white px-3 text-sm" value={entity.taxStatus} onChange={(event) => run('Tax status changed.', () => setEntityTaxStatus(entity.id, event.target.value as TaxStatus))}>
                  {taxStatuses.map((status) => (
                    <option key={status} value={status}>
                      {taxStatusLabels[status]}
                    </option>
                  ))}
                </select>
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* --- computation ----------------------------------------------------------- */}
      {tab === 'Computation' && taxed ? (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-3">
            {taxYears.length ? (
              <select className="min-h-[40px] rounded-lg border border-slate-200 bg-white px-3 text-sm" value={year?.id ?? ''} onChange={(event) => { setYearId(event.target.value); setWorksheet(null); }}>
                {taxYears.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.label} ({row.startDate} to {row.endDate})
                  </option>
                ))}
              </select>
            ) : null}
            {year ? (
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => loadWorksheet(year.id)}>
                Work it out
              </Button>
            ) : null}
            {year && allowed('document:post') ? (
              <Button size="sm" variant="ghost" onClick={() => editYear(year)}>
                Edit the year
              </Button>
            ) : null}
          </div>

          {worksheet ? (
            <Card className="rounded-2xl">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h3 className="text-lg font-semibold text-slate-900">
                  {worksheet.year.label}
                  <span className="ml-3 text-sm font-normal text-slate-500">at {worksheet.year.ratePct}%</span>
                </h3>
                {worksheet.year.postedAt ? <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-800">posted</span> : null}
              </div>
              <table className="mt-4 w-full text-sm">
                <tbody className="divide-y divide-slate-100">
                  {(
                    [
                      ['Accounting profit for the year', worksheet.accountingProfitMinor, false],
                      ['Add back: depreciation in the accounts', worksheet.depreciationMinor, false],
                      ['Add back: expenses not allowed', worksheet.addBacksMinor, false],
                      ['Less: allowed but not in the accounts', -worksheet.deductionsMinor, false],
                      ['Adjusted profit', worksheet.adjustedProfitMinor, true],
                      ['Less: capital allowances', -worksheet.capitalAllowancesMinor, false],
                      ['Less: incentives and exemptions', -worksheet.incentivesMinor, false],
                      ['Less: losses brought forward used', -worksheet.lossUsedMinor, false],
                      ['Chargeable income', worksheet.chargeableIncomeMinor, true],
                    ] as [string, number, boolean][]
                  ).map(([text, value, bold]) => (
                    <tr key={text} className={bold ? 'font-semibold' : ''}>
                      <td className="py-2 text-slate-800">{text}</td>
                      <td className="py-2 text-right">
                        <Money value={value} />
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-slate-300 text-base font-semibold">
                    <td className="py-2 text-slate-900">Tax at {worksheet.year.ratePct}%</td>
                    <td className="py-2 text-right">
                      <Money value={worksheet.taxChargeMinor} />
                    </td>
                  </tr>
                  {worksheet.lossCarriedForwardMinor > 0 ? (
                    <tr className="text-sm text-slate-600">
                      <td className="py-2">Losses to carry forward</td>
                      <td className="py-2 text-right">
                        <Money value={worksheet.lossCarriedForwardMinor} />
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>

              <h4 className="mt-6 text-sm font-semibold uppercase tracking-[0.12em] text-slate-500">Capital allowances</h4>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                    <tr>
                      <th className="py-2">Class</th>
                      <th className="py-2 text-right">Brought forward</th>
                      <th className="py-2 text-right">Additions</th>
                      <th className="py-2 text-right">Disposals</th>
                      <th className="py-2 text-right">Rate</th>
                      <th className="py-2 text-right">Allowance</th>
                      <th className="py-2 text-right">Carried forward</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {worksheet.allowances.rows.map((row) => (
                      <tr key={row.classId}>
                        <td className="py-2 text-slate-900">
                          {row.code} {row.name}
                        </td>
                        <td className="py-2 text-right text-slate-600">
                          <Money value={row.openingMinor} />
                        </td>
                        <td className="py-2 text-right text-slate-600">
                          <Money value={row.additionsMinor} />
                        </td>
                        <td className="py-2 text-right text-slate-600">
                          <Money value={row.disposalProceedsMinor} />
                        </td>
                        <td className="py-2 text-right text-slate-600">{row.ratePct}%</td>
                        <td className="py-2 text-right font-medium">
                          <Money value={row.allowanceMinor} />
                        </td>
                        <td className={['py-2 text-right', row.closingMinor < 0 ? 'text-rose-700' : ''].join(' ')}>
                          <Money value={row.closingMinor} />
                        </td>
                      </tr>
                    ))}
                    <tr className="font-semibold">
                      <td className="py-2">Total</td>
                      <td colSpan={4} />
                      <td className="py-2 text-right">
                        <Money value={worksheet.allowances.totalAllowanceMinor} />
                      </td>
                      <td className="py-2 text-right">
                        <Money value={worksheet.allowances.totalClosingMinor} />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {worksheet.allowances.rows.some((row) => row.closingMinor < 0) ? (
                <p className="mt-2 text-xs text-rose-700">A pool below nil means disposals exceeded what was left in it — a balancing charge for your adviser to look at.</p>
              ) : null}

              {!worksheet.year.postedAt && allowed('document:post') ? (
                <div className="mt-6">
                  <Button size="sm" disabled={pending} onClick={() => run(`${worksheet.year.label} posted.`, () => postTaxCharge(entity.id, worksheet.year.id, worksheet.taxChargeMinor), () => loadWorksheet(worksheet.year.id))}>
                    Post the charge
                  </Button>
                  <p className="mt-2 text-xs text-slate-500">It posts the tax as an expense and a liability, dated the last day of the year.</p>
                </div>
              ) : null}
            </Card>
          ) : null}

          {year && allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">Adjustments for {year.label}</h3>
              <table className="mt-3 w-full text-sm">
                <tbody className="divide-y divide-slate-100">
                  {year.adjustments.map((adjustment) => (
                    <tr key={adjustment.id}>
                      <td className="py-2 text-slate-600">{adjustmentKindLabels[adjustment.kind]}</td>
                      <td className="py-2 text-slate-900">{adjustment.description}</td>
                      <td className="py-2 text-right">
                        <Money value={adjustment.amountMinor} />
                      </td>
                      <td className="py-2 text-right">
                        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run('Adjustment removed.', () => removeTaxAdjustment(entity.id, adjustment.id), () => setWorksheet(null))}>
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {year.adjustments.length === 0 ? (
                    <tr>
                      <td className="py-2 text-slate-500" colSpan={4}>
                        None yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              <div className="mt-4 grid gap-4 md:grid-cols-4">
                <div>
                  <label className={label}>What kind</label>
                  <select className={selectClass} value={adjustmentForm.kind} onChange={(e) => setAdjustmentForm((f) => ({ ...f, kind: e.target.value as AdjustmentKind }))}>
                    {adjustmentKinds.map((kind) => (
                      <option key={kind} value={kind}>
                        {adjustmentKindLabels[kind]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className={label}>What it is</label>
                  <Input value={adjustmentForm.description} onChange={(e) => setAdjustmentForm((f) => ({ ...f, description: e.target.value }))} placeholder="Entertainment" />
                </div>
                <div>
                  <label className={label}>Amount</label>
                  <Input inputMode="decimal" value={adjustmentForm.amount} onChange={(e) => setAdjustmentForm((f) => ({ ...f, amount: e.target.value }))} />
                </div>
              </div>
              <div className="mt-4">
                <Button
                  size="sm"
                  disabled={pending || !adjustmentForm.description.trim() || !adjustmentForm.amount}
                  onClick={() =>
                    run('Adjustment added.', () => saveTaxAdjustment(entity.id, { taxYearId: year.id, kind: adjustmentForm.kind, description: adjustmentForm.description, amountMinor: toMinor(adjustmentForm.amount) }), () => {
                      setAdjustmentForm({ kind: 'add-back', description: '', amount: '' });
                      setWorksheet(null);
                    })
                  }
                >
                  Add
                </Button>
              </div>
            </Card>
          ) : null}

          {allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">{yearForm.id ? `Edit ${yearForm.label}` : 'Add a tax year'}</h3>
              <div className="mt-4 grid gap-4 md:grid-cols-4">
                <div>
                  <label className={label}>Year</label>
                  <Input value={yearForm.label} onChange={(e) => setYearForm((f) => ({ ...f, label: e.target.value }))} placeholder="2026" />
                </div>
                <div>
                  <label className={label}>From</label>
                  <Input type="date" value={yearForm.startDate} onChange={(e) => setYearForm((f) => ({ ...f, startDate: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>To</label>
                  <Input type="date" value={yearForm.endDate} onChange={(e) => setYearForm((f) => ({ ...f, endDate: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Tax rate, %</label>
                  <Input inputMode="decimal" value={yearForm.ratePct} onChange={(e) => setYearForm((f) => ({ ...f, ratePct: e.target.value }))} placeholder="25" />
                </div>
                <div>
                  <label className={label}>Losses brought forward</label>
                  <Input inputMode="decimal" value={yearForm.lossBroughtForward} onChange={(e) => setYearForm((f) => ({ ...f, lossBroughtForward: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Estimated liability</label>
                  <Input inputMode="decimal" value={yearForm.estimatedLiability} onChange={(e) => setYearForm((f) => ({ ...f, estimatedLiability: e.target.value }))} />
                  <p className="mt-1 text-xs text-slate-500">What the provisional instalments are based on.</p>
                </div>
              </div>
              {classes.length ? (
                <>
                  <h4 className="mt-6 text-sm font-semibold uppercase tracking-[0.12em] text-slate-500">Pools brought into the year</h4>
                  <div className="mt-2 grid gap-4 md:grid-cols-4">
                    {classes.map((row) => (
                      <div key={row.id}>
                        <label className={label}>
                          {row.code} {row.name}
                        </label>
                        <Input inputMode="decimal" value={poolForm[row.id] ?? ''} onChange={(e) => setPoolForm((f) => ({ ...f, [row.id]: e.target.value }))} placeholder="0.00" />
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
              <div className="mt-4 flex gap-2">
                <Button
                  size="sm"
                  disabled={pending || !yearForm.label.trim() || !yearForm.startDate || !yearForm.endDate || !yearForm.ratePct}
                  onClick={() =>
                    run(
                      'Tax year saved.',
                      () =>
                        saveTaxYear(entity.id, {
                          id: yearForm.id || undefined,
                          label: yearForm.label,
                          startDate: yearForm.startDate,
                          endDate: yearForm.endDate,
                          ratePct: yearForm.ratePct,
                          lossBroughtForwardMinor: yearForm.lossBroughtForward ? toMinor(yearForm.lossBroughtForward) : 0,
                          estimatedLiabilityMinor: yearForm.estimatedLiability ? toMinor(yearForm.estimatedLiability) : 0,
                          note: yearForm.note,
                          pools: Object.fromEntries(Object.entries(poolForm).filter(([, value]) => value.trim()).map(([id, value]) => [id, toMinor(value)])),
                        }),
                      () => {
                        setYearForm({ id: '', label: '', startDate: '', endDate: '', ratePct: '', lossBroughtForward: '', estimatedLiability: '', note: '' });
                        setPoolForm({});
                        setWorksheet(null);
                      },
                    )
                  }
                >
                  Save
                </Button>
                {yearForm.id ? (
                  <Button size="sm" variant="ghost" onClick={() => { setYearForm({ id: '', label: '', startDate: '', endDate: '', ratePct: '', lossBroughtForward: '', estimatedLiability: '', note: '' }); setPoolForm({}); }}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* --- provisional ------------------------------------------------------------ */}
      {tab === 'Provisional' && taxed ? (
        <div className="space-y-6">
          {taxYears.length ? (
            <select className="min-h-[40px] rounded-lg border border-slate-200 bg-white px-3 text-sm" value={year?.id ?? ''} onChange={(event) => setYearId(event.target.value)}>
              {taxYears.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
            </select>
          ) : null}

          {year && provisional ? (
            <Card className="rounded-2xl">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h3 className="text-lg font-semibold text-slate-900">Provisional tax for {year.label}</h3>
                <div className="text-sm text-slate-600">
                  Paid <Money value={provisional.paidMinor} /> of <Money value={provisional.estimatedMinor} />
                </div>
              </div>
              {provisional.overdueMinor > 0 ? (
                <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
                  <Money value={provisional.overdueMinor} /> is past due.
                </div>
              ) : provisional.next ? (
                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                  Next: quarter {provisional.next.quarter}, <Money value={provisional.next.outstandingMinor} /> by {provisional.next.dueDate}.
                </div>
              ) : (
                <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">All four instalments are settled.</div>
              )}
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                    <tr>
                      <th className="py-2">Quarter</th>
                      <th className="py-2">Due</th>
                      <th className="py-2 text-right">Estimated</th>
                      <th className="py-2 text-right">Paid</th>
                      <th className="py-2 text-right">Outstanding</th>
                      <th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {provisional.instalments.map((row) => (
                      <tr key={row.quarter}>
                        <td className="py-2 text-slate-900">Q{row.quarter}</td>
                        <td className={['py-2', row.overdue ? 'text-rose-700 font-medium' : 'text-slate-600'].join(' ')}>{row.dueDate}</td>
                        <td className="py-2 text-right">
                          <Money value={row.estimatedMinor} />
                        </td>
                        <td className="py-2 text-right text-slate-600">
                          <Money value={row.paidMinor} />
                        </td>
                        <td className="py-2 text-right">
                          <Money value={row.outstandingMinor} />
                        </td>
                        <td className="py-2 text-sm">
                          {row.outstandingMinor === 0 ? <span className="text-emerald-700">Paid</span> : row.overdue ? <span className="text-rose-700">Overdue</span> : <span className="text-slate-500">Not yet due</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {year && allowed('document:post') ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">Record a payment</h3>
              <div className="mt-4 grid gap-4 md:grid-cols-5">
                <div>
                  <label className={label}>Quarter</label>
                  <select className={selectClass} value={paymentForm.quarter} onChange={(e) => setPaymentForm((f) => ({ ...f, quarter: e.target.value }))}>
                    {['1', '2', '3', '4'].map((quarter) => (
                      <option key={quarter} value={quarter}>
                        Q{quarter}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Date</label>
                  <Input type="date" value={paymentForm.date} onChange={(e) => setPaymentForm((f) => ({ ...f, date: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>Amount</label>
                  <Input inputMode="decimal" value={paymentForm.amount} onChange={(e) => setPaymentForm((f) => ({ ...f, amount: e.target.value }))} />
                </div>
                <div>
                  <label className={label}>From</label>
                  <select className={selectClass} value={paymentForm.bankAccountId} onChange={(e) => setPaymentForm((f) => ({ ...f, bankAccountId: e.target.value }))}>
                    {bankAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Reference</label>
                  <Input value={paymentForm.reference} onChange={(e) => setPaymentForm((f) => ({ ...f, reference: e.target.value }))} />
                </div>
              </div>
              <div className="mt-4">
                <Button
                  size="sm"
                  disabled={pending || !paymentForm.amount || !paymentForm.bankAccountId}
                  onClick={() =>
                    run(
                      'Payment recorded.',
                      () => recordProvisionalPayment(entity.id, { taxYearId: year.id, quarter: Number(paymentForm.quarter), date: paymentForm.date, amountMinor: toMinor(paymentForm.amount), bankAccountId: paymentForm.bankAccountId, reference: paymentForm.reference }),
                      () => setPaymentForm((f) => ({ ...f, amount: '', reference: '' })),
                    )
                  }
                >
                  Record
                </Button>
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
