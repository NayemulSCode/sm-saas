/**
 * Every endpoint, described once.
 *
 * The OpenAPI document and the human-readable API page are both GENERATED from
 * this, and the request shapes are the SAME Zod schemas the handlers validate
 * with — so documentation cannot describe a field the server rejects.
 *
 * What is written by hand here is the part a schema cannot carry: which
 * permission an endpoint needs, and which `code` it answers with when it
 * refuses. That second list matters more than the request shape. A client
 * branches on `code` — never on `message`, which is localised — so an
 * undocumented code is an unhandled case in somebody's UI.
 *
 * A CI check fails the build when a route exists with no entry here, which is
 * what stops this drifting into fiction.
 */

import type { ZodType } from 'zod';
import type { Permission } from '../permissions';

import {
  OtpRequestSchema,
  OtpVerifySchema,
  PasswordLoginSchema,
  AcceptInviteSchema,
  ActivateContextSchema,
  InviteStaffSchema,
  RevokeInviteSchema,
  GrantRoleSchema,
  RevokeRoleSchema,
} from '../../modules/identity/application/dto';
import {
  OpenAcademicYearSchema,
  CloseAcademicYearSchema,
  CreateClassLevelSchema,
  ReorderClassLevelsSchema,
  CreateShiftSchema,
  CreateSectionSchema,
  UpdateSectionSchema,
} from '../../modules/structure/application/dto';
import {
  AdmitStudentSchema,
  UpdateStudentSchema,
  TransitionStudentSchema,
  WithdrawStudentSchema,
  LinkGuardianSchema,
  UnlinkGuardianSchema,
  LinkSiblingsSchema,
  PromoteSectionSchema,
  UndoPromotionSchema,
  MergePersonsSchema,
  UnmergePersonsSchema,
} from '../../modules/directory/application/dto';
import {
  CreateFeeHeadSchema,
  CreateFeeStructureSchema,
  CreateFeeAssignmentSchema,
  CreateDiscountSchema,
  ApproveDiscountSchema,
} from '../../modules/finance/application/dto';

export interface QueryParam {
  name: string;
  description: string;
}

export interface Failure {
  status: number;
  code: string;
  when: string;
}

export interface Endpoint {
  method: 'GET' | 'POST' | 'PATCH';
  /** OpenAPI form, with `{braces}` for path parameters. */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  /** `null` means unauthenticated — the login endpoints and the health probes. */
  permission: Permission | 'authenticated' | null;
  body?: ZodType;
  query?: QueryParam[];
  successStatus: number;
  /** What a successful response carries, in prose. */
  returns?: string;
  failures?: Failure[];
  /** Rules the JSON Schema cannot express — `.refine()` is dropped by the
   *  generator, so anything cross-field has to be said here. */
  notes?: string[];
}

/** Refusals every authenticated endpoint can produce. Not repeated per entry. */
export const COMMON_FAILURES: Failure[] = [
  { status: 400, code: 'VALIDATION_FAILED', when: 'The body does not match the schema. `details` names the fields.' },
  { status: 403, code: 'FORBIDDEN', when: 'No session cookie, or the session lacks the permission.' },
  { status: 401, code: 'SESSION_INVALID', when: 'The session cookie is unknown, expired or revoked.' },
  { status: 409, code: 'TENANT_SUSPENDED', when: 'The school is read-only; reads succeed, writes do not.' },
];

