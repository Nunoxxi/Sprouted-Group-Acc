/**
 * Which entity an email to a person comes from.
 *
 * A person belongs to entities, not the other way round, so the rule is
 * simple and stated here once: the first entity they have access to, by
 * entity code (SG001 first). Owners belong to the whole group and get the
 * group default. An entity without a sender of its own falls back to the
 * group default too.
 */

import { prisma } from './prisma';

export type ResolvedSender = {
  /** The address to send from; null means the group default (EMAIL_FROM). */
  from: string | null;
  /** The entity the email speaks for, for the wording; null for the group. */
  entityName: string | null;
};

export async function senderForUser(userId: string): Promise<ResolvedSender> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!user || user.role === 'owner') {
    return { from: null, entityName: null };
  }
  const access = await prisma.userEntityAccess.findFirst({
    where: { userId },
    orderBy: { entity: { code: 'asc' } },
    select: { entity: { select: { name: true, emailFrom: true } } },
  });
  if (!access) {
    return { from: null, entityName: null };
  }
  return { from: access.entity.emailFrom, entityName: access.entity.name };
}
