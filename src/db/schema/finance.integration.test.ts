/**
 * The finance schema (migration 0014), proven against a real database.
 *
 * There is no use case yet to exercise these tables indirectly — every other
 * module's schema got proven as a side effect of testing `admitStudent`,
 * `promoteSection`, and so on. This is that proof, done directly: one insert
 * per table through the Drizzle definitions in `schema/finance.ts`, so a
 * column-name or type mismatch between the SQL migration and its TypeScript
 * mirror fails here rather than surfacing three weeks from now as a confusing
 * runtime error inside the first real payment use case.
 *
 * The second half deliberately violates the load-bearing CHECK constraints —
 * the ones §13 calls out as what makes the workflow unbypassable by a direct
 * write (an approved discount needs an approver, a payment reversal needs a
 * reason). Each one is checked by breaking it, the same discipline the rest
 * of this codebase applies to application-level guards.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { provisionTenant } from '../../modules/platform/index';
import { createSection, getStructure } from '../../modules/structure/index';
import { admitStudent } from '../../modules/directory/index';
import { withTenant } from '../rls';
import {
  feeHead,
  feeStructure,
  discount,
  invoice,
  invoiceLine,
  receiptSequence,
  collectionSession,
  payment,
  paymentAllocation,
  lateFeeAccrual,
  idempotencyKey,
} from './finance';
import { Ids } from '../../shared/ids';
import { LocalDate } from '../../shared/date';
import type { PlatformContext, AuthContext } from '../../shared/auth-context';
import type {
  AcademicYearId,
  CampusId,
  ClassLevelId,
  SchoolId,
  SectionId,
  ShiftId,
  StudentId,
} from '../../shared/ids';
import { PERMISSIONS } from '../../shared/permissions';

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR;
const PLATFORM_URL = process.env.DATABASE_URL_PLATFORM;

const nid = <T extends string = 'x'>() => Ids.generate<T>();
const uuid = (v: string) => Ids.toUuid(v as never);

const STAMP = Date.now();
const PLAN_CODE = `finance-${STAMP}`;
const phone = (code: string): string => `+8801${code}${String(STAMP).slice(-6)}`;
const OWNER_PHONE = phone('560');

let admin: Pool;
let principal: AuthContext;
let schoolId: SchoolId;
let year: AcademicYearId;
let sectionA: SectionId;
let studentId: StudentId;

const clock = { now: () => new Date('2027-03-14T06:00:00.000Z') };

/**
 * A raw Postgres check-violation error carries the constraint name — but
 * Drizzle wraps it in its own `DrizzleQueryError` first, with the actual `pg`
 * error nested under `.cause`. Asserting on the top level alone passes for
 * ANY rejection, including a typo in the constraint name being checked; this
 * unwraps it so the assertion is on the thing that actually proves the
 * constraint fired.
 */
async function expectCheckViolation(p: Promise<unknown>, constraint: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ cause: { code: '23514', constraint } });
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
    requestId: 'finance-schema-int',
    reason: 'provisioning a school for the finance schema suite',
  };

  const p = await provisionTenant(
    operator,
    {
      slug: `finance-${STAMP}`,
      nameBn: 'অর্থ বিদ্যালয়',
      nameEn: 'Finance School',
      planCode: PLAN_CODE,
      owner: { nameBn: 'ফরিদা খাতুন', nameEn: 'Farida Khatun', phone: OWNER_PHONE },
    },
    { clock },
  );
  if (!p.ok) throw new Error(`provisioning failed: ${JSON.stringify(p)}`);
  schoolId = p.value.schoolId;

  const { requestOtp, verifyOtp, resolveAuthContext } = await import('../../modules/identity/index');
  const { codeHasher, randomSource, tokenGenerator } = await import(
    '../../modules/identity/infrastructure/crypto'
  );

  let code: string | undefined;
  await requestOtp(
    { identifier: OWNER_PHONE },
    { codeHasher, random: randomSource, dispatcher: { send: async (_to, c) => void (code = c) } },
  );
  if (!code) throw new Error('no OTP for owner');
  const s = await verifyOtp(
    { identifier: OWNER_PHONE, code },
    { codeHasher, tokens: tokenGenerator },
  );
  if (!s.ok) throw new Error(`login failed: ${JSON.stringify(s)}`);
  const ctx = await resolveAuthContext(s.value.sessionToken, { tokens: tokenGenerator });
  if (!ctx.ok) throw new Error(`context failed: ${JSON.stringify(ctx)}`);
  principal = ctx.value;

  const structure = await getStructure(principal);
  if (!structure.ok) throw new Error('structure read failed');
  year = structure.value.currentYear!.id as AcademicYearId;
  const campusId = structure.value.campuses[0]!.id as CampusId;
  const shiftId = structure.value.shifts[0]!.id as ShiftId;
  const level = structure.value.classLevels.find((l) => l.nameEn === 'Class 6')!;

  const sec = await createSection(principal, {
    schoolId,
    classLevelId: level.id as ClassLevelId,
    campusId,
    shiftId,
    nameBn: 'ক',
    nameEn: 'A',
  });
  if (!sec.ok) throw new Error(`section failed: ${JSON.stringify(sec)}`);
  sectionA = sec.value.sectionId;

  const admitted = await admitStudent(
    principal,
    {
      schoolId,
      sectionId: sectionA,
      academicYearId: year,
      nameBn: 'শিক্ষার্থী',
      nameEn: 'Fee Test Student',
    },
    { clock },
  );
  if (!admitted.ok) throw new Error(`admission failed: ${JSON.stringify(admitted)}`);
  studentId = admitted.value.studentId;
}, 180_000);

