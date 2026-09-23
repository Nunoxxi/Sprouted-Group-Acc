/**
 * Data protection: the register of what personal data is held, who may see
 * it, how numbers are masked, what erasure does and does not touch, and that
 * encryption is real — a value encrypted for one field will not decrypt as
 * another, and a tampered value does not come back as if it were fine.
 */

import { describe, expect, it } from 'vitest';

import { roleHas, roles, type Role } from '@/lib/authz';
import { decryptField, encryptField, isEncrypted } from '@/lib/pii-crypto';
import { redactedFields } from '@/lib/data/redact';
import {
  accessSummary,
  canSeePersonalDetail,
  dataMap,
  dataMapBySubject,
  encryptedFields,
  erasurePlan,
  isMasked,
  maskEmail,
  maskNumber,
  maskText,
  pseudonymFor,
  subjectKinds,
  subjectRights,
} from '@/lib/privacy';

// A key only this file uses, so the tests do not depend on the deployment's.
process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

describe('the register of personal data', () => {
  it('every field says whose it is, why it is held and what erasure does', () => {
    for (const field of dataMap) {
      expect(field.model, field.field).toBeTruthy();
      expect(field.describes.length, `${field.model}.${field.field}`).toBeGreaterThan(5);
      expect(['farmer', 'agent', 'staff', 'donor-or-supplier', 'app-user']).toContain(field.subject);
      expect(['replaced-with-a-pseudonym', 'removed', 'kept']).toContain(field.onErasure);
    }
  });

  it('covers the people the app actually holds data on', () => {
    const subjects = new Set(dataMap.map((field) => field.subject));
    expect(subjects).toEqual(new Set(['farmer', 'agent', 'staff', 'donor-or-supplier', 'app-user']));
  });

  it('names every field that is kept encrypted', () => {
    const encrypted = encryptedFields().map((field) => `${field.model}.${field.field}`);
    expect(encrypted).toEqual([
      'Farmer.phone',
      'Farmer.walletNumber',
      'AgentPurchase.evidenceData',
      'FarmerPayment.walletNumber',
      'BuyingAgent.phone',
      'Contact.phone',
      'Contact.email',
      'Contact.address',
    ]);
  });

  it('every contact detail and every biometric is encrypted, and is masked on screen', () => {
    for (const field of dataMap) {
      if (field.sensitivity === 'contact-detail' || field.sensitivity === 'biometric') {
        // A user's sign-in email is the one exception: it is how they are
        // identified to the authentication system, which needs to match it.
        if (field.model === 'User') continue;
        expect(field.encrypted, `${field.model}.${field.field} should be encrypted`).toBe(true);
        expect(field.masked, `${field.model}.${field.field} should be masked`).toBe(true);
      }
    }
  });

  it('every field the register calls masked is actually held back on the way out', () => {
    // src/lib/data/redact.ts is the only place masking happens on the server.
    // If the register declares a field masked and that pass does not cover
    // it, the register is describing an app that does not exist.
    const masked = dataMap.filter((field) => field.masked).map((field) => `${field.model}.${field.field}`);
    expect(masked.sort()).toEqual([...redactedFields].sort());
  });

  it('groups itself by whose data it is, for the register', () => {
    const groups = dataMapBySubject();
    expect(groups.map((group) => group.subject)).toEqual(['farmer', 'agent', 'staff', 'donor-or-supplier', 'app-user']);
    expect(groups.every((group) => group.fields.length > 0)).toBe(true);
    expect(groups.reduce((total, group) => total + group.fields.length, 0)).toBe(dataMap.length);
  });
});

describe('who may see personal details', () => {
  it('a Viewer may not', () => {
    expect(canSeePersonalDetail('viewer')).toBe(false);
  });

  it('the roles that do the work may', () => {
    for (const role of ['owner', 'accountant', 'bookkeeper', 'data-entry'] as Role[]) expect(canSeePersonalDetail(role)).toBe(true);
  });

  it('is the same thing as holding pii:view, not a second list that can drift', () => {
    for (const role of roles) {
      expect(canSeePersonalDetail(role)).toBe(roleHas(role, 'pii:view'));
    }
  });

  it('the permission matrix agrees: a Viewer can read reports but not personal detail', () => {
    expect(roleHas('viewer', 'reports:view')).toBe(true);
    expect(roleHas('viewer', 'pii:view')).toBe(false);
    expect(roleHas('accountant', 'pii:view')).toBe(true);
    expect(roleHas('bookkeeper', 'pii:view')).toBe(true);
    expect(roleHas('data-entry', 'pii:view')).toBe(true);
    expect(roleHas('owner', 'pii:view')).toBe(true);
  });
});

describe('masking', () => {
  it('shows the last four digits of a number and nothing else', () => {
    expect(maskNumber('0244111222')).toBe('••••••1222');
    expect(maskNumber('0244111222', 3)).toBe('•••••••222');
  });

  it('a very short number gives nothing away at all', () => {
    expect(maskNumber('12')).toBe('••');
  });

  it('nothing to mask is nothing', () => {
    expect(maskNumber(null)).toBe('');
    expect(maskNumber(undefined)).toBe('');
    expect(maskEmail(null)).toBe('');
    expect(maskText('')).toBe('');
  });

  it('an email keeps its first letter and its domain, so it can be recognised', () => {
    expect(maskEmail('akosua.mensah@example.com')).toBe('a••••••••••••@example.com');
  });

  it('anything else keeps only its first character', () => {
    expect(maskText('Wenchi')).toBe('W•••••');
  });

  it('a masked value is recognisable as masked, so it is never stored', () => {
    expect(isMasked(maskNumber('0244111222'))).toBe(true);
    expect(isMasked('0244111222')).toBe(false);
  });
});

