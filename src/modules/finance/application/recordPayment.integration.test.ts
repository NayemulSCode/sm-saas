/**
 * Payment recording and receipt issuance, end to end. §13.3, §13.4, §13.9.
 *
 * Invoices come from the REAL `generateInvoices` path, not hand-built rows —
 * same discipline `structure.integration.test.ts` and the rest of this
 * codebase already apply: a fixture built any other way is how a gap stays
 * invisible.
 *
 * A fixed clock, well after every `collectedAt` used here, makes every
 * payment in this suite technically backdated relative to "today" — which is
 * deliberate: it means every ordinary payment below only succeeds BECAUSE
 * `principal` holds `fee.backdate`, exercising the allow path on every test
 * rather than needing a separate one, and the refusal path gets exactly one
 * dedicated test with a weak context that does not hold it.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { provisionTenant } from '../../platform/index';
import { createClassLevel, createSection, createShift } from '../../structure/index';
import { admitStudent } from '../../directory/index';
import {
  createFeeHead,
  createFeeStructure,
  generateInvoices,
  recordPayment,
  listOutstanding,
  PaymentErrors,
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
const PLAN_CODE = `fin-pay-${STAMP}`;
const phone = (code: string): string => `+8801${code}${String(STAMP).slice(-6)}`;
const OWNER_PHONE = phone('570');

let admin: Pool;
let principal: AuthContext;
let tenantId: string;
let schoolId: SchoolId;
let campusId: CampusId;
let yearId: AcademicYearId;
let classLevelId: ClassLevelId;
let sectionId: SectionId;
let studentId: StudentId;

const provisionClock = { now: () => new Date('2027-01-05T06:00:00.000Z') };
/** Well after every `collectedAt` this suite uses — see the file header. */
const paymentClock = { now: () => new Date('2027-05-01T09:00:00.000Z') };
let keySeq = 0;
const nextKey = () => `test-key-${STAMP}-${++keySeq}`;

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

const OPERATOR_ACCOUNT = nid<'account'>();

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
    requestId: 'fin-pay-int',
    reason: 'provisioning a school for the payment-recording integration suite',
  };

  const p = await provisionTenant(
    operator,
    {
      slug: `fin-pay-${STAMP}`,
      nameBn: 'পরিশোধ বিদ্যালয়',
      nameEn: 'Payment School',
      planCode: PLAN_CODE,
      owner: { nameBn: 'রফিক ইসলাম', nameEn: 'Rafiq Islam', phone: OWNER_PHONE },
    },
    { clock: provisionClock },
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
    nameBn: 'পরিশোধ পরীক্ষা শ্রেণি',
    nameEn: 'Payment Test Class',
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

  // Sequence set explicitly so `oldest_first`'s tie-break (after due date) is
  // deterministic: TUITION before EXAM on the same invoice.
  const tuition = await createFeeHead(principal, {
    code: 'TUITION',
    nameBn: 'বেতন',
    nameEn: 'Tuition',
    frequency: 'monthly',
    sequence: 1,
  });
  if (!tuition.ok) throw new Error('tuition head setup failed');

  const exam = await createFeeHead(principal, {
    code: 'EXAM_FEE',
    nameBn: 'পরীক্ষার ফি',
    nameEn: 'Exam Fee',
    frequency: 'term',
    sequence: 2,
  });
  if (!exam.ok) throw new Error('exam head setup failed');

  for (const feeHeadId of [tuition.value.feeHeadId, exam.value.feeHeadId] as FeeHeadId[]) {
    const amountMinor = feeHeadId === tuition.value.feeHeadId ? '100000' : '50000'; // ৳1,000 / ৳500
    const r = await createFeeStructure(principal, { academicYearId: yearId, feeHeadId, classLevelId, amountMinor });
    if (!r.ok) throw new Error(`fee structure setup failed: ${JSON.stringify(r)}`);
  }

  const admitted = await admitStudent(principal, {
    schoolId,
    sectionId,
    academicYearId: yearId,
    nameBn: 'পরিশোধকারী ছাত্র',
    nameEn: 'Paying Student',
  });
  if (!admitted.ok) throw new Error(`admission setup failed: ${JSON.stringify(admitted)}`);
  studentId = admitted.value.studentId;

  // Two periods, so the student owes across two invoices — ৳1,500 each,
  // ৳3,000 total, March due before April.
  const march = await generateInvoices(principal, {
    academicYearId: yearId,
    periodLabel: '2027-03',
    issuedOn: '2027-03-01',
    dueDate: '2027-03-10',
  });
  if (!march.ok) throw new Error(`march invoice generation failed: ${JSON.stringify(march)}`);

  const april = await generateInvoices(principal, {
    academicYearId: yearId,
    periodLabel: '2027-04',
    issuedOn: '2027-04-01',
    dueDate: '2027-04-10',
  });
  if (!april.ok) throw new Error(`april invoice generation failed: ${JSON.stringify(april)}`);
}, 180_000);

