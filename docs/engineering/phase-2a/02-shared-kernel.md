# 2. The shared kernel

Everything in `src/shared/`. Deliberately small — a growing shared kernel is the
monolith re-forming inside the modules
([§9.5](../../architecture/phase-1a/09-domain-boundaries.md)).

Signatures are final. Implementations are Phase 3.

## 2.1 `money.ts`

Invariant 2: money is `bigint` minor units, never a float.

```ts
export type Currency = 'BDT';
export type Money = { readonly minor: bigint; readonly currency: Currency };

export const Money = {
  zero(currency: Currency = 'BDT'): Money,

  /** From integer minor units. The ONLY constructor used at the DB boundary. */
  fromMinor(minor: bigint | number, currency?: Currency): Money,

  /** Parse a user-typed major-unit string: "১,৫০০.৫০" | "1500.50" → 150050n.
   *  Accepts Bangla or Latin digits. Rejects >2 decimal places rather than
   *  rounding — silently dropping a poisha a user typed is not acceptable. */
  parseMajor(input: string, currency?: Currency): Result<Money, MoneyError>,

  add(a: Money, b: Money): Money,
  sub(a: Money, b: Money): Money,
  neg(a: Money): Money,
  compare(a: Money, b: Money): -1 | 0 | 1,
  isZero(a: Money): boolean,
  isNegative(a: Money): boolean,

  /** Percentage / ratio, e.g. a 12.5% discount. Banker's rounding. */
  mulRatio(a: Money, numerator: bigint, denominator: bigint): Money,

  /** Split across n parts so the parts ALWAYS sum to the whole.
   *  Remainder poisha go to the earliest parts.
   *  allocate(₹1000, 3) → [33334, 33333, 33333] minor. */
  allocate(a: Money, parts: number): Money[],

  /** Split proportionally to weights, same total-preserving guarantee.
   *  Used by proportional fee allocation (§17.3). */
  allocateByWeights(a: Money, weights: bigint[]): Money[],

  /** Display only. Never used for arithmetic or transport. */
  format(a: Money, opts: { locale: 'en' | 'bn'; numerals: 'latin' | 'bn';
                           showSymbol?: boolean }): string,

  /** Bangla amount-in-words for receipts. Indic system: lakh/crore, NOT a
   *  translation of an English words-generator. §22.3 */
  toWordsBn(a: Money): string,

  toJSON(a: Money): string,                 // "150000" — a STRING
  fromJSON(s: string, currency?: Currency): Money,
};
```

**Why `allocate` exists.** A ৳1,000 sibling discount split three ways is
33334 + 33333 + 33333 poisha. Anything computed as `1000/3` and rounded three
times loses or invents a poisha, and the daily collection report stops
reconciling. Total preservation is a unit-tested property, not a hope.

**Marks use `Money` too**, with `currency` ignored: 1 mark = 100 minor units.
This gets exact 0.5-mark and 0.25-mark grading for free and keeps a single
rounding implementation. Aliased as `Marks` for readability.

## 2.2 `date.ts`

Timezone is fixed to `Asia/Dhaka`. Platform-wide, non-configurable.

```ts
export type LocalDate = { readonly y: number; readonly m: number; readonly d: number };
export type DateRange = { readonly from: LocalDate; readonly to: LocalDate };  // inclusive

export const LocalDate = {
  of(y: number, m: number, d: number): LocalDate,
  parse(iso: string): Result<LocalDate, DateError>,   // strict "YYYY-MM-DD"
  toISO(d: LocalDate): string,

  /** Today in Asia/Dhaka — NOT the server's local date. */
  today(clock?: Clock): LocalDate,

  /** The business date of an instant, in Dhaka. Used to derive the attendance
   *  date from a sync payload rather than trusting the device clock (§27.5). */
  fromInstant(at: Date): LocalDate,

  addDays(d: LocalDate, n: number): LocalDate,
  addMonths(d: LocalDate, n: number): LocalDate,
  diffDays(a: LocalDate, b: LocalDate): number,
  compare(a: LocalDate, b: LocalDate): -1 | 0 | 1,
  dayOfWeek(d: LocalDate): 0|1|2|3|4|5|6,             // 0 = Sunday
  format(d: LocalDate, opts: { locale: 'en'|'bn'; numerals: 'latin'|'bn';
                               style: 'short'|'long' }): string,
};

export const DateRange = {
  of(from: LocalDate, to: LocalDate): Result<DateRange, DateError>,  // to >= from
  contains(r: DateRange, d: LocalDate): boolean,
  overlaps(a: DateRange, b: DateRange): boolean,
  days(r: DateRange): LocalDate[],
  lengthInDays(r: DateRange): number,
};

/** Injected everywhere time is read, so tests are deterministic and
 *  "what happens at 23:59 on 31 December" is testable. */
export interface Clock { now(): Date }
```

`Date` survives only for true instants. It never represents a calendar day.

## 2.3 `ids.ts`

