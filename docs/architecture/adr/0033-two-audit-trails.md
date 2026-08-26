# ADR-0033 — Two audit trails: `auth_event` (global) and `audit_log` (tenant)

**Status:** Accepted
**Date:** 2026-08-26
**Deciders:** Engineering

## Context

Non-negotiable 4 says every mutation is audited — actor, tenant, timestamp,
before/after, reason — and
[§8](../../engineering/phase-2a/08-auth-and-session.md) line 204 says *"every
authentication event appears in `audit_log`"*.

Those two sentences cannot both be satisfied by one table.
[§3.4](../../engineering/phase-2a/03-schema-platform-identity.md) defines
`audit_log` with `tenant_id uuid NOT NULL`, and it is a `[T]` table, so RLS
applies. But authentication happens **before a tenant is known**:

- `account`, `credential` and `session` are global tables (migration `0004`).
  One login reaches several schools — that is the entire point of the identity
  model ([ADR-0006](0006-identity-model.md)).
- `withPlatform` deliberately sets **no** tenant context, so
  `app.current_tenant_ids()` returns an empty array and every policy matches
  nothing. An `audit_log` insert from the login path is refused by RLS.
- A failed attempt on an unknown phone number has **no tenant at all**, not even
  in principle. It is the single most important row to keep during an attack.

So the question is not where to put authentication events. It is what to give
up in order to record them.

## Options

### A. Make `audit_log.tenant_id` nullable

Everything lands in one table, and "show me everything that happened" is one
query.

But a NULL `tenant_id` matches no RLS policy, so the row becomes invisible to
everyone — including the tenant that needs it. This is precisely the mistake
already rejected for `role.tenant_id`
([§3.3](../../engineering/phase-2a/03-schema-platform-identity.md)), where
Phase 1's sketch allowed NULL for platform templates and Phase 2 corrected it by
moving templates to `role_template`.

It would also break the isolation harness rule that *every* `tenant_id` column
has RLS enabled, forced, and a `WITH CHECK` policy. That rule earns its keep by
having **no exceptions list**; the first exception is the one that makes the
next one arguable.

### B. Guess a tenant at login time

Resolve the account's memberships and attribute the event to one of them.

Writes a lie into the audit trail. An account with two schools has no single
correct answer, and an unknown identifier has none at all. An audit trail that
is sometimes fiction is worse than one with a documented gap, because nobody can
tell which rows to trust.

### C. Two tables, split on what the event is *about*

`auth_event` — global, no `tenant_id`, for events about an **account**:
OTP requested and verified, password attempted, account locked, session created
and revoked, context switched, invite accepted.

`audit_log` — tenant-owned, RLS enforced, for events about something **inside a
school**: invite created and revoked, and every mutation the modules add.

## Decision

**Option C.** The split follows the grain the data already has: `account` and
`session` are global tables, `person` and `membership` are tenant-owned, and the
audit for each lives where its subject lives.

The single reason: **the isolation harness rule stays absolute.** Every column
named `tenant_id` in this schema has RLS, with no exceptions to remember and
none to argue about later. Option A buys one convenient query and pays for it by
turning a structural guarantee into a policy with a footnote.

Some moments appear in both trails, and that is correct rather than duplication:
inviting a staff member is a tenant mutation (`audit_log`), accepting the invite
is an authentication event (`auth_event`). They are two different facts about
two different subjects, recorded by two different actors.

### Both tables are append-only

Neither is created with `app.make_tenant_table`. That helper adds `updated_at`,
`deleted_at`, `delete_reason` and `version`, every one of which is a lie on a
row that must never change.

`sm_app` and `sm_platform` are granted `SELECT` and `INSERT` and nothing else.

A one-off `REVOKE` in the migration was the first attempt and it did not hold:
`scripts/dev-set-role-passwords.ts` runs afterwards with
`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public`, which
handed both privileges straight back. The isolation suite caught it on the first
CI run — the append-only claim was false for about an hour, and only a test that
actually attempted an `UPDATE` would have noticed.

So which tables are append-only is now **data**, in `app.append_only_table`, and
`app.enforce_append_only()` re-asserts the revocation for every registered
table. It is idempotent, any script that grants broadly ends with it, and a
table registered by a future migration is covered without editing those scripts.
The migration also fails outright if `sm_app` can `UPDATE` either table when it
finishes, so the hole cannot reopen quietly.

### Redaction is enforced, not requested

Invariant 12 says `before`/`after` hold ids and changed field names, not values.
`src/db/audit.ts` enforces this on the way in: a value survives only if it is a
ULID, a UUID or a boolean, and everything else becomes `[redacted]`.

It fails **safe**. A column added to a table next year is redacted by default
because it will not look like an id — nobody has to remember to add it to a
blocklist. The diff is computed on the raw rows *before* redaction, which is why
`audit()` takes real rows: redacted values all compare equal, so a diff taken
afterwards would find nothing.

The identifier on `auth_event` is stored as an unsalted SHA-256. Unsalted
deliberately — a salt would make two attempts on the same phone number hash
differently, destroying the only property the column exists for. It is not a
confidentiality control; the input space is small enough to brute-force. It is
there so that a support engineer reading the table does not read a list of
phone numbers.

## Consequences

**Makes easy:**

- Recording a failed login for an identifier that belongs to nobody — the case
  that matters most during an attack and that a tenant-scoped table cannot hold.
- Answering "which schools did this account move between" without reading every
  tenant's log.
- Keeping the RLS catalogue rule exception-free, so the harness stays a proof
  rather than a checklist.

**Makes hard:**

- "Everything that happened, in one list" is now a `UNION` across two tables
  with different shapes. Acceptable: the two questions are asked by different
  people — a school administrator reviewing their own school, and an operator
  investigating an account.
- Correlating a login to the tenant work that followed it requires joining on
  `request_id`. Both tables carry it, which is why it is `NOT NULL` on both.

**Forecloses:**

- A single `audit_log` covering everything, unless authentication stops being
  global — which would mean giving up one login across several schools.

## Revisit when

An operator investigation requires the `UNION` more than **once a week**, or
when the first cross-tenant reporting feature ships and needs a unified event
stream. Either is a reason to add a view over both tables — not to merge them.

Also revisit when `audit_log` passes **100 M rows**, which is the partitioning
trigger already named in
[§10.7](../../engineering/phase-2a/10-api-contracts.md); partitioning is easier
to introduce before a merge than after one.
