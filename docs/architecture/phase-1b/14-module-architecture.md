# 14. Module architecture

[§9](../phase-1a/09-domain-boundaries.md) fixed the module map and the dependency
direction. This section specifies what each module actually contains: its use
cases, the invariants it owns, its published surface, and the events it emits.

## 14.1 The shape every module takes

```
modules/<name>/
  domain/            pure. entities, value objects, rules, port interfaces
    <entity>.ts
    rules/           the decision logic, testable with no database
    ports.ts         interfaces this module needs someone else to implement
  application/       one file per business action
    <verb><Noun>.ts  e.g. recordPayment.ts, publishResults.ts
  infrastructure/    Drizzle repositories, provider adapters, mappers
  events.ts          the events this module emits, as types
  index.ts           THE public surface. Nothing else is importable
```

A use case is a function with a fixed shape. This is the only place
authorization, transactions and auditing happen, which is why they cannot be
forgotten:

```ts
export async function recordPayment(
  ctx: AuthContext,
  input: RecordPaymentInput,
): Promise<Result<Payment, PaymentError>> {
  authorize(ctx, 'fee.collect');                    // 1. always
  const parsed = RecordPaymentSchema.parse(input);  // 2. Zod at the boundary

  return withTenant(ctx, async (tx) => {            // 3. tenant session set
    await claimIdempotency(tx, ctx, parsed.idempotencyKey);
    // 4. domain decisions — pure functions, no IO
    const allocation = allocatePayment(parsed.amount, outstanding, policy);
    // 5. persistence
    const payment = await payments.insert(tx, ...);
    // 6. events enqueued IN THIS TRANSACTION
    await enqueue(tx, 'sms.payment_receipt', { paymentId: payment.id });
    // 7. audit
    await audit(tx, ctx, 'payment.recorded', payment.id, { after: payment });
    return ok(payment);
  });
}
```

Steps 1, 3, 6 and 7 are mechanical. They are wrapped in a `useCase()` helper in
Phase 2 so the boilerplate cannot drift — but the ordering above is the contract.

## 14.2 `platform`

Owns tenant lifecycle, plans, entitlements, platform billing and operator
actions.

| Use case | Invariant it protects |
|---|---|
| `provisionTenant` | Creates tenant, seeds system roles, default calendar, fee heads, grade scales, and the first owner account — atomically. A half-provisioned tenant is unusable and hard to detect |
| `changePlan` | Entitlement changes take effect at period boundaries, never mid-cycle retroactively |
| `suspendTenant` | Suspension is **read-only plus export**, never data removal ([§13.4 OQ-21](../phase-1a/13-open-questions.md)) |
| `reactivateTenant` | Restores write access without replaying billing |
| `offboardTenant` | Export first, deletion only after the retention SLA, both audited |
| `recordUsageMeter` | Written by a nightly batch, never on the request path |

**Entitlement check** is one function, server-side only:

```ts
can(ctx, 'sms_monthly')        // → { enabled: boolean, limit?: number, used?: number }
```

The client never decides entitlement. It may *render* based on the answer, but
every gated use case re-checks. A feature flag evaluated only in the UI is a
feature flag that a curl request ignores.

## 14.3 `identity`

Owns accounts, credentials, sessions, memberships, roles and the permission
vocabulary. Designed in [§8](../phase-1a/08-identity-authn-rbac.md).

| Use case | Note |
|---|---|
| `requestOtp` / `verifyOtp` | Identical response for known and unknown numbers |
| `authenticatePassword` | Argon2id; constant-time comparison; lockout after N failures |
| `resolveContexts` | Account → list of (tenant, person, roles, scope) |
| `switchContext` | Rewrites the **server-side** session. The client cannot select a context it has no membership for |
| `inviteStaff` | Single-use link; the invitee sets their own password. No password is ever transmitted |
| `grantRole` / `revokeRole` | Cannot grant a permission the granter lacks; self-grant blocked and audited |
| `revokeSession` / `revokeAllSessions` | Must take effect within 60 s (NFR §4.6) |

