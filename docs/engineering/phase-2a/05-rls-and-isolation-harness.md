# 5. RLS, roles and the generated isolation harness

Invariant 1, made executable. [§46.7](../../architecture/phase-1c/46-decision-summary.md)
requires the harness to exist **before the first tenant table** — so this is the
first migration and the first test, not a retrofit.

## 5.1 Roles

Created once, by migration `0001`, before any table.

```sql
-- Owns the schema, runs DDL. NEVER used by the running application.
CREATE ROLE sm_migrator LOGIN PASSWORD :'migrator_pw';

-- The application and worker. No BYPASSRLS. Not a superuser. DML only.
CREATE ROLE sm_app LOGIN PASSWORD :'app_pw';

-- Reporting and the replica. SELECT only; RLS still applies.
CREATE ROLE sm_readonly LOGIN PASSWORD :'ro_pw';

-- The ONE legitimate way past the wall: operator console, cross-tenant jobs,
-- context resolution at login. Separate credentials, separate pool, every use
-- audited (ADR-0029).
CREATE ROLE sm_platform LOGIN PASSWORD :'platform_pw' BYPASSRLS;

CREATE SCHEMA app AUTHORIZATION sm_migrator;
GRANT USAGE ON SCHEMA app, public TO sm_app, sm_readonly, sm_platform;

ALTER DEFAULT PRIVILEGES FOR ROLE sm_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE sm_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO sm_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE sm_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sm_platform;

ALTER ROLE sm_app       SET statement_timeout = '15s';
ALTER ROLE sm_readonly  SET statement_timeout = '5min';
ALTER ROLE sm_platform  SET statement_timeout = '60s';
```

The worker connects as `sm_app` but overrides `statement_timeout` per
transaction — a five-minute report must not run under the interactive limit, and
an interactive request must not be able to hold a connection for five minutes.

