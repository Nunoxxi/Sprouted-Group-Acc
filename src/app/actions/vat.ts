'use server';

/**
 * Server Functions for VAT registration. Same contract as documents.ts:
 * authorize first through src/lib/dal.ts, scope by entity, write the audit
 * event in the same transaction as the change.
 *
 * Registration is per entity. Switching it on records the date it takes
 * effect; documents dated before that day are never taxed, and documents
 * already posted are never touched — their journals and their `vatApplied`
 * flag are fixed at posting.
 */

import { refresh } from 'next/cache';

import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess } from '@/lib/dal';
import { entityRecord } from '@/lib/data/mappers';
import type { EntityRecord } from '@/lib/data/types';
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

export type VatRegistrationInput = {
  registered: boolean;
  /** YYYY-MM-DD the registration takes effect. Required when switching on. */
  registeredFrom?: string;
};

/**
 * Switch VAT on or off for one entity. On needs an effective date; off keeps
 * nothing but the audit trail. Other entities are untouched.
 */
export async function setVatRegistration(entityId: string, input: VatRegistrationInput): Promise<ActionResult<EntityRecord>> {
  return withEntityAccess(entityId, 'entity:configure', async (principal) => {
    const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId } });
    const from = (input.registeredFrom ?? '').trim();

    if (input.registered) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
        return fail('Enter the date VAT registration takes effect (YYYY-MM-DD).');
      }
      const fromDate = new Date(`${from}T00:00:00.000Z`);
      if (Number.isNaN(fromDate.getTime())) {
        return fail('That registration date is not a real date.');
      }
      const current = entity.vatRegisteredFrom ? entity.vatRegisteredFrom.toISOString().slice(0, 10) : null;
      if (entity.vatRegistered && current === from) {
        return { ok: true, value: entityRecord(entity) };
      }

      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.entity.update({ where: { id: entityId }, data: { vatRegistered: true, vatRegisteredFrom: fromDate } });
        await recordAuditEvent(
          {
            entityId,
            userId: principal.userId,
            userName: principal.name,
            action: 'EDIT',
            resourceType: 'entity',
            resourceRef: entityId,
            summary: entity.vatRegistered ? `VAT registration date changed from ${current} to ${from}` : `VAT registration switched on from ${from}`,
            metadata: { vatRegistered: true, vatRegisteredFrom: from, previous: { vatRegistered: entity.vatRegistered, vatRegisteredFrom: current } },
          },
          tx,
        );
        return row;
      });
      refresh();
      return { ok: true, value: entityRecord(updated) };
    }

    if (!entity.vatRegistered) {
      return { ok: true, value: entityRecord(entity) };
    }
    const previous = entity.vatRegisteredFrom ? entity.vatRegisteredFrom.toISOString().slice(0, 10) : null;
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.entity.update({ where: { id: entityId }, data: { vatRegistered: false, vatRegisteredFrom: null } });
      await recordAuditEvent(
        {
          entityId,
          userId: principal.userId,
          userName: principal.name,
          action: 'EDIT',
          resourceType: 'entity',
          resourceRef: entityId,
          summary: `VAT registration switched off (was registered from ${previous})`,
          metadata: { vatRegistered: false, previous: { vatRegistered: true, vatRegisteredFrom: previous } },
        },
        tx,
      );
      return row;
    });
    refresh();
    return { ok: true, value: entityRecord(updated) };
  });
}
