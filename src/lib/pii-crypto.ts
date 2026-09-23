/**
 * Encryption for the personal details the app holds: telephone numbers,
 * mobile money numbers, addresses, email addresses and the signatures farmers
 * give on an agent's phone.
 *
 * AES-256-GCM with a fresh random nonce each time and the field's own name as
 * associated data, so a value lifted out of one column cannot be pasted into
 * another and still decrypt. The key comes from the environment and is never
 * written anywhere the database can reach.
 *
 * Two things this deliberately does not do:
 *
 *  - It is not deterministic, so an encrypted column cannot be searched or
 *    made unique. That is the price of the database alone not giving the
 *    numbers up, and it is the right trade for contact details.
 *  - It does not encrypt names. Names are needed to sort, to search and to
 *    show on every screen, and encrypting them would only move the problem to
 *    the application while breaking the app. Names are protected by who is
 *    allowed to see them and by erasure instead, and the register says so.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/** Stored values start with this, so plaintext written before encryption is recognisable. */
const PREFIX = 'enc.v1.';

export class EncryptionUnavailable extends Error {}

function keyBytes(): Buffer {
  const raw = process.env.PII_ENCRYPTION_KEY;
  if (!raw) throw new EncryptionUnavailable('Personal data encryption is not configured: PII_ENCRYPTION_KEY has to be set.');
  // A base64 32-byte key is what the setup notes ask for; anything else is
  // hashed to 32 bytes rather than refused, so a long passphrase also works.
  const decoded = Buffer.from(raw, 'base64');
  return decoded.length === 32 ? decoded : createHash('sha256').update(raw, 'utf8').digest();
}

export function encryptionConfigured(): boolean {
  return !!process.env.PII_ENCRYPTION_KEY;
}

/**
 * Encrypt one field's value. `field` is bound into the ciphertext, so
 * `Farmer.phone` cannot be moved into `Farmer.walletNumber` undetected.
 */
export function encryptField(field: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text === '') return null;
  if (text.startsWith(PREFIX)) return text; // already encrypted
  const key = keyBytes();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(field, 'utf8'));
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${PREFIX}${nonce.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}

/**
 * Decrypt one field's value. A value that was written before encryption was
 * switched on comes back as it is, so turning this on does not blank out the
 * data already in the database; `encryptExisting` moves it over afterwards.
 *
 * With no key configured this returns nothing rather than raising. Reading is
 * not the dangerous direction: a telephone number that cannot be shown is a
 * gap on a screen, while an unset environment variable that raises takes down
 * every page that loads a contact — which is exactly what happened once.
 * Writing still refuses (see `encryptField`), because storing a number in
 * plain text while believing it encrypted is the failure that matters.
 *
 * So that the gap is never mistaken for "no number held", the app asks
 * `encryptionConfigured()` and says plainly on screen that the key is missing.
 */
export function decryptField(field: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  if (!text.startsWith(PREFIX)) return text; // stored before encryption was on
  if (!encryptionConfigured()) return null;
  const [nonce, tag, body] = text.slice(PREFIX.length).split('.');
  if (!nonce || !tag || !body) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(nonce, 'base64url'));
    decipher.setAAD(Buffer.from(field, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // A value that will not decrypt is a value that has been tampered with,
    // or the key has changed. Either way it is not shown as if it were fine.
    return null;
  }
}

/** Whether a stored value is encrypted. For the migration and for a test. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}
