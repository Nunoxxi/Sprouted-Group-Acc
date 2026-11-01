import { redirect } from 'next/navigation';
import type { Metadata, Viewport } from 'next';

import { can, mustSetUpTwoFactor, roleLabels, visibleEntityIds } from '@/lib/authz';
import { getPrincipal } from '@/lib/dal';
import { prisma } from '@/lib/prisma';

import { CaptureForm } from './capture-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Send a document — Sprouted',
  manifest: '/capture.webmanifest',
};

export const viewport: Viewport = {
  themeColor: '#2F6F5A',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

/**
 * The phone page staff use on the move: photograph a bill, an invoice, an
 * expense claim or a receipt and send it to a company's inbox. It keeps a
 * copy of this page on the phone, so it opens with no signal, and holds what
 * is captured until it can be sent.
 */
export default async function CapturePage() {
  const principal = await getPrincipal();
  if (!principal) redirect('/sign-in?next=%2Fcapture');
  if (mustSetUpTwoFactor(principal)) redirect('/two-factor/setup');
  if (!can(principal, 'document:capture')) {
    return <p className="p-6 text-sm text-slate-700">Your role ({roleLabels[principal.role]}) cannot send documents in. Ask an Owner to change it.</p>;
  }

  const entities = await prisma.entity.findMany({ orderBy: { code: 'asc' }, select: { id: true, name: true } });
  const allowedIds = visibleEntityIds(principal, entities.map((entity) => entity.id));
  const companies = entities.filter((entity) => allowedIds.includes(entity.id));
  if (companies.length === 0) {
    return <p className="p-6 text-sm text-slate-700">You have not been given access to any company yet. Ask an Owner.</p>;
  }

  // Staff have nothing in the main app to open; everyone else gets a way back to it.
  return <CaptureForm user={{ name: principal.name }} companies={companies} canOpenApp={can(principal, 'reports:view')} />;
}