Owns two things no other module may touch: the `Permission` union, and
`authorize()`.

## 14.4 `structure`

Organizations, schools, campuses, shifts, class levels, sections, academic years,
terms.

| Use case | Invariant |
|---|---|
| `openAcademicYear` | Exactly one `is_current` per school, enforced by a partial unique index |
| `closeAcademicYear` | Refuses while any exam is `marks_open` or any invoice is `draft` |
| `createSection` | Capacity, class teacher, campus and shift all resolved; a section without a shift is unschedulable |
| `reorderClassLevels` | `sequence` drives promotion; reordering mid-year is blocked |

The module is small and boring, and everything else depends on it. That is the
correct shape for a foundation module.

## 14.5 `directory`

Persons, students, guardians, staff, documents, enrolment, promotion, merging.

| Use case | Invariant |
|---|---|
| `admitStudent` | Creates person + student + first enrolment + status event in one transaction |
| `transitionStudentStatus` | Only legal transitions; every one writes a `student_status_event` with actor and reason |
| `promoteSection` | Bulk, with per-student exceptions. Assigns new roll numbers. **Does not touch dues** — arrears carry via `finance` |
| `linkGuardian` | Enforces at most one `is_billing_guardian` per student |
| `mergePersons` | Repoints every FK in one transaction; loser marked `merged_into`; reversible |
| `withdrawStudent` | Emits `StudentWithdrawn`; `finance` decides what happens to dues |

`promoteSection` is the riskiest bulk operation in the product — it rewrites a
whole cohort's enrolment. It runs as a chunked job with a recorded batch id and
a compensating action, so "undo the promotion, we ran it on the wrong section"
is a supported operation rather than a restore.

## 14.6 `calendar`

Designed in detail in [§16](16-calendar-engine.md). Publishes the
`CalendarService` contract from [§9.3](../phase-1a/09-domain-boundaries.md) and
owns `working_day`. No other module writes to it; no other module recomputes it.

## 14.7 `academics`

Curricula, subjects, class-subject mapping, books, periods, timetable,
substitutions.

| Use case | Invariant |
|---|---|
| `assignSubjectsToClass` | A subject cannot be both mandatory and fourth-subject for one class |
| `saveTimetableEntry` | Validates teacher clash, room clash, period belongs to the shift, day is a working day |
| `assignSubstitute` | Date-scoped; never edits the base entry |

**Timetable clash detection is MVP; timetable generation is not.** Detection is
a set of queries returning conflicts with severity; generation is a
constraint-solving project, and no school will switch vendors to get it
([FR-14](../phase-1a/03-functional-requirements.md)).

Conflict rules, evaluated on save and re-evaluated when the calendar changes:

| Rule | Severity |
|---|---|
| Teacher booked in two rooms in the same period | **block** |
| Room booked twice in the same period | **block** |
| Class scheduled on a non-working day | warn |
| Teacher exceeds a configured weekly period cap | warn |
| Subject scheduled fewer times than its curriculum requirement | warn |

## 14.8 `attendance`

| Use case | Invariant |
|---|---|
| `submitAttendance` | Rejects non-working days (asks `calendar`). Idempotent on `client_ref` |
| `syncOfflineBatch` | Replays a queued batch; duplicates collapse on the unique index — see [§27](27-mobile-offline.md) |
| `amendAttendance` | Writes a **new superseding row**; never updates in place |
| `reclassifyForHoliday` | Called only by `calendar`'s recompute job |
| `summarise` | Monthly and per-student; reads `working_day` for the denominator |

The denominator matters more than people expect. "85% attendance" is meaningless
unless every module agrees on how many working days there were — which is
precisely why `working_day` is materialised once
([ADR-0013](../adr/0013-calendar-as-infrastructure.md)).

