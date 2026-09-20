'use client';

import { useState, useTransition } from 'react';

import { revokeSession, type ActiveSession } from '@/app/actions/users';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatDateTime } from '@/lib/format-date';

function describe(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Chrome\//.test(userAgent)
      ? 'Chrome'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(userAgent) ? 'Windows' : /Mac OS/.test(userAgent) ? 'macOS' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Linux/.test(userAgent) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' on ');
}

export function SessionsAdmin({ sessions }: { sessions: ActiveSession[] }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Owner</p>
        <h1 className="mt-1 text-2xl font-semibold">Who is signed in</h1>
        <p className="mt-1 text-sm text-slate-600">
          Every live session. Forcing a sign-out ends that session on the next request the browser makes. Sessions expire
          after 12 hours regardless.
        </p>
      </div>

      {error ? (
        <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      ) : null}

      <Card className="p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Person</th>
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Address</th>
              <th className="px-4 py-3">Signed in</th>
              <th className="px-4 py-3">Last active</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-900">
                    {session.userName}
                    {session.isCurrent ? <span className="ml-2 rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-800 ring-1 ring-brand-100">this session</span> : null}
                  </div>
                  <div className="text-xs text-slate-500">{session.userEmail}</div>
                </td>
                <td className="px-4 py-3 text-slate-700" title={session.userAgent ?? undefined}>
                  {describe(session.userAgent)}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-slate-600">{session.ipAddress ?? '—'}</td>
                <td className="px-4 py-3 text-slate-700">{formatDateTime(session.createdAt)}</td>
                <td className="px-4 py-3 text-slate-700">{formatDateTime(session.updatedAt)}</td>
                <td className="px-4 py-3 text-right">
                  {session.isCurrent ? null : (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          const result = await revokeSession(session.token);
                          setError(result.ok ? null : result.error);
                        })
                      }
                    >
                      Force sign-out
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {sessions.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                  Nobody is signed in.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
