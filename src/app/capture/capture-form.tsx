'use client';

/**
 * The phone capture form. One column, big targets, the camera one tap away,
 * and nothing that needs the server until a capture is sent.
 *
 * Offline: a service worker (/capture-sw.js) keeps this page so it opens
 * with no signal. Each capture is saved on the phone (IndexedDB — a
 * photograph is too big for localStorage) with a reference made here, then
 * sent. The server ignores a reference it has already seen, so a capture
 * sent twice when the signal dropped is never recorded twice. Anything not
 * yet sent survives closing the browser and goes when the signal is back.
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { captureDocument } from '@/app/actions/attachments';
import { prepareFile } from '@/components/app/attachments';
import { SupportDialog } from '@/components/app/help-menu';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { captureKindHints, captureKindLabels, captureKinds, checkCapture, parseCedis, type CaptureKind } from '@/lib/capture';

type Company = { id: string; name: string };

type Capture = {
  clientRef: string;
  entityId: string;
  entityName: string;
  kind: CaptureKind;
  amountMinor: number | null;
  date: string | null;
  note: string;
  fileName: string;
  contentType: string;
  /** Dropped once sent: the phone does not need to keep the photograph. */
  base64: string | null;
  byteSize: number;
  savedAt: string;
  status: 'waiting' | 'sent' | 'refused';
  error?: string;
};

// --- the queue on the phone ---------------------------------------------------------------------

const DB_NAME = 'sprouted-capture';
const STORE = 'captures';

function openQueue(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'clientRef' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readQueue(): Promise<Capture[]> {
  const db = await openQueue();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    request.onsuccess = () => resolve((request.result as Capture[]).sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
    request.onerror = () => reject(request.error);
  });
}

async function writeQueue(change: { put?: Capture[]; remove?: string[] }): Promise<void> {
  const db = await openQueue();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const capture of change.put ?? []) store.put(capture);
    for (const ref of change.remove ?? []) store.delete(ref);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Sent captures shown as a receipt: the last week's, thirty at most. */
function sentToForget(queue: Capture[]): string[] {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const sent = queue.filter((capture) => capture.status === 'sent');
  return sent.filter((capture, index) => index >= 30 || capture.savedAt < weekAgo).map((capture) => capture.clientRef);
}

function newRef(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `cap-${random}`;
}

const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

