'use client';

import { useState, useTransition, type FormEvent } from 'react';

import { deactivateUser, inviteUser, reactivateUser, resendInvite, unlockUser, updateUserAccess, type ManagedUser } from '@/app/actions/users';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { roleDescriptions, roleLabels, roles, type Role } from '@/lib/authz';
import { formatDateTime } from '@/lib/format-date';

type EntityOption = { id: string; name: string };

const statusStyles: Record<ManagedUser['status'], string> = {
  active: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  invited: 'bg-amber-50 text-amber-800 ring-amber-200',
  locked: 'bg-rose-50 text-rose-800 ring-rose-200',
  deactivated: 'bg-slate-100 text-slate-600 ring-slate-200',
};

const statusLabels: Record<ManagedUser['status'], string> = {
  active: 'Active',
  invited: 'Invited — no password yet',
  locked: 'Locked',
  deactivated: 'Deactivated',
};

export function UsersAdmin({ users, entities }: { users: ManagedUser[]; entities: EntityOption[] }) {
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function run(label: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const result = await action();
      setMessage(result.ok ? { tone: 'ok', text: label } : { tone: 'error', text: result.error ?? 'Something went wrong.' });
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Owner</p>
        <h1 className="mt-1 text-2xl font-semibold">Users</h1>
        <p className="mt-1 text-sm text-slate-600">
          Invite by email; the person sets their own password from a link that expires in 48 hours. Roles say what someone
          can do; entity access says where. Nobody is ever deleted — deactivate instead, so the audit trail keeps resolving.
        </p>
      </div>

      {message ? (
        <p
          role="status"
          className={[
            'rounded-lg border px-3 py-2 text-sm',
            message.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800',
          ].join(' ')}
        >
          {message.text}
        </p>
      ) : null}

      <InviteForm entities={entities} pending={pending} onInvite={(input) => run(`Invitation sent to ${input.email}.`, () => inviteUser(input))} />

      <div className="space-y-3">
        {users.map((user) => (
          <UserRow
            key={user.id}
            user={user}
            entities={entities}
            pending={pending}
            onSave={(role, entityIds) => run(`${user.name} updated.`, () => updateUserAccess({ userId: user.id, role, entityIds }))}
            onDeactivate={() => {
              if (window.confirm(`Deactivate ${user.name}? They will be signed out everywhere and cannot sign in again until reactivated.`)) {
                run(`${user.name} deactivated.`, () => deactivateUser(user.id));
              }
            }}
            onReactivate={() => run(`${user.name} reactivated.`, () => reactivateUser(user.id))}
            onUnlock={() => run(`${user.name} unlocked.`, () => unlockUser(user.id))}
            onResend={() => run(`Invitation re-sent to ${user.email}.`, () => resendInvite(user.id))}
          />
        ))}
      </div>
    </div>
  );
}

