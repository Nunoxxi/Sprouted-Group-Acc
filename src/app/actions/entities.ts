'use server';

/**
 * Server Functions for entity settings that are neither currency nor VAT.
 * Same contract as documents.ts: authorize first through src/lib/dal.ts,
 * scope by entity, write the audit event in the same transaction.
 */

import { refresh } from 'next/cache';

import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess } from '@/lib/dal';
import { entityRecord } from '@/lib/data/mappers';
import type { EntityRecord } from '@/lib/data/types';
import { defaultSender, parseSender, verifiedSenderDomain } from '@/lib/email';
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

/**
 * Set the address this entity's invitations and password resets are sent
 * from. Empty clears it (the group default applies). The address must be on
 * the domain the email provider has verified — the default sender's domain —
 * otherwise every invitation from this entity would fail at send time.
 */
export async function setEntitySender(entityId: string, sender: string): Promise<ActionResult<EntityRecord>> {
  return withEntityAccess(entityId, 'entity:configure', async (principal) => {
    const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId } });
    const trimmed = sender.trim();

    let value: string | null = null;
    if (trimmed) {
      const parsed = parseSender(trimmed);
      if (!parsed) {
        return fail('Enter the sender as "Sprouted Crafts <crafts@yourdomain.com>" or just crafts@yourdomain.com.');
      }
      const verified = verifiedSenderDomain();
      if (verified && parsed.domain !== verified) {
        return fail(`The sender must be on ${verified}, the domain verified with the email provider (the group default is ${defaultSender()}). Emails from ${parsed.domain} would be refused.`);
      }
      value = parsed.display ? `${parsed.display} <${parsed.address}>` : parsed.address;
    }

    if ((entity.emailFrom ?? null) === value) {
      return { ok: true, value: entityRecord(entity) };
    }

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.entity.update({ where: { id: entityId }, data: { emailFrom: value } });
      await recordAuditEvent(
        {
          entityId,
          userId: principal.userId,
          userName: principal.name,
          action: 'EDIT',
          resourceType: 'entity',
          resourceRef: entityId,
          summary: value ? `Email sender set to ${value}` : 'Email sender cleared (group default applies)',
          metadata: { emailFrom: value, previous: entity.emailFrom },
        },
        tx,
      );
      return row;
    });

    refresh();
    return { ok: true, value: entityRecord(updated) };
  });
}
