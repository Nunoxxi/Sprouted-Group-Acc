/**
 * Outbound email: invite links and password resets. One function, two
 * transports.
 *
 * - RESEND_API_KEY set: sent through Resend's HTTP API (no SDK needed).
 * - Otherwise, in development only, the message is printed to the server
 *   console so the link can be copied. In production a missing transport is
 *   an error — an invite that silently goes nowhere is worse than one that
 *   fails loudly.
 *
 * The sender defaults to EMAIL_FROM, the group address. Each entity may set
 * its own sender on the same domain (Entity.emailFrom); the caller passes it
 * as `from` when the email is for that entity's people.
 */

export type OutboundEmail = {
  to: string;
  subject: string;
  text: string;
  /** Overrides EMAIL_FROM. Must be on the same verified domain. */
  from?: string | null;
};

const fallbackSender = 'Sprouted Accounting <accounting@example.com>';

export function defaultSender(): string {
  return process.env.EMAIL_FROM?.trim() || fallbackSender;
}

/**
 * Parse "Name <local@domain>" or "local@domain". Returns null when the value
 * is not a usable sender. Deliberately strict: Resend rejects anything odd
 * with a 4xx at send time, which would surface as a failed invitation.
 */
export function parseSender(value: string): { display: string; address: string; domain: string } | null {
  const trimmed = value.trim();
  const match = /^(?:"?([^"<>]*?)"?\s*<([^<>\s]+)>|([^<>\s]+))$/.exec(trimmed);
  if (!match) return null;
  const address = (match[2] ?? match[3]).toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!/^[a-z0-9._%+-]+$/.test(local) || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  return { display: (match[1] ?? '').trim(), address, domain };
}

/** The domain the default sender is on — the one verified with the email provider. Null when unset. */
export function verifiedSenderDomain(): string | null {
  const from = process.env.EMAIL_FROM?.trim();
  if (!from) return null;
  return parseSender(from)?.domain ?? null;
}

export async function sendEmail(message: OutboundEmail): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = message.from?.trim() || defaultSender();

  if (apiKey) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text }),
    });
    if (!response.ok) {
      throw new Error(`Email delivery failed (${response.status}): ${await response.text()}`);
    }
    return;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('No email transport configured: set RESEND_API_KEY (and EMAIL_FROM).');
  }

  console.log(`\n--- email from ${from} to ${message.to} ---\n${message.subject}\n\n${message.text}\n--- end email ---\n`);
}
