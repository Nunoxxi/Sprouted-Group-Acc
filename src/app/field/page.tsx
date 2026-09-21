import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import { can, mustSetUpTwoFactor, visibleEntityIds } from '@/lib/authz';
import { getPrincipal } from '@/lib/dal';
import { entityTypeOf } from '@/lib/data/mappers';
import { agentRecord } from '@/lib/data/trading';
import { itemRecord, locationRecord } from '@/lib/data/inventory';
import { prisma } from '@/lib/prisma';
import { holdsStock } from '@/lib/trading';

import { FieldForm, type FieldReferenceData } from './field-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Field purchases — Sprouted',
  manifest: '/manifest.webmanifest',
  themeColor: '#2F6F5A',
  viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
};

/**
 * The buying agent's form. Reference data (agents, grades, locations, open
 * floats) is loaded here for the entities the person may see; the form
 * keeps a copy on the phone so it works with no signal, and queues
 * purchases until it can sync them.
 */
export default async function FieldPage() {
  const principal = await getPrincipal();
  if (!principal) redirect('/sign-in?next=%2Ffield');
  if (mustSetUpTwoFactor(principal)) redirect('/two-factor/setup');
  if (!can(principal, 'stock:enter')) {
    return <p className="p-6 text-sm text-slate-700">Your role ({principal.role}) cannot record field purchases.</p>;
  }

  const entities = await prisma.entity.findMany({ orderBy: { code: 'asc' } });
  const allowedIds = visibleEntityIds(principal, entities.map((e) => e.id));
  const traders = entities.filter((e) => allowedIds.includes(e.id) && holdsStock(entityTypeOf(e.type)));
  const ids = traders.map((e) => e.id);
  if (ids.length === 0) {
    return <p className="p-6 text-sm text-slate-700">None of the entities you can see buys commodities. Field purchases are recorded for Sprouted Crafts and Oikazi.</p>;
  }

  const [agents, items, locations, floats, commodities] = await Promise.all([
    prisma.buyingAgent.findMany({ where: { entityId: { in: ids }, isActive: true }, orderBy: { name: 'asc' } }),
    prisma.item.findMany({ where: { entityId: { in: ids }, isActive: true, commodityId: { not: null } }, include: { account: { select: { code: true, name: true } } }, orderBy: { name: 'asc' } }),
    prisma.stockLocation.findMany({ where: { entityId: { in: ids }, isActive: true }, include: { account: { select: { code: true } } }, orderBy: { name: 'asc' } }),
    prisma.floatAdvance.findMany({ where: { entityId: { in: ids }, status: 'OPEN' }, select: { id: true, entityId: true, agentId: true, date: true, amountMinor: true }, orderBy: { date: 'desc' } }),
    prisma.commodity.findMany({ where: { entityId: { in: ids }, isActive: true } }),
  ]);

  const refs: FieldReferenceData = {
    loadedAt: new Date().toISOString(),
    user: { name: principal.name },
    entities: traders.map((e) => ({ id: e.id, name: e.name, lbcMode: e.lbcMode, producerPriceMinorPerKg: e.producerPriceMinorPerKg === null ? null : Number(e.producerPriceMinorPerKg) })),
    agents: agents.map(agentRecord),
    items: items.map(itemRecord),
    locations: locations.map(locationRecord),
    commodities: commodities.map((c) => ({ id: c.id, entityId: c.entityId, code: c.code, name: c.name, kind: c.kind === 'CASHEW' ? 'cashew' : c.kind === 'COCOA' ? 'cocoa' : 'other', gramsPerBag: c.gramsPerBag })),
    floats: floats.map((f) => ({ id: f.id, entityId: f.entityId, agentId: f.agentId, date: f.date.toISOString().slice(0, 10), amountMinor: Number(f.amountMinor) })),
  };

  return <FieldForm refs={refs} />;
}
