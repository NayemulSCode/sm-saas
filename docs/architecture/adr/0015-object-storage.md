# ADR-0015 — Cloudflare R2 for object storage, behind an S3-compatible interface

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1A

## Context

Student photos, guardian documents, birth certificates, staff documents, school
logos, generated report cards and receipts, import files and export bundles.
This is personal data about children, and none of it belongs in PostgreSQL.

The cost that matters is **egress**, not storage. On result publication day
every guardian of a school downloads a report card PDF. Storage is a few
hundred gigabytes; egress is the recurring, spiky bill.

## Options

### A. AWS S3
The reference implementation. Egress charged per GB — the wrong shape for this
traffic pattern, and it compounds exactly when the platform is under load.

### B. Cloudflare R2
S3-compatible API, roughly US$0.015/GB-month, **zero egress fees**. Already in
the team's toolchain via Cloudflare DNS/CDN, and the `bdagency` project uses R2.

### C. Self-hosted MinIO on the same VPS
No marginal cost. Durability, replication and backup become the team's problem,
on a box that already runs everything else. For documents that legally cannot be
regenerated — a scanned birth certificate — that is the wrong risk to own with
no DevOps function.

### D. Hetzner or DigitalOcean object storage
Reasonable, in-region, with egress allowances. Weaker CDN integration than R2.

## Decision

**B — Cloudflare R2**, private buckets only, accessed through **short-lived
signed URLs**, behind an S3-compatible `Storage` interface in the shared kernel.

Deciding reason: zero egress makes the cost model predictable precisely at the
moment the system is most loaded, and it removes any temptation to make document
delivery cheaper by making it less secure.

Access rules fixed now:

| Rule | Detail |
|---|---|
| No public buckets | Ever. Every object is fetched through a signed URL |
| Signed URL lifetime | Minutes, not hours |
| Authorization before signing | The application checks permission and scope, then signs. The URL is the last step, never the check |
| Key layout | `tenant/<tenant_id>/<entity>/<id>/<ulid>.<ext>` — so a tenant's objects are enumerable for export and deletion |
| Validation on upload | MIME sniffing, extension allowlist, size cap, image re-encoding to strip EXIF |
| Per-tenant quota | Enforced at upload from the plan limit |
| Retention | Generated documents expire on a schedule; source documents are retained per the tenant retention policy |

Virus scanning is deferred (ClamAV in the worker) and noted as a P2 item, since
the upload surface is authenticated staff rather than the public.

## Consequences

**Makes easy:** predictable cost under load; no storage operations; PostgreSQL
stays small and its backups stay fast; CDN integration is native.

**Makes hard:** an external dependency for document access — if R2 is
unavailable, documents are unavailable while the application still works.
Accepted. Local development needs either a bucket or MinIO for parity; MinIO is
used locally, which conveniently keeps option C exercised.

**Forecloses:** nothing. The `Storage` interface has four methods; MinIO or
Hetzner is an adapter swap.

## Revisit when

- **[OQ-1](../phase-1a/13-open-questions.md)** — a data-residency ruling
  requires objects stored in Bangladesh. Then MinIO or a local provider, using
  the same interface.
- Storage exceeds ~5 TB and a cheaper tier becomes material.
- Cloudflare pricing changes such that egress is no longer free — the assumption
  this decision rests on.
