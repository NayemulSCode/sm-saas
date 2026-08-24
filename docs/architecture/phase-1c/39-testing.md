# 39. Testing strategy

Two people cannot maintain a large test suite and ship fourteen modules. So the
strategy is not "test everything" — it is **test the things that are
unrecoverable when wrong, exhaustively, and rely on types and constraints for
the rest.**

Priority follows the tie-break in
[§1](../phase-1a/01-executive-summary.md): correctness of money and results
first, tenant isolation second, everything else after.

## 39.1 The shape

```
        ╱ E2E — a handful of critical journeys, Playwright ╲          ~15
      ╱  Integration — use cases against a real PostgreSQL   ╲        ~200
    ╱  Unit — domain rules, pure functions, no IO              ╲      ~600
  ╱  Generated — RLS leakage, permission matrix, migrations      ╲    auto
╱  Static — TypeScript strict, ESLint boundaries, Zod             ╲   always
```

Deliberately **bottom-heavy**. The assessment engine, the calendar resolver and
the money arithmetic are pure functions ([ADR-0012](../adr/0012-assessment-engine.md),
[ADR-0013](../adr/0013-calendar-as-infrastructure.md)) — they can be tested
exhaustively, in milliseconds, without a database. That was a design goal, and
this is where it pays.

## 39.2 The five suites that are non-negotiable

Everything else is negotiable under deadline pressure. These are not.

### 1. Tenant isolation — generated, not hand-written

```
For every table carrying tenant_id, generated from pg_class:
  set app.tenant_ids = tenant A
    assert SELECT of tenant B's rows returns 0
    assert INSERT with tenant_id = B raises
    assert UPDATE of B's row affects 0
    assert DELETE of B's row affects 0
Plus catalogue assertions:
    RLS enabled AND forced, policy present, no BYPASSRLS on sm_app
```

**Generated from the catalogue**, so a developer cannot add a table and forget
its test — the test appears automatically and fails until the policy exists
([§7.2](../phase-1a/07-multi-tenancy.md)). This is the single most valuable test
in the repository.

### 2. Money arithmetic

| Property | Assertion |
|---|---|
| No float anywhere | `Money` never exposes `number`; lint bans float ops on amounts |
| Allocation sums exactly | Σ allocations = payment, always, including 3-way splits |
| Rounding | Banker's rounding; remainder to the first allocation; parts sum to the whole |
| **Gapless receipts** | Concurrent issuance under load produces a contiguous sequence with no gaps and no duplicates |
| Reversal | A refund leaves both rows and a net of zero |
| Arrears carry-forward | Survives promotion, transfer, year rollover |
| Idempotency | The same key twice creates one payment |

The gapless test runs concurrent transactions against a real PostgreSQL. It is
the only way to prove the `FOR UPDATE` serialisation actually holds.

### 3. Assessment correctness

| Property | Assertion |
|---|---|
| **`ABSENT` never becomes 0** | Constraint test plus engine test plus PDF-context type test |
| `EXEMPT` reduces the denominator | Not penalised for a missing component |
| Component pass rules | Failing a required component fails the subject regardless of total |
| Grade bands | Boundary values on every band edge |
| Optional subject rule | Threshold, contribution, cap |
| Ranking tie-breaks | Including shared positions |
| Determinism | Same scheme version + same marks → identical `computation_hash` |
| Immutability | Revision creates v2; v1 remains byte-identical |

Fixtures are **real school configurations** — a GPA-5.0 secondary scheme, a
descriptive KG scheme, an English-medium letter scheme — not synthetic ones.
Every new tenant with an unusual rule set becomes a fixture.

### 4. Calendar resolution

| Property | Assertion |
|---|---|
| Precedence | section > class > campus > school > organization > government |
| **Suppression before precedence** | A school row cancels an inherited government holiday |
| Effective dating | Changing the weekend in July does not rewrite January |
| Provisional → confirmed | Cascades; recompute range is correct |
| **Retroactive holiday** | Attendance superseded not deleted; late fees reversed; exams flagged |
| Working-day count | Matches the materialised table and the resolver |

### 5. Authorization matrix

Table-driven over (role × permission × scope). Adding a permission without
expectations fails the build. Plus: a teacher's list queries are narrowed **in
SQL**, not in the UI, verified by asserting the generated predicate.

## 39.3 Supporting suites

