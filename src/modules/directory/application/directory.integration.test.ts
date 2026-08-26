/**
 * The directory module, end to end.
 *
 * The two that matter most are the ones §14.5 calls out: `promoteSection`,
 * "the riskiest bulk operation in the product", together with its undo; and
 * `mergePersons`, which repoints every reference from one human to another and
 * has to be reversible.
 *
 * The school is provisioned and configured through the real use cases, so the
 * fixture is the production path from `provisionTenant` down.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { provisionTenant } from '../../platform/index';
import { createSection, getStructure } from '../../structure/index';
import { requestOtp, verifyOtp, resolveAuthContext } from '../../identity/index';
import { codeHasher, randomSource, tokenGenerator } from '../../identity/infrastructure/crypto';
import {
  admitStudent,
  transitionStudentStatus,
  withdrawStudent,
  promoteSection,
  undoPromotion,
  linkGuardian,
  unlinkGuardian,
  linkSiblings,
  mergePersons,
  unmergePersons,
  getStudent,
  AdmissionErrors,
  TransitionErrors,
  PromotionErrors,
  GuardianErrors,
  MergeErrors,
} from '../index';
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
  StudentId,
} from '../../../shared/ids';
import { PERMISSIONS, type Permission } from '../../../shared/permissions';

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR;
const PLATFORM_URL = process.env.DATABASE_URL_PLATFORM;

const nid = <T extends string = 'x'>() => Ids.generate<T>();
const uuid = (v: string) => Ids.toUuid(v as never);

const STAMP = Date.now();
const PLAN_CODE = `dir-${STAMP}`;
const OWNER_PHONE = '+8801766000111';

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
async function makePerson(nameEn: string, phone?: string): Promise<PersonId> {
  const id = nid<'person'>();
  await admin.query(
    `INSERT INTO person (id, tenant_id, name_bn, name_en, phone)
     VALUES ($1,$2,'অভিভাবক',$3,$4)`,
    [uuid(id), uuid(tenantId), nameEn, phone ?? null],
  );
  return id;
}

const admit = async (nameEn: string, section: SectionId = class6, rollNo?: number) => {
  const r = await admitStudent(
    principal,
    {
      schoolId,
      sectionId: section,
      academicYearId: year2027,
      nameBn: 'শিক্ষার্থী',
      nameEn,
      ...(rollNo !== undefined ? { rollNo } : {}),
    },
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
    requestId: 'dir-int',
    reason: 'provisioning a school for the directory integration suite',
  };

  const p = await provisionTenant(
    operator,
    {
      slug: `dir-${STAMP}`,
      nameBn: 'তালিকা বিদ্যালয়',
      nameEn: 'Directory School',
      planCode: PLAN_CODE,
      owner: { nameBn: 'শিরিন আক্তার', nameEn: 'Shirin Akter', phone: OWNER_PHONE },
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

  // Next year, so promotion has somewhere to go.
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

describe('admitting a student', () => {
  it('creates person, student, enrolment and the first status event together', async () => {
    const r = await admit('Rafiq Islam', class6, 1);

    expect(r.studentCode).toMatch(/^2027-\d{4}$/);

    const t = uuid(tenantId);
    const person = await admin.query(`SELECT 1 FROM person WHERE id=$1 AND tenant_id=$2`, [
      uuid(r.personId),
      t,
    ]);
    expect(person.rowCount).toBe(1);

    const events = await admin.query<{ from_status: string | null; to_status: string }>(
      'SELECT from_status, to_status FROM student_status_event WHERE student_id=$1',
      [uuid(r.studentId)],
    );
    // The history is complete from row one, not from the first change.
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.from_status).toBeNull();
    expect(events.rows[0]?.to_status).toBe('active');

    const enrol = await admin.query<{ roll_no: number }>(
      'SELECT roll_no FROM enrolment WHERE id=$1',
      [uuid(r.enrolmentId)],
    );
    expect(enrol.rows[0]?.roll_no).toBe(1);
  }, 60_000);

  it('issues sequential codes without collision', async () => {
    const a = await admit('Sequential One');
    const b = await admit('Sequential Two');
    expect(a.studentCode).not.toBe(b.studentCode);
    expect(Number(b.studentCode.split('-')[1])).toBe(Number(a.studentCode.split('-')[1]) + 1);
  }, 60_000);

  it('refuses a section that is not in this school', async () => {
    const r = await admitStudent(
      principal,
      {
        schoolId,
        sectionId: nid<'section'>() as SectionId,
        academicYearId: year2027,
        nameBn: 'ক',
        nameEn: 'Nowhere',
      },
      { clock },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(AdmissionErrors.SECTION_NOT_FOUND.code);
  }, 60_000);

  // The unique constraint would refuse the second admission at the counter.
  it('refuses a code pattern with no sequence token', async () => {
    const r = await admitStudent(
      principal,
      {
        schoolId,
        sectionId: class6,
        academicYearId: year2027,
        nameBn: 'ক',
        nameEn: 'Bad Pattern',
        codePattern: 'DMS-{YYYY}',
      },
      { clock },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(AdmissionErrors.INVALID_CODE_PATTERN.code);
  }, 60_000);
});

describe('the student lifecycle', () => {
  let studentId: StudentId;

  beforeAll(async () => {
    studentId = (await admit('Lifecycle Test')).studentId;
  });

  it('records every transition with actor and reason', async () => {
    const r = await transitionStudentStatus(
      principal,
      { studentId, to: 'on_leave', reason: 'family travelling abroad for a term' },
      { clock },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const { rows } = await admin.query<{
      to_status: string;
      reason: string;
      actor_person_id: string;
    }>(
      `SELECT to_status, reason, actor_person_id FROM student_status_event
       WHERE student_id=$1 AND to_status='on_leave'`,
      [uuid(studentId)],
    );
    expect(rows[0]?.reason).toBe('family travelling abroad for a term');
    expect(rows[0]?.actor_person_id).toBe(uuid(principal.personId));
  }, 60_000);

  /*
   * The CHECK constraint permits this value; the school does not. Nothing in
   * SQL stops a student going back to being an applicant.
   */
  it('refuses an illegal transition', async () => {
    const r = await transitionStudentStatus(principal, { studentId, to: 'applicant' }, { clock });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(TransitionErrors.ILLEGAL_TRANSITION.code);
  }, 60_000);

  it('refuses a no-op rather than writing an event that claims a change', async () => {
    const r = await transitionStudentStatus(principal, { studentId, to: 'on_leave' }, { clock });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(TransitionErrors.ALREADY_IN_STATUS.code);
  }, 60_000);

  it('demands a reason for withdrawal', async () => {
    const r = await transitionStudentStatus(
      principal,
      { studentId, to: 'withdrawn', reason: '  ' },
      { clock },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(TransitionErrors.REASON_REQUIRED.code);
  }, 60_000);

  it('withdraws, stamping the date column', async () => {
    const r = await withdrawStudent(
      principal,
      { studentId, reason: 'moved to another district' },
      { clock },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const { rows } = await admin.query<{ status: string; withdrawn_on: string }>(
      'SELECT status, withdrawn_on::text AS withdrawn_on FROM student WHERE id=$1',
      [uuid(studentId)],
    );
    expect(rows[0]?.status).toBe('withdrawn');
    expect(rows[0]?.withdrawn_on).toBe('2027-03-14');
  }, 60_000);

  // FR-4.7 — one record, or the child's history and sibling discount both split.
  it('allows readmission of a withdrawn student', async () => {
    const r = await transitionStudentStatus(principal, { studentId, to: 'active' }, { clock });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }, 60_000);

  it('reads back the whole history in one call', async () => {
    const r = await getStudent(principal, studentId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const view = r.value as { history: unknown[]; enrolments: unknown[] };
    expect(view.history.length).toBeGreaterThanOrEqual(4);
    expect(view.enrolments).toHaveLength(1);
  }, 60_000);
});

describe('guardians', () => {
  let studentId: StudentId;
  let father: PersonId;
  let mother: PersonId;

  beforeAll(async () => {
    studentId = (await admit('Guardian Test')).studentId;
    father = await makePerson('Karim Ahmed', '+8801799000001');
    mother = await makePerson('Nasima Ahmed', '+8801799000002');
  });

  /*
   * The separated-parent case the flags exist for: the father pays, the mother
   * is contacted. A single "primary guardian" forces a wrong answer here.
   */
  it('lets one parent bill while the other is the contact', async () => {
    const a = await linkGuardian(principal, {
      studentId,
      guardianPersonId: father,
      relationship: 'father',
      isBillingGuardian: true,
    });
    expect(a.ok, JSON.stringify(a)).toBe(true);

    const b = await linkGuardian(principal, {
      studentId,
      guardianPersonId: mother,
      relationship: 'mother',
      isPrimaryContact: true,
    });
    expect(b.ok, JSON.stringify(b)).toBe(true);
    if (b.ok) expect(b.value.demoted).toEqual([]);

    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text n FROM guardian_link
       WHERE student_id=$1 AND deleted_at IS NULL`,
      [uuid(studentId)],
    );
    expect(rows[0]?.n).toBe('2');
  }, 60_000);

  it('demotes the incumbent when a third guardian claims billing', async () => {
    const uncle = await makePerson('Jamal Ahmed', '+8801799000003');
    const r = await linkGuardian(principal, {
      studentId,
      guardianPersonId: uncle,
      relationship: 'guardian',
      isBillingGuardian: true,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.value.demoted).toHaveLength(1);

    // Still exactly one biller — the partial unique index would have refused
    // the insert if the incumbent had not stepped down first.
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text n FROM guardian_link
       WHERE student_id=$1 AND is_billing_guardian AND deleted_at IS NULL`,
      [uuid(studentId)],
    );
    expect(rows[0]?.n).toBe('1');
  }, 60_000);

  it('refuses to bill an emergency contact', async () => {
    const neighbour = await makePerson('Neighbour', '+8801799000004');
    const r = await linkGuardian(principal, {
      studentId,
      guardianPersonId: neighbour,
      relationship: 'emergency',
      isBillingGuardian: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(GuardianErrors.EMERGENCY_CANNOT_BILL.code);
  }, 60_000);

  it('refuses the same guardian twice', async () => {
    const r = await linkGuardian(principal, {
      studentId,
      guardianPersonId: father,
      relationship: 'father',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(GuardianErrors.ALREADY_LINKED.code);
  }, 60_000);

  /*
   * A student with no contactable guardian is unreachable, and the consequence
   * shows up weeks later looking like the SMS system being broken.
   */
  it('refuses to remove the last guardian', async () => {
    const lonely = (await admit('Only Child')).studentId;
    const only = await makePerson('Sole Guardian', '+8801799000005');
    await linkGuardian(principal, {
      studentId: lonely,
      guardianPersonId: only,
      relationship: 'mother',
      isBillingGuardian: true,
    });

    const r = await unlinkGuardian(principal, {
      studentId: lonely,
      guardianPersonId: only,
      reason: 'trying to remove the only contact',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(GuardianErrors.LAST_CONTACT.code);
  }, 60_000);

  it('refuses to leave a student with nobody to invoice', async () => {
    const { rows } = await admin.query<{ guardian_person_id: string }>(
      `SELECT guardian_person_id FROM guardian_link
       WHERE student_id=$1 AND is_billing_guardian AND deleted_at IS NULL`,
      [uuid(studentId)],
    );
    const biller = Ids.fromUuid<'person'>(rows[0]!.guardian_person_id);

    const r = await unlinkGuardian(principal, {
      studentId,
      guardianPersonId: biller,
      reason: 'removing the billing guardian',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(GuardianErrors.WOULD_LEAVE_NO_BILLER.code);
  }, 60_000);

  // FR-4.8 — one group per student, or a sibling discount applies twice.
  it('puts two siblings in one group', async () => {
    const a = (await admit('Sibling One')).studentId;
    const b = (await admit('Sibling Two')).studentId;

    const r = await linkSiblings(principal, { studentId: a, siblingStudentId: b });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.value.members).toBe(2);

    const third = (await admit('Sibling Three')).studentId;
    const r2 = await linkSiblings(principal, { studentId: a, siblingStudentId: third });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.members).toBe(3);
  }, 120_000);
});

describe('promotion', () => {
  let batchId: string;
  const cohort: StudentId[] = [];

  beforeAll(async () => {
    for (const [i, name] of ['Promote A', 'Promote B', 'Promote C', 'Promote D'].entries()) {
      cohort.push((await admit(name, class7, i + 1)).studentId);
    }
  }, 120_000);

  it('moves the cohort, reassigns roll numbers and records a batch', async () => {
    const r = await promoteSection(
      principal,
      {
        sourceSectionId: class7,
        fromYearId: year2027,
        toYearId: year2028,
        targetSectionId: class6,
        exceptions: {
          [cohort[1]!]: 'retained',
          [cohort[3]!]: 'withdrawn',
        },
        reason: 'end of the 2027 session',
      },
      { clock },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    batchId = r.value.batchId;
    expect(r.value.counts).toMatchObject({ promoted: 2, retained: 1, withdrawn: 1 });
    expect(r.value.enrolled).toBe(3);

    // Rolls restart at 1 with no gap where the leaver was.
    const { rows } = await admin.query<{ roll_no: number }>(
      `SELECT roll_no FROM enrolment
       WHERE academic_year_id=$1 AND promotion_batch_id=$2 AND deleted_at IS NULL
       ORDER BY roll_no`,
      [uuid(year2028), uuid(batchId)],
    );
    expect(rows.map((x) => x.roll_no)).toEqual([1, 2, 3]);
  }, 120_000);

  it('closes the source enrolments with an outcome each', async () => {
    const { rows } = await admin.query<{ outcome: string; n: string }>(
      `SELECT outcome, count(*)::text n FROM enrolment
       WHERE section_id=$1 AND academic_year_id=$2 AND deleted_at IS NULL
       GROUP BY outcome`,
      [uuid(class7), uuid(year2027)],
    );
    const byOutcome = Object.fromEntries(rows.map((r) => [r.outcome, Number(r.n)]));
    expect(byOutcome['promoted']).toBe(2);
    expect(byOutcome['retained']).toBe(1);
    expect(byOutcome['withdrawn']).toBe(1);
  }, 60_000);

  it('withdraws the leaver and records why', async () => {
    const { rows } = await admin.query<{ status: string }>(
      'SELECT status FROM student WHERE id=$1',
      [uuid(cohort[3]!)],
    );
    expect(rows[0]?.status).toBe('withdrawn');

    const events = await admin.query<{ reason: string }>(
      `SELECT reason FROM student_status_event WHERE student_id=$1 AND to_status='withdrawn'`,
      [uuid(cohort[3]!)],
    );
    expect(events.rows[0]?.reason).toContain('end of the 2027 session');
  }, 60_000);

  it('keeps a retained student in their original section', async () => {
    const { rows } = await admin.query<{ section_id: string }>(
      `SELECT section_id FROM enrolment
       WHERE student_id=$1 AND academic_year_id=$2 AND deleted_at IS NULL`,
      [uuid(cohort[1]!), uuid(year2028)],
    );
    expect(rows[0]?.section_id).toBe(uuid(class7));
  }, 60_000);

  /*
   * "Undo the promotion, we ran it on the wrong section." Removes exactly the
   * rows this batch created and puts the source enrolments back to having no
   * outcome, so the cohort can be promoted again.
   */
  it('undoes the whole run', async () => {
    const r = await undoPromotion(principal, {
      batchId,
      reason: 'ran it on the wrong section',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.value.removed).toBe(3);

    const live = await admin.query<{ n: string }>(
      `SELECT count(*)::text n FROM enrolment
       WHERE promotion_batch_id=$1 AND deleted_at IS NULL`,
      [uuid(batchId)],
    );
    expect(live.rows[0]?.n).toBe('0');

    // Soft-deleted, not gone: nothing is hard-deleted.
    const all = await admin.query<{ n: string }>(
      'SELECT count(*)::text n FROM enrolment WHERE promotion_batch_id=$1',
      [uuid(batchId)],
    );
    expect(all.rows[0]?.n).toBe('3');

    const cleared = await admin.query<{ n: string }>(
      `SELECT count(*)::text n FROM enrolment
       WHERE section_id=$1 AND academic_year_id=$2 AND outcome IS NULL AND deleted_at IS NULL`,
      [uuid(class7), uuid(year2027)],
    );
    expect(Number(cleared.rows[0]?.n)).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('refuses to undo the same batch twice', async () => {
    const r = await undoPromotion(principal, { batchId, reason: 'again' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(PromotionErrors.BATCH_ALREADY_UNDONE.code);
  }, 60_000);

  it('refuses an exception naming someone who is not in the section', async () => {
    const r = await promoteSection(
      principal,
      {
        sourceSectionId: class7,
        fromYearId: year2027,
        toYearId: year2028,
        targetSectionId: class6,
        exceptions: { [nid<'student'>()]: 'retained' },
        reason: 'wrong section, probably',
      },
      { clock },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(PromotionErrors.UNKNOWN_EXCEPTION.code);
  }, 60_000);

  it('refuses to promote into the same year', async () => {
    const r = await promoteSection(
      principal,
      {
        sourceSectionId: class7,
        fromYearId: year2027,
        toYearId: year2027,
        targetSectionId: class6,
        reason: 'nonsense',
      },
      { clock },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(PromotionErrors.SAME_YEAR.code);
  }, 60_000);
});

describe('merging two person records', () => {
  let mergeId: string;
  let winner: PersonId;
  let loser: PersonId;
  let studentOfLoser: StudentId;

  beforeAll(async () => {
    // The same guardian entered twice, a year apart, spelled differently.
    winner = await makePerson('Mohammad Rahman', '+8801799000010');
    loser = await makePerson('Muhammad Rahman', '+8801799000010');

    studentOfLoser = (await admit('Child Of Duplicate')).studentId;
    await linkGuardian(principal, {
      studentId: studentOfLoser,
      guardianPersonId: loser,
      relationship: 'father',
      isBillingGuardian: true,
    });
  }, 120_000);

  it('repoints the references and marks the loser', async () => {
    const r = await mergePersons(principal, {
      winnerPersonId: winner,
      loserPersonId: loser,
      reason: 'same guardian entered twice, spelled two ways',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    mergeId = r.value.mergeId;
    expect(r.value.moved['guardianLinks']).toBe(1);

    const link = await admin.query<{ guardian_person_id: string }>(
      `SELECT guardian_person_id FROM guardian_link
       WHERE student_id=$1 AND deleted_at IS NULL`,
      [uuid(studentOfLoser)],
    );
    expect(link.rows[0]?.guardian_person_id).toBe(uuid(winner));

    // The loser stays: nothing is hard-deleted, and an old reference to that
    // id must still resolve to a human.
    const person = await admin.query<{ merged_into_person_id: string }>(
      'SELECT merged_into_person_id FROM person WHERE id=$1',
      [uuid(loser)],
    );
    expect(person.rows[0]?.merged_into_person_id).toBe(uuid(winner));
  }, 60_000);

  it('refuses to merge a record that already lost a merge', async () => {
    const third = await makePerson('Third Rahman');
    const r = await mergePersons(principal, {
      winnerPersonId: third,
      loserPersonId: loser,
      reason: 'merging the loser again',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(MergeErrors.ALREADY_MERGED.code);
  }, 60_000);

  it('refuses to merge the actor away', async () => {
    const other = await makePerson('Someone Else');
    const r = await mergePersons(principal, {
      winnerPersonId: other,
      loserPersonId: principal.personId,
      reason: 'merging myself away',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(MergeErrors.CANNOT_MERGE_SELF.code);
  }, 60_000);

  /*
   * Reversal puts back exactly the rows recorded in `moved`, by id — never
   * "everything pointing at the winner", which by now includes rows the winner
   * legitimately gained.
   */
  it('reverses, returning exactly the rows it moved', async () => {
    // The winner gains an unrelated link in the meantime.
    const otherChild = (await admit('Unrelated Child')).studentId;
    await linkGuardian(principal, {
      studentId: otherChild,
      guardianPersonId: winner,
      relationship: 'father',
      isBillingGuardian: true,
    });

    const r = await unmergePersons(principal, {
      mergeId,
      reason: 'they turned out to be two different people',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const back = await admin.query<{ guardian_person_id: string }>(
      `SELECT guardian_person_id FROM guardian_link
       WHERE student_id=$1 AND deleted_at IS NULL`,
      [uuid(studentOfLoser)],
    );
    expect(back.rows[0]?.guardian_person_id).toBe(uuid(loser));

    // The winner's own link stayed put.
    const kept = await admin.query<{ guardian_person_id: string }>(
      `SELECT guardian_person_id FROM guardian_link
       WHERE student_id=$1 AND deleted_at IS NULL`,
      [uuid(otherChild)],
    );
    expect(kept.rows[0]?.guardian_person_id).toBe(uuid(winner));

    const person = await admin.query<{ merged_into_person_id: string | null }>(
      'SELECT merged_into_person_id FROM person WHERE id=$1',
      [uuid(loser)],
    );
    expect(person.rows[0]?.merged_into_person_id).toBeNull();
  }, 120_000);

  it('refuses to reverse twice', async () => {
    const r = await unmergePersons(principal, { mergeId, reason: 'again' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(MergeErrors.MERGE_ALREADY_REVERSED.code);
  }, 60_000);
});

describe('authorization', () => {
  it('refuses admission without student.write', async () => {
    const weak: AuthContext = { ...principal, permissions: new Set<Permission>(['student.read']) };
    await expect(
      admitStudent(
        weak,
        { schoolId, sectionId: class6, academicYearId: year2027, nameBn: 'ক', nameEn: 'No' },
        { clock },
      ),
    ).rejects.toThrow(/student.write/);
  }, 30_000);

  it('refuses a merge without student.merge', async () => {
    const weak: AuthContext = {
      ...principal,
      permissions: new Set<Permission>(['student.read', 'student.write']),
    };
    await expect(
      mergePersons(weak, {
        winnerPersonId: nid<'person'>() as PersonId,
        loserPersonId: nid<'person'>() as PersonId,
        reason: 'should never happen',
      }),
    ).rejects.toThrow(/student.merge/);
  }, 30_000);

  it('refuses promotion without enrolment.promote', async () => {
    const weak: AuthContext = { ...principal, permissions: new Set<Permission>(['student.write']) };
    await expect(
      promoteSection(
        weak,
        {
          sourceSectionId: class7,
          fromYearId: year2027,
          toYearId: year2028,
          targetSectionId: class6,
          reason: 'should never happen',
        },
        { clock },
      ),
    ).rejects.toThrow(/enrolment.promote/);
  }, 30_000);
});
