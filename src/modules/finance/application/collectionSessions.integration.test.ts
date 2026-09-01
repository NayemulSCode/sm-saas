/**
 * Collection sessions, end to end, and their wiring into payment recording
 * and reversal. §13.3, §13.7.
 *
 * Each scenario below uses its OWN business date (a distinct clock) —
 * `collection_session` is `UNIQUE (tenant_id, collector_person_id,
 * business_date)`, one drawer per person per day, so testing "open a
 * session while one is already open" and "open a fresh one tomorrow" need
 * to be genuinely different days, not just different assertions.
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
  openCollectionSession,
  closeCollectionSession,
  verifyCollectionSession,
  CollectionSessionErrors,
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
const PLAN_CODE = `fin-cs-${STAMP}`;
const phone = (code: string): string => `+8801${code}${String(STAMP).slice(-6)}`;
const OWNER_PHONE = phone('590');

let admin: Pool;
let principal: AuthContext;
let tenantId: string;
let schoolId: SchoolId;
let campusId: CampusId;
let yearId: AcademicYearId;
let classLevelId: ClassLevelId;
let sectionId: SectionId;
let studentA: StudentId;
let studentB: StudentId;

const provisionClock = { now: () => new Date('2027-01-05T06:00:00.000Z') };
/** Already wrapped as `{ clock }` — every use case here takes `deps` in that
 *  shape, so call sites just pass this straight through. */
const clockOn = (iso: string) => ({ clock: { now: () => new Date(`${iso}T09:00:00.000Z`) } });

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
    requestId: 'fin-cs-int',
    reason: 'provisioning a school for the collection-session integration suite',
  };

  const p = await provisionTenant(
    operator,
    {
      slug: `fin-cs-${STAMP}`,
      nameBn: 'আদায় বিদ্যালয়',
      nameEn: 'Collection School',
      planCode: PLAN_CODE,
      owner: { nameBn: 'জাহিদ হাসান', nameEn: 'Zahid Hasan', phone: OWNER_PHONE },
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
    nameBn: 'আদায় পরীক্ষা শ্রেণি',
    nameEn: 'Collection Test Class',
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
  studentA = await admitOne('Session Student A');
  studentB = await admitOne('Session Student B');

  const invoiced = await generateInvoices(principal, {
    academicYearId: yearId,
    periodLabel: '2027-05',
    issuedOn: '2027-05-01',
    dueDate: '2027-05-31',
  });
  if (!invoiced.ok) throw new Error(`invoice generation failed: ${JSON.stringify(invoiced)}`);
}, 180_000);

afterAll(async () => {
  const { closeAllPools } = await import('../../../db/index');
  await closeAllPools();
  await admin?.end();
});