**`sm_app` must never gain `BYPASSRLS`.** A deploy-time assertion checks this
against the live database ([§5.6](#56-what-ci-asserts)).

## 5.2 Session functions

```sql
-- STABLE, so the planner evaluates it once per query and the index on
-- (tenant_id, …) is still used with = ANY(...). Verified by OQ-15.
CREATE FUNCTION app.current_tenant_ids() RETURNS uuid[]
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT COALESCE(
      string_to_array(current_setting('app.tenant_ids', true), ',')::uuid[],
      ARRAY[]::uuid[]                      -- unset ⇒ matches nothing ⇒ fails CLOSED
    )
  $$;

CREATE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT (app.current_tenant_ids())[1]
  $$;

CREATE FUNCTION app.current_actor_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.actor_id', true), '')::uuid
  $$;
```

**Failing closed is the whole point.** If `withTenant` is bypassed and the GUC is
unset, `current_tenant_ids()` returns an empty array, every policy matches
nothing, and queries return zero rows. A bug becomes visible and harmless rather
than silent and catastrophic.

## 5.3 The policy template

Applied by a migration helper to every `[T]` table. Never hand-written per
table — hand-written policies are where the one missing `FORCE` hides.

```sql
-- app.enable_tenant_rls('student')  emits exactly this:
ALTER TABLE student ENABLE ROW LEVEL SECURITY;
ALTER TABLE student FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON student
  USING      (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

CREATE INDEX IF NOT EXISTS student_tenant_id_idx ON student (tenant_id);
```

| Clause | Why it is load-bearing |
|---|---|
| `ENABLE` | Turns policies on for non-owner roles |
| **`FORCE`** | Without it the **table owner bypasses RLS**. Migrations create tables as `sm_migrator`; omitting `FORCE` silently disables isolation for any connection using that role |
| `USING` | Filters reads |
| **`WITH CHECK`** | Blocks writing a row *into* another tenant. `USING` alone does not |

## 5.4 `withTenant` — the only path to the database

```ts
// src/db/rls.ts
export function withTenant<T>(
  ctx: AuthContext,
  fn: (tx: Tx) => Promise<T>,
  opts?: { readOnly?: boolean; timeout?: string; synchronousCommit?: 'remote_write' },
): Promise<T> {
  if (ctx.readOnly && !opts?.readOnly) {
    throw new TenantSuspendedError();      // invariant 14, cannot be forgotten
  }
  const pool = poolFor(shardOf(ctx.activeTenantId));   // always 'primary' today

  return pool.transaction(async (tx) => {
    // set_config(..., true) is TRANSACTION-local: it cannot leak to the next
    // borrower of a pooled connection, and it is compatible with PgBouncer
    // transaction mode, which session-level SET is not.
    await tx.execute(sql`SELECT set_config('app.tenant_ids', ${ctx.tenantIds.join(',')}, true)`);
    await tx.execute(sql`SELECT set_config('app.actor_id',   ${ctx.personId}, true)`);
    if (opts?.timeout) await tx.execute(sql`SET LOCAL statement_timeout = ${opts.timeout}`);
    if (opts?.synchronousCommit)
      await tx.execute(sql`SET LOCAL synchronous_commit = ${opts.synchronousCommit}`);
    return fn(tx);
  });
}
```

`ctx.tenantIds` normally holds one id. It holds several **only** for an
organization admin viewing across their own schools, and the list is built from
verified memberships — never from a request parameter
([§8.4](08-auth-and-session.md)).

Money-moving use cases pass `synchronousCommit: 'remote_write'` for financial
RPO 0 ([ADR-0026](../../architecture/adr/0026-backup-and-financial-rpo.md)).

## 5.5 The generated isolation suite

Two tests, both **generated from `pg_catalog`** rather than written per table.
That is the property that makes them survive a Friday afternoon: a developer
who adds a table cannot forget to add its test, because the test appears by
itself and fails until the policy exists.

### Test 1 — structural

```sql
-- Every table with a tenant_id column must have RLS enabled AND forced AND at
-- least one policy. No exceptions list, no opt-out, no TODO.
SELECT c.relname,
       c.relrowsecurity      AS enabled,
       c.relforcerowsecurity AS forced,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
FROM   pg_class c
JOIN   pg_namespace n ON n.oid = c.relnamespace
JOIN   pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
                     AND NOT a.attisdropped
WHERE  n.nspname = 'public' AND c.relkind = 'r'
  AND (NOT c.relrowsecurity
       OR NOT c.relforcerowsecurity
       OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid));
-- MUST return zero rows.
```

A second structural query asserts invariant 11 — that every index on a
tenant-owned table leads with `tenant_id` — as a **warning**, not a failure,
since a few lookup indexes legitimately do not.

### Test 2 — behavioural leakage

```ts
// src/db/__tests__/isolation.test.ts
// Enumerates tenant tables from the catalogue at runtime; no hand-maintained list.
const tables = await listTenantOwnedTables(db);

describe.each(tables)('%s is tenant-isolated', (table) => {
  it('reads nothing belonging to another tenant', async () => {
    await seedRow(table, TENANT_B);
    const rows = await asTenant(TENANT_A, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`));
    expect(rows[0].n).toBe(0);
  });

  it('refuses to write a row into another tenant', async () => {
    await expect(
      asTenant(TENANT_A, (tx) => insertRowWithTenant(tx, table, TENANT_B)),
    ).rejects.toThrow(/row-level security/);
  });

  it('returns nothing when the tenant GUC is unset', async () => {
    const rows = await withoutTenantContext((tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`));
    expect(rows[0].n).toBe(0);                 // fails CLOSED
  });
});
```

The third case is the one people omit and the one that matters most: it proves
that forgetting `withTenant` yields **nothing**, not everything.

### Test 3 — role attributes

```ts
it('sm_app can never bypass RLS', async () => {
  const [r] = await adminDb.execute(sql`
    SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'sm_app'`);
  expect(r.rolbypassrls).toBe(false);
  expect(r.rolsuper).toBe(false);
});
```

## 5.6 What CI asserts

| Assertion | When | On failure |
|---|---|---|
| Structural catalogue query returns zero rows | Every CI run, against a migrated database | **Build fails** |
| Behavioural leakage suite, all tenant tables | Every CI run | **Build fails** |
| `sm_app` lacks `BYPASSRLS` and `SUPERUSER` | Every CI run **and every deploy**, against the live database | **Deploy aborts** |
| No `timestamp without time zone` in any migration | Lint on migration files | Build fails |
| Every new `[T]` table added RLS in the same migration | Structural query covers it automatically | Build fails |

The deploy-time role assertion exists because the dangerous change is not made in
a migration — it is made by a tired human at 02:00 running `psql` to fix
something. The check catches it on the next deploy.

## 5.7 Failure modes, and what each produces

| Mistake | Result | Caught by |
|---|---|---|
| Forgot `WHERE tenant_id` | Zero rows — bug is visible, data is safe | RLS itself |
| Forgot `withTenant` | Zero rows — fails closed | Test 2, case 3 |
| Table created without `FORCE` | Isolation off for owner connections | Test 1 |
| `WITH CHECK` omitted | Can write into another tenant | Test 2, case 2 |
| `sm_app` granted `BYPASSRLS` | Isolation gone entirely, silently | Test 3 + deploy assertion |
| `tenantIds` taken from request input | Cross-tenant read | Code review + the fact that `AuthContext` is built only in middleware |
| Operator pool used on a tenant path | Full bypass | Separate pool object, unreachable from tenant request code; every use audited |
| Index missing `tenant_id` prefix | Slow, not unsafe | Test 1 warning |

## 5.8 The one open question

[OQ-15](../../architecture/phase-1a/13-open-questions.md): does
`tenant_id = ANY(app.current_tenant_ids())` use the index at scale, or does the
planner mis-estimate?

**Measure during 3a**, with `EXPLAIN (ANALYZE, BUFFERS)` against a seeded 10 M-row
table. If the array form degrades, the fallback is a single-value GUC:

```sql
USING (tenant_id = app.current_tenant_id())
```

with organization-level reads issuing one query per school instead. That is a
policy change plus a loop in one place — contained, because `withTenant` is the
only path. The fallback is cheap precisely because the indirection already
exists.
