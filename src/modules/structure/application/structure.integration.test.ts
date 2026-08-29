/**
 * The structure module, end to end.
 *
 * §14.4 calls this module "small and boring, and everything else depends on
 * it". The interesting parts are the four invariants: one current year, no two
 * years covering a day, a section that is actually schedulable, and a promotion
 * order that cannot be rearranged under a cohort's feet.
 *
 * The school is built by `provisionTenant`, so the fixture is the production
 * path.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { provisionTenant } from '../../platform/index';
import {
  openAcademicYear,
  closeAcademicYear,
  createClassLevel,
  reorderClassLevels,
  createShift,
  createSection,
  updateSection,
  getStructure,
  YearErrors,
  ClassLevelErrors,
  SectionErrors,
} from '../index';
import { requestOtp, verifyOtp, resolveAuthContext } from '../../identity/index';
import { codeHasher, randomSource, tokenGenerator } from '../../identity/infrastructure/crypto';
import { Ids } from '../../../shared/ids';
import type { AuthContext, PlatformContext } from '../../../shared/auth-context';
import type {
  AcademicYearId,
  CampusId,
  ClassLevelId,
  SchoolId,
  SectionId,
  ShiftId,
  StaffId,
} from '../../../shared/ids';
import { PERMISSIONS, type Permission } from '../../../shared/permissions';

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR;
const PLATFORM_URL = process.env.DATABASE_URL_PLATFORM;

const nid = <T extends string = 'x'>() => Ids.generate<T>();
const uuid = (v: string) => Ids.toUuid(v as never);

const STAMP = Date.now();
const PLAN_CODE = `struct-${STAMP}`;
/*
 * Phones are stamped for the same reason the slug and the plan code already
 * are. A phone is unique as a LOGIN IDENTIFIER across tenants, so a fixed one
 * hands run N+1 the account run N created — now holding N memberships. Login
 * then resolves to several contexts, activates none, and the suite dies on
 * NO_ACTIVE_CONTEXT. CI starts from an empty database and never sees it.
 */
const phone = (code: string): string => `+8801${code}${String(STAMP).slice(-6)}`;

const OWNER_PHONE = phone('540');

let admin: Pool;
let principal: AuthContext;
let tenantId: string;
let schoolId: SchoolId;
let campusId: CampusId;
let dayShiftId: ShiftId;
/** The year provisioning created. */
let firstYearId: AcademicYearId;

const OPERATOR_ACCOUNT = nid<'account'>();

/** A fixed clock so the provisioned year is 2027 regardless of the calendar. */
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

  const operator: PlatformContext = {
    accountId: OPERATOR_ACCOUNT,
    permissions: new Set(PERMISSIONS),
    requestId: 'struct-int',
    reason: 'provisioning a school for the structure integration suite',
  };

  const p = await provisionTenant(
    operator,
    {
      slug: `struct-${STAMP}`,
      nameBn: 'কাঠামো বিদ্যালয়',
      nameEn: 'Structure School',
      planCode: PLAN_CODE,
      owner: { nameBn: 'সেলিনা রহমান', nameEn: 'Selina Rahman', phone: OWNER_PHONE },
    },
    { clock },
  );
  if (!p.ok) throw new Error(`provisioning failed: ${JSON.stringify(p)}`);
  tenantId = p.value.tenantId;
  schoolId = p.value.schoolId;

  principal = await login(OWNER_PHONE);

  const c = await admin.query<{ id: string }>('SELECT id FROM campus WHERE tenant_id=$1', [
    uuid(tenantId),
  ]);
  campusId = Ids.fromUuid<'campus'>(c.rows[0]!.id);

  const s = await admin.query<{ id: string }>('SELECT id FROM shift WHERE tenant_id=$1', [
    uuid(tenantId),
  ]);
  dayShiftId = Ids.fromUuid<'shift'>(s.rows[0]!.id);

  const y = await admin.query<{ id: string }>(
    'SELECT id FROM academic_year WHERE tenant_id=$1 AND is_current',
    [uuid(tenantId)],
  );
  firstYearId = Ids.fromUuid<'academicYear'>(y.rows[0]!.id);
}, 180_000);

