# ADR-0026 — WAL archiving to a second provider, with per-transaction synchronous commit for money

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1C

## Context

The brief requires that maximum acceptable data loss for financial records be
**zero**, and asks how. Meanwhile the platform runs on a single VPS with no HA
([ADR-0002](0002-hosting-and-region.md)) and a US$250/month ceiling.

Those look incompatible: zero RPO normally means synchronous replication, and
synchronous replication normally means paying its latency on every write.

## Options

### A. Nightly dumps only
Cheapest. RPO of up to 24 hours. Unacceptable for financial records — a day of
receipts is unrecoverable and the school has printed copies proving it.

### B. Base backup + continuous WAL archiving
RPO ≈ the archive interval (~60 s). Good for everything except money, where 60
seconds of lost receipts is still a school's afternoon.

### C. B, plus a synchronous standby for **all** writes
RPO 0 everywhere. Every attendance tick and page view pays replication latency,
on a product whose users are on 3G.

### D. B, plus a standby that only **money transactions** wait for

## Decision

**D.**

PostgreSQL's `synchronous_commit` is settable per transaction, so the cost is
paid only where it is warranted:

```sql
BEGIN;
  SET LOCAL synchronous_commit = 'remote_write';
  -- issue receipt number, insert payment, allocate against dues
COMMIT;   -- returns only once the standby has the WAL
```

| Property | Value |
|---|---|
| RPO, general | ≤ 60 s (`archive_timeout = 60s`) |
| **RPO, financial** | **0** |
| RTO | ≤ 4 h |
| Base backup | Nightly, 30 days |
| WAL | Continuous, 7-day PITR window |
| Monthly logical dump | 12 months |
| **Backup destination** | **Cloudflare R2 — a different provider from the compute host** |
| Restore drill | **Quarterly, on a real restore to a scratch host** |

Two supporting decisions:

**Backups live at a different provider than the host.** A provider-level account
problem must not take the compute and the backups together.

**The quarterly drill is the point.** An untested backup is not a backup, and the
measured restore time from the last drill *is* the real RTO — the 4-hour figure
is a target until a drill confirms it. The drill is performed by whoever did not
build the system, which is also the only reliable test of the runbook.

The standby costs US$12–22/month and does three jobs: financial durability, the
restore source, and the reporting read replica at
[stage 2](../phase-1c/32-scalability.md). It is the one component in this
architecture deliberately bought **before** its trigger metric fires, because the
brief is explicit that financial correctness outranks cost-consciousness.

## Consequences

**Makes easy:** an honest zero-RPO claim for money; point-in-time recovery; a
restore source that is already warm; reporting isolation later.

**Makes hard:** money transactions carry replication latency — acceptable, since
they are counter operations measured in hundreds per day, not thousands per
second. Standby health becomes operationally significant: if it falls behind,
money writes slow down. Monitored, with an alert at 30 s lag.

**Forecloses:** nothing.

## Revisit when

- A restore drill fails, or measures materially longer than 4 hours.
- Standby lag causes user-visible latency on payment recording.
- Regulation requires an onshore backup copy
  ([OQ-1](../phase-1a/13-open-questions.md)).
- Tenant count makes whole-cluster restore too slow for a single-tenant request —
  then per-tenant logical backups become worth their cost.