describe('collection sessions', () => {
  it('refuses opening without fee.collect', async () => {
    const weak: AuthContext = { ...principal, permissions: new Set<Permission>(['fee.read']) };
    await expect(
      openCollectionSession(weak, { schoolId }, clockOn('2027-05-01')),
    ).rejects.toThrow(/fee\.collect/);
  }, 30_000);

  it('opens a session, refuses a second one the same day, cash attaches and bank does not', async () => {
    const day = clockOn('2027-05-01');

    const opened = await openCollectionSession(principal, { schoolId }, day);
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.status).toBe('open');
    const sessionId = opened.value.id;

    const again = await openCollectionSession(principal, { schoolId }, day);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe(CollectionSessionErrors.SESSION_ALREADY_OPEN.code);

    const cash1 = await recordPayment(
      principal,
      { studentId: studentA, amountMinor: '40000', channel: 'cash', collectedAt: '2027-05-01', allocation: { mode: 'auto' } },
      `cs-cash1-${STAMP}`,
      day,
    );
    expect(cash1.ok, JSON.stringify(cash1)).toBe(true);
    if (!cash1.ok) return;

    const bank = await recordPayment(
      principal,
      {
        studentId: studentB,
        amountMinor: '50000',
        channel: 'bank',
        channelRef: 'TXN-CS-1',
        collectedAt: '2027-05-01',
        allocation: { mode: 'auto' },
      },
      `cs-bank-${STAMP}`,
      day,
    );
    expect(bank.ok, JSON.stringify(bank)).toBe(true);
    if (!bank.ok) return;

    const cash2 = await recordPayment(
      principal,
      { studentId: studentA, amountMinor: '30000', channel: 'cash', collectedAt: '2027-05-01', allocation: { mode: 'auto' } },
      `cs-cash2-${STAMP}`,
      day,
    );
    expect(cash2.ok, JSON.stringify(cash2)).toBe(true);
    if (!cash2.ok) return;

    const attached = await admin.query<{ id: string; collection_session_id: string | null }>(
      'SELECT id, collection_session_id FROM payment WHERE tenant_id=$1 AND idempotency_key=ANY($2)',
      [uuid(tenantId), [`cs-cash1-${STAMP}`, `cs-bank-${STAMP}`, `cs-cash2-${STAMP}`]],
    );
    const byId = new Map(attached.rows.map((r) => [r.id, r.collection_session_id]));
    expect(byId.get(uuid(cash1.value.id))).toBe(uuid(sessionId));
    expect(byId.get(uuid(bank.value.id))).toBeNull();
    expect(byId.get(uuid(cash2.value.id))).toBe(uuid(sessionId));

    // ৳400 + ৳300 cash, exactly — closing with a matching count needs no
    // variance reason at all.
    const closed = await closeCollectionSession(
      principal,
      { sessionId, countedMinor: '70000' },
      day,
    );
    expect(closed.ok, JSON.stringify(closed)).toBe(true);
    if (!closed.ok) return;
    expect(closed.value.status).toBe('closed');
    expect(closed.value.expectedMinor).toBe('70000');
    expect(closed.value.countedMinor).toBe('70000');
    expect(closed.value.varianceMinor).toBe('0');

    // A closed session refuses a NEW cash payment — the office assistant's
    // drawer for the day is done.
    const afterClose = await recordPayment(
      principal,
      { studentId: studentA, amountMinor: '10000', channel: 'cash', collectedAt: '2027-05-01', allocation: { mode: 'auto' } },
      `cs-cash3-${STAMP}`,
      day,
    );
    expect(afterClose.ok).toBe(false);
    if (!afterClose.ok) expect(afterClose.error.code).toBe(PaymentErrors.SESSION_CLOSED.code);

    const closeAgain = await closeCollectionSession(
      principal,
      { sessionId, countedMinor: '70000' },
      day,
    );
    expect(closeAgain.ok).toBe(false);
    if (!closeAgain.ok) expect(closeAgain.error.code).toBe(CollectionSessionErrors.SESSION_NOT_OPEN.code);

    const verified = await verifyCollectionSession(principal, {
      sessionId,
      depositReference: 'DEP-0001',
    });
    expect(verified.ok, JSON.stringify(verified)).toBe(true);
    if (!verified.ok) return;
    expect(verified.value.status).toBe('verified');

    const verifyAgain = await verifyCollectionSession(principal, { sessionId });
    expect(verifyAgain.ok).toBe(false);
    if (!verifyAgain.ok) expect(verifyAgain.error.code).toBe(CollectionSessionErrors.SESSION_NOT_CLOSED.code);
  }, 60_000);

  it('records a shortfall: refuses to close without a reason, accepts one with', async () => {
    const day = clockOn('2027-05-02');

    const opened = await openCollectionSession(principal, { schoolId }, day);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const cash = await recordPayment(
      principal,
      { studentId: studentB, amountMinor: '50000', channel: 'cash', collectedAt: '2027-05-02', allocation: { mode: 'auto' } },
      `cs-short-${STAMP}`,
      day,
    );
    expect(cash.ok, JSON.stringify(cash)).toBe(true);

    // ৳50 short of the ৳500 expected.
    const withoutReason = await closeCollectionSession(
      principal,
      { sessionId: opened.value.id, countedMinor: '49500' },
      day,
    );
    expect(withoutReason.ok).toBe(false);
    if (!withoutReason.ok) {
      expect(withoutReason.error.code).toBe(CollectionSessionErrors.VARIANCE_REASON_REQUIRED.code);
    }

    const withReason = await closeCollectionSession(
      principal,
      { sessionId: opened.value.id, countedMinor: '49500', varianceReason: 'one ৳50 note miscounted at handover' },
      day,
    );
    expect(withReason.ok, JSON.stringify(withReason)).toBe(true);
    if (!withReason.ok) return;
    expect(withReason.value.varianceMinor).toBe('-500'); // ৳5 short, in poisha
  }, 60_000);

  it('refuses verifying a session that is still open', async () => {
    const day = clockOn('2027-05-03');
    const opened = await openCollectionSession(principal, { schoolId }, day);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const r = await verifyCollectionSession(principal, { sessionId: opened.value.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(CollectionSessionErrors.SESSION_NOT_CLOSED.code);
  }, 30_000);

  it('refuses verifying without fee.reconcile', async () => {
    const day = clockOn('2027-05-04');
    const opened = await openCollectionSession(principal, { schoolId }, day);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const closed = await closeCollectionSession(principal, { sessionId: opened.value.id, countedMinor: '0' }, day);
    expect(closed.ok).toBe(true);

    const weak: AuthContext = {
      ...principal,
      permissions: new Set<Permission>(['fee.read', 'fee.collect']),
    };
    await expect(
      verifyCollectionSession(weak, { sessionId: opened.value.id }),
    ).rejects.toThrow(/fee\.reconcile/);
  }, 30_000);

  it('a reversal attaches to the CURRENT open session, not the original payment’s (now closed) one', async () => {
    const collectDay = clockOn('2027-05-05');
    const refundDay = clockOn('2027-05-06');

    const collectSession = await openCollectionSession(principal, { schoolId }, collectDay);
    expect(collectSession.ok).toBe(true);
    if (!collectSession.ok) return;

    const cash = await recordPayment(
      principal,
      { studentId: studentA, amountMinor: '20000', channel: 'cash', collectedAt: '2027-05-05', allocation: { mode: 'auto' } },
      `cs-refund-src-${STAMP}`,
      collectDay,
    );
    expect(cash.ok, JSON.stringify(cash)).toBe(true);
    if (!cash.ok) return;

    const closedCollectSession = await closeCollectionSession(
      principal,
      { sessionId: collectSession.value.id, countedMinor: '20000' },
      collectDay,
    );
    expect(closedCollectSession.ok).toBe(true);

    // A NEW session, a different day — this is the one the refund should land in.
    const refundSession = await openCollectionSession(principal, { schoolId }, refundDay);
    expect(refundSession.ok).toBe(true);
    if (!refundSession.ok) return;

    const reversal = await reversePayment(
      principal,
      { paymentId: cash.value.id, reason: 'refunded in cash the next day' },
      refundDay,
    );
    expect(reversal.ok, JSON.stringify(reversal)).toBe(true);
    if (!reversal.ok) return;

    const row = await admin.query<{ collection_session_id: string | null }>(
      'SELECT collection_session_id FROM payment WHERE id=$1',
      [uuid(reversal.value.id)],
    );
    expect(row.rows[0]?.collection_session_id).toBe(uuid(refundSession.value.id));

    // The refund left the drawer, so the session's own cash total is net
    // NEGATIVE the ৳200 that went back out.
    const total = await closeCollectionSession(
      principal,
      { sessionId: refundSession.value.id, countedMinor: '-20000' },
      refundDay,
    );
    expect(total.ok, JSON.stringify(total)).toBe(true);
    if (!total.ok) return;
    expect(total.value.expectedMinor).toBe('-20000');
    expect(total.value.varianceMinor).toBe('0');
  }, 60_000);

  /*
   * §13.3's own CHECK, proven directly: bypass the application and try to
   * record a non-zero variance with no reason.
   */
  it('the database itself refuses a non-zero variance with no reason', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `SELECT id FROM collection_session WHERE tenant_id=$1 AND variance_reason IS NULL LIMIT 1`,
      [uuid(tenantId)],
    );
    await expect(
      admin.query(`UPDATE collection_session SET variance_minor = 100 WHERE id = $1`, [rows[0]!.id]),
    ).rejects.toMatchObject({ code: '23514' });
  }, 30_000);
});
