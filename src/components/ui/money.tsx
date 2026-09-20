'use client';

import { createContext, useContext, type ReactNode } from 'react';

import { convertMinor, currencySymbols, type Currency } from '@/lib/fx';

/**
 * The currency an amount is in when nothing says otherwise: the selected
 * entity's functional currency. Set once by the shell; any amount that is
 * in another currency passes `currency` explicitly.
 */
const CurrencyContext = createContext<Currency>('GHS');

export function CurrencyProvider({ currency, children }: { currency: Currency; children: ReactNode }) {
  return <CurrencyContext.Provider value={currency}>{children}</CurrencyContext.Provider>;
}

export function useFunctionalCurrency(): Currency {
  return useContext(CurrencyContext);
}

type MoneyProps = {
  /** Minor units (pesewas, cents). */
  value: number;
  currency?: Currency;
  className?: string;
};

/** An amount with its currency symbol. There is no way to render a bare number. */
export function Money({ value, currency, className = '' }: MoneyProps) {
  const contextCurrency = useContext(CurrencyContext);
  const shown = currency ?? contextCurrency;
  const numeric = new Intl.NumberFormat('en-GH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value / 100));

  return (
    <span className={['font-mono tabular-nums text-right', className].join(' ')} title={shown}>
      {value < 0 ? '(' : ''}
      <span className="mr-1 text-[0.85em] text-slate-500">{currencySymbols[shown]}</span>
      {numeric}
      {value < 0 ? ')' : ''}
    </span>
  );
}

/**
 * Report translation: a chosen presentation currency at a chosen closing
 * rate. Every ReportMoney inside the provider is converted for display. This
 * is a translation of the functional figures, never the books — the shell
 * labels it as such wherever it is switched on.
 */
const TranslationContext = createContext<{ currency: Currency; rate: string } | null>(null);

export function TranslationProvider({ currency, rate, children }: { currency: Currency; rate: string; children: ReactNode }) {
  return <TranslationContext.Provider value={{ currency, rate }}>{children}</TranslationContext.Provider>;
}

export function ReportMoney({ value, currency, className }: MoneyProps) {
  const translation = useContext(TranslationContext);
  if (!translation || currency) {
    return <Money value={value} currency={currency} className={className} />;
  }
  return <Money value={convertMinor(value, translation.rate)} currency={translation.currency} className={className} />;
}
