'use server';

/**
 * Server Functions for data protection: finding a person, showing a hidden
 * number to somebody entitled to see it, producing the report a person is
 * entitled to ask for, and erasing a person at their request.
 *
 * Three rules hold throughout:
 *
 *  - Nothing here reveals anything without writing it down. Every reveal,
 *    every report and every erasure records an audit event in the entity's
 *    hash chain, so the record of who looked cannot be quietly edited later.
 *  - Erasure is anonymisation. The name goes, the telephone number, the
 *    mobile money number and the signature go; the amounts, the dates, the
 *    journals and the balances stay exactly as they were, because the law
 *    requires the accounts to be kept.
 *  - A pseudonym comes from a random token, never from the name it replaces,
 *    so nobody can work backwards from it.
 */

import { randomBytes } from 'node:crypto';

import { refresh } from 'next/cache';
import { Prisma } from '@prisma/client';

import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess } from '@/lib/dal';
import { dataRequestRecord, requestInclude } from '@/lib/data/privacy';
import { toMinor } from '@/lib/data/money';
import type { DataRequestRecord } from '@/lib/data/types';
import { formatMoney } from '@/lib/fx';
import { formatKg } from '@/lib/inventory';
import { decryptField, encryptField } from '@/lib/pii-crypto';
import {
  accessSummary,
  erasurePlan,
  pseudonymFor,
  subjectRights,
  type SubjectKind,
  type SubjectRecordGroup,
  type SubjectReport,
} from '@/lib/privacy';
import { prisma } from '@/lib/prisma';

import type { ActionResult } from './documents';

function fail<T>(error: string): ActionResult<T> {
  return { ok: false, error };
}

async function withEntityAccess<T>(entityId: string, permission: Permission, run: (principal: Principal) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  let principal: Principal;
  try {
    principal = await requireEntityAccess(entityId, permission);
  } catch (error) {
    const failure = authorizationFailure(error);
    if (failure) return failure;
    throw error;
  }
  return run(principal);
}

type Tx = Prisma.TransactionClient;

const dateText = (date: Date): string => date.toISOString().slice(0, 10);

// --- finding a person -------------------------------------------------------------------------

export type SubjectMatch = {
  kind: SubjectKind;
  id: string;
  name: string;
  /** Enough to tell two people of the same name apart, already masked. */
  detail: string;
};

/**
 * Find the people a request might be about. Searches names only: the
 * encrypted columns cannot be searched, which is the point of them.
 */
export async function findSubjects(entityId: string, query: string): Promise<ActionResult<SubjectMatch[]>> {
  return withEntityAccess(entityId, 'privacy:manage', async () => {
    const term = query.trim();
    if (term.length < 2) return fail('Type at least two letters of the name.');
    const contains = { contains: term, mode: 'insensitive' as const };

    const [farmers, agents, contacts, payroll, staffTime] = await Promise.all([
      prisma.farmer.findMany({ where: { entityId, name: contains }, select: { id: true, name: true, community: true, district: true }, take: 25 }),
      prisma.buyingAgent.findMany({ where: { entityId, name: contains }, select: { id: true, name: true }, take: 25 }),
      prisma.contact.findMany({ where: { name: contains, balances: { some: { entityId } } }, select: { id: true, name: true, category: true }, take: 25 }),
      prisma.payrollLine.findMany({ where: { entityId, employeeName: contains }, select: { employeeRef: true, employeeName: true, department: true }, distinct: ['employeeName'], take: 25 }),
      prisma.staffTimeAllocation.findMany({ where: { entityId, personName: contains }, select: { personName: true, role: true }, distinct: ['personName'], take: 25 }),
    ]);

    const staff = new Map<string, SubjectMatch>();
    for (const line of payroll) {
      const key = line.employeeRef?.trim() || line.employeeName;
      staff.set(key, { kind: 'employee', id: key, name: line.employeeName, detail: line.department ?? 'On the payroll' });
    }
    for (const row of staffTime) {
      if (!staff.has(row.personName)) staff.set(row.personName, { kind: 'employee', id: row.personName, name: row.personName, detail: row.role ?? 'Time charged to a grant' });
    }

    return {
      ok: true,
      value: [
        ...farmers.map((row) => ({ kind: 'farmer' as const, id: row.id, name: row.name, detail: [row.community, row.district].filter(Boolean).join(', ') || 'No community recorded' })),
        ...agents.map((row) => ({ kind: 'agent' as const, id: row.id, name: row.name, detail: 'Buying agent' })),
        ...contacts.map((row) => ({ kind: 'contact' as const, id: row.id, name: row.name, detail: row.category === 'GROUP_ENTITY' ? 'Another company in the group' : 'Customer, supplier or donor' })),
        ...staff.values(),
      ],
    };
  });
}

