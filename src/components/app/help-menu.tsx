'use client';

/**
 * The ? button at the top of the app: the user guide, and a form to ask
 * support for help. The form is also used on its own on the phone capture
 * page, where there is no header.
 */

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from 'react';

import { contactSupport } from '@/app/actions/support';
import { maxSupportMessage, supportTopicLabels, supportTopics, type SupportTopic } from '@/lib/support';

type Where = { entityId: string | null; screen: string };

export function HelpMenu({ where, onOpenGuide }: { where: Where; onOpenGuide: () => void }) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // Closes on a click anywhere else, or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const item = 'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-slate-700 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-900';

  return (
    <div ref={menu} className="relative">
      <button
        type="button"
        aria-label="Help"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((current) => !current)}
        className={[
          'flex h-9 w-9 items-center justify-center rounded-full border text-base font-semibold transition duration-150 ease-out active:scale-95',
          open ? 'border-brand-700 bg-brand-50 text-brand-800' : 'border-slate-300 bg-white text-slate-600 hover:border-brand-700 hover:text-brand-800',
        ].join(' ')}
      >
        ?
      </button>
      {open ? (
        <div id={menuId} role="menu" className="absolute right-0 z-30 mt-2 w-56 animate-fadeIn rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              onOpenGuide();
            }}
          >
            <span aria-hidden className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 text-[11px]">?</span>
            User guide
          </button>
          <div className="my-1 border-t border-slate-100" />
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              setAsking(true);
            }}
          >
            <span aria-hidden className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 text-[11px]">@</span>
            Contact support
          </button>
        </div>
      ) : null}
      {asking ? <SupportDialog where={where} onClose={() => setAsking(false)} /> : null}
    </div>
  );
}

/** The form itself, over the page. Says where it went once sent. */
export function SupportDialog({ where, onClose }: { where: Where; onClose: () => void }) {
  const [topic, setTopic] = useState<SupportTopic>('how-to');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const titleId = useId();

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await contactSupport({ entityId: where.entityId, screen: where.screen, topic, message });
      if (result.ok) setSentTo(result.value.sentTo);
      else setError(result.error);
    });
  }

  const field = 'w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 focus:border-brand-700 focus:outline-none sm:text-sm';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-4 sm:items-center" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-md animate-fadeIn rounded-2xl bg-white p-5 text-left shadow-xl">
        {sentTo ? (
          <>
            <h2 id={titleId} className="text-lg font-semibold text-slate-900">Sent</h2>
            <p className="mt-2 text-sm text-slate-600">Support has your message and will reply to your email address. You can carry on working.</p>
            <div className="mt-5 flex justify-end">
              <button type="button" onClick={onClose} className="min-h-[40px] rounded-xl bg-brand-700 px-4 text-sm font-semibold text-white active:scale-[0.98]">Done</button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <h2 id={titleId} className="text-lg font-semibold text-slate-900">Contact support</h2>
            <p className="mt-1 text-sm text-slate-600">Your name, role, company and the screen you are on are sent with it, and the reply comes to your email.</p>
            <label className="mt-4 mb-1.5 block text-sm font-medium text-slate-700" htmlFor="support-topic">What is it about?</label>
            <select id="support-topic" className={field} value={topic} onChange={(event) => setTopic(event.target.value as SupportTopic)}>
              {supportTopics.map((value) => <option key={value} value={value}>{supportTopicLabels[value]}</option>)}
            </select>
            <label className="mt-4 mb-1.5 block text-sm font-medium text-slate-700" htmlFor="support-message">Your message</label>
            <textarea
              id="support-message"
              rows={5}
              maxLength={maxSupportMessage}
              autoFocus
              className={field}
              placeholder="What were you trying to do, and what happened? Copy any message the app showed."
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
            {error ? <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p> : null}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="min-h-[40px] rounded-xl border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700">Cancel</button>
              <button type="submit" disabled={pending} className="min-h-[40px] rounded-xl bg-brand-700 px-4 text-sm font-semibold text-white active:scale-[0.98] disabled:opacity-60">
                {pending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
