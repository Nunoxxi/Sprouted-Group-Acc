import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { backupFileExists, verifyBackupFile } from '@/lib/backup';

const scratch: string[] = [];

function tempFile(contents: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sprouted-backup-')), 'snapshot.db');
  fs.writeFileSync(file, contents);
  scratch.push(path.dirname(file));
  return file;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

afterEach(() => {
  while (scratch.length) {
    fs.rmSync(scratch.pop() as string, { recursive: true, force: true });
  }
});

describe('a backup is only trusted once it has been re-read', () => {
  it('accepts a file that still matches its recorded checksum', () => {
    const file = tempFile('pretend sqlite snapshot');
    const result = verifyBackupFile(file, sha256(file));

    expect(result.ok).toBe(true);
  });

  it('rejects a file whose bytes changed after it was recorded', () => {
    const file = tempFile('pretend sqlite snapshot');
    const recorded = sha256(file);

    fs.writeFileSync(file, 'corrupted on disk');
    const result = verifyBackupFile(file, recorded);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('checksum-mismatch');
  });

  it('rejects a backup whose file has been pruned or lost', () => {
    const file = tempFile('pretend sqlite snapshot');
    const recorded = sha256(file);
    fs.rmSync(file);

    const result = verifyBackupFile(file, recorded);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('missing-file');
    expect(backupFileExists(file)).toBe(false);
  });

  it('rejects an empty file that happens to be recorded with the wrong checksum', () => {
    const file = tempFile('');
    const result = verifyBackupFile(file, sha256(tempFile('not empty')));

    expect(result.ok).toBe(false);
  });
});
