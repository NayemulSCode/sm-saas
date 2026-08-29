import type { NextRequest } from 'next/server';
import {
  inviteStaff,
  InviteStaffSchema,
  tokenGenerator,
} from '../../../../../modules/identity/index';
import type { PersonId, RoleId } from '../../../../../shared/ids';
import { fail, failValidation, newRequestId, ok } from '../../../_lib/http';
import { requireAuth, toAuthFailure } from '../../../_lib/auth';

export const runtime = 'nodejs';

/**
 * POST /api/v1/staff/invites
 *
 * Authenticated and tenant-scoped: an existing member of a school grants
 * access to it. Requires `membership.manage`.
 *
 * The invite token is returned ONCE, in this response, and never stored in
 * plaintext. The caller puts it in the link.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const requestId = newRequestId();

  const auth = await requireAuth(requestId);
  if (!auth.ok) return auth.response;

  const parsed = InviteStaffSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return failValidation(parsed.error.issues, requestId);

  try {
    const result = await inviteStaff(
      auth.ctx,
      {
        ...(parsed.data.personId !== undefined
          ? { personId: parsed.data.personId as PersonId }
          : {}),
        ...(parsed.data.person !== undefined ? { person: parsed.data.person } : {}),
        identifier: parsed.data.identifier,
        roleIds: parsed.data.roleIds as RoleId[],
      },
      { tokens: tokenGenerator },
    );
    if (!result.ok) return fail(result.error, requestId);

    return ok(
      {
        membershipId: result.value.membershipId,
        // null when the invitee already had a password: they were granted a
        // second school and sign in normally, so there is no link to leak.
        inviteToken: result.value.inviteToken,
        expiresAt: result.value.expiresAt,
      },
      { requestId },
      { status: 201 },
    );
  } catch (e) {
    const denied = toAuthFailure(e, requestId);
    if (denied) return denied;
    throw e;
  }
}
