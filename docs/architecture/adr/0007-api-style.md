# ADR-0007 — Versioned REST, with a mandatory idempotency convention

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1A

## Context

The brief asks for an explicit choice between REST, GraphQL and a hybrid,
including the cost to a small team, caching behaviour, and how tenant scoping
and authorization are enforced uniformly.

## Options

### A. REST, versioned under `/api/v1`
One authorization check per endpoint in one place. HTTP caching works, which
matters for published results at the CDN edge. Over-fetching on mobile is real,
but largely neutralised because React Server Components already select exactly
the columns they render.

### B. GraphQL
Solves mobile over-fetching natively and gives a self-documenting schema. Its
authorization surface grows per field and per resolver path — the exact property
that must not fail here is cross-tenant isolation. Requires DataLoader
discipline everywhere to avoid N+1. It is a second system for two people to own.

### C. Hybrid
Both surfaces to secure, both to document, both to keep in sync.

## Decision

**A — REST**, versioned, with these conventions fixed now:

| Convention | Rule |
|---|---|
| Versioning | `/api/v1/...`. A breaking change means `v2`, with `v1` supported for a stated window |
| Auth | Session cookie; tenant from subdomain; context built in middleware |
| Validation | Zod at the boundary, the same schema used by the client form |
| Errors | One envelope: `code`, `message` (localised), `details`, `requestId` |
| Pagination | Keyset by default; offset only where a UI genuinely needs page numbers |
| Filtering/sorting | Server-side, whitelisted fields only — never raw column names from input |
| **Idempotency** | `Idempotency-Key` header **required** on every money-moving and bulk endpoint; the key is stored and the original response replayed on retry |
| Rate limits | Per tenant and per account, at the edge and in the application |
| Documentation | OpenAPI generated from the Zod schemas — one source of truth |

The deciding reason: GraphQL's benefit lands on a problem RSC already solves
here, while its cost lands on the one property that must never fail.

## Consequences

**Makes easy:** one place to authorize; CDN caching of published results;
obvious N+1 diagnosis; a small, boring API surface a new developer can read.

**Makes hard:** purpose-built endpoints for composite screens — accepted, and
often clearer than a generic query language. Versioning requires discipline.

**Forecloses:** nothing. A GraphQL layer over the same use cases remains
possible if a partner integration ever demands it.

## Revisit when

- A third-party or partner integration needs flexible querying at real volume.
- A native mobile app ships and over-fetching is measured as a genuine cost on
  the target devices — measured, not assumed.
