'use client';

/**
 * Field buying: agents, the floats advanced to them, and the purchases they
 * bring back. Every change goes through src/app/actions/trading.ts. The
 * form the agents use in the field is at /field, built for a phone and
 * for no signal.
 */

import { useMemo, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { advanceFloat, assignPurchaseFloat, postAgentPurchases, reconcileFloat, rejectAgentPurchase, returnFloatCash, saveAgent, setFloatAgeLimit } from '@/app/actions/trading';
import type { Permission } from '@/lib/authz';
import type { AgentPurchaseRecord, BankAccountRecord, BuyingAgentRecord, CommodityRecord, EntityRecord, FloatAdvanceRecord, ItemRecord, StockLocationRecord } from '@/lib/data/types';
import { formatKg } from '@/lib/inventory';
import { agentFloatSummaries, floatPosition, qualityFieldsFor } from '@/lib/trading';

type Props = {
  entity: EntityRecord;
  agents: BuyingAgentRecord[];
  floats: FloatAdvanceRecord[];
  purchases: AgentPurchaseRecord[];
  items: ItemRecord[];
  commodities: CommodityRecord[];
  locations: StockLocationRecord[];
  bankAccounts: BankAccountRecord[];
  allowed: (permission: Permission) => boolean;
};

type Tab = 'Floats' | 'Purchases' | 'Agents';
const tabs: Tab[] = ['Floats', 'Purchases', 'Agents'];
const selectClass = 'min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50';
const label = 'mb-1.5 block text-sm font-medium text-slate-700';
const todayIso = () => new Date().toISOString().slice(0, 10);

export function BuyingPanel({ entity, agents, floats, purchases, items, commodities, locations, bankAccounts, allowed }: Props) {
  const [tab, setTab] = useState<Tab>('Floats');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const today = todayIso();
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const locationById = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);

  const positions = useMemo(
    () => floats.map((f) => ({ float: f, position: floatPosition({ amountMinor: f.amountMinor, date: f.date }, f.purchasedMinor, f.returns.reduce((s, r) => s + r.amountMinor, 0), today, entity.floatAgeLimitDays) })),
    [floats, today, entity.floatAgeLimitDays],
  );
  const summaries = useMemo(() => agentFloatSummaries(agents, positions.map((p) => ({ agentId: p.float.agentId, position: p.position, status: p.float.status }))), [agents, positions]);

  function run(okText: string, action: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) { setMessage({ tone: 'ok', text: okText }); after?.(); } else setMessage({ tone: 'error', text: result.error ?? 'Something went wrong.' });
    });
  }

  const [agentForm, setAgentForm] = useState({ id: '', name: '', phone: '', defaultLocationId: '' });
  const [floatForm, setFloatForm] = useState({ agentId: '', date: today, amount: '', bankAccountId: bankAccounts[0]?.id ?? '', note: '' });
  const [returnForm, setReturnForm] = useState<{ floatId: string; date: string; amount: string; bankAccountId: string }>({ floatId: '', date: today, amount: '', bankAccountId: bankAccounts[0]?.id ?? '' });
  const [ageLimit, setAgeLimit] = useState(String(entity.floatAgeLimitDays));
  const [selectedPurchases, setSelectedPurchases] = useState<Set<string>>(new Set());
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const pendingPurchases = purchases.filter((p) => p.status === 'pending');

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{entity.name}</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-900">Field buying</h2>
          <p className="mt-1 text-sm text-slate-600">Agents record purchases on their phones at <a className="font-medium text-brand-700 underline" href="/field">/field</a> — it works without signal and syncs when there is one.</p>
        </div>
        <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1">
          {tabs.map((candidate) => <button key={candidate} type="button" onClick={() => setTab(candidate)} className={['rounded-lg px-3 py-2 text-sm font-medium', tab === candidate ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'].join(' ')}>{candidate}{candidate === 'Purchases' && pendingPurchases.length ? <span className="ml-1 rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-800">{pendingPurchases.length}</span> : null}</button>)}
        </div>
      </div>

      {message ? <p className={['rounded-lg border px-3 py-2 text-sm', message.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800'].join(' ')}>{message.text}</p> : null}

      {/* ---------------------------------------------------------------- Floats */}
      {tab === 'Floats' ? (
        <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
          <div className="space-y-6">
            <Card className="rounded-2xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Outstanding per agent</p>
              <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {summaries.map((summary) => (
                  <div key={summary.agentId} className={['rounded-xl border p-3', summary.overdue ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-slate-50'].join(' ')}>
                    <div className="flex items-center justify-between gap-2"><span className="font-medium text-slate-900">{summary.agentName}</span>{summary.overdue ? <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white">Overdue</span> : null}</div>
                    <div className={['mt-1 font-mono text-xl tabular-nums', summary.overdue ? 'text-red-800' : 'text-slate-900'].join(' ')}><Money value={summary.outstandingMinor} /></div>
                    <div className="text-xs text-slate-600">{summary.openFloats} open float{summary.openFloats === 1 ? '' : 's'}{summary.openFloats ? ` · oldest ${summary.oldestAgeDays} days` : ''}</div>
                  </div>
                ))}
                {agents.length === 0 ? <p className="text-sm text-slate-600">No agents yet.</p> : null}
              </div>
            </Card>

            <Card className="rounded-2xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Floats</p>
              <h3 className="mt-1 text-xl font-semibold text-slate-900">Advanced = purchases posted + cash returned</h3>
              <div className="mt-4 space-y-3">
                {positions.map(({ float, position }) => {
                  const agent = agentById.get(float.agentId);
                  const isReturning = returnForm.floatId === float.id;
                  return (
                    <div key={float.id} className={['rounded-xl border p-4', float.status === 'reconciled' ? 'border-emerald-200 bg-emerald-50/40' : position.overdue ? 'border-red-300 bg-red-50' : 'border-slate-200'].join(' ')}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="font-medium text-slate-900">{agent?.name ?? float.agentId} · {float.date}{float.status === 'reconciled' ? <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">Reconciled</span> : position.overdue ? <span className="ml-2 rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white">{position.ageDays} days</span> : <span className="ml-2 text-xs text-slate-500">{position.ageDays} days old</span>}</div>
                          <div className="mt-1 grid grid-cols-4 gap-x-4 text-xs text-slate-600">
                            <span>Advanced<br /><span className="font-mono text-slate-900"><Money value={position.advancedMinor} /></span></span>
                            <span>Purchases<br /><span className="font-mono text-slate-900"><Money value={position.purchasedMinor} /></span></span>
                            <span>Cash back<br /><span className="font-mono text-slate-900"><Money value={position.returnedMinor} /></span></span>
                            <span>Outstanding<br /><span className={['font-mono', position.outstandingMinor === 0 ? 'text-emerald-700' : 'text-slate-900'].join(' ')}><Money value={position.outstandingMinor} /></span></span>
                          </div>
                        </div>
                        {float.status === 'open' && allowed('stock:post') ? (
                          <div className="flex gap-2">
                            <Button size="sm" variant="secondary" onClick={() => setReturnForm({ floatId: isReturning ? '' : float.id, date: today, amount: '', bankAccountId: bankAccounts[0]?.id ?? '' })}>Cash returned</Button>
                            <Button size="sm" disabled={pending || !position.reconciles} onClick={() => run('Float reconciled.', () => reconcileFloat(entity.id, float.id))}>Reconcile</Button>
                          </div>
                        ) : null}
                      </div>
                      {isReturning ? (
                        <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
                          <div><label className={label}>Amount</label><Input type="number" inputMode="decimal" min={0} step="0.01" value={returnForm.amount} onChange={(e) => setReturnForm({ ...returnForm, amount: e.target.value })} /></div>
                          <div><label className={label}>Date</label><Input type="date" value={returnForm.date} onChange={(e) => setReturnForm({ ...returnForm, date: e.target.value })} /></div>
                          <div><label className={label}>Into</label><select value={returnForm.bankAccountId} className={selectClass} onChange={(e) => setReturnForm({ ...returnForm, bankAccountId: e.target.value })}>{bankAccounts.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
                          <Button size="sm" disabled={pending || !returnForm.amount} onClick={() => run('Cash return recorded.', () => returnFloatCash(entity.id, { floatId: float.id, date: returnForm.date, amountMinor: Math.round(Number(returnForm.amount) * 100), bankAccountId: returnForm.bankAccountId }), () => setReturnForm({ ...returnForm, floatId: '', amount: '' }))}>Record</Button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {floats.length === 0 ? <p className="text-sm text-slate-600">No floats yet.</p> : null}
              </div>
            </Card>
          </div>

          <div className="space-y-6">
            {allowed('stock:post') ? (
              <Card className="rounded-2xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Advance a float</p>
                <div className="mt-3 space-y-3">
                  <div><label className={label}>Agent</label><select value={floatForm.agentId} className={selectClass} onChange={(e) => setFloatForm({ ...floatForm, agentId: e.target.value })}><option value="">Choose…</option>{agents.filter((a) => a.isActive).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
                  <div><label className={label}>Amount</label><Input type="number" inputMode="decimal" min={0} step="0.01" value={floatForm.amount} onChange={(e) => setFloatForm({ ...floatForm, amount: e.target.value })} /></div>
                  <div><label className={label}>Date</label><Input type="date" value={floatForm.date} onChange={(e) => setFloatForm({ ...floatForm, date: e.target.value })} /></div>
                  <div><label className={label}>From</label><select value={floatForm.bankAccountId} className={selectClass} onChange={(e) => setFloatForm({ ...floatForm, bankAccountId: e.target.value })}>{bankAccounts.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
                  <div><label className={label}>Note</label><Input value={floatForm.note} onChange={(e) => setFloatForm({ ...floatForm, note: e.target.value })} /></div>
                  <p className="text-xs text-slate-500">Posts money out of the bank into 1060 Agent Float Advances — a receivable until produce or cash comes back.</p>
                  <div className="flex justify-end"><Button size="sm" disabled={pending || !floatForm.agentId || !floatForm.amount || !floatForm.bankAccountId} onClick={() => run('Float advanced.', () => advanceFloat(entity.id, { agentId: floatForm.agentId, date: floatForm.date, amountMinor: Math.round(Number(floatForm.amount) * 100), bankAccountId: floatForm.bankAccountId, note: floatForm.note }), () => setFloatForm({ ...floatForm, amount: '', note: '' }))}>Advance</Button></div>
                </div>
              </Card>
            ) : null}
            <Card className="rounded-2xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Age limit</p>
              <p className="mt-1 text-sm text-slate-600">An open float older than this is flagged red here and on the dashboard.</p>
              <div className="mt-3 flex items-end gap-2">
                <div className="flex-1"><label className={label}>Days</label><Input type="number" inputMode="numeric" min={1} max={365} value={ageLimit} disabled={!allowed('inventory:manage')} onChange={(e) => setAgeLimit(e.target.value)} /></div>
                {allowed('inventory:manage') ? <Button size="sm" variant="secondary" disabled={pending || Number(ageLimit) === entity.floatAgeLimitDays} onClick={() => run('Age limit saved.', () => setFloatAgeLimit(entity.id, Number(ageLimit)))}>Save</Button> : null}
              </div>
            </Card>
          </div>
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- Purchases */}
      {tab === 'Purchases' ? (
        <div className="space-y-6">
          <Card className="rounded-2xl">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Pending</p>
                <h3 className="mt-1 text-xl font-semibold text-slate-900">Synced from the field, not yet posted</h3>
                <p className="mt-1 text-sm text-slate-600">Posting receives the stock at the agent&rsquo;s location against their float and creates the lot. A purchase needs an open float to post against.</p>
              </div>
              {allowed('stock:post') ? <Button size="sm" disabled={pending || selectedPurchases.size === 0} onClick={() => run(`${selectedPurchases.size} purchase${selectedPurchases.size === 1 ? '' : 's'} posted.`, () => postAgentPurchases(entity.id, [...selectedPurchases]), () => setSelectedPurchases(new Set()))}>Post selected ({selectedPurchases.size})</Button> : null}
            </div>
            <div className="mt-4 space-y-2">
              {pendingPurchases.map((purchase) => {
                const agent = agentById.get(purchase.agentId);
                const item = itemById.get(purchase.itemId);
                const commodity = commodities.find((c) => c.id === item?.commodityId);
                const openFloats = floats.filter((f) => f.agentId === purchase.agentId && f.status === 'open');
                const fields = qualityFieldsFor(commodity?.kind ?? 'other');
                return (
                  <div key={purchase.id} className="rounded-xl border border-slate-200 p-3 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <label className="flex items-start gap-3">
                        {allowed('stock:post') ? <input type="checkbox" className="mt-1" checked={selectedPurchases.has(purchase.id)} disabled={!purchase.floatId} onChange={(e) => { const next = new Set(selectedPurchases); if (e.target.checked) next.add(purchase.id); else next.delete(purchase.id); setSelectedPurchases(next); }} /> : null}
                        <span>
                          <span className="font-medium text-slate-900">{purchase.farmerName}</span> <span className="text-slate-500">· {[purchase.community, purchase.district].filter(Boolean).join(', ') || 'origin not given'} · {purchase.date}</span>
                          <span className="block text-xs text-slate-600">{item?.name ?? purchase.itemId} · {formatKg(purchase.grams)}{purchase.bags !== null ? ` (${purchase.bags} bags)` : ''} · <Money value={purchase.priceMinor} /> {purchase.paymentMethod === 'mobile-money' ? 'by mobile money' : 'in cash'} · by {agent?.name ?? '?'} → {locationById.get(purchase.locationId)?.name ?? '?'}</span>
                          <span className="block text-xs text-slate-500">{fields.map((f) => { const v = purchase.quality[f.key]; return v === null || v === undefined ? null : `${f.label} ${v}${f.unit ? ' ' + f.unit : ''}`; }).filter(Boolean).join(' · ') || 'no quality data'}{purchase.note ? ` · ${purchase.note}` : ''}</span>
                        </span>
                      </label>
                      {allowed('stock:post') ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <select value={purchase.floatId ?? ''} className="min-h-[36px] rounded-lg border border-slate-200 bg-white px-2 text-xs" onChange={(e) => { if (e.target.value) run('Float assigned.', () => assignPurchaseFloat(entity.id, purchase.id, e.target.value)); }}>
                            <option value="">{purchase.floatId ? 'Float' : 'Assign float…'}</option>
                            {openFloats.map((f) => <option key={f.id} value={f.id}>Float of {f.date} · {(f.amountMinor / 100).toFixed(2)}</option>)}
                          </select>
                          <Input className="min-h-[36px] w-40 text-xs" placeholder="Reject reason" value={rejectReasons[purchase.id] ?? ''} onChange={(e) => setRejectReasons({ ...rejectReasons, [purchase.id]: e.target.value })} />
                          <Button size="sm" variant="ghost" disabled={pending || !(rejectReasons[purchase.id] ?? '').trim()} onClick={() => run('Purchase rejected.', () => rejectAgentPurchase(entity.id, purchase.id, rejectReasons[purchase.id] ?? ''))}>Reject</Button>
                        </div>
                      ) : null}
                    </div>
                    {!purchase.floatId ? <p className="mt-2 text-xs text-amber-700">No float assigned — it cannot post until it is.</p> : null}
                  </div>
                );
              })}
              {pendingPurchases.length === 0 ? <p className="text-sm text-slate-600">Nothing pending.</p> : null}
            </div>
          </Card>
          <Card className="rounded-2xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">History</p>
            <div className="mt-3 divide-y divide-slate-200 text-sm">
              {purchases.filter((p) => p.status !== 'pending').map((purchase) => (
                <div key={purchase.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><span className="font-medium text-slate-900">{purchase.farmerName}</span> <span className="text-slate-500">· {purchase.date} · {itemById.get(purchase.itemId)?.name} · {formatKg(purchase.grams)} · by {agentById.get(purchase.agentId)?.name}</span></span>
                  <span className="flex items-center gap-3"><span className="font-mono"><Money value={purchase.priceMinor} /></span><span className={['rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]', purchase.status === 'posted' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-700'].join(' ')}>{purchase.status}{purchase.status === 'rejected' && purchase.rejectReason ? `: ${purchase.rejectReason}` : ''}</span></span>
                </div>
              ))}
              {purchases.filter((p) => p.status !== 'pending').length === 0 ? <p className="py-2 text-slate-600">None yet.</p> : null}
            </div>
          </Card>
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- Agents */}
      {tab === 'Agents' ? (
        <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <Card className="rounded-2xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Agents</p>
            <div className="mt-3 divide-y divide-slate-200 text-sm">
              {agents.map((agent) => (
                <div key={agent.id} className="flex items-center justify-between gap-3 py-2">
                  <div><span className="font-medium text-slate-900">{agent.name}</span><span className="block text-xs text-slate-500">{agent.phone || 'no phone'} · receives at {agent.defaultLocationId ? locationById.get(agent.defaultLocationId)?.name : 'no default location'}{agent.isActive ? '' : ' · inactive'}</span></div>
                  {allowed('inventory:manage') ? <Button size="sm" variant="ghost" onClick={() => setAgentForm({ id: agent.id, name: agent.name, phone: agent.phone, defaultLocationId: agent.defaultLocationId ?? '' })}>Edit</Button> : null}
                </div>
              ))}
              {agents.length === 0 ? <p className="py-2 text-slate-600">No agents yet.</p> : null}
            </div>
          </Card>
          {allowed('inventory:manage') ? (
            <Card className="rounded-2xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{agentForm.id ? 'Edit agent' : 'New agent'}</p>
              <div className="mt-3 space-y-3">
                <div><label className={label}>Name</label><Input value={agentForm.name} onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })} /></div>
                <div><label className={label}>Phone</label><Input value={agentForm.phone} inputMode="tel" onChange={(e) => setAgentForm({ ...agentForm, phone: e.target.value })} /></div>
                <div><label className={label}>Receives purchases at</label><select value={agentForm.defaultLocationId} className={selectClass} onChange={(e) => setAgentForm({ ...agentForm, defaultLocationId: e.target.value })}><option value="">Choose…</option>{locations.filter((l) => l.isActive).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
                <p className="text-xs text-slate-500">The agent signs in to /field with their own account (role Data entry, access to {entity.name}).</p>
                <div className="flex justify-end gap-2">
                  {agentForm.id ? <Button size="sm" variant="secondary" onClick={() => setAgentForm({ id: '', name: '', phone: '', defaultLocationId: '' })}>Cancel</Button> : null}
                  <Button size="sm" disabled={pending || !agentForm.name.trim()} onClick={() => run('Agent saved.', () => saveAgent(entity.id, { id: agentForm.id || undefined, name: agentForm.name, phone: agentForm.phone, defaultLocationId: agentForm.defaultLocationId || null }), () => setAgentForm({ id: '', name: '', phone: '', defaultLocationId: '' }))}>{agentForm.id ? 'Save changes' : 'Add agent'}</Button>
                </div>
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