// --- showing one hidden value ------------------------------------------------------------------

export type RevealInput = {
  subjectKind: SubjectKind;
  subjectId: string;
  /** Which stored value to show, as `Model.field`. */
  field: string;
  /** Why it is being shown. Recorded with the event. */
  reason: string;
};

/**
 * Show one hidden telephone or mobile money number in full, and write down
 * that it was shown, by whom and why. This is the only way a number that the
 * interface masks is ever revealed.
 */
export async function revealPersonalDetail(entityId: string, input: RevealInput): Promise<ActionResult<{ value: string }>> {
  return withEntityAccess(entityId, 'pii:view', async (principal) => {
    const reason = input.reason.trim();
    if (!reason) return fail('Say why the number is needed. It is recorded with the request.');

    let stored: string | null = null;
    let label = '';
    let detail = '';

    if (input.subjectKind === 'farmer') {
      const farmer = await prisma.farmer.findFirst({ where: { id: input.subjectId, entityId }, select: { name: true, phone: true, walletNumber: true } });
      if (!farmer) return fail('That farmer is not on this entity.');
      label = farmer.name;
      if (input.field === 'Farmer.phone') { stored = decryptField('Farmer.phone', farmer.phone); detail = 'telephone number'; }
      else if (input.field === 'Farmer.walletNumber') { stored = decryptField('Farmer.walletNumber', farmer.walletNumber); detail = 'mobile money number'; }
      else return fail('That is not a value that can be shown.');
    } else if (input.subjectKind === 'agent') {
      const agent = await prisma.buyingAgent.findFirst({ where: { id: input.subjectId, entityId }, select: { name: true, phone: true } });
      if (!agent) return fail('That agent is not on this entity.');
      if (input.field !== 'BuyingAgent.phone') return fail('That is not a value that can be shown.');
      label = agent.name;
      stored = decryptField('BuyingAgent.phone', agent.phone);
      detail = 'telephone number';
    } else if (input.subjectKind === 'contact') {
      const contact = await prisma.contact.findFirst({ where: { id: input.subjectId, balances: { some: { entityId } } }, select: { name: true, phone: true, email: true, address: true } });
      if (!contact) return fail('That contact does not trade with this entity.');
      label = contact.name;
      const fields: Record<string, [string | null, string]> = {
        'Contact.phone': [contact.phone, 'telephone number'],
        'Contact.email': [contact.email, 'email address'],
        'Contact.address': [contact.address, 'postal address'],
      };
      const chosen = fields[input.field];
      if (!chosen) return fail('That is not a value that can be shown.');
      stored = decryptField(input.field, chosen[0]);
      detail = chosen[1];
    } else {
      return fail('Nothing hidden is held about a member of staff: payroll figures come from the payroll system.');
    }

    if (!stored) return fail('Nothing is held there.');

    await recordAuditEvent({
      entityId,
      userId: principal.userId,
      userName: principal.name,
      action: 'VIEW_PII',
      resourceType: `${input.subjectKind}-detail`,
      resourceRef: input.subjectId,
      summary: accessSummary('revealed-a-contact-detail', label, detail),
      metadata: { field: input.field, reason },
    });

    refresh();
    return { ok: true, value: { value: stored } };
  });
}

// --- the report a person is entitled to ---------------------------------------------------------

