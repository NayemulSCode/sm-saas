/**
 * The whole product over real HTTP.
 *
 * The integration suites prove each module works when called directly. This
 * proves the transport layer in front of them: the envelope, the cookie, every
 * DomainError mapped to the status the client is supposed to branch on, and
 * `authorize()` throwing across the boundary as a 403 rather than a 500.
 *
 * It reads as one continuous session because that is what it is — provision a
 * school, log in, configure it, admit a cohort, promote them, undo it. If a
 * step here fails, a person doing the same thing with curl would have failed
 * at the same point.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { request as httpRequest } from 'node:http';
import { startNextServer, type TestServer } from '../../../test/next-server';
import { provisionTenant } from '../../../modules/platform/index';
import { Ids } from '../../../shared/ids';
import type { PlatformContext } from '../../../shared/auth-context';
import { PERMISSIONS } from '../../../shared/permissions';

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR;

const nid = <T extends string = 'x'>() => Ids.generate<T>();
const uuid = (v: string) => Ids.toUuid(v as never);

const STAMP = Date.now();
const PLAN_CODE = 'standard';
const OWNER_PHONE = '+8801777000111';

let server: TestServer;
let admin: Pool;
let cookie: string;
let tenantId: string;
let schoolId: string;
let campusId: string;
let shiftId: string;

/** Ids discovered as the walkthrough proceeds. */
let currentYearId: string;
let nextYearId: string;
let class6: string;
let class7: string;
let sectionA: string;
let sectionB: string;

const req = async (
  method: string,
  path: string,
  body?: unknown,
  withCookie = true,
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(withCookie && cookie ? { cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
};

const post = (p: string, b?: unknown, c = true) => req('POST', p, b, c);
const get = (p: string, c = true) => req('GET', p, undefined, c);
const patch = (p: string, b?: unknown) => req('PATCH', p, b);

const data = <T = Record<string, unknown>>(j: Record<string, unknown>): T =>
  j['data'] as T;
const errorCode = (j: Record<string, unknown>): string =>
  (j['error'] as { code: string } | undefined)?.code ?? '(no error)';

beforeAll(async () => {
  if (!ADMIN_URL) throw new Error('HTTP tests need DATABASE_URL_MIGRATOR.');

  /*
   * This suite provisions its school by calling the module directly, which
   * loads and validates the environment inside the TEST process — the server
   * under test has its own. The other HTTP suite only ever spoke raw SQL, so
   * it never needed these.
   */
  vi.stubEnv('APP_URL', 'http://localhost:3125');
  vi.stubEnv('PLATFORM_HOST', 'admin.localhost');
  vi.stubEnv('SESSION_SECRET', 'x'.repeat(32));
  vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64));
  vi.stubEnv('TZ', 'Asia/Dhaka');

  admin = new Pool({ connectionString: ADMIN_URL, max: 4 });

  const operatorAccount = nid<'account'>();
  await admin.query(
    `INSERT INTO account (id, status, locale) VALUES ($1,'active','en') ON CONFLICT DO NOTHING`,
    [uuid(operatorAccount)],
  );

  const operator: PlatformContext = {
    accountId: operatorAccount,
    permissions: new Set(PERMISSIONS),
    requestId: 'api-http',
    reason: 'provisioning a school for the API walkthrough',
  };

  // `standard` comes from `pnpm seed`, which CI runs before this suite.
  const p = await provisionTenant(
    operator,
    {
      slug: `api-${STAMP}`,
      nameBn: 'এপিআই বিদ্যালয়',
      nameEn: 'API School',
      planCode: PLAN_CODE,
      owner: { nameBn: 'ফরিদা ইয়াসমিন', nameEn: 'Farida Yasmin', phone: OWNER_PHONE },
    },
    { clock: { now: () => new Date('2027-03-14T06:00:00.000Z') } },
  );
  if (!p.ok) throw new Error(`provisioning failed: ${JSON.stringify(p)}`);
  tenantId = p.value.tenantId;
  schoolId = p.value.schoolId;

  server = await startNextServer(3125);
}, 240_000);

