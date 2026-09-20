'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { AuthFrame, FieldLabel, FormError } from '@/components/auth/auth-frame';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';

/**
 * Second step of sign-in for users with TOTP enabled. The library has already
 * checked the password and holds a short-lived two-factor cookie; no session
 * exists until the code is verified.
 */
export default function TwoFactorPage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const trimmed = code.replace(/\s+/g, '');
    const result = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code: trimmed })
      : await authClient.twoFactor.verifyTotp({ code: trimmed });

    if (result.error) {
      setBusy(false);
      setError(result.error.status === 429 ? 'Too many attempts. Wait a minute and try again.' : (result.error.message ?? 'That code was not accepted.'));
      return;
    }

    router.push('/');
    router.refresh();
  }

  return (
    <AuthFrame
      title="Two-factor code"
      intro={useBackup ? 'Enter one of your backup codes. Each code works once.' : 'Enter the 6-digit code from your authenticator app.'}
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <FieldLabel htmlFor="code">{useBackup ? 'Backup code' : 'Code'}</FieldLabel>
          <Input
            id="code"
            inputMode={useBackup ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            autoFocus
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Checking…' : 'Continue'}
        </Button>
        <button
          type="button"
          className="w-full text-center text-sm text-brand-800 underline-offset-2 hover:underline"
          onClick={() => {
            setUseBackup((current) => !current);
            setCode('');
            setError(null);
          }}
        >
          {useBackup ? 'Use my authenticator app instead' : 'Lost your device? Use a backup code'}
        </button>
      </form>
    </AuthFrame>
  );
}