afterAll(async () => {
  const { closeAllPools } = await import('../index');
  await closeAllPools();
  await admin?.end();
});

describe('every finance table accepts a real row through its Drizzle definition', () => {
  it('writes one row per table and reads each one back correctly typed', async () => {
    await withTenant(principal, async (tx) => {
      const feeHeadId = nid<'feeHead'>();
      await tx.insert(feeHead).values({
        id: feeHeadId,
        code: 'TUITION',
        nameBn: 'বেতন',
        nameEn: 'Tuition',
        frequency: 'monthly',
        isRefundable: false,
        sequence: 1,
      });
      const [readHead] = await tx.select().from(feeHead).where(eq(feeHead.id, feeHeadId));
      expect(readHead?.isRefundable).toBe(false);
      expect(readHead?.frequency).toBe('monthly');

      const feeStructureId = nid<'feeStructure'>();
      await tx.insert(feeStructure).values({
        id: feeStructureId,
        academicYearId: year,
        feeHeadId,
        sectionId: sectionA,
        // Below MAX_SAFE_INTEGER on purpose — Money.minor is bigint precisely
        // so a real fee (however large) never risks float precision, but this
        // is the schema test, not the money-boundary test.
        amountMinor: 150000n,
      });
      const [readStructure] = await tx
        .select()
        .from(feeStructure)
        .where(eq(feeStructure.id, feeStructureId));
      // A bigint column round-trips as a JS bigint, not a number — the whole
      // reason `moneyMinor` exists (invariant 2: `/100` on a bigint is a
      // compile error, not a silent rounding bug).
      expect(typeof readStructure?.amountMinor).toBe('bigint');
      expect(readStructure?.amountMinor).toBe(150000n);

      const approverId = principal.personId;
      const discountId = nid<'discount'>();
      await tx.insert(discount).values({
        id: discountId,
        studentId,
        kind: 'sibling',
        percent: '10.00',
        validFrom: LocalDate.of(2027, 3, 1),
        reason: 'second child at the school',
        requestedBy: approverId,
        approvedBy: approverId,
        approvedAt: new Date(),
        status: 'approved',
      });

      const invoiceId = nid<'invoice'>();
      await tx.insert(invoice).values({
        id: invoiceId,
        studentId,
        academicYearId: year,
        periodLabel: '2027-03',
        issuedOn: LocalDate.of(2027, 3, 1),
        dueDate: LocalDate.of(2027, 3, 10),
        totalMinor: 150000n,
      });

      const invoiceLineId = nid<'invoiceLine'>();
      await tx.insert(invoiceLine).values({
        id: invoiceLineId,
        invoiceId,
        feeHeadId,
        description: 'Tuition — March 2027',
        amountMinor: 150000n,
      });

      // The gapless counter — a plain row, not the locking transaction
      // (§13.4 belongs to the use case this PR deliberately does not build).
      await tx.insert(receiptSequence).values({
        schoolId,
        fiscalYear: 2027,
      });
      const [seq] = await tx
        .select()
        .from(receiptSequence)
        .where(eq(receiptSequence.schoolId, schoolId));
      expect(seq?.nextValue).toBe(1n);

      const sessionId = nid<'collectionSession'>();
      await tx.insert(collectionSession).values({
        id: sessionId,
        collectorPersonId: principal.personId,
        schoolId,
        businessDate: LocalDate.of(2027, 3, 14),
        expectedMinor: 150000n,
        countedMinor: 150000n,
        varianceMinor: 0n,
      });

      const paymentId = nid<'payment'>();
      await tx.insert(payment).values({
        id: paymentId,
        schoolId,
        studentId,
        fiscalYear: 2027,
        receiptNo: 1n,
        amountMinor: 150000n,
        channel: 'cash',
        collectedAt: new Date(),
        collectedBy: principal.personId,
        collectionSessionId: sessionId,
        idempotencyKey: `test-${STAMP}-1`,
      });
      const [readPayment] = await tx.select().from(payment).where(eq(payment.id, paymentId));
      expect(readPayment?.receiptNo).toBe(1n);

      await tx.insert(paymentAllocation).values({
        id: nid<'paymentAllocation'>(),
        paymentId,
        invoiceLineId,
        amountMinor: 150000n,
      });

      await tx.insert(lateFeeAccrual).values({
        id: nid<'lateFeeAccrual'>(),
        invoiceId,
        accruedOn: LocalDate.of(2027, 3, 20),
        amountMinor: 5000n,
        ruleSnapshot: { percentPerDay: '1.0' },
        waivedBy: principal.personId,
        waivedAt: new Date(),
        waiveReason: 'first offence, waived as a courtesy',
      });

      await tx.insert(idempotencyKey).values({
        key: `test-${STAMP}-key`,
        endpoint: '/api/v1/payments',
        requestHash: Buffer.from('deadbeef', 'hex'),
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    });
  }, 60_000);
});

describe('the load-bearing CHECK constraints actually hold', () => {
  it('refuses an approved discount with no approver', async () => {
    await expectCheckViolation(
      withTenant(principal, (tx) =>
        tx.insert(discount).values({
          id: nid<'discount'>(),
          studentId,
          kind: 'merit',
          percent: '5.00',
          validFrom: LocalDate.of(2027, 3, 1),
          reason: 'no approver on purpose',
          status: 'approved',
          // approvedBy omitted — the whole point of this test.
        }),
      ),
      'discount_approved_has_approver',
    );
  }, 30_000);

  it('refuses a discount naming both a fixed amount and a percent', async () => {
    await expectCheckViolation(
      withTenant(principal, (tx) =>
        tx.insert(discount).values({
          id: nid<'discount'>(),
          studentId,
          kind: 'need',
          valueMinor: 1000n,
          percent: '5.00',
          validFrom: LocalDate.of(2027, 3, 1),
          reason: 'both set on purpose',
          status: 'pending',
        }),
      ),
      'discount_exactly_one_value',
    );
  }, 30_000);

  it('refuses a fee structure scoped to neither a class nor a section', async () => {
    await expectCheckViolation(
      withTenant(principal, async (tx) => {
        const [head] = await tx
          .select()
          .from(feeHead)
          .where(eq(feeHead.tenantId, feeHead.tenantId))
          .limit(1);
        return tx.insert(feeStructure).values({
          id: nid<'feeStructure'>(),
          academicYearId: year,
          feeHeadId: head!.id,
          amountMinor: 1000n,
          // classLevelId AND sectionId both omitted on purpose.
        });
      }),
      'fee_structure_exactly_one_scope',
    );
  }, 30_000);

  it('refuses an invoice claiming more paid than it could owe', async () => {
    await expectCheckViolation(
      withTenant(principal, (tx) =>
        tx.insert(invoice).values({
          id: nid<'invoice'>(),
          studentId,
          academicYearId: year,
          periodLabel: '2027-04',
          issuedOn: LocalDate.of(2027, 4, 1),
          dueDate: LocalDate.of(2027, 4, 10),
          totalMinor: 1000n,
          paidMinor: 5000n, // more than total — on purpose
        }),
      ),
      'invoice_paid_within_bounds',
    );
  }, 30_000);

  it('refuses a payment reversal with no reason', async () => {
    await expectCheckViolation(
      withTenant(principal, async (tx) => {
        const original = nid<'payment'>();
        await tx.insert(payment).values({
          id: original,
          schoolId,
          studentId,
          fiscalYear: 2027,
          receiptNo: 900n,
          amountMinor: 1000n,
          channel: 'cash',
          collectedAt: new Date(),
          collectedBy: principal.personId,
          idempotencyKey: `test-${STAMP}-reversal-src`,
        });
        return tx.insert(payment).values({
          id: nid<'payment'>(),
          schoolId,
          studentId,
          fiscalYear: 2027,
          receiptNo: 901n,
          amountMinor: 1000n,
          channel: 'cash',
          collectedAt: new Date(),
          collectedBy: principal.personId,
          idempotencyKey: `test-${STAMP}-reversal-dst`,
          reversesPaymentId: original,
          // reversalReason omitted — the whole point of this test.
        });
      }),
      'payment_reversal_has_reason',
    );
  }, 30_000);

  it('refuses a non-cash payment with no channel reference', async () => {
    await expectCheckViolation(
      withTenant(principal, (tx) =>
        tx.insert(payment).values({
          id: nid<'payment'>(),
          schoolId,
          studentId,
          fiscalYear: 2027,
          receiptNo: 902n,
          amountMinor: 1000n,
          channel: 'bank',
          collectedAt: new Date(),
          collectedBy: principal.personId,
          idempotencyKey: `test-${STAMP}-no-ref`,
          // channelRef omitted — a bank payment with nothing to reconcile
          // against, which is exactly what this constraint exists to refuse.
        }),
      ),
      'payment_channel_ref_required',
    );
  }, 30_000);

  it('refuses a collection session with an unexplained variance', async () => {
    await expectCheckViolation(
      withTenant(principal, (tx) =>
        tx.insert(collectionSession).values({
          id: nid<'collectionSession'>(),
          collectorPersonId: principal.personId,
          schoolId,
          businessDate: LocalDate.of(2027, 3, 21),
          expectedMinor: 5000n,
          countedMinor: 4950n,
          varianceMinor: -50n,
          // varianceReason omitted — a ৳50 shortfall the system must not
          // round away silently (§13.3).
        }),
      ),
      'collection_session_variance_has_reason',
    );
  }, 30_000);
});
