# External actions register

**Four things the engineering work cannot produce.** They need a lawyer, five
sales conversations, a regulatory application and a measurement — not a
document. All four have long lead times, and
[roadmap §45.3](architecture/phase-1c/45-roadmap.md) places them in the
**September 2026** window, in parallel with Phase 2.

This is [§46.7 item 10](architecture/phase-1c/46-decision-summary.md) —
the one Phase 2 deliverable that stayed open, tracked here so it does not look
finished when it is not.

> Review this file at the start of every phase. Anything still `OPEN` past its
> "needed by" date is a schedule risk, not an admin task.

| # | Action | Needs | Started | Needed by | Status |
|---|---|---|---|---|---|
| **OQ-1** | Data-residency legal opinion | A Bangladeshi lawyer familiar with current data-protection law and any sector rules for schools | — | **Oct 2026** — before a production host is provisioned in Phase 3a | **OPEN** |
| **OQ-5** | BTRC masked-sender approval | Application via an SMS aggregator; confirm the current process and lead time | — | **Feb 2027** — Phase 3b, when SMS ships. **Start first: longest lead** | **OPEN** |
| **OQ-2** | Validate ARPU | Five pricing conversations with real principals in the target segment | — | **Sept 2026** — before the cost model is relied on commercially | **OPEN** |
| **OQ-11** | Dhaka → Singapore RTT | Rent an hour each on Hetzner SG, DO SG and Hetzner EU; run a real request pattern from a Dhaka connection | — | **Oct 2026** — confirms the region before the host is committed | **OPEN** |

## Why each one matters

### OQ-1 — data residency · highest impact

**The question:** may student and guardian personal data be stored outside
Bangladesh?

Two ADRs hang on the answer:
[ADR-0002](architecture/adr/0002-hosting-and-region.md) (Singapore hosting) and
[ADR-0015](architecture/adr/0015-object-storage.md) (Cloudflare R2). The cost
model says this is **the one scenario that threatens the infrastructure
ceiling** — onshore hosting takes infrastructure from ~$105/month to
~$250–320/month at 100 schools, or 15–19% of revenue at low ARPU
([§42](architecture/phase-1c/42-cost-model.md)).

**If the answer is "onshore only":** compute cost 2–3×, self-hosted object
storage instead of R2, a second onshore backup site, roughly 2–4 weeks of
infrastructure work. The tenancy model, identity model, schema and application
architecture are **unaffected** — that is why storage and hosting sit behind
interfaces.

**Why the deadline is October 2026:** Phase 3a ships deployment, CI and backups.
Provisioning a production host before this is answered risks doing it twice.

### OQ-5 — BTRC masked sender · longest lead

SMS is the primary channel for the largest user group
([§2.4](architecture/phase-1a/02-domain-analysis.md)), and a masked sender ID
needs regulatory approval that is obtained per provider. The lead time is
**unpredictable and outside the team's control**, which is the whole reason it
goes first.

Phase 1B already designs around a stall: **two providers behind one interface**,
so a tenant blocked on one provider's approval can ship on another
([§18.6](architecture/phase-1b/18-notification-architecture.md)). That mitigates
the risk; it does not remove the need to start.

**Start this in the first week of Phase 2, before the spec is finished.** It is
the only item here where waiting costs calendar time directly.

### OQ-2 — real ARPU

The whole cost model is argued against an **assumed** ৳20/student/month and
~৳6,000/school/month ([CONSTRAINTS.md](architecture/CONSTRAINTS.md)). Five
conversations is cheaper and faster than any architecture work, and it is the
input the commercial plan rests on.

The model survives a much lower figure — §42.5 tests ৳2,000/school/month — so
this is unlikely to invalidate the architecture. It changes what managed
services are affordable, and it changes the roadmap's viability.

### OQ-11 — measured latency

[ADR-0002](architecture/adr/0002-hosting-and-region.md) recommends Singapore over
EU on an **estimated** ~60–90 ms versus ~140–190 ms RTT. The reasoning is that
100 ms extra on every interactive request is paid repeatedly by an accountant
entering sixty receipts. That reasoning holds only if the estimates do.

A day's work with a real Dhaka connection either confirms the region or changes
it. Cheap, and it retires an assumption that a year of latency complaints would
otherwise surface the hard way.

## What is *not* blocked by these

Worth stating, so the register does not become an excuse to stall:

| Work | Blocked? |
|---|---|
| Phase 2B and 2C engineering spec | **No** |
| Phase 3a: tenancy, RLS, identity, structure, directory | **No** — schema and application design are residency-independent |
| Local development and CI | **No** |
| Phase 3a *production host provisioning* | **Yes, by OQ-1 and OQ-11** |
| Phase 3b *SMS go-live* | **Yes, by OQ-5** |
| Commercial pricing commitments | **Yes, by OQ-2** |

Only two dated milestones actually depend on this register. Everything else
proceeds.

## Keeping it current

Fill in **Started** when work begins and change **Status** to `IN PROGRESS`.
When an item closes, record the answer and the date, mark it `CLOSED`, and update
the ADR or document it affects — the same discipline used for
[OQ-12](architecture/spikes/oq-12-bangla-shaping/README.md) and
[OQ-13](architecture/spikes/oq-13-pdf-memory/README.md), both of which were closed by running
the experiment and then propagating the result.