describe('encryption', () => {
  it('a value round-trips', () => {
    const sealed = encryptField('Farmer.phone', '0244111222');
    expect(sealed).not.toBe('0244111222');
    expect(isEncrypted(sealed)).toBe(true);
    expect(decryptField('Farmer.phone', sealed)).toBe('0244111222');
  });

  it('the same number encrypts differently every time, so the column cannot be matched on', () => {
    const a = encryptField('Farmer.phone', '0244111222');
    const b = encryptField('Farmer.phone', '0244111222');
    expect(a).not.toBe(b);
    expect(decryptField('Farmer.phone', a)).toBe(decryptField('Farmer.phone', b));
  });

  it('a value moved into another column will not decrypt', () => {
    const sealed = encryptField('Farmer.phone', '0244111222');
    expect(decryptField('Farmer.walletNumber', sealed)).toBeNull();
  });

  it('a tampered value does not come back as if it were fine', () => {
    const sealed = encryptField('Farmer.phone', '0244111222') as string;
    const tampered = `${sealed.slice(0, -4)}AAAA`;
    expect(decryptField('Farmer.phone', tampered)).toBeNull();
  });

  it('a value written before encryption was switched on is still readable', () => {
    expect(decryptField('Farmer.phone', '0244111222')).toBe('0244111222');
    expect(isEncrypted('0244111222')).toBe(false);
  });

  it('encrypting twice does not double-wrap it', () => {
    const once = encryptField('Farmer.phone', '0244111222') as string;
    expect(encryptField('Farmer.phone', once)).toBe(once);
  });

  it('nothing is nothing', () => {
    expect(encryptField('Farmer.phone', null)).toBeNull();
    expect(encryptField('Farmer.phone', '')).toBeNull();
    expect(decryptField('Farmer.phone', null)).toBeNull();
  });
});

describe('erasure', () => {
  it('a pseudonym comes from a random token, never from the name', () => {
    const name = pseudonymFor('farmer', 'a1b2c3d4e5');
    expect(name).toBe('Farmer A1B2C3');
    expect(name).not.toContain('Akosua');
  });

  it("replaces a farmer's name everywhere it appears", () => {
    const plan = erasurePlan('farmer', 'Farmer A1B2C3');
    expect(plan.replaced.map((row) => `${row.model}.${row.field}`)).toEqual(['Farmer.name', 'AgentPurchase.farmerName', 'FarmerAdvance.farmerName', 'Lot.farmerName']);
    expect(plan.replaced.every((row) => row.with === 'Farmer A1B2C3')).toBe(true);
  });

  it('removes the telephone number, the mobile money number and the signature', () => {
    const plan = erasurePlan('farmer', 'Farmer A1B2C3');
    expect(plan.removed.map((row) => `${row.model}.${row.field}`)).toEqual(['Farmer.phone', 'Farmer.walletNumber', 'AgentPurchase.evidenceData', 'FarmerPayment.walletNumber']);
  });

  it('keeps the financial record, and says why', () => {
    const plan = erasurePlan('farmer', 'Farmer A1B2C3');
    const kept = plan.kept.map((row) => `${row.model}.${row.field}`);
    expect(kept).toContain('AgentPurchase.paymentRef');
    expect(plan.kept.find((row) => row.field === 'paymentRef')?.because).toContain('accounting record');
  });

  it('never touches an amount or a journal', () => {
    for (const kind of subjectKinds) {
      const plan = erasurePlan(kind, 'X');
      const touched = [...plan.replaced, ...plan.removed].map((row) => `${row.model}.${row.field}`);
      expect(touched.some((field) => /Minor|journal|Journal/.test(field))).toBe(false);
    }
  });

  it("a supplier's tax number stays, because it is part of the tax record", () => {
    const plan = erasurePlan('contact', 'Supplier X');
    expect(plan.removed.map((row) => row.field)).toEqual(['phone', 'email', 'address']);
    expect(plan.kept.map((row) => row.field)).toContain('tin');
  });

  it("a member of staff loses their payroll reference too, since it names them just as surely", () => {
    const plan = erasurePlan('employee', 'Member of staff X');
    const replaced = plan.replaced.map((row) => `${row.model}.${row.field}`);
    expect(replaced).toContain('PayrollLine.employeeRef');
    expect(replaced).toContain('PayrollLine.employeeName');
    expect(replaced).toContain('FixedAsset.custodian');
  });

  it('every kind of person can be erased', () => {
    for (const kind of subjectKinds) {
      const plan = erasurePlan(kind, 'X');
      expect(plan.replaced.length + plan.removed.length, kind).toBeGreaterThan(0);
    }
  });
});

describe('the record of who looked', () => {
  it('says what was done and to whom', () => {
    expect(accessSummary('revealed-a-contact-detail', 'Akosua Mensah', 'mobile money number')).toBe('Showed a hidden telephone or mobile money number: Akosua Mensah — mobile money number');
    expect(accessSummary('subject-access-report', 'Kwesi Boateng')).toBe('Produced a report of everything held about a person: Kwesi Boateng');
  });
});

describe("what a person is told about their rights", () => {
  it('explains that the money stays even when the name goes', () => {
    expect(subjectRights.join(' ')).toContain('Ghanaian law requires us to keep accounting records');
    expect(subjectRights.join(' ')).toContain('Data Protection Commission');
  });
});
