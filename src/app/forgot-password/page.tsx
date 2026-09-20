'use client';

import { useState, type FormEvent } from 'react';

import { AuthFrame, FieldLabel, FormError } from '@/components/auth/auth-frame';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    // The library answers the same way whether or not the address exists.
    const { error: requestError } = await authClient.requestPasswordReset({ email: email.trim(), redirectTo: '/set-password' });
    setBusy(false);
    if (requestError) {
      setError(requestError.status === 429 ? 'Too many requests. Try again in a few minutes.' : (requestError.message ?? 'Could not send the link.'));
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <AuthFrame title="Check your email" intro="If that address belongs to an account, a link to set a new password is on its way. It expires in 48 hours.">
        <a href="/sign-in" className="text-sm font-medium text-brand-800 underline-offset-2 hover:underline">
          Back to sign in
        </a>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Reset your password" intro="Enter the email address on your account.">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
    </AuthFrame>
  );
}
