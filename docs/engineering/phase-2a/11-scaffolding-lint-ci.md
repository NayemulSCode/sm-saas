# 11. Scaffolding, lint boundaries and CI

§46.7 items 6 and 7. This is the specification for the first Phase 3a commit —
**the scaffolding is not created in Phase 2**, per CLAUDE.md. Nothing here
executes until Phase 3a starts.

## 11.1 What the first Phase 3a commit contains

Tree per [§41](../../architecture/phase-1c/41-project-structure.md). The first
commit should establish the *skeleton and its guardrails* before any feature:

```
package.json  tsconfig.json  eslint.config.mjs  vitest.config.ts
drizzle.config.ts  playwright.config.ts
Dockerfile  Dockerfile.render  docker-compose.yml  docker-compose.dev.yml
.env.example
assets/fonts/                    vendored .ttf + SHA-256 (ADR-0009)
src/shared/                      money · date · ids · result · auth-context · cache
src/db/                          schema/ · migrations/0001–0002 · rls.ts · types.ts
src/db/__tests__/isolation.test.ts     ← BEFORE the first tenant table (§5)
src/modules/                     empty module folders with index.ts stubs
src/app/  src/worker/            entrypoints only
scripts/                         seed-platform.ts · seed-dev.ts · check-docs.sh
```

**Order matters.** `src/db/__tests__/isolation.test.ts` and migrations
`0001–0002` come before migration `0005` creates `person`, the first tenant
table. The harness must be able to fail before there is anything to protect.

## 11.2 Lint boundaries

The rule that *is* the architecture ([ADR-0001](../../architecture/adr/0001-modular-monolith.md)),
made mechanical.

```js
// eslint.config.mjs
import boundaries from 'eslint-plugin-boundaries';

export default [
  {
    settings: {
      'boundaries/elements': [
        { type: 'shared',    pattern: 'src/shared/*' },
        { type: 'db',        pattern: 'src/db/*' },
        { type: 'domain',    pattern: 'src/modules/*/domain/**' },
        { type: 'app-layer', pattern: 'src/modules/*/application/**' },
        { type: 'infra',     pattern: 'src/modules/*/infrastructure/**' },
        { type: 'module-api',pattern: 'src/modules/*/index.ts' },
        { type: 'transport', pattern: ['src/app/**', 'src/worker/**'] },
      ],
    },
    rules: {
      'boundaries/element-types': ['error', {
        default: 'disallow',
        rules: [
          // The core rule: domain is pure.
          { from: 'domain',     allow: ['shared', 'domain'] },
          { from: 'app-layer',  allow: ['shared', 'domain', 'module-api'] },
          { from: 'infra',      allow: ['shared', 'domain', 'db'] },
          { from: 'transport',  allow: ['shared', 'module-api'] },
          { from: 'module-api', allow: ['shared', 'domain', 'app-layer', 'infra'] },
          { from: 'shared',     allow: ['shared'] },
        ],
      }],

      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['next/*', 'react', 'drizzle-orm', '@aws-sdk/*'],
            message: 'domain/ must stay framework-free (ADR-0001)',
            // applied via an override scoped to src/modules/*/domain/**
          },
          { group: ['**/modules/*/domain/**', '**/modules/*/infrastructure/**'],
            message: 'Import a module through its index.ts only' },
          { group: ['**/db/index'],
            message: 'Use withTenant(ctx, fn) — there is no other path (§5.4)' },
        ],
      }],
    },
  },
];
```

Custom rules, each backing a named invariant:

| Rule | Enforces |
|---|---|
| `sm/no-money-arithmetic` — no `+ - * /` on `.minor` outside `shared/money.ts` | Invariant 2 |
| `sm/use-case-must-authorize` — exported `application/*.ts` must call `authorize()` | §9.4 |
| `sm/no-bare-jsx-text` — user-visible text goes through `t()` | §22.2 |
| `sm/no-timestamp-without-tz` — migration lint | §1.3 |
| `sm/index-leads-with-tenant` — warn on `db/schema/**` indexes | Invariant 11 |

The first two are worth writing by hand. Both encode a rule that reviewers
demonstrably miss under time pressure, and both are cheap AST checks.

## 11.3 Scripts

```jsonc
{
  "scripts": {
    "dev":          "next dev",
    "worker:dev":   "tsx watch src/worker/index.ts",
    "build":        "next build",
    "typecheck":    "tsc --noEmit",
    "lint":         "eslint .",
    "test":         "vitest run",
    "test:isolation":"vitest run src/db/__tests__/isolation.test.ts",
    "test:e2e":     "playwright test",
    "db:migrate":   "tsx scripts/migrate.ts",
    "db:check":     "drizzle-kit check",
    "db:drift":     "tsx scripts/drift.ts",
    "seed":         "tsx scripts/seed-platform.ts",
    "seed:dev":     "tsx scripts/seed-dev.ts",
    "check:docs":   "bash ./scripts/check-docs.sh",
    "check:bundle": "tsx scripts/bundle-budget.ts"
  }
}
```

