/**
 * Provision a tenant. §7.4.
 *
 * ONE TRANSACTION. A half-provisioned school is unusable and, worse, hard to
 * detect: a tenant row with no roles looks exactly like a tenant row, and the
 * owner discovers it by logging in and finding they can do nothing.
 *
 * Runs as `sm_platform`, because it writes rows for a tenant that does not
 * exist yet and therefore cannot have a tenant session. That role is the one
 * permitted past RLS, which is why the actor is a `PlatformContext` carrying
 * `platform.tenant.provision` and a mandatory audit reason rather than an
 * ordinary `AuthContext`.
 */

import { withPlatform } from '../../../db/rls';
import { auditAs, recordAuthEvent } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorizePlatform, type PlatformContext } from '../../../shared/auth-context';
import { Ids } from '../../../shared/ids';
import type { AccountId, PersonId, SchoolId, TenantId } from '../../../shared/ids';
import { LocalDate, type Clock, systemClock } from '../../../shared/date';
import {
  DEFAULT_CLASS_LEVELS,
  DEFAULT_SHIFTS,
  defaultAcademicYear,
  isValidSlug,
  type ClassLevelSeed,
  type ShiftSeed,
} from '../domain/provisioning';
import { provisioning } from '../infrastructure/repositories';

export const ProvisionErrors = defineErrors({
  INVALID_SLUG: {
    code: 'INVALID_SLUG',
    messageKey: 'tenant.error.invalidSlug',
    httpStatus: 400,
  },
  SLUG_TAKEN: {
    code: 'SLUG_TAKEN',
    messageKey: 'tenant.error.slugTaken',
    httpStatus: 409,
  },
  PLAN_NOT_FOUND: {
    code: 'PLAN_NOT_FOUND',
    messageKey: 'tenant.error.planNotFound',
    httpStatus: 404,
  },
  INVALID_OWNER_PHONE: {
    code: 'INVALID_OWNER_PHONE',
    messageKey: 'auth.error.invalidIdentifier',
    httpStatus: 400,
  },
});

export interface ProvisionTenantInput {
  /** In every URL the school will ever print, so it is confirmed by a human. */
  slug: string;
  nameBn: string;
  nameEn: string;
  planCode: string;

  /** The first human. Gets the Principal role and can invite everyone else. */
  owner: {
    nameBn: string;
    nameEn: string;
    /** E.164. Becomes their login identifier; they sign in by OTP. */
    phone: string;
    email?: string | undefined;
  };

  /** Government institution id, if the school has one yet. */
  eiin?: string | undefined;
  /** 1 = January (the default), 7 = the government fiscal year. */
  fiscalYearStartMonth?: number | undefined;
  classLevels?: readonly ClassLevelSeed[] | undefined;
  shifts?: readonly ShiftSeed[] | undefined;
}

export interface ProvisionTenantDeps {
  /** Injected so a test can provision deterministically. */
  clock?: Clock;
}

export interface ProvisionTenantResult {
  tenantId: TenantId;
  slug: string;
  schoolId: SchoolId;
  ownerPersonId: PersonId;
  ownerAccountId: AccountId;
  /**
   * True when the owner's phone already had an account — a principal who is
   * also a guardian at another school, or who runs two schools. They keep the
   * login they have; a second account for one human is the bug the identity
   * model exists to prevent (ADR-0006).
   */
  ownerAccountReused: boolean;
  academicYearName: string;
  classLevelCount: number;
  roleCount: number;
}

