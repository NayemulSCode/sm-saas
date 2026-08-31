/**
 * Fee heads and fee structures, end to end. §13.1.
 *
 * The first use cases finance has — everything invoice generation will read
 * later gets written here first. The school is built by `provisionTenant`,
 * same fixture pattern as `structure.integration.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { provisionTenant } from '../../platform/index';
import { createClassLevel, createSection, createShift, getStructure } from '../../structure/index';
import {
  createFeeHead,
  listFeeHeads,
  createFeeStructure,
  listFeeStructures,
  createFeeAssignment,
  listFeeAssignments,
  createDiscount,
  approveDiscount,
  listDiscounts,
} from '../index';
import { FeeHeadErrors } from './feeHeads';
import { FeeStructureErrors } from './feeStructures';
import { FeeAssignmentErrors } from './feeAssignments';
import { DiscountErrors } from './discounts';
import { admitStudent } from '../../directory/index';
import { requestOtp, verifyOtp, resolveAuthContext } from '../../identity/index';
import { codeHasher, randomSource, tokenGenerator } from '../../identity/infrastructure/crypto';
import { Ids } from '../../../shared/ids';
import type { AuthContext, PlatformContext } from '../../../shared/auth-context';
import type {
  AcademicYearId,
  CampusId,
  ClassLevelId,
  DiscountId,
  FeeHeadId,
  SchoolId,
  SectionId,
  StudentId,
} from '../../../shared/ids';
import { PERMISSIONS, type Permission } from '../../../shared/permissions';

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR;
const PLATFORM_URL = process.env.DATABASE_URL_PLATFORM;

const nid = <T extends string = 'x'>() => Ids.generate<T>();
const uuid = (v: string) => Ids.toUuid(v as never);

const STAMP = Date.now();
const PLAN_CODE = `fin-def-${STAMP}`;
const phone = (code: string): string => `+8801${code}${String(STAMP).slice(-6)}`;
const OWNER_PHONE = phone('550');

let admin: Pool;
let principal: AuthContext;
let tenantId: string;
let schoolId: SchoolId;
let campusId: CampusId;
let yearId: AcademicYearId;
let classLevelId: ClassLevelId;
let sectionId: SectionId;
let studentId: StudentId;
let tuitionId: FeeHeadId;

const OPERATOR_ACCOUNT = nid<'account'>();
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
    requestId: 'fin-def-int',
    reason: 'provisioning a school for the fee-definition integration suite',
  };

  const p = await provisionTenant(
    operator,
    {
      slug: `fin-def-${STAMP}`,
      nameBn: 'অর্থ বিদ্যালয়',
      nameEn: 'Finance School',
      planCode: PLAN_CODE,
      owner: { nameBn: 'করিম আহমেদ', nameEn: 'Karim Ahmed', phone: OWNER_PHONE },
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

  const y = await admin.query<{ id: string }>(
    'SELECT id FROM academic_year WHERE tenant_id=$1 AND is_current',
    [uuid(tenantId)],
  );
  yearId = Ids.fromUuid<'academicYear'>(y.rows[0]!.id);

  // A name distinct from provisioning's own default ladder (which already
  // seeds a 'Class 6') — createClassLevel refuses a duplicate name.
  const level = await createClassLevel(principal, {
    schoolId,
    nameBn: 'অর্থ পরীক্ষা শ্রেণি',
    nameEn: 'Finance Test Class',
  });
  if (!level.ok) throw new Error(`class level setup failed: ${JSON.stringify(level)}`);
  classLevelId = level.value.classLevelId;

  const morningShift = await createShift(principal, {
    campusId,
    nameBn: 'প্রভাতী',
    nameEn: 'Morning',
    startTime: '07:00',
    endTime: '11:30',
  });
  if (!morningShift.ok) throw new Error('shift setup failed');

  const sec = await createSection(principal, {
    schoolId,
    classLevelId,
    campusId,
    shiftId: morningShift.value.shiftId,
    nameBn: 'ক',
    nameEn: 'A',
  });
  if (!sec.ok) throw new Error('section setup failed');
  sectionId = sec.value.sectionId;

  const admitted = await admitStudent(principal, {
    schoolId,
    sectionId,
    academicYearId: yearId,
    nameBn: 'নতুন ছাত্র',
    nameEn: 'Fee Test Student',
  });
  if (!admitted.ok) throw new Error(`student setup failed: ${JSON.stringify(admitted)}`);
  studentId = admitted.value.studentId;

  const head = await createFeeHead(principal, {
    code: 'TUITION',
    nameBn: 'বেতন',
    nameEn: 'Tuition',
    frequency: 'monthly',
  });
  if (!head.ok) throw new Error(`fee head setup failed: ${JSON.stringify(head)}`);
  tuitionId = head.value.feeHeadId;
}, 180_000);

afterAll(async () => {
  const { closeAllPools } = await import('../../../db/index');
  await closeAllPools();
  await admin?.end();
});

describe('fee heads', () => {
  // TUITION was created in `beforeAll` — the fee-structures/assignments/
  // discounts suites below all need one already in place, so this describe
  // proves createFeeHead works against a DIFFERENT code instead of redoing it.

  it('creates a fee head', async () => {
    const r = await createFeeHead(principal, {
      code: 'EXAM_FEE',
      nameBn: 'পরীক্ষার ফি',
      nameEn: 'Exam Fee',
      frequency: 'term',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    const list = await listFeeHeads(principal);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.some((h) => h.id === r.value.feeHeadId && h.code === 'EXAM_FEE')).toBe(true);
  }, 60_000);

  it('refuses a duplicate code', async () => {
    const r = await createFeeHead(principal, {
      code: 'TUITION',
      nameBn: 'অন্য বেতন',
      nameEn: 'Other Tuition',
      frequency: 'annual',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(FeeHeadErrors.CODE_TAKEN.code);
  }, 60_000);

  it('refuses a caller without fee.structure.manage', async () => {
    const weak: AuthContext = { ...principal, permissions: new Set<Permission>(['fee.read']) };
    await expect(
      createFeeHead(weak, { code: 'EXAM', nameBn: 'পরীক্ষা', nameEn: 'Exam', frequency: 'term' }),
    ).rejects.toThrow(/fee\.structure\.manage/);
  }, 30_000);

  it('refuses a read without fee.read', async () => {
    const weak: AuthContext = { ...principal, permissions: new Set<Permission>([]) };
    await expect(listFeeHeads(weak)).rejects.toThrow(/fee\.read/);
  }, 30_000);

  describe('fee structures', () => {
    it('prices the class', async () => {
      const r = await createFeeStructure(principal, {
        academicYearId: yearId,
        feeHeadId: tuitionId,
        classLevelId,
        amountMinor: '150000', // ৳1,500
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;

      const list = await listFeeStructures(principal, { academicYearId: yearId });
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      const row = list.value.find((s) => s.id === r.value.feeStructureId);
      expect(row?.amountMinor).toBe('150000');
      expect(row?.classLevelId).toBe(classLevelId);
      expect(row?.sectionId).toBeNull();
    }, 60_000);

    // A section can carry its own price on top of the class-wide one — a
    // special programme section paying extra, e.g. — since the unique index
    // keys on COALESCE(class_level_id, section_id), not the head alone.
    it('a section-specific price for the same head does not collide with the class-wide one', async () => {
      const r = await createFeeStructure(principal, {
        academicYearId: yearId,
        feeHeadId: tuitionId,
        sectionId,
        amountMinor: '200000', // ৳2,000 — this section pays more
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }, 60_000);

    it('refuses a second class-wide price for the same head and year', async () => {
      const r = await createFeeStructure(principal, {
        academicYearId: yearId,
        feeHeadId: tuitionId,
        classLevelId,
        amountMinor: '999900',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(FeeStructureErrors.DUPLICATE_SCOPE.code);
    }, 60_000);

    it('refuses an unknown year, head and scope, one error each', async () => {
      const year = await createFeeStructure(principal, {
        academicYearId: nid<'academicYear'>() as AcademicYearId,
        feeHeadId: tuitionId,
        classLevelId,
        amountMinor: '1000',
      });
      expect(year.ok).toBe(false);
      if (!year.ok) expect(year.error.code).toBe(FeeStructureErrors.YEAR_NOT_FOUND.code);

      const head = await createFeeStructure(principal, {
        academicYearId: yearId,
        feeHeadId: nid<'feeHead'>() as FeeHeadId,
        classLevelId,
        amountMinor: '1000',
      });
      expect(head.ok).toBe(false);
      if (!head.ok) expect(head.error.code).toBe(FeeStructureErrors.HEAD_NOT_FOUND.code);

      const scope = await createFeeStructure(principal, {
        academicYearId: yearId,
        feeHeadId: tuitionId,
        classLevelId: nid<'classLevel'>() as ClassLevelId,
        amountMinor: '1000',
      });
      expect(scope.ok).toBe(false);
      if (!scope.ok) expect(scope.error.code).toBe(FeeStructureErrors.SCOPE_NOT_FOUND.code);
    }, 60_000);

    /*
     * A class level from a DIFFERENT school than the academic year. The
     * single-column FK on `class_level_id` would happily allow it; nothing
     * downstream could price a student against a class outside their own
     * school's calendar.
     */
    it('refuses a scope that belongs to a different school', async () => {
      const otherSchool = nid<'school'>();
      await admin.query(
        `INSERT INTO school (id, tenant_id, name_bn, name_en) VALUES ($1,$2,'অন্য','Other')`,
        [uuid(otherSchool), uuid(tenantId)],
      );
      const otherLevel = nid<'classLevel'>();
      await admin.query(
        `INSERT INTO class_level (id, tenant_id, school_id, name_bn, name_en, sequence)
         VALUES ($1,$2,$3,'অন্য শ্রেণি','Other Class',1)`,
        [uuid(otherLevel), uuid(tenantId), uuid(otherSchool)],
      );

      const r = await createFeeStructure(principal, {
        academicYearId: yearId,
        feeHeadId: tuitionId,
        classLevelId: otherLevel as ClassLevelId,
        amountMinor: '1000',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(FeeStructureErrors.SCOPE_SCHOOL_MISMATCH.code);
    }, 60_000);

    it('refuses a caller without fee.structure.manage', async () => {
      const weak: AuthContext = { ...principal, permissions: new Set<Permission>(['fee.read']) };
      await expect(
        createFeeStructure(weak, {
          academicYearId: yearId,
          feeHeadId: tuitionId,
          classLevelId,
          amountMinor: '1000',
        }),
      ).rejects.toThrow(/fee\.structure\.manage/);
    }, 30_000);

    // Invariant 14: a suspended tenant resolves reads but refuses writes.
    it('refuses every write for a read-only tenant but allows the read', async () => {
      const suspended: AuthContext = { ...principal, readOnly: true };
      await expect(
        createFeeHead(suspended, {
          code: 'SUSPENDED',
          nameBn: 'স্থগিত',
          nameEn: 'Suspended',
          frequency: 'one_time',
        }),
      ).rejects.toThrow();
      const read = await listFeeHeads(suspended);
      expect(read.ok).toBe(true);
    }, 30_000);
  });
});

