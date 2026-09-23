'use client';

/**
 * A telephone or mobile money number, shown with only its last digits until
 * somebody asks for the rest.
 *
 * The full number is not in the page: the server masked it before the page
 * was built. Asking for it fetches that one number and records who asked and
 * why, which is the whole reason the mask is worth anything.
 */

import { useState, useTransition } from 'react';

import { revealPersonalDetail } from '@/app/actions/privacy';
import type { Permission } from '@/lib/authz';
import type { SubjectKind } from '@/lib/privacy';

type Props = {
  entityId: string;
  subjectKind: SubjectKind;
  subjectId: string;
  /** Which stored value, as `Model.field`. */
  field: string;
  /** The masked value as it arrived from the server. */
  masked: string;
  allowed: (permission: Permission) => boolean;
  /** Shown in place of nothing at all. */
  empty?: string;
  className?: string;
};

export function MaskedDetail({ entityId, subjectKind, subjectId, field, masked, allowed, empty = '—', className }: Props) {
  const [shown, setShown] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();

  if (!masked) return <span className={className}>{empty}</span>;
  if (shown) return <span className={className}>{shown}</span>;

  function show() {
    setError('');
    startTransition(async () => {
      const result = await revealPersonalDetail(entityId, { subjectKind, subjectId, field, reason });
      if (result.ok) {
        setShown(result.value.value);
        setAsking(false);
      } else setError(result.error);
    });
  }

  return (
    <span className={className}>
      {masked}
      {allowed('pii:view') ? (
        asking ? (
          <span className="ml-2 inline-flex items-center gap-1 align-middle">
            <input
              autoFocus
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && reason.trim()) show();
                if (event.key === 'Escape') { setAsking(false); setError(''); }
              }}
              placeholder="Why do you need it?"
              className="w-44 rounded border border-slate-300 px-1.5 py-0.5 text-xs"
            />
            <button type="button" className="text-xs font-medium text-brand-700 disabled:text-slate-400" disabled={pending || !reason.trim()} onClick={show}>
              {pending ? '…' : 'Show'}
            </button>
            <button type="button" className="text-xs text-slate-500" onClick={() => { setAsking(false); setError(''); }}>Cancel</button>
          </span>
        ) : (
          <button type="button" className="ml-2 text-xs font-medium text-brand-700 underline-offset-2 hover:underline" onClick={() => setAsking(true)}>
            Show
          </button>
        )
      ) : null}
      {error ? <span className="ml-2 text-xs text-rose-600">{error}</span> : null}
    </span>
  );
}

/**
 * Fetch the real values behind a masked record so that it can be edited.
 * Returns null when the caller may not see them, so the form is not opened
 * half-filled with dots that would be saved back over the real number.
 */
export async function revealForEditing(entityId: string, subjectKind: SubjectKind, subjectId: string, fields: string[]): Promise<Record<string, string> | string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const result = await revealPersonalDetail(entityId, { subjectKind, subjectId, field, reason: 'Opened the record to edit it' });
    if (result.ok) values[field] = result.value.value;
    else if (!/Nothing is held there/.test(result.error)) return result.error;
    else values[field] = '';
  }
  return values;
}
