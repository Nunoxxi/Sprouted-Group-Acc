'use client';

/**
 * Go-live: the cut-over date, the Excel template, uploading and posting
 * each opening section, the control reconciliations, and the checklist
 * that has to be complete before the entity goes live. Every change goes
 * through src/app/actions/opening.ts.
 */

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { discardOpeningBatch, goLive, openingChecklist, openingTemplate, postOpeningBatch, setCutOverDate, uploadOpeningWorkbook, type UploadResult } from '@/app/actions/opening';
import type { Permission } from '@/lib/authz';
import type { EntityRecord, OpeningStatusRecord } from '@/lib/data/types';
import { sectionLabels, type OpeningSection, type RowError } from '@/lib/opening';

type Props = { entity: EntityRecord; opening: OpeningStatusRecord; allowed: (permission: Permission) => boolean };
type ChecklistItem = { key: string; label: string; done: boolean; detail: string };

const label = 'mb-1.5 block text-sm font-medium text-slate-700';
const todayIso = () => new Date().toISOString().slice(0, 10);

export function OpeningPanel({ entity, opening, allowed }: Props) {
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<OpeningStatusRecord>(opening);
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [canGoLive, setCanGoLive] = useState(false);
  const [uploadErrors, setUploadErrors] = useState<{ section: OpeningSection; rows: RowError[] }[]>([]);
  const [cutOver, setCutOver] = useState(entity.cutOverDate ?? todayIso());
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    startTransition(async () => {
      const result = await openingChecklist(entity.id);
      if (result.ok) { setStatus(result.value.status); setItems(result.value.items); setCanGoLive(result.value.canGoLive); }
      else setMessage({ tone: 'error', text: result.error });
    });
  }, [entity.id]);
  // The checklist is computed from the ledger, so it is read on open and after
  // each change; load only sets state once the server has answered.
  useEffect(() => {
    load();
  }, [load, opening]);

  function run(okText: string, action: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) { setMessage({ tone: 'ok', text: okText }); after?.(); load(); } else setMessage({ tone: 'error', text: result.error ?? 'Something went wrong.' });
    });
  }

  function downloadTemplate() {
    setMessage(null);
    startTransition(async () => {
      const result = await openingTemplate(entity.id);
      if (!result.ok) { setMessage({ tone: 'error', text: result.error }); return; }
      const bytes = Uint8Array.from(atob(result.value.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url; a.download = result.value.fileName; a.click();
      URL.revokeObjectURL(url);
    });
  }

  function upload(file: File) {
    setMessage(null);
    setUploadErrors([]);
    startTransition(async () => {
      const base64 = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
      const result = await uploadOpeningWorkbook(entity.id, file.name, base64);
      if (!result.ok) { setMessage({ tone: 'error', text: result.error }); return; }
      const value = result.value as UploadResult;
      setUploadErrors(value.errors);
      setMessage({ tone: value.errors.length ? 'error' : 'ok', text: value.batches.length ? `${value.batches.length} sheet(s) read; review and post them below.` : 'No sheet could be read — see the errors below.' });
      load();
      if (fileRef.current) fileRef.current.value = '';
    });
  }

  const live = !!status.liveAt;
  const drafts = status.batches.filter((b) => b.status === 'draft');
  const posted = status.batches.filter((b) => b.status === 'posted');

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{entity.name}</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-900">{live ? 'Live' : 'Go-live'}</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            {live
              ? `${entity.name} went live on ${status.liveAt?.slice(0, 10)}, with opening balances as at ${status.cutOverDate}. Opening imports are closed; corrections are ordinary journals.`
              : 'Import the balances as at your cut-over date. The trial balance posts first with its control accounts held in Opening Balance Suspense; each detail sheet then clears them. Anything that does not match stays in suspense, and the entity cannot go live until it is zero.'}
          </p>
        </div>
        {!live && allowed('entity:configure') ? (
          <Button disabled={pending || !canGoLive} onClick={() => run(`${entity.name} is live.`, () => goLive(entity.id))}>Go live</Button>
        ) : null}
      </div>

      {message ? <p className={['rounded-lg border px-3 py-2 text-sm', message.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800'].join(' ')}>{message.text}</p> : null}

      <Card className="rounded-2xl">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Checklist</p>
        <div className="mt-3 divide-y divide-slate-200">
          {items.map((item) => (
            <div key={item.key} className="flex items-start gap-3 py-2">
              <span className={['mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold', item.done ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-500'].join(' ')}>{item.done ? '✓' : ''}</span>
              <span className="text-sm"><span className={item.done ? 'text-slate-900' : 'font-medium text-slate-900'}>{item.label}</span><span className="block text-xs text-slate-600">{item.detail}</span></span>
            </div>
          ))}
          {items.length === 0 ? <p className="py-2 text-sm text-slate-600">Loading…</p> : null}
        </div>
        {status.suspenseMinor !== 0 ? (
          <p className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900"><span className="font-semibold">Opening Balance Suspense holds <Money value={status.suspenseMinor} />.</span> That is the difference between the trial balance&rsquo;s control accounts and the detail you have imported. Post the missing sheet, or correct the figures and re-import.</p>
        ) : null}
      </Card>

      {status.controls.length > 0 ? (
        <Card className="rounded-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Control accounts</p>
          <div className="mt-3 overflow-x-auto">
            <div className="grid min-w-[620px] grid-cols-[1.4fr_1fr_1fr_1fr_100px] gap-3 rounded-t-xl bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500"><span>Control</span><span className="text-right">Trial balance</span><span className="text-right">Detail imported</span><span className="text-right">Difference</span><span /></div>
            {status.controls.map((c) => (
              <div key={c.label} className={['grid min-w-[620px] grid-cols-[1.4fr_1fr_1fr_1fr_100px] gap-3 border-t border-slate-200 px-3 py-2 text-sm', c.reconciles ? '' : 'bg-amber-50'].join(' ')}>
                <span>{c.label}</span>
                <span className="text-right font-mono"><Money value={c.trialBalanceMinor} /></span>
                <span className="text-right font-mono"><Money value={c.detailMinor} /></span>
                <span className={['text-right font-mono', c.reconciles ? 'text-slate-500' : 'font-semibold text-amber-900'].join(' ')}><Money value={c.differenceMinor} /></span>
                <span className="text-right"><span className={['rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]', c.reconciles ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-200 text-amber-900'].join(' ')}>{c.reconciles ? 'agrees' : 'open'}</span></span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {!live ? (
        <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
          <div className="space-y-6">
            <Card className="rounded-2xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">1 · Cut-over date</p>
              <p className="mt-1 text-sm text-slate-600">The date the balances are as at. Every opening journal is dated here.</p>
              <div className="mt-3 flex items-end gap-2">
                <div className="flex-1"><label className={label}>Cut-over</label><Input type="date" value={cutOver} disabled={!allowed('entity:configure') || posted.length > 0} onChange={(e) => setCutOver(e.target.value)} /></div>
                {allowed('entity:configure') ? <Button size="sm" variant="secondary" disabled={pending || posted.length > 0 || cutOver === entity.cutOverDate} onClick={() => run(`Cut-over date set to ${cutOver}.`, () => setCutOverDate(entity.id, cutOver))}>Save</Button> : null}
              </div>
              {posted.length > 0 ? <p className="mt-2 text-xs text-slate-500">Fixed: opening balances have been posted at {status.cutOverDate}.</p> : null}
            </Card>

            <Card className="rounded-2xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">2 · The template</p>
              <p className="mt-1 text-sm text-slate-600">An Excel workbook for {entity.name}, with its chart, grades, locations, agents and contacts already in it. One sheet per section; fill in what applies.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={pending} onClick={downloadTemplate}>Download template</Button>
                {allowed('entity:configure') ? (
                  <>
                    <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) upload(file); }} />
                    <Button size="sm" disabled={pending || !status.cutOverDate} onClick={() => fileRef.current?.click()}>Upload filled-in file</Button>
                  </>
                ) : null}
              </div>
              {!status.cutOverDate ? <p className="mt-2 text-xs text-amber-800">Set the cut-over date before uploading.</p> : null}
            </Card>
          </div>

          <div className="space-y-6">
            {uploadErrors.length > 0 ? (
              <Card className="rounded-2xl border-red-300 bg-red-50">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-red-700">Sheets not accepted</p>
                <p className="mt-1 text-sm text-red-900">Fix these rows in the file and upload it again. Nothing from a sheet with an error is saved.</p>
                <div className="mt-3 space-y-3">
                  {uploadErrors.map((e) => (
                    <div key={e.section}>
                      <div className="text-sm font-semibold text-red-900">{sectionLabels[e.section]}</div>
                      <ul className="mt-1 space-y-0.5 text-xs text-red-800">
                        {e.rows.slice(0, 20).map((r, i) => <li key={i}>{r.row > 0 ? `Row ${r.row}: ` : ''}{r.message}</li>)}
                        {e.rows.length > 20 ? <li>…and {e.rows.length - 20} more.</li> : null}
                      </ul>
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}

            <Card className="rounded-2xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">3 · Review and post</p>
              <p className="mt-1 text-sm text-slate-600">Post the trial balance first; the detail sheets clear what it puts into suspense.</p>
              <div className="mt-3 divide-y divide-slate-200">
                {drafts.map((batch) => (
                  <div key={batch.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div>
                      <span className="font-medium text-slate-900">{sectionLabels[batch.section]}</span>
                      <span className="block text-xs text-slate-500">{batch.rowCount} row{batch.rowCount === 1 ? '' : 's'} · {batch.fileName} · uploaded by {batch.createdByName}</span>
                    </div>
                    {allowed('document:post') ? (
                      <span className="flex gap-2">
                        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run('Draft discarded.', () => discardOpeningBatch(entity.id, batch.id))}>Discard</Button>
                        <Button size="sm" disabled={pending} onClick={() => run(`${sectionLabels[batch.section]} posted.`, () => postOpeningBatch(entity.id, batch.id))}>Post</Button>
                      </span>
                    ) : null}
                  </div>
                ))}
                {drafts.length === 0 ? <p className="py-2 text-sm text-slate-600">Nothing waiting. Upload a filled-in template.</p> : null}
              </div>
            </Card>

            {posted.length > 0 ? (
              <Card className="rounded-2xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Posted</p>
                <div className="mt-3 divide-y divide-slate-200 text-sm">
                  {posted.map((batch) => (
                    <div key={batch.id} className="flex items-center justify-between gap-3 py-2">
                      <span>{sectionLabels[batch.section]}<span className="block text-xs text-slate-500">{batch.rowCount} rows · posted {batch.postedAt?.slice(0, 10)}</span></span>
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-800">posted</span>
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
