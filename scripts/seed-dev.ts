/**
 * Development and demo fixtures. §7.3 tier 3.
 *
 *   pnpm demo
 *
 * TWO TENANTS, ALWAYS. A single-tenant development database makes cross-tenant
 * bugs invisible, and there has to be a second tenant to leak *into* before
 * "no leak" means anything.
 *
 * The fixtures are not decoration. Shared guardian phones, a sibling group and
 * a separated-parent family are the cases the identity model was designed for
 * (ADR-0006); if they are not in the seed, nobody exercises them until a real
 * school does. Bangla names include conjunct-heavy forms and the
 * মোহাম্মদ / মুহাম্মদ transliteration pair, so duplicate detection and PDF
 * shaping have real data from day one.
 *
 * Everything is created through the REAL use cases — provisionTenant,
 * createSection, admitStudent, linkGuardian — so the seed exercises the same
 * path production does. A fixture built with raw INSERTs is how the missing
 * `permission` seed stayed invisible for four increments.
 */

import { Pool } from 'pg';
import { provisionTenant } from '../src/modules/platform/index';
import { createSection } from '../src/modules/structure/index';
import { getStructure } from '../src/modules/structure/index';
import {
  admitStudent,
  linkGuardian,
  linkSiblings,
  transitionStudentStatus,
} from '../src/modules/directory/index';
import {
  inviteStaff,
  resolveAuthContext,
  requestOtp,
  verifyOtp,
  tokenGenerator,
  passwordHasher,
  codeHasher,
  randomSource,
} from '../src/modules/identity/index';
import { Ids } from '../src/shared/ids';
import type {
  AcademicYearId,
  CampusId,
  ClassLevelId,
  PersonId,
  SchoolId,
  SectionId,
  ShiftId,
  StudentId,
} from '../src/shared/ids';
import type { AuthContext, PlatformContext } from '../src/shared/auth-context';
import { PERMISSIONS } from '../src/shared/permissions';
import { closeAllPools } from '../src/db/index';

// ── guards ───────────────────────────────────────────────────────────────────

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR;

if (process.env.NODE_ENV === 'production') {
  console.error('seed-dev refuses to run with NODE_ENV=production.');
  process.exit(1);
}
if (!ADMIN_URL) {
  console.error('Set DATABASE_URL_MIGRATOR. See docs/RUNNING-LOCALLY.md.');
  process.exit(1);
}

/*
 * A second, independent guard on the database NAME. NODE_ENV is a string
 * somebody can forget to set; the database in the connection string is the
 * thing actually about to be written to. Both have to agree.
 */
const dbName = ADMIN_URL.split('/').pop()?.split('?')[0] ?? '';
if (!/dev|demo|test|local|sm_saas$/.test(dbName)) {
  console.error(
    `Refusing to seed "${dbName}". The database name must look like a development one.`,
  );
  process.exit(1);
}

/** The password every seeded staff member gets. Development only. */
const DEMO_PASSWORD = 'demo1234';

// ── determinism ──────────────────────────────────────────────────────────────

/**
 * A seeded PRNG, so two runs produce the same school.
 *
 * Ids are NOT fixed — `Ids.generate` is monotonic rather than seedable — so a
 * re-seed produces different ULIDs. Slugs, student codes, phone numbers and
 * names are all stable, which is what a demo script or an E2E selector should
 * be written against anyway.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20270314);

// ── names ────────────────────────────────────────────────────────────────────

/** Conjunct-heavy on purpose: ক্ষ, ঞ্জ, র্ম, ্র and ya-phala all appear. */
const GIVEN_BN = [
  'মোহাম্মদ', 'মুহাম্মদ', 'আব্দুল্লাহ', 'তানভীর', 'সাদিয়া', 'নুসরাত',
  'ফারহানা', 'রাফিয়া', 'ইশরাক', 'অন্তরা', 'সৌমিক', 'প্রজ্ঞা',
  'কৃষ্ণা', 'শ্রাবণী', 'অর্ণব', 'মৃত্তিকা', 'জ্যোতি', 'সংঘমিত্রা',
] as const;
const FAMILY_BN = [
  'ইসলাম', 'রহমান', 'হোসেন', 'আক্তার', 'চৌধুরী', 'সরকার',
  'ভট্টাচার্য', 'মজুমদার', 'দাশগুপ্ত', 'সিদ্দিকী',
] as const;
const GIVEN_EN = [
  'Mohammad', 'Muhammad', 'Abdullah', 'Tanvir', 'Sadia', 'Nusrat',
  'Farhana', 'Rafia', 'Ishraq', 'Antara', 'Soumik', 'Progya',
  'Krishna', 'Shrabani', 'Arnob', 'Mrittika', 'Jyoti', 'Sanghamitra',
] as const;
const FAMILY_EN = [
  'Islam', 'Rahman', 'Hossain', 'Akter', 'Chowdhury', 'Sarkar',
  'Bhattacharya', 'Majumder', 'Dasgupta', 'Siddiqui',
] as const;