export async function provisionTenant(
  ctx: PlatformContext,
  input: ProvisionTenantInput,
  deps: ProvisionTenantDeps = {},
): Promise<Result<ProvisionTenantResult, DomainError>> {
  authorizePlatform(ctx, 'platform.tenant.provision');

  if (!isValidSlug(input.slug)) return err(ProvisionErrors.INVALID_SLUG);

  // E.164 only. The owner's number is typed by an operator from a signup form,
  // not normalised by the phone input the guardian app uses.
  const phone = input.owner.phone.trim();
  if (!/^\+8801[3-9]\d{8}$/.test(phone)) return err(ProvisionErrors.INVALID_OWNER_PHONE);

  const today = LocalDate.today(deps.clock ?? systemClock);
  const year = defaultAcademicYear(today);
  const classLevels = input.classLevels ?? DEFAULT_CLASS_LEVELS;
  const shifts = input.shifts ?? DEFAULT_SHIFTS;

  return withPlatform(
    `provision a new tenant: ${ctx.reason}`,
    async (tx): Promise<Result<ProvisionTenantResult, DomainError>> => {
      if (await provisioning.slugExists(tx, input.slug)) {
        return err(ProvisionErrors.SLUG_TAKEN);
      }

      const plan = await provisioning.planByCode(tx, input.planCode);
      if (!plan) return err(ProvisionErrors.PLAN_NOT_FOUND);

      const templates = await provisioning.roleTemplates(tx);
      if (templates.length === 0) {
        /*
         * `pnpm seed` has not run. THROWS rather than returning a DomainError:
         * the taxonomy has no 500 because a DomainError is an expected business
         * outcome, and an unseeded database is a deployment fault. Provisioning
         * a school whose owner would hold no permissions at all is far worse
         * than failing loudly.
         */
        throw new Error(
          'No role templates: run `pnpm seed` before provisioning a tenant.',
        );
      }

      const tenantId = Ids.generate<'tenant'>();
      const organizationId = Ids.generate<'organization'>();
      const schoolId = Ids.generate<'school'>();
      const campusId = Ids.generate<'campus'>();
      const ownerPersonId = Ids.generate<'person'>();

      await provisioning.createTenant(tx, {
        id: tenantId,
        slug: input.slug,
        nameBn: input.nameBn,
        nameEn: input.nameEn,
        planId: plan.id,
      });

      /*
       * The owner's person row comes FIRST: organization.owner_person_id,
       * school.created_by and every other tenant row reference person(id), and
       * the tenant column set defaults created_by from it.
       */
      await provisioning.createPerson(tx, {
        id: ownerPersonId,
        tenantId,
        nameBn: input.owner.nameBn,
        nameEn: input.owner.nameEn,
        phone,
        email: input.owner.email,
      });

      await provisioning.createOrganization(tx, {
        id: organizationId,
        tenantId,
        nameBn: input.nameBn,
        nameEn: input.nameEn,
        ownerPersonId,
      });
      // The tenant → organization link could not be set at insert time: the
      // organization is tenant-owned and so could not exist before the tenant.
      await provisioning.linkOrganization(tx, tenantId, organizationId);

      await provisioning.createSchool(tx, {
        id: schoolId,
        tenantId,
        organizationId,
        nameBn: input.nameBn,
        nameEn: input.nameEn,
        eiin: input.eiin,
        fiscalYearStartMonth: input.fiscalYearStartMonth ?? 1,
        createdBy: ownerPersonId,
      });

      await provisioning.createCampus(tx, {
        id: campusId,
        tenantId,
        schoolId,
        nameBn: input.nameBn,
        nameEn: input.nameEn,
        createdBy: ownerPersonId,
      });

      await provisioning.createShifts(tx, tenantId, campusId, shifts, ownerPersonId);

      await provisioning.createAcademicYear(tx, {
        tenantId,
        schoolId,
        name: year.name,
        startDate: year.startDate,
        endDate: year.endDate,
        createdBy: ownerPersonId,
      });

      await provisioning.createClassLevels(tx, tenantId, schoolId, classLevels, ownerPersonId);

      // role_template → role + role_permission. Copied rather than referenced,
      // so a tenant may edit its own roles (§3.3).
      const roles = await provisioning.copyRoleTemplates(tx, tenantId, templates, ownerPersonId);

      /*
       * Find or create the LOGIN. A principal who is already a guardian at
       * another school keeps the account they have and gains a membership —
       * credential.value is globally unique precisely so this cannot fork into
       * two identities for one human.
       */
      const existing = await provisioning.credentialByPhone(tx, phone);
      const ownerAccountId = existing?.accountId ?? Ids.generate<'account'>();
      if (!existing) {
        await provisioning.createAccount(tx, ownerAccountId, phone);
      }

      const membershipId = Ids.generate<'membership'>();
      await provisioning.createMembership(tx, {
        id: membershipId,
        tenantId,
        accountId: ownerAccountId,
        personId: ownerPersonId,
        createdBy: ownerPersonId,
      });

      const principal = roles.find((r) => r.code === 'Principal') ?? roles[0]!;
      await provisioning.grantRole(tx, {
        tenantId,
        membershipId,
        roleId: principal.id,
        createdBy: ownerPersonId,
      });

      /*
       * The school's own history starts with its creation. This is the first
       * row in its audit_log, and the actor is an OPERATOR — no person in this
       * tenant, so actor_person_id is null and the account identifies them.
       */
      await auditAs(
        tx,
        {
          tenantId,
          actorAccountId: ctx.accountId,
          requestId: ctx.requestId,
        },
        'tenant.provisioned',
        tenantId,
        {
          entityType: 'tenant',
          reason: ctx.reason,
          after: {
            tenantId,
            organizationId,
            schoolId,
            campusId,
            ownerPersonId,
            ownerAccountId,
            ownerAccountReused: existing !== undefined,
            principalRoleId: principal.id,
          },
        },
      );

      // Global, because granting a login is a fact about the ACCOUNT — and for
      // a reused account it is the row showing they now reach a second school.
      await recordAuthEvent(tx, {
        type: 'membership.provisioned',
        outcome: 'success',
        accountId: ownerAccountId,
        identifier: phone,
        requestId: ctx.requestId,
        reason: ctx.reason,
        detail: { tenantId, membershipId, accountReused: existing !== undefined },
      });

      return ok({
        tenantId,
        slug: input.slug,
        schoolId,
        ownerPersonId,
        ownerAccountId,
        ownerAccountReused: existing !== undefined,
        academicYearName: year.name,
        classLevelCount: classLevels.length,
        roleCount: roles.length,
      });
    },
  );
}
