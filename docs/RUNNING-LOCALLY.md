# Running and verifying this locally

Everything so far has been proven by CI. This is how to prove it yourself, on
one machine, and how to satisfy yourself that each guard is real rather than
decorative.

Written for Windows 11 with PowerShell. The commands are the same on macOS and
Linux apart from how environment variables are set.

## 0. What you need

| | Version | Check |
|---|---|---|
| Node | 24 | `node -v` |
| pnpm | 10 | `pnpm -v` |
| PostgreSQL | **18** | see below |

PostgreSQL **18** specifically — CI uses `postgres:18-alpine`, and running a
different major version locally means a green local run proves less than it
looks like it does.

The easiest way to match CI exactly is the dev compose file, which also brings
up MinIO (so the R2 adapter stays exercised locally) and Mailpit (so nothing in
development can reach a real inbox):

```bash
docker compose -f docker-compose.dev.yml up -d
```

If you only want the database:

```bash
docker run --name sm-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=sm_saas -p 5432:5432 -d postgres:18-alpine
```

If you already have PostgreSQL 18 installed natively, create the database and
skip the container:

```bash
createdb -U postgres sm_saas
```

## 1. Install

```bash
pnpm install --frozen-lockfile
```

## 2. Environment

Copy the example:

```bash
cp .env.example .env
```

Then change **two things**, both of which the example gets wrong for a first
local run:

1. **`DATABASE_URL_MIGRATOR` must be a superuser.** Migration `0001` *creates*
   the roles `sm_app`, `sm_platform` and `sm_migrator`, so it cannot run as
   `sm_migrator` — that role does not exist yet. CI uses `postgres`. Set:

   ```
   DATABASE_URL_MIGRATOR=postgres://postgres:postgres@localhost:5432/sm_saas
   ```

2. **The app and platform URLs need the dev password**, which
   `pnpm db:roles:dev` sets in step 4:

   ```
   DATABASE_URL_APP=postgres://sm_app:devpassword@localhost:5432/sm_saas
   DATABASE_URL_PLATFORM=postgres://sm_platform:devpassword@localhost:5432/sm_saas
   ```

Also set a real `SESSION_SECRET` (32+ characters) and `ENCRYPTION_KEY` (exactly
64 hex characters):

```bash
openssl rand -hex 32
```

### `.env` is only read by Next.js

This is the part that will waste your afternoon otherwise. **No script and no
test suite loads `.env`** — there is no `dotenv` anywhere in the repository. The
`tsx` scripts and Vitest read `process.env` directly, so `pnpm db:migrate` on a
bare shell fails with "Set DATABASE_URL_MIGRATOR".

Only `next dev` and `next build` pick `.env` up automatically.

So for everything in steps 4 and 5, export the variables into your shell first.
In PowerShell:

```powershell
$env:DATABASE_URL_MIGRATOR = 'postgres://postgres:postgres@localhost:5432/sm_saas'; $env:DATABASE_URL_APP = 'postgres://sm_app:devpassword@localhost:5432/sm_saas'; $env:DATABASE_URL_PLATFORM = 'postgres://sm_platform:devpassword@localhost:5432/sm_saas'; $env:DEV_DB_PASSWORD = 'devpassword'; $env:APP_URL = 'http://localhost:3000'; $env:PLATFORM_HOST = 'admin.localhost'; $env:SESSION_SECRET = ('x' * 32); $env:ENCRYPTION_KEY = ('a' * 64); $env:SMS_PROVIDER = 'mock'; $env:TZ = 'Asia/Dhaka'
```

In Git Bash:

```bash
export DATABASE_URL_MIGRATOR=postgres://postgres:postgres@localhost:5432/sm_saas DATABASE_URL_APP=postgres://sm_app:devpassword@localhost:5432/sm_saas DATABASE_URL_PLATFORM=postgres://sm_platform:devpassword@localhost:5432/sm_saas DEV_DB_PASSWORD=devpassword APP_URL=http://localhost:3000 PLATFORM_HOST=admin.localhost SESSION_SECRET=$(printf 'x%.0s' {1..32}) ENCRYPTION_KEY=$(printf 'a%.0s' {1..64}) SMS_PROVIDER=mock TZ=Asia/Dhaka
```

These are throwaway development values. Never use them anywhere real.

## 3. The checks that need no database

```bash
pnpm verify
```

Typecheck, lint including the architecture boundaries, and the unit tests. Fast,
and the first thing to run after any change.

## 4. Set the database up

In this order — each step depends on the one before:

```bash
pnpm db:migrate
```

