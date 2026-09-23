'use client';

/**
 * Attachments on a transaction: what is already there, and a way to add
 * more — from a file, or straight from a phone's camera.
 *
 * Photographs are reduced here, in the browser, before anything is sent. A
 * weighbridge ticket off a modern phone is four thousand pixels across and
 * several megabytes; none of that is needed to read it, and a field agent on
 * a patchy connection should not have to upload it.
 */

import { useRef, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { removeAttachment, attachmentUrl, uploadAttachment } from '@/app/actions/attachments';
import type { AttachmentRecord, AttachmentRuleRecord } from '@/lib/data/types';
import { acceptedTypes, imageQuality, isImage, maxImageEdge, plannedSize, ruleFor, type AttachmentTarget } from '@/lib/attachments';

const accept = Object.keys(acceptedTypes).join(',');

/**
 * Reduce a photograph before it is uploaded. A PDF is left exactly as it is:
 * it is already a document, and re-encoding one would only lose something.
 */
export async function prepareFile(file: File): Promise<{ base64: string; contentType: string; fileName: string; byteSize: number }> {
  const asBase64 = (buffer: ArrayBuffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
  };

  if (!isImage(file.type) || typeof createImageBitmap !== 'function') {
    return { base64: asBase64(await file.arrayBuffer()), contentType: file.type, fileName: file.name, byteSize: file.size };
  }

  try {
    const bitmap = await createImageBitmap(file);
    const size = plannedSize(bitmap.width, bitmap.height, maxImageEdge);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no canvas');
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', imageQuality));
    if (!blob) throw new Error('no blob');
    return { base64: asBase64(await blob.arrayBuffer()), contentType: 'image/jpeg', fileName: file.name.replace(/\.[^.]+$/, '') + '.jpg', byteSize: blob.size };
  } catch {
    // A format the browser cannot decode — an iPhone HEIC on a desktop, say.
    // Send it as it came and let the server keep it.
    return { base64: asBase64(await file.arrayBuffer()), contentType: file.type, fileName: file.name, byteSize: file.size };
  }
}

const sizeText = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(Math.round(bytes / 1024), 1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

type Props = {
  entityId: string;
  target: AttachmentTarget;
  targetId: string | null;
  attachments: AttachmentRecord[];
  rules: AttachmentRuleRecord[];
  /** The transaction's value, for saying what the rule will ask for. */
  amountMinor?: number;
  /** A posted transaction's attachments stay: nothing can be removed. */
  posted: boolean;
  currentUserId: string;
  canEdit: boolean;
};

export function Attachments({ entityId, target, targetId, attachments, rules, amountMinor = 0, posted, currentUserId, canEdit }: Props) {
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  const mine = attachments.filter((row) => row.target === target && row.targetId === targetId);
  const rule = ruleFor(
    rules.map((row) => ({ target: row.target, thresholdMinor: row.thresholdMinor, isActive: row.isActive })),
    target,
  );
  const required = !!rule && Math.abs(amountMinor) >= rule.thresholdMinor;

  function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setMessage(null);
    startTransition(async () => {
      for (const file of Array.from(files)) {
        const prepared = await prepareFile(file);
        const result = await uploadAttachment(entityId, {
          fileName: prepared.fileName,
          contentType: prepared.contentType,
          base64: prepared.base64,
          target: targetId ? target : 'inbox',
          targetId,
        });
        if (!result.ok) {
          setMessage({ tone: 'error', text: result.error });
          return;
        }
      }
      setMessage({ tone: 'ok', text: targetId ? 'Attached.' : 'Put in the inbox — match it to a transaction later.' });
    });
  }

  function open(id: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await attachmentUrl(entityId, id);
      if (result.ok) window.open(result.value.url, '_blank', 'noopener,noreferrer');
      else setMessage({ tone: 'error', text: result.error });
    });
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Attachments
          {mine.length ? <span className="ml-2 font-normal tracking-normal text-slate-600">{mine.length}</span> : null}
        </p>
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <input ref={fileInput} type="file" accept={accept} multiple className="hidden" onChange={(event) => { upload(event.target.files); event.target.value = ''; }} />
            <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="hidden" onChange={(event) => { upload(event.target.files); event.target.value = ''; }} />
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => fileInput.current?.click()}>
              {pending ? 'Uploading…' : 'Attach a file'}
            </Button>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => cameraInput.current?.click()}>
              Photograph
            </Button>
          </div>
        ) : null}
      </div>

      {required && mine.length === 0 ? (
        <p className="mt-2 text-sm text-amber-800">
          {rule.thresholdMinor > 0 ? `This needs a document attached before it can be posted.` : 'Every one of these needs a document attached before it can be posted.'}
        </p>
      ) : null}

      {message ? <p className={['mt-2 text-sm', message.tone === 'ok' ? 'text-emerald-700' : 'text-rose-700'].join(' ')}>{message.text}</p> : null}

      {mine.length ? (
        <ul className="mt-3 divide-y divide-slate-100">
          {mine.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <div className="min-w-0">
                <button type="button" className="truncate text-left font-medium text-brand-700 underline-offset-2 hover:underline" onClick={() => open(row.id)}>
                  {row.fileName}
                </button>
                <p className="text-xs text-slate-500">
                  {sizeText(row.byteSize)} · {row.uploadedAt.slice(0, 10)}
                  {row.uploadedByName ? ` · ${row.uploadedByName}` : ''}
                </p>
              </div>
              {canEdit && !posted && row.uploadedById === currentUserId ? (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => startTransition(async () => {
                  const result = await removeAttachment(entityId, row.id);
                  if (!result.ok) setMessage({ tone: 'error', text: result.error });
                })}>
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-slate-500">{posted ? 'Nothing was attached to this.' : 'Nothing attached yet.'}</p>
      )}

      {posted && mine.length ? <p className="mt-2 text-xs text-slate-500">This has been posted, so its attachments stay. More can still be added.</p> : null}
    </div>
  );
}
