/**
 * Granting roles, end to end.
 *
 * The school is built by `provisionTenant` rather than by hand-written SQL.
 * Hand-built tenants are how the missing `permission` seed stayed invisible for
 * four increments; a test that provisions the way production does cannot drift
 * from it.
 *
 * The tests that matter are the two escalation guards, and the pair that proves
 * a grant actually changes what someone can do: grant → log in → the permission
 * is there; revoke → log in → it is gone.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { provisionTenant } from '../../platform/index';
import { grantRole, revokeRole, listRoles, GrantErrors } from './grantRole';
import { inviteStaff } from './inviteStaff';
import { requestOtp } from './requestOtp';
import { verifyOtp } from './verifyOtp';
import { resolveAuthContext } from './resolveAuthContext';
import { codeHasher, randomSource, tokenGenerator } from '../infrastructure/crypto';
import { Ids } from '../../../shared/ids';
import type { AuthContext, PlatformContext } from '../../../shared/auth-context';
import type { MembershipId, RoleId } from '../../../shared/ids';
import { PERMISSIONS } from '../../../shared/permissions';

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR;
const PLATFORM_URL = process.env.DATABASE_URL_PLATFORM;

const nid = <T extends string = 'x'>() => Ids.generate<T>();
const uuid = (v: string) => Ids.toUuid(v as never);

const STAMP = Date.now();
const PLAN_CODE = `grant-${STAMP}`;
const OWNER_PHONE = '+8801744000111';
const CLERK_PHONE = '+8801744000222';
const TEACHER_PHONE = '+8801744000333';

let admin: Pool;
let operator: PlatformContext;
const OPERATOR_ACCOUNT = nid<'account'>();

let tenantId: string;
/** The Principal, resolved from a real session. */
let principal: AuthContext;
/** Holds role.manage and little else — the escalation case. */
let clerk: AuthContext;
let teacherMembershipId: MembershipId;
let clerkMembershipId: MembershipId;

/** Roles copied into the tenant by provisioning. */
let roleByCode: Map<string, RoleId>;

async function login(phone: string): Promise<AuthContext> {
  await admin.query(
    `DELETE FROM otp_challenge WHERE credential_id IN
       (SELECT id FROM credential WHERE value = $1)`,
    [phone],
  );

  let code: string | undefined;
  await requestOtp(
    { identifier: phone },
    { codeHasher, random: randomSource, dispatcher: { send: async (_to, c) => void (code = c) } },
  );
  if (!code) throw new Error(`no OTP dispatched for ${phone}`);

  const session = await verifyOtp({ identifier: phone, code }, { codeHasher, tokens: tokenGenerator });
  if (!session.ok) throw new Error(`login failed for ${phone}: ${JSON.stringify(session)}`);

  const ctx = await resolveAuthContext(session.value.sessionToken, { tokens: tokenGenerator });
  if (!ctx.ok) throw new Error(`context failed for ${phone}: ${JSON.stringify(ctx)}`);
  return ctx.value;
}