afterAll(async () => {
  await server?.stop();
  const { closeAllPools } = await import('../../../db/index');
  await closeAllPools();
  await admin?.end();
});

describe('logging in over HTTP', () => {
  it('sends an OTP and exchanges it for an HttpOnly session', async () => {
    await admin.query(
      `DELETE FROM otp_challenge WHERE credential_id IN
         (SELECT id FROM credential WHERE value = $1)`,
      [OWNER_PHONE],
    );

    const requested = await post('/api/v1/auth/otp/request', { identifier: OWNER_PHONE }, false);
    expect(requested.status).toBe(200);

    const code = server.lastOtpCode();
    expect(code, 'the mock dispatcher should have logged a code').toMatch(/^\d{6}$/);

    const res = await fetch(`${server.url}/api/v1/auth/otp/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: OWNER_PHONE, code }),
    });
    expect(res.status).toBe(200);

    const setCookie = res.headers.getSetCookie?.() ?? [];
    const session = setCookie.find((c) => c.startsWith('sm_session='));
    expect(session).toBeDefined();
    expect(session).toMatch(/HttpOnly/i);
    cookie = session!.split(';')[0]!;
  }, 60_000);

  it('resolves the session into a context with real permissions', async () => {
    const me = await get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(data<{ readOnly: boolean }>(me.json).readOnly).toBe(false);
  }, 30_000);
});

describe('reading the school', () => {
  it('returns the whole structure in one call', async () => {
    const res = await get('/api/v1/structure');
    expect(res.status, JSON.stringify(res.json)).toBe(200);

    const view = data<{
      school: { id: string };
      currentYear: { id: string; name: string };
      campuses: Array<{ id: string }>;
      shifts: Array<{ id: string }>;
      classLevels: Array<{ id: string; nameEn: string }>;
    }>(res.json);

    expect(view.school.id).toBe(schoolId);
    expect(view.currentYear.name).toBe('2027');
    expect(view.classLevels.length).toBeGreaterThan(10);

    currentYearId = view.currentYear.id;
    campusId = view.campuses[0]!.id;
    shiftId = view.shifts[0]!.id;
    class6 = view.classLevels.find((l) => l.nameEn === 'Class 6')!.id;
    class7 = view.classLevels.find((l) => l.nameEn === 'Class 7')!.id;
  }, 30_000);

  it('refuses every route without a cookie', async () => {
    for (const path of ['/api/v1/structure', '/api/v1/roles', `/api/v1/students/${nid()}`]) {
      const res = await get(path, false);
      expect(res.status, path).toBe(403);
    }
  }, 30_000);
});

describe('configuring the school', () => {
  it('adds the morning shift a two-shift school needs', async () => {
    const res = await post('/api/v1/shifts', {
      campusId,
      nameBn: 'প্রভাতী',
      nameEn: 'Morning',
      startTime: '07:00',
      endTime: '11:30',
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
  }, 30_000);

  it('rejects a shift that ends before it starts, as a field error', async () => {
    const res = await post('/api/v1/shifts', {
      campusId,
      nameBn: 'ভুল',
      nameEn: 'Backwards',
      startTime: '14:00',
      endTime: '08:00',
    });
    expect(res.status).toBe(400);
    expect(errorCode(res.json)).toBe('INVALID_SHIFT_TIMES');
  }, 30_000);

  it('creates two sections', async () => {
    for (const [level, name] of [
      [class6, 'A'],
      [class7, 'B'],
    ] as const) {
      const res = await post('/api/v1/sections', {
        schoolId,
        classLevelId: level,
        campusId,
        shiftId,
        nameBn: 'ক',
        nameEn: name,
        capacity: 40,
      });
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      const id = data<{ sectionId: string }>(res.json).sectionId;
      if (name === 'A') sectionA = id;
      else sectionB = id;
    }
  }, 60_000);

  it('reports a missing required field with the field name', async () => {
    const res = await post('/api/v1/sections', {
      schoolId,
      classLevelId: class6,
      campusId,
      // shiftId omitted — a section without a shift is unschedulable.
      nameBn: 'ক',
      nameEn: 'NoShift',
    });
    expect(res.status).toBe(400);
    expect(errorCode(res.json)).toBe('VALIDATION_FAILED');

    const details = (res.json['error'] as { details: Array<{ field: string }> }).details;
    expect(details.map((d) => d.field)).toContain('shiftId');
  }, 30_000);

  it('opens next year and closes the old one, in that order', async () => {
    const opened = await post('/api/v1/academic-years', {
      schoolId,
      name: '2028',
      startDate: '2028-01-01',
      endDate: '2028-12-31',
    });
    expect(opened.status, JSON.stringify(opened.json)).toBe(201);
    nextYearId = data<{ academicYearId: string }>(opened.json).academicYearId;

    // 2027 was demoted by opening 2028, so it can now be closed.
    const closed = await post(`/api/v1/academic-years/${currentYearId}/close`, {
      reason: 'the 2027 session has finished',
    });
    expect(closed.status, JSON.stringify(closed.json)).toBe(200);
  }, 60_000);

  it('refuses to close the year that is current', async () => {
    const res = await post(`/api/v1/academic-years/${nextYearId}/close`, {
      reason: 'trying to close the year we are in',
    });
    expect(res.status).toBe(409);
    expect(errorCode(res.json)).toBe('YEAR_STILL_CURRENT');
  }, 30_000);

  it('refuses a close with a one-word reason', async () => {
    const res = await post(`/api/v1/academic-years/${currentYearId}/close`, { reason: 'ok' });
    expect(res.status).toBe(400);
    expect(errorCode(res.json)).toBe('VALIDATION_FAILED');
  }, 30_000);
});

describe('admitting and managing students', () => {
  let studentId: string;
  let guardianPersonId: string;

  it('admits a student', async () => {
    const res = await post('/api/v1/students', {
      schoolId,
      sectionId: sectionA,
      academicYearId: nextYearId,
      nameBn: 'রাফিয়া হক',
      nameEn: 'Rafia Haque',
      rollNo: 1,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);

    const body = data<{ studentId: string; studentCode: string }>(res.json);
    studentId = body.studentId;
    expect(body.studentCode).toMatch(/^\d{4}-\d{4}$/);
  }, 60_000);

  it('reads the student back with history and enrolments', async () => {
    const res = await get(`/api/v1/students/${studentId}`);
    expect(res.status).toBe(200);

    const view = data<{
      student: { studentCode: string; status: string };
      enrolments: unknown[];
      history: unknown[];
    }>(res.json);
    expect(view.student.status).toBe('active');
    expect(view.enrolments).toHaveLength(1);
    expect(view.history).toHaveLength(1);
  }, 30_000);

  it('refuses a phone that is not E.164 Bangladesh', async () => {
    const res = await post('/api/v1/students', {
      schoolId,
      sectionId: sectionA,
      academicYearId: nextYearId,
      nameBn: 'ক',
      nameEn: 'Bad Phone',
      phone: '01711223344',
    });
    expect(res.status).toBe(400);
    const details = (res.json['error'] as { details: Array<{ field: string }> }).details;
    expect(details.map((d) => d.field)).toContain('phone');
  }, 30_000);

  it('links a guardian and refuses to bill an emergency contact', async () => {
    const person = nid<'person'>();
    await admin.query(
      `INSERT INTO person (id, tenant_id, name_bn, name_en, phone)
       VALUES ($1,$2,'করিম আহমেদ','Karim Ahmed','+8801777000222')`,
      [uuid(person), uuid(tenantId)],
    );
    guardianPersonId = person;

    const ok = await post(`/api/v1/students/${studentId}/guardians`, {
      guardianPersonId,
      relationship: 'father',
      isBillingGuardian: true,
      isPrimaryContact: true,
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);

    const neighbour = nid<'person'>();
    await admin.query(
      `INSERT INTO person (id, tenant_id, name_bn, name_en) VALUES ($1,$2,'প্রতিবেশী','Neighbour')`,
      [uuid(neighbour), uuid(tenantId)],
    );
    const refused = await post(`/api/v1/students/${studentId}/guardians`, {
      guardianPersonId: neighbour,
      relationship: 'emergency',
      isBillingGuardian: true,
    });
    expect(refused.status).toBe(409);
    expect(errorCode(refused.json)).toBe('EMERGENCY_CANNOT_BILL');
  }, 60_000);

  it('refuses to unlink the only guardian', async () => {
    const res = await post(`/api/v1/students/${studentId}/guardians/unlink`, {
      guardianPersonId,
      reason: 'removing the only contact',
    });
    expect(res.status).toBe(409);
    expect(errorCode(res.json)).toBe('LAST_CONTACT');
  }, 30_000);

  /*
   * The CHECK constraint permits this value; the school does not. Nothing in
   * SQL stops a student going back to being an applicant.
   */
  it('refuses an illegal lifecycle transition', async () => {
    const res = await post(`/api/v1/students/${studentId}/transition`, { to: 'applicant' });
    expect(res.status).toBe(409);
    expect(errorCode(res.json)).toBe('ILLEGAL_TRANSITION');
  }, 30_000);

  it('withdraws with a reason, and refuses one without', async () => {
    const bare = await post(`/api/v1/students/${studentId}/withdraw`, {});
    expect(bare.status).toBe(400);

    const done = await post(`/api/v1/students/${studentId}/withdraw`, {
      reason: 'moved to another district',
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
  }, 60_000);
});

describe('promotion and its undo', () => {
  let batchId: string;

  beforeAll(async () => {
    for (const [i, name] of ['Promote One', 'Promote Two', 'Promote Three'].entries()) {
      const res = await post('/api/v1/students', {
        schoolId,
        sectionId: sectionB,
        academicYearId: nextYearId,
        nameBn: 'শিক্ষার্থী',
        nameEn: name,
        rollNo: i + 1,
      });
      expect(res.status, JSON.stringify(res.json)).toBe(201);
    }
  }, 120_000);

  it('promotes the cohort into another section', async () => {
    // 2027 is closed, so promote out of the current year into a third one.
    const third = await post('/api/v1/academic-years', {
      schoolId,
      name: '2029',
      startDate: '2029-01-01',
      endDate: '2029-12-31',
      makeCurrent: false,
    });
    expect(third.status).toBe(201);
    const yearId = data<{ academicYearId: string }>(third.json).academicYearId;

    const res = await post(`/api/v1/sections/${sectionB}/promote`, {
      fromYearId: nextYearId,
      toYearId: yearId,
      targetSectionId: sectionA,
      reason: 'end of the 2028 session',
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);

    const body = data<{ batchId: string; enrolled: number }>(res.json);
    batchId = body.batchId;
    expect(body.enrolled).toBe(3);
  }, 120_000);

  it('undoes the run, and refuses to undo it twice', async () => {
    const first = await post(`/api/v1/promotions/${batchId}/undo`, {
      reason: 'ran it on the wrong section',
    });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(data<{ removed: number }>(first.json).removed).toBe(3);

    const second = await post(`/api/v1/promotions/${batchId}/undo`, { reason: 'again' });
    expect(second.status).toBe(409);
    expect(errorCode(second.json)).toBe('BATCH_ALREADY_UNDONE');
  }, 60_000);
});

describe('roles', () => {
  it('lists what each role confers', async () => {
    const res = await get('/api/v1/roles');
    expect(res.status, JSON.stringify(res.json)).toBe(200);

    const roles = data<Array<{ code: string; permissions: string[] }>>(res.json);
    expect(roles.find((r) => r.code === 'Principal')?.permissions).toContain('membership.manage');
  }, 30_000);

  /*
   * The rule that stops a school administrator handing themselves everything.
   * The principal holds every permission, so only the self-grant check refuses
   * them — which is why it runs first.
   */
  it('refuses the principal granting themselves a role', async () => {
    const me = await get('/api/v1/auth/me');
    const membershipId = data<{ activeMembershipId: string }>(me.json).activeMembershipId;

    const roles = await get('/api/v1/roles');
    const accountant = data<Array<{ id: string; code: string }>>(roles.json).find(
      (r) => r.code === 'Accountant',
    )!;

    const res = await post(`/api/v1/memberships/${membershipId}/roles`, {
      roleId: accountant.id,
      reason: 'wants to handle the money too',
    });
    expect(res.status).toBe(403);
    expect(errorCode(res.json)).toBe('SELF_GRANT_BLOCKED');
  }, 60_000);
});

describe('the transport contract', () => {
  it('wraps every success as { data, meta.requestId }', async () => {
    const res = await get('/api/v1/roles');
    expect(res.json['data']).toBeDefined();
    expect((res.json['meta'] as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
  }, 30_000);

  it('wraps every failure as { error } with a stable code and a request id', async () => {
    const res = await get(`/api/v1/students/${nid()}`);
    expect(res.status).toBe(404);
    const error = res.json['error'] as { code: string; requestId: string; message: string };
    expect(error.code).toBe('STUDENT_NOT_FOUND');
    expect(error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    // `code` is what a client branches on; `message` is localised and never
    // parsed. Both present, and never the same thing.
    expect(error.message).not.toBe(error.code);
  }, 30_000);

  it('answers 400 for malformed JSON rather than 500', async () => {
    const res = await fetch(`${server.url}/api/v1/sections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: 'not json at all',
    });
    expect(res.status).toBe(400);
  }, 30_000);

  it('answers 400 for a malformed id in the body, not 500', async () => {
    const res = await post('/api/v1/sections', {
      schoolId: 'not-a-ulid',
      classLevelId: class6,
      campusId,
      shiftId,
      nameBn: 'ক',
      nameEn: 'Bad',
    });
    expect(res.status).toBe(400);
    expect(errorCode(res.json)).toBe('VALIDATION_FAILED');
  }, 30_000);

  it('answers 404 for a real-looking id that does not exist', async () => {
    const res = await patch(`/api/v1/sections/${nid()}`, { capacity: 10 });
    expect(res.status).toBe(404);
    expect(errorCode(res.json)).toBe('SECTION_NOT_FOUND');
  }, 30_000);
});