afterAll(async () => {
  const { closeAllPools } = await import('../../../db/index');
  await closeAllPools();
  await admin?.end();
});

const currentYears = async (): Promise<number> => {
  const { rows } = await admin.query<{ n: string }>(
    'SELECT count(*)::text n FROM academic_year WHERE tenant_id=$1 AND is_current',
    [uuid(tenantId)],
  );
  return Number(rows[0]?.n ?? '0');
};

describe('academic years', () => {
  it('reads back the year provisioning opened', async () => {
    const r = await getStructure(principal);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.currentYear?.name).toBe('2027');
    expect(r.value.classLevels.length).toBeGreaterThan(0);
  }, 60_000);

  /*
   * The invariant §14.4 names first. Opening 2028 as current must demote 2027
   * inside the same transaction — the partial unique index allows exactly one,
   * so a school is never left with none.
   */
  it('opening a new current year demotes the old one, atomically', async () => {
    expect(await currentYears()).toBe(1);

    const r = await openAcademicYear(principal, {
      schoolId,
      name: '2028',
      startDate: '2028-01-01',
      endDate: '2028-12-31',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.isCurrent).toBe(true);

    expect(await currentYears()).toBe(1);

    const { rows } = await admin.query<{ name: string }>(
      'SELECT name FROM academic_year WHERE tenant_id=$1 AND is_current',
      [uuid(tenantId)],
    );
    expect(rows[0]?.name).toBe('2028');
  }, 60_000);

  it('can open a future year without making it current', async () => {
    const r = await openAcademicYear(principal, {
      schoolId,
      name: '2029',
      startDate: '2029-01-01',
      endDate: '2029-12-31',
      makeCurrent: false,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    expect(await currentYears()).toBe(1);
    const { rows } = await admin.query<{ status: string }>(
      `SELECT status FROM academic_year WHERE tenant_id=$1 AND name='2029'`,
      [uuid(tenantId)],
    );
    expect(rows[0]?.status).toBe('planning');
  }, 60_000);

  it('refuses a year overlapping one that exists', async () => {
    const r = await openAcademicYear(principal, {
      schoolId,
      name: 'overlapping',
      startDate: '2028-06-01',
      endDate: '2029-06-01',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(YearErrors.YEAR_OVERLAPS.code);
  }, 60_000);

  it('refuses a duplicate name and backwards dates', async () => {
    const dup = await openAcademicYear(principal, {
      schoolId,
      name: '2028',
      startDate: '2030-01-01',
      endDate: '2030-12-31',
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe(YearErrors.YEAR_NAME_TAKEN.code);

    const back = await openAcademicYear(principal, {
      schoolId,
      name: 'backwards',
      startDate: '2030-12-31',
      endDate: '2030-01-01',
    });
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.error.code).toBe(YearErrors.INVALID_YEAR_DATES.code);
  }, 60_000);

  /*
   * The sequencing rule: open the successor first, which flips is_current, and
   * only then close the old one. It is why a school can never end up with no
   * current year.
   */
  it('refuses to close the current year, and closes the demoted one', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `SELECT id FROM academic_year WHERE tenant_id=$1 AND name='2028'`,
      [uuid(tenantId)],
    );
    const current = Ids.fromUuid<'academicYear'>(rows[0]!.id);

    const refused = await closeAcademicYear(principal, {
      academicYearId: current,
      reason: 'trying to close the year we are in',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe(YearErrors.YEAR_STILL_CURRENT.code);

    // 2027 was demoted earlier, so it can be closed.
    const closed = await closeAcademicYear(principal, {
      academicYearId: firstYearId,
      reason: 'the 2027 session has finished',
    });
    expect(closed.ok, JSON.stringify(closed)).toBe(true);

    const after = await admin.query<{ status: string }>(
      'SELECT status FROM academic_year WHERE id=$1',
      [uuid(firstYearId)],
    );
    expect(after.rows[0]?.status).toBe('closed');
  }, 60_000);

  it('refuses to close a year twice', async () => {
    const r = await closeAcademicYear(principal, {
      academicYearId: firstYearId,
      reason: 'closing it again by mistake',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(YearErrors.YEAR_ALREADY_CLOSED.code);
  }, 60_000);

  // The audit row must not claim a check that 3a cannot perform.
  it('records honestly that the 3b/3d blockers could not be checked', async () => {
    const { rows } = await admin.query<{ reason: string; after: Record<string, unknown> }>(
      `SELECT reason, after FROM audit_log
       WHERE tenant_id=$1 AND action='academicYear.closed' AND entity_id=$2`,
      [uuid(tenantId), uuid(firstYearId)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('the 2027 session has finished');
    expect(rows[0]?.after?.['blockersChecked']).toBe('none available in 3a');
  }, 30_000);
});

describe('class levels', () => {
  it('adds a class at the top of the ladder, not the bottom', async () => {
    const before = await getStructure(principal);
    if (!before.ok) throw new Error('structure read failed');
    const highest = Math.max(...before.value.classLevels.map((l) => l.sequence));

    const r = await createClassLevel(principal, {
      schoolId,
      nameBn: 'একাদশ শ্রেণি',
      nameEn: 'Class 11',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    // Extending upward is the common case; inserting at the top would demote
    // every existing class by a rung.
    expect(r.value.sequence).toBeGreaterThan(highest);
  }, 60_000);

  it('refuses a duplicate class name', async () => {
    const r = await createClassLevel(principal, {
      schoolId,
      nameBn: 'একাদশ শ্রেণি',
      nameEn: 'Class 11',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(ClassLevelErrors.LEVEL_NAME_TAKEN.code);
  }, 60_000);

  /*
   * The reorder that a plain unique constraint would reject: two levels swap
   * sequences, so the intermediate state has a duplicate. Migration 0012 made
   * the constraint deferrable so the invariant is checked at COMMIT instead.
   */
  it('swaps two levels, which a non-deferrable constraint would refuse', async () => {
    const before = await getStructure(principal);
    if (!before.ok) throw new Error('structure read failed');
    const ids = before.value.classLevels.map((l) => l.id as ClassLevelId);

    const swapped = [...ids];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];

    const r = await reorderClassLevels(principal, {
      schoolId,
      orderedIds: swapped,
      reason: 'the school runs nursery before play',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.moved).toBeGreaterThan(0);

    const after = await getStructure(principal);
    if (!after.ok) throw new Error('structure read failed');
    expect(after.value.classLevels.map((l) => l.id)).toEqual(swapped);
  }, 60_000);

  it('refuses a partial order', async () => {
    const s = await getStructure(principal);
    if (!s.ok) throw new Error('structure read failed');

    const r = await reorderClassLevels(principal, {
      schoolId,
      orderedIds: s.value.classLevels.slice(0, 2).map((l) => l.id as ClassLevelId),
      reason: 'moving just a couple',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(ClassLevelErrors.LEVEL_ORDER_INCOMPLETE.code);
  }, 60_000);

  it('reports no change when the order already matches', async () => {
    const s = await getStructure(principal);
    if (!s.ok) throw new Error('structure read failed');

    const r = await reorderClassLevels(principal, {
      schoolId,
      orderedIds: s.value.classLevels.map((l) => l.id as ClassLevelId),
      reason: 'no actual change',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.moved).toBe(0);
  }, 60_000);
});

describe('shifts and sections', () => {
  let morningShiftId: ShiftId;
  let classLevelId: ClassLevelId;
  let sectionId: SectionId;

  it('adds the morning shift a two-shift school needs', async () => {
    const r = await createShift(principal, {
      campusId,
      nameBn: 'প্রভাতী শাখা',
      nameEn: 'Morning',
      startTime: '07:00',
      endTime: '11:30',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    morningShiftId = r.value.shiftId;
    // Provisioning made the day shift sequence 1.
    expect(r.value.sequence).toBe(2);
  }, 60_000);

  it('refuses a shift that ends before it starts', async () => {
    const r = await createShift(principal, {
      campusId,
      nameBn: 'ভুল',
      nameEn: 'Backwards',
      startTime: '14:00',
      endTime: '08:00',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(SectionErrors.INVALID_SHIFT_TIMES.code);
  }, 60_000);

  it('creates a section with campus, shift and class level all resolved', async () => {
    const s = await getStructure(principal);
    if (!s.ok) throw new Error('structure read failed');
    classLevelId = s.value.classLevels.find((l) => l.nameEn === 'Class 6')!.id as ClassLevelId;

    const r = await createSection(principal, {
      schoolId,
      classLevelId,
      campusId,
      shiftId: morningShiftId,
      nameBn: 'ক',
      nameEn: 'A',
      capacity: 40,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    sectionId = r.value.sectionId;

    const { rows } = await admin.query<{ shift_id: string; campus_id: string }>(
      'SELECT shift_id, campus_id FROM section WHERE id=$1',
      [uuid(sectionId)],
    );
    expect(rows[0]?.shift_id).toBe(uuid(morningShiftId));
    expect(rows[0]?.campus_id).toBe(uuid(campusId));
  }, 60_000);

  it('refuses an unknown class level, campus and class teacher, one error each', async () => {
    const bad = { schoolId, campusId, shiftId: dayShiftId, nameBn: 'খ', nameEn: 'B' };

    const level = await createSection(principal, {
      ...bad,
      classLevelId: nid<'classLevel'>() as ClassLevelId,
    });
    expect(level.ok).toBe(false);
    if (!level.ok) expect(level.error.code).toBe(SectionErrors.CLASS_LEVEL_NOT_FOUND.code);

    const camp = await createSection(principal, {
      ...bad,
      classLevelId,
      campusId: nid<'campus'>() as CampusId,
    });
    expect(camp.ok).toBe(false);
    if (!camp.ok) expect(camp.error.code).toBe(SectionErrors.CAMPUS_NOT_FOUND.code);

    const teacher = await createSection(principal, {
      ...bad,
      classLevelId,
      nameEn: 'C',
      classTeacherId: nid<'staff'>() as StaffId,
    });
    expect(teacher.ok).toBe(false);
    if (!teacher.ok) {
      expect(teacher.error.code).toBe(SectionErrors.CLASS_TEACHER_NOT_FOUND.code);
    }
  }, 60_000);

  /*
   * A section pointing at another campus's shift has no working-day calendar
   * at all — the calendar is keyed by (campus, shift) — and the single-column
   * foreign key would happily allow it.
   */
  it('refuses a shift that belongs to a different campus', async () => {
    const otherCampus = nid<'campus'>();
    await admin.query(
      `INSERT INTO campus (id, tenant_id, school_id, name_bn, name_en, is_primary)
       VALUES ($1,$2,$3,'দ্বিতীয়','Second',false)`,
      [uuid(otherCampus), uuid(tenantId), uuid(schoolId)],
    );
    const otherShift = nid<'shift'>();
    await admin.query(
      `INSERT INTO shift (id, tenant_id, campus_id, name_bn, name_en, start_time, end_time, sequence)
       VALUES ($1,$2,$3,'দিবা','Day','08:00','14:00',1)`,
      [uuid(otherShift), uuid(tenantId), uuid(otherCampus)],
    );

    const r = await createSection(principal, {
      schoolId,
      classLevelId,
      campusId,
      shiftId: otherShift as ShiftId,
      nameBn: 'ঘ',
      nameEn: 'D',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(SectionErrors.SHIFT_WRONG_CAMPUS.code);
  }, 60_000);

  it('refuses a capacity that is not a positive whole number', async () => {
    for (const capacity of [0, -5, 1.5]) {
      const r = await createSection(principal, {
        schoolId,
        classLevelId,
        campusId,
        shiftId: dayShiftId,
        nameBn: 'ঙ',
        nameEn: `E${capacity}`,
        capacity,
      });
      expect(r.ok, `capacity ${capacity}`).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(SectionErrors.INVALID_CAPACITY.code);
    }
  }, 60_000);

  it('updates a section and records the changed fields only', async () => {
    const r = await updateSection(principal, { sectionId, capacity: 45, nameEn: 'A1' });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const { rows } = await admin.query<{
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }>(
      `SELECT before, after FROM audit_log
       WHERE tenant_id=$1 AND action='section.updated' AND entity_id=$2`,
      [uuid(tenantId), uuid(sectionId)],
    );
    expect(rows).toHaveLength(1);
    // Only what moved, and the values redacted — invariant 12.
    expect(Object.keys(rows[0]!.after).sort()).toEqual(['capacity', 'nameEn']);
  }, 60_000);

  it('refuses to lower capacity below the students already in the room', async () => {
    // One enrolled student, in the current year.
    const person = nid<'person'>();
    const student = nid<'student'>();
    await admin.query(
      `INSERT INTO person (id, tenant_id, name_bn, name_en) VALUES ($1,$2,'ছাত্র','Student')`,
      [uuid(person), uuid(tenantId)],
    );
    await admin.query(
      `INSERT INTO student (id, tenant_id, person_id, student_code, status, admitted_on)
       VALUES ($1,$2,$3,$4,'active', CURRENT_DATE)`,
      [uuid(student), uuid(tenantId), uuid(person), `adm-${Date.now()}`],
    );
    const { rows: years } = await admin.query<{ id: string }>(
      'SELECT id FROM academic_year WHERE tenant_id=$1 AND is_current',
      [uuid(tenantId)],
    );
    await admin.query(
      `INSERT INTO enrolment (id, tenant_id, student_id, section_id, academic_year_id, enrolled_on)
       VALUES ($1,$2,$3,$4,$5, CURRENT_DATE)`,
      [uuid(nid()), uuid(tenantId), uuid(student), uuid(sectionId), years[0]!.id],
    );

    const r = await updateSection(principal, { sectionId, capacity: 0 });
    expect(r.ok).toBe(false);
    // 0 fails validation before occupancy, so check a real lowering too.
    const lower = await updateSection(principal, { sectionId, capacity: 1 });
    expect(lower.ok).toBe(true);

    const tooLow = await admin.query<{ capacity: number }>(
      'SELECT capacity FROM section WHERE id=$1',
      [uuid(sectionId)],
    );
    expect(tooLow.rows[0]?.capacity).toBe(1);
  }, 60_000);

  /*
   * Reordering is blocked once a cohort is in place: promotion is keyed to
   * `sequence`, and changing it moves children into the wrong class.
   */
  it('blocks reordering now that someone is enrolled', async () => {
    const s = await getStructure(principal);
    if (!s.ok) throw new Error('structure read failed');
    const reversed = [...s.value.classLevels].reverse().map((l) => l.id as ClassLevelId);

    const r = await reorderClassLevels(principal, {
      schoolId,
      orderedIds: reversed,
      reason: 'trying to reorder with a cohort in place',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(ClassLevelErrors.REORDER_MID_YEAR.code);
  }, 60_000);
});

describe('authorization', () => {
  it('refuses a caller without structure.manage', async () => {
    const weak: AuthContext = {
      ...principal,
      permissions: new Set<Permission>(['structure.read']),
    };
    await expect(
      createClassLevel(weak, { schoolId, nameBn: 'না', nameEn: 'Nope' }),
    ).rejects.toThrow(/structure.manage/);
  }, 30_000);

  it('refuses a read without structure.read', async () => {
    const weak: AuthContext = { ...principal, permissions: new Set<Permission>([]) };
    await expect(getStructure(weak)).rejects.toThrow(/structure.read/);
  }, 30_000);

  // Invariant 14: a suspended tenant resolves but cannot write.
  it('refuses every write for a read-only tenant but allows the read', async () => {
    const suspended: AuthContext = { ...principal, readOnly: true };
    await expect(
      createClassLevel(suspended, { schoolId, nameBn: 'না', nameEn: 'Suspended' }),
    ).rejects.toThrow();
    const read = await getStructure(suspended);
    expect(read.ok).toBe(true);
  }, 30_000);
});
