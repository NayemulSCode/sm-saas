# ADR-0004 — Next.js full-stack, not NestJS plus a separate frontend

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1A

## Context

The brief suggests NestJS + Prisma for the backend with Next.js as a separate
frontend. The team is 1–2 developers who most recently shipped a Next.js
application. The product is overwhelmingly a data-entry and reporting UI over a
relational database, with a handful of asynchronous flows.

## Options

### A. NestJS API + separate Next.js frontend
Excellent structure, first-class DI, mature module system. Costs: two
deployables, two CI pipelines, two dependency trees, an auth surface implemented
twice, a DTO layer maintained on both sides, and an HTTP hop for every dashboard
query that a server component could satisfy directly.

### B. Next.js full-stack — RSC for reads, route handlers for the REST API,
a second entrypoint for the worker
One deployable. Server components query the database in-process. One auth
implementation. The genuine risk is that domain logic leaks into route handlers
and the "architecture" becomes a folder of controllers.

### C. Fastify or Hono API + Next.js frontend
Lighter than NestJS but shares its two-deployable cost without its structure.

## Decision

**B**, with the risk mitigated structurally rather than hoped away: the domain
lives in `modules/*/domain` and `modules/*/application`, and an ESLint boundary
rule forbids those directories from importing `next/*`, Drizzle or any SDK.
Route handlers, server components and job handlers are all thin transports over
the same use cases ([ADR-0001](0001-modular-monolith.md)).

The deciding reason: NestJS's real value is module boundaries and dependency
inversion, and both are available as plain TypeScript. What NestJS *adds* on top
is a second deployable — which at 1–2 developers is a cost with no matching
benefit.

## Consequences

**Makes easy:** one repository, one deploy, one auth path, no client/server DTO
drift, and dashboards that read the database without a network hop.

**Makes hard:** keeping discipline — the lint rule is doing real work here.
Next.js version upgrades touch everything at once. Some Node libraries assume a
long-lived server process; the worker entrypoint is where those live.

**Forecloses:** nothing. Because the domain layer is framework-free, standing up
a Fastify or NestJS process over the same modules later is a packaging exercise.

## Revisit when

- A non-web consumer appears that needs the API without the UI — a mobile app or
  a partner integration at meaningful volume.
- Next.js request handling becomes a measured bottleneck for the API
  specifically, as distinct from rendering.
- The team exceeds ~6 developers and frontend/backend specialisation makes two
  deployables cheaper than one.