**Attendance-triggered SMS** is emitted as an event, batched, deduplicated by
guardian phone, and rate-limited against the tenant's SMS budget. It is never
sent inline with the teacher's submit — the teacher's request must return in
under a second on a 3G connection.

## 14.9 `assessment`

Designed in detail in [§15](15-assessment-engine.md).

## 14.10 `finance`

Designed in detail in [§17](17-finance-architecture.md).

## 14.11 `notification`

Designed in detail in [§18](18-notification-architecture.md).

## 14.12 `documents`

Templates, render jobs, generated artefacts. Designed in [§24](24-documents-pdf-bangla.md).

| Use case | Invariant |
|---|---|
| `renderDocument` | Always a job. Never renders inline with a request |
| `renderBatch` | Chunked; progress reported; resumable |
| `getSignedUrl` | Authorization is checked **before** signing, never after |

## 14.13 `dataport`

Import staging, validation, commit, duplicate detection, tenant export. Designed
in [§25](25-data-import.md).

## 14.14 `reporting`

Read-only. Designed in [§26](26-reporting-data-path.md).

## 14.15 Deferred modules — what is designed for now

| Module | What exists in Phase 1 | What is deliberately absent |
|---|---|---|
| `cms` | Routing model, tenant content boundary, [§21](21-cms-architecture.md) | Editor, block library, media pipeline |
| `library` | Entity sketch; fine linkage into `finance` | Everything else |
| `inventory` | Entity sketch | Everything else |
| `transport` | Entity sketch; route→student assignment feeding a transport fee head | Tracking, of any kind |

Each is a directory that does not exist yet. Their absence is the point: an
empty module costs nothing, a half-built one costs maintenance.

## 14.16 Event catalogue

Emitted inside the transaction that caused them
([ADR-0010](../adr/0010-job-queue.md)). Payloads carry **ids only** — consumers
re-read current state, so a delayed job cannot act on stale data.

| Event | Emitted by | Consumed by |
|---|---|---|
| `StudentAdmitted` | directory | finance (generate opening invoices), notification |
| `StudentPromoted` | directory | finance (carry arrears forward) |
| `StudentWithdrawn` | directory | finance (settle or write off), notification |
| `AttendanceRecorded` | attendance | notification (absence SMS, batched) |
| `AttendanceAmended` | attendance | reporting (invalidate cached summaries) |
| `MarksLocked` | assessment | documents (pre-render tabulation) |
| `ResultsPublished` | assessment | notification (staggered fan-out — [§4.3](../phase-1a/04-non-functional-requirements.md)), documents |
| `ResultRevised` | assessment | notification, documents (re-render) |
| `InvoiceGenerated` | finance | notification |
| `PaymentRecorded` | finance | notification (receipt SMS) |
| `PaymentReversed` | finance | notification, reporting |
| `LateFeeAccrued` | finance | notification (optional per tenant) |
| `HolidayConfirmed` | calendar | calendar (recompute), notification |
| `CalendarRecomputed` | calendar | attendance, assessment, finance |
| `TenantSuspended` / `TenantReactivated` | platform | all — gates writes |

## 14.17 Where each module's risk actually is

Honest assessment, to inform sequencing in Phase 1C.

| Module | Risk | Why |
|---|---|---|
| `assessment` | **Highest** | Configuration surface is enormous; errors are public and reputational |
| `finance` | **Highest** | Errors are financial and unrecoverable in perception |
| `calendar` | High | Subtle; wrong answers surface indirectly, in other modules |
| `dataport` | High | Runs during the onboarding window, on data nobody has seen before |
| `attendance` | Medium | Offline sync is fiddly; the domain itself is simple |
| `identity` | Medium | Model is unusual, so bugs are conceptual rather than mechanical |
| `notification` | Medium | Cost overruns and duplicate sends are the failure modes |
| `documents` | Medium | Bangla shaping is the risk; resolved by the spike ([OQ-12](../phase-1a/13-open-questions.md)) |
| `structure`, `academics`, `platform` | Low | CRUD with constraints |
