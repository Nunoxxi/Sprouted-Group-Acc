import * as React from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'success' | 'danger';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
};

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-700 text-white hover:bg-brand-800 focus-visible:ring-brand-600',
  secondary:
    'bg-white text-brand-800 border border-brand-200 hover:bg-brand-50 focus-visible:ring-brand-500',
  ghost:
    'bg-transparent text-slate-700 hover:bg-slate-100 focus-visible:ring-slate-500',
  success:
    'bg-success text-white hover:bg-emerald-700 focus-visible:ring-success',
  danger:
    'bg-danger text-white hover:bg-rose-700 focus-visible:ring-danger',
};

const sizeClasses: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'min-h-[36px] px-3 py-2 text-sm',
  md: 'min-h-[44px] px-4 py-2.5 text-sm',
  lg: 'min-h-[48px] px-5 py-3 text-base',
};

export function Button({ variant = 'primary', size = 'md', className = '', ...props }: ButtonProps) {
  return (
    <button
      className={[
        'inline-flex items-center justify-center rounded-lg font-medium transition-colors duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        'min-w-[44px]',
        sizeClasses[size],
        variantClasses[variant],
        className,
      ].join(' ')}
      {...props}
    />
  );
}