async function farmerReport(entityId: string, farmerId: string): Promise<{ label: string; groups: SubjectRecordGroup[] } | null> {
  const farmer = await prisma.farmer.findFirst({
    where: { id: farmerId, entityId },
    include: {
      purchases: { orderBy: { date: 'desc' }, include: { item: { select: { name: true } } } },
      advances: { orderBy: { date: 'desc' } },
      payments: { include: { batch: { select: { reference: true, paidAt: true } } } },
    },
  });
  if (!farmer) return null;

  const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
  const money = (minor: bigint) => formatMoney(toMinor(minor), entity.functionalCurrency);

  return {
    label: farmer.name,
    groups: [
      {
        title: 'What we hold about you',
        explanation: 'The details we keep so that we can pay you and reach you about a delivery.',
        rows: [
          { label: 'Name', value: farmer.name },
          { label: 'Telephone number', value: decryptField('Farmer.phone', farmer.phone) ?? 'None held' },
          { label: 'Mobile money number', value: decryptField('Farmer.walletNumber', farmer.walletNumber) ?? 'None held' },
          { label: 'Community', value: farmer.community ?? 'None held' },
          { label: 'District', value: farmer.district ?? 'None held' },
          { label: 'First recorded', value: dateText(farmer.createdAt) },
        ],
      },
      {
        title: 'What you delivered',
        explanation: 'Every delivery recorded against your name. These are accounting records and cannot be deleted.',
        rows: farmer.purchases.map((purchase) => ({
          label: `${dateText(purchase.date)} — ${purchase.item.name}`,
          value: `${formatKg(Number(purchase.grams))} at ${money(purchase.priceMinor)}${purchase.evidenceKind ? ', signed for on the agent’s phone' : ''}`,
        })),
      },
      {
        title: 'What we paid you',
        explanation: 'Payments sent to you, and the reference for each one.',
        rows: farmer.payments.map((payment) => ({
          label: `${payment.batch.paidAt ? dateText(payment.batch.paidAt) : 'Not yet paid'} — ${payment.batch.reference}`,
          value: `${money(payment.amountMinor)}${payment.paymentRef ? `, reference ${payment.paymentRef}` : ''}`,
        })),
      },
      {
        title: 'Advances',
        explanation: 'Money paid to you before a delivery, and how much of it has been recovered.',
        rows: farmer.advances.map((advance) => ({
          label: dateText(advance.date),
          value: `${money(advance.amountMinor)} advanced, ${money(advance.settledMinor)} recovered`,
        })),
      },
    ],
  };
}

async function agentReport(entityId: string, agentId: string): Promise<{ label: string; groups: SubjectRecordGroup[] } | null> {
  const agent = await prisma.buyingAgent.findFirst({
    where: { id: agentId, entityId },
    include: { floats: { orderBy: { date: 'desc' } }, purchases: { orderBy: { date: 'desc' }, take: 200 } },
  });
  if (!agent) return null;

  const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
  const money = (minor: bigint) => formatMoney(toMinor(minor), entity.functionalCurrency);

  return {
    label: agent.name,
    groups: [
      {
        title: 'What we hold about you',
        explanation: 'The details we keep so that we can reach you about buying.',
        rows: [
          { label: 'Name', value: agent.name },
          { label: 'Telephone number', value: decryptField('BuyingAgent.phone', agent.phone) ?? 'None held' },
          { label: 'First recorded', value: dateText(agent.createdAt) },
        ],
      },
      {
        title: 'Money advanced to you to buy with',
        explanation: 'Float given to you, which the accounts treat as owed by you until it is accounted for.',
        rows: agent.floats.map((float) => ({ label: dateText(float.date), value: money(float.amountMinor) })),
      },
      {
        title: 'What you bought for us',
        explanation: 'Deliveries you recorded. These are accounting records and cannot be deleted.',
        rows: [{ label: 'Purchases recorded', value: `${agent.purchases.length}` }],
      },
    ],
  };
}

