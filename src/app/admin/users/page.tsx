import { listUsers } from '@/app/actions/users';
import { prisma } from '@/lib/prisma';

import { UsersAdmin } from './users-admin';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const [users, entities] = await Promise.all([
    listUsers(),
    prisma.entity.findMany({ select: { id: true, name: true }, orderBy: { code: 'asc' } }),
  ]);

  if (!users.ok) {
    return <p className="text-sm text-rose-800">{users.error}</p>;
  }

  return <UsersAdmin users={users.value} entities={entities} />;
}
