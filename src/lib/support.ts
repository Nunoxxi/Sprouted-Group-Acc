/**
 * Asking for help from inside the app: the "Contact support" form under the
 * ? menu. The message goes by email to whoever supports the app, with who
 * sent it, their role, the company and the screen they were on, so nobody
 * has to ask "which company were you in?" before they can help.
 *
 * Pure: no I/O. The Server Function in src/app/actions/support.ts sends it.
 */

/** Where support requests go. SUPPORT_EMAIL on the server overrides it. */
export const defaultSupportAddress = 'support.sproutedgroup@gmail.com';

export function supportAddress(): string {
  return process.env.SUPPORT_EMAIL?.trim() || defaultSupportAddress;
}

export type SupportTopic = 'how-to' | 'problem' | 'access' | 'idea' | 'other';

export const supportTopics: SupportTopic[] = ['how-to', 'problem', 'access', 'idea', 'other'];

export const supportTopicLabels: Record<SupportTopic, string> = {
  'how-to': 'How do I…?',
  problem: 'Something is not working',
  access: 'Access, password or sign-in',
  idea: 'A suggestion',
  other: 'Something else',
};

export const maxSupportMessage = 4000;

export type SupportRequest = { topic: SupportTopic; message: string };

export type SupportCheck = { ok: true; value: SupportRequest } | { ok: false; error: string };

export function checkSupportRequest(input: { topic: string; message: string }): SupportCheck {
  if (!(supportTopics as string[]).includes(input.topic)) return { ok: false, error: 'Choose what it is about.' };
  const message = input.message.trim();
  if (message.length < 10) return { ok: false, error: 'Say a little more about what you need, so support can help the first time.' };
  if (message.length > maxSupportMessage) return { ok: false, error: `Keep it under ${maxSupportMessage} characters. Send a second message for the rest.` };
  return { ok: true, value: { topic: input.topic as SupportTopic, message } };
}

export type SupportContext = {
  name: string;
  email: string;
  roleLabel: string;
  /** The company they had selected, or null when there was none. */
  entityName: string | null;
  /** The screen they were on, e.g. "Payroll" or "Phone capture". */
  screen: string;
  sentAt: string;
};

/** The email support receives. Replying to it reaches the person who asked. */
export function supportEmail(request: SupportRequest, context: SupportContext): { subject: string; text: string } {
  const where = [context.entityName, context.screen].filter(Boolean).join(' · ');
  return {
    subject: `[Sprouted support] ${supportTopicLabels[request.topic]} — ${context.name}`,
    text: [
      request.message,
      '',
      '---',
      `From: ${context.name} <${context.email}>`,
      `Role: ${context.roleLabel}`,
      `Where: ${where || 'not given'}`,
      `Sent: ${context.sentAt}`,
      '',
      'Reply to this email to answer them directly.',
    ].join('\n'),
  };
}

/** At most this many requests from one person in the window: a stuck button, not a conversation. */
export const supportLimit = { count: 5, windowMs: 10 * 60 * 1000 };

/** Whether one more request fits, given when this person's recent ones were sent. */
export function withinSupportLimit(sentAt: number[], now: number): boolean {
  return sentAt.filter((time) => now - time < supportLimit.windowMs).length < supportLimit.count;
}