```ts
declare const brand: unique symbol;
export type Id<T extends string> = string & { readonly [brand]: T };

export type TenantId     = Id<'tenant'>;
export type AccountId    = Id<'account'>;
export type PersonId     = Id<'person'>;
export type StudentId    = Id<'student'>;
export type StaffId      = Id<'staff'>;
export type EnrolmentId  = Id<'enrolment'>;
export type SectionId    = Id<'section'>;
export type MembershipId = Id<'membership'>;
// … one per aggregate

export const Ids = {
  /** Time-ordered ULID (ADR-0016). Generated in the APPLICATION so a full
   *  object graph can be built before any write — the import staging flow
   *  depends on this (ADR-0024). */
  generate<T extends string>(): Id<T>,

  parse<T extends string>(s: string): Result<Id<T>, IdError>,

  /** Canonical uuid text for the DB; Crockford base32 at the API edge. */
  toUuid(id: Id<string>): string,
  fromUuid(uuid: string): Id<string>,
};
```

Branding is compile-time only — zero runtime cost, and it makes
`getEnrolment(studentId)` fail to compile.

## 2.4 `result.ts`

```ts
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok  = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const Result = {
  map<T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E>,
  flatMap<T, U, E>(r: Result<T, E>, f: (t: T) => Result<U, E>): Result<U, E>,
  /** Fails on the FIRST error — used by import row validation, which must
   *  report every bad cell, so it uses `partition` instead. */
  all<T, E>(rs: Result<T, E>[]): Result<T[], E>,
  partition<T, E>(rs: Result<T, E>[]): { values: T[]; errors: E[] },
  unwrapOr<T, E>(r: Result<T, E>, fallback: T): T,
};

export interface DomainError {
  readonly code: string;
  readonly messageKey: string;
  readonly details?: Record<string, unknown>;
  readonly httpStatus: 400|403|404|409|422|423|429;
}
```

## 2.5 `auth-context.ts`

The object every use case takes as its first argument.

```ts
export interface AuthContext {
  readonly accountId: AccountId;
  readonly sessionId: SessionId;

  /** Normally one. Several ONLY for an organization admin viewing across their
   *  own schools. Built from verified memberships — NEVER from request input. */
  readonly tenantIds: readonly TenantId[];
  readonly activeTenantId: TenantId;

  readonly personId: PersonId;
  readonly membershipId: MembershipId;
  readonly permissions: ReadonlySet<Permission>;
  readonly scope: Scope;

  readonly locale: 'en' | 'bn';
  readonly requestId: string;

  /** A suspended tenant resolves but cannot write (invariant 14). */
  readonly readOnly: boolean;

  /** Set only during support impersonation (ADR-0029). Present in every audit
   *  row written during the session, and visible to the tenant. */
  readonly impersonation?: { operatorId: string; reason: string; expiresAt: Date };
}

export interface Scope {
  readonly campusIds?:  readonly SectionId[];
  readonly classIds?:   readonly ClassLevelId[];
  readonly sectionIds?: readonly SectionId[];
  readonly subjectIds?: readonly SubjectId[];
  // An absent key means unrestricted WITHIN the tenant. Never across tenants.
}

/** Throws AuthorizationError. Asserts, so control flow after it is typed as
 *  authorized. Called by EVERY use case — checked by lint (§9.4). */
export function authorize(
  ctx: AuthContext,
  permission: Permission,
  target?: ScopeTarget,
): asserts ctx is AuthorizedContext;

/** Scope predicates for the query layer, so a teacher's list is narrowed in
 *  SQL rather than filtered in JS after the fact (§8.5). */
export function scopeFilter(ctx: AuthContext, on: 'section' | 'class' | 'campus')
  : SQL | undefined;
```

`readOnly` is on the context rather than checked per use case, so suspension
cannot be forgotten: `withTenant` refuses to open a writable transaction when it
is set.

## 2.6 `cache.ts` and `rate-limiter.ts`

Interfaces now, in-process implementations now, Redis adapters when the second
node is planned ([ADR-0014](../../architecture/adr/0014-defer-redis.md)).

```ts
export interface Cache {
  get<T>(key: CacheKey): Promise<T | undefined>;
  set<T>(key: CacheKey, value: T, ttlSeconds: number): Promise<void>;
  invalidate(prefix: CacheKeyPrefix): Promise<void>;
}

/** Invariant 15: every cache key carries tenant_id. The type makes it
 *  impossible to construct one that does not. */
export type CacheKey = `t:${string}:${string}`;
export const cacheKey = (tenantId: TenantId, rest: string): CacheKey =>
  `t:${tenantId}:${rest}`;

export interface RateLimiter {
  check(key: string, limit: number, windowSeconds: number)
    : Promise<{ allowed: boolean; remaining: number; retryAfterSeconds?: number }>;
}
```

**No cached value is ever required for correctness** (invariant 15). A cold cache
is a latency event. This is what makes deferring Redis safe rather than merely
cheap.

## 2.7 What is deliberately *not* in `shared/`

| Not here | Where |
|---|---|
| Calendar resolution | `modules/calendar` — it needs the database |
| Grade scales, fee heads | Tenant data, not code |
| Permission *values* | `modules/identity` owns the union |
| Repositories, Drizzle | `modules/*/infrastructure` |
| Localised strings | `src/messages/` |
| HTTP status mapping | The transport edge |

If something needs the database, it is not shared-kernel material.
