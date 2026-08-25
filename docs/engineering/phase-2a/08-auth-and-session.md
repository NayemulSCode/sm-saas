# 8. Authentication and session mechanics

Implementable detail for [§8.4](../../architecture/phase-1a/08-identity-authn-rbac.md).
Own implementation, because one account holding memberships across tenants with
phone-OTP as a first-class login defeats the off-the-shelf options
([§5.4](../../architecture/phase-1a/05-technology-review.md)).

What is **not** hand-rolled: Argon2id, TLS, CSRF token generation, rate limiting.

## 8.1 Credential normalisation

Applied before **any** lookup or insert. A number entered as `01711…`,
`+88 01711…` and `8801711…` must resolve to one account.

```ts
export function normalisePhone(raw: string): Result<string, CredentialError> {
  const digits = raw.replace(/[\s\-()]/g, '')
                    .replace(/^\+?88/, '')     // strip country code if present
                    .replace(/^0/, '');        // strip trunk zero
  if (!/^1[3-9]\d{8}$/.test(digits)) return err(INVALID_PHONE);
  return ok(`+880${digits}`);                  // E.164, matches the DDL CHECK
}

export const normaliseEmail = (raw: string) => raw.trim().toLowerCase();
```

Bangla digits are converted to Latin first — a user typing on a Bangla keypad
produces `০১৭…`, and rejecting it would be a support call
([§22.3](../../architecture/phase-1b/22-i18n-architecture.md)).

## 8.2 Guardian login — phone OTP

The default path for the largest user group, and the answer to FR-2.10:
**credential distribution is solved by not having credentials.**

```mermaid
sequenceDiagram
    autonumber
    participant G as Guardian
    participant A as App
    participant P as PostgreSQL
    participant S as SMS worker

    G->>A: POST /auth/otp/request { phone }
    A->>A: normalise → E.164
    A->>A: rate limit: per phone AND per IP
    A->>P: SELECT credential WHERE (kind,value)
    Note over A: Respond 200 IDENTICALLY whether or not the<br/>account exists. Timing normalised to a fixed floor.
    A->>P: INSERT otp_challenge (code_hash, expires 5 min, attempts 0)
    A->>P: enqueue sms.otp — transactional queue
    A-->>G: 200 { challengeId }
    S->>G: 6-digit code

    G->>A: POST /auth/otp/verify { challengeId, code }
    A->>P: SELECT ... FOR UPDATE (single-use)
    A->>A: constant-time compare; check expiry, attempts
    A->>P: UPDATE consumed_at; INSERT session
    A->>P: resolve contexts (sm_platform pool)
    A-->>G: Set-Cookie: sm_session=<opaque>; contexts[]
```

| Control | Value |
|---|---|
| Code | 6 digits, CSPRNG, **hashed** at rest (never stored plaintext) |
| Expiry | 5 minutes |
| Attempts | 5, enforced by a `CHECK` **and** the update path |
| Single use | `consumed_at` set under `FOR UPDATE` |
| Rate limit | 3 requests / 15 min per phone; 20 / hour per IP |
| Enumeration | Identical response and normalised timing for unknown numbers |
| Resend | Reuses the live challenge; does not mint a second code |
| Cost | Each OTP is a billable SMS — the per-IP limit is a spend control as much as a security one |

## 8.3 Staff login — password

```
POST /auth/password  { identifier, password }
  normalise identifier (phone or email)
  SELECT credential JOIN account
  if account.locked_until > now()  → 423 ACCOUNT_LOCKED
  argon2id.verify(password_hash, password)        ← constant time
  on failure: failed_attempts += 1
              if >= 5 → locked_until = now() + 15 min, audit, notify
  on success: failed_attempts = 0, issue session
```

**Argon2id parameters:** `m = 19456 KiB (19 MiB)`, `t = 2`, `p = 1` — the OWASP
baseline. Memory cost is deliberately modest because the app shares an 8 GB host
with PostgreSQL and Chromium ([ADR-0002](../../architecture/adr/0002-hosting-and-region.md));
a 64 MiB setting under a login burst would compete with the database.

Staff are provisioned by **single-use invite link**, and set their own password.
No password is ever transmitted, by SMS or email.

## 8.4 Context resolution

The step that makes one login work across schools.

