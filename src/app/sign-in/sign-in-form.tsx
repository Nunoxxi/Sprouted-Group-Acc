'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { AuthFrame, FieldLabel, FormError } from '@/components/auth/auth-frame';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';

export function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const { data, error: signInError } = await authClient.signIn.email({ email: email.trim(), password });

    if (signInError) {
      setBusy(false);
      setError(
        signInError.status === 429
          ? 'Too many attempts. Wait a minute and try again.'
          : (signInError.message ?? 'Sign-in failed.'),
      );
      return;
    }

    // With TOTP enabled the library answers with a redirect flag instead of a
    // session; the code is verified on /two-factor.
    // Where they were going is passed along, so a phone that came from
    // /capture goes back there after the code.
    if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
      const next = params.get('next');
      router.push(next && next.startsWith('/') && !next.startsWith('//') ? `/two-factor?next=${encodeURIComponent(next)}` : '/two-factor');
      return;
    }

    // One navigation, not a push followed by a refresh: the page is rendered
    // per request anyway, and the refresh only loaded it a second time.
    const next = params.get('next');
    setOpening(true);
    router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
  }

  return (
    <AuthFrame title="Sign in" intro="Accounts are created by invitation. There is no sign-up.">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy}>
          {opening ? 'Opening the app…' : busy ? 'Signing in…' : 'Sign in'}
        </Button>
        <p className="text-center text-sm">
          <a href="/forgot-password" className="text-brand-800 underline-offset-2 hover:underline">
            Forgotten your password?
          </a>
        </p>
      </form>
    </AuthFrame>
  );
}
