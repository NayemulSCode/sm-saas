# 9. The permission vocabulary and role seed

§46.7 item 4: the closed union, plus the role seed data. Code is the source of
truth; the `permission` table is generated from it
([§7.3](07-migrations-and-seed.md)).

## 9.1 The union

A closed TypeScript union, so a typo is a compile error rather than a silent
grant.

```ts
// modules/identity/domain/permissions.ts
export type Permission =
  // ── platform (operator console only) ────────────────────────────────
  | 'platform.tenant.provision' | 'platform.tenant.suspend'
  | 'platform.plan.manage'      | 'platform.impersonate'
  | 'platform.usage.read'

  // ── tenant settings ─────────────────────────────────────────────────
  | 'tenant.settings.manage'    | 'tenant.branding.manage'
  | 'role.manage'               | 'membership.manage'

  // ── structure ───────────────────────────────────────────────────────
  | 'structure.read'            | 'structure.manage'
  | 'academicYear.manage'       | 'academicYear.close'

  // ── directory ───────────────────────────────────────────────────────
  | 'student.read'              | 'student.write'
  | 'student.transition'                     // admit, withdraw, alumni
  | 'student.merge'
  | 'guardian.read'             | 'guardian.write'
  | 'staff.read'                | 'staff.write'
  | 'enrolment.manage'          | 'enrolment.promote'
  | 'document.read'             | 'document.write'

  // ── calendar (3c) ───────────────────────────────────────────────────
  | 'calendar.read'             | 'calendar.manage'
  | 'holiday.approve'

  // ── attendance (3c) ─────────────────────────────────────────────────
  | 'attendance.read'           | 'attendance.write'
  | 'attendance.amend'

  // ── assessment (3d) ─────────────────────────────────────────────────
  | 'scheme.read'               | 'scheme.manage'
  | 'mark.read'                 | 'mark.write'
  | 'mark.lock'                 | 'mark.moderate'
  | 'result.tabulate'           | 'result.publish'   | 'result.revise'

  // ── finance (3b) ────────────────────────────────────────────────────
  | 'fee.structure.manage'
  | 'fee.read'
  | 'fee.collect'                            // take money
  | 'fee.waive'                              // forgive money
  | 'fee.refund'                             // return money
  | 'fee.backdate'
  | 'fee.reconcile'
  | 'report.financial.read'

  // ── communication (3b) ──────────────────────────────────────────────
  | 'sms.send'                  | 'sms.budget.manage'
  | 'notice.publish'

  // ── data (3b) ───────────────────────────────────────────────────────
  | 'import.run'                | 'export.run'
  | 'report.read';
```

### The separations that matter

| Split | Why it is not one permission |
|---|---|
| `fee.collect` / `fee.waive` / `fee.refund` | The office assistant takes money; only the principal forgives it. Collapsing into `fee.write` is how a school loses money |
| `mark.write` / `mark.lock` / `mark.moderate` | Entering marks, freezing them, and adjusting a whole cohort are three different levels of trust |
| `result.tabulate` / `result.publish` / `result.revise` | Computing is routine; publishing is irreversible in perception; revising is an admission of error |
| `student.write` / `student.transition` | Editing a phone number is not the same as withdrawing a child |
| `attendance.write` / `attendance.amend` | Recording today differs from changing last week |
| `fee.backdate` | Backdating is permitted and audited, but it is not the default grant ([§17.8](../../architecture/phase-1b/17-finance-architecture.md)) |

`is_dangerous` in the `permission` table flags the ones that require a confirm
step and always write a `reason`: `fee.waive`, `fee.refund`, `result.publish`,
`result.revise`, `student.merge`, `academicYear.close`, `platform.impersonate`.

## 9.2 Role templates

Seeded into `role_template`, copied per tenant at provisioning
([§7.4](07-migrations-and-seed.md)). A tenant may edit its copies and add custom
roles from the same vocabulary.

| Role | Permissions |
|---|---|
| **Principal** | Everything except `platform.*`. Including `fee.waive`, `result.publish`, `academicYear.close` |
| **Vice Principal** | Principal minus `fee.waive`, `fee.refund`, `academicYear.close`, `role.manage` |
| **Class Teacher** | `student.read`, `guardian.read`, `attendance.read/write`, `mark.read/write`, `calendar.read`, `report.read` — **scoped to own sections** |
| **Subject Teacher** | `student.read`, `mark.read/write`, `attendance.read`, `calendar.read` — **scoped to own (section, subject) pairs** |
| **Accountant** | `fee.*` except `waive`; `report.financial.read`, `fee.reconcile`, `student.read`, `guardian.read`, `export.run` |
| **Office Assistant** | `student.read/write`, `guardian.read/write`, `enrolment.manage`, `fee.read`, `fee.collect`, `document.*`, `sms.send` |
| **Admission Officer** | `student.read/write`, `student.transition`, `guardian.read/write`, `document.*`, `import.run` |
| **Librarian** | `student.read` (+ library permissions when that module lands) |
| **Guardian** | `student.read`, `fee.read`, `attendance.read`, `result.read` — **scoped to own children via `guardian_link`** |
| **Student** | `attendance.read`, `result.read` — **scoped to self** |

