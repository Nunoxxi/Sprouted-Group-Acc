/**
 * Stock balance primitives shared by the inventory server functions and
 * bill posting (receipts). Always inside the caller's transaction.
 */

import type { Prisma } from '@prisma/client';

import { formatKg, type StockPosition } from '../inventory';
import { fromMinor, toMinor } from './money';

type Tx = Prisma.TransactionClient;

/** A refusal raised inside a transaction; the server function returns it as a value. */
export class StockRefusal extends Error {}

/** The item's position across every location: what its average cost is made of. */
export async function positionOf(tx: Tx, itemId: string): Promise<StockPosition> {
  const sums = await tx.stockBalance.aggregate({ where: { itemId }, _sum: { quantityGrams: true, valueMinor: true } });
  return { quantityGrams: toMinor(sums._sum.quantityGrams ?? 0n), valueMinor: toMinor(sums._sum.valueMinor ?? 0n) };
}

export async function balanceAt(tx: Tx, itemId: string, locationId: string): Promise<StockPosition> {
  const row = await tx.stockBalance.findUnique({ where: { itemId_locationId: { itemId, locationId } } });
  return row ? { quantityGrams: toMinor(row.quantityGrams), valueMinor: toMinor(row.valueMinor) } : { quantityGrams: 0, valueMinor: 0 };
}

/** Apply a signed change to a balance. Refuses to take a location's quantity negative. */
export async function moveBalance(tx: Tx, entityId: string, itemId: string, locationId: string, quantityGrams: number, valueMinor: number): Promise<void> {
  const current = await balanceAt(tx, itemId, locationId);
  if (current.quantityGrams + quantityGrams < 0) {
    throw new StockRefusal(`Only ${formatKg(current.quantityGrams)} on hand at that location; cannot remove ${formatKg(-quantityGrams)}.`);
  }
  await tx.stockBalance.upsert({
    where: { itemId_locationId: { itemId, locationId } },
    create: { entityId, itemId, locationId, quantityGrams: fromMinor(quantityGrams), valueMinor: fromMinor(valueMinor) },
    update: { quantityGrams: { increment: fromMinor(quantityGrams) }, valueMinor: { increment: fromMinor(valueMinor) } },
  });
}
