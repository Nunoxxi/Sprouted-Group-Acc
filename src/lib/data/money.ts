/**
 * The bigint boundary.
 *
 * Money columns are BigInt in Postgres so a single line can exceed GHS 21.4M.
 * Prisma returns them as JS bigint, which cannot be JSON-serialised, cannot be
 * mixed with numbers in arithmetic, and would surface as confusing runtime
 * errors far from where it leaked. So every read converts here, and nothing
 * outside src/lib/data ever sees a bigint.
 *
 * A JS number is exact up to 2^53 pesewas — about GHS 90 trillion — so the
 * conversion cannot lose precision for any real ledger amount. If it ever
 * would, this throws rather than rounding a balance.
 */

export function toMinor(value: bigint): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new RangeError(`Amount ${value} pesewas exceeds the safe integer range`);
  }
  return asNumber;
}

export function fromMinor(value: number): bigint {
  if (!Number.isInteger(value)) {
    throw new RangeError(`Amount ${value} is not a whole number of pesewas`);
  }
  return BigInt(value);
}

/**
 * Guard for anything about to be JSON-serialised (exports, API responses,
 * audit metadata). Throws if a bigint slipped through the mappers, so the
 * mistake shows up at the boundary rather than as a cryptic serialiser error.
 */
export function assertNoBigInt(value: unknown, path = 'value'): void {
  if (typeof value === 'bigint') {
    throw new TypeError(`${path} is a bigint; convert it with toMinor() before serialising`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoBigInt(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      assertNoBigInt(nested, `${path}.${key}`);
    }
  }
}
