'use client';

/**
 * The field purchase form. Built for a phone in a farming community with no
 * signal: one column, big targets, numeric keyboards, and nothing that
 * needs the server until "Sync".
 *
 * Offline: a service worker (/field-sw.js) keeps this page and its scripts
 * so it opens without a connection; reference data is kept in localStorage
 * from the last online load; each saved purchase goes into a local queue
 * with a client-generated reference. Sync sends the queue to
 * syncAgentPurchases, which ignores references it has seen, so a retry can
 * never double-record. The queue survives closing the browser.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { syncAgentPurchases, type FieldPurchase } from '@/app/actions/trading';
import type { BuyingAgentRecord, ItemRecord, StockLocationRecord } from '@/lib/data/types';
import { qualityFieldsFor, type CommodityKind, type Quality } from '@/lib/trading';

export type FieldReferenceData = {
  loadedAt: string;
  user: { name: string };
  entities: { id: string; name: string; lbcMode: boolean; producerPriceMinorPerKg: number | null }[];
  agents: BuyingAgentRecord[];
  items: ItemRecord[];
  locations: StockLocationRecord[];
  commodities: { id: string; entityId: string; code: string; name: string; kind: CommodityKind; gramsPerBag: number }[];
  floats: { id: string; entityId: string; agentId: string; date: string; amountMinor: number }[];
};

type QueuedPurchase = FieldPurchase & { entityId: string; savedAt: string; status: 'queued' | 'synced' | 'rejected'; error?: string; summary: string };

const REFS_KEY = 'sprouted-field-refs';
const QUEUE_KEY = 'sprouted-field-queue';
const todayIso = () => new Date().toISOString().slice(0, 10);

function readQueue(): QueuedPurchase[] {
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedPurchase[]) : [];
  } catch {
    return [];
  }
}
function writeQueue(queue: QueuedPurchase[]) {
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    /* storage unavailable: the in-memory queue still works for this session */
  }
}
function toFieldPurchase(q: QueuedPurchase): FieldPurchase {
  return { clientRef: q.clientRef, agentId: q.agentId, floatId: q.floatId, date: q.date, farmerName: q.farmerName, farmerPhone: q.farmerPhone, walletNumber: q.walletNumber, community: q.community, district: q.district, itemId: q.itemId, locationId: q.locationId, bags: q.bags, grams: q.grams, priceMinor: q.priceMinor, paymentMethod: q.paymentMethod, settlement: q.settlement, paymentRef: q.paymentRef, evidenceKind: q.evidenceKind, evidenceData: q.evidenceData, quality: q.quality, note: q.note };
}

/**
 * The farmer's mark, captured on the agent's device: a signature drawn with
 * a finger, or a thumb pressed on the screen. Either way what is stored is
 * the picture, with the kind that was asked for. Small on purpose — it
 * travels with the purchase through the offline queue.
 */