```bash
pnpm seed
```

```bash
pnpm db:roles:dev
```

- **`db:migrate`** applies `0001`–`0013`. Forward-only; re-running is a no-op.
- **`seed`** writes the permission vocabulary, the role templates and the plans
  from `src/shared/permissions.ts` and `src/shared/role-templates.ts`. **Not
  optional**: `role_permission.permission_key` has a foreign key to
  `permission(key)`, so on an unseeded database no permission can be granted and
  every authorised endpoint answers 403.
- **`db:roles:dev`** gives the least-privilege roles a password, because
  migration `0001` creates them without one — a migration is checked into Git
  and a credential must not be. It also re-asserts the append-only revocation on
  the audit tables, which its own blanket `GRANT` would otherwise undo.

## 4b. Demo data

```bash
pnpm demo
```

Builds **two** schools through the real use cases. The second exists so that
"no cross-tenant leak" means something you can check by eye rather than only in
a test.

It prints the sign-in details. Staff get a password so showing this to somebody
does not require reading an OTP out of a terminal:

| | |
|---|---|
| `http://demo.localhost:3000/app/login` | `+8801700000001` / `demo1234` |
| `http://other-school.localhost:3000/app/login` | `+8801700000010` / `demo1234` |

**The tenant surface is chosen by HOST, not by path.** `localhost:3000` is the
marketing site; `demo.localhost:3000` is the school. `*.localhost` resolves to
127.0.0.1 on Windows, macOS and most Linux without touching `hosts`.

Guardians have no password by design — use the Phone code tab, and read the
six digits from the `pnpm dev` terminal.

`pnpm demo` is **not idempotent**: it creates a whole school each run and
refuses if the slug already exists. To start over:

```bash
psql -c 'DROP DATABASE sm_saas' -c 'CREATE DATABASE sm_saas'
```

## 5. The four test layers

Each proves something the others cannot. Run them in this order — it is the
order CI uses, and it puts the most fundamental failure first.

```bash
pnpm test:isolation
```

**The tenancy gate.** Connects as `sm_app`, which has no `BYPASSRLS`, and
enumerates every table in `pg_class` carrying a `tenant_id` column. Any such
table without RLS enabled, forced, and a `WITH CHECK` policy fails the build —
there is no exceptions list. It also proves the audit tables refuse `UPDATE` and
`DELETE`.

If this is red, nothing else matters.

```bash
pnpm test
```

**Unit.** No database. The pure decisions: money allocation, `LocalDate`, the
permission matrix, the student lifecycle, promotion planning, redaction.

```bash
pnpm test:integration
```

**Module wiring.** Real database, real transactions. Provisioning a school,
logging in by OTP, granting roles, promoting a cohort and undoing it, merging
two people and reversing it.

```bash
pnpm build && pnpm test:http
```

**Transport.** Boots the built Next server and makes real HTTP requests. The
only layer that exercises the response envelope, the HttpOnly cookie, the
error→status mapping and the rate limiter.

`pnpm build` first is not optional — `test:http` runs `next start`, which serves
the build output.

## 6. Prove the guards are real

A test suite you have not tried to break is a suite you are trusting rather than
verifying. Each of these should FAIL. Undo the change afterwards.

| Break this | Expect |
|---|---|
| Add `tenant_id uuid` to a table in a new migration without calling `app.make_tenant_table` | `test:isolation` — "Unprotected tenant tables" |
| Import `next/server` inside any `src/modules/*/domain/` file | `pnpm lint` — domain purity |
| Import `db/pool` outside `src/db/**` | `pnpm lint` — `withTenant` is the only path |
| Write `amount.minor * 2` outside `shared/money.ts` | `pnpm lint` — no arithmetic on money |
| Add a key to `PERMISSIONS` in `src/shared/permissions.ts` | `pnpm test` — the matrix has no answer for it |
| Remove `reason` from a `revokeInvite` call | `pnpm test:integration` — `audit()` refuses the action |
| `UPDATE audit_log SET action = 'x'` as `sm_app` in psql | `permission denied for table audit_log` |

The last one is worth doing by hand once. Connect as the app role and try:

```bash
psql postgres://sm_app:devpassword@localhost:5432/sm_saas -c "UPDATE audit_log SET action = 'rewritten'"
```

## 7. Drive it end to end by hand

This is the part that turns "the tests pass" into "I have seen it work".

### Provision a school

```bash
pnpm provision --slug my-school --name-bn 'আমার বিদ্যালয়' --name-en 'My School' --plan standard --owner-name-bn 'রহিম উদ্দিন' --owner-name-en 'Rahim Uddin' --owner-phone +8801711223344 --reason 'trying the product locally'
```