## 11.4 Environment

`.env.example` is committed; `.env` never is. Every variable is validated at
boot by a Zod schema — **the process refuses to start** on a missing or malformed
value, rather than failing at 02:00 on the first request that needs it.

```ts
// src/config/env.ts
export const Env = z.object({
  NODE_ENV: z.enum(['development','test','production']),
  APP_URL: z.string().url(),
  PLATFORM_HOST: z.string(),

  DATABASE_URL_APP:      z.string().url(),   // sm_app — no BYPASSRLS
  DATABASE_URL_PLATFORM: z.string().url(),   // sm_platform — audited use only
  DATABASE_URL_MIGRATOR: z.string().url().optional(),  // migrations only
  DATABASE_URL_READONLY: z.string().url().optional(),  // replica, reporting

  SESSION_SECRET:    z.string().min(32),
  ENCRYPTION_KEY:    z.string().length(64),  // hex, for national_id_enc
  ARGON2_MEMORY_KIB: z.coerce.number().default(19456),

  R2_ACCOUNT_ID: z.string(), R2_ACCESS_KEY_ID: z.string(),
  R2_SECRET_ACCESS_KEY: z.string(), R2_BUCKET: z.string(),

  SMS_PROVIDER: z.enum(['mock','provider_a','provider_b']).default('mock'),
  SMS_API_KEY: z.string().optional(),
  SMS_SENDER_ID: z.string().optional(),

  SENTRY_DSN: z.string().optional(),
  TZ: z.literal('Asia/Dhaka'),
}).parse(process.env);
```

Three separate database URLs is the point: the operator pool is a **different
connection string**, so it cannot be reached by accident from tenant request code
([§5.1](05-rls-and-isolation-harness.md)).

Secrets live in the host's environment file, `chmod 600`, root-owned; never in
the repo, never in the image ([§33](../../architecture/phase-1c/33-security.md)).

## 11.5 Compose

```yaml
# docker-compose.yml — production topology (§35)
services:
  caddy:    { image: caddy:2, ports: ["80:80","443:443"] }
  app:      { image: sm-saas:${TAG}, command: ["node","server.js"],
              mem_limit: 900m, env_file: .env, depends_on: [postgres] }
  worker:   { image: sm-saas:${TAG}, command: ["node","worker.js"],
              mem_limit: 400m, env_file: .env }
  render:   { image: sm-saas-render:${TAG},
              # 958 MB measured peak (OQ-13) + headroom. Chromium sizes its
              # caches to AVAILABLE memory and will otherwise starve PostgreSQL.
              mem_limit: 1500m, shm_size: 512m }
  postgres: { image: postgres:16, mem_limit: 3g,
              volumes: ["pgdata:/var/lib/postgresql/data"] }
```

`docker-compose.dev.yml` adds MinIO (R2-compatible, keeps that adapter
exercised), Mailpit, and a seeded database. Every container has an explicit
`mem_limit` — on an 8 GB host an unbounded Chromium is the failure mode OQ-13
identified.

## 11.6 CI

Extends the existing `docs` job. Budget ≤ 10 minutes
([ADR-0028](../../architecture/adr/0028-testing-strategy.md)).

```yaml
jobs:
  docs:        # exists today
  typecheck:   # tsc --noEmit
  lint:        # eslint, including the boundary rules
  test:
    services: { postgres: { image: postgres:16 } }
    steps:
      - db:migrate
      - test:isolation      # ← gate: fails the build on any unprotected table
      - test                # unit + integration
      - seed && seed        # twice: the second run must be a no-op
  build:       # next build + bundle budget check
  e2e:         # playwright, on PRs touching src/app
```

Required checks on `main`: `docs`, `typecheck`, `lint`, `test`, `build`.

`test:isolation` is a **separate step before the main suite** so a tenancy
regression is the first thing that fails and is unmistakable in the log, rather
than one red dot among four hundred.

## 11.7 Definition of ready for Phase 3a

The scaffolding is complete when all of these are true on an empty database:

1. `pnpm db:migrate` runs `0001`–`0002` clean.
2. `pnpm test:isolation` **passes with zero tenant tables** — the harness works
   before it has anything to check.
3. Adding a table with `tenant_id` and *no* policy makes it **fail**. Verify by
   deliberately doing so, then reverting. An untested guard is not a guard.
4. `pnpm lint` fails when `domain/` imports `drizzle-orm`. Verify the same way.
5. `pnpm seed && pnpm seed` is idempotent.
6. `docker compose up` gives a working app, worker and database.
7. CI runs all jobs in under 10 minutes.

Points 3 and 4 are the ones to actually perform rather than assume. The whole
value of this scaffolding is that two guards fail loudly, and the only way to
know they do is to make them fail once, on purpose.