const cedis = (minor: number) => `GH₵${(minor / 100).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// The server's words for "not signed in" and "two-factor not set up": the
// capture is fine, the session is not, so it waits rather than being refused.
const sessionErrors = ['Sign in to continue.', 'Set up two-factor authentication to continue.'];

/** Whether the phone has a connection, as the browser sees it. */
function subscribeOnline(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

const label = 'mb-1.5 block text-sm font-medium text-slate-700';
const field = 'min-h-[52px] w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 focus:border-brand-700 focus:outline-none';

// --- the form ---------------------------------------------------------------------------------

export function CaptureForm({ user, companies, canOpenApp }: { user: { name: string }; companies: Company[]; canOpenApp: boolean }) {
  const [entityId, setEntityId] = useState(companies[0].id);
  const [kind, setKind] = useState<CaptureKind | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');

  const [queue, setQueue] = useState<Capture[]>([]);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const [sending, setSending] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [askingSupport, setAskingSupport] = useState(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sendingRef = useRef(false);

  const send = useCallback(async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      for (const capture of (await readQueue()).filter((item) => item.status === 'waiting').reverse()) {
        let result: Awaited<ReturnType<typeof captureDocument>>;
        try {
          result = await captureDocument(capture.entityId, {
            clientRef: capture.clientRef,
            kind: capture.kind,
            amountMinor: capture.amountMinor,
            date: capture.date,
            note: capture.note,
            fileName: capture.fileName,
            contentType: capture.contentType,
            base64: capture.base64 ?? '',
          });
        } catch {
          // No signal, or the server could not be reached: try again later.
          break;
        }
        if (!result.ok && sessionErrors.includes(result.error)) {
          setNeedsSignIn(true);
          break;
        }
        await writeQueue({ put: [result.ok ? { ...capture, status: 'sent', base64: null, error: undefined } : { ...capture, status: 'refused', error: result.error }] });
      }
      const all = await readQueue();
      const forget = sentToForget(all);
      if (forget.length) await writeQueue({ remove: forget });
      setQueue(all.filter((capture) => !forget.includes(capture.clientRef)));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, []);

  useEffect(() => {
    // Reading the phone's own queue and connection state on first load; there
    // is nothing to render from it on the server.
    readQueue()
      .then((saved) => setQueue(saved))
      .catch(() => setNotice({ tone: 'error', text: 'This browser will not keep captures on the phone. Send each one while you have signal.' }));
    // Signal back: send whatever waited for it.
    const up = () => void send();
    window.addEventListener('online', up);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/capture-sw.js').catch(() => undefined);
    if (navigator.onLine) void send();
    return () => window.removeEventListener('online', up);
  }, [send]);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  function choose(files: FileList | null) {
    const chosen = files?.[0];
    if (!chosen) return;
    setFile(chosen);
    setPreview(chosen.type.startsWith('image/') ? URL.createObjectURL(chosen) : null);
  }

  async function save() {
    setNotice(null);
    if (!kind) return setNotice({ tone: 'error', text: 'Choose what the document is.' });
    if (!file) return setNotice({ tone: 'error', text: 'Take a photo of it, or choose the file.' });
    const amountMinor = parseCedis(amount);
    if (amountMinor === undefined) return setNotice({ tone: 'error', text: 'The amount should be a number, like 150 or 150.50.' });
    const clientRef = newRef();
    const checked = checkCapture({ clientRef, kind, amountMinor, date: date || null, note }, today());
    if (!checked.ok) return setNotice({ tone: 'error', text: checked.error });

    setSaving(true);
    try {
      const prepared = await prepareFile(file);
      const capture: Capture = {
        ...checked.value,
        entityId,
        entityName: companies.find((company) => company.id === entityId)?.name ?? '',
        fileName: prepared.fileName,
        contentType: prepared.contentType,
        base64: prepared.base64,
        byteSize: prepared.byteSize,
        savedAt: new Date().toISOString(),
        status: 'waiting',
      };
      await writeQueue({ put: [capture] });
      setQueue(await readQueue());
    } catch {
      setSaving(false);
      return setNotice({ tone: 'error', text: 'That could not be saved on the phone. Try again.' });
    }
    setSaving(false);
    setFile(null);
    setPreview(null);
    setAmount('');
    setNote('');
    setNotice({ tone: 'ok', text: online ? 'Saved. Sending now…' : 'Saved on the phone. It will be sent when you have signal.' });
    if (online) void send();
  }

  async function forget(ref: string) {
    await writeQueue({ remove: [ref] });
    setQueue(await readQueue());
  }

  const waiting = queue.filter((capture) => capture.status === 'waiting');
  const refused = queue.filter((capture) => capture.status === 'refused');
  const sent = queue.filter((capture) => capture.status === 'sent');

  return (
    <main className="mx-auto min-h-screen max-w-md bg-[#F6F4EF] px-4 pb-16 pt-4 text-slate-900">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Sprouted · send a document</p>
          <h1 className="text-xl font-semibold">{user.name}</h1>
        </div>
        <span className={['rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]', online ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'].join(' ')}>
          {online ? 'Online' : 'Offline — saving on phone'}
        </span>
      </header>

      {needsSignIn ? (
        <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          You have been signed out, so nothing can be sent. Your captures are safe on the phone.{' '}
          <a className="font-semibold underline" href="/sign-in?next=%2Fcapture">Sign in again</a>
        </p>
      ) : null}
      {notice ? (
        <p className={['mt-3 rounded-xl border px-3 py-2 text-sm', notice.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'].join(' ')}>{notice.text}</p>
      ) : null}

      <section className="mt-4 space-y-5">
        {companies.length > 1 ? (
          <div>
            <label className={label} htmlFor="company">Company</label>
            <select id="company" className={field} value={entityId} onChange={(event) => setEntityId(event.target.value)}>
              {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </div>
        ) : (
          <p className="text-sm text-slate-600">For <span className="font-medium text-slate-900">{companies[0].name}</span></p>
        )}

        <div>
          <p className={label}>What is it?</p>
          <div className="grid grid-cols-2 gap-3">
            {captureKinds.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setKind(option)}
                className={[
                  'min-h-[72px] rounded-xl border px-3 py-2 text-left transition duration-150 ease-out active:scale-[0.98]',
                  kind === option ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white text-slate-900',
                ].join(' ')}
              >
                <span className="block text-base font-semibold">{captureKindLabels[option]}</span>
                <span className={['block text-xs', kind === option ? 'text-white/80' : 'text-slate-500'].join(' ')}>{captureKindHints[option]}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className={label}>The document</p>
          <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="hidden" onChange={(event) => { choose(event.target.files); event.target.value = ''; }} />
          <input ref={fileInput} type="file" accept="image/*,application/pdf" className="hidden" onChange={(event) => { choose(event.target.files); event.target.value = ''; }} />
          {file ? (
            <div className="flex items-center gap-3 rounded-xl border border-slate-300 bg-white p-3">
              {/* A photograph still on the phone (a blob: address), which next/image cannot load. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {preview ? <img src={preview} alt="" className="h-20 w-16 rounded-lg object-cover" /> : <span className="flex h-20 w-16 items-center justify-center rounded-lg bg-slate-100 text-xs font-semibold text-slate-500">PDF</span>}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <button type="button" className="mt-1 text-sm text-brand-800 underline" onClick={() => cameraInput.current?.click()}>Take it again</button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <button type="button" onClick={() => cameraInput.current?.click()} className="min-h-[56px] rounded-xl bg-brand-700 text-base font-semibold text-white active:scale-[0.98]">Take a photo</button>
              <button type="button" onClick={() => fileInput.current?.click()} className="min-h-[56px] rounded-xl border border-slate-300 bg-white text-base font-medium text-slate-800 active:scale-[0.98]">Choose a file</button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label} htmlFor="amount">Amount (GH₵){kind === 'expense-claim' ? '' : ' — optional'}</label>
            <input id="amount" className={field} inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </div>
          <div>
            <label className={label} htmlFor="date">Date on it</label>
            <input id="date" type="date" className={field} value={date} max={today()} onChange={(event) => setDate(event.target.value)} />
          </div>
        </div>

        <div>
          <label className={label} htmlFor="note">Note — optional</label>
          <textarea
            id="note"
            rows={2}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-base focus:border-brand-700 focus:outline-none"
            placeholder={kind === 'expense-claim' ? 'What was it for?' : 'Anything finance should know'}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>

        <button type="button" disabled={saving} onClick={() => void save()} className="min-h-[56px] w-full rounded-xl bg-brand-700 text-lg font-semibold text-white active:scale-[0.99] disabled:opacity-60">
          {saving ? 'Saving…' : 'Send'}
        </button>
      </section>

      {waiting.length ? (
        <section className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Waiting to send ({waiting.length})</h2>
            <button type="button" disabled={sending || !online} onClick={() => void send()} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium disabled:opacity-50">
              {sending ? 'Sending…' : 'Send now'}
            </button>
          </div>
          <CaptureList captures={waiting} />
        </section>
      ) : null}

      {refused.length ? (
        <section className="mt-8">
          <h2 className="text-base font-semibold text-rose-900">Could not be sent</h2>
          <CaptureList captures={refused} onForget={(ref) => void forget(ref)} />
        </section>
      ) : null}

      {sent.length ? (
        <section className="mt-8">
          <h2 className="text-base font-semibold">Sent this week</h2>
          <CaptureList captures={sent} />
        </section>
      ) : null}

      <p className="mt-10 flex justify-center gap-5 text-sm">
        <a className="text-brand-800 underline" href="/user-guide.html#for-staff" target="_blank" rel="noopener">How to use this</a>
        <button type="button" className="text-brand-800 underline" onClick={() => setAskingSupport(true)}>Contact support</button>
      </p>
      {askingSupport ? <SupportDialog where={{ entityId, screen: 'Phone capture' }} onClose={() => setAskingSupport(false)} /> : null}
      <p className="mt-3 text-center text-sm">
        {canOpenApp ? (
          <Link className="text-brand-800 underline" href="/">Open the full app</Link>
        ) : (
          <SignOutButton className="text-brand-800 underline" />
        )}
      </p>
    </main>
  );
}

function CaptureList({ captures, onForget }: { captures: Capture[]; onForget?: (ref: string) => void }) {
  return (
    <ul className="mt-2 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
      {captures.map((capture) => (
        <li key={capture.clientRef} className="px-3 py-2.5 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-medium">{captureKindLabels[capture.kind]}</span>
            <span className="tabular-nums">{capture.amountMinor === null ? '' : cedis(capture.amountMinor)}</span>
          </div>
          <p className="text-xs text-slate-500">
            {capture.entityName}
            {capture.date ? ` · ${capture.date}` : ''}
            {capture.note ? ` · ${capture.note}` : ''}
          </p>
          {capture.error ? (
            <p className="mt-1 text-xs text-rose-800">
              {capture.error}
              {onForget ? (
                <button type="button" className="ml-2 font-semibold underline" onClick={() => onForget(capture.clientRef)}>Remove</button>
              ) : null}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