export const ENDPOINTS: Endpoint[] = [
  // ── authentication ─────────────────────────────────────────────────────────
  {
    method: 'POST',
    path: '/api/v1/auth/otp/request',
    tag: 'Authentication',
    summary: 'Send a login code',
    description:
      'Guardians sign in this way and have no password at all. The response is IDENTICAL whether or not the number belongs to anybody — an endpoint that distinguishes them is a tool for discovering who is enrolled at a school.',
    permission: null,
    body: OtpRequestSchema,
    successStatus: 200,
    returns: '`{ accepted: true, expiresInSeconds }` — always, even for an unknown number.',
    failures: [
      { status: 429, code: 'RATE_LIMITED', when: 'Too many requests for this number or IP. `Retry-After` is set.' },
    ],
    notes: [
      'A resend within the validity window reuses the live code rather than minting a second one: two valid codes double both the guessing surface and the SMS bill.',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/auth/otp/verify',
    tag: 'Authentication',
    summary: 'Exchange a code for a session',
    permission: null,
    body: OtpVerifySchema,
    successStatus: 200,
    returns:
      'Sets an `HttpOnly` `sm_session` cookie and returns the contexts this login reaches. The token is never in the body.',
    failures: [
      { status: 400, code: 'INVALID_CODE', when: 'Wrong, expired, already used, or the number is unknown — deliberately indistinguishable.' },
      { status: 423, code: 'ACCOUNT_LOCKED', when: 'Too many failed attempts.' },
      { status: 403, code: 'NO_MEMBERSHIP', when: 'The account exists but belongs to no school.' },
    ],
    notes: ['With exactly one context the session activates it; with several the caller must call `activate`.'],
  },
  {
    method: 'POST',
    path: '/api/v1/auth/password',
    tag: 'Authentication',
    summary: 'Sign in with a password',
    description: 'Staff only. Guardians have no password.',
    permission: null,
    body: PasswordLoginSchema,
    successStatus: 200,
    returns: 'Sets the `sm_session` cookie, same shape as OTP verification.',
    failures: [
      { status: 400, code: 'INVALID_CREDENTIALS', when: 'Wrong password, unknown identifier, or an OTP-only account — all the same answer, in the same time.' },
      { status: 423, code: 'ACCOUNT_LOCKED', when: 'Five failed attempts. Fifteen minutes.' },
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/auth/invite/accept',
    tag: 'Authentication',
    summary: 'Accept a staff invite and set a password',
    description: 'Unauthenticated: the single-use token IS the credential.',
    permission: null,
    body: AcceptInviteSchema,
    successStatus: 200,
    returns: 'Sets the password, opens a session, and sets the cookie — so the new member lands signed in.',
    failures: [
      { status: 400, code: 'INVITE_INVALID', when: 'Unknown, expired, revoked or already used — indistinguishable on purpose.' },
      { status: 409, code: 'PASSWORD_ALREADY_SET', when: 'They already had a password; the invite is consumed anyway.' },
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/auth/me',
    tag: 'Authentication',
    summary: 'The current session',
    permission: 'authenticated',
    successStatus: 200,
    returns: '`{ accountId, activeMembershipId, readOnly }`. `readOnly` is true for a suspended school.',
  },
  {
    method: 'GET',
    path: '/api/v1/auth/contexts',
    tag: 'Authentication',
    summary: 'Schools this login reaches',
    permission: 'authenticated',
    successStatus: 200,
    returns: 'One entry per membership, with the school slug and which is active.',
  },
  {
    method: 'POST',
    path: '/api/v1/auth/contexts/{membershipId}/activate',
    tag: 'Authentication',
    summary: 'Switch school',
    description:
      'The caller supplies a membership id and nothing else. Which tenant the session lands in is derived from that membership server-side; a client can never name a tenant.',
    permission: 'authenticated',
    body: ActivateContextSchema,
    successStatus: 200,
    failures: [
      { status: 404, code: 'CONTEXT_NOT_FOUND', when: 'The membership belongs to another account, or does not exist.' },
      { status: 409, code: 'TENANT_UNAVAILABLE', when: 'That school is cancelled or purged.' },
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/auth/logout',
    tag: 'Authentication',
    summary: 'Revoke this session',
    description: 'Server-side state, so it takes effect on the very next request — the whole reason for not using JWTs.',
    permission: 'authenticated',
    successStatus: 200,
  },

  // ── structure ──────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/v1/structure',
    tag: 'Structure',
    summary: 'The whole shape of a school',
    description: 'School, current year, campuses, shifts, class levels and sections in one read — four round trips on a 3G connection is the alternative.',
    permission: 'structure.read',
    query: [{ name: 'schoolId', description: 'Optional. Most tenants have one school, and it is resolved for you.' }],
    successStatus: 200,
  },
  {
    method: 'POST',
    path: '/api/v1/academic-years',
    tag: 'Structure',
    summary: 'Open an academic year',
    permission: 'academicYear.manage',
    body: OpenAcademicYearSchema,
    successStatus: 201,
    failures: [
      { status: 409, code: 'YEAR_NAME_TAKEN', when: 'A year of that name exists at this school.' },
      { status: 409, code: 'YEAR_OVERLAPS', when: 'Two years must not cover the same day — "which year is this date in?" needs one answer.' },
      { status: 400, code: 'INVALID_YEAR_DATES', when: 'Backwards, or longer than 400 days.' },
    ],
    notes: ['`makeCurrent` demotes the previous current year in the same transaction, so a school is never left without one.'],
  },
  {
    method: 'POST',
    path: '/api/v1/academic-years/{academicYearId}/close',
    tag: 'Structure',
    summary: 'Close an academic year',
    permission: 'academicYear.close',
    body: CloseAcademicYearSchema,
    successStatus: 200,
    failures: [
      { status: 409, code: 'YEAR_STILL_CURRENT', when: 'Open the successor first — that moves the flag — then close this one.' },
      { status: 409, code: 'YEAR_ALREADY_CLOSED', when: 'Already closed.' },
      { status: 409, code: 'YEAR_HAS_OPEN_WORK', when: 'Reserved for open exams and draft invoices. Neither module ships in 3a, so this cannot currently occur.' },
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/class-levels',
    tag: 'Structure',
    summary: 'Add a class',
    description: 'Added at the top of the ladder unless `sequence` says otherwise.',
    permission: 'structure.manage',
    body: CreateClassLevelSchema,
    successStatus: 201,
    failures: [{ status: 409, code: 'LEVEL_NAME_TAKEN', when: 'That name, or that sequence, is in use.' }],
  },
  {
    method: 'POST',
    path: '/api/v1/class-levels/reorder',
    tag: 'Structure',
    summary: 'Reorder the class ladder',
    description: '`sequence` is promotion order — this changes what "the next class up" means.',
    permission: 'structure.manage',
    body: ReorderClassLevelsSchema,
    successStatus: 200,
    failures: [
      { status: 409, code: 'REORDER_MID_YEAR', when: 'Students are enrolled in the current year. Promotion is keyed to this order.' },
      { status: 400, code: 'LEVEL_ORDER_INCOMPLETE', when: 'The list must name every class exactly once — it is the complete order, not a diff.' },
      { status: 404, code: 'LEVEL_NOT_FOUND', when: 'An id in the list is not a class at this school.' },
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/shifts',
    tag: 'Structure',
    summary: 'Add a shift',
    description: 'A shift is a first-class entity with its own timetable and working-day calendar, not a label on a section.',
    permission: 'structure.manage',
    body: CreateShiftSchema,
    successStatus: 201,
    failures: [
      { status: 400, code: 'INVALID_SHIFT_TIMES', when: 'Ends before it starts, or not `HH:MM`.' },
      { status: 404, code: 'CAMPUS_NOT_FOUND', when: 'No such campus in this school.' },
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/sections',
    tag: 'Structure',
    summary: 'Create a section',
    permission: 'structure.manage',
    body: CreateSectionSchema,
    successStatus: 201,
    failures: [
      { status: 409, code: 'SHIFT_WRONG_CAMPUS', when: 'The working-day calendar is keyed by (campus, shift), so a borrowed shift leaves the section with no calendar.' },
      { status: 404, code: 'CLASS_LEVEL_NOT_FOUND', when: 'No such class at this school.' },
      { status: 404, code: 'CAMPUS_NOT_FOUND', when: 'No such campus.' },
      { status: 404, code: 'CLASS_TEACHER_NOT_FOUND', when: 'No such staff member.' },
      { status: 400, code: 'INVALID_CAPACITY', when: 'Capacity must be a positive whole number.' },
    ],
  },
  {
    method: 'PATCH',
    path: '/api/v1/sections/{sectionId}',
    tag: 'Structure',
    summary: 'Update a section',
    permission: 'structure.manage',
    body: UpdateSectionSchema,
    successStatus: 200,
    failures: [
      { status: 404, code: 'SECTION_NOT_FOUND', when: 'No such section at this school.' },
      { status: 409, code: 'CAPACITY_BELOW_OCCUPANCY', when: 'Capacity below the students already enrolled.' },
    ],
    notes: ['`null` clears a field; omitting it leaves the field alone.'],
  },

  // ── students ───────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/v1/students',
    tag: 'Students',
    summary: 'List students',
    description:
      'Keyset paginated, and SCOPE-NARROWED IN SQL — a class teacher scoped to two sections receives two sections of rows, not the school with the rest hidden by the client.',
    permission: 'student.read',
    query: [
      { name: 'sectionId', description: 'Only this section.' },
      { name: 'academicYearId', description: 'Which year the enrolment columns describe.' },
      { name: 'status', description: 'One of the lifecycle values. Anything else is ignored rather than rejected — a bookmarked URL should still work.' },
      { name: 'search', description: 'Matches either name script or the student code.' },
      { name: 'limit', description: '1–100, default 25. Larger values are capped, not refused.' },
      { name: 'cursor', description: 'From `nextCursor`. Opaque; a malformed one restarts the list rather than erroring.' },
    ],
    successStatus: 200,
    returns: '`{ items, nextCursor, hasMore }`. There is deliberately no total — a second count over the same predicate costs as much as the page.',
  },
  {
    method: 'GET',
    path: '/api/v1/guardian/children',
    tag: 'Guardians',
    summary: "The caller's own children",
    description:
      'Never takes a student id. The result is entirely determined by `guardian_link` rows already on file for `ctx.personId` — there is nothing in the request a guardian could alter to see a different family. This is deliberately a SEPARATE endpoint from `GET /students`, which answers for any student in the tenant to anyone holding `student.read`; a guardian holds that same permission key, so the household surface must never call the staff one.',
    permission: 'student.read',
    successStatus: 200,
    returns: 'An array of `{ studentId, studentCode, status, nameBn, nameEn, classNameEn, sectionNameEn, rollNo, relationship, isBillingGuardian, isPrimaryContact }`, one row per child regardless of how many years of enrolment history they carry.',
    failures: [],
  },
  {
    method: 'POST',
    path: '/api/v1/students',
    tag: 'Students',
    summary: 'Admit a student',
    description: 'Creates the person, the student, the first enrolment and the opening status event in one transaction.',
    permission: 'student.write',
    body: AdmitStudentSchema,
    successStatus: 201,
    returns: '`{ studentId, personId, enrolmentId, studentCode }`. The code is generated from the school pattern.',
    failures: [
      { status: 404, code: 'SECTION_NOT_FOUND', when: 'No such section at this school.' },
      { status: 400, code: 'INVALID_ADMISSION_DATE', when: 'A date is not `YYYY-MM-DD`.' },
    ],
    notes: ['Both names are required and neither is a translation of the other: the report card prints one, the board registration list needs the other.'],
  },
  {
    method: 'GET',
    path: '/api/v1/students/{studentId}',
    tag: 'Students',
    summary: 'One student, with guardians, enrolments and history',
    permission: 'student.read',
    successStatus: 200,
    returns: 'Includes `student.version`, which `PATCH` requires.',
    failures: [{ status: 404, code: 'STUDENT_NOT_FOUND', when: 'Absent, or in another school — RLS makes it invisible rather than forbidden.' }],
  },
  {
    method: 'PATCH',
    path: '/api/v1/students/{studentId}',
    tag: 'Students',
    summary: 'Correct a student record',
    permission: 'student.write',
    body: UpdateStudentSchema,
    successStatus: 200,
    returns: 'The new `version`.',
    failures: [
      { status: 409, code: 'CONCURRENT_MODIFICATION', when: 'Somebody else saved first. Re-read, re-apply, retry — never overwrite.' },
      { status: 400, code: 'NOTHING_TO_UPDATE', when: 'No field other than `version` was sent.' },
    ],
    notes: ['`null` clears a field; omitting it leaves the field alone.'],
  },
  {
    method: 'POST',
    path: '/api/v1/students/{studentId}/transition',
    tag: 'Students',
    summary: 'Change lifecycle status',
    description: 'applicant → admitted → active → on_leave → withdrawn → alumni. `alumni` is terminal; `withdrawn → active` is readmission.',
    permission: 'student.transition',
    body: TransitionStudentSchema,
    successStatus: 200,
    failures: [
      { status: 409, code: 'ILLEGAL_TRANSITION', when: 'Not a legal move. The CHECK constraint permits the value; the school does not.' },
      { status: 409, code: 'ALREADY_IN_STATUS', when: 'Already there. Refused rather than ignored — an event claiming a change that did not happen is worse.' },
      { status: 400, code: 'REASON_REQUIRED', when: 'Withdrawal and leave both require one.' },
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/students/{studentId}/withdraw',
    tag: 'Students',
    summary: 'Withdraw a student',
    description: 'A lifecycle event, not a settlement. Outstanding fees are unaffected and handled separately.',
    permission: 'student.transition',
    body: WithdrawStudentSchema,
    successStatus: 200,
  },
  {
    method: 'POST',
    path: '/api/v1/students/{studentId}/siblings',
    tag: 'Students',
    summary: 'Link two siblings',
    description: 'Drives sibling discounts and SMS deduplication. A student belongs to exactly one group, or a discount applies twice.',
    permission: 'student.write',
    body: LinkSiblingsSchema,
    successStatus: 200,
    failures: [
      { status: 400, code: 'SAME_STUDENT', when: 'A student cannot be their own sibling.' },
      { status: 409, code: 'ALREADY_LINKED', when: 'They are already in two different groups — that is a merge, not a link.' },
    ],
  },

  // ── guardians ──────────────────────────────────────────────────────────────
  {
    method: 'POST',
    path: '/api/v1/students/{studentId}/guardians',
    tag: 'Guardians',
    summary: 'Link a guardian',
    description:
      '`isBillingGuardian` (who owes) and `isPrimaryContact` (who is told) are SEPARATE. Separated parents: one may pay while the other is contacted.',
    permission: 'guardian.write',
    body: LinkGuardianSchema,
    successStatus: 201,
    returns: '`{ linkId, demoted }` — `demoted` names any link that lost a flag to this one.',
    failures: [
      { status: 409, code: 'ALREADY_LINKED', when: 'That person is already a guardian for this student.' },
      { status: 409, code: 'EMERGENCY_CANNOT_BILL', when: 'An emergency contact has not agreed to pay fees; an invoice addressed to a neighbour is a data-entry slip.' },
      { status: 404, code: 'PERSON_NOT_FOUND', when: '`guardianPersonId` is not a person at this school.' },
    ],
    notes: [
      'Send EXACTLY ONE of `guardianPersonId` or `person`. Naming both is refused rather than resolved by a precedence rule nobody would remember. **This rule is not in the JSON Schema** — a cross-field check cannot be expressed there.',
      'Claiming either flag demotes the incumbent in the same transaction, so the student is never briefly unbilled.',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/students/{studentId}/guardians/unlink',
    tag: 'Guardians',
    summary: 'Remove a guardian',
    permission: 'guardian.write',
    body: UnlinkGuardianSchema,
    successStatus: 200,
    failures: [
      { status: 409, code: 'LAST_CONTACT', when: 'A student with nobody to contact is unreachable — no absence SMS, no results, nobody to call.' },
      { status: 409, code: 'WOULD_LEAVE_NO_BILLER', when: 'Nominate another billing guardian first.' },
      { status: 404, code: 'NOT_LINKED', when: 'Not a guardian of this student.' },
    ],
  },

  // ── promotion ──────────────────────────────────────────────────────────────
  {
    method: 'POST',
    path: '/api/v1/sections/{sectionId}/promote',
    tag: 'Promotion',
    summary: 'Promote a section',
    description:
      'The riskiest bulk operation in the product. Reassigns roll numbers, and DOES NOT TOUCH DUES — arrears carry forward through finance.',
    permission: 'enrolment.promote',
    body: PromoteSectionSchema,
    successStatus: 200,
    returns: '`{ batchId, counts, enrolled }`. Keep `batchId`: it is what undo needs.',
    failures: [
      { status: 409, code: 'SECTION_EMPTY', when: 'Nobody in that section and year is awaiting an outcome.' },
      { status: 400, code: 'UNKNOWN_EXCEPTION', when: 'An exception names a student who is not in the section — usually the wrong section.' },
      { status: 400, code: 'SAME_YEAR', when: 'Cannot promote into the year being promoted from.' },
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/promotions',
    tag: 'Promotion',
    summary: 'Recent promotion runs',
    description:
      'The last few runs, newest first — what can still be taken back. Guarded by `enrolment.promote` rather than a read permission, because deciding what to undo is its only purpose.',
    permission: 'enrolment.promote',
    query: [
      { name: 'limit', description: 'Default 10, maximum 50.' },
    ],
    successStatus: 200,
    returns:
      'An array of `{ id, sectionNameEn, className, fromYearName, toYearName, promoted, retained, transferred, withdrawn, undoneAt, undoReason, at }`. A batch whose section or year has since been removed still appears, with nulls for the names — it is still undoable.',
    failures: [],
  },
  {
    method: 'POST',
    path: '/api/v1/promotions/{batchId}/undo',
    tag: 'Promotion',
    summary: 'Undo a promotion',
    description:
      'Removes exactly the enrolments that batch created, found by batch id — never by (section, year), which would also catch students enrolled by hand afterwards.',
    permission: 'enrolment.promote',
    body: UndoPromotionSchema,
    successStatus: 200,
    failures: [
      { status: 404, code: 'BATCH_NOT_FOUND', when: 'No such batch at this school.' },
      { status: 409, code: 'BATCH_ALREADY_UNDONE', when: 'Already reversed.' },
    ],
    notes: ['A leaver’s status is NOT restored. Reversing a lifecycle event needs its own decision and its own reason.'],
  },

  // ── merging ────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/v1/duplicates/persons',
    tag: 'People',
    summary: 'Possible duplicate people',
    description:
      'Proposed pairs with the evidence that proposed each one — a shared birth registration number, or a shared name together with a date of birth or a phone number. Name alone is deliberately not a signal: it is far too noisy to review. Decides nothing; the surviving record is whichever id the caller then puts in the merge path.',
    permission: 'student.merge',
    query: [{ name: 'limit', description: 'Default 25, maximum 100.' }],
    successStatus: 200,
    returns:
      'An array of `{ evidence, left, right, suggestedWinner }`. Each side carries `students`, `guardianLinks`, `staff`, `memberships` and `attachedTo` — the counts and the NAMES of what would move if that side lost. The names matter because a proposed pair has identical names by construction; the children behind each record are what distinguishes them. `suggestedWinner` is advice for a screen, never applied by the server.',
    failures: [],
  },
  {
    method: 'GET',
    path: '/api/v1/merges',
    tag: 'People',
    summary: 'Merges already made',
    description:
      'Newest first, with the names on both sides and the ids that moved. A reversal reachable only from the response that performed the merge keeps its promise for nobody but the person who ran it.',
    permission: 'student.merge',
    query: [{ name: 'limit', description: 'Default 10, maximum 50.' }],
    successStatus: 200,
    returns:
      'An array of `{ id, winnerPersonId, loserPersonId, names, moved, reason, reversedAt, reverseReason, at }`. A reversed merge stays listed.',
    failures: [],
  },
  {
    method: 'POST',
    path: '/api/v1/persons/{personId}/merge',
    tag: 'People',
    summary: 'Merge a duplicate person',
    description: 'The path id SURVIVES; the body names the duplicate. Dangerous — getting it wrong fuses two children’s records.',
    permission: 'student.merge',
    body: MergePersonsSchema,
    successStatus: 200,
    returns: '`{ mergeId, moved }`. Keep `mergeId` to reverse it.',
    failures: [
      { status: 400, code: 'SAME_PERSON', when: 'Winner and loser are the same record.' },
      { status: 409, code: 'ALREADY_MERGED', when: 'One of them already lost a merge that is still in force.' },
      { status: 403, code: 'CANNOT_MERGE_SELF', when: 'Neither may be the caller’s own person record.' },
    ],
    notes: ['Only DOMAIN references move. `created_by`, `updated_by` and the audit actor stay put — rewriting them would falsify who acted.'],
  },
  {
    method: 'POST',
    path: '/api/v1/merges/{mergeId}/reverse',
    tag: 'People',
    summary: 'Reverse a merge',
    description: 'Puts back exactly the rows that merge moved, by id — never everything currently pointing at the winner, who may have gained rows since.',
    permission: 'student.merge',
    body: UnmergePersonsSchema,
    successStatus: 200,
    failures: [
      { status: 404, code: 'MERGE_NOT_FOUND', when: 'No such merge at this school.' },
      { status: 409, code: 'MERGE_ALREADY_REVERSED', when: 'Already reversed.' },
    ],
  },

  // ── staff and roles ────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/v1/members',
    tag: 'Staff and roles',
    summary: 'Who works here',
    description: 'With their roles, their login identifier, and whether an invite is still outstanding.',
    permission: 'staff.read',
    successStatus: 200,
    returns: '`isSelf` marks the caller — the one membership they may not edit.',
  },
  {
    method: 'GET',
    path: '/api/v1/roles',
    tag: 'Staff and roles',
    summary: 'Roles and what each confers',
    permission: 'role.manage',
    successStatus: 200,
  },
  {
    method: 'POST',
    path: '/api/v1/staff/invites',
    tag: 'Staff and roles',
    summary: 'Invite a member of staff',
    description: 'No password is ever transmitted. They set their own from the link.',
    permission: 'membership.manage',
    body: InviteStaffSchema,
    successStatus: 201,
    returns:
      '`inviteToken` is returned ONCE and never stored in plaintext — put it in the link. It is `null` when the person already had a password: they gained a second school and sign in as they already do.',
    failures: [
      { status: 409, code: 'ALREADY_A_MEMBER', when: 'That person is already a member here.' },
      { status: 400, code: 'INVALID_IDENTIFIER', when: 'Not a Bangladeshi mobile in E.164, nor an email.' },
    ],
    notes: ['Send EXACTLY ONE of `personId` or `person`. **Not expressible in the JSON Schema.**'],
  },
  {
    method: 'POST',
    path: '/api/v1/staff/invites/{membershipId}/revoke',
    tag: 'Staff and roles',
    summary: 'Revoke an outstanding invite',
    description: 'The link stops working immediately.',
    permission: 'membership.manage',
    body: RevokeInviteSchema,
    successStatus: 200,
    failures: [{ status: 404, code: 'INVITE_NOT_FOUND', when: 'No live invite for that membership.' }],
  },
  {
    method: 'POST',
    path: '/api/v1/memberships/{membershipId}/roles',
    tag: 'Staff and roles',
    summary: 'Grant a role',
    permission: 'role.manage',
    body: GrantRoleSchema,
    successStatus: 201,
    failures: [
      { status: 403, code: 'SELF_GRANT_BLOCKED', when: 'Nobody edits their own membership, however privileged.' },
      { status: 403, code: 'CANNOT_GRANT_BEYOND_OWN', when: 'The role confers a permission the granter does not hold.' },
      { status: 409, code: 'ALREADY_GRANTED', when: 'They already hold it.' },
      { status: 404, code: 'ROLE_NOT_FOUND', when: 'No such role at this school.' },
      { status: 404, code: 'MEMBERSHIP_NOT_FOUND', when: 'No such membership at this school.' },
    ],
    notes: ['Both refusals are audited. The attempt is the signal.'],
  },
  {
    method: 'POST',
    path: '/api/v1/memberships/{membershipId}/roles/revoke',
    tag: 'Staff and roles',
    summary: 'Remove a role',
    permission: 'role.manage',
    body: RevokeRoleSchema,
    successStatus: 200,
    failures: [
      { status: 403, code: 'SELF_GRANT_BLOCKED', when: 'Locking yourself out of a one-administrator school is unrecoverable.' },
      { status: 404, code: 'NOT_GRANTED', when: 'They do not hold that role.' },
    ],
  },

  // ── finance ────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/v1/fee-heads',
    tag: 'Finance',
    summary: 'List fee heads',
    description: 'Tenant-wide, not per-school (§13.1) — a multi-school tenant shares one catalogue of fee kinds and prices them per school through fee structures instead.',
    permission: 'fee.read',
    successStatus: 200,
  },
  {
    method: 'POST',
    path: '/api/v1/fee-heads',
    tag: 'Finance',
    summary: 'Add a fee head',
    description: 'The priced items a school charges — tuition, exam, transport, a security deposit.',
    permission: 'fee.structure.manage',
    body: CreateFeeHeadSchema,
    successStatus: 201,
    failures: [{ status: 409, code: 'CODE_TAKEN', when: 'That code is already in use.' }],
  },
  {
    method: 'GET',
    path: '/api/v1/fee-structures',
    tag: 'Finance',
    summary: 'List fee structures',
    permission: 'fee.read',
    query: [{ name: 'academicYearId', description: 'Optional. Narrows the list to one academic year.' }],
    successStatus: 200,
  },
  {
    method: 'POST',
    path: '/api/v1/fee-structures',
    tag: 'Finance',
    summary: 'Price a class or a section for a fee head',
    description: 'Exactly one of `classLevelId` / `sectionId` — class-wide or section-specific, never both, never neither. A section can carry its own price on top of the class-wide one.',
    permission: 'fee.structure.manage',
    body: CreateFeeStructureSchema,
    successStatus: 201,
    failures: [
      { status: 404, code: 'YEAR_NOT_FOUND', when: 'No such academic year at this school.' },
      { status: 404, code: 'HEAD_NOT_FOUND', when: 'No such fee head.' },
      { status: 404, code: 'SCOPE_NOT_FOUND', when: 'No such class level or section.' },
      { status: 400, code: 'SCOPE_SCHOOL_MISMATCH', when: 'The class level or section belongs to a different school than the academic year.' },
      { status: 409, code: 'DUPLICATE_SCOPE', when: 'This head already has a price for this exact scope, in this year.' },
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/students/{studentId}/fee-assignments',
    tag: 'Finance',
    summary: 'List a student’s fee overrides',
    permission: 'fee.read',
    successStatus: 200,
  },
  {
    method: 'POST',
    path: '/api/v1/students/{studentId}/fee-assignments',
    tag: 'Finance',
    summary: 'Override the class price for one student',
    description: 'A scholarship, or a corrected amount for one student. Beats `fee_structure` for this exact (student, head, year).',
    permission: 'fee.structure.manage',
    body: CreateFeeAssignmentSchema,
    successStatus: 201,
    failures: [
      { status: 404, code: 'STUDENT_NOT_FOUND', when: 'No such student.' },
      { status: 404, code: 'HEAD_NOT_FOUND', when: 'No such fee head.' },
      { status: 404, code: 'YEAR_NOT_FOUND', when: 'No such academic year.' },
      { status: 409, code: 'ASSIGNMENT_TAKEN', when: 'This student already has an override for this head and year.' },
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/discounts',
    tag: 'Finance',
    summary: 'List discounts',
    permission: 'fee.read',
    query: [{ name: 'studentId', description: 'Optional. Narrows the list to one student.' }],
    successStatus: 200,
  },
  {
    method: 'POST',
    path: '/api/v1/discounts',
    tag: 'Finance',
    summary: 'Propose a discount',
    description: 'Only needs `fee.read` — it always lands `pending`. Nothing it does is real until it is approved.',
    permission: 'fee.read',
    body: CreateDiscountSchema,
    successStatus: 201,
    failures: [
      { status: 404, code: 'STUDENT_NOT_FOUND', when: 'No such student.' },
      { status: 404, code: 'HEAD_NOT_FOUND', when: 'No such fee head.' },
      { status: 400, code: 'INVALID_DATE_RANGE', when: '`validTo` is before `validFrom`, or either is malformed.' },
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/discounts/{discountId}/approve',
    tag: 'Finance',
    summary: 'Approve a discount',
    description: 'The principal alone (`fee.waive`) — collect / waive / refund stay separate, per the permission matrix.',
    permission: 'fee.waive',
    body: ApproveDiscountSchema,
    successStatus: 200,
    failures: [
      { status: 404, code: 'NOT_FOUND', when: 'No such discount.' },
      { status: 409, code: 'ALREADY_DECIDED', when: 'Already approved, rejected or revoked — approval is a one-way door.' },
    ],
  },

  // ── operations ─────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/health/live',
    tag: 'Operations',
    summary: 'Liveness',
    description: 'Touches nothing external. A liveness probe that checks the database restarts the app every time the database hiccups.',
    permission: null,
    successStatus: 200,
  },
  {
    method: 'GET',
    path: '/api/health/ready',
    tag: 'Operations',
    summary: 'Readiness',
    description: 'Checks the database as the app role. **503** when not ready, so a deploy cannot shift traffic to a replica that cannot reach it.',
    permission: null,
    successStatus: 200,
  },
  {
    method: 'GET',
    path: '/api/v1/health',
    tag: 'Operations',
    summary: 'Tenant surface health',
    permission: null,
    successStatus: 200,
  },
  {
    method: 'GET',
    path: '/api/platform/v1/health',
    tag: 'Operations',
    summary: 'Operator surface health',
    permission: null,
    successStatus: 200,
  },
  {
    method: 'GET',
    path: '/api/public/v1/health',
    tag: 'Operations',
    summary: 'Public surface health',
    permission: null,
    successStatus: 200,
  },
  {
    method: 'POST',
    path: '/api/hooks/{provider}',
    tag: 'Operations',
    summary: 'Provider webhook',
    description: 'Signature-verified per provider. Not part of the tenant API.',
    permission: null,
    successStatus: 200,
  },
];
