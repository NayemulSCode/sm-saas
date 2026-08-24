# 3. Functional requirements

Requirements are grouped by module and tagged with a release band. The bands are
the MVP cut from [§1](01-executive-summary.md) made specific.

| Band | Meaning |
|---|---|
| **M** | MVP. Required for the first paying school |
| **P2** | Phase 2. Deferred, but the data model and boundaries must not preclude it |
| **P3** | Phase 3+. Designed against only where it is nearly free to do so |
| **X** | Out of scope. Explicitly not designed for |

Requirement IDs are stable and referenced from the entity model and later phases.

---

## FR-1 Tenancy and platform (§5.1)

| ID | Requirement | Band |
|---|---|---|
| FR-1.1 | Provision a tenant with a slug, plan, locale and academic-year template in a single operator action | M |
| FR-1.2 | Every tenant-owned row carries `tenant_id`; cross-tenant reads are structurally impossible, not merely filtered | M |
| FR-1.3 | An organization may own several schools; org-level users see all of them, school-level users see one | M |
| FR-1.4 | Tenant lifecycle: `trial → active → past_due → suspended → cancelled → purged`, each transition audited | M |
| FR-1.5 | A suspended tenant retains read-only access and full data export. It is never silently deleted | M |
| FR-1.6 | Plan-driven feature flags evaluated server-side; the client never decides entitlement | M |
| FR-1.7 | Per-tenant branding: logo, colours, school name and address applied to app, SMS sender, PDFs | M |
| FR-1.8 | Subdomain routing `<slug>.<platform-domain>` | M |
| FR-1.9 | Custom domains with automated certificates | P2 |
| FR-1.10 | Offboarding: full export in an open format, then deletion against a published SLA | M |

**Note on FR-1.2.** "Structurally impossible" is the whole ballgame and is
specified in [§7](07-multi-tenancy.md) and [§10](10-database-architecture.md).
An application-layer `WHERE tenant_id = ?` convention is not sufficient; one
forgotten clause in one report query leaks another school's students.

---

## FR-2 Identity, authentication, RBAC (§5.4, §5.5, §5.23)

| ID | Requirement | Band |
|---|---|---|
| FR-2.1 | One login account may hold memberships in several tenants and several roles per tenant | M |
| FR-2.2 | Login by **phone or email**, whichever the account has. Neither is mandatory if the other exists | M |
| FR-2.3 | Phone-OTP login for guardians; password login for staff | M |
| FR-2.4 | A phone number may be shared by several *people*; it is unique only as a *login identifier* | M |
| FR-2.5 | After login, the account resolves to a list of contexts (tenant × role × person); a switcher selects one | M |
| FR-2.6 | Students below a configurable class level have no login at all | M |
| FR-2.7 | Roles are data: system roles are seeded, tenants may define custom roles from a fixed permission vocabulary | M |
| FR-2.8 | Permissions are `resource.action` pairs, additionally scoped by campus, class, section and subject | M |
| FR-2.9 | A teacher can read and write only their own sections and assigned subjects, enforced server-side | M |
| FR-2.10 | Bulk credential issuance for thousands of guardians at onboarding, without emailing passwords | M |
| FR-2.11 | MFA for platform operators and tenant owners | P2 |
| FR-2.12 | Account lockout, rate limiting, brute-force and enumeration protection on every credential endpoint | M |
| FR-2.13 | Duplicate-person detection and a reviewed merge across Bangla/English name variants | P2 |
| FR-2.14 | Full audit log of authentication events and permission changes | M |

---

## FR-3 School structure (§5.2, §5.6)

| ID | Requirement | Band |
|---|---|---|
| FR-3.1 | `Organization → School → Campus → Shift` with campus and shift optional but always present as a resolved default | M |
| FR-3.2 | Arbitrary class naming and ordering (`Play`, `Nursery`, `KG`, `Class 1`…) defined per tenant | M |
| FR-3.3 | Sections within a class, per shift, with a capacity and a class teacher | M |
| FR-3.4 | Medium and curriculum configurable at class or section level | M |
| FR-3.5 | Academic years with start/end dates; exactly one current year per school, others readable | M |
| FR-3.6 | Adding a new structural level later must not require a schema redesign | M |

---

## FR-4 Students, guardians, staff (§5.7, §5.8, §5.9)

