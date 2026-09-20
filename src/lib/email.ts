/**
 * Outbound email: invite links and password resets. One function, two
 * transports.
 *
 * - RESEND_API_KEY set: sent through Resend's HTTP API (no SDK needed).
 * - Otherwise, in development only, the message is printed to the server
 *   console so the link can be copied. In production a missing transport is
 *   an error — an invite that silently goes nowhere is worse than one that
 *   fails loudly.
 */

export type OutboundEmail = {
  to: string;
  subject: string;
  text: string;
};

export async function sendEmail(message: OutboundEmail): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim() || 'Sprouted Accounting <accounting@example.com>';

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

  console.log(`\n--- email to ${message.to} ---\n${message.subject}\n\n${message.text}\n--- end email ---\n`);
}
