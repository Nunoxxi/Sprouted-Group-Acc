import { describe, expect, it } from 'vitest';

import { checkSupportRequest, supportEmail, supportLimit, withinSupportLimit } from '../src/lib/support';

describe('checkSupportRequest', () => {
  it('keeps a request and trims the message', () => {
    expect(checkSupportRequest({ topic: 'problem', message: '  The payroll will not approve.  ' })).toEqual({ ok: true, value: { topic: 'problem', message: 'The payroll will not approve.' } });
  });

  it('refuses an unknown topic, a message too short to act on, and one too long', () => {
    expect(checkSupportRequest({ topic: 'complaint', message: 'The payroll will not approve.' }).ok).toBe(false);
    expect(checkSupportRequest({ topic: 'problem', message: 'help' }).ok).toBe(false);
    expect(checkSupportRequest({ topic: 'problem', message: 'x'.repeat(4001) }).ok).toBe(false);
  });
});

describe('supportEmail', () => {
  const context = { name: 'Ama Owusu', email: 'ama@example.com', roleLabel: 'Bookkeeper', entityName: 'Oikazi', screen: 'Payroll', sentAt: '2026-11-01 10:15' };

  it('says who asked, from where, so support can answer the first time', () => {
    const email = supportEmail({ topic: 'how-to', message: 'How do I email payslips?' }, context);
    expect(email.subject).toBe('[Sprouted support] How do I…? — Ama Owusu');
    expect(email.text).toContain('How do I email payslips?');
    expect(email.text).toContain('From: Ama Owusu <ama@example.com>');
    expect(email.text).toContain('Role: Bookkeeper');
    expect(email.text).toContain('Where: Oikazi · Payroll');
  });

  it('copes with no company selected', () => {
    expect(supportEmail({ topic: 'access', message: 'I cannot see Sprouted Roots.' }, { ...context, entityName: null }).text).toContain('Where: Payroll');
  });
});

describe('withinSupportLimit', () => {
  const now = 1_000_000_000;

  it('allows up to the limit in the window, then refuses', () => {
    const recent = Array.from({ length: supportLimit.count - 1 }, (_, i) => now - i * 1000);
    expect(withinSupportLimit(recent, now)).toBe(true);
    expect(withinSupportLimit([...recent, now], now)).toBe(false);
  });

  it('forgets requests older than the window', () => {
    const old = Array.from({ length: supportLimit.count }, () => now - supportLimit.windowMs - 1);
    expect(withinSupportLimit(old, now)).toBe(true);
  });
});
