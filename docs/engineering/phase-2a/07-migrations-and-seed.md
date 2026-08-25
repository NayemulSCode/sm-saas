# 7. Migrations and seed data

Forward-only, sequential, hand-written SQL. Rollback is achieved by deploying the
previous application version, which is why every migration must be **backwards
compatible with the release before it**.

## 7.1 Rules

| Rule | Reason |
|---|---|
| Forward-only, `NNNN_snake_description.sql` | Down-migrations are written under stress and rarely tested |
| **Backwards compatible for one release** | Rollback = redeploy the previous image. It must still run against the new schema |
| Expand → migrate → contract, across three releases | Add column · deploy · backfill · deploy code using it · drop old column in a *later* release. Never one step |
| `lock_timeout = '3s'` at the top of every migration | A blocked migration fails fast instead of freezing the school day |
| Indexes on populated tables use `CREATE INDEX CONCURRENTLY` | Avoids blocking writes; runs outside a transaction |
| Run as `sm_migrator`, never `sm_app` | [§5.1](05-rls-and-isolation-harness.md) |
| **Every migration adding a `tenant_id` table calls `app.enable_tenant_rls()` in the same file** | The structural test fails the build otherwise |
| Tested against a restored production-shaped dump before release | Migrations that pass on an empty database and fail on real data are the norm |

```sql
-- Header on every migration file.
SET lock_timeout = '3s';
SET statement_timeout = '5min';
```

## 7.2 The Phase 3a migration set

Order is constrained by `person` ← every `[T]` table's `created_by`, and
`tenant` ← `person.tenant_id` ([§3.1](03-schema-platform-identity.md)).

| # | Migration | Contents |
|---|---|---|
| `0001` | `roles_and_schema` | `sm_migrator/app/readonly/platform`, `app` schema, default privileges, `statement_timeout` per role |
| `0002` | `extensions_and_functions` | `pg_trgm`, `citext` if needed; `app.current_tenant_ids/id/actor_id`, `app.touch_updated_at`, `app.enable_tenant_rls` |
| `0003` | `platform` | `plan`, `plan_feature`, `tenant`, `tenant_feature_override`, `permission`, `role_template` |
| `0004` | `identity_global` | `account`, `credential`, `session`, `otp_challenge` |
| `0005` | `person` | `person` + trigram indexes + RLS. **First `[T]` table — the isolation suite must go green here** |
| `0006` | `identity_tenant` | `membership`, `role`, `role_permission`, `membership_role` |
| `0007` | `structure` | `organization`, `school`, `campus`, `shift`, `academic_year`, `term`, `class_level`, `section` |
| `0008` | `directory` | `student`, `student_status_event`, `enrolment`, `guardian_link`, `sibling_group`, `sibling_member`, `staff`, `staff_section_assignment`, `staff_subject_assignment`, `document` |
| `0009` | `cross_cutting` | `audit_log`, `idempotency_key`, `domain_event` |
| `0010` | `platform_billing` | `platform_invoice`, `platform_payment`, `tenant_usage_meter`, `operator_audit` |
| `0011` | `jobs` | pg-boss schema, installed by its own migrator into schema `pgboss` |

Migration `0005` is the milestone: the first tenant-owned table, and therefore
the first run of the generated isolation suite. It must be green before `0006`
is written — that is the sequencing §46.7 asks for.

## 7.3 Seed data

Three tiers. Only tier 1 ships to production.

### Tier 1 — platform reference data (production)

Idempotent, re-runnable, versioned with the code. `scripts/seed-platform.ts`.

| Set | Contents | Notes |
|---|---|---|
| `permission` | Every key in the `Permission` union | **Generated from the TypeScript union** — the code is the source of truth ([§9](09-permissions-and-roles.md)) |
| `role_template` | Principal, Vice Principal, Class Teacher, Subject Teacher, Accountant, Office Assistant, Librarian, Admission Officer, Guardian, Student | Copied into each tenant at provisioning |
| `plan` + `plan_feature` | Starter / Standard / Multi-campus | Prices from [§42](../../architecture/phase-1c/42-cost-model.md) |
| `government_holiday` | The current and next year's national calendar | Phase 3c; stubbed as an empty version now |

