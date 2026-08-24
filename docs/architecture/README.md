# Architecture

Design documents for the multi-tenant School Management SaaS. Phase 1 produces
the architecture; Phase 2 the engineering specification; Phase 3 the
implementation. **No production code is written in Phase 1.**

## Phase 1A — Foundations (complete, awaiting review)

Read in order; each builds on the last.

| # | Document | Answers |
|---|---|---|
| — | [Constraints](CONSTRAINTS.md) | The §1 values every trade-off is argued against, with assumptions marked |
| 1 | [Executive summary](phase-1a/01-executive-summary.md) | The recommendation, the disagreements with the brief, the MVP cut |
| 2 | [Business and domain analysis](phase-1a/02-domain-analysis.md) | Who buys, what they pay for, how the academic year shapes the business |
| 3 | [Functional requirements](phase-1a/03-functional-requirements.md) | Every requirement, banded MVP / P2 / P3 / out of scope |
| 4 | [Non-functional requirements](phase-1a/04-non-functional-requirements.md) | The numbers: latency, availability, RPO/RTO, performance budgets |
| 5 | [Technology review](phase-1a/05-technology-review.md) | §11 verdicts, switching costs, the recommended stack |
| 6 | [Architecture overview](phase-1a/06-architecture-overview.md) | Context, containers, layering, request lifecycle, the seams |
| 7 | [Multi-tenant strategy](phase-1a/07-multi-tenancy.md) | The isolation guarantee and how it is proven in CI |
| 8 | [Identity, authentication, RBAC](phase-1a/08-identity-authn-rbac.md) | Shared phones, multi-tenant humans, permissions and scope |
| 9 | [Domain boundaries](phase-1a/09-domain-boundaries.md) | Module map, dependency direction, folder structure |
| 10 | [Database architecture](phase-1a/10-database-architecture.md) | Ids, money, Bangla collation, indexes, partitioning, migrations |
| 11 | [Entity model](phase-1a/11-entity-model.md) | Schema sketches for ~102 MVP tables |
| 12 | [ERD](phase-1a/12-erd.md) | Relationship fragments and the cardinalities people get wrong |
| 13 | [Open questions](phase-1a/13-open-questions.md) | Assumptions, what breaks if wrong, contradictions found in the brief |
| — | [ADR log](adr/README.md) | 16 decisions, each with a revisit trigger |

## Phase 1B — Domain and application (not started)

Module-by-module design, assessment and calendar engine detail, finance and
payment abstraction, notifications, API surface, frontend and component
strategy, Puck CMS, i18n, theming, PDF and Bangla typography, data import,
reporting data path, mobile/offline, accessibility.

## Phase 1C — Platform and operations (not started)

Files and media, queues, caching, scalability triggers, security, observability,
deployment, backup and DR, SaaS billing and tenant lifecycle, support console
and impersonation, testing, CI/CD, project structure, capacity and cost model,
risks, roadmap, and the consolidated architecture decision summary.

## Reading it quickly

If you have ten minutes: the [executive summary](phase-1a/01-executive-summary.md)
and the [ADR log](adr/README.md).

If you are reviewing the riskiest parts: [multi-tenancy](phase-1a/07-multi-tenancy.md)
§7.2, [ADR-0012](adr/0012-assessment-engine.md) on assessment, and
[§11.7](phase-1a/11-entity-model.md) on finance. Those three are where a mistake
is unrecoverable.

If you want to disagree with something: [open
questions](phase-1a/13-open-questions.md) lists what is assumed and what changes
if the assumption is wrong. Start there.
