/**
 * Privacy readers: how many people's details the app holds and in what
 * shape, every time somebody looked at personal data, and the record of the
 * requests people have made about their own data.
 *
 * The counts exist so that the register in src/lib/privacy.ts can be checked
 * against what is actually in the database — a register that says a field is
 * encrypted while half the rows are still in plain text is worse than none.
 */

import type { DataSubjectRequest, User } from '@prisma/client';

import { isEncrypted } from '../pii-crypto';
import { prisma } from '../prisma';
import type { SubjectKind } from '../privacy';
import type { AuditEventRecord, DataRequestRecord, PersonalDataCount } from './types';

export const requestInclude = { handledBy: { select: { name: true } } } as const;

export function dataRequestRecord(row: DataSubjectRequest & { handledBy: Pick<User, 'name'> | null }): DataRequestRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    kind: row.kind === 'ERASURE' ? 'erasure' : 'access',
    subjectKind: row.subjectKind as SubjectKind,
    subjectId: row.subjectId,
    subjectRef: row.subjectRef,
    requestedBy: row.requestedBy,
    note: row.note ?? '',
    pseudonym: row.pseudonym ?? '',
    fieldsChanged: row.fieldsChanged,
    handledByName: row.handledBy?.name ?? row.handledByName,
    createdAt: row.createdAt.toISOString(),
  };
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) (groups[keyOf(item)] ??= []).push(item);
  return groups;
}

/**
 * How many people of each kind the entity holds details on, and how many of
 * those details are still sitting in plain text. `pending` above zero means
 * the one-off encryption pass has not been run since those rows were
 * written; scripts/encrypt-existing-pii.ts is what clears it.
 */
async function countsFor(entityId: string): Promise<PersonalDataCount[]> {
  const [farmers, agents, contacts, payrollPeople, staffTime, custodians] = await Promise.all([
    prisma.farmer.findMany({ where: { entityId }, select: { phone: true, walletNumber: true } }),
    prisma.buyingAgent.findMany({ where: { entityId }, select: { phone: true } }),
    prisma.contact.findMany({ where: { balances: { some: { entityId } } }, select: { phone: true, email: true, address: true } }),
    prisma.payrollLine.findMany({ where: { entityId }, select: { employeeRef: true }, distinct: ['employeeRef'] }),
    prisma.staffTimeAllocation.findMany({ where: { entityId }, select: { personName: true }, distinct: ['personName'] }),
    prisma.fixedAsset.findMany({ where: { entityId, custodian: { not: null } }, select: { custodian: true } }),
  ]);

  const plainText = (values: (string | null)[]): number => values.filter((value) => value && !isEncrypted(value)).length;

  return [
    {
      subject: 'farmer',
      label: 'Farmers',
      people: farmers.length,
      encryptedValues: farmers.flatMap((row) => [row.phone, row.walletNumber]).filter((value) => value && isEncrypted(value)).length,
      pendingValues: plainText(farmers.flatMap((row) => [row.phone, row.walletNumber])),
      holds: 'Name, telephone number, mobile money number, community and district',
    },
    {
      subject: 'agent',
      label: 'Buying agents',
      people: agents.length,
      encryptedValues: agents.filter((row) => row.phone && isEncrypted(row.phone)).length,
      pendingValues: plainText(agents.map((row) => row.phone)),
      holds: 'Name and telephone number',
    },
    {
      subject: 'donor-or-supplier',
      label: 'Customers, suppliers and donors',
      people: contacts.length,
      encryptedValues: contacts.flatMap((row) => [row.phone, row.email, row.address]).filter((value) => value && isEncrypted(value)).length,
      pendingValues: plainText(contacts.flatMap((row) => [row.phone, row.email, row.address])),
      holds: 'Name, telephone number, email address, postal address and TIN',
    },
    {
      subject: 'staff',
      label: 'Staff on imported payrolls',
      people: payrollPeople.length + staffTime.length + custodians.length,
      encryptedValues: 0,
      pendingValues: 0,
      holds: 'Name, payroll reference, department, and the assets they hold. Pay figures come from the payroll system and stay in the ledger.',
    },
  ];
}

/** Scoped by the principal's grant in every query. */
export async function loadPrivacyData(scope: { entityId?: { in: string[] } }, entityIds: string[]) {
  const [requests, access] = await Promise.all([
    prisma.dataSubjectRequest.findMany({ where: scope, include: requestInclude, orderBy: { createdAt: 'desc' }, take: 500 }),
    prisma.auditEvent.findMany({ where: { ...scope, action: { in: ['VIEW_PII', 'ERASE'] } }, orderBy: { createdAt: 'desc' }, take: 500 }),
  ]);

  const withAll = <T>(grouped: Record<string, T[]>): Record<string, T[]> => Object.fromEntries(entityIds.map((id) => [id, grouped[id] ?? []]));
  const counts = await Promise.all(entityIds.map(async (id) => [id, await countsFor(id)] as const));

  const accessRecords: AuditEventRecord[] = access.map((row) => ({
    id: row.id,
    entityId: row.entityId,
    sequence: row.sequence,
    userName: row.userName,
    action: row.action,
    resourceType: row.resourceType,
    resourceRef: row.resourceRef,
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
  }));

  return {
    dataRequestsByEntity: withAll(groupBy(requests.map(dataRequestRecord), (row) => row.entityId)),
    piiAccessByEntity: withAll(groupBy(accessRecords, (row) => row.entityId)),
    personalDataCountsByEntity: Object.fromEntries(counts),
  };
}