| ID | Requirement | Band |
|---|---|---|
| FR-4.1 | Student lifecycle `applicant → admitted → active → on_leave → withdrawn → alumni`, every transition audited with actor, reason and timestamp | M |
| FR-4.2 | Enrolment links student to section for one academic year; history is preserved, never overwritten | M |
| FR-4.3 | Roll numbers are an attribute of enrolment and are reassigned on promotion | M |
| FR-4.4 | Student ID generation with a configurable per-school pattern | M |
| FR-4.5 | Documents: birth certificate, photo, previous transcripts, with type and expiry | M |
| FR-4.6 | Bulk promotion of a section with per-student exceptions (retain, transfer, withdraw) | M |
| FR-4.7 | Readmission of a returning student reuses the existing person record | P2 |
| FR-4.8 | Sibling linking, driving sibling discounts and SMS deduplication | M |
| FR-4.9 | Several guardians per student with relationship, and a designated **billing guardian** and **primary contact** | M |
| FR-4.10 | Per-guardian communication preferences, including suppressing a guardian from receiving messages | M |
| FR-4.11 | Staff profiles: designation, department, joining date, documents, subject and section assignments | M |
| FR-4.12 | ID card generation for students and staff | P2 |

**On FR-4.9.** Separated parents are common enough to design for, and getting it
wrong means sending a child's results to the wrong household. "Which guardian is
billed" and "which guardian is told" are **separate flags**, not one.

---

## FR-5 Academic calendar (§5.16)

| ID | Requirement | Band |
|---|---|---|
| FR-5.1 | Holiday categories are data. No holiday is hardcoded in schema or logic | M |
| FR-5.2 | A central government calendar, versioned per year, importable by any tenant | M |
| FR-5.3 | Inheritance `platform → organization → school → campus → class/section` with a documented precedence order | M |
| FR-5.4 | A school can **suppress** an inherited holiday, not merely add to it | M |
| FR-5.5 | Holidays carry `provisional \| confirmed`; confirming cascades to dependent recomputation | M |
| FR-5.6 | Weekly-off patterns are per school/campus/shift and effective-dated | M |
| FR-5.7 | A materialized **working-day table** per school/campus/shift/academic-year is the single source of truth | M |
| FR-5.8 | Retroactive holiday declaration reclassifies existing attendance, suspends late-fee accrual for those days, flags exam and timetable conflicts, and notifies — all auditable and reversible | M |
| FR-5.9 | Conflict rules are named, carry `block \| warn` severity, and are re-evaluated whenever the calendar changes | M |
| FR-5.10 | Recurrence via generated instances plus exception dates. **No RFC 5545 engine** | M |
| FR-5.11 | Calendar views: month, year, academic timeline, exam, holiday, event; filterable | M |
| FR-5.12 | Platform timezone fixed to `Asia/Dhaka`; holiday boundaries stored as `DATE` with optional time parts | M |

---

## FR-6 Attendance (§5.11)

| ID | Requirement | Band |
|---|---|---|
| FR-6.1 | Day-wise or period-wise capture, configurable per school | M |
| FR-6.2 | Statuses: present, absent, late, excused, half-day — extensible per tenant | M |
| FR-6.3 | Capture works offline; entries queue locally and sync when connectivity returns, with conflict resolution | M |
| FR-6.4 | Attendance can only be recorded on a working day, resolved from FR-5.7 | M |
| FR-6.5 | Corrections are new versioned records with actor and reason. Nothing is overwritten | M |
| FR-6.6 | Monthly and per-student summaries, exportable | M |
| FR-6.7 | Absence SMS to the primary contact, deduplicated across siblings, rate-limited and budget-capped | M |
| FR-6.8 | Biometric/RFID ingestion API with a reconciliation step | P2 |
| FR-6.9 | Staff attendance | P2 |

---

## FR-7 Assessment and examination (§5.12)

The highest-risk module. Design in [ADR-0012](../adr/0012-assessment-engine.md).