It prints the tenant, school, owner ids and the class levels created. Every
value is real: look at the database and you will find one school, one primary
campus, one day shift, a current academic year, thirteen class levels, ten roles
copied from the templates, and one membership holding Principal.

### Start the server

```bash
pnpm dev
```

`next dev` reads `.env`, so this one does not need the exported variables.

### Log in as the owner

The owner has **no password** — staff never receive one by SMS or email. They
sign in by OTP. Request a code:

```bash
curl -X POST http://localhost:3000/api/v1/auth/otp/request -H 'content-type: application/json' -d '{"identifier":"+8801711223344"}'
```

`SMS_PROVIDER=mock`, so no message is sent anywhere. **The code is printed in
the `pnpm dev` terminal** as a log line containing `otp.dispatch.mock`. Copy the
six digits and verify:

```bash
curl -i -X POST http://localhost:3000/api/v1/auth/otp/verify -H 'content-type: application/json' -d '{"identifier":"+8801711223344","code":"123456"}'
```

The response carries a `Set-Cookie: sm_session=…; HttpOnly; SameSite=Lax`. The
session token is never in the body — check.

### Use the session

```bash
curl http://localhost:3000/api/v1/auth/me -H 'cookie: sm_session=PASTE_TOKEN_HERE'
```

Then invite a member of staff, which is the first thing a principal actually
does. You need a `person` in the tenant to invite; the directory module creates
those, and there is no HTTP route for it yet — so for now, insert one with SQL
and use its id:

```bash
curl -X POST http://localhost:3000/api/v1/staff/invites -H 'content-type: application/json' -H 'cookie: sm_session=PASTE_TOKEN_HERE' -d '{"personId":"PASTE_PERSON_ULID","identifier":"teacher@example.bd"}'
```

The response contains the one-time invite token — returned once and never
stored in plaintext. Only its hash is in `staff_invite`.

### Watch the audit trail fill up

```bash
psql postgres://postgres:postgres@localhost:5432/sm_saas -c "SELECT at, action, reason FROM audit_log ORDER BY at DESC LIMIT 20"
```

```bash
psql postgres://postgres:postgres@localhost:5432/sm_saas -c "SELECT at, type, outcome, reason FROM auth_event ORDER BY at DESC LIMIT 20"
```

Two trails, on purpose ([ADR-0033](architecture/adr/0033-two-audit-trails.md)).
Look for what is **not** there: no names, no phone numbers, no passwords. The
identifier on `auth_event` is a SHA-256 hash.

## 8. What you will not be able to see yet

Being clear about this so you do not go looking:

- **There is no user interface.** `login/page.tsx` and the dashboard exist as
  skeletons with zero `fetch` calls. Everything above is curl and psql.
- **No HTTP routes** for structure, directory or roles. Those modules are
  complete and tested at the integration layer; the transport layer for them is
  the next increment.
- **No documents, no PDFs, no SMS.** Object storage is unwired and SMS ships in
  Phase 3b.
- **No worker.** `src/worker/index.ts` is a 51-line stub; the pg-boss consumers
  are commented out until the modules that need them exist.

## 8b. Two Windows gotchas

**`curl` on Git Bash mangles Bangla.** Non-ASCII in a `-d` argument arrives at
the server as `?????`. The application is fine — it is the shell. Test Bangla
input through the browser, or from Node:

```bash
node -e "fetch('http://127.0.0.1:3000/api/v1/students',{method:'POST',headers:{'content-type':'application/json',host:'demo.localhost:3000',cookie:'sm_session=...'},body:JSON.stringify({nameBn:'পরীক্ষা'})})"
```

**Database collation.** A database created by a Windows PostgreSQL installer
usually gets `English_United States.1252`. Storage is still UTF-8 and nothing
breaks, but Bangla names SORT by code point rather than linguistically. A Linux
host will differ. If it matters for a demo:

```bash
psql -c "CREATE DATABASE sm_saas TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C.UTF-8'"
```

## 9. Known rough edges

Two things that should be fixed and are not, both flagged here rather than left
to surprise you:

1. **Scripts do not read `.env`.** Hence step 2's export dance. Node 24 supports
   `--env-file`, so this is a small fix to `package.json` — it needs care
   because CI has no `.env` file and `--env-file` errors on a missing one.
2. **`.env.example` shows `sm_migrator` as the migration role**, which cannot
   work on a fresh database because `0001` creates that role. It should say
   `postgres`, with a comment explaining why.
