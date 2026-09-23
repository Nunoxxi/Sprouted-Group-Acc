'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { AuthFrame, FieldLabel, FormError } from '@/components/auth/auth-frame';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';
import { passwordPolicy } from '@/lib/authz';

/**
 * Where invite and reset links land. The token in the URL was issued by the
 * library and is consumed by it; the same page serves a first password
 * (invitation) and a replacement (reset).
 */
export function SetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token');
  const linkError = params.get('error');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // A link that turns out to be spent or expired only when the form is sent.
  const [linkDead, setLinkDead] = useState(false);

  if (linkError || !token || linkDead) {
    return (
      <AuthFrame title="This link is no longer valid">
        <p className="text-sm text-slate-600">
          Invitation and reset links work once and expire after 48 hours. Ask an Owner to send a new invitation, or request
          a new reset link.
        </p>
        <div className="mt-5 flex gap-3">
          <Button variant="secondary" onClick={() => router.push('/forgot-password')}>
            Request a reset link
          </Button>
          <Button variant="ghost" onClick={() => router.push('/sign-in')}>
            Back to sign in
          </Button>
        </div>
      </AuthFrame>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password.length < passwordPolicy.minLength) {
      setError(`Use at least ${passwordPolicy.minLength} characters. A sentence you will remember works well.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    const { error: resetError } = await authClient.resetPassword({ newPassword: password, token: token as string });
    setBusy(false);
    if (resetError) {
      // Not a dead end in the middle of a form: say the link has gone and
      // offer a new one.
      if (resetError.code === 'INVALID_TOKEN') {
        setLinkDead(true);
        return;
      }
      setError(resetError.message ?? 'Could not set the password.');
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <AuthFrame title="Password set" intro="You can sign in now. Any other sessions on this account have been signed out.">
        <Button className="w-full" onClick={() => router.push('/sign-in')}>
          Go to sign in
        </Button>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title="Choose your password"
      intro={`At least ${passwordPolicy.minLength} characters. No forced symbols or numbers — length matters more. It is checked against a list of passwords known to have leaked in breaches.`}
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <FieldLabel htmlFor="password">New password</FieldLabel>
          <Input id="password" type="password" autoComplete="new-password" required minLength={passwordPolicy.minLength} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div>
          <FieldLabel htmlFor="confirm">Repeat it</FieldLabel>
          <Input id="confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Saving…' : 'Set password'}
        </Button>
      </form>
    </AuthFrame>
  );
}
