/**
 * Attachments: what may be uploaded, how a photograph is reduced, where the
 * file goes in storage, when a transaction must carry one, what may be taken
 * away, and matching an inbox file to a transaction. Pure.
 */

import { describe, expect, it } from 'vitest';

import {
  acceptedTypes,
  attachmentGate,
  canRemove,
  checkFile,
  isImage,
  maxBytes,
  plannedSize,
  ruleFor,
  ruleTargets,
  safeFileName,
  storageKey,
  suggestMatches,
  type AttachmentRule,
  type Candidate,
} from '@/lib/attachments';

describe('what may be uploaded', () => {
  it('accepts PDFs and photographs', () => {
    expect(checkFile('application/pdf', 1000)).toEqual({ ok: true, extension: 'pdf' });
    expect(checkFile('image/jpeg', 1000)).toEqual({ ok: true, extension: 'jpg' });
    expect(checkFile('image/heic', 1000)).toEqual({ ok: true, extension: 'heic' });
  });

  it('refuses anything else', () => {
    expect(checkFile('application/zip', 1000)).toEqual({ ok: false, error: 'Only PDFs and photographs can be attached.' });
    expect(checkFile('text/html', 1000).ok).toBe(false);
    expect(checkFile('application/x-msdownload', 1000).ok).toBe(false);
  });

  it('refuses an empty file and one that is too big, and says how big it was', () => {
    expect(checkFile('image/jpeg', 0).ok).toBe(false);
    const big = checkFile('image/jpeg', maxBytes + 1);
    expect(big.ok).toBe(false);
    expect(big.ok === false && big.error).toContain('10 MB');
  });

  it('knows a picture from a document', () => {
    expect(isImage('image/jpeg')).toBe(true);
    expect(isImage('application/pdf')).toBe(false);
  });

  it('the accepted list is the one the file input offers', () => {
    expect(Object.keys(acceptedTypes)).toContain('application/pdf');
    expect(Object.keys(acceptedTypes).every((type) => type === 'application/pdf' || type.startsWith('image/'))).toBe(true);
  });
});

