import { describe, expect, it } from 'vitest';

import { checkCapture, parseCedis } from '../src/lib/capture';

describe('parseCedis', () => {
  it('reads cedis to pesewas', () => {
    expect(parseCedis('12')).toBe(1200);
    expect(parseCedis('12.5')).toBe(1250);
    expect(parseCedis('12.05')).toBe(1205);
    expect(parseCedis('1,234.56')).toBe(123456);
    expect(parseCedis('GHS 40')).toBe(4000);
    expect(parseCedis('₵ 0.99')).toBe(99);
  });

  it('treats blank as no amount', () => {
    expect(parseCedis('')).toBeNull();
    expect(parseCedis('   ')).toBeNull();
  });

  it('refuses what is not a plain amount, rather than guessing', () => {
    expect(parseCedis('12.345')).toBeUndefined();
    expect(parseCedis('-5')).toBeUndefined();
    expect(parseCedis('ten')).toBeUndefined();
    expect(parseCedis('1e3')).toBeUndefined();
  });

  it('does not lose a pesewa to floating point', () => {
    expect(parseCedis('0.29')).toBe(29);
    expect(parseCedis('1.15')).toBe(115);
  });
});

describe('checkCapture', () => {
  const today = '2026-11-01';
  const base = { clientRef: 'cap-2026-abcdef12', kind: 'bill', amountMinor: 5000, date: '2026-10-30', note: ' Fuel ' };

  it('keeps a good capture and tidies the note', () => {
    expect(checkCapture(base, today)).toEqual({ ok: true, value: { clientRef: 'cap-2026-abcdef12', kind: 'bill', amountMinor: 5000, date: '2026-10-30', note: 'Fuel' } });
  });

  it('lets a bill, invoice or receipt go without an amount or date', () => {
    for (const kind of ['bill', 'invoice', 'receipt']) {
      expect(checkCapture({ ...base, kind, amountMinor: null, date: null }, today).ok).toBe(true);
    }
  });

  it('needs an amount on an expense claim', () => {
    expect(checkCapture({ ...base, kind: 'expense-claim', amountMinor: null }, today)).toEqual({ ok: false, error: 'An expense claim needs the amount you paid.' });
    expect(checkCapture({ ...base, kind: 'expense-claim' }, today).ok).toBe(true);
  });

  it('refuses an unknown kind, a bad reference and an impossible amount', () => {
    expect(checkCapture({ ...base, kind: 'payslip' }, today).ok).toBe(false);
    expect(checkCapture({ ...base, clientRef: 'x' }, today).ok).toBe(false);
    expect(checkCapture({ ...base, clientRef: 'has spaces in it' }, today).ok).toBe(false);
    expect(checkCapture({ ...base, amountMinor: 0 }, today).ok).toBe(false);
    expect(checkCapture({ ...base, amountMinor: -100 }, today).ok).toBe(false);
    expect(checkCapture({ ...base, amountMinor: 12.5 }, today).ok).toBe(false);
    expect(checkCapture({ ...base, amountMinor: 10_000_000_001 }, today).ok).toBe(false);
  });

  it('refuses a date that is not a real day, or is in the future', () => {
    expect(checkCapture({ ...base, date: '2026-02-30' }, today).ok).toBe(false);
    expect(checkCapture({ ...base, date: '30/10/2026' }, today).ok).toBe(false);
    expect(checkCapture({ ...base, date: '2026-11-03' }, today)).toEqual({ ok: false, error: 'That date is in the future.' });
  });

  it('allows tomorrow, for a phone a time zone ahead', () => {
    expect(checkCapture({ ...base, date: '2026-11-02' }, today).ok).toBe(true);
  });
});
