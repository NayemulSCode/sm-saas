# ADR-0013 — The academic calendar is infrastructure, with one materialized answer

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1A

## Context

Attendance, timetable, examinations, fees and notifications all need the same
answer: **is date *D* a working day for section *S*?**

If each module computes it independently they will disagree, and the
disagreement surfaces as a late fee charged for a day the school was shut, or an
exam scheduled on Eid.

The domain makes this harder than a holiday list. Holidays inherit across five
levels; a school must be able to **suppress** an inherited government holiday,
not merely add to it; Eid dates are provisional until moon sighting; the
government declares closures **after** attendance has already been taken; and
the weekend itself is per-school, per-shift configuration that has changed
nationally within living memory.

## Options

### A. Each module computes working days from holiday rows as needed
No new tables. Guaranteed divergence, repeated expensive resolution, and no
single place to fix a bug.

### B. A shared `CalendarService` computing on demand, cached in memory
One implementation, so no divergence. Resolution runs on every attendance screen
load; cache invalidation across five inheritance levels is subtle; and a
retroactive holiday has no record of what changed.

### C. A shared service over a **materialized `working_day` table**, rebuilt by
explicit triggers
One indexed lookup answers the hot question. Rebuilds are auditable jobs.
Requires disciplined invalidation and stores derived data.

## Decision

**C.**

`working_day` is keyed `(tenant_id, campus_id, shift_id, date)` and carries the
status, the holiday that caused it, and a **localised reason string** so the UI
can say "Friday — weekly off" or "Eid-ul-Fitr vacation (school calendar)" rather
than "not a working day".

Resolution runs **suppression first, then precedence**:

```
1. Collect candidate holidays for the date across all levels
2. Remove any holiday suppressed by a more specific level   ← FR-5.4
3. Apply precedence: section > class > campus > school > organization > platform
4. Apply the effective-dated weekly-off pattern
5. Apply academic-year bounds
6. Write status + source + reason
```

Rebuild triggers are explicit and each enqueues a `calendar_recompute` row:
holiday created/edited/confirmed/cancelled, weekly-off pattern changed,
academic-year bounds changed, government calendar version imported, campus or
shift created.

**Retroactive declarations** (FR-5.8) are the case this design exists for. When
a holiday is declared over dates that already have attendance, the recompute
job: reclassifies affected attendance by writing **new superseding rows** rather
than editing history; suspends late-fee accrual for those dates; flags
conflicting exam schedules and timetable entries; notifies affected users; and
records the whole change set in `calendar_recompute.changes` so it can be
reversed.

Sizing: 100 schools × 2 campuses × 2 shifts × 365 days ≈ 146,000 rows a year.
Trivial.

## Consequences

**Makes easy:** one indexed lookup for the hottest question in the system; one
place to fix a calendar bug; auditable, reversible recomputation; a UI that can
always explain itself.

**Makes hard:** invalidation must be right, or the table drifts from its
sources. Mitigated by a nightly consistency job that recomputes a sample and
alerts on mismatch. Recompute over a long range is a background job, so a
newly declared holiday is not instantaneous everywhere.

**Forecloses:** per-student calendar exceptions. If a student ever needs an
individual working-day calendar — extended medical leave, say — that is an
attendance-level exemption, not a calendar level. Deliberate: adding a sixth
inheritance level would multiply the table by the student count.

## Revisit when

- A per-student or per-subject calendar requirement appears and cannot be
  modelled as an attendance exemption.
- `working_day` rebuild time for one tenant-year exceeds ~30 seconds.
- Recurrence needs exceed generated instances plus exception dates — at which
  point revisit the brief's own instruction not to build an RFC 5545 engine.