describe('reducing a photograph', () => {
  it('caps the longest edge and keeps the shape', () => {
    expect(plannedSize(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    expect(plannedSize(3024, 4032)).toEqual({ width: 1200, height: 1600 });
  });

  it('leaves a small picture alone', () => {
    expect(plannedSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('never rounds an edge away to nothing', () => {
    expect(plannedSize(10000, 3).height).toBe(1);
  });

  it('a picture with no size is nothing', () => {
    expect(plannedSize(0, 0)).toEqual({ width: 0, height: 0 });
  });
});

describe('the file and where it goes', () => {
  it('keeps a readable name and drops anything awkward', () => {
    expect(safeFileName('Weighbridge ticket #4471.HEIC', 'jpg')).toBe('Weighbridge ticket 4471.jpg');
    expect(safeFileName('../../etc/passwd', 'pdf')).toBe('passwd.pdf'); // the path is dropped, only the file name kept
    expect(safeFileName('', 'pdf')).toBe('attachment.pdf');
  });

  it('puts the entity first, so one entity cannot list another', () => {
    expect(storageKey('sprouted-crafts', '2026-09-23T10:00:00.000Z', 'abc123', 'jpg')).toBe('sprouted-crafts/2026-09/abc123.jpg');
  });
});

describe('when a transaction must carry one', () => {
  const rules: AttachmentRule[] = [
    { target: 'bill', thresholdMinor: 5_000_00, isActive: true },
    { target: 'payment', thresholdMinor: 0, isActive: true },
    { target: 'invoice', thresholdMinor: 1_000_00, isActive: false },
  ];

  it('lets a small bill through', () => {
    expect(attachmentGate(rules, { target: 'bill', amountMinor: 4_999_00, attachmentCount: 0 })).toEqual({ ok: true });
  });

  it('stops a bill at or above the threshold with nothing attached', () => {
    const gate = attachmentGate(rules, { target: 'bill', amountMinor: 5_000_00, attachmentCount: 0 });
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.error).toContain('5000.00 or more needs a document');
  });

  it('lets it through once something is attached', () => {
    expect(attachmentGate(rules, { target: 'bill', amountMinor: 50_000_00, attachmentCount: 1 })).toEqual({ ok: true });
  });

  it('a threshold of nothing means always', () => {
    const gate = attachmentGate(rules, { target: 'payment', amountMinor: 1_00, attachmentCount: 0 });
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.error).toContain('Every payment needs');
  });

  it('treats a credit the same as a charge of the same size', () => {
    expect(attachmentGate(rules, { target: 'bill', amountMinor: -6_000_00, attachmentCount: 0 }).ok).toBe(false);
  });

  it('ignores a rule that has been switched off', () => {
    expect(attachmentGate(rules, { target: 'invoice', amountMinor: 900_000_00, attachmentCount: 0 })).toEqual({ ok: true });
  });

  it('a kind with no rule is never stopped', () => {
    expect(attachmentGate(rules, { target: 'journal', amountMinor: 900_000_00, attachmentCount: 0 })).toEqual({ ok: true });
    expect(attachmentGate([], { target: 'bill', amountMinor: 900_000_00, attachmentCount: 0 })).toEqual({ ok: true });
  });

  it('finds the rule that applies, for showing a person what is expected', () => {
    expect(ruleFor(rules, 'bill')?.thresholdMinor).toBe(5_000_00);
    expect(ruleFor(rules, 'invoice')).toBeNull(); // switched off
  });

  it('a rule cannot be set against the inbox: it is a waiting room, not a transaction', () => {
    expect(ruleTargets).not.toContain('inbox');
    expect(ruleTargets).toContain('bill');
  });
});

describe('what may be taken away', () => {
  it('an attachment on a posted transaction stays', () => {
    const gate = canRemove({ targetPosted: true, uploadedByThem: true });
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.error).toContain('attachments stay');
  });

  it('before posting, the person who uploaded it may remove it', () => {
    expect(canRemove({ targetPosted: false, uploadedByThem: true })).toEqual({ ok: true });
  });

  it('but nobody else may', () => {
    expect(canRemove({ targetPosted: false, uploadedByThem: false }).ok).toBe(false);
  });
});

describe('matching an inbox file to a transaction', () => {
  const candidates: Candidate[] = [
    { id: 'b1', target: 'bill', reference: 'BILL-0042', date: '2026-09-20', amountMinor: 5_000_00 },
    { id: 'b2', target: 'bill', reference: 'BILL-0043', date: '2026-09-22', amountMinor: 2_000_00 },
    { id: 'b3', target: 'bill', reference: 'BILL-0001', date: '2026-01-05', amountMinor: 900_00 },
  ];

  it('matches on a reference in the file name', () => {
    expect(suggestMatches({ fileName: 'scan BILL-0043.pdf', uploadedAt: '2026-09-23T10:00:00.000Z' }, candidates).map((row) => row.id)).toEqual(['b2']);
  });

  it('otherwise offers what is nearest in time, closest first', () => {
    expect(suggestMatches({ fileName: 'IMG_4471.jpg', uploadedAt: '2026-09-23T10:00:00.000Z' }, candidates).map((row) => row.id)).toEqual(['b2', 'b1']);
  });

  it('leaves out anything long past', () => {
    expect(suggestMatches({ fileName: 'IMG_4471.jpg', uploadedAt: '2026-09-23T10:00:00.000Z' }, candidates).map((row) => row.id)).not.toContain('b3');
  });

  it('nothing to match against is no suggestion', () => {
    expect(suggestMatches({ fileName: 'IMG_4471.jpg', uploadedAt: '2026-09-23T10:00:00.000Z' }, [])).toEqual([]);
  });
});