beforeAll(async () => {
  if (!ADMIN_URL || !PLATFORM_URL) {
    throw new Error('Integration tests need DATABASE_URL_MIGRATOR and DATABASE_URL_PLATFORM.');
  }
  vi.stubEnv('APP_URL', 'http://localhost:3000');
  vi.stubEnv('PLATFORM_HOST', 'admin.localhost');
  vi.stubEnv('SESSION_SECRET', 'x'.repeat(32));
  vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64));
  vi.stubEnv('TZ', 'Asia/Dhaka');

  admin = new Pool({ connectionString: ADMIN_URL, max: 4 });

  await admin.query(
    `INSERT INTO plan (id, code, name_bn, name_en, price_minor, billing_period)
     VALUES ($1,$2,'পরীক্ষা','Test',0,'monthly') ON CONFLICT DO NOTHING`,
    [uuid(nid()), PLAN_CODE],
  );
  await admin.query(
    `INSERT INTO account (id, status, locale) VALUES ($1,'active','en') ON CONFLICT DO NOTHING`,
    [uuid(OPERATOR_ACCOUNT)],
  );

  operator = {
    accountId: OPERATOR_ACCOUNT,
    permissions: new Set(PERMISSIONS),
    requestId: 'grant-int',
    reason: 'provisioning a school for the grantRole integration suite',
  };

  const provisioned = await provisionTenant(operator, {
    slug: `grant-${STAMP}`,
    nameBn: 'গ্রান্ট বিদ্যালয়',
    nameEn: 'Grant School',
    planCode: PLAN_CODE,
    owner: { nameBn: 'নাসরিন আক্তার', nameEn: 'Nasrin Akter', phone: OWNER_PHONE },
  });
  if (!provisioned.ok) throw new Error(`provisioning failed: ${JSON.stringify(provisioned)}`);
  tenantId = provisioned.value.tenantId;

  principal = await login(OWNER_PHONE);

  const { rows } = await admin.query<{ id: string; code: string }>(
    'SELECT id, code FROM role WHERE tenant_id = $1',
    [uuid(tenantId)],
  );
  roleByCode = new Map(rows.map((r) => [r.code, Ids.fromUuid<'role'>(r.id)]));

  // Two more staff, created the way a principal actually creates them.
  const mkStaff = async (phone: string, nameEn: string): Promise<MembershipId> => {
    const personId = Ids.generate<'person'>();
    await admin.query(
      `INSERT INTO person (id, tenant_id, name_bn, name_en) VALUES ($1,$2,'কর্মী',$3)`,
      [uuid(personId), uuid(tenantId), nameEn],
    );
    const invited = await inviteStaff(
      principal,
      { personId, identifier: phone, roleIds: [] as RoleId[] },
      { tokens: tokenGenerator },
    );
    if (!invited.ok) throw new Error(`invite failed: ${JSON.stringify(invited)}`);
    // Phone credentials log in by OTP, so no invite acceptance is needed.
    await admin.query(`UPDATE credential SET verified_at = now() WHERE value = $1`, [phone]);
    return invited.value.membershipId;
  };

  clerkMembershipId = await mkStaff(CLERK_PHONE, 'Clerk');
  teacherMembershipId = await mkStaff(TEACHER_PHONE, 'Teacher');
}, 180_000);

afterAll(async () => {
  const { closeAllPools } = await import('../../../db/index');
  await closeAllPools();
  await admin?.end();
});

const auditRows = async (action: string, membershipId: string) => {
  const { rows } = await admin.query<{
    action: string;
    reason: string;
    after: Record<string, unknown>;
    actor_person_id: string;
  }>(
    `SELECT action, reason, after, actor_person_id FROM audit_log
     WHERE tenant_id = $1 AND action = $2 AND entity_id = $3 ORDER BY at DESC`,
    [uuid(tenantId), action, uuid(membershipId)],
  );
  return rows;
};

