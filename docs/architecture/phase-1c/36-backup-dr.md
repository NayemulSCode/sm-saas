# 36. Backup and disaster recovery

Targets from [§4.1](../phase-1a/04-non-functional-requirements.md):

| Target | Value |
|---|---|
| RPO — general | ≤ 60 s |
| **RPO — financial records** | **0** |
| RTO | ≤ 4 hours |
| Restore drill | **Quarterly, on a real restore** |

The last row is the one that makes the others true. An untested backup is not a
backup, and the single most common way small teams lose data is discovering at
restore time that the backups were empty for months.

## 36.1 What is backed up

| Data | Method | Destination | Retention |
|---|---|---|---|
| PostgreSQL — base | `pg_basebackup`, nightly | R2 (separate bucket) | 30 days |
| PostgreSQL — WAL | Continuous archive, `archive_timeout = 60s` | R2 | 7 days (PITR window) |
| PostgreSQL — monthly archive | Logical dump, 1st of month | R2, cold | 12 months |
| **Streaming replica** | Continuous | Second VPS | Live |
| R2 objects | Versioning + lifecycle | R2 | Per [§29.5](29-file-media.md) |
| Secrets | **Offline, out of band** | Password manager | — |
| Configuration | Git | GitHub | Forever |

Backups go to a **different provider than the compute** — Hetzner/DO for the
host, Cloudflare R2 for backups. A provider-level account problem should not take
the host and the backups at the same time.

## 36.2 How financial RPO reaches zero

Restating the mechanism from
[§4.5](../phase-1a/04-non-functional-requirements.md), because it is the
cleverest part of the design and easy to lose:

```sql
-- Ordinary transactions: fast, group-committed.
-- RPO bounded by WAL archive interval (~60 s).

-- Money-moving transactions: wait for the replica.
BEGIN;
  SET LOCAL synchronous_commit = 'remote_write';
  -- issue receipt number, insert payment, allocate
COMMIT;   -- returns only once the standby has the WAL
```

`synchronous_commit` is **per transaction**, so a US$5–8/month replica converts
financial RPO from ~60 seconds to zero, while attendance and page views pay none
of the latency cost. The replica then does three jobs for one price: financial
durability, restore source, and the reporting read replica at
[stage 2](32-scalability.md).

Additional financial durability, none of which costs anything:

- Payments are append-only; corrections are reversing entries
- Receipt numbers are issued in the same transaction as the payment
- Idempotency keys prevent a retry double-posting
- **The school holds a printed receipt** — a genuine out-of-band record

## 36.3 Disaster scenarios and responses

| Scenario | Likelihood | Response | RTO |
|---|---|---|---|
| Container crash | High | Compose restart policy | Seconds |
| Bad release | Medium | Deploy previous tag ([§35.7](35-deployment.md)) | ≤ 5 min |
| Accidental bulk data change by a user | **Medium** | Compensating batch action; audit log | Minutes |
| Accidental destructive migration | Low | PITR to just before it | 1–3 h |
| PostgreSQL corruption | Low | Promote replica, or restore base + WAL | 30 min – 3 h |
| **Host loss** | Low | Provision new VPS, restore, repoint DNS | ≤ 4 h |
| Region outage | Very low | Restore to another region from R2 | 4–8 h |
| R2 outage | Low | Documents unavailable; app works ([§29.7](29-file-media.md)) | — |
| Ransomware / destructive insider | Very low | Restore from immutable offsite backups | 4–8 h |
| Provider account loss | Very low | Backups are at a different provider | 8–24 h |

Row three deserves attention: **the most likely "disaster" is a user, not a
machine.** Someone promotes the wrong section, or imports a file twice. That is
why the primary recovery mechanism is not a database restore at all — it is soft
deletes, audit trails and compensating batch actions
([§7.5](../phase-1a/07-multi-tenancy.md)). Those handle the overwhelming majority
of real incidents in minutes, without touching a backup.

## 36.4 Single-tenant restore

The acknowledged weak point of shared-schema tenancy
([ADR-0003](../adr/0003-tenancy-model.md)), so it is designed rather than hoped
for.

| Need | Mechanism | Time |
|---|---|---|
| Undo a bad bulk operation | Compensating action + audit log | Minutes |
| Undo an import batch | Batch reversal ([§25.5](../phase-1b/25-data-import.md)) | Minutes |
| Recover a deleted record | Soft delete → restore | Seconds |
| **Restore one tenant to a point in time** | Restore the cluster to a scratch host → export that tenant → re-import under a new tenant id → repoint the slug | **2–4 h** |

The last row is genuinely slower than a per-tenant database would be. That is the
accepted cost of the tenancy model, and it is accepted because rows 1–3 handle
almost every real request. "Restore this school to yesterday" is nearly always
"undo what we did at 11:40".

The export/import path is the **same code** as tenant offboarding
([§25.7](../phase-1b/25-data-import.md)) — so the emergency path is exercised
continuously rather than only in emergencies.

## 36.5 Verification — the part that is usually skipped

| Check | Frequency | Failure action |
|---|---|---|
| Backup job completed | Daily, automated | **Notify tier** ([§34.5](34-observability.md)) |
| Backup file exists, size sane vs yesterday | Daily, automated | Notify |
| WAL archive continuity — no gaps | Daily, automated | Notify |
| `pg_verifybackup` on the latest base | Weekly, automated | Notify |
| **Full restore to a scratch host + row counts + app boots** | **Quarterly, manual** | Fix before anything else |
| Single-tenant export/restore rehearsal | Quarterly, with the above | Fix |
| Replica lag | Continuous | Alert > 30 s |

The quarterly drill is a calendar commitment, not an aspiration, and it produces
a written record: how long it took, what broke, what the runbook got wrong. **The
measured restore time from the last drill is the real RTO** — the 4-hour figure
is a target until a drill confirms it.

## 36.6 Host-loss runbook

```
 0–15 min   Confirm the host is gone, not merely unreachable.
            Post status. Set the maintenance page at Cloudflare.

15–45 min   Provision a new VPS, same region, same size.
            Run the committed provisioning script.

45–90 min   Restore PostgreSQL:
              fastest — promote the streaming replica
              otherwise — restore base + replay WAL to the latest point
            Verify row counts against the last known metrics.

90–120 min  Deploy the current release tag by digest.
            Point DNS at the new host (low TTL is kept for this reason).
            /healthz/deep, then a real login and a real payment read.

120+ min    Re-establish streaming replication and WAL archiving.
            THIS STEP IS NOT OPTIONAL — until it is done there is
            no financial RPO 0 and no PITR window.

After       Written post-incident note. Update this runbook where it was wrong.
```

The penultimate step is called out because it is the one that gets forgotten in
the relief of being back online, leaving the platform running unprotected for
days.

## 36.7 Data lifecycle on tenant exit

| Stage | Timing | State |
|---|---|---|
| Cancellation | Day 0 | Read-only, full export available |
| Grace | Days 0–60 | Data intact, reactivation possible |
| Export SLA | ≤ 72 h from request | Complete bundle ([§25.7](../phase-1b/25-data-import.md)) |
| Deletion | ≤ 30 days after grace | Rows and objects hard-deleted |
| Backup expiry | ≤ 12 months | Purged as backups age out |

Backups are the reason deletion is not instantaneous, and saying so plainly is
better than implying an immediacy the system cannot deliver. The published
commitment is: **live data deleted within 30 days, backup copies purged within 12
months.**