async function contactReport(entityId: string, contactId: string): Promise<{ label: string; groups: SubjectRecordGroup[] } | null> {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, balances: { some: { entityId } } },
    include: { balances: { where: { entityId } }, documents: { where: { entityId }, orderBy: { date: 'desc' }, take: 200 } },
  });
  if (!contact) return null;

  const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
  const money = (minor: bigint) => formatMoney(toMinor(minor), entity.functionalCurrency);

  return {
    label: contact.name,
    groups: [
      {
        title: 'What we hold about you',
        explanation: 'The details we keep so that we can invoice you, pay you and reach you.',
        rows: [
          { label: 'Name', value: contact.name },
          { label: 'Telephone number', value: decryptField('Contact.phone', contact.phone) ?? 'None held' },
          { label: 'Email address', value: decryptField('Contact.email', contact.email) ?? 'None held' },
          { label: 'Postal address', value: decryptField('Contact.address', contact.address) ?? 'None held' },
          { label: 'TIN', value: contact.tin ?? 'None held' },
        ],
      },
      {
        title: 'Invoices and bills',
        explanation: 'Documents raised to you or received from you. These are accounting records and cannot be deleted.',
        rows: contact.documents.map((document) => ({ label: `${dateText(document.date)} — ${document.number}`, value: document.status.toLowerCase().replace(/_/g, ' ') })),
      },
      {
        title: 'What is owed',
        explanation: 'The balance between us at this company today.',
        rows: contact.balances.map((balance) => ({ label: 'Balance', value: money(balance.balanceMinor) })),
      },
    ],
  };
}

async function employeeReport(entityId: string, employeeKey: string): Promise<{ label: string; groups: SubjectRecordGroup[] } | null> {
  const [lines, allocations, staffTime, assets] = await Promise.all([
    prisma.payrollLine.findMany({ where: { entityId, OR: [{ employeeRef: employeeKey }, { employeeName: employeeKey }] }, include: { run: { select: { period: true } } }, orderBy: { id: 'asc' } }),
    prisma.payrollAllocation.findMany({ where: { entityId, employeeKey }, include: { grant: { select: { name: true } } } }),
    prisma.staffTimeAllocation.findMany({ where: { entityId, personName: employeeKey }, include: { grant: { select: { name: true } } }, orderBy: { periodStart: 'desc' } }),
    prisma.fixedAsset.findMany({ where: { entityId, custodian: employeeKey }, select: { description: true, code: true } }),
  ]);
  if (lines.length === 0 && allocations.length === 0 && staffTime.length === 0 && assets.length === 0) return null;

  const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
  const money = (minor: bigint) => formatMoney(toMinor(minor), entity.functionalCurrency);
  const label = lines[0]?.employeeName ?? employeeKey;

  return {
    label,
    groups: [
      {
        title: 'What we hold about you',
        explanation: 'Your pay is worked out in a separate payroll system. What this app holds is the summary that was imported, so that the cost appears in the accounts.',
        rows: [
          { label: 'Name', value: label },
          { label: 'Payroll reference', value: lines[0]?.employeeRef ?? 'None held' },
          { label: 'Department', value: lines[0]?.department ?? 'None held' },
        ],
      },
      {
        title: 'Imported payroll summaries',
        explanation: 'One line per month, as it came from the payroll system. These are accounting records and cannot be deleted.',
        rows: lines.map((line) => ({ label: line.run.period, value: `Gross ${money(line.grossMinor)}, PAYE ${money(line.payeMinor)}, net ${money(line.netMinor)}` })),
      },
      {
        title: 'How your cost is split between funders',
        explanation: 'The share of your cost charged to each grant, so that donors are reported to correctly.',
        rows: [
          ...allocations.map((allocation) => ({ label: allocation.grant.name, value: `${allocation.pct.toString()}%` })),
          ...staffTime.map((row) => ({ label: `${row.grant.name} — ${dateText(row.periodStart)} to ${dateText(row.periodEnd)}`, value: `${row.hours.toString()} hours, valued at ${money(row.valueMinor)}` })),
        ],
      },
      {
        title: 'Company property in your care',
        explanation: 'Assets recorded as being with you.',
        rows: assets.map((asset) => ({ label: asset.code, value: asset.description })),
      },
    ],
  };
}

