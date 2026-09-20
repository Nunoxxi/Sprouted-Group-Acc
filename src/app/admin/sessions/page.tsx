import { listSessions } from '@/app/actions/users';

import { SessionsAdmin } from './sessions-admin';

export const dynamic = 'force-dynamic';

export default async function SessionsPage() {
  const sessions = await listSessions();
  if (!sessions.ok) {
    return <p className="text-sm text-rose-800">{sessions.error}</p>;
  }
  return <SessionsAdmin sessions={sessions.value} />;
}
