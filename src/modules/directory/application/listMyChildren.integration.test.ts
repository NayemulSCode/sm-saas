/**
 * The read the guardian surface is built on, and the isolation it exists to
 * guarantee.
 *
 * The scenario that matters is the ordinary one: two unrelated families at the
 * same school, each with their own child. Guardian A must never see Guardian
 * B's son or daughter — not a redacted version, not a count, nothing. And a
 * PROMOTED child must appear exactly once, with the newer class and section,
 * even though promotion leaves the old enrolment row live (§14.5 — undo has to
 * find exactly what it created, so the source year is never touched).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { provisionTenant } from '../../platform/index';
import { createSection, getStructure } from '../../structure/index';
import { requestOtp, verifyOtp, resolveAuthContext } from '../../identity/index';
import { codeHasher, randomSource, tokenGenerator } from '../../identity/infrastructure/crypto';
import { admitStudent, linkGuardian, promoteSection, listMyChildren } from '../index';
import { Ids } from '../../../shared/ids';
import type { AuthContext, PlatformContext } from '../../../shared/auth-context';
import type {
  AcademicYearId,
  CampusId,
  ClassLevelId,
  PersonId,
  SchoolId,
  SectionId,
  ShiftId,
} from '../../../shared/ids';
import { PERMISSIONS } from '../../../shared/permissions';

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR;
const PLATFORM_URL = process.env.DATABASE_URL_PLATFORM;

const nid = <T extends string = 'x'>() => Ids.generate<T>();
const uuid = (v: string) => Ids.toUuid(v as never);

const STAMP = Date.now();
const PLAN_CODE = `mychild-${STAMP}`;
/*
 * Per-run natural keys, same reason as every other integration suite: run two
 * would otherwise silently skip an `ON CONFLICT DO NOTHING` insert and hand
 * the freshly generated id nothing to point at.
 */
const phone = (code: string): string => `+8801${code}${String(STAMP).slice(-6)}`;
const OWNER_PHONE = phone('550');

let admin: Pool;
let principal: AuthContext;
let tenantId: string;
let schoolId: SchoolId;
let year2027: AcademicYearId;
let year2028: AcademicYearId;
let class6: SectionId;
let class7: SectionId;

const clock = { now: () => new Date('2027-03-14T06:00:00.000Z') };

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
  if (!code) throw new Error(`no OTP for ${phone}`);
  const s = await verifyOtp({ identifier: phone, code }, { codeHasher, tokens: tokenGenerator });
  if (!s.ok) throw new Error(`login failed: ${JSON.stringify(s)}`);
  const ctx = await resolveAuthContext(s.value.sessionToken, { tokens: tokenGenerator });
  if (!ctx.ok) throw new Error(`context failed: ${JSON.stringify(ctx)}`);
  return ctx.value;
}

/** A guardian is a person first; `directory` does not invent them. */
async function makePerson(nameEn: string): Promise<PersonId> {
  const id = nid<'person'>();
  await admin.query(
    `INSERT INTO person (id, tenant_id, name_bn, name_en) VALUES ($1,$2,'অভিভাবক',$3)`,
    [uuid(id), uuid(tenantId), nameEn],
  );
  return id;
}

/**
 * A membership with the given role codes, and NO real login — the point of
 * this suite is what `listMyChildren` returns for a given identity, not how
 * that identity signs in. The HTTP suite proves the login/redirect path;
 * spreading `principal` keeps every field this test does not care about
 * (tenantIds, locale, requestId…) realistic without restating it.
 */
function asHousehold(personId: PersonId): AuthContext {
  return {
    ...principal,
    personId,
    membershipId: nid(),
    permissions: new Set(['student.read']),
    scope: {},
    roleCodes: ['Guardian'],
  };
}