### Tier 2 — tenant provisioning defaults

Not "seed" so much as what `provisionTenant` writes. Copied per tenant so the
school can edit them without affecting anyone else — the central point of
[§4 of the brief](../../architecture/phase-1a/03-functional-requirements.md).

| Set | Default |
|---|---|
| Roles | From `role_template`, with `is_system = true` |
| Academic year | Current calendar year, Jan 1 – Dec 31, `is_current` |
| Campus | One, `is_primary` |
| Shift | One, "Day", 08:00–14:00 |
| Class levels | Play, Nursery, KG, Class 1–5, sequence 1–8 |
| Weekly off | Friday + Saturday, effective from the year start |
| Grade scale | GPA 5.0 bands **and** a 4-level descriptive scale — both, because a tenant may use each at different class levels |
| Fee heads | Admission, Monthly Tuition, Exam, Transport, Others |

Every default is editable. None is referenced by code — the seed writes rows,
and the application reads rows.

### Tier 3 — development and E2E fixtures

`scripts/seed-dev.ts`. Never runs against production; guarded on
`NODE_ENV !== 'production'` **and** a database-name check.

- **Two tenants**, always. A single-tenant dev database makes cross-tenant bugs
  invisible, and the isolation suite needs a second tenant to leak *into*.
- Tenant A: ~200 students across 8 class levels, 2 sections each, guardians with
  deliberately shared phone numbers, one sibling group, one separated-parent
  family with divergent `is_billing_guardian` / `is_primary_contact`.
- Tenant B: minimal, exists to be leaked into.
- **Bangla names throughout**, including conjunct-heavy and transliteration-variant
  names (মোহাম্মদ / মুহাম্মদ), so duplicate detection and PDF shaping have real
  data from day one.
- Deterministic: seeded PRNG, fixed ULIDs, so a failing E2E test reproduces.

The shared-phone and separated-parent fixtures exist because those are the cases
the identity model was designed for
([ADR-0006](../../architecture/adr/0006-identity-model.md)); if they are not in
the seed, nobody exercises them until a real school does.

## 7.4 Provisioning a tenant

One transaction. A half-provisioned tenant is unusable and hard to detect
([§14.2](../../architecture/phase-1b/14-module-architecture.md)).

```
provisionTenant(input):
  BEGIN
    insert tenant                      (status='trial', shard_id='primary')
    copy role_template  → role, role_permission
    insert school, campus(is_primary), shift
    insert academic_year(is_current), class_level[], weekly_off_pattern
    insert grade_scale[], fee_head[]
    insert person(owner), account, credential(phone), membership,
           membership_role(Principal)
    audit('tenant.provisioned')
  COMMIT
  → send owner an OTP-based first-login SMS   (enqueued in the same transaction)
```

Runs as `sm_platform`, because it writes rows for a tenant that does not exist
yet and therefore cannot have a tenant session context. It is one of the few
legitimate uses of that role, and it is audited to `operator_audit`.

## 7.5 Restore and drift

| Concern | Mechanism |
|---|---|
| Schema drift between TS and DB | `pnpm db:drift` in CI ([§6.6](06-drizzle-patterns.md)) |
| Migration correctness on real data | Rehearse against a restored dump before release |
| Restore drill | Quarterly, `scripts/restore-drill.sh` ([§36.5](../../architecture/phase-1c/36-backup-dr.md)) |
| Seed idempotency | Tier 1 seed re-run in CI twice; the second run must be a no-op |

The double-run seed test catches the classic bug where a seed uses `INSERT`
rather than `INSERT … ON CONFLICT DO NOTHING` and breaks the second deploy.
