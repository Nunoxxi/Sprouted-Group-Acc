'use client';

/**
 * The attachment inbox: upload a receipt now, match it to a transaction
 * later. Also where the rules live that say when a transaction must carry a
 * document before it can be posted.
 */

import { useMemo, useRef, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { attachmentUrl, inboxSuggestions, matchAttachment, removeAttachment, saveAttachmentRule, unmatchAttachment, uploadAttachment, type InboxSuggestion } from '@/app/actions/attachments';
import { prepareFile } from '@/components/app/attachments';
import type { Permission } from '@/lib/authz';
import type { AttachmentRecord, AttachmentRuleRecord, DocumentRecord, EntityRecord } from '@/lib/data/types';
import { acceptedTypes, attachmentTargetLabels, ruleTargets, type AttachmentTarget } from '@/lib/attachments';

const accept = Object.keys(acceptedTypes).join(',');
const label = 'mb-1.5 block text-sm font-medium text-slate-700';
const sizeText = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(Math.round(bytes / 1024), 1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

type Props = {
  entity: EntityRecord;
  attachments: AttachmentRecord[];
  rules: AttachmentRuleRecord[];
  documents: DocumentRecord[];
  allowed: (permission: Permission) => boolean;
  currentUserId: string;
};

export function InboxPanel({ entity, attachments, rules, documents, allowed, currentUserId }: Props) {
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const [suggestions, setSuggestions] = useState<InboxSuggestion[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [ruleForm, setRuleForm] = useState<{ target: AttachmentTarget; threshold: string; isActive: boolean }>({ target: 'bill', threshold: '', isActive: true });

  const waiting = useMemo(() => attachments.filter((row) => row.target === 'inbox'), [attachments]);
  const attached = useMemo(() => attachments.filter((row) => row.target !== 'inbox').slice(0, 50), [attachments]);
  const documentById = useMemo(() => new Map(documents.map((row) => [row.id, row])), [documents]);

  function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setMessage(null);
    startTransition(async () => {
      for (const file of Array.from(files)) {
        const prepared = await prepareFile(file);
        const result = await uploadAttachment(entity.id, { fileName: prepared.fileName, contentType: prepared.contentType, base64: prepared.base64, target: 'inbox' });
        if (!result.ok) {
          setMessage({ tone: 'error', text: result.error });
          return;
        }
      }
      setMessage({ tone: 'ok', text: 'In the inbox. Match it to a transaction when you are ready.' });
      setSuggestions([]);
    });
  }

  function open(id: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await attachmentUrl(entity.id, id);
      if (result.ok) window.open(result.value.url, '_blank', 'noopener,noreferrer');
      else setMessage({ tone: 'error', text: result.error });
    });
  }

  function run(okText: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) setMessage({ tone: 'ok', text: okText });
      else setMessage({ tone: 'error', text: result.error ?? 'Something went wrong.' });
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{entity.name}</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-900">Attachment inbox</h2>
          <p className="mt-1 text-sm text-slate-600">Upload receipts as they come in and match them to transactions later. Files are kept in cloud storage, not in the database.</p>
        </div>
        {allowed('document:draft') ? (
          <div className="flex flex-wrap gap-2">
            <input ref={fileInput} type="file" accept={accept} multiple className="hidden" onChange={(event) => { upload(event.target.files); event.target.value = ''; }} />
            <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="hidden" onChange={(event) => { upload(event.target.files); event.target.value = ''; }} />
            <Button size="sm" disabled={pending} onClick={() => fileInput.current?.click()}>
              {pending ? 'Uploading…' : 'Upload files'}
            </Button>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => cameraInput.current?.click()}>
              Photograph a receipt
            </Button>
          </div>
        ) : null}
      </div>

      {message ? (
        <div className={['rounded-xl border px-4 py-3 text-sm', message.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'].join(' ')}>{message.text}</div>
      ) : null}

      <Card className="rounded-2xl">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="text-lg font-semibold text-slate-900">
            Waiting to be matched
            {waiting.length ? <span className="ml-2 text-sm font-normal text-slate-500">{waiting.length}</span> : null}
          </h3>
          {waiting.length ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await inboxSuggestions(entity.id);
                  if (result.ok) setSuggestions(result.value);
                  else setMessage({ tone: 'error', text: result.error });
                })
              }
            >
              Suggest matches
            </Button>
          ) : null}
        </div>

        {waiting.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">Nothing waiting. Anything uploaded here sits until you match it.</p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-100">
            {waiting.map((row) => {
              const suggested = suggestions.find((item) => item.attachmentId === row.id)?.candidates ?? [];
              return (
                <li key={row.id} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <button type="button" className="truncate text-left font-medium text-brand-700 underline-offset-2 hover:underline" onClick={() => open(row.id)}>
                        {row.fileName}
                      </button>
                      <p className="text-xs text-slate-500">
                        {sizeText(row.byteSize)} · uploaded {row.uploadedAt.slice(0, 10)}
                        {row.uploadedByName ? ` by ${row.uploadedByName}` : ''}
                      </p>
                    </div>
                    {allowed('document:draft') ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          className="min-h-[36px] rounded-lg border border-slate-200 bg-white px-2 text-xs"
                          value={choice[row.id] ?? ''}
                          onChange={(event) => setChoice((current) => ({ ...current, [row.id]: event.target.value }))}
                        >
                          <option value="">Match to…</option>
                          {suggested.length ? (
                            <optgroup label="Suggested">
                              {suggested.map((candidate) => (
                                <option key={candidate.id} value={`${candidate.target}:${candidate.id}`}>
                                  {candidate.reference || candidate.id.slice(-6)} · {candidate.date} · {(candidate.amountMinor / 100).toFixed(2)}
                                </option>
                              ))}
                            </optgroup>
                          ) : null}
                          <optgroup label="Invoices and bills">
                            {documents
                              .filter((document) => document.status !== 'voided')
                              .slice(0, 100)
                              .map((document) => (
                                <option key={document.id} value={`${document.kind}:${document.id}`}>
                                  {document.docNumber || 'draft'} · {document.contactName} · {document.date}
                                </option>
                              ))}
                          </optgroup>
                        </select>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={pending || !choice[row.id]}
                          onClick={() => {
                            const [target, id] = (choice[row.id] ?? '').split(':');
                            run('Matched.', () => matchAttachment(entity.id, row.id, target as AttachmentTarget, id));
                          }}
                        >
                          Match
                        </Button>
                        {row.uploadedById === currentUserId ? (
                          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run('Removed.', () => removeAttachment(entity.id, row.id))}>
                            Remove
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card className="rounded-2xl">
        <h3 className="text-lg font-semibold text-slate-900">Recently attached</h3>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
              <tr>
                <th className="py-2">File</th>
                <th className="py-2">Attached to</th>
                <th className="py-2">When</th>
                <th className="py-2">By</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {attached.map((row) => {
                const document = row.targetId ? documentById.get(row.targetId) : undefined;
                const posted = !!document && document.status !== 'draft';
                return (
                  <tr key={row.id}>
                    <td className="py-2">
                      <button type="button" className="text-left text-brand-700 underline-offset-2 hover:underline" onClick={() => open(row.id)}>
                        {row.fileName}
                      </button>
                    </td>
                    <td className="py-2 text-slate-600">
                      {attachmentTargetLabels[row.target]}
                      {document ? ` ${document.docNumber || 'draft'} — ${document.contactName}` : ''}
                    </td>
                    <td className="py-2 text-slate-600">{row.uploadedAt.slice(0, 10)}</td>
                    <td className="py-2 text-slate-600">{row.uploadedByName}</td>
                    <td className="py-2 text-right">
                      {allowed('document:draft') && !posted && row.uploadedById === currentUserId ? (
                        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run('Back in the inbox.', () => unmatchAttachment(entity.id, row.id))}>
                          Unmatch
                        </Button>
                      ) : (
                        <span className="text-xs text-slate-400">posted</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {attached.length === 0 ? (
                <tr>
                  <td className="py-2 text-slate-500" colSpan={5}>
                    Nothing attached yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="rounded-2xl">
        <h3 className="text-lg font-semibold text-slate-900">When a document is required</h3>
        <p className="mt-1 text-sm text-slate-600">
          At or above the amount you set, that kind of transaction cannot be posted without something attached. A threshold of nothing means every one of them.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td className="py-2 text-slate-900">{attachmentTargetLabels[rule.target]}</td>
                  <td className="py-2 text-slate-600">
                    {rule.isActive ? (
                      rule.thresholdMinor > 0 ? (
                        <>
                          required at <Money value={rule.thresholdMinor} /> and above
                        </>
                      ) : (
                        'required on every one'
                      )
                    ) : (
                      'not required'
                    )}
                  </td>
                  <td className="py-2 text-right">
                    {allowed('document:post') ? (
                      <Button size="sm" variant="ghost" onClick={() => setRuleForm({ target: rule.target, threshold: (rule.thresholdMinor / 100).toFixed(2), isActive: rule.isActive })}>
                        Change
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {rules.length === 0 ? (
                <tr>
                  <td className="py-2 text-slate-500">No rules yet — nothing is required.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {allowed('document:post') ? (
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div>
              <label className={label}>Kind</label>
              <select className="min-h-[44px] rounded-lg border border-slate-200 bg-white px-3 text-sm" value={ruleForm.target} onChange={(event) => setRuleForm((f) => ({ ...f, target: event.target.value as AttachmentTarget }))}>
                {ruleTargets.map((target) => (
                  <option key={target} value={target}>
                    {attachmentTargetLabels[target]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={label}>Required at and above</label>
              <Input inputMode="decimal" value={ruleForm.threshold} onChange={(event) => setRuleForm((f) => ({ ...f, threshold: event.target.value }))} placeholder="5000.00" />
            </div>
            <div>
              <label className={label}>Switched on?</label>
              <select className="min-h-[44px] rounded-lg border border-slate-200 bg-white px-3 text-sm" value={ruleForm.isActive ? 'yes' : 'no'} onChange={(event) => setRuleForm((f) => ({ ...f, isActive: event.target.value === 'yes' }))}>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </div>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                run('Rule saved.', () =>
                  saveAttachmentRule(entity.id, {
                    target: ruleForm.target,
                    thresholdMinor: ruleForm.threshold ? Math.round(Number(ruleForm.threshold.replace(/,/g, '')) * 100) : 0,
                    isActive: ruleForm.isActive,
                  }),
                )
              }
            >
              Save
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