const admit = async (nameEn: string, section: SectionId, year: AcademicYearId, rollNo: number) => {
  const r = await admitStudent(
    principal,
    { schoolId, sectionId: section, academicYearId: year, nameBn: 'শিক্ষার্থী', nameEn, rollNo },
    { clock },
  );
  if (!r.ok) throw new Error(`admission failed: ${JSON.stringify(r)}`);
  return r.value;
};

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

  const operatorAccount = nid<'account'>();
  await admin.query(
    `INSERT INTO plan (id, code, name_bn, name_en, price_minor, billing_period)
     VALUES ($1,$2,'পরীক্ষা','Test',0,'monthly') ON CONFLICT DO NOTHING`,
    [uuid(nid()), PLAN_CODE],
  );
  await admin.query(
    `INSERT INTO account (id, status, locale) VALUES ($1,'active','en') ON CONFLICT DO NOTHING`,
    [uuid(operatorAccount)],
  );

  const operator: PlatformContext = {
    accountId: operatorAccount,
    permissions: new Set(PERMISSIONS),
    requestId: 'mychild-int',
    reason: 'provisioning a school for the guardian-scoping suite',
  };

  const p = await provisionTenant(
    operator,
    {
      slug: `mychild-${STAMP}`,
      nameBn: 'অভিভাবক বিদ্যালয়',
      nameEn: 'Guardian School',
      planCode: PLAN_CODE,
      owner: { nameBn: 'নাসিমা বেগম', nameEn: 'Nasima Begum', phone: OWNER_PHONE },
    },
    { clock },
  );
  if (!p.ok) throw new Error(`provisioning failed: ${JSON.stringify(p)}`);
  tenantId = p.value.tenantId;
  schoolId = p.value.schoolId;

  principal = await login(OWNER_PHONE);

  const structure = await getStructure(principal);
  if (!structure.ok) throw new Error('structure read failed');
  year2027 = structure.value.currentYear!.id as AcademicYearId;
  const campusId = structure.value.campuses[0]!.id as CampusId;
  const shiftId = structure.value.shifts[0]!.id as ShiftId;

  const mkSection = async (levelName: string): Promise<SectionId> => {
    const level = structure.value.classLevels.find((l) => l.nameEn === levelName)!;
    const r = await createSection(principal, {
      schoolId,
      classLevelId: level.id as ClassLevelId,
      campusId,
      shiftId,
      nameBn: 'ক',
      nameEn: 'A',
    });
    if (!r.ok) throw new Error(`section failed: ${JSON.stringify(r)}`);
    return r.value.sectionId;
  };
  class6 = await mkSection('Class 6');
  class7 = await mkSection('Class 7');

  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO academic_year
       (id, tenant_id, school_id, name, start_date, end_date, is_current, status)
     VALUES ($1,$2,$3,'2028','2028-01-01','2028-12-31',false,'planning') RETURNING id`,
    [uuid(nid()), uuid(tenantId), uuid(schoolId)],
  );
  year2028 = Ids.fromUuid<'academicYear'>(rows[0]!.id);
}, 180_000);

afterAll(async () => {
  const { closeAllPools } = await import('../../../db/index');
  await closeAllPools();
  await admin?.end();
});

describe('a guardian sees only their own child', () => {
  it('never sees a child linked to a different guardian', async () => {
    const guardianA = await makePerson('Guardian A');
    const guardianB = await makePerson('Guardian B');

    const childA = await admit('Child of A', class6, year2027, 11);
    const childB = await admit('Child of B', class6, year2027, 12);

    const linkA = await linkGuardian(principal, {
      studentId: childA.studentId,
      guardianPersonId: guardianA,
      relationship: 'mother',
      isBillingGuardian: true,
      isPrimaryContact: true,
    });
    expect(linkA.ok, JSON.stringify(linkA)).toBe(true);

    const linkB = await linkGuardian(principal, {
      studentId: childB.studentId,
      guardianPersonId: guardianB,
      relationship: 'father',
      isBillingGuardian: false,
      isPrimaryContact: false,
    });
    expect(linkB.ok, JSON.stringify(linkB)).toBe(true);

    const resultA = await listMyChildren(asHousehold(guardianA));
    expect(resultA.ok, JSON.stringify(resultA)).toBe(true);
    if (!resultA.ok) return;
    expect(resultA.value.map((c) => c.studentId)).toEqual([childA.studentId]);
    // Not a redacted or partial row for B's child — genuinely absent.
    expect(resultA.value.some((c) => c.studentId === childB.studentId)).toBe(false);

    const resultB = await listMyChildren(asHousehold(guardianB));
    expect(resultB.ok).toBe(true);
    if (!resultB.ok) return;
    expect(resultB.value.map((c) => c.studentId)).toEqual([childB.studentId]);

    // The relationship and flags round-trip exactly, per guardian.
    expect(resultA.value[0]).toMatchObject({
      relationship: 'mother',
      isBillingGuardian: true,
      isPrimaryContact: true,
    });
    expect(resultB.value[0]).toMatchObject({
      relationship: 'father',
      isBillingGuardian: false,
      isPrimaryContact: false,
    });
  }, 60_000);

  it('answers with an empty list for a guardian linked to nobody', async () => {
    const unlinked = await makePerson('Unlinked Guardian');
    const result = await listMyChildren(asHousehold(unlinked));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(0);
  }, 30_000);

  it('shows a promoted child once, with the NEWER class — not twice', async () => {
    /*
     * Promotion creates a new enrolment in the target year and does not touch
     * the one it promoted from (undo has to find exactly what it created), so
     * after this the child carries a LIVE enrolment row in both 2027 and 2028.
     * An unqualified join would return the child twice.
     */
    const guardian = await makePerson('Promoted Child Guardian');
    const child = await admit('Promoted Child', class6, year2027, 30);

    const linked = await linkGuardian(principal, {
      studentId: child.studentId,
      guardianPersonId: guardian,
      relationship: 'guardian',
      isBillingGuardian: true,
      isPrimaryContact: true,
    });
    expect(linked.ok, JSON.stringify(linked)).toBe(true);

    const promoted = await promoteSection(
      principal,
      {
        sourceSectionId: class6,
        fromYearId: year2027,
        toYearId: year2028,
        targetSectionId: class7,
        defaultOutcome: 'promoted',
        exceptions: {},
        reason: 'promoting the guardian-scoping cohort',
      },
      { clock },
    );
    expect(promoted.ok, JSON.stringify(promoted)).toBe(true);

    const result = await listMyChildren(asHousehold(guardian));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = result.value.filter((c) => c.studentId === child.studentId);
    expect(rows, 'exactly one row for a child with two live enrolment years').toHaveLength(1);
    expect(rows[0]).toMatchObject({ classNameEn: 'Class 7', sectionNameEn: 'A' });
  }, 60_000);
});
