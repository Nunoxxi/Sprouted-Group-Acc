import * as React from 'react';

type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export function Input({ className = '', ...props }: InputProps) {
  return (
    <input
      className={[
        'min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900',
        'placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100',
        className,
      ].join(' ')}
      {...props}
    />
  );
}
