'use client';

/** Small pieces the payroll screens share. */

export const fieldLabel = 'mb-1.5 block text-sm font-medium text-slate-700';
export const selectClass = 'min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50';
export const todayIso = () => new Date().toISOString().slice(0, 10);
/** "1,234.56" typed by a person → pesewas; NaN for nonsense, 0 for blank. */
export const minorOf = (text: string) => {
  const clean = text.replace(/,/g, '').trim();
  if (clean === '') return 0;
  return /^\d+(\.\d{1,2})?$/.test(clean) ? Math.round(Number(clean) * 100) : Number.NaN;
};
export const cedisOf = (minor: number) => (minor / 100).toFixed(2);

export function download(fileName: string, base64: string, type: string) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export type Message = { tone: 'ok' | 'error'; text: string } | null;

export function Banner({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <div className={['rounded-xl border px-4 py-3 text-sm', message.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'].join(' ')}>{message.text}</div>
  );
}