export type SubjectRequestInput = {
  subjectKind: SubjectKind;
  subjectId: string;
  /** Who asked, in their own words. */
  requestedBy: string;
  note?: string;
};

/**
 * Everything the app holds about one person, in plain words, with the rights
 * paragraph at the end. Producing one is itself recorded.
 */
export async function subjectAccessReport(entityId: string, input: SubjectRequestInput): Promise<ActionResult<{ report: SubjectReport; request: DataRequestRecord }>> {
  return withEntityAccess(entityId, 'privacy:manage', async (principal) => {
    const requestedBy = input.requestedBy.trim();
    if (!requestedBy) return fail('Record who asked for the report.');

    const built =
      input.subjectKind === 'farmer' ? await farmerReport(entityId, input.subjectId)
      : input.subjectKind === 'agent' ? await agentReport(entityId, input.subjectId)
      : input.subjectKind === 'contact' ? await contactReport(entityId, input.subjectId)
      : await employeeReport(entityId, input.subjectId);

    if (!built) return fail('Nothing is held about that person on this company.');

    const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId }, select: { name: true } });

    const request = await prisma.$transaction(async (tx: Tx) => {
      const row = await tx.dataSubjectRequest.create({
        data: {
          entityId,
          kind: 'ACCESS',
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          subjectRef: built.label,
          requestedBy,
          note: input.note?.trim() || null,
          handledById: principal.userId,
          handledByName: principal.name,
        },
        include: requestInclude,
      });
      await recordAuditEvent(
        {
          entityId,
          userId: principal.userId,
          userName: principal.name,
          action: 'VIEW_PII',
          resourceType: 'subject-access-report',
          resourceRef: row.id,
          summary: accessSummary('subject-access-report', built.label),
          metadata: { subjectKind: input.subjectKind, requestedBy },
        },
        tx,
      );
      return row;
    });

    refresh();
    return {
      ok: true,
      value: {
        report: {
          subjectKind: input.subjectKind,
          subjectLabel: built.label,
          entityName: entity.name,
          producedAt: new Date().toISOString(),
          groups: built.groups,
          rights: subjectRights,
        },
        request: dataRequestRecord(request),
      },
    };
  });
}

// --- erasure -----------------------------------------------------------------------------------

/**
 * Erase a person: their name becomes a reference, their contact details and
 * any signature are emptied, and every amount, date and journal stays exactly
 * where it was. Nothing is deleted.
 *
 * A farmer's name also appears on lots, which are linked by name rather than
 * by id, so those are matched on the old name inside this entity before it
 * changes.
 */
