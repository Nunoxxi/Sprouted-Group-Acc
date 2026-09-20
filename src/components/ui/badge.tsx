type BadgeProps = {
  children: React.ReactNode;
  tone?: 'neutral' | 'success' | 'danger';
};

export function Badge({ children, tone = 'neutral' }: BadgeProps) {
  const toneClasses = {
    neutral: 'bg-slate-100 text-slate-700',
    success: 'bg-green-100 text-green-700',
    danger: 'bg-red-100 text-red-700',
  };

  return (
    <span
      className={[
        'inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]',
        toneClasses[tone],
      ].join(' ')}
    >
      {children}
    </span>
  );
}