describe('granting a role', () => {
  it('lists the roles provisioning copied in, with what each confers', async () => {
    const r = await listRoles(principal);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.length).toBeGreaterThan(0);
    const p = r.value.find((x) => x.code === 'Principal');
    expect(p?.permissions).toContain('membership.manage');
  }, 60_000);

  it('grants, audits with the reason, and the teacher gains the permission', async () => {
    const roleId = roleByCode.get('ClassTeacher')!;
    const reason = 'assigned to class 6A for the 2027 year';

    const granted = await grantRole(principal, {
      membershipId: teacherMembershipId,
      roleId,
      reason,
    });
    expect(granted.ok, JSON.stringify(granted)).toBe(true);

    const rows = await auditRows('role.granted', teacherMembershipId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe(reason);
    expect(rows[0]?.actor_person_id).toBe(uuid(principal.personId));
    expect(rows[0]?.after?.['roleCode']).toBe('ClassTeacher');

    /*
     * The proof. Not "a row was written" — the teacher logs in and the
     * permission is actually in the context that authorize() reads.
     */
    const teacher = await login(TEACHER_PHONE);
    expect(teacher.permissions.has('student.read')).toBe(true);
    expect(teacher.permissions.has('guardian.read')).toBe(true);
    // A class teacher is nowhere near the cash box.
    expect(teacher.permissions.has('fee.collect')).toBe(false);
    expect(teacher.permissions.has('role.manage')).toBe(false);
  }, 120_000);

  it('refuses to grant the same role twice', async () => {
    const r = await grantRole(principal, {
      membershipId: teacherMembershipId,
      roleId: roleByCode.get('ClassTeacher')!,
      reason: 'trying again by mistake',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(GrantErrors.ALREADY_GRANTED.code);
  }, 60_000);

  it('carries a scope through to the context', async () => {
    const section = Ids.generate<'section'>();
    const granted = await grantRole(principal, {
      membershipId: teacherMembershipId,
      roleId: roleByCode.get('SubjectTeacher')!,
      scope: { sectionIds: [section] },
      reason: 'teaches maths in one section only',
    });
    expect(granted.ok, JSON.stringify(granted)).toBe(true);

    const teacher = await login(TEACHER_PHONE);
    // ClassTeacher is unrestricted and SubjectTeacher is scoped; the union of
    // an unrestricted role with a scoped one is unrestricted (§9.3).
    expect(teacher.scope.sectionIds).toBeUndefined();
  }, 120_000);
});

describe('nobody grants beyond what they hold', () => {
  it('lets the principal give a clerk role.manage', async () => {
    // A bespoke role: role.manage plus almost nothing, which is the shape that
    // makes the subset rule matter.
    const roleId = Ids.generate<'role'>();
    await admin.query(
      `INSERT INTO role (id, tenant_id, code, name_bn, name_en, is_system)
       VALUES ($1,$2,'Registrar','রেজিস্ট্রার','Registrar',false)`,
      [uuid(roleId), uuid(tenantId)],
    );
    for (const key of ['role.manage', 'student.read']) {
      await admin.query(
        `INSERT INTO role_permission (id, tenant_id, role_id, permission_key)
         VALUES ($1,$2,$3,$4)`,
        [uuid(nid()), uuid(tenantId), uuid(roleId), key],
      );
    }
    roleByCode.set('Registrar', roleId);

    const r = await grantRole(principal, {
      membershipId: clerkMembershipId,
      roleId,
      reason: 'handles staff records',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    clerk = await login(CLERK_PHONE);
    expect(clerk.permissions.has('role.manage')).toBe(true);
    expect(clerk.permissions.has('membership.manage')).toBe(false);
  }, 120_000);

  /*
   * The escalation the rule exists for. The clerk legitimately holds
   * role.manage — they are supposed to assign roles — and tries to hand out
   * one that confers far more than they have.
   */
  it('refuses the clerk granting Principal, and names what was missing', async () => {
    const r = await grantRole(clerk, {
      membershipId: teacherMembershipId,
      roleId: roleByCode.get('Principal')!,
      reason: 'a favour for a colleague',
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(GrantErrors.CANNOT_GRANT_BEYOND_OWN.code);

    // The ATTEMPT is the signal. A blocked escalation that leaves no trace
    // teaches nobody anything.
    const rows = await auditRows('role.grant_refused', teacherMembershipId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.after?.['refusedBecause']).toBe('beyond_own');
    expect(String(rows[0]?.after?.['excess'])).toContain('membership.manage');
    expect(rows[0]?.reason).toBe('a favour for a colleague');

    // And nothing was granted.
    const teacher = await login(TEACHER_PHONE);
    expect(teacher.permissions.has('membership.manage')).toBe(false);
  }, 120_000);

  it('still lets the clerk grant what they do hold', async () => {
    const roleId = Ids.generate<'role'>();
    await admin.query(
      `INSERT INTO role (id, tenant_id, code, name_bn, name_en, is_system)
       VALUES ($1,$2,'Reader','পাঠক','Reader',false)`,
      [uuid(roleId), uuid(tenantId)],
    );
    await admin.query(
      `INSERT INTO role_permission (id, tenant_id, role_id, permission_key)
       VALUES ($1,$2,$3,'student.read')`,
      [uuid(nid()), uuid(tenantId), uuid(roleId)],
    );

    const r = await grantRole(clerk, {
      membershipId: teacherMembershipId,
      roleId,
      reason: 'needs to see the class list',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }, 60_000);
});

describe('nobody edits their own access', () => {
  /*
   * The principal holds every permission, so the subset rule passes trivially.
   * Only the self-grant rule stops them, which is why it is checked first.
   */
  it('refuses the principal granting themselves a role', async () => {
    const r = await grantRole(principal, {
      membershipId: principal.membershipId,
      roleId: roleByCode.get('Accountant')!,
      reason: 'wants to handle the money too',
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(GrantErrors.SELF_GRANT_BLOCKED.code);

    const rows = await auditRows('role.grant_refused', principal.membershipId);
    expect(rows[0]?.after?.['refusedBecause']).toBe('self_grant');
  }, 60_000);

  // Locking yourself out of a one-administrator school is unrecoverable.
  it('refuses self-revocation for the same reason', async () => {
    const r = await revokeRole(principal, {
      membershipId: principal.membershipId,
      roleId: roleByCode.get('Principal')!,
      reason: 'stepping back from admin duties',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(GrantErrors.SELF_GRANT_BLOCKED.code);

    // And they still hold it.
    const stillPrincipal = await login(OWNER_PHONE);
    expect(stillPrincipal.permissions.has('role.manage')).toBe(true);
  }, 120_000);
});

describe('revoking', () => {
  it('takes the permission away, and the next login proves it', async () => {
    const before = await login(TEACHER_PHONE);
    expect(before.permissions.has('guardian.read')).toBe(true);

    const r = await revokeRole(principal, {
      membershipId: teacherMembershipId,
      roleId: roleByCode.get('ClassTeacher')!,
      reason: 'no longer a class teacher this year',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const after = await login(TEACHER_PHONE);
    expect(after.permissions.has('guardian.read')).toBe(false);
    // The Reader role granted earlier survives, so this removed one role and
    // not the membership.
    expect(after.permissions.has('student.read')).toBe(true);

    const rows = await auditRows('role.revoked', teacherMembershipId);
    expect(rows[0]?.reason).toBe('no longer a class teacher this year');
  }, 120_000);

  it('soft-deletes, so the record that the role was once held survives', async () => {
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text n FROM membership_role
       WHERE tenant_id=$1 AND membership_id=$2 AND role_id=$3 AND deleted_at IS NOT NULL`,
      [uuid(tenantId), uuid(teacherMembershipId), uuid(roleByCode.get('ClassTeacher')!)],
    );
    expect(rows[0]?.n).toBe('1');
  }, 30_000);

  it('refuses to revoke a role that was never granted', async () => {
    const r = await revokeRole(principal, {
      membershipId: teacherMembershipId,
      roleId: roleByCode.get('Accountant')!,
      reason: 'was not there in the first place',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(GrantErrors.NOT_GRANTED.code);
  }, 60_000);
});

describe('refusals', () => {
  it('refuses an actor without role.manage', async () => {
    const teacher = await login(TEACHER_PHONE);
    await expect(
      grantRole(teacher, {
        membershipId: clerkMembershipId,
        roleId: roleByCode.get('Librarian')!,
        reason: 'should never happen',
      }),
    ).rejects.toThrow(/role.manage/);
  }, 60_000);

  it('reads a role from another tenant as not found, not as a refusal', async () => {
    // A real role id, in a school this principal has nothing to do with.
    const other = await provisionTenant(operator, {
      slug: `other-${STAMP}`,
      nameBn: 'অন্য বিদ্যালয়',
      nameEn: 'Other School',
      planCode: PLAN_CODE,
      owner: { nameBn: 'অন্য', nameEn: 'Other', phone: '+8801744000999' },
    });
    expect(other.ok).toBe(true);
    if (!other.ok) return;

    const { rows } = await admin.query<{ id: string }>(
      `SELECT id FROM role WHERE tenant_id=$1 AND code='Principal'`,
      [uuid(other.value.tenantId)],
    );
    const foreignRole = Ids.fromUuid<'role'>(rows[0]!.id);

    const r = await grantRole(principal, {
      membershipId: teacherMembershipId,
      roleId: foreignRole,
      reason: 'reaching into another school',
    });
    expect(r.ok).toBe(false);
    // RLS makes it invisible, so it is absent rather than forbidden.
    if (!r.ok) expect(r.error.code).toBe(GrantErrors.ROLE_NOT_FOUND.code);
  }, 120_000);

  it('refuses an unknown membership', async () => {
    const r = await grantRole(principal, {
      membershipId: nid<'membership'>() as MembershipId,
      roleId: roleByCode.get('Librarian')!,
      reason: 'no such person',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(GrantErrors.MEMBERSHIP_NOT_FOUND.code);
  }, 60_000);

  // audit() refuses the action outright, so the DTO is not the only guard.
  it('refuses a grant recorded without a reason', async () => {
    await expect(
      grantRole(principal, {
        membershipId: clerkMembershipId,
        roleId: roleByCode.get('Librarian')!,
        reason: '   ',
      }),
    ).rejects.toThrow(/may not be recorded without a reason/);
  }, 60_000);
});