| ID | Requirement | Band |
|---|---|---|
| FR-7.1 | Marks-based and competency/rubric-based assessment coexist, potentially within one school | M |
| FR-7.2 | Per-subject components (CQ, MCQ, practical, viva, continuous assessment) each with full marks, weight and an **independent pass rule** | M |
| FR-7.3 | Grade scales are data: GPA points, letter grades, or pass/fail only | M |
| FR-7.4 | Optional/fourth-subject contribution rules expressed as configuration | M |
| FR-7.5 | `ENTERED`, `ABSENT`, `EXEMPT`, `INCOMPLETE` and an explicit zero are **distinct states**. Absent never silently becomes zero | M |
| FR-7.6 | Grace marks and moderation passes record reason, actor and approver | M |
| FR-7.7 | Mark entry lock/unlock, fully audited | M |
| FR-7.8 | Bulk mark entry: keyboard-driven grid, paste from spreadsheet, per-cell validation, resumable after connection loss | M |
| FR-7.9 | Tabulation sheet generation per section per exam | M |
| FR-7.10 | Position/merit ranking with explicit tie-break rules and configurable scope | M |
| FR-7.11 | Result publication is a controlled, reversible event with a per-audience access window | M |
| FR-7.12 | Post-publication revision produces a new result **version**; the prior version stays retrievable | M |
| FR-7.13 | Promotion rules: automatic or manual, carry-forward of failed subjects, minimum attendance | M |
| FR-7.14 | Per-school report card and marksheet layouts without code changes | M |
| FR-7.15 | Re-check request workflow | P2 |
| FR-7.16 | Exam schedule: subject, date, time, duration, room, invigilator, validated against the calendar | M |
| FR-7.17 | Admit card generation, optionally gated on fee clearance | M |

---

## FR-8 Fees and finance (§5.13)

| ID | Requirement | Band |
|---|---|---|
| FR-8.1 | All money as integer minor units. No floating point anywhere in the stack | M |
| FR-8.2 | Fee heads (tuition, admission, exam, transport, …) with per-class, per-section and per-student overrides | M |
| FR-8.3 | Scheduled fee generation per period, idempotent and re-runnable | M |
| FR-8.4 | **Gapless** receipt numbering per school per fiscal year | M |
| FR-8.5 | Channels: cash, bank deposit, cheque, mobile financial services, online gateway — each with its own reconciliation path | M |
| FR-8.6 | Partial payment with a configurable allocation order across outstanding heads | M |
| FR-8.7 | Arrears carry forward across academic years and survive promotion and transfer | M |
| FR-8.8 | Late-fee accrual (per day, per month or flat), waivable with approval and audit, suspended on non-working days | M |
| FR-8.9 | Discounts, scholarships and waivers with an approval workflow; sibling and staff-child discounts | M |
| FR-8.10 | Daily collection reconciliation per collector, with a deposit record | M |
| FR-8.11 | Backdated receipt entry, permitted and audited | M |
| FR-8.12 | Refunds and adjustments as reversing entries. **Nothing is ever deleted** | M |
| FR-8.13 | Defined treatment of outstanding dues on withdrawal, transfer and alumni transition | M |
| FR-8.14 | Online payment gateway behind a provider-agnostic interface | P2 |
| FR-8.15 | Idempotent webhook/IPN handling with replay protection and signature verification | P2 |
| FR-8.16 | Repair workflow for "money taken, callback lost" | P2 |
| FR-8.17 | Double-entry ledger | P3 — upgrade path documented in [§11](11-entity-model.md) |

---

## FR-9 Communication (§5.14, §5.18)

| ID | Requirement | Band |
|---|---|---|
| FR-9.1 | SMS through a provider-agnostic interface; at least two BD providers implemented | M |
| FR-9.2 | Bangla SMS is Unicode — segment counting and cost estimation shown **before** send | M |
| FR-9.3 | Per-tenant SMS credit balance, low-balance alert, hard cap and throttle | M |
| FR-9.4 | Deduplication when siblings share a guardian phone | M |
| FR-9.5 | Delivery-report ingestion and per-message status | M |
| FR-9.6 | Templates with variables, per language, versioned | M |
| FR-9.7 | Audience targeting by class, section, shift, status or individual | M |
| FR-9.8 | Opt-out handling and a suppression list | M |
| FR-9.9 | Notices and announcements in-app | M |
| FR-9.10 | Email as a secondary channel for staff | M |
| FR-9.11 | Web push | P2 |
| FR-9.12 | Scheduled and recurring campaigns | P2 |

**On FR-9.2.** A Bangla SMS segment is around 70 characters because it is UCS-2.
A three-segment template sent to 400 guardians costs three times what the author
assumed. Cost must be visible at authoring time or SMS spend becomes the tenant's
top complaint and the platform's top support burden.

---

## FR-10 Documents and PDF (§5.19)

