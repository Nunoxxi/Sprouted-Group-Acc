'use server';

/**
 * The "Contact support" form under the ? menu. Any signed-in person may send
 * one, Staff included. The message is emailed to the support address with
 * who sent it and where they were (src/lib/support.ts); a reply reaches them.
 *
 * The company named must be one the person may see: it only labels the
 * email, but a label for a company they cannot see would say it exists.
 */

import { canAccessEntity, roleLabels } from '@/lib/authz';
import { authorizationFailure, requirePrincipal } from '@/lib/dal';
import { sendEmail } from '@/lib/email';
import { prisma } from '@/lib/prisma';
import { checkSupportRequest, supportAddress, supportEmail, withinSupportLimit } from '@/lib/support';

import type { ActionResult } from './documents';

// When each person last asked, in this server process. A restart forgets it,
// which is fine: this stops a stuck button, it is not a quota.
const recentlySent = new Map<string, number[]>();

export async function contactSupport(input: { entityId: string | null; screen: string; topic: string; message: string }): Promise<ActionResult<{ sentTo: string }>> {
  let principal;
  try {
    principal = await requirePrincipal({ allowPendingTwoFactor: true });
  } catch (error) {
    const failure = authorizationFailure(error);
    if (failure) return failure;
    throw error;
  }
  if (input.entityId && !canAccessEntity(principal, input.entityId)) {
    return { ok: false, error: 'You do not have access to this entity.' };
  }

  const checked = checkSupportRequest(input);
  if (!checked.ok) return checked;

  const now = Date.now();
  const sent = recentlySent.get(principal.userId) ?? [];
  if (!withinSupportLimit(sent, now)) {
    return { ok: false, error: 'You have sent several messages in the last few minutes. Wait a little, and support will reply to those first.' };
  }

  const entity = input.entityId ? await prisma.entity.findUnique({ where: { id: input.entityId }, select: { name: true } }) : null;
  const to = supportAddress();
  const email = supportEmail(checked.value, {
    name: principal.name,
    email: principal.email,
    roleLabel: roleLabels[principal.role],
    entityName: entity?.name ?? null,
    screen: input.screen.trim().slice(0, 60),
    sentAt: `${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} GMT`,
  });

  try {
    await sendEmail({ to, subject: email.subject, text: email.text, replyTo: principal.email });
  } catch {
    return { ok: false, error: `The message could not be sent just now. Try again in a moment, or email ${to} directly.` };
  }
  recentlySent.set(principal.userId, [...sent.filter((time) => now - time < 60 * 60 * 1000), now]);
  return { ok: true, value: { sentTo: to } };
}
