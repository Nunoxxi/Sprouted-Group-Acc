'use client';

/**
 * Sales contracts: the contract list and form, deliveries against a
 * contract, margin per contract (revenue, cost of stock delivered, selling
 * costs, per kg — and for foreign contracts at the contract rate and at
 * today's), the position report, and LBC mode. Every change goes through
 * src/app/actions/contracts.ts; the figures shown come from
 * src/lib/contracts.ts over the records the server wrote.
 */

import { useMemo, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { acceptDelivery, recordCmcReceipt, recordDelivery, recordSeedFund, saveContract, setContractStatus, setLbcSettings } from '@/app/actions/contracts';
import type { Permission } from '@/lib/authz';
import { contractMargin, contractValueMinor, positionReport, priceUnits, sellingCostLabels, type PriceUnit } from '@/lib/contracts';
import type { BankAccountRecord, CommodityRecord, ContactRecord, EntityRecord, ExchangeRateRow, ItemRecord, SalesContractRecord, SeedFundRecord, StockBalanceRecord, StockLocationRecord } from '@/lib/data/types';
import { currencies, selectRate, type Currency } from '@/lib/fx';
import { formatKg, type StockUnit } from '@/lib/inventory';
import { bagsOf } from '@/lib/trading';

type Props = {
  entity: EntityRecord;
  contracts: SalesContractRecord[];
  contacts: ContactRecord[];
  items: ItemRecord[];
  commodities: CommodityRecord[];
  locations: StockLocationRecord[];
  balances: StockBalanceRecord[];
  rates: ExchangeRateRow[];
  bankAccounts: BankAccountRecord[];
  seedFunds: SeedFundRecord[];
  allowed: (permission: Permission) => boolean;
};

type Tab = 'Contracts' | 'Position' | 'LBC';
const selectClass = 'min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50';
const label = 'mb-1.5 block text-sm font-medium text-slate-700';
const todayIso = () => new Date().toISOString().slice(0, 10);

type ContractForm = { id: string; buyerContactId: string; itemId: string; quantity: string; quantityUnit: StockUnit; price: string; priceUnit: PriceUnit; currency: Currency; contractRate: string; deliveryTerms: string; deliveryFrom: string; deliveryTo: string; recognizeOn: 'delivery' | 'acceptance'; saleType: 'domestic' | 'export'; isCmc: boolean; note: string };

export function ContractsPanel({ entity, contracts, contacts, items, commodities, locations, balances, rates, bankAccounts, seedFunds, allowed }: Props) {
  const [tab, setTab] = useState<Tab>('Contracts');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const today = todayIso();
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const commodityOf = (itemId: string) => commodities.find((c) => c.id === itemById.get(itemId)?.commodityId);
  const grades = items.filter((i) => i.isActive && i.commodityId);
  const buyers = contacts.filter((c) => c.isActive && (c.type === 'customer' || c.type === 'both' || c.category === 'group-entity'));

  function run(okText: string, action: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) { setMessage({ tone: 'ok', text: okText }); after?.(); } else setMessage({ tone: 'error', text: result.error ?? 'Something went wrong.' });
    });
  }

  const blank = (): ContractForm => ({ id: '', buyerContactId: '', itemId: '', quantity: '', quantityUnit: 'tonne', price: '', priceUnit: 'kg', currency: entity.functionalCurrency, contractRate: '', deliveryTerms: '', deliveryFrom: today, deliveryTo: today, recognizeOn: 'delivery', saleType: 'export', isCmc: false, note: '' });
  const [form, setForm] = useState<ContractForm>(blank());
  const [selectedId, setSelectedId] = useState<string>('');
  const selected = contracts.find((c) => c.id === selectedId) ?? null;
  const [deliveryForm, setDeliveryForm] = useState({ date: today, locationId: '', quantity: '', unit: 'tonne' as StockUnit, rate: '', destination: '', note: '' });
  const [acceptDate, setAcceptDate] = useState(today);

  // Today's rate for a foreign contract: the rate table's most recent.
  const todayRateFor = (currency: Currency) => (currency === entity.functionalCurrency ? null : (selectRate(rates, currency, entity.functionalCurrency, today)?.rate ?? null));

  const marginOf = (contract: SalesContractRecord) => {
    const gramsPerBag = commodityOf(contract.itemId)?.gramsPerBag ?? 0;
    return contractMargin(
      { quantityGrams: contract.quantityGrams, priceMinor: contract.priceMinor, priceUnit: contract.priceUnit, currency: contract.currency, contractRate: contract.contractRate },
      contract.deliveries.map((d) => ({ grams: d.grams, revenueTxnMinor: d.revenueTxnMinor, revenueMinor: d.revenueMinor, costMinor: d.costMinor, marginMinor: d.marginMinor, haulageMinor: d.haulageMinor, recognised: d.status !== 'awaiting-acceptance' })),
      contract.sellingCosts,
      entity.functionalCurrency,
      gramsPerBag,
      todayRateFor(contract.currency),
    );
  };

  const position = useMemo(
    () => positionReport(contracts.map((c) => ({ itemId: c.itemId, status: c.status, quantityGrams: c.quantityGrams, deliveredGrams: c.deliveries.reduce((s, d) => s + d.grams, 0) })), balances.filter((b) => locations.find((l) => l.id === b.locationId)?.code !== 'DELIVERED'), grades.map((g) => g.id)),
    [contracts, balances, grades, locations],
  );

  // LBC
  const [lbcForm, setLbcForm] = useState({ lbcMode: entity.lbcMode, presentation: entity.revenuePresentation, producer: entity.producerPriceMinorPerKg === null ? '' : String(entity.producerPriceMinorPerKg / 100), margin: entity.buyerMarginMinorPerKg === null ? '' : String(entity.buyerMarginMinorPerKg / 100), haulage: entity.haulageMinorPerKg === null ? '' : String(entity.haulageMinorPerKg / 100) });
  const [seedForm, setSeedForm] = useState({ kind: 'received' as 'received' | 'repaid' | 'offset', date: today, amount: '', bankAccountId: bankAccounts[0]?.id ?? '', note: '' });
  const [cmcForm, setCmcForm] = useState({ date: today, amount: '', bankAccountId: bankAccounts[0]?.id ?? '' });
  const seedBalance = seedFunds.reduce((s, f) => s + (f.kind === 'received' ? f.amountMinor : -f.amountMinor), 0);

  const formValueTxn = (() => {
    const commodity = commodityOf(form.itemId);
    if (!commodity || !form.quantity || !form.price) return null;
    const grams = Math.round(Number(form.quantity) * (form.quantityUnit === 'kg' ? 1000 : form.quantityUnit === 'tonne' ? 1_000_000 : commodity.gramsPerBag));
    return contractValueMinor(grams, Math.round(Number(form.price) * 100), form.priceUnit, commodity.gramsPerBag);
  })();

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{entity.name}</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-900">Sales contracts</h2>
          {entity.lbcMode ? <p className="mt-1 text-sm text-amber-800">LBC mode: {entity.revenuePresentation} presentation. CMC deliveries post buyer&rsquo;s margin and haulage as separate income.</p> : null}
        </div>
        <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1">
          {(['Contracts', 'Position', 'LBC'] as Tab[]).map((candidate) => <button key={candidate} type="button" onClick={() => setTab(candidate)} className={['rounded-lg px-3 py-2 text-sm font-medium', tab === candidate ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'].join(' ')}>{candidate}</button>)}
        </div>
      </div>
      {message ? <p className={['rounded-lg border px-3 py-2 text-sm', message.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800'].join(' ')}>{message.text}</p> : null}

      {/* ---------------------------------------------------------------- Contracts */}
      {tab === 'Contracts' ? (
        <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
          <div className="space-y-6">
            <Card className="rounded-2xl">
              <div className="flex items-center justify-between"><p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Contracts</p>{allowed('document:draft') ? <Button size="sm" variant="secondary" onClick={() => { setSelectedId(''); setForm(blank()); }}>New</Button> : null}</div>
              <div className="mt-3 divide-y divide-slate-200">
                {contracts.map((c) => {
                  const m = marginOf(c);
                  return (
                    <button key={c.id} type="button" onClick={() => { setSelectedId(c.id); setDeliveryForm({ ...deliveryForm, locationId: '', quantity: '', rate: '' }); }} className={['block w-full py-2 text-left text-sm hover:bg-slate-50', c.id === selectedId ? 'bg-brand-50' : ''].join(' ')}>
                      <div className="flex items-center justify-between gap-2"><span className="font-medium text-slate-900">{c.contractNo} · {c.buyerName}</span><span className={['rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]', c.status === 'open' ? 'bg-emerald-100 text-emerald-700' : c.status === 'closed' ? 'bg-slate-200 text-slate-700' : 'bg-red-100 text-red-700'].join(' ')}>{c.status}</span></div>
                      <div className="text-xs text-slate-500">{itemById.get(c.itemId)?.name} · {formatKg(c.quantityGrams)} · {c.currency} {(c.priceMinor / 100).toFixed(2)}/{c.priceUnit}{c.isCmc ? ' · CMC' : ''} · delivered {formatKg(m.deliveredGrams)}</div>
                    </button>
                  );
                })}
                {contracts.length === 0 ? <p className="py-2 text-sm text-slate-600">No contracts yet.</p> : null}
              </div>
            </Card>
          </div>

          <div className="space-y-6">
            {!selected ? (
              allowed('document:draft') ? (
                <Card className="rounded-2xl">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{form.id ? 'Edit contract' : 'New contract'}</p>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <div><label className={label}>Buyer</label><select value={form.buyerContactId} className={selectClass} onChange={(e) => setForm({ ...form, buyerContactId: e.target.value })}><option value="">Choose…</option>{buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
                    <div><label className={label}>Commodity grade</label><select value={form.itemId} className={selectClass} onChange={(e) => setForm({ ...form, itemId: e.target.value })}><option value="">Choose…</option>{grades.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></div>
                    <div className="grid grid-cols-[1fr_120px] gap-2">
                      <div><label className={label}>Quantity</label><Input type="number" inputMode="decimal" min={0} step="any" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} /></div>
                      <div><label className={label}>Unit</label><select value={form.quantityUnit} className={selectClass} onChange={(e) => setForm({ ...form, quantityUnit: e.target.value as StockUnit })}><option value="tonne">tonnes</option><option value="kg">kg</option><option value="bag">bags</option></select></div>
                    </div>
                    <div className="grid grid-cols-[1fr_90px_90px] gap-2">
                      <div><label className={label}>Price</label><Input type="number" inputMode="decimal" min={0} step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></div>
                      <div><label className={label}>Per</label><select value={form.priceUnit} className={selectClass} onChange={(e) => setForm({ ...form, priceUnit: e.target.value as PriceUnit })}>{priceUnits.map((u) => <option key={u} value={u}>{u}</option>)}</select></div>
                      <div><label className={label}>Currency</label><select value={form.currency} className={selectClass} onChange={(e) => setForm({ ...form, currency: e.target.value as Currency })}>{currencies.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
                    </div>
                    {form.currency !== entity.functionalCurrency ? <div><label className={label}>Contract rate ({entity.functionalCurrency} per 1 {form.currency})</label><Input inputMode="decimal" value={form.contractRate} placeholder={todayRateFor(form.currency) ?? 'e.g. 12.5'} onChange={(e) => setForm({ ...form, contractRate: e.target.value })} /><p className="mt-1 text-xs text-slate-500">The rate the deal was priced at; the margin screen compares it with today&rsquo;s.</p></div> : <div />}
                    <div><label className={label}>Delivery terms</label><Input value={form.deliveryTerms} placeholder="FOB Tema · EXW warehouse · CMC take-over Kumasi" onChange={(e) => setForm({ ...form, deliveryTerms: e.target.value })} /></div>
                    <div className="grid grid-cols-2 gap-2">
                      <div><label className={label}>Deliver from</label><Input type="date" value={form.deliveryFrom} onChange={(e) => setForm({ ...form, deliveryFrom: e.target.value })} /></div>
                      <div><label className={label}>to</label><Input type="date" value={form.deliveryTo} onChange={(e) => setForm({ ...form, deliveryTo: e.target.value })} /></div>
                    </div>
                    <div><label className={label}>Revenue recognised</label><select value={form.recognizeOn} className={selectClass} onChange={(e) => setForm({ ...form, recognizeOn: e.target.value as 'delivery' | 'acceptance' })}><option value="delivery">On delivery</option><option value="acceptance">On buyer&rsquo;s acceptance</option></select></div>
                    <div><label className={label}>Sale</label><select value={form.saleType} className={selectClass} onChange={(e) => setForm({ ...form, saleType: e.target.value as 'domestic' | 'export' })}><option value="export">Export</option><option value="domestic">Domestic</option></select></div>
                    {entity.lbcMode ? <label className="flex items-center gap-2 text-sm text-slate-700 md:col-span-2"><input type="checkbox" checked={form.isCmc} onChange={(e) => setForm({ ...form, isCmc: e.target.checked, currency: entity.functionalCurrency, price: e.target.checked && entity.producerPriceMinorPerKg !== null ? String(entity.producerPriceMinorPerKg / 100) : form.price, priceUnit: e.target.checked ? 'kg' : form.priceUnit, saleType: e.target.checked ? 'domestic' : form.saleType })} />CMC contract at the gazetted producer price (LBC)</label> : null}
                    <div className="md:col-span-2"><label className={label}>Note</label><Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
                  </div>
                  {formValueTxn !== null ? <p className="mt-3 text-sm text-slate-700">Contract value: <span className="font-mono font-semibold"><Money value={formValueTxn} currency={form.currency} /></span></p> : null}
                  <div className="mt-3 flex justify-end"><Button size="sm" disabled={pending} onClick={() => run('Contract saved.', () => saveContract(entity.id, { id: form.id || undefined, buyerContactId: form.buyerContactId, itemId: form.itemId, quantity: Number(form.quantity), quantityUnit: form.quantityUnit, priceMinor: Math.round(Number(form.price) * 100), priceUnit: form.priceUnit, currency: form.currency, contractRate: form.contractRate || null, deliveryTerms: form.deliveryTerms, deliveryFrom: form.deliveryFrom, deliveryTo: form.deliveryTo, recognizeOn: form.recognizeOn, saleType: form.saleType, isCmc: form.isCmc, note: form.note }), () => setForm(blank()))}>{form.id ? 'Save changes' : 'Create contract'}</Button></div>
                </Card>
              ) : <Card className="rounded-2xl"><p className="text-sm text-slate-600">Choose a contract on the left.</p></Card>
            ) : (
              <ContractDetail contract={selected} margin={marginOf(selected)} entity={entity} itemById={itemById} commodity={commodityOf(selected.itemId)} locations={locations} balances={balances} deliveryForm={deliveryForm} setDeliveryForm={setDeliveryForm} acceptDate={acceptDate} setAcceptDate={setAcceptDate} pending={pending} allowed={allowed} run={run} onEdit={() => { setForm({ id: selected.id, buyerContactId: selected.buyerContactId, itemId: selected.itemId, quantity: String(selected.quantityGrams / 1_000_000), quantityUnit: 'tonne', price: String(selected.priceMinor / 100), priceUnit: selected.priceUnit, currency: selected.currency, contractRate: selected.contractRate ?? '', deliveryTerms: selected.deliveryTerms, deliveryFrom: selected.deliveryFrom, deliveryTo: selected.deliveryTo, recognizeOn: selected.recognizeOn, saleType: selected.saleType, isCmc: selected.isCmc, note: selected.note }); setSelectedId(''); }} todayRate={todayRateFor(selected.currency)} />
            )}
          </div>
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- Position */}
      {tab === 'Position' ? (
        <Card className="rounded-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Position</p>
          <h3 className="mt-1 text-xl font-semibold text-slate-900">Contracted but undelivered, against stock on hand</h3>
          <p className="mt-1 text-sm text-slate-600">Open contracts only. Red: sold more than held. Amber: stock with no buyer.</p>
          <div className="mt-4 overflow-x-auto">
            <div className="grid min-w-[820px] grid-cols-[1.6fr_1fr_1fr_1fr_1fr_1fr_120px] gap-3 rounded-t-xl bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500"><span>Grade</span><span className="text-right">Contracted</span><span className="text-right">Delivered</span><span className="text-right">Undelivered</span><span className="text-right">On hand</span><span className="text-right">Net</span><span /></div>
            {position.map((row) => {
              const item = itemById.get(row.itemId);
              const gramsPerBag = commodityOf(row.itemId)?.gramsPerBag ?? 0;
              return (
                <div key={row.itemId} className={['grid min-w-[820px] grid-cols-[1.6fr_1fr_1fr_1fr_1fr_1fr_120px] gap-3 border-t border-slate-200 px-3 py-2 text-sm', row.status === 'oversold' ? 'bg-red-50' : row.status === 'unsold' ? 'bg-amber-50' : ''].join(' ')}>
                  <span>{item?.name}</span>
                  <span className="text-right font-mono">{formatKg(row.contractedGrams)}</span>
                  <span className="text-right font-mono">{formatKg(row.deliveredGrams)}</span>
                  <span className="text-right font-mono">{formatKg(row.undeliveredGrams)}</span>
                  <span className="text-right font-mono">{formatKg(row.onHandGrams)}<span className="block text-[11px] text-slate-500">{gramsPerBag ? `${bagsOf(row.onHandGrams, gramsPerBag).toFixed(1)} bags` : ''}</span></span>
                  <span className={['text-right font-mono font-semibold', row.netGrams < 0 ? 'text-red-800' : 'text-slate-900'].join(' ')}>{row.netGrams < 0 ? '−' : ''}{formatKg(Math.abs(row.netGrams))}</span>
                  <span className="text-right"><span className={['rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]', row.status === 'oversold' ? 'bg-red-600 text-white' : row.status === 'unsold' ? 'bg-amber-200 text-amber-900' : row.status === 'covered' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'].join(' ')}>{row.status}</span></span>
                </div>
              );
            })}
            {position.length === 0 ? <p className="px-3 py-3 text-sm text-slate-600">No grades yet.</p> : null}
          </div>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------------- LBC */}
      {tab === 'LBC' ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-6">
            <Card className="rounded-2xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">COCOBOD Licensed Buying Company</p>
              <h3 className="mt-1 text-xl font-semibold text-slate-900">LBC mode is {entity.lbcMode ? 'on' : 'off'}</h3>
              <p className="mt-1 text-sm text-slate-600">When on: seed funds received are a liability to COCOBOD (2050), never income; purchases are at the gazetted producer price; deliveries go to CMC take-over centres and are owed by COCOBOD (1065); the buyer&rsquo;s margin (4020) and haulage allowance (4025) are separate income lines.</p>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <label className="flex items-center gap-2 text-sm text-slate-800 md:col-span-2"><input type="checkbox" checked={lbcForm.lbcMode} disabled={!allowed('entity:configure')} onChange={(e) => setLbcForm({ ...lbcForm, lbcMode: e.target.checked })} />Operate as a Licensed Buying Company</label>
                <div className="md:col-span-2">
                  <label className={label}>Revenue presentation</label>
                  <div className="grid gap-2 md:grid-cols-2">
                    {(['gross', 'net'] as const).map((p) => (
                      <button key={p} type="button" disabled={!allowed('entity:configure')} onClick={() => setLbcForm({ ...lbcForm, presentation: p })} className={['rounded-xl border p-3 text-left text-sm', lbcForm.presentation === p ? 'border-brand-700 bg-brand-50' : 'border-slate-200 bg-white'].join(' ')}>
                        <div className="font-semibold text-slate-900">{p === 'gross' ? 'Gross' : 'Net'}</div>
                        <div className="mt-1 text-xs text-slate-600">{p === 'gross' ? 'Producer value to Sales, cost to Cost of Goods Sold, margin and haulage as income. You are the principal.' : 'The cocoa passes through: no sales, no COGS. Only margin, haulage and the pass-through difference are income. You are the agent.'}</div>
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">This is your principal-versus-agent assessment. The app posts whichever you choose and never decides for you.</p>
                </div>
                <div><label className={label}>Producer price per kg</label><Input type="number" inputMode="decimal" min={0} step="0.01" value={lbcForm.producer} disabled={!allowed('entity:configure')} onChange={(e) => setLbcForm({ ...lbcForm, producer: e.target.value })} /></div>
                <div><label className={label}>Buyer&rsquo;s margin per kg</label><Input type="number" inputMode="decimal" min={0} step="0.01" value={lbcForm.margin} disabled={!allowed('entity:configure')} onChange={(e) => setLbcForm({ ...lbcForm, margin: e.target.value })} /></div>
                <div><label className={label}>Haulage allowance per kg</label><Input type="number" inputMode="decimal" min={0} step="0.01" value={lbcForm.haulage} disabled={!allowed('entity:configure')} onChange={(e) => setLbcForm({ ...lbcForm, haulage: e.target.value })} /></div>
              </div>
              {allowed('entity:configure') ? <div className="mt-3 flex justify-end"><Button size="sm" disabled={pending} onClick={() => run('LBC settings saved.', () => setLbcSettings(entity.id, { lbcMode: lbcForm.lbcMode, revenuePresentation: lbcForm.presentation, producerPriceMinorPerKg: lbcForm.producer.trim() ? Math.round(Number(lbcForm.producer) * 100) : null, buyerMarginMinorPerKg: lbcForm.margin.trim() ? Math.round(Number(lbcForm.margin) * 100) : null, haulageMinorPerKg: lbcForm.haulage.trim() ? Math.round(Number(lbcForm.haulage) * 100) : null }))}>Save LBC settings</Button></div> : null}
            </Card>
            {entity.lbcMode ? (
              <Card className="rounded-2xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Seed funds</p>
                <h3 className="mt-1 text-xl font-semibold text-slate-900">Owed to COCOBOD: <Money value={seedBalance} /></h3>
                <div className="mt-3 divide-y divide-slate-200 text-sm">
                  {seedFunds.map((f) => <div key={f.id} className="flex items-center justify-between py-2"><span>{f.date} · {f.kind}{f.note ? ` · ${f.note}` : ''}</span><span className="font-mono"><Money value={f.amountMinor} /></span></div>)}
                  {seedFunds.length === 0 ? <p className="py-2 text-slate-600">None recorded.</p> : null}
                </div>
              </Card>
            ) : null}
          </div>
          {entity.lbcMode && allowed('document:post') ? (
            <div className="space-y-6">
              <Card className="rounded-2xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Seed fund movement</p>
                <div className="mt-3 space-y-3">
                  <div><label className={label}>Kind</label><select value={seedForm.kind} className={selectClass} onChange={(e) => setSeedForm({ ...seedForm, kind: e.target.value as 'received' | 'repaid' | 'offset' })}><option value="received">Received from COCOBOD (liability up)</option><option value="repaid">Repaid to COCOBOD</option><option value="offset">Offset against cocoa delivered</option></select></div>
                  <div><label className={label}>Amount</label><Input type="number" inputMode="decimal" min={0} step="0.01" value={seedForm.amount} onChange={(e) => setSeedForm({ ...seedForm, amount: e.target.value })} /></div>
                  <div><label className={label}>Date</label><Input type="date" value={seedForm.date} onChange={(e) => setSeedForm({ ...seedForm, date: e.target.value })} /></div>
                  {seedForm.kind !== 'offset' ? <div><label className={label}>Bank account</label><select value={seedForm.bankAccountId} className={selectClass} onChange={(e) => setSeedForm({ ...seedForm, bankAccountId: e.target.value })}>{bankAccounts.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div> : null}
                  <div><label className={label}>Note</label><Input value={seedForm.note} onChange={(e) => setSeedForm({ ...seedForm, note: e.target.value })} /></div>
                  <div className="flex justify-end"><Button size="sm" disabled={pending || !seedForm.amount} onClick={() => run('Seed fund movement posted.', () => recordSeedFund(entity.id, { kind: seedForm.kind, date: seedForm.date, amountMinor: Math.round(Number(seedForm.amount) * 100), bankAccountId: seedForm.kind === 'offset' ? null : seedForm.bankAccountId, note: seedForm.note }), () => setSeedForm({ ...seedForm, amount: '', note: '' }))}>Post</Button></div>
                </div>
              </Card>
              <Card className="rounded-2xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">CMC payment received</p>
                <div className="mt-3 space-y-3">
                  <div><label className={label}>Amount</label><Input type="number" inputMode="decimal" min={0} step="0.01" value={cmcForm.amount} onChange={(e) => setCmcForm({ ...cmcForm, amount: e.target.value })} /></div>
                  <div><label className={label}>Date</label><Input type="date" value={cmcForm.date} onChange={(e) => setCmcForm({ ...cmcForm, date: e.target.value })} /></div>
                  <div><label className={label}>Into</label><select value={cmcForm.bankAccountId} className={selectClass} onChange={(e) => setCmcForm({ ...cmcForm, bankAccountId: e.target.value })}>{bankAccounts.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
                  <div className="flex justify-end"><Button size="sm" disabled={pending || !cmcForm.amount} onClick={() => run('CMC payment posted.', () => recordCmcReceipt(entity.id, { date: cmcForm.date, amountMinor: Math.round(Number(cmcForm.amount) * 100), bankAccountId: cmcForm.bankAccountId }), () => setCmcForm({ ...cmcForm, amount: '' }))}>Post</Button></div>
                </div>
              </Card>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type DetailProps = {
  contract: SalesContractRecord;
  margin: ReturnType<typeof contractMargin>;
  entity: EntityRecord;
  itemById: Map<string, ItemRecord>;
  commodity: CommodityRecord | undefined;
  locations: StockLocationRecord[];
  balances: StockBalanceRecord[];
  deliveryForm: { date: string; locationId: string; quantity: string; unit: StockUnit; rate: string; destination: string; note: string };
  setDeliveryForm: (f: DetailProps['deliveryForm']) => void;
  acceptDate: string;
  setAcceptDate: (d: string) => void;
  pending: boolean;
  allowed: (permission: Permission) => boolean;
  run: (ok: string, action: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => void;
  onEdit: () => void;
  todayRate: string | null;
};

function ContractDetail({ contract, margin, entity, itemById, commodity, locations, balances, deliveryForm, setDeliveryForm, acceptDate, setAcceptDate, pending, allowed, run, onEdit, todayRate }: DetailProps) {
  const item = itemById.get(contract.itemId);
  const foreign = contract.currency !== entity.functionalCurrency;
  const stockAt = (locationId: string) => balances.find((b) => b.itemId === contract.itemId && b.locationId === locationId)?.quantityGrams ?? 0;
  const warehouses = locations.filter((l) => l.isActive && l.code !== 'DELIVERED');
  const rateLine = (view: NonNullable<typeof margin.atContractRate>, title: string) => (
    <div className="rounded-xl border border-slate-200 p-3 text-sm">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{title} · {view.rate}</div>
      <div className="mt-1 flex justify-between"><span>Revenue restated</span><Money value={view.revenueMinor} /></div>
      <div className="flex justify-between font-semibold"><span>Gross margin</span><Money value={view.grossMarginMinor} /></div>
      <div className="flex justify-between text-slate-600"><span>per kg</span><Money value={view.marginPerKgMinor} /></div>
    </div>
  );

  return (
    <>
      <Card className="rounded-2xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{contract.contractNo} · {contract.status}</p>
            <h3 className="mt-1 text-xl font-semibold text-slate-900">{contract.buyerName} · {item?.name}</h3>
            <p className="mt-1 text-sm text-slate-600">{formatKg(contract.quantityGrams)}{commodity ? ` (${bagsOf(contract.quantityGrams, commodity.gramsPerBag).toFixed(0)} bags)` : ''} at {contract.currency} {(contract.priceMinor / 100).toFixed(2)} per {contract.priceUnit} · {contract.deliveryTerms} · {contract.deliveryFrom} to {contract.deliveryTo} · revenue on {contract.recognizeOn} · {contract.saleType}{contract.isCmc ? ' · CMC' : ''}{foreign && contract.contractRate ? ` · contract rate ${contract.contractRate}` : ''}</p>
          </div>
          <div className="flex gap-2">
            {contract.status === 'open' && contract.deliveries.length === 0 && allowed('document:draft') ? <Button size="sm" variant="secondary" onClick={onEdit}>Edit</Button> : null}
            {contract.status === 'open' && allowed('document:post') ? <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(`${contract.contractNo} closed.`, () => setContractStatus(entity.id, contract.id, 'closed'))}>Close</Button> : null}
            {contract.status === 'open' && contract.deliveries.length === 0 && allowed('document:post') ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(`${contract.contractNo} cancelled.`, () => setContractStatus(entity.id, contract.id, 'cancelled'))}>Cancel</Button> : null}
            {contract.status !== 'open' && allowed('document:post') ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(`${contract.contractNo} reopened.`, () => setContractStatus(entity.id, contract.id, 'open'))}>Reopen</Button> : null}
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          {[['Delivered', formatKg(margin.deliveredGrams)], ['Undelivered', formatKg(margin.undeliveredGrams)], ['Revenue', <Money key="r" value={margin.revenueTxnMinor} currency={contract.currency} />], ['Gross margin / kg', <Money key="m" value={margin.marginPerKgMinor} />]].map(([title, value]) => (
            <div key={title as string} className="rounded-xl border border-slate-200 bg-slate-50 p-3"><div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{title as string}</div><div className="mt-1 font-mono text-lg tabular-nums">{value}</div></div>
          ))}
        </div>
      </Card>

      <Card className="rounded-2xl">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Margin</p>
        <div className="mt-3 grid gap-4 md:grid-cols-[1fr_1fr]">
          <div className="rounded-xl border border-slate-200 p-4 text-sm">
            <div className="flex justify-between"><span>Revenue recognised ({formatKg(margin.recognisedGrams)})</span><Money value={margin.revenueMinor} /></div>
            {foreign ? <div className="flex justify-between text-xs text-slate-500"><span>in {contract.currency}, at the delivery-date rates</span><Money value={margin.revenueTxnMinor} currency={contract.currency} /></div> : null}
            {margin.allowancesMinor ? <div className="flex justify-between"><span>Buyer&rsquo;s margin and haulage</span><Money value={margin.allowancesMinor} /></div> : null}
            <div className="flex justify-between"><span>Cost of stock delivered</span><span>− <Money value={margin.costMinor} /></span></div>
            <div className="flex justify-between"><span>Selling costs</span><span>− <Money value={margin.sellingMinor} /></span></div>
            <div className="mt-2 flex justify-between border-t border-slate-200 pt-2 font-semibold"><span>Gross margin</span><Money value={margin.grossMarginMinor} /></div>
            <div className="flex justify-between text-slate-600"><span>per kg delivered</span><Money value={margin.marginPerKgMinor} /></div>
            {contract.sellingCosts.length ? <div className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-600">{contract.sellingCosts.map((c) => <div key={c.id} className="flex justify-between"><span>{c.date} · {sellingCostLabels[c.kind]} · {c.description}</span><Money value={c.amountMinor} /></div>)}</div> : <p className="mt-3 text-xs text-slate-500">Selling costs come from bill lines attributed to this contract (Purchases → line → Stock → Selling cost).</p>}
          </div>
          {foreign ? (
            <div className="space-y-3">
              {margin.atContractRate ? rateLine(margin.atContractRate, 'At the contract rate') : <p className="text-xs text-slate-500">No contract rate recorded.</p>}
              {margin.atTodayRate ? rateLine(margin.atTodayRate, "At today's rate") : <p className="text-xs text-slate-500">No {contract.currency} rate on file for today.</p>}
              {margin.exposure ? (
                <div className={['rounded-xl border p-3 text-sm', (margin.exposure.differenceMinor ?? 0) < 0 ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50'].join(' ')}>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">FX exposure on the undelivered balance</div>
                  <div className="mt-1 flex justify-between"><span>{formatKg(margin.undeliveredGrams)} still to deliver</span><Money value={margin.exposure.undeliveredTxnMinor} currency={contract.currency} /></div>
                  {margin.exposure.atContractRateMinor !== null ? <div className="flex justify-between"><span>at the contract rate</span><Money value={margin.exposure.atContractRateMinor} /></div> : null}
                  {margin.exposure.atTodayRateMinor !== null ? <div className="flex justify-between"><span>at today&rsquo;s rate</span><Money value={margin.exposure.atTodayRateMinor} /></div> : null}
                  {margin.exposure.differenceMinor !== null ? <div className="flex justify-between font-semibold"><span>Difference</span><Money value={margin.exposure.differenceMinor} /></div> : <p className="text-xs text-slate-500">Needs both rates.</p>}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>

      <Card className="rounded-2xl">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Deliveries</p>
        <div className="mt-3 divide-y divide-slate-200 text-sm">
          {contract.deliveries.map((d) => (
            <div key={d.id} className="py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span><span className="font-medium text-slate-900">#{d.deliveryNo} · {d.date}</span> · {formatKg(d.grams)} from {locations.find((l) => l.id === d.locationId)?.name}{d.destination ? ` → ${d.destination}` : ''}</span>
                <span className="flex items-center gap-3 font-mono text-xs"><span>rev <Money value={d.revenueMinor} /></span><span>cost <Money value={d.costMinor} /></span>{d.status === 'awaiting-acceptance' ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-800">awaiting acceptance</span> : d.status === 'accepted' ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-800">accepted</span> : null}</span>
              </div>
              {d.journal ? <div className="mt-1 text-xs text-slate-500">{d.journal.lines.map((l) => `${l.accountCode} ${l.type === 'debit' ? 'in' : 'out'} ${(l.amount / 100).toFixed(2)}`).join(' · ')}</div> : null}
              {d.status === 'awaiting-acceptance' && allowed('document:post') ? <div className="mt-2 flex items-center gap-2"><Input type="date" className="w-44" value={acceptDate} onChange={(e) => setAcceptDate(e.target.value)} /><Button size="sm" disabled={pending} onClick={() => run('Delivery accepted; revenue recognised.', () => acceptDelivery(entity.id, d.id, acceptDate))}>Buyer accepted</Button></div> : null}
            </div>
          ))}
          {contract.deliveries.length === 0 ? <p className="py-2 text-slate-600">None yet.</p> : null}
        </div>
        {contract.status === 'open' && allowed('document:post') ? (
          <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Record a delivery</p>
            <div className="mt-2 grid gap-3 md:grid-cols-3">
              <div><label className={label}>From</label><select value={deliveryForm.locationId} className={selectClass} onChange={(e) => setDeliveryForm({ ...deliveryForm, locationId: e.target.value })}><option value="">Choose…</option>{warehouses.map((l) => <option key={l.id} value={l.id}>{l.name} · {formatKg(stockAt(l.id))}</option>)}</select></div>
              <div className="grid grid-cols-[1fr_100px] gap-2">
                <div><label className={label}>Quantity</label><Input type="number" inputMode="decimal" min={0} step="any" value={deliveryForm.quantity} onChange={(e) => setDeliveryForm({ ...deliveryForm, quantity: e.target.value })} /></div>
                <div><label className={label}>Unit</label><select value={deliveryForm.unit} className={selectClass} onChange={(e) => setDeliveryForm({ ...deliveryForm, unit: e.target.value as StockUnit })}><option value="tonne">tonnes</option><option value="kg">kg</option><option value="bag">bags</option></select></div>
              </div>
              <div><label className={label}>Date</label><Input type="date" value={deliveryForm.date} onChange={(e) => setDeliveryForm({ ...deliveryForm, date: e.target.value })} /></div>
              {foreign ? <div><label className={label}>Rate ({entity.functionalCurrency} per 1 {contract.currency})</label><Input inputMode="decimal" value={deliveryForm.rate} placeholder={todayRate ?? 'from the rate table'} onChange={(e) => setDeliveryForm({ ...deliveryForm, rate: e.target.value })} /></div> : null}
              <div><label className={label}>{contract.isCmc ? 'Take-over centre' : 'Destination'}</label><Input value={deliveryForm.destination} placeholder={contract.isCmc ? 'CMC Kumasi' : 'Tema port'} onChange={(e) => setDeliveryForm({ ...deliveryForm, destination: e.target.value })} /></div>
              <div><label className={label}>Note</label><Input value={deliveryForm.note} onChange={(e) => setDeliveryForm({ ...deliveryForm, note: e.target.value })} /></div>
            </div>
            <p className="mt-2 text-xs text-slate-500">Stock leaves at the location&rsquo;s weighted average cost; revenue is {formatKg(margin.undeliveredGrams)} × the contract price{foreign ? `, converted at the delivery-date rate and fixed` : ''}. {contract.recognizeOn === 'acceptance' ? 'Revenue waits for the buyer’s acceptance; until then the cost sits in Goods in Transit.' : ''}</p>
            <div className="mt-3 flex justify-end"><Button size="sm" disabled={pending || !deliveryForm.locationId || !deliveryForm.quantity} onClick={() => run('Delivery posted.', () => recordDelivery(entity.id, { contractId: contract.id, date: deliveryForm.date, locationId: deliveryForm.locationId, quantity: Number(deliveryForm.quantity), unit: deliveryForm.unit, rate: deliveryForm.rate || null, destination: deliveryForm.destination, note: deliveryForm.note }), () => setDeliveryForm({ ...deliveryForm, quantity: '', note: '' }))}>Post delivery</Button></div>
          </div>
        ) : null}
      </Card>
    </>
  );
}