| ID | Requirement | Band |
|---|---|---|
| FR-10.1 | Correct Bangla shaping: conjuncts, ya-phala, reph, matras. Verified by a golden-image test in CI | M |
| FR-10.2 | Bilingual documents: report card, marksheet, tabulation sheet, admit card, money receipt | M |
| FR-10.3 | Bangla and Latin numeral formatting, configurable per document | M |
| FR-10.4 | Per-school layout variation without code changes | M |
| FR-10.5 | Batch generation of hundreds of documents as a background job with progress | M |
| FR-10.6 | Generated artefacts stored, addressable and re-downloadable; retention policy defined | M |
| FR-10.7 | Certificates, transfer certificates, testimonials | P2 |

---

## FR-11 Data import and export (§5.20)

| ID | Requirement | Band |
|---|---|---|
| FR-11.1 | Templated Excel/CSV import for students, guardians, staff, fee structures and **opening dues** | M |
| FR-11.2 | Staging area with dry-run validation before commit | M |
| FR-11.3 | Row-level errors reported in the user's language, with the offending cell identified | M |
| FR-11.4 | All-or-nothing commit per import batch, with rollback | M |
| FR-11.5 | Duplicate detection across Bangla/English name variants and transliteration | M |
| FR-11.6 | Import audit trail: who imported what, when, and which rows | M |
| FR-11.7 | Full tenant export in an open format (CSV bundle + JSON manifest) | M |
| FR-11.8 | Historical results import | P2 |

**On FR-11.1.** "Opening dues" is the requirement that is always forgotten and
always blocks go-live. A school switching in December carries arrears from the
old system; without importing them, every fee report is wrong from day one.

---

## FR-12 Reports (§5.26)

| ID | Requirement | Band |
|---|---|---|
| FR-12.1 | Core reports: collection summary, outstanding dues, attendance summary, result summary, admission funnel | M |
| FR-12.2 | Server-side filtering, sorting and pagination on every list | M |
| FR-12.3 | Excel and PDF export | M |
| FR-12.4 | Long-running reports run as background jobs and notify on completion | M |
| FR-12.5 | Scheduled reports delivered by email/SMS | P2 |
| FR-12.6 | Per-tenant custom report definitions | P3 |

---

## FR-13 SaaS billing and operations (§5.24, §5.25)

| ID | Requirement | Band |
|---|---|---|
| FR-13.1 | Plans with feature flags and limits (students, SMS, storage) | M |
| FR-13.2 | Metering of active students per tenant per month, recorded off the hot write path | M |
| FR-13.3 | Trials, BDT invoicing, dunning, grace period, suspension and reactivation | M |
| FR-13.4 | Platform revenue is a **separate ledger** from school fee collection. They never share a table | M |
| FR-13.5 | Operator console: provisioning, plan changes, feature flags, per-tenant health and usage | M |
| FR-13.6 | Support impersonation with mandatory reason, time limit, full audit and **visibility to the tenant** | P2 |

---

## FR-14 Modules deferred in full

| Module | Band | Designed for? |
|---|---|---|
| Timetable/routine — manual entry with clash detection | M (detection only) | Auto-generation is P3 |
| Puck CMS and tenant public pages (§5.17) | P2 | Yes — content tables and routing anticipated |
| Library (§5.15) | P2 | Yes — entity sketch only |
| Inventory (§5.15) | P2 | Yes — entity sketch only |
| Transport routes and assignment (§5.15) | P2 | Yes — fee linkage anticipated |
| Live vehicle tracking | **X** | No |
| Payroll, hostel, alumni portal | **X** | No |
| Native mobile apps (§5.27) | **X** | PWA instead — see Phase 1B |
| Analytics warehouse (§5.26) | P3 | Yes — trigger metric in Phase 1C |
| Marketplace / plugins | **X** | No |

## Cross-cutting requirements

| ID | Requirement | Band |
|---|---|---|
| FR-X.1 | Every mutation records actor, tenant, timestamp, before/after and reason where applicable | M |
| FR-X.2 | Full UI, validation, notification, SMS and PDF localisation in `en` and `bn` | M |
| FR-X.3 | Adding a third language requires no schema change | M |
| FR-X.4 | WCAG 2.2 AA, including under tenant custom branding | M |
| FR-X.5 | Soft delete with restore on every tenant-owned entity; hard delete only through offboarding | M |
| FR-X.6 | Idempotency keys accepted on every money-moving and bulk endpoint | M |
| FR-X.7 | Light, dark and system theme | M |
