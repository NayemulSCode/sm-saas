/**
 * Who works here, and what each of them may do.
 *
 * The screen behind every "who can see the fee reports?" conversation. It shows
 * ROLES rather than permissions, because a principal thinks in "Accountant",
 * not in `fee.reconcile`.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  listMembers,
  listRoles,
  resolveAuthContext,
  tokenGenerator,
} from '../../../../../../../modules/identity/index';
import { readSessionToken } from '../../../../../../api/_lib/session-cookie';
import { can } from '../../../../../../../shared/auth-context';
import { InviteStaff, MemberRoles, type RoleOption } from './StaffActions';
import { appPath } from '../../../../../../../shared/paths';

export const dynamic = 'force-dynamic';

export default async function StaffPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<React.JSX.Element> {
  const { locale } = await params;
  const base = appPath(locale);

  const token = await readSessionToken();
  if (!token) redirect(`${base}/login`);

  const ctx = await resolveAuthContext(token, { tokens: tokenGenerator });
  if (!ctx.ok) redirect(`${base}/login`);

  if (!can(ctx.value, 'staff.read')) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <p className="text-sm text-[var(--color-text-muted)]">
          You do not have permission to view staff.
        </p>
      </main>
    );
  }

  const canManageRoles = can(ctx.value, 'role.manage');
  const canInvite = can(ctx.value, 'membership.manage');

  const [membersResult, rolesResult] = await Promise.all([
    listMembers(ctx.value),
    // Only fetched when it can be used: listRoles requires role.manage and
    // would throw for somebody who may read staff but not change access.
    canManageRoles ? listRoles(ctx.value) : Promise.resolve(null),
  ]);

  if (!membersResult.ok) redirect(`${base}/dashboard`);

  const roles: RoleOption[] =
    rolesResult?.ok
      ? rolesResult.value.map((r) => ({
          id: r.id,
          code: r.code,
          permissions: [...r.permissions],
        }))
      : [];

  // What the signed-in person holds, so the UI can grey out roles conferring
  // more than that rather than offering a guaranteed refusal.
  const myPermissions = [...ctx.value.permissions];

  return (
    <main className="mx-auto max-w-4xl p-6">
      <p className="mb-4 text-sm">
        <Link href={`${base}/dashboard`} className="underline">
          ← Dashboard
        </Link>
      </p>

      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">Staff</h1>
        {canInvite && <InviteStaff />}
      </div>

      <ul className="divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)]">
        {membersResult.value.map((m) => (
          <li key={m.membershipId} className="p-4">
            <div className="flex flex-wrap items-baseline gap-2">
              <p className="font-medium">{m.nameBn}</p>
              <p className="text-sm text-[var(--color-text-muted)]">{m.nameEn}</p>
              {m.identifier && (
                <p className="text-sm text-[var(--color-text-muted)]">· {m.identifier}</p>
              )}
              {/* An invited person is already a member — their membership exists
                  the moment the invite is issued — so hiding them until they
                  accept means inviting the same teacher twice. */}
              {m.invitePending && (
                <span className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]">
                  invite pending
                </span>
              )}
              {m.status !== 'active' && (
                <span className="rounded border border-[var(--color-danger)] px-2 py-0.5 text-xs text-[var(--color-danger)]">
                  {m.status}
                </span>
              )}
            </div>

            <div className="mt-2">
              <MemberRoles
                membershipId={m.membershipId}
                roles={m.roles}
                allRoles={roles}
                myPermissions={myPermissions}
                isSelf={m.isSelf}
                canManage={canManageRoles}
              />
            </div>
          </li>
        ))}
      </ul>

      {canManageRoles && (
        <p className="mt-6 text-sm text-[var(--color-text-muted)]">
          Granting and removing a role both require a reason, and both are
          recorded — including the attempts that are refused.
        </p>
      )}
    </main>
  );
}