afterAll(async () => {
  const { closeAllPools } = await import('../../../db/index');
  await closeAllPools();
  await admin?.end();
});

describe('recordPayment', () => {
  it('refuses a caller without fee.collect', async () => {
    const weak: AuthContext = { ...principal, permissions: new Set<Permission>(['fee.read']) };
    await expect(
      recordPayment(
        weak,
        {
          studentId,
          amountMinor: '100000',
          channel: 'cash',
          collectedAt: '2027-03-01',
          allocation: { mode: 'auto' },
        },
        nextKey(),
        { clock: paymentClock },
      ),
    ).rejects.toThrow(/fee\.collect/);
  }, 30_000);

  it('refuses a backdated payment for a collector without fee.backdate', async () => {
    const officeAssistant: AuthContext = {
      ...principal,
      permissions: new Set<Permission>(['fee.read', 'fee.collect']),
    };
    const r = await recordPayment(
      officeAssistant,
      {
        studentId,
        amountMinor: '100000',
        channel: 'cash',
        collectedAt: '2027-03-01', // before paymentClock's "today" of 2027-05-01
        allocation: { mode: 'auto' },
      },
      nextKey(),
      { clock: paymentClock },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(PaymentErrors.BACKDATE_NOT_PERMITTED.code);
  }, 30_000);

  /*
   * ৳1,200 against ৳3,000 owed, oldest_first, no policy named on the wire —
   * `auto` is the whole contract. Fills March TUITION (৳1,000) completely,
   * leaves ৳200 of March EXAM's ৳500 paid.
   */
  it('records a cash payment, allocated oldest_first across two lines', async () => {
    const r = await recordPayment(
      principal, // holds fee.backdate — this IS a backdated payment relative to paymentClock
      {
        studentId,
        amountMinor: '120000',
        channel: 'cash',
        collectedAt: '2027-03-05',
        allocation: { mode: 'auto' },
      },
      nextKey(),
      { clock: paymentClock },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    expect(r.value.receiptNo).toBe(1); // this school's very first receipt
    expect(r.value.amountMinor).toBe('120000');
    expect(r.value.allocations).toHaveLength(2);
    const byHead = Object.fromEntries(r.value.allocations.map((a) => [a.feeHeadName, a.amountMinor]));
    expect(byHead['Tuition']).toBe('100000');
    expect(byHead['Exam Fee']).toBe('20000');
    // ৳1,800 still owed: ৳300 of March EXAM + all of April (৳1,500).
    expect(r.value.remainingDueMinor).toBe('180000');

    const march = await admin.query<{ paid_minor: string; status: string }>(
      `SELECT paid_minor, status FROM invoice
        WHERE tenant_id=$1 AND student_id=$2 AND period_label='2027-03'`,
      [uuid(tenantId), uuid(studentId)],
    );
    expect(march.rows[0]?.paid_minor).toBe('120000');
    expect(march.rows[0]?.status).toBe('partially_paid');
  }, 60_000);

  // Manual mode targets ONE specific line, ignoring "oldest" — the April exam
  // fee gets cleared while March's partial balance sits untouched.
  it('records a manual allocation to one named line, receipt number 2', async () => {
    const outstanding = await listOutstanding(principal, studentId);
    expect(outstanding.ok).toBe(true);
    if (!outstanding.ok) return;
    const aprilExam = outstanding.value.find(
      (l) => l.feeHeadName === 'Exam Fee' && l.dueDate === '2027-04-10',
    );
    expect(aprilExam).toBeDefined();
    if (!aprilExam) return;

    const r = await recordPayment(
      principal,
      {
        studentId,
        amountMinor: '50000',
        channel: 'bank',
        channelRef: 'TXN-0042',
        collectedAt: '2027-04-02',
        allocation: { mode: 'manual', lines: [{ invoiceLineId: aprilExam.invoiceLineId, amountMinor: '50000' }] },
      },
      nextKey(),
      { clock: paymentClock },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    expect(r.value.receiptNo).toBe(2);
    expect(r.value.allocations).toEqual([
      { invoiceLineId: aprilExam.invoiceLineId, feeHeadName: 'Exam Fee', amountMinor: '50000' },
    ]);
    // ৳300 (March EXAM) + ৳1,000 (April TUITION) — April EXAM is now clear.
    expect(r.value.remainingDueMinor).toBe('130000');
  }, 60_000);

  it('replays the exact same response for a retried request with the same key', async () => {
    const key = nextKey();
    const request = {
      studentId,
      amountMinor: '10000',
      channel: 'cash' as const,
      collectedAt: '2027-04-05',
      allocation: { mode: 'auto' as const },
    };

    const first = await recordPayment(principal, request, key, { clock: paymentClock });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;

    const second = await recordPayment(principal, request, key, { clock: paymentClock });
    expect(second).toEqual(first); // byte-for-byte the same Result, not just similar

    const receiptCount = await admin.query<{ n: string }>(
      'SELECT count(*)::text n FROM payment WHERE tenant_id=$1 AND idempotency_key=$2',
      [uuid(tenantId), key],
    );
    expect(receiptCount.rows[0]?.n).toBe('1'); // exactly one payment, not two
  }, 60_000);

  it('refuses reusing a key for a materially different request', async () => {
    const key = nextKey();
    const first = await recordPayment(
      principal,
      {
        studentId,
        amountMinor: '10000',
        channel: 'cash',
        collectedAt: '2027-04-05',
        allocation: { mode: 'auto' },
      },
      key,
      { clock: paymentClock },
    );
    expect(first.ok).toBe(true);

    const reused = await recordPayment(
      principal,
      {
        studentId,
        amountMinor: '20000', // different amount, same key
        channel: 'cash',
        collectedAt: '2027-04-05',
        allocation: { mode: 'auto' },
      },
      key,
      { clock: paymentClock },
    );
    expect(reused.ok).toBe(false);
    if (!reused.ok) expect(reused.error.code).toBe(PaymentErrors.IDEMPOTENCY_KEY_REUSED.code);
  }, 60_000);

  it('refuses a payment larger than everything the student owes', async () => {
    const r = await recordPayment(
      principal,
      {
        studentId,
        amountMinor: '99999900',
        channel: 'cash',
        collectedAt: '2027-04-05',
        allocation: { mode: 'auto' },
      },
      nextKey(),
      { clock: paymentClock },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(PaymentErrors.ALLOCATION_EXCEEDS_OUTSTANDING.code);
  }, 30_000);

  it('refuses a non-cash channel with no reference', async () => {
    const r = await recordPayment(
      principal,
      {
        studentId,
        amountMinor: '1000',
        channel: 'bank',
        collectedAt: '2027-04-05',
        allocation: { mode: 'auto' },
      },
      nextKey(),
      { clock: paymentClock },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(PaymentErrors.CHANNEL_REFERENCE_REQUIRED.code);
  }, 30_000);

  /*
   * §13.4's receipt sequence, proven directly: bypass the application layer
   * and try to INSERT a second payment claiming a receipt number already in
   * use for this school and fiscal year. The database must refuse it.
   */
  it('the database itself refuses a duplicate receipt number', async () => {
    const { rows } = await admin.query<{ id: string }>(
      'SELECT id FROM payment WHERE tenant_id=$1 AND student_id=$2 ORDER BY receipt_no LIMIT 1',
      [uuid(tenantId), uuid(studentId)],
    );
    const firstPaymentId = rows[0]!.id;
    const { rows: p } = await admin.query<{ fiscal_year: number; school_id: string }>(
      'SELECT fiscal_year, school_id FROM payment WHERE id=$1',
      [firstPaymentId],
    );

    await expect(
      admin.query(
        `INSERT INTO payment
           (id, tenant_id, school_id, student_id, fiscal_year, receipt_no, amount_minor,
            channel, collected_at, collected_by, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,1,100,'cash',now(),
                 (SELECT collected_by FROM payment WHERE id=$6), $7)`,
        [
          uuid(nid()),
          uuid(tenantId),
          p[0]!.school_id,
          uuid(studentId),
          p[0]!.fiscal_year,
          firstPaymentId,
          `dup-${STAMP}`,
        ],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  }, 30_000);
});
