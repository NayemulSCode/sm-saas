# 19. API architecture

REST, versioned ([ADR-0007](../adr/0007-api-style.md)). This section fixes the
conventions so they are decided once rather than per endpoint.

## 19.1 Surfaces

| Surface | Path | Consumer | Auth |
|---|---|---|---|
| App REST | `/api/v1/...` | The web app's client components, future integrations | Session cookie + tenant from host |
| Server actions / RSC | none — in-process | Server components and forms | Same `AuthContext` |
| Platform | `/api/platform/v1/...` | Operator console | Operator session, MFA, separate pool |
| Webhooks in | `/api/hooks/<provider>` | Payment and SMS providers | Signature verification, no session |
| Public tenant | `/api/public/v1/...` | CMS pages, published results by token | Unauthenticated, heavily rate-limited |

All five run through the same middleware that resolves tenant and context, and
all five call the same use cases. There is no second implementation of anything.

## 19.2 Resource conventions

```
GET    /api/v1/students?sectionId=…&status=active&limit=50&cursor=…
POST   /api/v1/students
GET    /api/v1/students/{id}
PATCH  /api/v1/students/{id}
DELETE /api/v1/students/{id}            → soft delete, requires reason

POST   /api/v1/students/{id}:withdraw   → a state transition, not a field edit
POST   /api/v1/exams/{id}:publish
POST   /api/v1/payments                 → Idempotency-Key required
```

State transitions are **verbs on the resource**, not `PATCH {status: …}`. A
withdrawal requires a reason, an effective date and an audit entry; modelling it
as a field update invites a client to skip all three.

## 19.3 Response envelope

One shape, always.

```jsonc
// success
{ "data": { … }, "meta": { "requestId": "01J…" } }

// list
{ "data": [ … ],
  "meta": { "requestId": "01J…", "nextCursor": "…", "hasMore": true } }

// error
{ "error": {
    "code": "FEE_ALREADY_PAID",          // stable, machine-readable
    "message": "এই ইনভয়েসটি ইতিমধ্যে পরিশোধিত",   // localised for humans
    "details": [ { "field": "invoiceId", "code": "ALREADY_PAID" } ],
    "requestId": "01J…"
  } }
```

`code` is stable and never localised. `message` is localised to the request
locale and never parsed by clients. `requestId` appears in the response, in the
logs and in Sentry — which is what makes a support call resolvable: "read me the
reference at the bottom of the error".

## 19.4 Error taxonomy

| HTTP | When | Note |
|---|---|---|
| 400 | Malformed request, Zod failure | `details` carries field-level codes |
| 401 | No or expired session | |
| 403 | Authenticated, lacks permission or scope | |
| **404** | Resource absent **or** in another tenant | Deliberate: 403 would confirm existence ([§7.3](../phase-1a/07-multi-tenancy.md)) |
| 409 | Optimistic-lock conflict, duplicate, illegal state transition | |
| 422 | Valid shape, violates a domain rule | e.g. marks above full marks |
| 423 | Locked — marks locked, tenant suspended, year closed | Distinct from 403; the actor may have permission but the object is frozen |
| 429 | Rate limited | `Retry-After` always set |
| 500 | Unexpected | Never leaks internals; `requestId` only |

Domain errors are typed `Result<T, E>` in the use case and mapped to HTTP at the
transport edge — the domain layer knows nothing about status codes.

## 19.5 Idempotency

Required on every money-moving and bulk endpoint (FR-X.6).

```http
POST /api/v1/payments
Idempotency-Key: 01JB2K9X7T4QZC8M3N5P6R7S8T
```

| Rule | Behaviour |
|---|---|
| Key stored with a hash of the request body | Same key + same body → the **original response** is replayed |
| Same key + **different** body | `409 IDEMPOTENCY_KEY_REUSED`. This catches a genuine client bug |
| Claimed inside the transaction | A concurrent duplicate conflicts on the primary key and loses |
| Retention | 24 hours, then purged |
| Scope | Per tenant |

