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
import { Badge, Button, Card, CardContent } from '../../../../../../../components/ui';
import { FormField } from '../../../../../../../components/patterns';

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
          <Badge key={r.id} tone="brand" className="gap-1">
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
          </Badge>
        ))}
      </div>

      {canManage && !isSelf && (
        <div className="mt-2 flex flex-wrap gap-1">
          {allRoles
            .filter((r) => !held.has(r.id))
            .map((r) => {
              const allowed = grantable(r);
              return (
                <Button
                  key={r.id}
                  variant="secondary"
                  size="sm"
                  disabled={busy || !allowed}
                  onClick={() => void grant(r.id)}
                  title={
                    allowed
                      ? `Grant ${r.code}`
                      : `${r.code} confers permissions you do not hold`
                  }
                  className="min-h-0 py-0.5 text-xs"
                >
                  + {r.code}
                </Button>
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
      <Card>
        <CardContent className="pt-5">
          <p className="font-medium text-[var(--color-text)]">Invite created</p>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Send them this link. It works once, and it is shown only now — it is
            never stored in a form anybody can read back.
          </p>
          <code className="mt-2 block break-all rounded-[var(--radius-sm)] bg-[var(--color-surface-sunken)] p-2 text-xs">
            {`${window.location.origin}/app/invite/accept?token=${link}`}
          </code>
          <Button variant="secondary" onClick={() => window.location.reload()} className="mt-3">
            Done
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!open) {
    return <Button onClick={() => setOpen(true)}>Invite a member of staff</Button>;
  }

  return (
    <Card>
      <CardContent className="pt-5">
        <form onSubmit={(e) => void submit(e)}>
          <p className="mb-3 font-medium text-[var(--color-text)]">Invite a member of staff</p>

          {error && (
            <p role="alert" className="mb-3 text-sm text-[var(--color-danger)]">
              {error}
            </p>
          )}

          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField name="nameBn" label="Name (Bangla)" required />
              <FormField name="nameEn" label="Name (English)" required />
            </div>

            <FormField
              name="identifier"
              label="Mobile or email"
              required
              placeholder="+8801XXXXXXXXX"
              hint="Becomes their login. No password is ever sent — they set their own from the link."
            />
          </div>

          <div className="mt-4 flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? 'Inviting…' : 'Create invite'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
