# 1. Development conventions

Phase 1 fixed *what* is built. This fixes *how it is written*, so that two
developers (and any agent session) produce the same code from the same spec.

Everything here is enforced by tooling where it can be. A convention that relies
on memory is a convention that decays.

## 1.1 TypeScript configuration

```jsonc
// tsconfig.json — the non-negotiable flags
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,      // arr[0] is T | undefined
    "exactOptionalPropertyTypes": true,     // {a?: string} ≠ {a: string | undefined}
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "target": "ES2022",                     // native BigInt, .at(), Error.cause
    "moduleResolution": "bundler",
    "paths": {
      "@/*":        ["./src/*"],
      "@shared/*":  ["./src/shared/*"],
      "@modules/*": ["./src/modules/*"]
    }
  }
}
```

`noUncheckedIndexedAccess` is the one people disable when it gets annoying.
Do not. Half this system indexes into arrays of marks and fee lines where a
missing element must be handled, not assumed.

**`any` is banned** by lint. `unknown` plus a Zod parse is the escape hatch.

## 1.2 Naming

| Thing | Convention | Example |
|---|---|---|
| Database table | `snake_case`, **singular** | `guardian_link` |
| Database column | `snake_case` | `collected_at` |
| Money column | `*_minor` — always | `amount_minor` |
| Boolean column | `is_*` / `can_*` / `has_*` | `is_billing_guardian` |
| Timestamp column | `*_at` | `published_at` |
| Date-only column | `*_date` or bare noun | `due_date`, `date` |
| TypeScript type | `PascalCase` | `EnrolmentId` |
| Use case file | `verbNoun.ts`, one export | `recordPayment.ts` |
| Zod schema | `<Thing>Schema` | `RecordPaymentSchema` |
| Event | `NounPastTense` | `PaymentRecorded` |
| Permission | `resource.action` | `fee.collect` |
| Job name | `module.action` | `documents.render` |
| Migration | `NNNN_snake_description.sql` | `0007_add_guardian_link.sql` |

## 1.3 The four boundary rules

These exist because each one is a bug class that is expensive to find late.

### Money never becomes a JavaScript number

```ts
// src/shared/money.ts — the ONLY representation of an amount
export type Money = { readonly minor: bigint; readonly currency: 'BDT' };

// Wire:  string of minor units   "150000"
// DB:    bigint                   150000
// UI:    formatted at the edge    "৳১,৫০০.০০"
```

| Layer | Representation | Never |
|---|---|---|
| PostgreSQL | `bigint` | `numeric`, `money`, `float` |
| Drizzle | `bigint` mode `bigint` | mode `number` |
| Domain | `Money` | `number` |
| JSON | **string** `"150000"` | JSON number — IEEE 754 loses precision above 2^53 |
| Display | `Money.format(locale, numerals)` | manual `/100` |

Lint rule: any arithmetic operator applied to a `.minor` outside `shared/money.ts`
is an error. All arithmetic goes through `Money.add/sub/mulRatio/allocate`.

### Dates are `LocalDate`, not `Date`

```ts
export type LocalDate = { readonly y: number; readonly m: number; readonly d: number };
```

A calendar day in Dhaka is not an instant. `new Date('2027-01-15')` is midnight
**UTC**, which is 06:00 Dhaka — and a working-day lookup done that way is off by
one for six hours of every day.

- **Calendar days** (attendance date, due date, holiday bounds) → `LocalDate` ↔ `date`
- **Instants** (`created_at`, `collected_at`) → `Date` ↔ `timestamptz`
- `timestamp` without time zone is banned in DDL. Lint catches it in migrations.

### Ids are branded

```ts
declare const brand: unique symbol;
export type Id<T extends string> = string & { readonly [brand]: T };
export type TenantId    = Id<'tenant'>;
export type StudentId   = Id<'student'>;
export type EnrolmentId = Id<'enrolment'>;
```

Prevents passing a `StudentId` where an `EnrolmentId` is expected — which is the
single easiest mistake to make in this domain, because a student and their
enrolment are both "the student" in conversation.

### Absent is a state, never a number

```ts
export type MarkValue =
  | { state: 'entered'; score: Money }      // marks are minor units too: 1 mark = 100
  | { state: 'absent' }
  | { state: 'exempt' }
  | { state: 'incomplete' };
```

A discriminated union, so `score` is **unreachable** unless the state is
`entered`. The type system enforces invariant 4 alongside the `CHECK` constraint.
There is no code path that can read a score off an absent mark.

## 1.4 Error handling

Domain functions return `Result`; they do not throw. Exceptions are for
programmer error and infrastructure failure only.

```ts
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface DomainError {
  code: string;              // stable, machine-readable, never localised
  messageKey: string;        // i18n key — localised at the transport edge
  details?: Record<string, unknown>;
  httpStatus: 400|403|404|409|422|423|429;
}
```