Guardian and Student are real roles with real memberships. Their scope is not
expressed in `Scope` (which is campus/class/section/subject) but by the
**relationship join** — every guardian query passes through `guardian_link`, so
a guardian physically cannot address another family's child
([§8.7](../../architecture/phase-1a/08-identity-authn-rbac.md)).

## 9.3 Scope semantics

```ts
export interface Scope {
  campusIds?:  readonly CampusId[];
  classIds?:   readonly ClassLevelId[];
  sectionIds?: readonly SectionId[];
  subjectIds?: readonly SubjectId[];
}
```

| Rule | Meaning |
|---|---|
| Absent key | Unrestricted **within the tenant**. Never across tenants |
| Present, empty array | Denies everything. A misconfigured role fails closed |
| Several roles on one membership | Scopes **union** — a class teacher who is also exam controller gets both |
| `sectionIds` + `subjectIds` together | Interpreted as a **pair filter**, not a cross-product: a subject teacher teaching Maths in 6A gets Maths-in-6A, not everything in 6A |

The pair rule is the subtle one and is the reason
`staff_subject_assignment` carries both columns
([§4.2](04-schema-structure-directory.md)).

## 9.4 `authorize()`

```ts
export function authorize(
  ctx: AuthContext,
  permission: Permission,
  target?: ScopeTarget,
): asserts ctx is AuthorizedContext {
  if (ctx.readOnly && isWrite(permission)) throw new TenantSuspendedError();
  if (!ctx.permissions.has(permission))    throw new ForbiddenError(permission);
  if (target && !inScope(ctx.scope, target)) throw new OutOfScopeError(target);
}
```

Two enforcement points, deliberately redundant:

1. **On the way in** — `authorize()` rejects a write outside scope.
2. **On the way out** — list queries receive `scopeFilter(ctx, …)` predicates, so
   results are narrowed **in SQL** ([§6.4](06-drizzle-patterns.md)).

The second prevents the classic leak where a page fetches everything and hides
some rows in the UI.

### Grant rules

```
grantRole(ctx, membership, role):
  authorize(ctx, 'role.manage')
  if role.permissions ⊄ ctx.permissions        → 403 CANNOT_GRANT_BEYOND_OWN
  if membership.id == ctx.membershipId         → 403 SELF_GRANT_BLOCKED
  audit('role.granted', reason required)
```

Nobody can grant a permission they do not hold, and nobody can escalate
themselves. Both attempts are audited — the attempt is the signal.

## 9.5 The permission matrix test

Table-driven, exhaustive, and it fails the build when a permission is added
without expectations. This is what makes the vocabulary trustworthy.

```ts
const MATRIX: Array<[RoleCode, Permission, ScopeCase, 'allow' | 'deny']> = [
  ['ClassTeacher',    'attendance.write', 'ownSection',   'allow'],
  ['ClassTeacher',    'attendance.write', 'otherSection', 'deny'],
  ['ClassTeacher',    'fee.collect',      'any',          'deny'],
  ['SubjectTeacher',  'mark.write',       'ownPair',      'allow'],
  ['SubjectTeacher',  'mark.write',       'sameSectionOtherSubject', 'deny'],
  ['OfficeAssistant', 'fee.collect',      'any',          'allow'],
  ['OfficeAssistant', 'fee.waive',        'any',          'deny'],
  ['Accountant',      'fee.waive',        'any',          'deny'],
  ['Principal',       'fee.waive',        'any',          'allow'],
  ['Guardian',        'student.read',     'ownChild',     'allow'],
  ['Guardian',        'student.read',     'otherChild',   'deny'],
  // … one row per (role × permission × scope case)
];

it('every Permission appears in the matrix', () => {
  expect(new Set(MATRIX.map(r => r[1]))).toEqual(new Set(ALL_PERMISSIONS));
});
```

The last assertion is the important one: adding a permission to the union without
adding matrix rows fails CI, so the vocabulary cannot grow silently.

A companion lint rule flags any exported use case whose body does not call
`authorize()`.

## 9.6 Phase 3a scope

Only the permissions for modules that exist in 3a are *granted* in seeded roles:
`platform.*`, `tenant.*`, `structure.*`, `directory.*`, `role.manage`,
`membership.manage`, `import.run`, `export.run`, `report.read`.

The rest are **declared in the union now** — so the vocabulary is stable, the
`permission` table is complete, and role templates do not need editing in 3b–3d.
They simply become reachable when their module ships.
