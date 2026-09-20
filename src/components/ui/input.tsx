import * as React from 'react';

type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export function Input({ className = '', ...props }: InputProps) {
  // Once a caller passes `value` the field stays controlled, even if that value
  // momentarily arrives undefined. Inputs without `value` are left untouched so
  // uncontrolled usage (defaultValue) still works.
  const inputProps = 'value' in props ? { ...props, value: props.value ?? '' } : props;

  return (
    <input
      className={[
        'min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900',
        'placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100',
        className,
      ].join(' ')}
      {...inputProps}
    />
  );
}