The error taxonomy maps to the HTTP table in
[§19.4](../../architecture/phase-1b/19-api-architecture.md). Mapping happens
**once**, at the transport edge — the domain layer knows no status codes.

```ts
// Errors are declared per module, as data.
export const FeeErrors = {
  INVOICE_ALREADY_PAID:  { code: 'INVOICE_ALREADY_PAID',
                           messageKey: 'fee.error.alreadyPaid', httpStatus: 409 },
  MARKS_LOCKED:          { code: 'MARKS_LOCKED',
                           messageKey: 'assessment.error.locked', httpStatus: 423 },
} as const satisfies Record<string, DomainError>;
```

## 1.5 The use-case shape

Every business action is one file, one exported function, this shape. It is
mechanical on purpose — [§14.1](../../architecture/phase-1b/14-module-architecture.md).

```ts
export async function recordPayment(
  ctx: AuthContext,
  input: unknown,                                   // unknown until parsed
): Promise<Result<PaymentView, DomainError>> {
  authorize(ctx, 'fee.collect');                    // 1. ALWAYS first
  const cmd = RecordPaymentSchema.parse(input);     // 2. Zod at the boundary

  return withTenant(ctx, async (tx) => {            // 3. tenant session set
    const claim = await claimIdempotency(tx, ctx, cmd.idempotencyKey);
    if (claim.replayed) return ok(claim.response);

    const outstanding = await invoices.outstandingFor(tx, cmd.studentId);
    const plan = allocatePayment(cmd.amount, outstanding, policy);  // 4. PURE

    const payment = await payments.insert(tx, /* … */);             // 5. persist
    await enqueue(tx, 'sms.payment_receipt', { paymentId: payment.id }); // 6. same tx
    await audit(tx, ctx, 'payment.recorded', payment.id, { after: payment });

    return ok(toView(payment));
  });
}
```

Steps 1, 3, 6 and 7 are wrapped by a `useCase()` helper in Phase 3 so they cannot
be omitted. **Step 4 is where the domain lives** — a pure function, unit-tested
without a database.

## 1.6 Import boundaries

Enforced by `eslint-plugin-boundaries`; a violation fails CI
([§11](11-scaffolding-lint-ci.md)).

| From | May import | May **not** import |
|---|---|---|
| `modules/*/domain` | `shared/*`, own domain | `next/*`, `drizzle-orm`, any SDK, any other module, own `infrastructure` |
| `modules/*/application` | own `domain`, `shared/*`, **other modules' `index.ts`** | other modules' internals, `next/*` |
| `modules/*/infrastructure` | own `domain`, `shared/*`, `db/*` | other modules entirely |
| `app/*`, `worker/*` | `modules/*/index.ts`, `shared/*` | any module internal, `db/*` directly |
| `shared/*` | `shared/*` only | everything else |

The rule that will be violated first is `app/*` importing `db/*` to "just run one
query". It is a build failure, not a review comment.

## 1.7 Testing conventions

Detail in [ADR-0028](../../architecture/adr/0028-testing-strategy.md); the
code-level rules:

| Kind | Location | Database? |
|---|---|---|
| Domain unit | `modules/*/domain/**/*.test.ts` | **Never** |
| Use case integration | `modules/*/application/**/*.test.ts` | Real Postgres, transaction rolled back |
| Isolation suite | `src/db/__tests__/isolation.test.ts` | **Generated from the catalogue** — [§5](05-rls-and-isolation-harness.md) |
| API contract | `src/app/api/**/*.test.ts` | Real, seeded |
| E2E | `e2e/**/*.spec.ts` | Real, seeded |

Fixtures are **builders**, not JSON dumps, so a schema change breaks compilation
rather than silently producing invalid rows:

```ts
const student = aStudent().inSection(s).withGuardian(g).build();
```

## 1.8 Comments

Comment **why**, never what. The bar: would a competent developer be surprised,
or undo this if they did not know?

```ts
// FOR UPDATE serialises receipt issuance per school. Required: a PostgreSQL
// sequence is NOT gapless because it does not roll back, and a missing receipt
// serial reads as theft to a school. Invariant 3.
const seq = await tx.execute(sql`SELECT ... FOR UPDATE`);
```

Every deliberate oddity from CLAUDE.md's "things that look like bugs but are not"
carries a comment like this at its definition site.

## 1.9 Definition of done

A change is done when:

1. Types compile with no `any` and no suppressions
2. Domain logic is unit-tested with no database
3. Any new tenant table has RLS **and** appears green in the generated isolation suite
4. Any new mutation writes an audit row
5. Any new money path uses `Money` end to end
6. Localised in `en` and `bn`, with key parity green
7. `bash ./scripts/check-docs.sh` passes if docs changed
8. The PR describes what was actually run, not "tested locally"
