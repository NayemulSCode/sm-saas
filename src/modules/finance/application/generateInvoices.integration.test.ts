/**
 * Invoice generation, end to end. §13.6, §13.9.
 *
 * The acceptance test §13.9 names first: generate a month's invoices twice,
 * get no duplicate lines. Everything else here is what has to be true for
 * that number to mean anything — the right amount, on the right student, for
 * the right reason (structure, override, discount, each proven separately).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { provisionTenant } from '../../platform/index';
import { createClassLevel, createSection, createShift } from '../../structure/index';
import {
  admitStudent,
  transitionStudentStatus,
} from '../../directory/index';
import {
  createFeeHead,
  createFeeStructure,
  createFeeAssignment,
  createDiscount,
  approveDiscount,
  generateInvoices,
  InvoiceGenerationErrors,
} from '../index';
import { requestOtp, verifyOtp, resolveAuthContext } from '../../identity/index';
import { codeHasher, randomSource, tokenGenerator } from '../../identity/infrastructure/crypto';
import { Ids } from '../../../shared/ids';
import type { AuthContext, PlatformContext } from '../../../shared/auth-context';
import type {
  AcademicYearId,
  CampusId,
  ClassLevelId,
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
const PLAN_CODE = `fin-gen-${STAMP}`;
const phone = (code: string): string => `+8801${code}${String(STAMP).slice(-6)}`;
const OWNER_PHONE = phone('560');

let admin: Pool;
let principal: AuthContext;
let tenantId: string;
let schoolId: SchoolId;
let campusId: CampusId;
let yearId: AcademicYearId;
let classLevelId: ClassLevelId;
let sectionId: SectionId;
let tuitionId: FeeHeadId;
let examId: FeeHeadId;
let studentA: StudentId; // scholarship on tuition, 10% discount on exam
let studentB: StudentId; // plain class-wide pricing, no override, no discount
let studentC: StudentId; // withdrawn — must not appear at all

const OPERATOR_ACCOUNT = nid<'account'>();
const clock = { now: () => new Date('2027-03-01T06:00:00.000Z') };

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
    requestId: 'fin-gen-int',
    reason: 'provisioning a school for the invoice-generation integration suite',
  };

  const p = await provisionTenant(
    operator,
    {
      slug: `fin-gen-${STAMP}`,
      nameBn: 'চালান বিদ্যালয়',
      nameEn: 'Invoice School',
      planCode: PLAN_CODE,
      owner: { nameBn: 'নাসরিন আক্তার', nameEn: 'Nasrin Akter', phone: OWNER_PHONE },
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

  const level = await createClassLevel(principal, {
    schoolId,
    nameBn: 'চালান পরীক্ষা শ্রেণি',
    nameEn: 'Invoice Test Class',
  });
  if (!level.ok) throw new Error(`class level setup failed: ${JSON.stringify(level)}`);
  classLevelId = level.value.classLevelId;

  const shift = await createShift(principal, {
    campusId,
    nameBn: 'প্রভাতী',
    nameEn: 'Morning',
    startTime: '07:00',
    endTime: '11:30',
  });
  if (!shift.ok) throw new Error('shift setup failed');

  const sec = await createSection(principal, {
    schoolId,
    classLevelId,
    campusId,
    shiftId: shift.value.shiftId,
    nameBn: 'ক',
    nameEn: 'A',
  });
  if (!sec.ok) throw new Error('section setup failed');
  sectionId = sec.value.sectionId;

  const tuition = await createFeeHead(principal, {
    code: 'TUITION',
    nameBn: 'বেতন',
    nameEn: 'Tuition',
    frequency: 'monthly',
  });
  if (!tuition.ok) throw new Error('tuition head setup failed');
  tuitionId = tuition.value.feeHeadId;

  const exam = await createFeeHead(principal, {
    code: 'EXAM_FEE',
    nameBn: 'পরীক্ষার ফি',
    nameEn: 'Exam Fee',
    frequency: 'term',
  });
  if (!exam.ok) throw new Error('exam head setup failed');
  examId = exam.value.feeHeadId;

  const tuitionStructure = await createFeeStructure(principal, {
    academicYearId: yearId,
    feeHeadId: tuitionId,
    classLevelId,
    amountMinor: '150000', // ৳1,500
  });
  if (!tuitionStructure.ok) throw new Error('tuition structure setup failed');

  const examStructure = await createFeeStructure(principal, {
    academicYearId: yearId,
    feeHeadId: examId,
    classLevelId,
    amountMinor: '30000', // ৳300
  });
  if (!examStructure.ok) throw new Error('exam structure setup failed');

  const admitOne = async (nameEn: string) => {
    const r = await admitStudent(principal, {
      schoolId,
      sectionId,
      academicYearId: yearId,
      nameBn: nameEn,
      nameEn,
    });
    if (!r.ok) throw new Error(`admission setup failed: ${JSON.stringify(r)}`);
    return r.value.studentId;
  };

  studentA = await admitOne('Scholarship Student');
  studentB = await admitOne('Plain Student');
  studentC = await admitOne('Withdrawn Student');

  const override = await createFeeAssignment(principal, {
    studentId: studentA,
    feeHeadId: tuitionId,
    academicYearId: yearId,
    amountMinor: '50000', // ৳500 scholarship, replaces the ৳1,500 class price
    reason: 'merit scholarship agreed with the family',
  });
  if (!override.ok) throw new Error('assignment setup failed');

  const discount = await createDiscount(principal, {
    studentId: studentA,
    feeHeadId: examId,
    kind: 'merit',
    percent: 10,
    validFrom: '2027-01-01',
    reason: 'top of class last term',
  });
  if (!discount.ok) throw new Error('discount setup failed');
  const approved = await approveDiscount(principal, {
    discountId: discount.value.discountId,
    reason: 'confirmed with the exam controller',
  });
  if (!approved.ok) throw new Error('discount approval setup failed');

  const withdrawn = await transitionStudentStatus(principal, {
    studentId: studentC,
    to: 'withdrawn',
    reason: 'family relocated before the term started',
  });
  if (!withdrawn.ok) throw new Error(`withdrawal setup failed: ${JSON.stringify(withdrawn)}`);
}, 180_000);

afterAll(async () => {
  const { closeAllPools } = await import('../../../db/index');
  await closeAllPools();
  await admin?.end();
});

describe('generateInvoices', () => {
  it('refuses a caller without fee.structure.manage', async () => {
    const weak: AuthContext = { ...principal, permissions: new Set<Permission>(['fee.read']) };
    await expect(
      generateInvoices(weak, {
        academicYearId: yearId,
        periodLabel: '2027-03',
        issuedOn: '2027-03-01',
        dueDate: '2027-03-10',
      }),
    ).rejects.toThrow(/fee\.structure\.manage/);
  }, 30_000);

  it('refuses an unknown academic year', async () => {
    const r = await generateInvoices(principal, {
      academicYearId: nid<'academicYear'>() as AcademicYearId,
      periodLabel: '2027-03',
      issuedOn: '2027-03-01',
      dueDate: '2027-03-10',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(InvoiceGenerationErrors.YEAR_NOT_FOUND.code);
  }, 30_000);

  it('prices the class, an override, and an approved discount — and skips the withdrawn student', async () => {
    const r = await generateInvoices(principal, {
      academicYearId: yearId,
      periodLabel: '2027-03',
      issuedOn: '2027-03-01',
      dueDate: '2027-03-10',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    // Exactly A and B — C is withdrawn and never reaches the count at all.
    expect(r.value.studentsProcessed).toBe(2);
    expect(r.value.invoicesCreated).toBe(2);
    expect(r.value.invoicesReused).toBe(0);
    expect(r.value.linesCreated).toBe(4); // 2 heads × 2 students

    const invoices = await admin.query<{
      student_id: string;
      total_minor: string;
      discount_minor: string;
      paid_minor: string;
      status: string;
      period_label: string;
    }>(
      `SELECT student_id, total_minor, discount_minor, paid_minor, status, period_label
         FROM invoice WHERE tenant_id=$1 AND academic_year_id=$2 ORDER BY student_id`,
      [uuid(tenantId), uuid(yearId)],
    );
    expect(invoices.rows).toHaveLength(2);

    const byStudent = new Map(invoices.rows.map((row) => [row.student_id, row]));
    const invoiceA = byStudent.get(uuid(studentA));
    const invoiceB = byStudent.get(uuid(studentB));

    // A: ৳500 (override) + ৳300 (exam gross) = ৳800 total; ৳30 discount (10% of exam only).
    expect(invoiceA?.total_minor).toBe('80000');
    expect(invoiceA?.discount_minor).toBe('3000');
    expect(invoiceA?.paid_minor).toBe('0');
    expect(invoiceA?.status).toBe('issued');
    expect(invoiceA?.period_label).toBe('2027-03');

    // B: plain class pricing, no override, no discount.
    expect(invoiceB?.total_minor).toBe('180000');
    expect(invoiceB?.discount_minor).toBe('0');

    // C never got an invoice at all.
    expect(byStudent.has(uuid(studentC))).toBe(false);

    const linesA = await admin.query<{ fee_head_id: string; amount_minor: string; discount_minor: string; description: string }>(
      `SELECT fee_head_id, amount_minor, discount_minor, description
         FROM invoice_line WHERE tenant_id=$1 AND invoice_id=(
           SELECT id FROM invoice WHERE tenant_id=$1 AND student_id=$2 AND academic_year_id=$3
         ) ORDER BY fee_head_id`,
      [uuid(tenantId), uuid(studentA), uuid(yearId)],
    );
    expect(linesA.rows).toHaveLength(2);
    const tuitionLine = linesA.rows.find((l) => l.fee_head_id === uuid(tuitionId));
    expect(tuitionLine?.amount_minor).toBe('50000');
    expect(tuitionLine?.discount_minor).toBe('0');
    expect(tuitionLine?.description).toBe('Tuition');
    const examLine = linesA.rows.find((l) => l.fee_head_id === uuid(examId));
    expect(examLine?.amount_minor).toBe('30000');
    expect(examLine?.discount_minor).toBe('3000');
  }, 60_000);

  /*
   * §13.9's own first acceptance test, verbatim: "Generate a month's
   * invoices twice → no duplicate lines." Re-running with the SAME period
   * must create nothing new — both unique indexes (0014's on invoice_line,
   * 0015's on invoice) working together, exercised through the use case
   * rather than by inspecting the indexes directly.
   */
  it('generating the same period twice creates no duplicate invoices or lines', async () => {
    const before = await admin.query<{ n: string }>(
      'SELECT count(*)::text n FROM invoice_line WHERE tenant_id=$1',
      [uuid(tenantId)],
    );

    const again = await generateInvoices(principal, {
      academicYearId: yearId,
      periodLabel: '2027-03',
      issuedOn: '2027-03-01',
      dueDate: '2027-03-10',
    });
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;

    expect(again.value.studentsProcessed).toBe(2);
    expect(again.value.invoicesCreated).toBe(0);
    expect(again.value.invoicesReused).toBe(2);
    expect(again.value.linesCreated).toBe(0);

    const after = await admin.query<{ n: string }>(
      'SELECT count(*)::text n FROM invoice_line WHERE tenant_id=$1',
      [uuid(tenantId)],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);

    const invoiceCount = await admin.query<{ n: string }>(
      'SELECT count(*)::text n FROM invoice WHERE tenant_id=$1 AND academic_year_id=$2',
      [uuid(tenantId), uuid(yearId)],
    );
    expect(invoiceCount.rows[0]?.n).toBe('2');
  }, 60_000);

  // A different period for the same student is a genuinely new invoice —
  // idempotency must not collapse two real periods into one.
  it('a different period for the same student creates a new invoice', async () => {
    const r = await generateInvoices(principal, {
      academicYearId: yearId,
      periodLabel: '2027-04',
      issuedOn: '2027-04-01',
      dueDate: '2027-04-10',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.invoicesCreated).toBe(2);

    const count = await admin.query<{ n: string }>(
      'SELECT count(*)::text n FROM invoice WHERE tenant_id=$1 AND academic_year_id=$2',
      [uuid(tenantId), uuid(yearId)],
    );
    expect(count.rows[0]?.n).toBe('4'); // 2 students × 2 periods
  }, 60_000);

  /*
   * Migration 0015's own guard, proven directly: bypass the application
   * layer entirely and try to INSERT a second 'system' invoice for a period
   * that already has one. The database must refuse it on its own — the same
   * discipline `finance.integration.test.ts` already applies to every other
   * load-bearing CHECK and unique index in this schema.
   */
  it('the database itself refuses a second system invoice for the same period', async () => {
    await expect(
      admin.query(
        `INSERT INTO invoice
           (id, tenant_id, student_id, academic_year_id, period_label, issued_on, due_date, source)
         VALUES ($1,$2,$3,$4,'2027-03','2027-03-01','2027-03-10','system')`,
        [uuid(nid()), uuid(tenantId), uuid(studentA), uuid(yearId)],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'invoice_system_one_per_period_idx' });
  }, 30_000);
});
