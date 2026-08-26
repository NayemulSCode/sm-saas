/**
 * Provisioning writes. Every one takes an explicit `tenantId`.
 *
 * The tenant column set defaults `tenant_id` to `app.current_tenant_id()`, and
 * there is no tenant session here — provisioning runs on the platform pool
 * because the tenant does not exist yet. Passing it explicitly is not belt and
 * braces; without it the default resolves to nothing and the insert fails.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../../../db/rls';
import { plan, tenant, roleTemplate } from '../../../db/schema/platform';
import { account, credential, membership, membershipRole, role, rolePermission } from '../../../db/schema/identity';
import { person } from '../../../db/schema/directory';
import { academicYear, campus, classLevel, organization, school, shift } from '../../../db/schema/structure';
import { Ids } from '../../../shared/ids';
import type { AccountId, CampusId, MembershipId, OrganizationId, PersonId, PlanId, RoleId, SchoolId, TenantId } from '../../../shared/ids';
import type { LocalDate } from '../../../shared/date';
import { isPermission, type Permission } from '../../../shared/permissions';
import type { ClassLevelSeed, ShiftSeed } from '../domain/provisioning';

export interface CopiedRole {
  id: RoleId;
  code: string;
}

export const provisioning = {
  async slugExists(tx: Tx, slug: string): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(tenant)
      .where(eq(tenant.slug, slug));
    return (row?.n ?? 0) > 0;
  },

  async planByCode(tx: Tx, code: string): Promise<{ id: PlanId } | undefined> {
    const [row] = await tx.select({ id: plan.id }).from(plan).where(eq(plan.code, code)).limit(1);
    return row;
  },

  async roleTemplates(tx: Tx) {
    return tx
      .select({
        code: roleTemplate.code,
        nameBn: roleTemplate.nameBn,
        nameEn: roleTemplate.nameEn,
        permissions: roleTemplate.permissions,
      })
      .from(roleTemplate)
      .orderBy(roleTemplate.sequence);
  },

  async createTenant(
    tx: Tx,
    input: { id: TenantId; slug: string; nameBn: string; nameEn: string; planId: PlanId },
  ): Promise<void> {
    await tx.insert(tenant).values({
      id: input.id,
      slug: input.slug,
      nameBn: input.nameBn,
      nameEn: input.nameEn,
      planId: input.planId,
      // Trial, not active. Billing decides when that changes, not provisioning.
      status: 'trial',
      // Always 'primary' today — the indirection that lets one large tenant
      // move to its own database later (§7.6).
      shardId: 'primary',
    });
  },

  async createPerson(
    tx: Tx,
    input: {
      id: PersonId;
      tenantId: TenantId;
      nameBn: string;
      nameEn: string;
      phone: string;
      email?: string | undefined;
    },
  ): Promise<void> {
    await tx.insert(person).values({
      id: input.id,
      tenantId: input.tenantId,
      // NFC on write, or two visually identical Bangla names will not compare
      // equal (ADR-0019).
      nameBn: input.nameBn.normalize('NFC'),
      nameEn: input.nameEn.normalize('NFC'),
      /* CONTACT detail, deliberately not unique. The login identifier is the
       * separate, globally unique credential.value. */
      phone: input.phone,
      email: input.email ?? null,
      createdBy: input.id,
    });
  },

  async createOrganization(
    tx: Tx,
    input: {
      id: OrganizationId;
      tenantId: TenantId;
      nameBn: string;
      nameEn: string;
      ownerPersonId: PersonId;
    },
  ): Promise<void> {
    await tx.insert(organization).values({
      id: input.id,
      tenantId: input.tenantId,
      nameBn: input.nameBn.normalize('NFC'),
      nameEn: input.nameEn.normalize('NFC'),
      ownerPersonId: input.ownerPersonId,
      createdBy: input.ownerPersonId,
    });
  },

  async linkOrganization(tx: Tx, tenantId: TenantId, organizationId: OrganizationId): Promise<void> {
    await tx.update(tenant).set({ organizationId }).where(eq(tenant.id, tenantId));
  },

  async createSchool(
    tx: Tx,
    input: {
      id: SchoolId;
      tenantId: TenantId;
      organizationId: OrganizationId;
      nameBn: string;
      nameEn: string;
      eiin?: string | undefined;
      fiscalYearStartMonth: number;
      createdBy: PersonId;
    },
  ): Promise<void> {
    await tx.insert(school).values({
      id: input.id,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      nameBn: input.nameBn.normalize('NFC'),
      nameEn: input.nameEn.normalize('NFC'),
      eiin: input.eiin ?? null,
      fiscalYearStartMonth: input.fiscalYearStartMonth,
      createdBy: input.createdBy,
    });
  },

  async createCampus(
    tx: Tx,
    input: {
      id: CampusId;
      tenantId: TenantId;
      schoolId: SchoolId;
      nameBn: string;
      nameEn: string;
      createdBy: PersonId;
    },
  ): Promise<void> {
    await tx.insert(campus).values({
      id: input.id,
      tenantId: input.tenantId,
      schoolId: input.schoolId,
      nameBn: input.nameBn.normalize('NFC'),
      nameEn: input.nameEn.normalize('NFC'),
      // The single-campus school is the common case, and "the campus" must be
      // unambiguous for every module that resolves one.
      isPrimary: true,
      createdBy: input.createdBy,
    });
  },

  async createShifts(
    tx: Tx,
    tenantId: TenantId,
    campusId: CampusId,
    shifts: readonly ShiftSeed[],
    createdBy: PersonId,
  ): Promise<void> {
    if (shifts.length === 0) return;
    await tx.insert(shift).values(
      shifts.map((s) => ({
        id: Ids.generate<'shift'>(),
        tenantId,
        campusId,
        nameBn: s.nameBn.normalize('NFC'),
        nameEn: s.nameEn,
        startTime: s.startTime,
        endTime: s.endTime,
        sequence: s.sequence,
        createdBy,
      })),
    );
  },

  async createAcademicYear(
    tx: Tx,
    input: {
      tenantId: TenantId;
      schoolId: SchoolId;
      name: string;
      startDate: LocalDate;
      endDate: LocalDate;
      createdBy: PersonId;
    },
  ): Promise<void> {
    await tx.insert(academicYear).values({
      id: Ids.generate<'academicYear'>(),
      tenantId: input.tenantId,
      schoolId: input.schoolId,
      name: input.name,
      startDate: input.startDate,
      endDate: input.endDate,
      // The school needs a year it can enrol into today, not a plan.
      isCurrent: true,
      status: 'active',
      createdBy: input.createdBy,
    });
  },

  async createClassLevels(
    tx: Tx,
    tenantId: TenantId,
    schoolId: SchoolId,
    levels: readonly ClassLevelSeed[],
    createdBy: PersonId,
  ): Promise<void> {
    if (levels.length === 0) return;
    await tx.insert(classLevel).values(
      levels.map((c) => ({
        id: Ids.generate<'classLevel'>(),
        tenantId,
        schoolId,
        nameBn: c.nameBn.normalize('NFC'),
        nameEn: c.nameEn,
        sequence: c.sequence,
        loginEnabled: c.loginEnabled,
        createdBy,
      })),
    );
  },

  /**
   * role_template → role + role_permission.
   *
   * Copied, not referenced: a tenant may edit its own roles, and a template
   * shared by reference would let one edit change every school (§3.3).
   */
  async copyRoleTemplates(
    tx: Tx,
    tenantId: TenantId,
    templates: ReadonlyArray<{
      code: string;
      nameBn: string;
      nameEn: string;
      permissions: string[];
    }>,
    createdBy: PersonId,
  ): Promise<CopiedRole[]> {
    const copied: CopiedRole[] = [];

    for (const t of templates) {
      const id = Ids.generate<'role'>();
      await tx.insert(role).values({
        id,
        tenantId,
        code: t.code,
        nameBn: t.nameBn.normalize('NFC'),
        nameEn: t.nameEn,
        // Seeded roles cannot be deleted; a tenant may still edit them.
        isSystem: true,
        createdBy,
      });

      /* Unknown keys are dropped rather than inserted. role_permission has a
       * foreign key to permission(key), so a stale template entry would abort
       * the whole provisioning transaction — one bad row in reference data
       * must not stop a school being created. */
      const grants = t.permissions.filter((p): p is Permission => isPermission(p));
      if (grants.length > 0) {
        await tx.insert(rolePermission).values(
          grants.map((permissionKey) => ({
            id: Ids.generate<'rolePermission'>(),
            tenantId,
            roleId: id,
            permissionKey,
            createdBy,
          })),
        );
      }

      copied.push({ id, code: t.code });
    }

    return copied;
  },

  async credentialByPhone(
    tx: Tx,
    value: string,
  ): Promise<{ accountId: AccountId } | undefined> {
    const [row] = await tx
      .select({ accountId: credential.accountId })
      .from(credential)
      .where(and(eq(credential.kind, 'phone'), eq(credential.value, value)))
      .limit(1);
    return row;
  },

  async createAccount(tx: Tx, accountId: AccountId, phone: string): Promise<void> {
    await tx.insert(account).values({ id: accountId, status: 'active', locale: 'bn' });
    await tx.insert(credential).values({
      id: Ids.generate<'credential'>(),
      accountId,
      kind: 'phone',
      value: phone,
      /* No password. The owner signs in by OTP on first use — there is nobody
       * to invite the first user, and §7.4 sends them an OTP link rather than
       * transmitting a password. They may set one afterwards. */
      isPrimary: true,
    });
  },

  async createMembership(
    tx: Tx,
    input: {
      id: MembershipId;
      tenantId: TenantId;
      accountId: AccountId;
      personId: PersonId;
      createdBy: PersonId;
    },
  ): Promise<void> {
    await tx.insert(membership).values({
      id: input.id,
      tenantId: input.tenantId,
      accountId: input.accountId,
      personId: input.personId,
      status: 'active',
      createdBy: input.createdBy,
    });
  },

  async grantRole(
    tx: Tx,
    input: { tenantId: TenantId; membershipId: MembershipId; roleId: RoleId; createdBy: PersonId },
  ): Promise<void> {
    await tx.insert(membershipRole).values({
      id: Ids.generate<'membershipRole'>(),
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      roleId: input.roleId,
      // Unrestricted within the tenant: the owner is not scoped to a campus.
      scope: {},
      createdBy: input.createdBy,
    });
  },
};