export async function erasePerson(entityId: string, input: SubjectRequestInput): Promise<ActionResult<{ request: DataRequestRecord; pseudonym: string }>> {
  return withEntityAccess(entityId, 'privacy:manage', async (principal) => {
    const requestedBy = input.requestedBy.trim();
    if (!requestedBy) return fail('Record who asked for the erasure.');

    const pseudonym = pseudonymFor(input.subjectKind, randomBytes(8).toString('hex'));
    const plan = erasurePlan(input.subjectKind, pseudonym);

    const result = await prisma.$transaction(
      async (tx: Tx) => {
        let subjectRef = '';
        let changed = 0;

        if (input.subjectKind === 'farmer') {
          const farmer = await tx.farmer.findFirst({ where: { id: input.subjectId, entityId }, select: { id: true, name: true } });
          if (!farmer) return { refusal: 'That farmer is not on this entity.', row: null };
          subjectRef = farmer.name;
          await tx.farmer.update({ where: { id: farmer.id }, data: { name: pseudonym, phone: null, walletNumber: null } });
          changed += 3;
          changed += (await tx.agentPurchase.updateMany({ where: { entityId, farmerId: farmer.id }, data: { farmerName: pseudonym, evidenceData: null } })).count;
          changed += (await tx.farmerAdvance.updateMany({ where: { entityId, farmerId: farmer.id }, data: { farmerName: pseudonym } })).count;
          changed += (await tx.farmerPayment.updateMany({ where: { entityId, farmerId: farmer.id }, data: { walletNumber: null } })).count;
          changed += (await tx.lot.updateMany({ where: { entityId, farmerName: farmer.name }, data: { farmerName: pseudonym } })).count;
        } else if (input.subjectKind === 'agent') {
          const agent = await tx.buyingAgent.findFirst({ where: { id: input.subjectId, entityId }, select: { id: true, name: true } });
          if (!agent) return { refusal: 'That agent is not on this entity.', row: null };
          subjectRef = agent.name;
          await tx.buyingAgent.update({ where: { id: agent.id }, data: { name: pseudonym, phone: null } });
          changed += 2;
        } else if (input.subjectKind === 'contact') {
          const contact = await tx.contact.findFirst({ where: { id: input.subjectId, balances: { some: { entityId } } }, select: { id: true, name: true, category: true } });
          if (!contact) return { refusal: 'That contact does not trade with this entity.', row: null };
          if (contact.category === 'GROUP_ENTITY') return { refusal: 'That is another company in the group, not a person. It cannot be erased.', row: null };
          subjectRef = contact.name;
          await tx.contact.update({ where: { id: contact.id }, data: { name: pseudonym, phone: null, email: null, address: null } });
          changed += 4;
        } else {
          const lines = await tx.payrollLine.findMany({ where: { entityId, OR: [{ employeeRef: input.subjectId }, { employeeName: input.subjectId }] }, select: { id: true, employeeName: true } });
          const times = await tx.staffTimeAllocation.findMany({ where: { entityId, personName: input.subjectId }, select: { id: true, personName: true } });
          const allocations = await tx.payrollAllocation.findMany({ where: { entityId, employeeKey: input.subjectId }, select: { id: true } });
          const assets = await tx.fixedAsset.findMany({ where: { entityId, custodian: input.subjectId }, select: { id: true } });
          if (lines.length === 0 && times.length === 0 && allocations.length === 0 && assets.length === 0) {
            return { refusal: 'Nothing is held about that person on this company.', row: null };
          }
          subjectRef = lines[0]?.employeeName ?? times[0]?.personName ?? input.subjectId;
          changed += (await tx.payrollLine.updateMany({ where: { id: { in: lines.map((line) => line.id) } }, data: { employeeName: pseudonym, employeeRef: pseudonym } })).count;
          changed += (await tx.payrollAllocation.updateMany({ where: { id: { in: allocations.map((row) => row.id) } }, data: { employeeName: pseudonym, employeeKey: pseudonym } })).count;
          changed += (await tx.staffTimeAllocation.updateMany({ where: { id: { in: times.map((row) => row.id) } }, data: { personName: pseudonym } })).count;
          changed += (await tx.fixedAsset.updateMany({ where: { id: { in: assets.map((row) => row.id) } }, data: { custodian: pseudonym } })).count;
        }

        const row = await tx.dataSubjectRequest.create({
          data: {
            entityId,
            kind: 'ERASURE',
            subjectKind: input.subjectKind,
            subjectId: input.subjectId,
            subjectRef,
            requestedBy,
            note: input.note?.trim() || null,
            pseudonym,
            fieldsChanged: changed,
            handledById: principal.userId,
            handledByName: principal.name,
          },
          include: requestInclude,
        });

        await recordAuditEvent(
          {
            entityId,
            userId: principal.userId,
            userName: principal.name,
            action: 'ERASE',
            resourceType: `${input.subjectKind}-erasure`,
            resourceRef: row.id,
            // The audit chain says what became of whom. It names the person,
            // because a record that somebody was erased without saying who is
            // not a record of anything.
            summary: accessSummary('erased-a-person', subjectRef, `now ${pseudonym}`),
            metadata: {
              pseudonym,
              valuesChanged: changed,
              replaced: plan.replaced.map((field) => `${field.model}.${field.field}`),
              removed: plan.removed.map((field) => `${field.model}.${field.field}`),
            },
          },
          tx,
        );

        return { refusal: null, row };
      },
      { timeout: 20_000, maxWait: 10_000 },
    );

    if (result.refusal || !result.row) return fail(result.refusal ?? 'Nothing was erased.');

    refresh();
    return { ok: true, value: { request: dataRequestRecord(result.row), pseudonym } };
  });
}