/*
 * The login page itself. Not a substitute for driving it in a browser, but it
 * catches the two failures that make the product unusable and that no unit test
 * sees: the page throwing on render, and the client island failing to ship.
 */
describe('the login page', () => {
  /** The tenant surface is chosen by HOST, so the slug is a subdomain. */
  const tenantHost = `api-${STAMP}.localhost:3125`;

  /*
   * node:http rather than fetch. `host` is a FORBIDDEN HEADER NAME in the fetch
   * spec, and undici drops it silently — the request lands on the root host,
   * middleware routes it to the marketing surface, and the assertion fails with
   * a 404 that looks like a broken route rather than a dropped header.
   */
  const page = (path: string): Promise<{ status: number; html: string }> =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port: 3125, path, headers: { host: tenantHost } },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, html: body }));
        },
      );
      request.on('error', reject);
      request.end();
    });

  it('renders, server-side, with both sign-in methods offered', async () => {
    const { status, html } = await page('/app/login');
    expect(status, html.slice(0, 400)).toBe(200);

    // The heading and copy are server-rendered: the page is readable before
    // any JavaScript arrives, which on 3G is most of the wait.
    expect(html).toContain('Sign in');
    expect(html).toContain('Phone code');
    expect(html).toContain('Password');
  }, 60_000);

  it('ships the fields a phone needs to autofill an SMS code', async () => {
    const { html } = await page('/app/login');
    /*
     * Case-INSENSITIVE. React 19 emits `autoComplete` and `inputMode` in
     * camelCase in its server output rather than lowercasing them; HTML
     * attribute names are case-insensitive so browsers do not care, and
     * asserting on exact case would be testing React's serialiser instead of
     * the behaviour that matters — a handset offering the number and the SMS
     * code from the keyboard.
     */
    expect(html).toMatch(/autocomplete="tel"/i);
    expect(html).toMatch(/inputmode="tel"/i);
    expect(html).toMatch(/type="tel"/i);
  }, 60_000);

  it('sets lang from the locale, which a screen reader switches voice on', async () => {
    const { html } = await page('/app/login');
    expect(html).toMatch(/<html[^>]+lang="(bn|en)"/);
  }, 60_000);
});