function InviteForm({
  entities,
  pending,
  onInvite,
}: {
  entities: EntityOption[];
  pending: boolean;
  onInvite: (input: { name: string; email: string; role: Role; entityIds: string[] }) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [entityIds, setEntityIds] = useState<string[]>([]);

  function submit(event: FormEvent) {
    event.preventDefault();
    onInvite({ name, email, role, entityIds });
    setName('');
    setEmail('');
    setEntityIds([]);
  }

  return (
    <Card as="section">
      <h2 className="text-base font-semibold">Invite someone</h2>
      <form onSubmit={submit} className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Name</label>
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Email</label>
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <RoleAndEntities role={role} entityIds={entityIds} entities={entities} onRole={setRole} onEntities={setEntityIds} />
        <div className="md:col-span-2">
          <Button type="submit" disabled={pending || (role !== 'owner' && entityIds.length === 0)}>
            Send invitation
          </Button>
          {role !== 'owner' && entityIds.length === 0 ? (
            <span className="ml-3 text-xs text-slate-500">Choose at least one entity.</span>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

function RoleAndEntities({
  role,
  entityIds,
  entities,
  onRole,
  onEntities,
}: {
  role: Role;
  entityIds: string[];
  entities: EntityOption[];
  onRole: (role: Role) => void;
  onEntities: (ids: string[]) => void;
}) {
  return (
    <>
      <div>
        <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Role</label>
        <select
          value={role}
          onChange={(e) => onRole(e.target.value as Role)}
          className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"
        >
          {roles.map((value) => (
            <option key={value} value={value}>
              {roleLabels[value]}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-500">
          {roleDescriptions[role]}
        </p>
      </div>
      <div>
        <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Entity access</label>
        {role === 'owner' ? (
          <p className="text-sm text-slate-600">Owners see every entity.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {entities.map((entity) => {
              const checked = entityIds.includes(entity.id);
              return (
                <label
                  key={entity.id}
                  className={[
                    'cursor-pointer rounded-lg border px-3 py-2 text-sm',
                    checked ? 'border-brand-300 bg-brand-50 text-brand-900' : 'border-slate-200 bg-white text-slate-700',
                  ].join(' ')}
                >
                  <input
                    type="checkbox"
                    className="mr-2"
                    checked={checked}
                    onChange={(e) => onEntities(e.target.checked ? [...entityIds, entity.id] : entityIds.filter((id) => id !== entity.id))}
                  />
                  {entity.name}
                </label>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function UserRow({
  user,
  entities,
  pending,
  onSave,
  onDeactivate,
  onReactivate,
  onUnlock,
  onResend,
}: {
  user: ManagedUser;
  entities: EntityOption[];
  pending: boolean;
  onSave: (role: Role, entityIds: string[]) => void;
  onDeactivate: () => void;
  onReactivate: () => void;
  onUnlock: () => void;
  onResend: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [role, setRole] = useState<Role>(user.role);
  const [entityIds, setEntityIds] = useState<string[]>(user.entityIds);
  const entityNames = user.role === 'owner' ? 'All entities' : user.entityIds.map((id) => entities.find((e) => e.id === id)?.name ?? id).join(', ') || 'No entities';

  return (
    <Card as="article" className={user.status === 'deactivated' ? 'opacity-70' : ''}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{user.name}</h3>
            <span className={['rounded-full px-2 py-0.5 text-xs font-medium ring-1', statusStyles[user.status]].join(' ')}>{statusLabels[user.status]}</span>
            {user.twoFactorEnabled ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 ring-1 ring-slate-200">2FA on</span> : null}
          </div>
          <p className="mt-0.5 text-sm text-slate-600">{user.email}</p>
          <p className="mt-1 text-sm text-slate-700">
            <span className="font-medium">{user.roleLabel}</span> · {entityNames}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {user.lastSeenAt ? `Last seen ${formatDateTime(user.lastSeenAt)}` : 'Never signed in'}
            {user.failedLoginAttempts > 0 ? ` · ${user.failedLoginAttempts} failed sign-in${user.failedLoginAttempts === 1 ? '' : 's'}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {user.status === 'deactivated' ? (
            <Button size="sm" variant="secondary" disabled={pending} onClick={onReactivate}>
              Reactivate
            </Button>
          ) : (
            <>
              {user.status === 'locked' ? (
                <Button size="sm" variant="success" disabled={pending} onClick={onUnlock}>
                  Unlock
                </Button>
              ) : null}
              {user.status === 'invited' ? (
                <Button size="sm" variant="secondary" disabled={pending} onClick={onResend}>
                  Re-send invitation
                </Button>
              ) : null}
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => setEditing((current) => !current)}>
                {editing ? 'Cancel' : 'Change access'}
              </Button>
              <Button size="sm" variant="danger" disabled={pending} onClick={onDeactivate}>
                Deactivate
              </Button>
            </>
          )}
        </div>
      </div>

      {editing ? (
        <form
          className="mt-4 grid gap-4 border-t border-slate-100 pt-4 md:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSave(role, entityIds);
            setEditing(false);
          }}
        >
          <RoleAndEntities role={role} entityIds={entityIds} entities={entities} onRole={setRole} onEntities={setEntityIds} />
          <div className="md:col-span-2">
            <Button type="submit" size="sm" disabled={pending || (role !== 'owner' && entityIds.length === 0)}>
              Save access
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
