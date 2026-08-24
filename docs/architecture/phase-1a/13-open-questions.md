# 13. Open questions and standing assumptions

Open questions are first-class, per §9 of the brief. Each one below states the
assumption being used in the meantime, what it affects, and **what changes if the
assumption turns out to be wrong**. Nothing here is blocking Phase 1A; three
items can invalidate decisions already taken and are marked **⚠ INVALIDATING**.

## 13.1 The three that can move the architecture

### OQ-1 ⚠ INVALIDATING — Data residency

> May student and guardian personal data be stored outside Bangladesh?

**Assumed:** yes, with a contractual commitment to the tenant.

**Affects:** [ADR-0002](../adr/0002-hosting-and-region.md) (Singapore hosting),
[ADR-0015](../adr/0015-object-storage.md) (Cloudflare R2), the entire cost model,
and the backup destination.

**If wrong:** hosting moves to a Bangladeshi datacentre. Compute cost rises,
managed services largely disappear, object storage becomes self-hosted MinIO
with durability as the team's problem, and backups need a second onshore
location. The tenancy model, identity model, schema and application architecture
are all unaffected — which is the point of keeping storage and hosting behind
interfaces. Budget roughly **2–4 weeks** of infrastructure work and a materially
higher monthly bill.

**How to close it:** a written opinion from a Bangladeshi lawyer familiar with
current data-protection legislation and any sector-specific rules for
educational institutions. This is the single highest-value question in the
document and should be asked in week one.

---

### OQ-2 ⚠ INVALIDATING — Real ARPU and price point

> What will a school in the target segment actually pay per month?

**Assumed:** ৳20/student/month, ~৳6,000/school/month, 300-student average.

**Affects:** the infrastructure ceiling, the tenancy decision
([ADR-0003](../adr/0003-tenancy-model.md)), and whether managed services are
affordable at all.

**If materially lower** (say ৳2,000/school/month), everything tightens: the
shared-schema decision becomes even more clearly correct, but the streaming
replica in [§4.5](04-non-functional-requirements.md) and paid tooling need
re-justification.

**If materially higher** (৳20,000+/school/month, plausible for larger
English-medium schools), managed Postgres and a hot standby become affordable
and [ADR-0002](../adr/0002-hosting-and-region.md) should be revisited — the
operational relief would be worth the money at this team size.

**How to close it:** five pricing conversations with real principals in the
target segment. Cheaper and faster than any architecture work.

---

### OQ-3 ⚠ INVALIDATING — Team availability over the build

> Is "1–2 developers" one full-time developer, two full-time, or two people
> also running an agency?

**Assumed:** approximately 1.5 full-time-equivalent developers, sustained.

**Affects:** the roadmap far more than the architecture, but it does affect the
architecture at the margin — at 0.5 FTE, even the MVP cut in
[§1](01-executive-summary.md) is too large and the product has to narrow to
fees plus SMS alone.

**If it is 0.5 FTE:** cut to a single-module product (fee collection and
receipts), ship that, and let it fund the rest. The architecture supports this —
the modules are already separable — but the MVP list must shrink by roughly half.

**How to close it:** a calendar, not a conversation.

## 13.2 Domain questions

| # | Question | Assumption | Affects | If wrong |
|---|---|---|---|---|
| OQ-4 | Current primary-level assessment policy: marks-based, competency-based, or both? | Both must be supported simultaneously | Assessment engine seed data | None architecturally — [ADR-0012](../adr/0012-assessment-engine.md) supports both by design. Only the default seed changes |
| OQ-5 | Which SMS aggregators, and what is the real BTRC masked-sender lead time? | 2–6 weeks, two providers integrated | Launch timeline, not architecture | If the lead time is months, onboarding must start before the product is finished. **Start this process in week one regardless** |
| OQ-6 | Do target schools need board-exam registration exports today? | No, not in MVP | Export module scope | Adds a P2 export target. Data model already carries EIIN and English names |
| OQ-7 | Is the fiscal year for receipt numbering the academic year (Jan–Dec) or the government fiscal year (Jul–Jun)? | **Configurable per school**, defaulting to academic year | `receipt_sequence` key | Already configurable — the assumption is only about the default |
| OQ-8 | Do any target schools run more than two shifts? | Two maximum, but modelled as N | `shift` cardinality | Already modelled as unbounded |
| OQ-9 | Madrasah curriculum and calendar differences | Out of MVP seed data | Segment reach | Configuration exists; only seed data and sales are affected |
| OQ-10 | How are student photos captured at onboarding? | Bulk upload of a named-file archive, matched to student codes | Import module | May need a mobile capture flow — a P2 addition |

## 13.3 Technical questions to close before Phase 2 ends

