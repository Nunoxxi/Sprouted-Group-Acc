type MoneyProps = {
  value: number;
  currency?: 'GHS';
  className?: string;
};

export function Money({ value, currency = 'GHS', className = '' }: MoneyProps) {
  const numeric = new Intl.NumberFormat('en-GH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value / 100));

  const sign = value < 0 ? '(' : '';
  const signClose = value < 0 ? ')' : '';
  const prefix = currency === 'GHS' ? 'GHS ' : '';

  return (
    <span className={['font-mono tabular-nums text-right', className].join(' ')}>
      {sign}
      {prefix}
      {numeric}
      {signClose}
    </span>
  );
}