Applies to: payments, refunds, invoice generation, bulk promotion, bulk import
commit, result publication, campaign dispatch.

## 19.6 Pagination, filtering, sorting

**Keyset by default.** Offset pagination degrades on large tables and — worse —
produces duplicate and skipped rows while data changes underneath, which for a
defaulter list being worked through is a real problem.

```
GET /api/v1/payments?limit=50&cursor=eyJjb2xsZWN0ZWRBdCI6…
```

Cursor encodes the sort key plus the id tiebreaker, and is opaque and signed.
Offset pagination is available only where a UI genuinely needs page numbers, and
is capped.

Filtering and sorting accept **whitelisted field names only**, mapped
server-side to columns. Raw column names from input are never interpolated —
that is both an injection surface and a coupling to the schema.

Every list endpoint has a maximum `limit` (100) and a default (25).

## 19.7 Validation

One Zod schema per input, shared by the client form and the server handler:

```ts
export const RecordPaymentSchema = z.object({
  studentId: ulid(),
  amountMinor: z.bigint().positive(),
  channel: z.enum(['cash','bank','cheque','mfs','online']),
  collectedAt: localDate(),
  channelRef: z.string().max(64).optional(),
});
```

The client gets instant validation; the server never trusts it. Sharing the
schema means the two cannot drift, which is the main practical benefit of a
single-language stack ([ADR-0004](../adr/0004-application-framework.md)).

## 19.8 Versioning

`/api/v1`. A breaking change means `/api/v2` with `v1` supported for a stated
window. Additive changes — new optional fields, new endpoints — do not bump the
version.

Breaking includes: removing or renaming a field, narrowing a type, changing an
error `code`, changing pagination semantics, or changing a default.

Because the primary consumer ships with the server, v1 will live a long time.
The versioning exists for the day a partner integration appears — at which point
the discipline must already be in place.

## 19.9 Rate limiting

| Layer | Scope | Purpose |
|---|---|---|
| Cloudflare | Per IP, per path | Volumetric abuse, before it reaches origin |
| Application | Per account, per tenant | Fair use, runaway clients |
| Endpoint-specific | OTP: per phone **and** per IP | Enumeration and SMS-cost abuse |
| Write endpoints | Per tenant | An import loop cannot saturate the pool |

Limits are advertised via `RateLimit-*` headers and always accompanied by
`Retry-After` on 429. Per [ADR-0014](../adr/0014-defer-redis.md), the application
limiter is in-process while there is one node, behind a `RateLimiter` interface.

## 19.10 Documentation

OpenAPI generated from the Zod schemas — one source of truth, so the document
cannot describe an API that no longer exists. Served at `/api/v1/openapi.json`,
with a rendered reference behind operator auth until there is an external
consumer.

## 19.11 Cross-cutting request rules

| Rule | Detail |
|---|---|
| `requestId` | Generated at the edge, propagated through logs, jobs and Sentry |
| Tenant context | From the host header, never from a body field or query parameter |
| Locale | `Accept-Language`, overridden by the user's stored preference |
| Timezone | Server always computes in `Asia/Dhaka`; clients never send offsets |
| Money on the wire | **Strings** of minor units (`"150000"`), never JSON numbers — JSON numbers are IEEE doubles and `bigint` values above 2^53 lose precision |
| Dates | `YYYY-MM-DD` for calendar days, RFC 3339 for instants. Never mixed |
| Max body | 1 MB for JSON; uploads go to a separate signed-URL flow, never through the API |
| Compression | Brotli/gzip on responses. Meaningful on 3G |
| CORS | Same-origin only in MVP. No wildcard, ever |

The money-as-string rule is the one most likely to be violated by accident and
the most expensive to discover late. It is a lint rule on the serialisation
layer in Phase 3.