describe('the student list', () => {
  let listSection: string;

  beforeAll(async () => {
    // A section of its own, so paging assertions are not disturbed by the
    // students the earlier groups created.
    const made = await post('/api/v1/sections', {
      schoolId,
      classLevelId: class6,
      campusId,
      shiftId,
      nameBn: 'গ',
      nameEn: 'ListSection',
      capacity: 60,
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    listSection = data<{ sectionId: string }>(made.json).sectionId;

    for (let i = 1; i <= 7; i++) {
      const res = await post('/api/v1/students', {
        schoolId,
        sectionId: listSection,
        academicYearId: nextYearId,
        nameBn: `তালিকা ${i}`,
        nameEn: `Listed Student ${i}`,
        rollNo: i,
      });
      expect(res.status, JSON.stringify(res.json)).toBe(201);
    }
  }, 180_000);

  it('returns a page with the class and roll a class list needs', async () => {
    const res = await get(`/api/v1/students?sectionId=${listSection}&limit=25`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);

    const page = data<{
      items: Array<{ nameBn: string; studentCode: string; rollNo: number; classNameEn: string }>;
      hasMore: boolean;
      nextCursor: string | null;
    }>(res.json);

    expect(page.items).toHaveLength(7);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]?.classNameEn).toBe('Class 6');
    expect(page.items.every((i) => typeof i.rollNo === 'number')).toBe(true);
  }, 60_000);

  /*
   * Keyset, not offset. The probe row is trimmed, the cursor points at the last
   * VISIBLE row, and following it must not repeat or skip anybody — on a list
   * somebody is working through, a skip means a family is missed.
   */
  it('pages without repeating or skipping', async () => {
    const first = await get(`/api/v1/students?sectionId=${listSection}&limit=3`);
    const p1 = data<{ items: Array<{ id: string }>; hasMore: boolean; nextCursor: string }>(
      first.json,
    );
    expect(p1.items).toHaveLength(3);
    expect(p1.hasMore).toBe(true);

    const second = await get(
      `/api/v1/students?sectionId=${listSection}&limit=3&cursor=${encodeURIComponent(p1.nextCursor)}`,
    );
    const p2 = data<{ items: Array<{ id: string }>; hasMore: boolean; nextCursor: string }>(
      second.json,
    );
    expect(p2.items).toHaveLength(3);

    const third = await get(
      `/api/v1/students?sectionId=${listSection}&limit=3&cursor=${encodeURIComponent(p2.nextCursor)}`,
    );
    const p3 = data<{ items: Array<{ id: string }>; hasMore: boolean }>(third.json);
    expect(p3.items).toHaveLength(1);
    expect(p3.hasMore).toBe(false);

    const seen = [...p1.items, ...p2.items, ...p3.items].map((i) => i.id);
    expect(new Set(seen).size).toBe(7);
  }, 60_000);

  it('restarts the list for a cursor that has been mangled in a URL', async () => {
    const res = await get(`/api/v1/students?sectionId=${listSection}&cursor=not-a-real-cursor`);
    expect(res.status).toBe(200);
    expect(data<{ items: unknown[] }>(res.json).items).toHaveLength(7);
  }, 30_000);

  it('searches both scripts and the student code', async () => {
    const byEnglish = await get('/api/v1/students?search=Listed%20Student%203');
    expect(data<{ items: unknown[] }>(byEnglish.json).items).toHaveLength(1);

    const byBangla = await get(`/api/v1/students?search=${encodeURIComponent('তালিকা ৩')}`);
    expect(byBangla.status).toBe(200);

    // A name in one script is not a translation of the other, so an office
    // assistant types whichever they are looking at.
    const partial = await get('/api/v1/students?search=Listed');
    expect(data<{ items: unknown[] }>(partial.json).items.length).toBeGreaterThanOrEqual(5);
  }, 60_000);

  it('filters by status', async () => {
    const res = await get('/api/v1/students?status=withdrawn');
    const items = data<{ items: Array<{ status: string }> }>(res.json).items;
    expect(items.every((i) => i.status === 'withdrawn')).toBe(true);
  }, 30_000);

  it('ignores an unrecognised status rather than failing a bookmarked URL', async () => {
    const res = await get('/api/v1/students?status=nonsense');
    expect(res.status).toBe(200);
  }, 30_000);

  it('caps the page size, so a client cannot ask for the whole school', async () => {
    const res = await get('/api/v1/students?limit=99999');
    expect(res.status).toBe(200);
    expect(data<{ items: unknown[] }>(res.json).items.length).toBeLessThanOrEqual(100);
  }, 30_000);

  it('refuses without a cookie', async () => {
    expect((await get('/api/v1/students', false)).status).toBe(403);
  }, 30_000);
});