function person(): { nameBn: string; nameEn: string } {
  const i = Math.floor(rand() * GIVEN_BN.length);
  const j = Math.floor(rand() * FAMILY_BN.length);
  return {
    nameBn: `${GIVEN_BN[i]} ${FAMILY_BN[j]}`,
    nameEn: `${GIVEN_EN[i]} ${FAMILY_EN[j]}`,
  };
}

let phoneCounter = 0;
const nextPhone = (): string => `+88017${String(10_000_000 + ++phoneCounter).slice(-8)}`;

// ── setup ────────────────────────────────────────────────────────────────────

const admin = new Pool({ connectionString: ADMIN_URL, max: 4 });

const operatorAccount = Ids.generate<'account'>();

/**
 * Staff sign in with a password; guardians never have one.
 *
 * Setting it directly is what an accepted invite would have done, so the
 * outstanding invite is closed at the same time. Leaving it open would show
 * "invite pending" beside somebody who can already sign in — a demo that
 * contradicts itself on the first screen.
 */
async function setPassword(phone: string): Promise<void> {
  const hash = await passwordHasher.hash(DEMO_PASSWORD);
  await admin.query(
    `UPDATE credential SET password_hash = $1, verified_at = now()
     WHERE kind = 'phone' AND value = $2`,
    [hash, phone],
  );
  await admin.query(
    `UPDATE staff_invite SET consumed_at = now()
     WHERE consumed_at IS NULL AND revoked_at IS NULL
       AND credential_id IN (SELECT id FROM credential WHERE value = $1)`,
    [phone],
  );
}

/** Signs in for real, so the seed uses the same AuthContext the app does. */
async function login(phone: string): Promise<AuthContext> {
  await admin.query(
    `DELETE FROM otp_challenge WHERE credential_id IN
       (SELECT id FROM credential WHERE value = $1)`,
    [phone],
  );
  let code: string | undefined;
  await requestOtp(
    { identifier: phone },
    { codeHasher, random: randomSource, dispatcher: { send: async (_t, c) => void (code = c) } },
  );
  if (!code) throw new Error(`no OTP for ${phone}`);

  const session = await verifyOtp({ identifier: phone, code }, { codeHasher, tokens: tokenGenerator });
  if (!session.ok) throw new Error(`login failed: ${JSON.stringify(session)}`);

  const ctx = await resolveAuthContext(session.value.sessionToken, { tokens: tokenGenerator });
  if (!ctx.ok) throw new Error(`context failed: ${JSON.stringify(ctx)}`);
  return ctx.value;
}

interface Tenant {
  slug: string;
  tenantId: string;
  schoolId: SchoolId;
  ownerPhone: string;
  ctx: AuthContext;
  yearId: AcademicYearId;
  campusId: CampusId;
  shiftId: ShiftId;
  levels: Array<{ id: ClassLevelId; nameEn: string }>;
}

async function provision(
  slug: string,
  nameBn: string,
  nameEn: string,
  ownerPhone: string,
): Promise<Tenant> {
  const operator: PlatformContext = {
    accountId: operatorAccount,
    permissions: new Set(PERMISSIONS),
    requestId: `seed-dev-${slug}`,
    reason: `seeding the ${nameEn} development fixture`,
  };

  const existing = await admin.query('SELECT id FROM tenant WHERE slug = $1', [slug]);
  if (existing.rowCount && existing.rowCount > 0) {
    throw new Error(
      `Tenant "${slug}" already exists. seed-dev is not idempotent — it creates a whole ` +
        `school every run. Drop and re-migrate, or use a different slug.`,
    );
  }

  const result = await provisionTenant(operator, {
    slug,
    nameBn,
    nameEn,
    planCode: 'standard',
    owner: { ...person(), nameEn: 'Principal', phone: ownerPhone },
  });
  if (!result.ok) throw new Error(`provisioning ${slug} failed: ${JSON.stringify(result)}`);

  await setPassword(ownerPhone);
  const ctx = await login(ownerPhone);

  const structure = await getStructure(ctx);
  if (!structure.ok) throw new Error('structure read failed');

  return {
    slug,
    tenantId: result.value.tenantId,
    schoolId: result.value.schoolId,
    ownerPhone,
    ctx,
    yearId: structure.value.currentYear!.id as AcademicYearId,
    campusId: structure.value.campuses[0]!.id as CampusId,
    shiftId: structure.value.shifts[0]!.id as ShiftId,
    levels: structure.value.classLevels.map((l) => ({
      id: l.id as ClassLevelId,
      nameEn: l.nameEn,
    })),
  };
}

