'use client';

/**
 * The Inventory screen: stock on hand with its ledger reconciliation, items,
 * locations, movements (transfers and adjustments), stock counts and the
 * NRV report. Every change goes through a Server Function in
 * src/app/actions/inventory.ts; this file only decides what to show.
 */

import { useMemo, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import {
  adjustStock,
  postStockCount,
  saveItem,
  saveLocation,
  saveStockCount,
  setNrvPrice,
  transferStock,
  writeDownToNrv,
} from '@/app/actions/inventory';
import type { Permission } from '@/lib/authz';
import type {
  AccountRecord,
  EntityRecord,
  InventoryLedgerRow,
  ItemRecord,
  NrvPriceRecord,
  StockBalanceRecord,
  StockCountRecord,
  StockLocationRecord,
  StockMovementRecord,
} from '@/lib/data/types';
import {
  adjustmentReasons,
  averageCostPerKg,
  categoriesFor,
  categoryLabels,
  countDifferences,
  defaultAccountCodeFor,
  formatInUnit,
  formatKg,
  fromGrams,
  inventoryAccountCategory,
  nrvAssessment,
  reasonLabels,
  reconcileStockToLedger,
  stockUnits,
  toGrams,
  unitLabels,
  type AdjustmentReason,
  type ItemCategory,
  type StockPosition,
  type StockUnit,
} from '@/lib/inventory';

type Props = {
  entity: EntityRecord;
  accounts: AccountRecord[];
  items: ItemRecord[];
  locations: StockLocationRecord[];
  balances: StockBalanceRecord[];
  movements: StockMovementRecord[];
  counts: StockCountRecord[];
  nrvPrices: NrvPriceRecord[];
  ledger: InventoryLedgerRow[];
  allowed: (permission: Permission) => boolean;
};

type Tab = 'Stock' | 'Items' | 'Locations' | 'Movements' | 'Counts' | 'NRV';
const tabs: Tab[] = ['Stock', 'Items', 'Locations', 'Movements', 'Counts', 'NRV'];

const selectClass = 'min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50';
const label = 'mb-1.5 block text-sm font-medium text-slate-700';
const todayIso = () => new Date().toISOString().slice(0, 10);
const currentPeriod = () => todayIso().slice(0, 7);
const kindLabels: Record<StockMovementRecord['kind'], string> = { receipt: 'Receipt', 'receipt-reversal': 'Receipt reversed', transfer: 'Transfer', adjustment: 'Adjustment', 'write-down': 'Write-down' };

export function InventoryPanel({ entity, accounts, items, locations, balances, movements, counts, nrvPrices, ledger, allowed }: Props) {
  const [tab, setTab] = useState<Tab>('Stock');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const locationById = useMemo(() => new Map(locations.map((location) => [location.id, location])), [locations]);
  const activeItems = items.filter((item) => item.isActive);
  const activeLocations = locations.filter((location) => location.isActive);
  const inventoryAccounts = accounts.filter((account) => account.isActive && account.category === inventoryAccountCategory);

  /** Position per item across locations — what its average cost is. */
  const positionByItem = useMemo(() => {
    const map = new Map<string, StockPosition>();
    for (const balance of balances) {
      const current = map.get(balance.itemId) ?? { quantityGrams: 0, valueMinor: 0 };
      map.set(balance.itemId, { quantityGrams: current.quantityGrams + balance.quantityGrams, valueMinor: current.valueMinor + balance.valueMinor });
    }
    return map;
  }, [balances]);

  // Stock value per inventory account (the item's account, or the location's override).
  const reconciliation = useMemo(() => {
    const stockByAccount: Record<string, number> = {};
    for (const balance of balances) {
      const item = itemById.get(balance.itemId);
      const location = locationById.get(balance.locationId);
      if (!item) continue;
      const code = location?.accountCode ?? item.accountCode;
      stockByAccount[code] = (stockByAccount[code] ?? 0) + balance.valueMinor;
    }
    const ledgerByAccount = Object.fromEntries(ledger.map((row) => [row.accountCode, row.balanceMinor]));
    return reconcileStockToLedger(stockByAccount, ledgerByAccount);
  }, [balances, itemById, locationById, ledger]);

  function run(okText: string, action: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setMessage({ tone: 'ok', text: okText });
        after?.();
      } else {
        setMessage({ tone: 'error', text: result.error ?? 'Something went wrong.' });
      }
    });
  }

  const accountName = (code: string) => accounts.find((account) => account.code === code)?.name ?? code;

  // --- forms -------------------------------------------------------------------------

  const blankItem = { id: '', code: '', name: '', category: categoriesFor(entity.type)[0] as ItemCategory, baseUnit: 'kg' as StockUnit, kgPerBag: '', kgPerCarton: '', accountCode: '' };
  const [itemForm, setItemForm] = useState(blankItem);
  const [locationForm, setLocationForm] = useState({ id: '', code: '', name: '', accountCode: '' });
  const [transferForm, setTransferForm] = useState({ itemId: '', fromLocationId: '', toLocationId: '', quantity: '', unit: 'kg' as StockUnit, date: todayIso(), note: '' });
  const [adjustForm, setAdjustForm] = useState({ itemId: '', locationId: '', quantity: '', unit: 'kg' as StockUnit, reason: 'count-difference' as AdjustmentReason, date: todayIso(), note: '', unitCost: '' });
  const [countForm, setCountForm] = useState<{ id: string; locationId: string; date: string; note: string; counted: Record<string, string> }>({ id: '', locationId: '', date: todayIso(), note: '', counted: {} });
  const [countConfirmed, setCountConfirmed] = useState(false);
  const [nrvPeriod, setNrvPeriod] = useState(currentPeriod());
  const [nrvInputs, setNrvInputs] = useState<Record<string, string>>({});
  const [nrvDate, setNrvDate] = useState(todayIso());

  const unitsFor = (item: ItemRecord | undefined): StockUnit[] =>
    stockUnits.filter((unit) => unit === 'kg' || unit === 'tonne' || (unit === 'bag' && !!item?.gramsPerBag) || (unit === 'carton' && !!item?.gramsPerCarton));

  // --- the count being edited, with its preview ------------------------------------------

  const countLocation = locationById.get(countForm.locationId);
  const countRows = countLocation
    ? activeItems.map((item) => {
        const expected = balances.find((b) => b.itemId === item.id && b.locationId === countLocation.id)?.quantityGrams ?? 0;
        const typed = countForm.counted[item.id];
        let countedGrams: number | null = null;
        if (typed !== undefined && typed.trim() !== '') {
          try {
            countedGrams = toGrams(Number(typed), item.baseUnit, item);
          } catch {
            countedGrams = null;
          }
        }
        return { item, expectedGrams: expected, countedGrams, position: positionByItem.get(item.id) ?? { quantityGrams: 0, valueMinor: 0 } };
      })
    : [];
  const countPreview = countDifferences(countRows.map((row) => ({ itemId: row.item.id, expectedGrams: row.expectedGrams, countedGrams: row.countedGrams, position: row.position })));
  const savedCount = counts.find((count) => count.id === countForm.id);

  function openCount(count: StockCountRecord) {
    const counted: Record<string, string> = {};
    for (const line of count.lines) {
      const item = itemById.get(line.itemId);
      if (item && line.countedGrams !== null) counted[line.itemId] = String(fromGrams(line.countedGrams, item.baseUnit, item));
    }
    setCountForm({ id: count.id, locationId: count.locationId, date: count.date, note: count.note, counted });
    setCountConfirmed(false);
    setTab('Counts');
  }

  // --- NRV rows ------------------------------------------------------------------------

  const nrvPriceOf = (itemId: string) => nrvPrices.find((price) => price.itemId === itemId && price.period === nrvPeriod)?.sellingPriceMinorPerKg;
  const nrvRows = nrvAssessment(
    activeItems.map((item) => ({ itemId: item.id, ...(positionByItem.get(item.id) ?? { quantityGrams: 0, valueMinor: 0 }) })).filter((row) => row.quantityGrams > 0),
    Object.fromEntries(activeItems.map((item) => [item.id, nrvPriceOf(item.id)])),
  );

  // --- render ----------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{entity.name}</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-900">Inventory</h2>
          {entity.type === 'programs' ? <p className="mt-1 text-sm text-slate-600">Raw produce in transit only — {entity.name} does not hold processed stock.</p> : null}
        </div>
        <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1">
          {tabs.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => setTab(candidate)}
              className={['rounded-lg px-3 py-2 text-sm font-medium', tab === candidate ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'].join(' ')}
            >
              {candidate}
            </button>
          ))}
        </div>
      </div>

      {message ? (
        <p className={['rounded-lg border px-3 py-2 text-sm', message.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800'].join(' ')}>{message.text}</p>
      ) : null}

      {/* ---------------------------------------------------------------- Stock */}
      {tab === 'Stock' ? (
        <>
          <Card className={['rounded-2xl', reconciliation.agrees ? '' : 'border-red-300 bg-red-50'].join(' ')}>
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Live stock value</p>
                <div className="mt-2 font-mono text-3xl tabular-nums text-slate-900"><Money value={reconciliation.stockTotal} /></div>
                <p className="mt-1 text-sm text-slate-600">
                  {reconciliation.agrees
                    ? 'Reconciles exactly to the inventory accounts in the ledger.'
                    : 'Does not reconcile to the inventory accounts in the ledger — see the accounts below.'}
                </p>
              </div>
              <div className="min-w-[320px]">
                <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 gap-y-1 text-xs">
                  <span className="font-semibold uppercase tracking-[0.12em] text-slate-500">Account</span>
                  <span className="text-right font-semibold uppercase tracking-[0.12em] text-slate-500">Stock</span>
                  <span className="text-right font-semibold uppercase tracking-[0.12em] text-slate-500">Ledger</span>
                  <span className="text-right font-semibold uppercase tracking-[0.12em] text-slate-500">Diff</span>
                  {reconciliation.rows.map((row) => (
                    <div key={row.accountCode} className="contents">
                      <span className={row.differenceMinor !== 0 ? 'font-semibold text-red-800' : 'text-slate-700'}>{row.accountCode} · {accountName(row.accountCode)}</span>
                      <span className="text-right"><Money value={row.stockMinor} /></span>
                      <span className="text-right"><Money value={row.ledgerMinor} /></span>
                      <span className={['text-right', row.differenceMinor !== 0 ? 'font-semibold text-red-800' : 'text-slate-500'].join(' ')}><Money value={row.differenceMinor} /></span>
                    </div>
                  ))}
                  {reconciliation.rows.length === 0 ? <span className="col-span-4 text-slate-500">No inventory accounts have been posted to yet.</span> : null}
                </div>
              </div>
            </div>
            {!reconciliation.agrees ? (
              <p className="mt-4 rounded-xl bg-red-100 px-4 py-3 text-sm font-medium text-red-900">
                Warning: stock value and the ledger disagree. The usual cause is a bill line posted to an inventory account without naming an item, or a manual journal to an inventory account. Find it in the journal for the account shown in red and either receive the stock or move the posting.
              </p>
            ) : null}
          </Card>

          <Card className="rounded-2xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">On hand</p>
            <h3 className="mt-1 text-xl font-semibold text-slate-900">Stock by item and location</h3>
            {activeItems.length === 0 ? (
              <p className="mt-3 text-sm text-slate-600">No items yet. Add them under Items, then receive stock by posting a bill whose lines name the item and the location.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <div className="grid min-w-[760px] grid-cols-[1.4fr_1fr_1fr_0.9fr_1fr] gap-3 rounded-t-xl bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                  <span>Item</span><span>Location</span><span className="text-right">Quantity</span><span className="text-right">Avg cost / kg</span><span className="text-right">Value</span>
                </div>
                {activeItems.map((item) => {
                  const position = positionByItem.get(item.id) ?? { quantityGrams: 0, valueMinor: 0 };
                  const rows = balances.filter((b) => b.itemId === item.id && (b.quantityGrams !== 0 || b.valueMinor !== 0));
                  const avg = averageCostPerKg(position);
                  return (
                    <div key={item.id} className="border-t border-slate-200">
                      <div className="grid grid-cols-[1.4fr_1fr_1fr_0.9fr_1fr] gap-3 px-4 py-2 text-sm">
                        <span><span className="font-mono text-xs text-slate-500">{item.code}</span> <span className="font-medium text-slate-900">{item.name}</span><span className="ml-2 text-[10px] uppercase tracking-[0.12em] text-slate-500">{categoryLabels[item.category]}</span></span>
                        <span className="text-slate-500">all locations</span>
                        <span className="text-right font-mono text-slate-900">{formatKg(position.quantityGrams)}<span className="block text-[11px] text-slate-500">{item.baseUnit !== 'kg' ? formatInUnit(position.quantityGrams, item) : ''}</span></span>
                        <span className="text-right font-mono">{avg === null ? '—' : <Money value={avg} />}</span>
                        <span className="text-right font-mono font-semibold"><Money value={position.valueMinor} /></span>
                      </div>
                      {rows.map((row) => (
                        <div key={row.locationId} className="grid grid-cols-[1.4fr_1fr_1fr_0.9fr_1fr] gap-3 px-4 py-1 text-xs text-slate-600">
                          <span />
                          <span>{locationById.get(row.locationId)?.name ?? row.locationId}{locationById.get(row.locationId)?.accountCode ? ` · ${locationById.get(row.locationId)?.accountCode}` : ''}</span>
                          <span className="text-right font-mono">{formatKg(row.quantityGrams)}</span>
                          <span />
                          <span className="text-right font-mono"><Money value={row.valueMinor} /></span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </>
      ) : null}

      {/* ---------------------------------------------------------------- Items */}
      {tab === 'Items' ? (
        <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <Card className="rounded-2xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Items</p>
            <h3 className="mt-1 text-xl font-semibold text-slate-900">{items.length} item{items.length === 1 ? '' : 's'}</h3>
            <div className="mt-4 divide-y divide-slate-200">
              {items.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div>
                    <span className="font-mono text-xs text-slate-500">{item.code}</span> <span className="font-medium text-slate-900">{item.name}</span>
                    <div className="text-xs text-slate-500">
                      {categoryLabels[item.category]} · counted in {unitLabels[item.baseUnit]}
                      {item.gramsPerBag ? ` · ${item.gramsPerBag / 1000} kg/bag` : ''}{item.gramsPerCarton ? ` · ${item.gramsPerCarton / 1000} kg/carton` : ''} · {item.accountCode} {item.accountName}{item.isActive ? '' : ' · inactive'}
                    </div>
                  </div>
                  {allowed('inventory:manage') ? (
                    <Button size="sm" variant="ghost" onClick={() => setItemForm({ id: item.id, code: item.code, name: item.name, category: item.category, baseUnit: item.baseUnit, kgPerBag: item.gramsPerBag ? String(item.gramsPerBag / 1000) : '', kgPerCarton: item.gramsPerCarton ? String(item.gramsPerCarton / 1000) : '', accountCode: item.accountCode })}>Edit</Button>
                  ) : null}
                </div>
              ))}
              {items.length === 0 ? <p className="py-2 text-sm text-slate-600">No items yet.</p> : null}
            </div>
          </Card>
          {allowed('inventory:manage') ? (
            <Card className="rounded-2xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{itemForm.id ? 'Edit item' : 'New item'}</p>
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-[110px_1fr] gap-3">
                  <div><label className={label}>Code</label><Input value={itemForm.code} onChange={(e) => setItemForm({ ...itemForm, code: e.target.value })} placeholder="RCN" /></div>
                  <div><label className={label}>Name</label><Input value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} placeholder="Raw cashew nuts" /></div>
                </div>
                <div>
                  <label className={label}>Category</label>
                  <select value={itemForm.category} className={selectClass} onChange={(e) => { const category = e.target.value as ItemCategory; setItemForm({ ...itemForm, category, accountCode: defaultAccountCodeFor(entity.type, category) }); }}>
                    {categoriesFor(entity.type).map((category) => <option key={category} value={category}>{categoryLabels[category]}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className={label}>Counted in</label>
                    <select value={itemForm.baseUnit} className={selectClass} onChange={(e) => setItemForm({ ...itemForm, baseUnit: e.target.value as StockUnit })}>
                      {stockUnits.map((unit) => <option key={unit} value={unit}>{unitLabels[unit]}</option>)}
                    </select>
                  </div>
                  <div><label className={label}>kg per bag</label><Input type="number" min={0} step="0.001" value={itemForm.kgPerBag} onChange={(e) => setItemForm({ ...itemForm, kgPerBag: e.target.value })} placeholder="80" /></div>
                  <div><label className={label}>kg per carton</label><Input type="number" min={0} step="0.001" value={itemForm.kgPerCarton} onChange={(e) => setItemForm({ ...itemForm, kgPerCarton: e.target.value })} placeholder="12.5" /></div>
                </div>
                <div>
                  <label className={label}>Carried in account</label>
                  <select value={itemForm.accountCode || defaultAccountCodeFor(entity.type, itemForm.category)} className={selectClass} onChange={(e) => setItemForm({ ...itemForm, accountCode: e.target.value })}>
                    {inventoryAccounts.map((account) => <option key={account.code} value={account.code}>{account.code} · {account.name}</option>)}
                  </select>
                </div>
                <p className="text-xs text-slate-500">Everything is stored in kilograms; bags, cartons and tonnes convert through these factors. A tonne is always 1,000 kg.</p>
                <div className="flex justify-end gap-2">
                  {itemForm.id ? <Button variant="secondary" size="sm" onClick={() => setItemForm(blankItem)}>Cancel</Button> : null}
                  <Button size="sm" disabled={pending} onClick={() => run(`Item ${itemForm.code.toUpperCase()} saved.`, () => saveItem(entity.id, {
                    id: itemForm.id || undefined, code: itemForm.code, name: itemForm.name, category: itemForm.category, baseUnit: itemForm.baseUnit,
                    gramsPerBag: itemForm.kgPerBag ? Math.round(Number(itemForm.kgPerBag) * 1000) : null,
                    gramsPerCarton: itemForm.kgPerCarton ? Math.round(Number(itemForm.kgPerCarton) * 1000) : null,
                    accountCode: itemForm.accountCode || defaultAccountCodeFor(entity.type, itemForm.category),
                  }), () => setItemForm(blankItem))}>
                    {itemForm.id ? 'Save changes' : 'Add item'}
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- Locations */}
      {tab === 'Locations' ? (
        <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <Card className="rounded-2xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Locations</p>
            <h3 className="mt-1 text-xl font-semibold text-slate-900">Warehouses and storage points</h3>
            <div className="mt-4 divide-y divide-slate-200">
              {locations.map((location) => (
                <div key={location.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div>
                    <span className="font-mono text-xs text-slate-500">{location.code}</span> <span className="font-medium text-slate-900">{location.name}</span>
                    <div className="text-xs text-slate-500">{location.accountCode ? `Stock here is carried in ${location.accountCode} ${accountName(location.accountCode)}` : "Stock here is carried in each item's own account"}{location.isActive ? '' : ' · inactive'}</div>
                  </div>
                  {allowed('inventory:manage') ? <Button size="sm" variant="ghost" onClick={() => setLocationForm({ id: location.id, code: location.code, name: location.name, accountCode: location.accountCode ?? '' })}>Edit</Button> : null}
                </div>
              ))}
              {locations.length === 0 ? <p className="py-2 text-sm text-slate-600">No locations yet. Add at least one before receiving stock.</p> : null}
            </div>
          </Card>
          {allowed('inventory:manage') ? (
            <Card className="rounded-2xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{locationForm.id ? 'Edit location' : 'New location'}</p>
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-[110px_1fr] gap-3">
                  <div><label className={label}>Code</label><Input value={locationForm.code} onChange={(e) => setLocationForm({ ...locationForm, code: e.target.value })} placeholder="WH1" /></div>
                  <div><label className={label}>Name</label><Input value={locationForm.name} onChange={(e) => setLocationForm({ ...locationForm, name: e.target.value })} placeholder="Main warehouse" /></div>
                </div>
                <div>
                  <label className={label}>Account override</label>
                  <select value={locationForm.accountCode} className={selectClass} onChange={(e) => setLocationForm({ ...locationForm, accountCode: e.target.value })}>
                    <option value="">None — each item&apos;s own account</option>
                    {inventoryAccounts.map((account) => <option key={account.code} value={account.code}>{account.code} · {account.name}</option>)}
                  </select>
                  <p className="mt-1 text-xs text-slate-500">Use for a location like Goods in Transit: transfers into and out of it post between the two accounts.</p>
                </div>
                <div className="flex justify-end gap-2">
                  {locationForm.id ? <Button variant="secondary" size="sm" onClick={() => setLocationForm({ id: '', code: '', name: '', accountCode: '' })}>Cancel</Button> : null}
                  <Button size="sm" disabled={pending} onClick={() => run(`Location ${locationForm.code.toUpperCase()} saved.`, () => saveLocation(entity.id, { id: locationForm.id || undefined, code: locationForm.code, name: locationForm.name, accountCode: locationForm.accountCode || null }), () => setLocationForm({ id: '', code: '', name: '', accountCode: '' }))}>
                    {locationForm.id ? 'Save changes' : 'Add location'}
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- Movements */}
      {tab === 'Movements' ? (
        <>
          {allowed('stock:post') ? (
            <div className="grid gap-6 xl:grid-cols-2">
              <Card className="rounded-2xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Transfer</p>
                <h3 className="mt-1 text-xl font-semibold text-slate-900">Move stock between locations</h3>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div className="md:col-span-2"><label className={label}>Item</label>
                    <select value={transferForm.itemId} className={selectClass} onChange={(e) => setTransferForm({ ...transferForm, itemId: e.target.value, unit: itemById.get(e.target.value)?.baseUnit ?? 'kg' })}>
                      <option value="">Choose…</option>{activeItems.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
                    </select></div>
                  <div><label className={label}>From</label><select value={transferForm.fromLocationId} className={selectClass} onChange={(e) => setTransferForm({ ...transferForm, fromLocationId: e.target.value })}><option value="">Choose…</option>{activeLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
                  <div><label className={label}>To</label><select value={transferForm.toLocationId} className={selectClass} onChange={(e) => setTransferForm({ ...transferForm, toLocationId: e.target.value })}><option value="">Choose…</option>{activeLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
                  <div><label className={label}>Quantity</label><Input type="number" min={0} step="any" value={transferForm.quantity} onChange={(e) => setTransferForm({ ...transferForm, quantity: e.target.value })} /></div>
                  <div><label className={label}>Unit</label><select value={transferForm.unit} className={selectClass} onChange={(e) => setTransferForm({ ...transferForm, unit: e.target.value as StockUnit })}>{unitsFor(itemById.get(transferForm.itemId)).map((unit) => <option key={unit} value={unit}>{unitLabels[unit]}</option>)}</select></div>
                  <div><label className={label}>Date</label><Input type="date" value={transferForm.date} onChange={(e) => setTransferForm({ ...transferForm, date: e.target.value })} /></div>
                  <div><label className={label}>Note</label><Input value={transferForm.note} onChange={(e) => setTransferForm({ ...transferForm, note: e.target.value })} /></div>
                </div>
                <div className="mt-3 flex justify-end">
                  <Button size="sm" disabled={pending || !transferForm.itemId || !transferForm.fromLocationId || !transferForm.toLocationId || !transferForm.quantity} onClick={() => run('Transfer posted.', () => transferStock(entity.id, { ...transferForm, quantity: Number(transferForm.quantity) }), () => setTransferForm({ ...transferForm, quantity: '', note: '' }))}>Post transfer</Button>
                </div>
              </Card>
              <Card className="rounded-2xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Adjustment</p>
                <h3 className="mt-1 text-xl font-semibold text-slate-900">Change a quantity, with a reason</h3>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div className="md:col-span-2"><label className={label}>Item</label>
                    <select value={adjustForm.itemId} className={selectClass} onChange={(e) => setAdjustForm({ ...adjustForm, itemId: e.target.value, unit: itemById.get(e.target.value)?.baseUnit ?? 'kg' })}>
                      <option value="">Choose…</option>{activeItems.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
                    </select></div>
                  <div><label className={label}>Location</label><select value={adjustForm.locationId} className={selectClass} onChange={(e) => setAdjustForm({ ...adjustForm, locationId: e.target.value })}><option value="">Choose…</option>{activeLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
                  <div><label className={label}>Reason</label><select value={adjustForm.reason} className={selectClass} onChange={(e) => setAdjustForm({ ...adjustForm, reason: e.target.value as AdjustmentReason })}>{adjustmentReasons.map((reason) => <option key={reason} value={reason}>{reasonLabels[reason]}</option>)}</select></div>
                  <div><label className={label}>Quantity (− removes)</label><Input type="number" step="any" value={adjustForm.quantity} onChange={(e) => setAdjustForm({ ...adjustForm, quantity: e.target.value })} placeholder="-12.5" /></div>
                  <div><label className={label}>Unit</label><select value={adjustForm.unit} className={selectClass} onChange={(e) => setAdjustForm({ ...adjustForm, unit: e.target.value as StockUnit })}>{unitsFor(itemById.get(adjustForm.itemId)).map((unit) => <option key={unit} value={unit}>{unitLabels[unit]}</option>)}</select></div>
                  <div><label className={label}>Date</label><Input type="date" value={adjustForm.date} onChange={(e) => setAdjustForm({ ...adjustForm, date: e.target.value })} /></div>
                  <div><label className={label}>Cost per kg (only for stock found with none on hand)</label><Input type="number" min={0} step="0.01" value={adjustForm.unitCost} onChange={(e) => setAdjustForm({ ...adjustForm, unitCost: e.target.value })} /></div>
                  <div className="md:col-span-2"><label className={label}>Note</label><Input value={adjustForm.note} onChange={(e) => setAdjustForm({ ...adjustForm, note: e.target.value })} placeholder="What happened" /></div>
                </div>
                <p className="mt-2 text-xs text-slate-500">Valued at the item&apos;s weighted average cost. The difference posts to 5030 Inventory Adjustments with the reason on the journal — nothing is applied silently.</p>
                <div className="mt-3 flex justify-end">
                  <Button size="sm" disabled={pending || !adjustForm.itemId || !adjustForm.locationId || !adjustForm.quantity} onClick={() => run('Adjustment posted.', () => adjustStock(entity.id, { ...adjustForm, quantity: Number(adjustForm.quantity), unitCostMinorPerKg: adjustForm.unitCost ? Math.round(Number(adjustForm.unitCost) * 100) : undefined }), () => setAdjustForm({ ...adjustForm, quantity: '', note: '', unitCost: '' }))}>Post adjustment</Button>
                </div>
              </Card>
            </div>
          ) : null}

          <Card className="rounded-2xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">History</p>
            <h3 className="mt-1 text-xl font-semibold text-slate-900">Stock movements</h3>
            <div className="mt-4 overflow-x-auto">
              <div className="grid min-w-[900px] grid-cols-[90px_110px_1.3fr_1.2fr_1fr_1fr_1fr] gap-3 rounded-t-xl bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                <span>Date</span><span>Kind</span><span>Item</span><span>Where</span><span className="text-right">Quantity</span><span className="text-right">Value</span><span>Reason / journal</span>
              </div>
              {movements.map((movement) => (
                <div key={movement.id} className="grid min-w-[900px] grid-cols-[90px_110px_1.3fr_1.2fr_1fr_1fr_1fr] gap-3 border-t border-slate-200 px-4 py-2 text-sm">
                  <span>{movement.date}</span>
                  <span>{kindLabels[movement.kind]}</span>
                  <span><span className="font-mono text-xs text-slate-500">{movement.itemCode}</span> {movement.itemName}</span>
                  <span className="text-slate-600">{movement.fromLocationId ? locationById.get(movement.fromLocationId)?.name : ''}{movement.fromLocationId && movement.toLocationId ? ' → ' : ''}{movement.toLocationId ? locationById.get(movement.toLocationId)?.name : ''}</span>
                  <span className={['text-right font-mono', movement.quantityGrams < 0 ? 'text-red-700' : 'text-slate-900'].join(' ')}>{movement.quantityGrams === 0 ? '—' : formatKg(movement.quantityGrams)}</span>
                  <span className={['text-right font-mono', movement.valueMinor < 0 ? 'text-red-700' : 'text-slate-900'].join(' ')}><Money value={movement.valueMinor} /></span>
                  <span className="text-xs text-slate-600">{movement.reason ? reasonLabels[movement.reason] : ''}{movement.journal ? ` · ${movement.journal.kind === 'STOCK' ? 'stock journal' : movement.journal.kind.toLowerCase()} ${movement.journal.postedAt}` : movement.kind === 'transfer' ? ' · same account, no ledger effect' : ''}{movement.note ? ` · ${movement.note}` : ''}</span>
                </div>
              ))}
              {movements.length === 0 ? <p className="px-4 py-3 text-sm text-slate-600">No movements yet.</p> : null}
            </div>
          </Card>
        </>
      ) : null}

      {/* ---------------------------------------------------------------- Counts */}
      {tab === 'Counts' ? (
        <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
          <Card className="rounded-2xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{countForm.id ? (savedCount?.status === 'posted' ? 'Posted count' : 'Draft count') : 'New count'}</p>
            <h3 className="mt-1 text-xl font-semibold text-slate-900">Stock count</h3>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <div><label className={label}>Location</label>
                <select value={countForm.locationId} className={selectClass} disabled={!!countForm.id} onChange={(e) => setCountForm({ ...countForm, locationId: e.target.value, counted: {} })}>
                  <option value="">Choose…</option>{activeLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select></div>
              <div><label className={label}>Date</label><Input type="date" value={countForm.date} disabled={savedCount?.status === 'posted'} onChange={(e) => setCountForm({ ...countForm, date: e.target.value })} /></div>
              <div><label className={label}>Note</label><Input value={countForm.note} disabled={savedCount?.status === 'posted'} onChange={(e) => setCountForm({ ...countForm, note: e.target.value })} /></div>
            </div>
            {countLocation ? (
              <div className="mt-4 overflow-x-auto">
                <div className="grid min-w-[640px] grid-cols-[1.4fr_1fr_1fr_1fr_1fr] gap-3 rounded-t-xl bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                  <span>Item</span><span className="text-right">Expected</span><span>Counted</span><span className="text-right">Difference</span><span className="text-right">Value</span>
                </div>
                {countRows.map((row) => {
                  const difference = countPreview.find((d) => d.itemId === row.item.id);
                  return (
                    <div key={row.item.id} className="grid min-w-[640px] grid-cols-[1.4fr_1fr_1fr_1fr_1fr] items-center gap-3 border-t border-slate-200 px-4 py-2 text-sm">
                      <span><span className="font-mono text-xs text-slate-500">{row.item.code}</span> {row.item.name}</span>
                      <span className="text-right font-mono">{formatKg(row.expectedGrams)}<span className="block text-[11px] text-slate-500">{row.item.baseUnit !== 'kg' ? formatInUnit(row.expectedGrams, row.item) : ''}</span></span>
                      <span className="flex items-center gap-2">
                        <Input type="number" min={0} step="any" value={countForm.counted[row.item.id] ?? ''} disabled={savedCount?.status === 'posted'} onChange={(e) => setCountForm({ ...countForm, counted: { ...countForm.counted, [row.item.id]: e.target.value } })} />
                        <span className="text-xs text-slate-500">{unitLabels[row.item.baseUnit]}</span>
                      </span>
                      <span className={['text-right font-mono', difference ? (difference.differenceGrams < 0 ? 'text-red-700' : 'text-emerald-700') : 'text-slate-400'].join(' ')}>{difference ? `${difference.differenceGrams > 0 ? '+' : '−'}${formatKg(Math.abs(difference.differenceGrams))}` : row.countedGrams === null ? 'not counted' : 'no change'}</span>
                      <span className="text-right font-mono">{difference ? (difference.unvalued ? <span className="text-xs text-amber-700">no cost on hand</span> : <Money value={difference.valueMinor} />) : ''}</span>
                    </div>
                  );
                })}
                {countRows.length === 0 ? <p className="px-4 py-3 text-sm text-slate-600">No items to count.</p> : null}
              </div>
            ) : null}

            {savedCount?.status === 'posted' ? (
              <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">Posted by {savedCount.postedByName} on {savedCount.postedAt?.slice(0, 10)}{savedCount.journal ? ` — stock journal dated ${savedCount.journal.postedAt}` : ' — no differences, nothing posted'}.</p>
            ) : countLocation ? (
              <>
                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                  <span className="font-medium text-slate-900">Preview:</span>{' '}
                  {countPreview.length === 0
                    ? 'no differences — posting would change nothing.'
                    : `${countPreview.length} adjustment${countPreview.length === 1 ? '' : 's'}, net value ${countPreview.reduce((s, d) => s + d.valueMinor, 0) >= 0 ? '+' : '−'}${(Math.abs(countPreview.reduce((s, d) => s + d.valueMinor, 0)) / 100).toFixed(2)}, each posted as a count-difference adjustment to 5030 in one stock journal dated ${countForm.date}.`}
                  {countPreview.some((d) => d.unvalued) ? ' One line found stock with no cost on hand; posting will be refused until it is received through a bill or adjusted with a cost per kg.' : ''}
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
                  {allowed('stock:enter') ? (
                    <Button variant="secondary" size="sm" disabled={pending} onClick={() => run('Count saved as a draft.', async () => {
                      const result = await saveStockCount(entity.id, { id: countForm.id || undefined, locationId: countForm.locationId, date: countForm.date, note: countForm.note, lines: activeItems.map((item) => ({ itemId: item.id, counted: countForm.counted[item.id]?.trim() ? Number(countForm.counted[item.id]) : null })) });
                      if (result.ok) setCountForm((current) => ({ ...current, id: result.value.id }));
                      return result;
                    })}>Save draft</Button>
                  ) : null}
                  {allowed('stock:post') ? (
                    <>
                      <label className="flex items-center gap-2 text-sm text-slate-700">
                        <input type="checkbox" checked={countConfirmed} onChange={(e) => setCountConfirmed(e.target.checked)} />
                        I have reviewed the differences above
                      </label>
                      <Button size="sm" disabled={pending || !countConfirmed || countPreview.length === 0} onClick={() => run('Count posted.', async () => {
                        const saved = await saveStockCount(entity.id, { id: countForm.id || undefined, locationId: countForm.locationId, date: countForm.date, note: countForm.note, lines: activeItems.map((item) => ({ itemId: item.id, counted: countForm.counted[item.id]?.trim() ? Number(countForm.counted[item.id]) : null })) });
                        if (!saved.ok) return saved;
                        const posted = await postStockCount(entity.id, saved.value.id);
                        if (posted.ok) setCountForm((current) => ({ ...current, id: posted.value.id }));
                        return posted;
                      }, () => setCountConfirmed(false))}>Confirm and post</Button>
                    </>
                  ) : null}
                </div>
              </>
            ) : null}
          </Card>

          <Card className="rounded-2xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Counts</p>
            <div className="mt-3 flex justify-end"><Button size="sm" variant="secondary" onClick={() => { setCountForm({ id: '', locationId: '', date: todayIso(), note: '', counted: {} }); setCountConfirmed(false); }}>New count</Button></div>
            <div className="mt-3 divide-y divide-slate-200">
              {counts.map((count) => (
                <button key={count.id} type="button" onClick={() => openCount(count)} className={['block w-full py-2 text-left text-sm hover:bg-slate-50', count.id === countForm.id ? 'bg-brand-50' : ''].join(' ')}>
                  <div className="font-medium text-slate-900">{locationById.get(count.locationId)?.name ?? count.locationId} · {count.date}</div>
                  <div className="text-xs text-slate-500">{count.status === 'posted' ? `Posted by ${count.postedByName}` : `Draft by ${count.createdByName}`} · {count.lines.filter((l) => l.countedGrams !== null).length}/{count.lines.length} counted</div>
                </button>
              ))}
              {counts.length === 0 ? <p className="py-2 text-sm text-slate-600">No counts yet.</p> : null}
            </div>
          </Card>
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- NRV */}
      {tab === 'NRV' ? (
        <Card className="rounded-2xl">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Period end</p>
              <h3 className="mt-1 text-xl font-semibold text-slate-900">Net realisable value</h3>
              <p className="mt-1 text-sm text-slate-600">Enter the selling price per kg for each item. Any item whose weighted average cost exceeds it is flagged with the write-down needed.</p>
            </div>
            <div className="flex items-end gap-3">
              <div><label className={label}>Period</label><Input type="month" value={nrvPeriod} onChange={(e) => { setNrvPeriod(e.target.value); setNrvInputs({}); }} /></div>
              {allowed('stock:post') ? <div><label className={label}>Write-down date</label><Input type="date" value={nrvDate} onChange={(e) => setNrvDate(e.target.value)} /></div> : null}
            </div>
          </div>
          <div className="mt-4 overflow-x-auto">
            <div className="grid min-w-[900px] grid-cols-[1.4fr_1fr_1fr_1.1fr_1fr_1fr_120px] gap-3 rounded-t-xl bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              <span>Item</span><span className="text-right">On hand</span><span className="text-right">Cost / kg</span><span>NRV / kg</span><span className="text-right">Value at cost</span><span className="text-right">Write-down</span><span />
            </div>
            {nrvRows.map((row) => {
              const item = itemById.get(row.itemId)!;
              const typed = nrvInputs[row.itemId];
              const shown = typed ?? (row.nrvPerKgMinor === null ? '' : String(row.nrvPerKgMinor / 100));
              return (
                <div key={row.itemId} className={['grid min-w-[900px] grid-cols-[1.4fr_1fr_1fr_1.1fr_1fr_1fr_120px] items-center gap-3 border-t border-slate-200 px-4 py-2 text-sm', row.flagged ? 'bg-red-50' : ''].join(' ')}>
                  <span><span className="font-mono text-xs text-slate-500">{item.code}</span> {item.name}{row.flagged ? <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-red-800">Cost above NRV</span> : null}</span>
                  <span className="text-right font-mono">{formatKg(row.quantityGrams)}</span>
                  <span className="text-right font-mono">{row.costPerKgMinor === null ? '—' : <Money value={row.costPerKgMinor} />}</span>
                  <span className="flex items-center gap-2">
                    <Input type="number" min={0} step="0.01" value={shown} disabled={!allowed('stock:enter')} onChange={(e) => setNrvInputs({ ...nrvInputs, [row.itemId]: e.target.value })} />
                    {allowed('stock:enter') && typed !== undefined && typed !== '' && Math.round(Number(typed) * 100) !== row.nrvPerKgMinor ? (
                      <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(`NRV for ${item.code} saved.`, () => setNrvPrice(entity.id, { itemId: row.itemId, period: nrvPeriod, sellingPriceMinorPerKg: Math.round(Number(typed) * 100) }), () => setNrvInputs((current) => { const next = { ...current }; delete next[row.itemId]; return next; }))}>Save</Button>
                    ) : null}
                  </span>
                  <span className="text-right font-mono"><Money value={row.valueMinor} /></span>
                  <span className={['text-right font-mono', row.flagged ? 'font-semibold text-red-800' : 'text-slate-400'].join(' ')}>{row.nrvPerKgMinor === null ? 'no price' : <Money value={row.writeDownMinor} />}</span>
                  <span className="text-right">{row.flagged && allowed('stock:post') ? <Button size="sm" variant="danger" disabled={pending} onClick={() => run(`${item.code} written down to NRV.`, () => writeDownToNrv(entity.id, { itemId: row.itemId, period: nrvPeriod, date: nrvDate }))}>Write down</Button> : null}</span>
                </div>
              );
            })}
            {nrvRows.length === 0 ? <p className="px-4 py-3 text-sm text-slate-600">Nothing on hand to assess.</p> : null}
          </div>
          <p className="mt-3 text-xs text-slate-500">A write-down posts the difference to 5035 Inventory Write-downs (NRV) and reduces the item&apos;s carrying value; quantity is unchanged and the new average cost is the NRV.</p>
        </Card>
      ) : null}
    </div>
  );
}
