import * as React from 'react';

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  as?: 'div' | 'section' | 'article' | 'aside';
};

export function Card({ as: Component = 'div', className = '', ...props }: CardProps) {
  return (
    <Component
      className={[
        'rounded-xl border border-slate-200 bg-white p-5',
        'transition-colors duration-150 ease-out',
        className,
      ].join(' ')}
      {...props}
    />
  );
}