```ts
async function resolveContexts(accountId: AccountId): Promise<Context[]> {
  // Runs on the sm_platform pool: this query is legitimately cross-tenant and
  // cannot use a tenant session context, because the tenant is what it is
  // resolving. It is the ONLY read of membership done this way, and it is
  // narrow — by account_id, returning ids and names only.
  return platformDb.select({ … })
    .from(membership)
    .innerJoin(tenant, eq(tenant.id, membership.tenantId))
    .innerJoin(person, eq(person.id, membership.personId))
    .where(and(eq(membership.accountId, accountId),
               eq(membership.status, 'active'),
               isNull(membership.deletedAt),
               notInArray(tenant.status, ['purged', 'cancelled'])));
}
```

| Outcome | Behaviour |
|---|---|
| 0 contexts | 403 with a neutral message. The account exists but belongs nowhere |
| 1 context | Activated immediately; no switcher shown |
| >1 contexts | Switcher; the last-used context is remembered per account |

Switching rewrites `session.active_membership_id` **server-side**. The client
sends a membership id; the server verifies it belongs to this account before
activating it. A client cannot select a context it has no membership for.

`AuthContext.tenantIds` normally holds exactly one id. It holds several only when
the active membership carries an organization-level role, and the list is derived
from `organization → school → tenant` — never from request input
([§5.4](05-rls-and-isolation-harness.md)).

## 8.5 Session mechanics

Opaque random tokens, server-side state. **Not JWTs** — revocation must take
effect within 60 seconds (NFR §4.6), and a stateless token cannot do that without
a revocation list, which is a session table with worse ergonomics.

```
Cookie: sm_session=<32 bytes base64url>
  HttpOnly · Secure · SameSite=Lax · Path=/ · Domain=<tenant subdomain>
```

Stored as `sha256(token)` in `session.token_hash`. A database leak does not yield
usable session tokens.

| Property | Staff | Guardian |
|---|---|---|
| Idle timeout | 12 h | 30 d rolling |
| Absolute lifetime | 30 d | 90 d |
| `last_seen_at` write | Throttled to once per 5 min | Same |
| Revocation | Immediate, by `revoked_at` | Same |

`SameSite=Lax` rather than `Strict` because guardians arrive via SMS links from
an external context and `Strict` would drop the session on that first navigation.
CSRF is covered by a double-submit token on state-changing requests, plus an
`Origin` check.

**Sessions are one of only two tables that are hard-deleted** (with
`otp_challenge`) — invariant 6. A nightly job purges rows past `expires_at`.

## 8.6 Middleware — building the context

Runs before every handler ([§6.4](../../architecture/phase-1a/06-architecture-overview.md)):

```
1. resolve tenant from Host           → 404 if the slug is unknown
2. read session cookie                → 401 if absent/expired/revoked
3. load account + active membership
4. verify membership.tenant_id == resolved tenant
      mismatch → 404, NOT 403
      (403 would confirm the tenant exists — tenant existence is information)
5. load roles, permissions, scope
6. tenant.status ∈ (suspended, past_due) → ctx.readOnly = true
7. attach requestId, locale
8. → AuthContext
```

Step 4's 404 is deliberate and easy to "fix" into a 403 by someone who thinks it
is a bug. It carries a comment saying so.

## 8.7 Threats and controls

| Threat | Control |
|---|---|
| Credential stuffing on guardians | No password to stuff; OTP rate-limited per phone and IP |
| SIM swap | Accepted residual risk for guardians. **Financial actions always require staff authentication**, never a guardian's |
| Enumeration of enrolled phones | Identical responses, normalised timing |
| OTP brute force | 6 digits, 5 attempts, 5-minute window, single use |
| Session fixation | New session id issued on every authentication |
| Session theft | HttpOnly + Secure + hashed at rest + revocable in < 60 s |
| CSRF | SameSite=Lax + double-submit token + Origin check |
| Privilege escalation | `role.manage` cannot grant a permission the granter lacks; self-grant blocked and audited ([§9](09-permissions-and-roles.md)) |
| Cross-tenant context switching | Membership verified server-side against the account |
| Operator abuse | Separate pool, mandatory reason, 30-minute limit, tenant-visible ([ADR-0029](../../architecture/adr/0029-impersonation-controls.md)) |

## 8.8 Phase 3a acceptance

Auth is done for 3a when:

1. A guardian logs in by OTP with no password anywhere in the system.
2. A staff member accepts an invite, sets a password, and logs in.
3. **One account with memberships in two tenants sees a switcher and can reach
   both** — the case the whole model exists for.
4. Revoking a session takes effect on the next request.
5. Lockout, rate limits and enumeration-resistance are covered by tests.
6. Every authentication event appears in `audit_log`.
