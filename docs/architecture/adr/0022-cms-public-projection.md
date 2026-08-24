# ADR-0022 — Puck CMS deferred to Phase 2, behind a public projection boundary

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1B

## Context

The brief specifies Puck Editor for tenant-authored pages. Two questions:
**when**, and **what may a tenant-authored page reach**.

The second is a security question. A CMS page is tenant-authored content served
on a tenant subdomain, and its blocks want to show live data — notices, exam
routines, admission dates. That is the value; it is also the largest untrusted-
input surface in the platform.

## Options

### A. Build the CMS in the MVP
Costs roughly a quarter. No school changes vendors for a website builder.

### B. Defer entirely, design nothing
Cheapest now. The public-data boundary then gets invented in a hurry later,
probably by handing a template a real query interface.

### C. Defer the build, decide the boundary now

## Decision

**C.** Puck is the right editor and ships in Phase 2. The **boundary** is decided
now, in one page of design, and constrains anything built before then.

Two rules:

**1. Data-bound blocks read only a `PublicProjection`.**

```ts
interface PublicProjection {
  notices(tenantId, opts): Promise<PublicNotice[]>;
  examRoutine(tenantId, classLevelId): Promise<PublicRoutineRow[]>;
  staffDirectory(tenantId): Promise<PublicStaff[]>;   // name + designation only
  lookupResult(tenantId, examId, token): Promise<PublicResult | null>;
}
```

A hand-written allowlist, not a filter over full records. A CMS block physically
cannot reach a student record because the only interface available to it does not
expose one.

**2. No raw HTML block, ever.** Rich text is a constrained schema, sanitised on
save and on render. A raw-HTML block is a stored-XSS feature request. Embeds are
allowlisted; public pages are served from a route group with no session cookie
access; media is re-encoded and EXIF-stripped on upload.

Storage: Puck's document is stored as `jsonb` on `page_version` rather than
shredded into per-block tables. The editor owns the document shape, content is
rendered rather than queried, and a mirrored schema would need migrating every
time a block gains a field.

## Consequences

**Makes easy:** a quarter of MVP time spent on things schools pay for; a security
boundary that exists before the feature does; rollback by selecting an older
version row.

**Makes hard:** every new data-bound block needs a deliberate projection method —
which is the intended friction. Public pages have their own caching and
invalidation path.

**Forecloses:** arbitrary tenant queries from templates. Deliberate.

## Revisit when

- Twenty tenants are live and retention conversations mention the school website,
  or a sale is lost over it.
- A tenant needs a block whose data is not in the projection — extend the
  projection explicitly; never widen it to a general query interface.
