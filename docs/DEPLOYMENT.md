# Deploying

The whole product runs on **one 8 GB / 4 vCPU VPS**. That is a deliberate
constraint, not a starting point to grow out of: two people with no dedicated
DevOps have to operate it at 02:00, and every component here was chosen against
that test ([CONSTRAINTS.md](architecture/CONSTRAINTS.md)).

## What exists and what does not

| | State |
|---|---|
| `Dockerfile`, `docker-compose.yml`, `Caddyfile` | Built, and CI builds the image on every push |
| `scripts/provision-host.sh` | Written, idempotent, **never run on a real host** |
| `scripts/deploy.sh` | Written, **never run on a real host** |
| `scripts/backup.sh` + `scripts/restore-drill.sh` | Written, and **CI runs both on every push** |
| A production host | **Does not exist.** Blocked — see below |
| WAL archiving to R2 | **Not configured.** `archive_command` is `/bin/true` |
| Streaming replica | **Does not exist.** Financial RPO is ~60 s, not 0 |

Everything in the first group is region-agnostic and could be pointed at a host
tomorrow. Everything in the second needs a decision or an account that does not
exist yet.

## What blocks the first real deploy

Two open questions from [EXTERNAL-ACTIONS.md](EXTERNAL-ACTIONS.md), neither of
which is an engineering task:

- **OQ-1 — data residency.** Whether Bangladeshi law requires student records to
  stay onshore decides between Hetzner EU, DO Singapore and a Dhaka provider.
  Provisioning a host before this is answered risks provisioning the wrong one
  and migrating a live database later.
- **OQ-11 — Dhaka → Singapore RTT.** Measured, not assumed. The difference
  between 60 ms and 180 ms is the difference between a teacher's attendance
  submit feeling instant and feeling broken.

A third, **OQ-5 (BTRC masked sender)**, does not block deployment but has the
longest lead of anything on the list and gates Phase 3b's SMS. It is worth
starting on the same day as the other two.

## The pieces

### The image

One image, three commands — `app`, `worker`, and the migration runner. Building
one rather than three means the code that runs a migration is byte-identical to
the code that serves the request afterwards, which is what stops "column does
not exist" in production.

It runs as the `node` user, uses `tini` as PID 1 so `docker stop` drains rather
than killing mid-request, and carries **no secrets**. The `ENV` values in the
build stage are placeholders that satisfy the env schema at build time; the real
ones come from the host's `env_file`. A secret baked into a layer is a secret in
every registry that ever holds the image.

### Memory limits are the critical control

Every container has an explicit `mem_limit`, and this is the single most
important line in `docker-compose.yml`. Without one, Chromium sizes its caches
to available host memory and expands until PostgreSQL starves — the most likely
way this host falls over ([§24.6](architecture/phase-1b/24-documents-pdf-bangla.md)).

The limits total 5.5 GB of 8 GB. The remainder is page cache, which PostgreSQL
depends on and which a tighter allocation would take away.

### Health probes

`/api/health/live` touches nothing external. A liveness probe that checks the
database restarts the application every time the database hiccups, turning a
thirty-second blip into a restart loop that outlasts it.

`/api/health/ready` checks the database **as the app role** — not the migrator,
because the question is whether the role serving requests can connect — and
returns **503** when it cannot. That is what stops a deploy shifting traffic to
a replica that cannot reach the database. CI asserts the 503 case.

## Running it

### 1. Provision the host

```bash
sudo ./scripts/provision-host.sh
```

Idempotent, so re-running it on a half-configured host is the way to find out
whether a step actually happened. It installs Docker, creates the deploy user,
locks the firewall to 22/80/443 — **PostgreSQL is never exposed**; an open 5432
on a public IP is found by a scanner within the hour — disables password SSH,
adds 2 GB of swap so a memory spike degrades into slowness rather than the OOM
killer choosing PostgreSQL, and writes a `chmod 600` root-owned `.env` for you
to fill in.

### 2. Deploy

```bash
./scripts/deploy.sh ghcr.io/you/sm-saas@sha256:abc123...
```

**A digest, not a tag.** A tag can be moved after it has been tested; a digest
cannot, so what was verified on staging is byte-identical to what runs in
production.

It refuses to run between **07:00 and 15:00 Asia/Dhaka** unless `FORCE=1`.
School hours are when attendance and fee collection happen: a five-second blip
then is a support call, and at 19:00 it is nothing.

Migrations run **before** the new code, and every migration must be backwards
compatible with the release before it. That is what makes rollback "deploy the
previous digest" rather than "restore a backup".

This is **low-downtime, not zero-downtime** — a few seconds during the app swap.
Genuine zero-downtime needs a second host and shared session state, which is a
stage-2 concern. The availability target is 99.5% in school hours, and this is
the honest way to hit it.

### 3. Verify by hand

A green health check only proves the process can reach the database. §35.3 step
5 asks for a **real login** on a real school subdomain, and then the error rate
for five minutes.

## Backups

```bash
./scripts/backup.sh
```

Custom-format `pg_dump`, verified readable by `pg_restore --list` before being
trusted — that is how a backup interrupted by a full disk is caught tonight
rather than at restore time — and rejected if suspiciously small, because an
empty dump is worse than no dump: it looks like one.

Backups go to a **different provider than the compute**. Hetzner or DO for the
host, Cloudflare R2 for the backups. A provider-level account problem should not
take the host and its backups at the same time. The R2 upload is the one part
not yet written, because the bucket does not exist.

### The restore drill is the part that matters

```bash
./scripts/restore-drill.sh backups/base-2027-03-14.dump
```

An untested backup is not a backup. This restores into a **throwaway database**
and verifies the result — it never touches the live one, because a drill that
could damage production is a drill nobody runs.

It checks more than "pg_restore exited zero", because a restore can succeed and
still produce something unusable:

- migrations applied, reference data present — a restore that loses the
  permission vocabulary produces a system where every authorised endpoint
  answers 403
- **every `tenant_id` table still has RLS enabled, forced, and a policy** — a
  restore that loses RLS has silently merged every school's data into one
  visible pool
- the audit tables are still append-only for `sm_app`
- actual rows, not just tables — a `--schema-only` dump restores perfectly and
  contains nobody's data

**CI runs this on every push.** Quarterly on a calendar is what §36 asks for;
every push is what makes it true, and it means restore drill #1 has already
happened many times before the first real one.

The drill prints its elapsed time. That is the *restore* only — it excludes
noticing the incident, deciding to restore, and repointing the app. The 4-hour
RTO covers all four.

## What is still missing before real data

In the order it becomes dangerous:

1. **WAL archiving to R2.** `archive_command` is `/bin/true`. Until it is real,
   the RPO is "last night's dump", not 60 seconds. This must be done **before**
   the host holds a single real student record.
2. **A streaming replica.** Financial RPO is 0 only because money-moving
   transactions wait for a standby — and there is no standby. Until there is,
   `synchronous_commit = remote_write` has nothing to wait for.
3. **Staging.** A migration that passes on an empty database and fails on real
   data is the normal case, not the exception. Staging is where that is caught,
   and it needs an anonymised production-shaped dump — which needs production.
4. **Monitoring.** No Prometheus, no Grafana, no alerting. The first time this
   host has a problem, the way you will find out is a phone call from a school.