| Suite | Scope | Runs |
|---|---|---|
| **Migrations** | Every migration applied to a restored production-shaped dump; forward-only; RLS present on new tables | CI, pre-release |
| **Bangla PDF golden image** | [`fixture.html`](../spikes/oq-12-bangla-shaping/fixture.html) rendered through the real PDF path, diffed against a reference | CI on renderer/font/template change |
| **Accessibility** | Axe on key routes; contrast across the token set **and hostile tenant brand colours**; keyboard traversal of the three critical screens | CI ([§28.6](../phase-1b/28-accessibility.md)) |
| **Bundle size** | Per route group against budgets | CI, fails the build |
| **i18n parity** | `en`/`bn` key parity, ICU validity, no bare JSX text, no Bangla in `en` SMS templates | CI |
| **Log redaction** | No names, phones, marks or amounts in log output | CI |
| **Header assertions** | `Cache-Control: private, no-store` on authenticated responses; CSP present | CI |
| **Offline sync** | Queue replay idempotency, conflict rules, session-expiry survival | CI |

## 39.4 E2E — few, and only the journeys that pay the bills

Playwright, run against a seeded stack. Roughly fifteen tests, because E2E is
expensive to maintain and flaky tests get disabled, which is worse than not
having them.

| Journey | Why it qualifies |
|---|---|
| Guardian OTP login → view published result | The result-day path |
| Teacher takes attendance for a section | Daily, highest-volume |
| Teacher enters marks in the grid, including paste and `a`/`e`/`i` | The screen teachers judge the product by |
| Office records a cash payment → receipt printed | Money |
| Partial payment allocated across heads | Money, the subtle case |
| Import students dry-run → fix errors → commit | The onboarding path |
| Publish results → SMS queued → revoke publication | Controlled, reversible event |
| Promote a section with exceptions | The riskiest bulk operation |
| Tenant suspension → read-only + export still work | The ethical constraint in [§37.5](37-saas-billing.md) |
| Context switch: teacher at A, parent at B | The identity model's reason for existing |

Each runs in **both locales**, because Bangla string lengths break layouts that
pass in English ([§22.7](../phase-1b/22-i18n-architecture.md)).

## 39.5 Test data

| Need | Approach |
|---|---|
| Unit | Inline builders with sensible defaults; override only what the test is about |
| Integration | Per-test transaction, rolled back. Fast, isolated, no cleanup |
| Multi-tenant | Every integration test seeds **two** tenants — a test that passes with one tenant proves nothing about isolation |
| E2E | A seeded school: 3 classes, 6 sections, 120 students, guardians, staff, one completed exam, a fee structure with arrears |
| Bangla | Real Bangla names and conjunct-heavy strings, never `foo`/`bar`. Layout and shaping bugs only appear with real text |
| **Never** | Production data, even anonymised, in a test suite |

## 39.6 Coverage — a target, not a religion

| Area | Target | Note |
|---|---|---|
| `modules/*/domain` | **90%** | Pure functions; anything less means untested rules |
| `modules/*/application` | 75% | Use cases |
| `modules/*/infrastructure` | 50% | Repositories — integration tests cover the real risk |
| UI components | 40% | E2E and accessibility tests carry more weight here |
| **Overall gate** | 70% | Fails the build below it |

Coverage is a smoke detector, not a goal. A 95%-covered module with no
concurrency test on receipt numbering is worse tested than a 70%-covered one that
has it.

## 39.7 Speed budget

**≤ 10 minutes in CI, or the suite stops being run.**

| Suite | Budget |
|---|---|
| Static + lint + typecheck | 2 min |
| Unit | 1 min |
| Integration | 4 min |
| Generated RLS + permission matrix | 1 min |
| E2E | 5 min, parallel |
| PDF golden image | 2 min, only on relevant changes |

Unit tests run on save locally. Integration and E2E run in CI and on demand.

## 39.8 What is deliberately not tested

| Not tested | Reason |
|---|---|
| Third-party SDK internals | Adapters are tested against fakes; contract behaviour is verified in staging |
| Every CRUD endpoint | Types and Zod cover the shape; the audit trail catches misuse |
| Exhaustive UI states | Diminishing returns; accessibility and E2E cover the paths that matter |
| Load and performance in CI | Measured deliberately in spikes ([OQ-13](../spikes/oq-13-pdf-memory/README.md)) rather than continuously |
| Provider sandboxes in CI | Slow and flaky. Contract tests against recorded fixtures instead |