// --- the one-off pass over rows written before encryption ---------------------------------------

/**
 * Encrypt every personal detail still sitting in plain text. Safe to run
 * again: an already-encrypted value is left alone. The count it returns is
 * what the privacy panel shows as outstanding, so running it until that
 * reads zero is the whole of the job.
 */
export async function encryptStoredPersonalData(entityId: string): Promise<ActionResult<{ encrypted: number }>> {
  return withEntityAccess(entityId, 'privacy:manage', async (principal) => {
    let encrypted = 0;

    const farmers = await prisma.farmer.findMany({ where: { entityId }, select: { id: true, phone: true, walletNumber: true } });
    for (const farmer of farmers) {
      const phone = encryptField('Farmer.phone', farmer.phone);
      const wallet = encryptField('Farmer.walletNumber', farmer.walletNumber);
      if (phone === farmer.phone && wallet === farmer.walletNumber) continue;
      await prisma.farmer.update({ where: { id: farmer.id }, data: { phone, walletNumber: wallet } });
      encrypted += Number(phone !== farmer.phone) + Number(wallet !== farmer.walletNumber);
    }

    const agents = await prisma.buyingAgent.findMany({ where: { entityId }, select: { id: true, phone: true } });
    for (const agent of agents) {
      const phone = encryptField('BuyingAgent.phone', agent.phone);
      if (phone === agent.phone) continue;
      await prisma.buyingAgent.update({ where: { id: agent.id }, data: { phone } });
      encrypted += 1;
    }

    const purchases = await prisma.agentPurchase.findMany({ where: { entityId, evidenceData: { not: null } }, select: { id: true, evidenceData: true } });
    for (const purchase of purchases) {
      const evidence = encryptField('AgentPurchase.evidenceData', purchase.evidenceData);
      if (evidence === purchase.evidenceData) continue;
      await prisma.agentPurchase.update({ where: { id: purchase.id }, data: { evidenceData: evidence } });
      encrypted += 1;
    }

    const payments = await prisma.farmerPayment.findMany({ where: { entityId, walletNumber: { not: null } }, select: { id: true, walletNumber: true } });
    for (const payment of payments) {
      const wallet = encryptField('FarmerPayment.walletNumber', payment.walletNumber);
      if (wallet === payment.walletNumber) continue;
      await prisma.farmerPayment.update({ where: { id: payment.id }, data: { walletNumber: wallet } });
      encrypted += 1;
    }

    // Contacts are shared across the group, so this pass covers the ones this
    // entity trades with; running it on each entity covers them all.
    const contacts = await prisma.contact.findMany({ where: { balances: { some: { entityId } } }, select: { id: true, phone: true, email: true, address: true } });
    for (const contact of contacts) {
      const phone = encryptField('Contact.phone', contact.phone);
      const email = encryptField('Contact.email', contact.email);
      const address = encryptField('Contact.address', contact.address);
      if (phone === contact.phone && email === contact.email && address === contact.address) continue;
      await prisma.contact.update({ where: { id: contact.id }, data: { phone, email, address } });
      encrypted += Number(phone !== contact.phone) + Number(email !== contact.email) + Number(address !== contact.address);
    }

    if (encrypted > 0) {
      await recordAuditEvent({
        entityId,
        userId: principal.userId,
        userName: principal.name,
        action: 'EDIT',
        resourceType: 'personal-data',
        resourceRef: entityId,
        summary: `Encrypted ${encrypted} personal detail${encrypted === 1 ? '' : 's'} that were still in plain text`,
        metadata: { encrypted },
      });
    }

    refresh();
    return { ok: true, value: { encrypted } };
  });
}