/*
 * The dashboard. A server component that calls the use cases directly, so this
 * is checking real rendered output rather than a fetch it makes.
 */
describe('the dashboard', () => {
  const tenantHost = `api-${STAMP}.localhost:3125`;

  const page = (path: string, withCookie = true): Promise<{ status: number; html: string }> =>
    new Promise((resolve, reject) => {
      const r = httpRequest(
        {
          host: '127.0.0.1',
          port: 3125,
          path,
          headers: { host: tenantHost, ...(withCookie ? { cookie } : {}) },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, html: body }));
        },
      );
      r.on('error', reject);
      r.end();
    });

  it('renders the school, the year and the student list', async () => {
    const { status, html } = await page('/app/dashboard');
    expect(status, html.slice(0, 300)).toBe(200);

    expect(html).toContain('API School');
    expect(html).toContain('Students');
    expect(html).toContain('Listed Student 1');
    // Bangla is shown first: it is the name the school uses day to day.
    expect(html).toContain('তালিকা');
  }, 60_000);

  it('sends an unauthenticated visitor to the login page, not a 403', async () => {
    // A 403 is a dead end for somebody who simply arrived with an expired
    // cookie, which after a fortnight is most guardians.
    const { status, html } = await page('/app/dashboard', false);
    expect([200, 307, 302]).toContain(status);
    if (status === 200) expect(html).toContain('Sign in');
  }, 60_000);

  it('search is a plain GET form, so the result is a shareable URL', async () => {
    const { html } = await page(`/app/dashboard?search=${encodeURIComponent('Listed Student 2')}`);
    expect(html).toContain('Listed Student 2');
    expect(html).not.toContain('Listed Student 5');
  }, 60_000);

  it('says so plainly when a search matches nobody', async () => {
    const { html } = await page('/app/dashboard?search=zzzznobody');
    expect(html).toMatch(/Nobody matches/);
  }, 60_000);
});

describe('the student detail page', () => {
  const tenantHost = `api-${STAMP}.localhost:3125`;

  const page = (path: string): Promise<{ status: number; html: string }> =>
    new Promise((resolve, reject) => {
      const r = httpRequest(
        { host: '127.0.0.1', port: 3125, path, headers: { host: tenantHost, cookie } },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, html: body }));
        },
      );
      r.on('error', reject);
      r.end();
    });

  it('shows the student, their history and the withdraw action', async () => {
    const list = await get('/api/v1/students?limit=1');
    const student = data<{ items: Array<{ id: string; studentCode: string }> }>(list.json)
      .items[0]!;

    const { status, html } = await page(`/app/students/${student.id}`);
    expect(status, html.slice(0, 300)).toBe(200);

    expect(html).toContain(student.studentCode);
    expect(html).toContain('Guardians');
    expect(html).toContain('History');
    expect(html).toContain('Withdraw student');
  }, 60_000);

  /*
   * A student in another school is ABSENT, not forbidden. RLS makes the row
   * invisible, and a 403 would confirm the id exists somewhere on the platform.
   */
  it('answers 404 for a student that does not exist', async () => {
    const { status } = await page(`/app/students/${nid()}`);
    expect(status).toBe(404);
  }, 60_000);
});
