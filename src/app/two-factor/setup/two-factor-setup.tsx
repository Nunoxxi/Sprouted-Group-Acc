'use client';

import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';

import { AuthFrame, FieldLabel, FormError } from '@/components/auth/auth-frame';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';

type Step = { name: 'password' } | { name: 'scan'; totpURI: string; backupCodes: string[] } | { name: 'done'; backupCodes: string[] };

/**
 * Three steps, all through the library: confirm the password (enable returns
 * the TOTP secret as an otpauth URI plus backup codes), verify one code from
 * the app (which is what marks 2FA enabled), then show the backup codes once.
 */
export function TwoFactorSetup({ email }: { email: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ name: 'password' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (step.name !== 'scan') return;
    QRCode.toDataURL(step.totpURI, { margin: 1, width: 192 }).then(setQr).catch(() => setQr(null));
  }, [step]);

  async function begin(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: enableError } = await authClient.twoFactor.enable({ password, method: 'totp' });
    setBusy(false);
    if (enableError || !data || data.method !== 'totp') {
      setError(enableError?.message ?? 'Could not start two-factor setup.');
      return;
    }
    setPassword('');
    setStep({ name: 'scan', totpURI: data.totpURI, backupCodes: data.backupCodes });
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (step.name !== 'scan') return;
    setBusy(true);
    setError(null);
    const { error: verifyError } = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s+/g, '') });
    setBusy(false);
    if (verifyError) {
      setError(verifyError.message ?? 'That code was not accepted. Check the time on your phone and try again.');
      return;
    }
    setStep({ name: 'done', backupCodes: step.backupCodes });
  }

  if (step.name === 'password') {
    return (
      <AuthFrame
        title="Set up two-factor authentication"
        intro="Your role can post transactions, so an authenticator app is required. Confirm your password to begin."
      >
        <form onSubmit={begin} className="space-y-4">
          <div>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <FormError message={error} />
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Preparing…' : 'Continue'}
          </Button>
        </form>
      </AuthFrame>
    );
  }

  if (step.name === 'scan') {
    const secret = new URL(step.totpURI).searchParams.get('secret') ?? '';
    return (
      <AuthFrame
        title="Scan this code"
        intro={
          <>
            Open Google Authenticator, Microsoft Authenticator, 1Password or any TOTP app and scan the code for <strong>{email}</strong>.
          </>
        }
      >
        <div className="flex justify-center">
          {qr ? (
            // A data URL rendered locally; next/image adds nothing here.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt="TOTP QR code" width={192} height={192} className="rounded-lg border border-slate-200" />
          ) : (
            <div className="h-48 w-48 animate-pulse rounded-lg bg-slate-100" />
          )}
        </div>
        <p className="mt-3 text-center text-xs text-slate-500">
          Can&apos;t scan? Enter this key manually: <code className="select-all font-mono text-slate-800">{secret}</code>
        </p>
        <form onSubmit={verify} className="mt-6 space-y-4">
          <div>
            <FieldLabel htmlFor="code">Code from the app</FieldLabel>
            <Input id="code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          <FormError message={error} />
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Verifying…' : 'Verify and enable'}
          </Button>
        </form>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title="Save your backup codes"
      intro="If you lose your phone, one of these codes signs you in instead. Each works once. Store them somewhere safe — they will not be shown again."
    >
      <ul className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-sm">
        {step.backupCodes.map((backupCode) => (
          <li key={backupCode} className="select-all">
            {backupCode}
          </li>
        ))}
      </ul>
      <label className="mt-5 flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" className="mt-0.5" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I have saved these codes somewhere safe.
      </label>
      <Button
        className="mt-5 w-full"
        disabled={!saved}
        onClick={() => {
          router.push('/');
          router.refresh();
        }}
      >
        Go to the app
      </Button>
    </AuthFrame>
  );
}
