'use client';

/**
 * Inviting staff and changing what they may do.
 *
 * Two rules from §9.5 shape this screen, and both are enforced by the server —
 * the UI only avoids offering a guaranteed refusal:
 *
 *   Nobody edits their own access. The principal holds every permission, so
 *   the subset check passes for them trivially; only the self-grant rule stops
 *   them, and their own row therefore has no controls.
 *
 *   Nobody grants beyond what they hold. Roles conferring something the signed-
 *   in person lacks are shown, but disabled and labelled — hiding them entirely
 *   would leave somebody hunting for a role they can see on the roles list.
 */

import { useState, type FormEvent } from 'react';

export interface RoleOption {
  id: string;
  code: string;
  permissions: string[];
}

const MESSAGES: Record<string, string> = {
  SELF_GRANT_BLOCKED: 'Nobody can change their own access, including you.',
  CANNOT_GRANT_BEYOND_OWN: 'That role confers something you do not hold yourself.',
  ALREADY_GRANTED: 'They already have that role.',
  NOT_GRANTED: 'They do not have that role.',
  ALREADY_A_MEMBER: 'That person is already a member of this school.',
  INVALID_IDENTIFIER: 'Use a mobile number as +8801XXXXXXXXX, or an email address.',
  VALIDATION_FAILED: 'Check the details and try again.',
  TENANT_SUSPENDED: 'This school is read-only.',
};

async function call(path: string, body: unknown): Promise<string | null> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  if (res.ok) return null;
  const json = (await res.json().catch(() => ({}))) as {
    error?: { code: string; message: string };
  };
  return MESSAGES[json.error?.code ?? ''] ?? json.error?.message ?? 'That did not work.';
}

// ── roles on one member ──────────────────────────────────────────────────────

export function MemberRoles({
  membershipId,
  roles,
  allRoles,
  myPermissions,
  isSelf,
  canManage,
}: {
  membershipId: string;
  roles: Array<{ id: string; code: string }>;
  allRoles: RoleOption[];
  myPermissions: string[];
  isSelf: boolean;
  canManage: boolean;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const held = new Set(roles.map((r) => r.id));
  const mine = new Set(myPermissions);
  const grantable = (r: RoleOption): boolean => r.permissions.every((p) => mine.has(p));

  async function grant(roleId: string): Promise<void> {
    setBusy(true);
    const reason = window.prompt('Why is this role being granted?') ?? '';
    if (reason.trim().length < 3) {
      setBusy(false);
      return;
    }
    const failure = await call(`/api/v1/memberships/${membershipId}/roles`, {
      roleId,
      reason: reason.trim(),
    });
    if (failure) {
      setBusy(false);
      setError(failure);
      return;
    }
    window.location.reload();
  }

  async function revoke(roleId: string, code: string): Promise<void> {
    setBusy(true);
    const reason = window.prompt(`Why is ${code} being removed?`) ?? '';
    if (reason.trim().length < 3) {
      setBusy(false);
      return;
    }
    const failure = await call(`/api/v1/memberships/${membershipId}/roles/revoke`, {
      roleId,
      reason: reason.trim(),
    });
    if (failure) {
      setBusy(false);
      setError(failure);
      return;
    }
    window.location.reload();
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1">
        {roles.length === 0 && (
          <span className="text-sm text-[var(--color-text-muted)]">
            No role — they can sign in but do nothing.
          </span>
        )}
        {roles.map((r) => (
          <span
            key={r.id}
            className="flex items-center gap-1 rounded bg-[var(--brand-primary)] px-2 py-0.5 text-xs text-[var(--brand-on-primary)]"
          >
            {r.code}
            {canManage && !isSelf && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void revoke(r.id, r.code)}
                aria-label={`Remove ${r.code}`}
                className="disabled:opacity-60"
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>

      {canManage && !isSelf && (
        <div className="mt-2 flex flex-wrap gap-1">
          {allRoles
            .filter((r) => !held.has(r.id))
            .map((r) => {
              const allowed = grantable(r);
              return (
                <button
                  key={r.id}
                  type="button"
                  disabled={busy || !allowed}
                  onClick={() => void grant(r.id)}
                  title={
                    allowed
                      ? `Grant ${r.code}`
                      : `${r.code} confers permissions you do not hold`
                  }
                  className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs disabled:opacity-40"
                >
                  + {r.code}
                </button>
              );
            })}
        </div>
      )}

      {isSelf && canManage && (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          This is you. Nobody edits their own access.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

// ── invite ───────────────────────────────────────────────────────────────────

export function InviteStaff(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const f = new FormData(e.currentTarget);
    const res = await fetch('/api/v1/staff/invites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        person: {
          nameBn: String(f.get('nameBn') ?? '').trim(),
          nameEn: String(f.get('nameEn') ?? '').trim(),
        },
        identifier: String(f.get('identifier') ?? '').trim(),
      }),
    });

    const json = (await res.json().catch(() => ({}))) as {
      data?: { inviteToken: string | null };
      error?: { code: string; message: string };
    };
    setBusy(false);

    if (!res.ok) {
      setError(MESSAGES[json.error?.code ?? ''] ?? json.error?.message ?? 'The invite failed.');
      return;
    }

    /*
     * The token is returned ONCE and never stored in plaintext. Showing it here
     * is the only chance to copy it — and it is null when the person already
     * had a password, because they were granted a second school and sign in
     * with the credentials they already use.
     */
    setLink(json.data?.inviteToken ?? null);
  }

  if (link !== null) {
    return (
      <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4">
        <p className="font-medium">Invite created</p>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Send them this link. It works once, and it is shown only now — it is
          never stored in a form anybody can read back.
        </p>
        <code className="mt-2 block break-all rounded bg-[var(--color-surface)] p-2 text-xs">
          {`${window.location.origin}/app/invite/accept?token=${link}`}
        </code>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-3 min-h-11 rounded border border-[var(--color-border)] px-4"
        >
          Done
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-11 rounded bg-[var(--brand-primary)] px-4 text-sm text-[var(--brand-on-primary)]"
      >
        Invite a member of staff
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4"
    >
      <p className="mb-3 font-medium">Invite a member of staff</p>

      {error && (
        <p role="alert" className="mb-3 text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}

      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="nameBn" className="block text-sm font-medium">
              Name (Bangla)
            </label>
            <input
              id="nameBn"
              name="nameBn"
              required
              className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-base"
            />
          </div>
          <div>
            <label htmlFor="nameEn" className="block text-sm font-medium">
              Name (English)
            </label>
            <input
              id="nameEn"
              name="nameEn"
              required
              className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-base"
            />
          </div>
        </div>

        <div>
          <label htmlFor="identifier" className="block text-sm font-medium">
            Mobile or email
          </label>
          <input
            id="identifier"
            name="identifier"
            required
            placeholder="+8801XXXXXXXXX"
            className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-base"
          />
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Becomes their login. No password is ever sent — they set their own
            from the link.
          </p>
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 rounded bg-[var(--brand-primary)] px-4 text-[var(--brand-on-primary)] disabled:opacity-60"
        >
          {busy ? 'Inviting…' : 'Create invite'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="min-h-11 rounded border border-[var(--color-border)] px-4"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
