/**
 * Payment reversal, end to end. §13.3, §13.9's acceptance criterion 4:
 * "Refund creates a reversing row; the original receipt number stays
 * consumed."
 *
 * Same fixed-clock reasoning as `recordPayment.integration.test.ts`: every
 * ordinary reversal below is technically backdated relative to "today",
 * succeeding only because `principal` holds `fee.backdate` — the refusal
 * path gets its own dedicated test with a context that does not.
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
  reversePayment,
  ReversalErrors,
  listPaymentsForStudent,
} from '../index';
import { requestOtp, verifyOtp, resolveAuthContext } from '../../identity/index';
import { codeHasher, randomSource, tokenGenerator } from '../../identity/infrastructure/crypto';
import { Ids } from '../../../shared/ids';
import type { AuthContext, PlatformContext } from '../../../shared/auth-context';
import type {
  AcademicYearId,
  CampusId,
  ClassLevelId,
  PaymentId,
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
const PLAN_CODE = `fin-rev-${STAMP}`;
const phone = (code: string): string => `+8801${code}${String(STAMP).slice(-6)}`;
const OWNER_PHONE = phone('580');

let admin: Pool;
let principal: AuthContext;
let tenantId: string;
let schoolId: SchoolId;
let campusId: CampusId;
let yearId: AcademicYearId;
let classLevelId: ClassLevelId;
let sectionId: SectionId;
let studentId: StudentId;
let invoiceLineId: string;

const provisionClock = { now: () => new Date('2027-01-05T06:00:00.000Z') };
const paymentClock = { now: () => new Date('2027-05-01T09:00:00.000Z') };

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
    requestId: 'fin-rev-int',
    reason: 'provisioning a school for the payment-reversal integration suite',
  };

  const p = await provisionTenant(
    operator,
    {
      slug: `fin-rev-${STAMP}`,
      nameBn: 'ফেরত বিদ্যালয়',
      nameEn: 'Reversal School',
      planCode: PLAN_CODE,
      owner: { nameBn: 'শাহিন আলম', nameEn: 'Shahin Alam', phone: OWNER_PHONE },
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
    nameBn: 'ফেরত পরীক্ষা শ্রেণি',
    nameEn: 'Reversal Test Class',
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

  const structure = await createFeeStructure(principal, {
    academicYearId: yearId,
    feeHeadId: tuition.value.feeHeadId,
    classLevelId,
    amountMinor: '100000', // ৳1,000
  });
  if (!structure.ok) throw new Error('fee structure setup failed');

  const admitted = await admitStudent(principal, {
    schoolId,
    sectionId,
    academicYearId: yearId,
    nameBn: 'ফেরত ছাত্র',
    nameEn: 'Refund Student',
  });
  if (!admitted.ok) throw new Error(`admission setup failed: ${JSON.stringify(admitted)}`);
  studentId = admitted.value.studentId;

  const invoiced = await generateInvoices(principal, {
    academicYearId: yearId,
    periodLabel: '2027-03',
    issuedOn: '2027-03-01',
    dueDate: '2027-03-10',
  });
  if (!invoiced.ok) throw new Error(`invoice generation failed: ${JSON.stringify(invoiced)}`);

  const line = await admin.query<{ id: string }>(
    `SELECT il.id FROM invoice_line il JOIN invoice i ON i.id = il.invoice_id
      WHERE i.tenant_id=$1 AND i.student_id=$2`,
    [uuid(tenantId), uuid(studentId)],
  );
  invoiceLineId = Ids.fromUuid(line.rows[0]!.id);
}, 180_000);

afterAll(async () => {
  const { closeAllPools } = await import('../../../db/index');
  await closeAllPools();
  await admin?.end();
});

describe('reversePayment', () => {
  let paymentId: PaymentId;

  it('pays the invoice in full, receipt 1', async () => {
    const r = await recordPayment(
      principal,
      {
        studentId,
        amountMinor: '100000',
        channel: 'cash',
        collectedAt: '2027-03-05',
        allocation: { mode: 'auto' },
      },
      `pay-${STAMP}`,
      { clock: paymentClock },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.receiptNo).toBe(1);
    expect(r.value.remainingDueMinor).toBe('0');
    paymentId = r.value.id;

    const invoice = await admin.query<{ status: string; paid_minor: string }>(
      `SELECT status, paid_minor FROM invoice WHERE tenant_id=$1 AND student_id=$2`,
      [uuid(tenantId), uuid(studentId)],
    );
    expect(invoice.rows[0]?.status).toBe('paid');
    expect(invoice.rows[0]?.paid_minor).toBe('100000');
  }, 60_000);

  it('refuses a caller without fee.refund', async () => {
    const collector: AuthContext = {
      ...principal,
      permissions: new Set<Permission>(['fee.read', 'fee.collect', 'fee.backdate']),
    };
    await expect(
      reversePayment(collector, { paymentId, reason: 'trying without fee.refund' }, { clock: paymentClock }),
    ).rejects.toThrow(/fee\.refund/);
  }, 30_000);

  it('refuses a backdated reversal for a refunder without fee.backdate', async () => {
    const refunder: AuthContext = {
      ...principal,
      permissions: new Set<Permission>(['fee.read', 'fee.refund']),
    };
    const r = await reversePayment(
      refunder,
      { paymentId, reason: 'refunding, backdated, no fee.backdate', collectedAt: '2027-03-06' },
      { clock: paymentClock },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(ReversalErrors.BACKDATE_NOT_PERMITTED.code);
  }, 30_000);

  it('reverses the payment: a new receipt, negated allocations, the line reopens', async () => {
    const r = await reversePayment(
      principal,
      { paymentId, reason: 'family disputed the charge, refunded in full' },
      { clock: paymentClock },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    expect(r.value.id).not.toBe(paymentId);
    expect(r.value.receiptNo).toBe(2); // a NEW receipt, not the original's
    expect(r.value.amountMinor).toBe('100000'); // positive — CHECK (amount_minor > 0)
    expect(r.value.allocations).toEqual([
      { invoiceLineId, feeHeadName: 'Tuition', amountMinor: '-100000' },
    ]);
    expect(r.value.remainingDueMinor).toBe('100000'); // the ৳1,000 is owed again

    const original = await admin.query<{ reversed_by_payment_id: string | null }>(
      'SELECT reversed_by_payment_id FROM payment WHERE id=$1',
      [uuid(paymentId)],
    );
    expect(original.rows[0]?.reversed_by_payment_id).toBe(uuid(r.value.id));

    const reversing = await admin.query<{ reverses_payment_id: string; reversal_reason: string }>(
      'SELECT reverses_payment_id, reversal_reason FROM payment WHERE id=$1',
      [uuid(r.value.id)],
    );
    expect(reversing.rows[0]?.reverses_payment_id).toBe(uuid(paymentId));
    expect(reversing.rows[0]?.reversal_reason).toBe('family disputed the charge, refunded in full');

    // The ORIGINAL receipt number stays consumed — §13.9's own words. Still
    // 1, not reassigned to anything else.
    const stillOne = await admin.query<{ receipt_no: string }>(
      'SELECT receipt_no FROM payment WHERE id=$1',
      [uuid(paymentId)],
    );
    expect(stillOne.rows[0]?.receipt_no).toBe('1');

    const line = await admin.query<{ paid_minor: string }>(
      'SELECT paid_minor FROM invoice_line WHERE id=$1',
      [uuid(invoiceLineId)],
    );
    expect(line.rows[0]?.paid_minor).toBe('0');

    const invoice = await admin.query<{ status: string; paid_minor: string }>(
      `SELECT status, paid_minor FROM invoice WHERE tenant_id=$1 AND student_id=$2`,
      [uuid(tenantId), uuid(studentId)],
    );
    expect(invoice.rows[0]?.status).toBe('issued'); // back down from 'paid'
    expect(invoice.rows[0]?.paid_minor).toBe('0');
  }, 60_000);

  it('refuses to reverse the same payment twice', async () => {
    const r = await reversePayment(
      principal,
      { paymentId, reason: 'trying to reverse it again' },
      { clock: paymentClock },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(ReversalErrors.ALREADY_REVERSED.code);
  }, 30_000);

  it('refuses to reverse an unknown payment', async () => {
    const r = await reversePayment(
      principal,
      { paymentId: nid<'payment'>() as PaymentId, reason: 'reversing something that does not exist' },
      { clock: paymentClock },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(ReversalErrors.PAYMENT_NOT_FOUND.code);
  }, 30_000);

  // Proof the line genuinely reopened, not just cosmetically: a fresh
  // payment can pay it again.
  it('accepts a new payment against the line the reversal reopened', async () => {
    const r = await recordPayment(
      principal,
      {
        studentId,
        amountMinor: '100000',
        channel: 'cash',
        collectedAt: '2027-03-07',
        allocation: { mode: 'auto' },
      },
      `pay-again-${STAMP}`,
      { clock: paymentClock },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.receiptNo).toBe(3);
    expect(r.value.remainingDueMinor).toBe('0');
  }, 60_000);

  it('lists the three payments newest first, each linked to the other side of its reversal', async () => {
    const r = await listPaymentsForStudent(principal, studentId);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    expect(r.value.map((p) => p.receiptNo)).toEqual([3, 2, 1]);

    const byReceipt = new Map(r.value.map((p) => [p.receiptNo, p]));
    const original = byReceipt.get(1)!;
    const reversal = byReceipt.get(2)!;
    const fresh = byReceipt.get(3)!;

    expect(original.reversesPaymentId).toBeNull();
    expect(original.reversedByPaymentId).toBe(reversal.id);

    expect(reversal.reversesPaymentId).toBe(original.id);
    expect(reversal.reversedByPaymentId).toBeNull();

    expect(fresh.reversesPaymentId).toBeNull();
    expect(fresh.reversedByPaymentId).toBeNull();
  }, 30_000);

  it('refuses to list payments for a caller without fee.read', async () => {
    const noFinance: AuthContext = {
      ...principal,
      permissions: new Set<Permission>(['student.read']),
    };
    await expect(listPaymentsForStudent(noFinance, studentId)).rejects.toThrow(/fee\.read/);
  }, 30_000);
});