| # | Question | How to close it | Blocks |
|---|---|---|---|
| OQ-11 | Actual RTT Dhaka → Hetzner Singapore vs DO Singapore vs Hetzner EU | Measure. Rent an hour of each and run a real request pattern from a Dhaka connection | [ADR-0002](../adr/0002-hosting-and-region.md) region choice |
| ~~OQ-12~~ | ~~Does headless Chromium render Bangla conjuncts correctly with the pinned Noto build?~~ | **CLOSED 2026-08-24** — spike run, all five feature classes pass. See [`spikes/oq-12-bangla-shaping/`](../spikes/oq-12-bangla-shaping/README.md) | [ADR-0009](../adr/0009-pdf-rendering.md) **confirmed**, no engine change |
| ~~OQ-13~~ | ~~Chromium memory ceiling under a 500-document batch~~ | **CLOSED 2026-08-24** — 500 docs in 4.1 min, peak 958 MB, no leak. See [`spikes/oq-13-pdf-memory/`](../spikes/oq-13-pdf-memory/README.md) | Renderer **stays on the shared host**; needs a container memory limit, page recycling, and an 8 GB minimum VPS |
| OQ-14 | Real p95 for the tabulation query on a 400-student, 12-subject, 5-component exam | Synthetic data + `EXPLAIN ANALYZE` during Phase 2 | Whether results need precomputation beyond `result_snapshot` |
| OQ-15 | RLS planner behaviour: does `= ANY(app.current_tenant_ids())` use the index at scale? | `EXPLAIN` against a seeded 10 M-row `attendance` table | [ADR-0003](../adr/0003-tenancy-model.md) — falls back to a single-value GUC if not |
| OQ-16 | pg-boss throughput for a 20,000-message SMS fan-out on the target hardware | Load test | [ADR-0010](../adr/0010-job-queue.md) — BullMQ moves up if it fails |
| OQ-17 | Offline attendance sync conflict rules when two teachers mark the same section | Design decision in Phase 1B | Attendance module |
| OQ-18 | Service worker storage limits on the target low-end Android devices | Test on a real device | Offline strategy scope |

**OQ-12 is closed.** The spike was run on 2026-08-24: conjuncts, ya-phala, reph,
matra reordering and Bangla numerals all render correctly under Chromium with
Noto Bengali, verified against ZWNJ-forced controls. It also produced a measured
typographic rule — Bangla ascends ~23% higher than Latin, so `line-height: 1.0`
clips — and three font-shipping sub-decisions. Full report:
[`spikes/oq-12-bangla-shaping/`](../spikes/oq-12-bangla-shaping/README.md).

**OQ-13 is also closed.** Measured on 2026-08-24: 500 report cards render in 4.1
minutes against a 10-minute target, with no memory leak and a 958 MB peak. Page
recycling every 25 renders cuts peak memory 40% at no throughput cost. The
renderer stays on the shared host, subject to a hard container memory limit — and
the spike sets **8 GB as the minimum VPS size**, which is a direct input to the
Phase 1C cost model. Full report:
[`spikes/oq-13-pdf-memory/`](../spikes/oq-13-pdf-memory/README.md).

Both PDF-stack questions are now answered by measurement rather than assumption.
The remaining first-priority item is **[OQ-1](#oq-1--invalidating--data-residency)**,
data residency, which is a legal question and not one this team can close alone.

## 13.4 Product and commercial questions

| # | Question | Assumption |
|---|---|---|
| OQ-19 | Who performs tenant onboarding — the platform team or the school? | Platform team, hands-on, for the first ~20 schools |
| OQ-20 | Is SMS resold at a margin, bundled, or billed at cost? | Resold with a per-tenant credit balance and a hard cap |
| OQ-21 | What happens to a tenant that stops paying mid-academic-year? | Read-only plus export for 60 days, then suspension. Results and receipts stay retrievable — withholding a child's transcript over a vendor dispute is not acceptable |
| OQ-22 | Support hours and response commitment | Business hours Asia/Dhaka, next-business-day, no formal SLA at launch |
| OQ-23 | Is there an existing customer or design partner? | None assumed. **If one exists, the MVP cut should be re-derived from their workflow** |

OQ-23 is worth acting on immediately if the answer is yes. A single committed
design partner is worth more than any amount of speculative requirement
analysis, and would legitimately reorder the roadmap.

## 13.5 Contradictions found in the brief

Recorded here rather than silently resolved, per §9 of the brief.

| # | Contradiction | Resolution taken |
|---|---|---|
| C-1 | §5.4 says most guardians have no email; §5.23 requires email verification and §5.18 treats email as a channel | Phone and email are interchangeable credential kinds; verification applies to whichever exists. Email is staff-facing |
| C-2 | §5.29 asks for thousands of schools and millions of students; §1 imposes a cost ceiling that rules out that infrastructure | Schema modelled for millions, infrastructure provisioned for hundreds, every component carries a trigger metric |
| C-3 | §7 asks not to over-engineer; §5 lists fourteen modules plus a page builder | The MVP cut. Stated explicitly rather than quietly descoped |
| C-4 | §5.13 asks whether double-entry is warranted "now" while also requiring accounting rigour | Not now. Immutability plus reversing entries preserves the ability to derive a ledger later — [§11.7](11-entity-model.md) |
| C-5 | §5.16 requires recurrence but forbids an RFC 5545 engine | Generated instances plus exception dates, as the brief itself suggests. Agreed and adopted |
| C-6 | §14 orders scalability first; the same section says financial and examination correctness outranks everything | Reordered explicitly in [§1](01-executive-summary.md) with reasoning |

## 13.6 How to read the assumptions

Every assumption in this document is marked **ASSUMED** at its point of use and
listed here. None of them is load-bearing in the sense that discovering it is
wrong requires a redesign — that was a design goal, not luck. The three
invalidating questions in §13.1 change *infrastructure* and *scope*; they do not
change the tenancy model, the identity model, the module boundaries or the data
model, because those were derived from the domain rather than from the budget.
