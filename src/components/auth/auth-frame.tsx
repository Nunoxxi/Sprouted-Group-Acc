import type { ReactNode } from 'react';

/** The centred card every sign-in-flow page sits in. */
export function AuthFrame({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-sand-50 px-4 py-10 text-slate-900">
      <div className="w-full max-w-md">
        <p className="mb-6 text-center text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Sprouted Group</p>
        <section className="rounded-2xl border border-slate-200 bg-white p-8 shadow-soft">
          <h1 className="text-xl font-semibold">{title}</h1>
          {intro ? <div className="mt-2 text-sm text-slate-600">{intro}</div> : null}
          <div className="mt-6">{children}</div>
        </section>
      </div>
    </main>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
      {message}
    </p>
  );
}

export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
      {children}
    </label>
  );
}