describe('fee assignments', () => {
  it('overrides the class price for one student', async () => {
    const r = await createFeeAssignment(principal, {
      studentId,
      feeHeadId: tuitionId,
      academicYearId: yearId,
      amountMinor: '50000', // ৳500 — a scholarship, well under the class price
      reason: 'merit scholarship agreed with the family',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    const list = await listFeeAssignments(principal, { studentId });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const row = list.value.find((a) => a.id === r.value.feeAssignmentId);
    expect(row?.amountMinor).toBe('50000');
  }, 60_000);

  it('refuses a second override for the same student, head and year', async () => {
    const r = await createFeeAssignment(principal, {
      studentId,
      feeHeadId: tuitionId,
      academicYearId: yearId,
      amountMinor: '60000',
      reason: 'trying to override it again',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(FeeAssignmentErrors.ASSIGNMENT_TAKEN.code);
  }, 60_000);

  it('refuses an unknown student, head and year, one error each', async () => {
    const good = { feeHeadId: tuitionId, academicYearId: yearId, amountMinor: '1000', reason: 'x' };

    const noStudent = await createFeeAssignment(principal, {
      ...good,
      studentId: nid<'student'>() as StudentId,
    });
    expect(noStudent.ok).toBe(false);
    if (!noStudent.ok) expect(noStudent.error.code).toBe(FeeAssignmentErrors.STUDENT_NOT_FOUND.code);

    const noHead = await createFeeAssignment(principal, {
      studentId,
      academicYearId: yearId,
      amountMinor: '1000',
      reason: 'x',
      feeHeadId: nid<'feeHead'>() as FeeHeadId,
    });
    expect(noHead.ok).toBe(false);
    if (!noHead.ok) expect(noHead.error.code).toBe(FeeAssignmentErrors.HEAD_NOT_FOUND.code);

    const noYear = await createFeeAssignment(principal, {
      studentId,
      feeHeadId: tuitionId,
      amountMinor: '1000',
      reason: 'x',
      academicYearId: nid<'academicYear'>() as AcademicYearId,
    });
    expect(noYear.ok).toBe(false);
    if (!noYear.ok) expect(noYear.error.code).toBe(FeeAssignmentErrors.YEAR_NOT_FOUND.code);
  }, 60_000);

  it('refuses a caller without fee.structure.manage', async () => {
    const weak: AuthContext = { ...principal, permissions: new Set<Permission>(['fee.read']) };
    await expect(
      createFeeAssignment(weak, {
        studentId,
        feeHeadId: tuitionId,
        academicYearId: yearId,
        amountMinor: '1000',
        reason: 'x',
      }),
    ).rejects.toThrow(/fee\.structure\.manage/);
  }, 30_000);
});

describe('discounts', () => {
  it('creates a pending discount, requested by the caller', async () => {
    const r = await createDiscount(principal, {
      studentId,
      feeHeadId: tuitionId,
      kind: 'merit',
      percent: 10,
      validFrom: '2027-01-01',
      reason: 'top of class last term',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    const list = await listDiscounts(principal, { studentId });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const row = list.value.find((d) => d.id === r.value.discountId);
    expect(row?.status).toBe('pending');
    expect(row?.percent).toBe('10.00');
    expect(row?.valueMinor).toBeNull();
  }, 60_000);

  it('creates a fixed-amount discount applying to every head', async () => {
    const r = await createDiscount(principal, {
      studentId,
      kind: 'sibling',
      valueMinor: '25000',
      validFrom: '2027-01-01',
      validTo: '2027-12-31',
      reason: 'second child at this school',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    const list = await listDiscounts(principal, { studentId });
    if (!list.ok) return;
    const row = list.value.find((d) => d.id === r.value.discountId);
    expect(row?.feeHeadId).toBeNull(); // every head
    expect(row?.valueMinor).toBe('25000');
  }, 60_000);

  it('refuses a validTo before validFrom', async () => {
    const r = await createDiscount(principal, {
      studentId,
      kind: 'other',
      valueMinor: '1000',
      validFrom: '2027-06-01',
      validTo: '2027-01-01',
      reason: 'backwards range',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(DiscountErrors.INVALID_DATE_RANGE.code);
  }, 60_000);

  it('refuses an unknown student and head', async () => {
    const noStudent = await createDiscount(principal, {
      studentId: nid<'student'>() as StudentId,
      kind: 'need',
      valueMinor: '1000',
      validFrom: '2027-01-01',
      reason: 'x',
    });
    expect(noStudent.ok).toBe(false);
    if (!noStudent.ok) expect(noStudent.error.code).toBe(DiscountErrors.STUDENT_NOT_FOUND.code);

    const noHead = await createDiscount(principal, {
      studentId,
      feeHeadId: nid<'feeHead'>() as FeeHeadId,
      kind: 'need',
      valueMinor: '1000',
      validFrom: '2027-01-01',
      reason: 'x',
    });
    expect(noHead.ok).toBe(false);
    if (!noHead.ok) expect(noHead.error.code).toBe(DiscountErrors.HEAD_NOT_FOUND.code);
  }, 60_000);

  describe('approval', () => {
    it('refuses fee.waive to everyone but the principal', async () => {
      const created = await createDiscount(principal, {
        studentId,
        kind: 'staff_child',
        percent: 50,
        validFrom: '2027-01-01',
        reason: 'staff member’s child, per policy',
      });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      if (!created.ok) return;

      const accountant: AuthContext = {
        ...principal,
        permissions: new Set<Permission>(['fee.read', 'fee.structure.manage', 'fee.collect']),
      };
      await expect(
        approveDiscount(accountant, {
          discountId: created.value.discountId,
          reason: 'an accountant trying to approve their own discount',
        }),
      ).rejects.toThrow(/fee\.waive/);

      const r = await approveDiscount(principal, {
        discountId: created.value.discountId,
        reason: 'confirmed with the staff office',
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);

      const list = await listDiscounts(principal, { studentId });
      if (!list.ok) return;
      const row = list.value.find((d) => d.id === created.value.discountId);
      expect(row?.status).toBe('approved');
      expect(row?.approvedAt).not.toBeNull();
    }, 60_000);

    it('refuses to approve the same discount twice', async () => {
      const created = await createDiscount(principal, {
        studentId,
        kind: 'need',
        valueMinor: '5000',
        validFrom: '2027-01-01',
        reason: 'family hardship, documented',
      });
      if (!created.ok) throw new Error('setup failed');

      const first = await approveDiscount(principal, {
        discountId: created.value.discountId,
        reason: 'approved after review',
      });
      expect(first.ok).toBe(true);

      const second = await approveDiscount(principal, {
        discountId: created.value.discountId,
        reason: 'trying again',
      });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.code).toBe(DiscountErrors.ALREADY_DECIDED.code);
    }, 60_000);

    it('refuses to approve an unknown discount', async () => {
      const r = await approveDiscount(principal, {
        discountId: nid<'discount'>() as DiscountId,
        reason: 'approving something that does not exist',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(DiscountErrors.NOT_FOUND.code);
    }, 60_000);
  });
});

// The class level created above must still resolve through getStructure —
// proof this suite did not leave the structure module's own invariants
// broken by reaching into its tables for the school-mismatch fixture above.
describe('does not disturb structure', () => {
  it('the school still reads back correctly', async () => {
    const r = await getStructure(principal, schoolId);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.classLevels.some((l) => l.id === classLevelId)).toBe(true);
    expect(r.value.sections.some((s) => s.id === sectionId)).toBe(true);
  }, 60_000);
});