function MarkPad({ kind, value, onChange }: { kind: 'signature' | 'thumbprint'; value: string; onChange: (dataUrl: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);

  function positionOf(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget;
    const box = canvas.getBoundingClientRect();
    return { x: ((event.clientX - box.left) / box.width) * canvas.width, y: ((event.clientY - box.top) / box.height) * canvas.height };
  }

  function stroke(event: React.PointerEvent<HTMLCanvasElement>, begin: boolean) {
    const context = event.currentTarget.getContext('2d');
    if (!context) return;
    const { x, y } = positionOf(event);
    context.lineWidth = kind === 'thumbprint' ? 26 : 3;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#0f172a';
    if (begin) {
      context.beginPath();
      context.moveTo(x, y);
    }
    context.lineTo(x, y);
    context.stroke();
  }

  function clear() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    onChange('');
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={520}
        height={200}
        className="w-full touch-none rounded-xl border border-dashed border-slate-400 bg-white"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drawing.current = true;
          stroke(event, true);
        }}
        onPointerMove={(event) => {
          if (drawing.current) stroke(event, false);
        }}
        onPointerUp={(event) => {
          drawing.current = false;
          onChange(event.currentTarget.toDataURL('image/png'));
        }}
      />
      <div className="mt-1 flex items-center justify-between text-xs text-slate-600">
        <span>{value ? 'Captured.' : kind === 'signature' ? 'Ask the farmer to sign above.' : 'Ask the farmer to press their thumb above.'}</span>
        <button type="button" className="underline" onClick={clear}>Clear</button>
      </div>
    </div>
  );
}
function newRef(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const field = 'min-h-[52px] w-full rounded-xl border border-slate-300 bg-white px-4 text-lg text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100';
const label = 'mb-1 block text-sm font-medium text-slate-700';

export function FieldForm({ refs: serverRefs }: { refs: FieldReferenceData }) {
  // Prefer the server's data when we have it; fall back to the last copy on the phone.
  const [refs, setRefs] = useState<FieldReferenceData>(serverRefs);
  const [online, setOnline] = useState(true);
  const [queue, setQueue] = useState<QueuedPurchase[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Hydrate from the phone's storage: a one-off sync with an external store
  // (the shell's localStorage import uses the same justified pattern). The
  // reads and sets run in a microtask so the effect body itself sets nothing.
  useEffect(() => {
    const hydrate = () => {
      try {
        if (serverRefs.entities.length > 0) window.localStorage.setItem(REFS_KEY, JSON.stringify(serverRefs));
        else {
          const cached = window.localStorage.getItem(REFS_KEY);
          if (cached) setRefs(JSON.parse(cached) as FieldReferenceData);
        }
      } catch { /* ignore */ }
      setQueue(readQueue());
      setOnline(navigator.onLine);
    };
    void Promise.resolve().then(hydrate);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/field-sw.js').catch(() => undefined);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, [serverRefs]);

  const [entityId, setEntityId] = useState(serverRefs.entities[0]?.id ?? '');
  const entityAgents = refs.agents.filter((a) => a.entityId === entityId);
  const entityItems = refs.items.filter((i) => i.entityId === entityId);
  const entityLocations = refs.locations.filter((l) => l.entityId === entityId);

  const [form, setForm] = useState({ agentId: '', floatId: '', date: todayIso(), farmerName: '', farmerPhone: '', walletNumber: '', community: '', district: '', itemId: '', locationId: '', bags: '', kg: '', price: '', paymentMethod: 'cash' as 'cash' | 'mobile-money', settlement: 'float' as 'float' | 'payable', paymentRef: '', evidenceKind: 'signature' as 'signature' | 'thumbprint', note: '' });
  const [mark, setMark] = useState('');
  const [quality, setQuality] = useState<Record<string, string>>({});
  const agent = entityAgents.find((a) => a.id === form.agentId);
  const item = entityItems.find((i) => i.id === form.itemId);
  const commodity = refs.commodities.find((c) => c.id === item?.commodityId);
  const openFloats = refs.floats.filter((f) => f.entityId === entityId && f.agentId === form.agentId);
  const grams = useMemo(() => {
    if (form.kg.trim()) return Math.round(Number(form.kg) * 1000);
    if (form.bags.trim() && commodity) return Math.round(Number(form.bags) * commodity.gramsPerBag);
    return 0;
  }, [form.kg, form.bags, commodity]);
  const qualityFields = qualityFieldsFor(commodity?.kind ?? 'other');
  // LBC mode: the price is the gazetted producer price × weight, unless typed over.
  const lbcEntity = refs.entities.find((e) => e.id === entityId);
  const producerPrice = lbcEntity?.lbcMode && lbcEntity.producerPriceMinorPerKg !== null ? lbcEntity.producerPriceMinorPerKg : null;
  const suggestedPrice = producerPrice !== null && grams > 0 ? Math.round((grams * producerPrice) / 1000) : null;
  const priceToUse = form.price.trim() ? form.price : suggestedPrice !== null ? (suggestedPrice / 100).toFixed(2) : '';
  const pendingCount = queue.filter((q) => q.status === 'queued').length;

  const sync = useCallback(async (current: QueuedPurchase[]) => {
    const toSend = current.filter((q) => q.status === 'queued');
    if (toSend.length === 0 || syncing) return;
    setSyncing(true);
    setNotice(null);
    let next = [...current];
    try {
      const byEntity = new Map<string, QueuedPurchase[]>();
      for (const q of toSend) (byEntity.get(q.entityId) ?? byEntity.set(q.entityId, []).get(q.entityId)!).push(q);
      for (const [eid, batch] of byEntity) {
        const result = await syncAgentPurchases(eid, batch.map(toFieldPurchase));
        if (!result.ok) {
          setNotice(result.error);
          continue;
        }
        const accepted = new Set([...result.value.accepted, ...result.value.duplicates]);
        const rejected = new Map(result.value.rejected.map((r) => [r.clientRef, r.error]));
        next = next.map((q) => (accepted.has(q.clientRef) ? { ...q, status: 'synced' as const } : rejected.has(q.clientRef) ? { ...q, status: 'rejected' as const, error: rejected.get(q.clientRef) } : q));
      }
      setQueue(next);
      writeQueue(next);
      const sent = toSend.filter((q) => next.find((n) => n.clientRef === q.clientRef)?.status === 'synced').length;
      setNotice(sent ? `${sent} purchase${sent === 1 ? '' : 's'} synced.` : notice);
    } catch {
      setNotice('Could not reach the server — your purchases are still saved on this phone. Try again when you have signal.');
    } finally {
      setSyncing(false);
    }
  }, [syncing, notice]);

  // Auto-sync whenever we come back online with something queued. sync only
  // sets state after the server answers.
  useEffect(() => {
    if (online && queue.some((q) => q.status === 'queued')) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void sync(queue);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  function save() {
    if (!entityId || !form.agentId || !form.itemId || !form.farmerName.trim() || grams <= 0 || !priceToUse.trim()) {
      setNotice('Fill in agent, farmer, grade, weight and price.');
      return;
    }
    // Paying the farmer now needs evidence it happened; paying centrally does not.
    if (form.settlement === 'float') {
      if (!form.floatId) {
        setNotice('Say which float this came out of, or choose "Pay centrally later".');
        return;
      }
      if (form.paymentMethod === 'cash' && !mark) {
        setNotice(`Capture the farmer's ${form.evidenceKind === 'thumbprint' ? 'thumbprint' : 'signature'} before saving.`);
        return;
      }
      if (form.paymentMethod === 'mobile-money' && !form.paymentRef.trim()) {
        setNotice('Enter the mobile money reference for this transfer.');
        return;
      }
    }
    const q: Quality = {};
    for (const f of qualityFields) {
      const raw = quality[f.key];
      if (raw === undefined || raw === '') continue;
      if (f.kind === 'number') (q as Record<string, unknown>)[f.key] = Number(raw);
      else (q as Record<string, unknown>)[f.key] = raw;
    }
    const purchase: QueuedPurchase = {
      entityId,
      clientRef: newRef(),
      agentId: form.agentId,
      floatId: form.floatId || null,
      date: form.date,
      farmerName: form.farmerName.trim(),
      farmerPhone: form.farmerPhone.trim(),
      walletNumber: form.walletNumber.trim(),
      community: form.community.trim(),
      district: form.district.trim(),
      itemId: form.itemId,
      locationId: form.locationId || agent?.defaultLocationId || null,
      bags: form.bags.trim() ? Number(form.bags) : null,
      grams,
      priceMinor: Math.round(Number(priceToUse) * 100),
      paymentMethod: form.paymentMethod,
      settlement: form.settlement,
      paymentRef: form.settlement === 'float' && form.paymentMethod === 'mobile-money' ? form.paymentRef.trim() : '',
      evidenceKind: form.settlement === 'float' ? (form.paymentMethod === 'cash' ? form.evidenceKind : 'reference') : undefined,
      evidenceData: form.settlement === 'float' && form.paymentMethod === 'cash' ? mark : '',
      quality: q,
      note: form.note.trim(),
      savedAt: new Date().toISOString(),
      status: 'queued',
      summary: `${form.farmerName.trim()} · ${(grams / 1000).toFixed(1)} kg ${item?.grade ?? ''} · GH₵${Number(priceToUse).toFixed(2)}`,
    };
    const next = [purchase, ...queue];
    setQueue(next);
    writeQueue(next);
    setSaved(purchase.summary);
    setForm({ ...form, farmerName: '', farmerPhone: '', walletNumber: '', community: form.community, district: form.district, bags: '', kg: '', price: '', paymentRef: '', note: '' });
    setMark('');
    setQuality({});
    if (online) void sync(next);
  }

  return (
    <main className="mx-auto min-h-screen max-w-md bg-[#F6F4EF] px-4 pb-32 pt-4 text-slate-900">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Sprouted · field purchase</p>
          <h1 className="text-xl font-semibold">{refs.user.name}</h1>
        </div>
        <span className={['rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]', online ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'].join(' ')}>{online ? 'Online' : 'Offline — saving on phone'}</span>
      </header>

      {notice ? <p className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">{notice}</p> : null}
      {saved ? <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">Saved: {saved}</p> : null}

      <section className="mt-4 space-y-4">
        {refs.entities.length > 1 ? (
          <div><label className={label}>Buying for</label><select className={field} value={entityId} onChange={(e) => { setEntityId(e.target.value); setForm({ ...form, agentId: '', floatId: '', itemId: '', locationId: '' }); }}>{refs.entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></div>
        ) : null}
        <div><label className={label}>Agent</label><select className={field} value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value, floatId: '', locationId: '' })}><option value="">Choose…</option>{entityAgents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
        {openFloats.length > 0 ? (
          <div><label className={label}>Float</label><select className={field} value={form.floatId} onChange={(e) => setForm({ ...form, floatId: e.target.value })}><option value="">Assign later</option>{openFloats.map((f) => <option key={f.id} value={f.id}>Float of {f.date} · GH₵{(f.amountMinor / 100).toFixed(2)}</option>)}</select></div>
        ) : null}
        <div><label className={label}>Date</label><input type="date" className={field} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
        <div><label className={label}>Farmer</label><input className={field} value={form.farmerName} autoComplete="off" placeholder="Name" onChange={(e) => setForm({ ...form, farmerName: e.target.value })} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={label}>Phone</label><input className={field} type="tel" inputMode="tel" value={form.farmerPhone} onChange={(e) => setForm({ ...form, farmerPhone: e.target.value })} /></div>
          <div><label className={label}>Wallet number</label><input className={field} type="tel" inputMode="tel" value={form.walletNumber} onChange={(e) => setForm({ ...form, walletNumber: e.target.value })} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={label}>Community</label><input className={field} value={form.community} onChange={(e) => setForm({ ...form, community: e.target.value })} /></div>
          <div><label className={label}>District</label><input className={field} value={form.district} onChange={(e) => setForm({ ...form, district: e.target.value })} /></div>
        </div>
        <div><label className={label}>Grade</label><select className={field} value={form.itemId} onChange={(e) => { setForm({ ...form, itemId: e.target.value }); setQuality({}); }}><option value="">Choose…</option>{entityItems.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={label}>Bags{commodity ? ` (${commodity.gramsPerBag / 1000} kg)` : ''}</label><input type="number" inputMode="decimal" min={0} step="any" className={field} value={form.bags} onChange={(e) => setForm({ ...form, bags: e.target.value, kg: '' })} /></div>
          <div><label className={label}>or weight (kg)</label><input type="number" inputMode="decimal" min={0} step="any" className={field} value={form.kg} onChange={(e) => setForm({ ...form, kg: e.target.value, bags: '' })} /></div>
        </div>
        {grams > 0 ? <p className="-mt-2 text-sm text-slate-600">= {(grams / 1000).toLocaleString('en-GH', { maximumFractionDigits: 3 })} kg</p> : null}
        <div><label className={label}>Price paid (GH₵){producerPrice !== null ? ` — producer price GH₵${(producerPrice / 100).toFixed(2)}/kg` : ''}</label><input type="number" inputMode="decimal" min={0} step="0.01" className={field} value={form.price} placeholder={suggestedPrice !== null ? (suggestedPrice / 100).toFixed(2) : ''} onChange={(e) => setForm({ ...form, price: e.target.value })} />{producerPrice !== null && form.price.trim() && Math.round(Number(form.price) * 100) !== suggestedPrice ? <p className="mt-1 text-xs text-amber-800">Differs from the gazetted producer price.</p> : null}</div>
        <div>
          <label className={label}>Settled</label>
          <div className="grid grid-cols-2 gap-3">
            {([['float', 'Paid now'], ['payable', 'Pay centrally later']] as const).map(([value, text]) => (
              <button key={value} type="button" onClick={() => setForm({ ...form, settlement: value })} className={['min-h-[52px] rounded-xl border text-base font-medium', form.settlement === value ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white text-slate-800'].join(' ')}>{text}</button>
            ))}
          </div>
          {form.settlement === 'payable' ? <p className="mt-1 text-xs text-slate-600">The office pays this farmer in a batch. Anything they owe on an advance comes off automatically.</p> : null}
        </div>
        {form.settlement === 'float' ? (
          <>
            <div>
              <label className={label}>Paid by</label>
              <div className="grid grid-cols-2 gap-3">
                {(['cash', 'mobile-money'] as const).map((method) => (
                  <button key={method} type="button" onClick={() => setForm({ ...form, paymentMethod: method })} className={['min-h-[52px] rounded-xl border text-base font-medium', form.paymentMethod === method ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white text-slate-800'].join(' ')}>{method === 'cash' ? 'Cash' : 'Mobile money'}</button>
                ))}
              </div>
            </div>
            {form.paymentMethod === 'mobile-money' ? (
              <div><label className={label}>Transfer reference</label><input className={field} autoCapitalize="characters" autoComplete="off" value={form.paymentRef} onChange={(e) => setForm({ ...form, paymentRef: e.target.value })} placeholder="From the confirmation message" /></div>
            ) : (
              <div>
                <label className={label}>Farmer&rsquo;s confirmation</label>
                <div className="mb-2 grid grid-cols-2 gap-3">
                  {([['signature', 'Signature'], ['thumbprint', 'Thumbprint']] as const).map(([value, text]) => (
                    <button key={value} type="button" onClick={() => { setForm({ ...form, evidenceKind: value }); setMark(''); }} className={['min-h-[44px] rounded-xl border text-base font-medium', form.evidenceKind === value ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white text-slate-800'].join(' ')}>{text}</button>
                  ))}
                </div>
                <MarkPad key={form.evidenceKind} kind={form.evidenceKind} value={mark} onChange={setMark} />
              </div>
            )}
          </>
        ) : null}
        {item ? (
          <div>
            <label className={label}>Quality</label>
            <div className="grid grid-cols-3 gap-2">
              {qualityFields.map((f) => (
                <div key={f.key}>
                  <span className="block text-xs text-slate-600">{f.label}{f.unit ? ` (${f.unit})` : ''}</span>
                  <input className={field} type={f.kind === 'number' ? 'number' : 'text'} inputMode={f.kind === 'number' ? 'decimal' : undefined} step="any" value={quality[f.key] ?? ''} onChange={(e) => setQuality({ ...quality, [f.key]: e.target.value })} />
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {entityLocations.length > 1 ? (
          <div><label className={label}>Delivered to</label><select className={field} value={form.locationId || agent?.defaultLocationId || ''} onChange={(e) => setForm({ ...form, locationId: e.target.value })}><option value="">Agent&rsquo;s usual place</option>{entityLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
        ) : null}
        <div><label className={label}>Note</label><input className={field} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-500">On this phone</h2>
        <ul className="mt-2 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
          {queue.slice(0, 30).map((q) => (
            <li key={q.clientRef} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span>{q.summary}<span className="block text-xs text-slate-500">{q.date}{q.error ? ` · ${q.error}` : ''}</span></span>
              <span className={['rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]', q.status === 'synced' ? 'bg-emerald-100 text-emerald-800' : q.status === 'rejected' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-900'].join(' ')}>{q.status === 'queued' ? 'waiting' : q.status}</span>
            </li>
          ))}
          {queue.length === 0 ? <li className="px-3 py-2 text-sm text-slate-500">Nothing saved yet.</li> : null}
        </ul>
        {queue.some((q) => q.status !== 'queued') ? <button type="button" className="mt-2 text-xs text-slate-500 underline" onClick={() => { const next = queue.filter((q) => q.status === 'queued'); setQueue(next); writeQueue(next); }}>Clear synced and rejected</button> : null}
      </section>

      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-md gap-3">
          <button type="button" onClick={save} className="min-h-[56px] flex-1 rounded-xl bg-brand-700 text-lg font-semibold text-white">Save purchase</button>
          <button type="button" disabled={syncing || pendingCount === 0} onClick={() => void sync(queue)} className="min-h-[56px] rounded-xl border border-slate-300 bg-white px-4 text-base font-medium text-slate-800 disabled:opacity-50">{syncing ? 'Syncing…' : `Sync (${pendingCount})`}</button>
        </div>
      </div>
    </main>
  );
}