/** A guardian person, created directly: `directory` does not invent guardians. */
async function guardianPerson(tenantId: string, phone: string): Promise<PersonId> {
  const id = Ids.generate<'person'>();
  const { nameBn, nameEn } = person();
  await admin.query(
    `INSERT INTO person (id, tenant_id, name_bn, name_en, phone)
     VALUES ($1, $2, $3, $4, $5)`,
    [Ids.toUuid(id), Ids.toUuid(tenantId as never), nameBn, nameEn, phone],
  );
  return id;
}

// ── the work ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Seeding development fixtures…\n');

  /*
   * The operator needs a real account row: audit_log.actor_account_id has a
   * foreign key to account(id), and provisioning writes the school's first
   * audit entry as this actor.
   */
  await admin.query(
    `INSERT INTO account (id, status, locale) VALUES ($1, 'active', 'en')
     ON CONFLICT DO NOTHING`,
    [Ids.toUuid(operatorAccount)],
  );

  // ── Tenant A: the demo school ──────────────────────────────────────────────
  const a = await provision(
    'demo',
    'ঢাকা আদর্শ বিদ্যালয়',
    'Dhaka Model School',
    '+8801700000001',
  );
  console.log(`  ✓ ${a.slug} — provisioned`);

  // Sections for the classes a demo actually walks through.
  const sections = new Map<string, SectionId>();
  for (const levelName of ['Class 6', 'Class 7', 'Class 8']) {
    for (const [bn, en] of [['ক', 'A'], ['খ', 'B']] as const) {
      const level = a.levels.find((l) => l.nameEn === levelName)!;
      const made = await createSection(a.ctx, {
        schoolId: a.schoolId,
        classLevelId: level.id,
        campusId: a.campusId,
        shiftId: a.shiftId,
        nameBn: bn,
        nameEn: en,
        capacity: 40,
      });
      if (!made.ok) throw new Error(`section failed: ${JSON.stringify(made)}`);
      sections.set(`${levelName} ${en}`, made.value.sectionId);
    }
  }
  console.log(`  ✓ ${sections.size} sections`);

  // Staff, invited the way a principal actually does it.
  const staffPhones: Array<[string, string]> = [
    ['+8801700000002', 'Office Assistant'],
    ['+8801700000003', 'Class Teacher'],
    ['+8801700000004', 'Accountant'],
  ];
  for (const [phone, role] of staffPhones) {
    const personId = await guardianPerson(a.tenantId, phone);
    const invited = await inviteStaff(
      a.ctx,
      { personId, identifier: phone, roleIds: [] },
      { tokens: tokenGenerator },
    );
    if (!invited.ok) throw new Error(`invite failed: ${JSON.stringify(invited)}`);
    await setPassword(phone);
    console.log(`  ✓ staff: ${phone} (${role})`);
  }

  // Students, spread across the sections.
  const sectionKeys = [...sections.keys()];
  const admitted: Array<{ id: StudentId; code: string }> = [];
  const COUNT = Number(process.env.DEMO_STUDENTS ?? 120);

  for (let i = 0; i < COUNT; i++) {
    const key = sectionKeys[i % sectionKeys.length]!;
    const names = person();
    const result = await admitStudent(a.ctx, {
      schoolId: a.schoolId,
      sectionId: sections.get(key)!,
      academicYearId: a.yearId,
      nameBn: names.nameBn,
      nameEn: names.nameEn,
      rollNo: Math.floor(i / sectionKeys.length) + 1,
      gender: rand() > 0.5 ? 'male' : 'female',
    });
    if (!result.ok) throw new Error(`admission ${i} failed: ${JSON.stringify(result)}`);
    admitted.push({ id: result.value.studentId, code: result.value.studentCode });

    if (i > 0 && i % 40 === 0) console.log(`    …${i} students`);
  }
  console.log(`  ✓ ${admitted.length} students`);

  // ── the fixtures that exist to be exercised ────────────────────────────────

  /*
   * A shared handset. Two children, one guardian phone — FR-9.4 says an absence
   * SMS to both must produce ONE message, and that is unprovable without this.
   */
  const sharedPhone = '+8801700000900';
  const sharedGuardian = await guardianPerson(a.tenantId, sharedPhone);
  for (const child of admitted.slice(0, 2)) {
    const linked = await linkGuardian(a.ctx, {
      studentId: child.id,
      guardianPersonId: sharedGuardian,
      relationship: 'father',
      isBillingGuardian: true,
      isPrimaryContact: true,
    });
    if (!linked.ok) throw new Error(`shared guardian failed: ${JSON.stringify(linked)}`);
  }
  await linkSiblings(a.ctx, {
    studentId: admitted[0]!.id,
    siblingStudentId: admitted[1]!.id,
  });
  console.log('  ✓ sibling group sharing one handset');

  /*
   * Separated parents. The father pays, the mother is contacted, and the flags
   * diverge — a single "primary guardian" would force a wrong answer here,
   * which is the whole reason they are two columns.
   */
  const father = await guardianPerson(a.tenantId, '+8801700000901');
  const mother = await guardianPerson(a.tenantId, '+8801700000902');
  const child = admitted[2]!;
  await linkGuardian(a.ctx, {
    studentId: child.id,
    guardianPersonId: father,
    relationship: 'father',
    isBillingGuardian: true,
    isPrimaryContact: false,
    canReceiveResults: false,
  });
  await linkGuardian(a.ctx, {
    studentId: child.id,
    guardianPersonId: mother,
    relationship: 'mother',
    isBillingGuardian: false,
    isPrimaryContact: true,
    canReceiveResults: true,
  });
  console.log('  ✓ separated-parent family with divergent flags');

  // Ordinary guardians for the rest, so no student is unreachable.
  for (const student of admitted.slice(3, 40)) {
    const g = await guardianPerson(a.tenantId, nextPhone());
    await linkGuardian(a.ctx, {
      studentId: student.id,
      guardianPersonId: g,
      relationship: rand() > 0.5 ? 'father' : 'mother',
      isBillingGuardian: true,
      isPrimaryContact: true,
    });
  }
  console.log('  ✓ guardians linked');

  // A few students in other lifecycle states, so the list is not uniformly
  // 'active' and the status filter has something to filter.
  await transitionStudentStatus(a.ctx, {
    studentId: admitted[5]!.id,
    to: 'on_leave',
    reason: 'family travelling abroad for a term',
  });
  await transitionStudentStatus(a.ctx, {
    studentId: admitted[6]!.id,
    to: 'withdrawn',
    reason: 'moved to another district',
  });
  console.log('  ✓ mixed lifecycle states');

  // ── Tenant B: exists to be leaked into ─────────────────────────────────────
  const b = await provision(
    'other-school',
    'চট্টগ্রাম বালিকা বিদ্যালয়',
    'Chittagong Girls School',
    '+8801700000010',
  );
  const level = b.levels.find((l) => l.nameEn === 'Class 6')!;
  const bSection = await createSection(b.ctx, {
    schoolId: b.schoolId,
    classLevelId: level.id,
    campusId: b.campusId,
    shiftId: b.shiftId,
    nameBn: 'ক',
    nameEn: 'A',
  });
  if (!bSection.ok) throw new Error('tenant B section failed');
  for (let i = 0; i < 5; i++) {
    const names = person();
    await admitStudent(b.ctx, {
      schoolId: b.schoolId,
      sectionId: bSection.value.sectionId,
      academicYearId: b.yearId,
      nameBn: names.nameBn,
      nameEn: names.nameEn,
      rollNo: i + 1,
    });
  }
  console.log(`  ✓ ${b.slug} — a second tenant to leak into`);

  const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
  const host = new URL(appUrl).host;

  console.log(`
Done.

  Open      http://demo.${host}/app/login
  Sign in   Password tab
            +8801700000001  /  ${DEMO_PASSWORD}

  Other staff, same password:
    +8801700000002   office assistant
    +8801700000003   class teacher
    +8801700000004   accountant

  Second school (proves isolation — its students must NOT be visible above):
            http://other-school.${host}/app/login
            +8801700000010  /  ${DEMO_PASSWORD}

Guardians have NO password, by design. To sign in as one, use the Phone code
tab — the code is printed in the \`pnpm dev\` terminal, because SMS_PROVIDER=mock.
`);
}

try {
  await main();
} finally {
  await closeAllPools();
  await admin.end();
}
