/**
 * Object storage for attachments, on Supabase Storage over its REST API.
 *
 * Files never go in the database. The database holds the key, the name, the
 * type, the size and a checksum; the bytes live here, in a private bucket
 * nothing can read without a signed link.
 *
 * Plain fetch rather than a client library: three calls is not worth a
 * dependency, and the failure modes are easier to read this way.
 */

const BUCKET = 'attachments';

function credentials(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new StorageUnavailable('File storage is not configured: SUPABASE_URL and SUPABASE_SERVICE_KEY have to be set.');
  }
  return { url, key };
}

/** Storage is down or not set up. Distinct from a refusal a person caused. */
export class StorageUnavailable extends Error {}

export function storageConfigured(): boolean {
  return !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_KEY;
}

const headers = (key: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${key}`, apikey: key, ...extra });

/**
 * Make sure the bucket exists. Private: every read goes through a signed link
 * this app issues, so a key that leaks is not a file anybody can fetch.
 */
export async function ensureBucket(): Promise<void> {
  const { url, key } = credentials();
  const existing = await fetch(`${url}/storage/v1/bucket/${BUCKET}`, { headers: headers(key) });
  if (existing.ok) return;
  const created = await fetch(`${url}/storage/v1/bucket`, {
    method: 'POST',
    headers: headers(key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  });
  if (!created.ok) {
    const text = await created.text();
    // Another request may have created it between the two calls.
    if (created.status === 409 || text.includes('already exists')) return;
    throw new StorageUnavailable(`Could not prepare file storage: ${created.status} ${text.slice(0, 200)}`);
  }
}

/** Put the bytes in storage. The key is never reused, so nothing is overwritten. */
export async function putObject(storageKey: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const { url, key } = credentials();
  await ensureBucket();
  const response = await fetch(`${url}/storage/v1/object/${BUCKET}/${storageKey}`, {
    method: 'POST',
    headers: headers(key, { 'Content-Type': contentType, 'cache-control': 'max-age=31536000', 'x-upsert': 'false' }),
    body: bytes as BodyInit,
  });
  if (!response.ok) {
    throw new StorageUnavailable(`Could not store the file: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
}

/**
 * A link to the file that works for a while and then stops. Long enough to
 * open or download it, short enough that a link pasted somewhere it should
 * not be goes dead on its own.
 */
export async function signedUrl(storageKey: string, expiresInSeconds = 600): Promise<string> {
  const { url, key } = credentials();
  const response = await fetch(`${url}/storage/v1/object/sign/${BUCKET}/${storageKey}`, {
    method: 'POST',
    headers: headers(key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });
  if (!response.ok) {
    throw new StorageUnavailable(`Could not make a link to the file: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  const body = (await response.json()) as { signedURL?: string; signedUrl?: string };
  const path = body.signedURL ?? body.signedUrl;
  if (!path) throw new StorageUnavailable('Storage did not return a link.');
  return `${url}/storage/v1${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Remove an object. Only ever called for a file that was never attached to
 * anything posted — a posted transaction's attachments stay.
 */
export async function removeObject(storageKey: string): Promise<void> {
  const { url, key } = credentials();
  const response = await fetch(`${url}/storage/v1/object/${BUCKET}/${storageKey}`, { method: 'DELETE', headers: headers(key) });
  if (!response.ok && response.status !== 404) {
    throw new StorageUnavailable(`Could not remove the file: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
}

/** The bytes back again, for verifying a checksum. */
export async function getObject(storageKey: string): Promise<Uint8Array> {
  const { url, key } = credentials();
  const response = await fetch(`${url}/storage/v1/object/${BUCKET}/${storageKey}`, { headers: headers(key) });
  if (!response.ok) throw new StorageUnavailable(`Could not read the file: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
