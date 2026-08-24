# 2. Business and domain analysis

Architecture that does not come from the domain is decoration. This section is
the reasoning that the rest of Phase 1A is derived from.

> **Verification note.** Statements about Bangladeshi market structure, pricing
> and curriculum policy below are drawn from general knowledge and are marked
> where they carry real design weight. Anything tagged **[VERIFY]** should be
> confirmed against live market research before Phase 2 closes. None of them
> change the architecture; several change the roadmap.

## 2.1 Who actually buys this

The buyer is **the proprietor or principal of a private school**, not an IT
department. There is no CTO, no procurement process and no security
questionnaire. The decision is made by one person, often in a single meeting,
frequently on a phone.

That has four architectural consequences that outrank most of §5:

| Buyer reality | Consequence |
|---|---|
| No IT staff at the school | The product must be self-explanatory in Bangla and survive being configured wrongly. Every destructive action needs an undo or an audit trail. |
| Bought by one person, in one meeting | Onboarding must complete in days, not weeks. **Excel import is a sales requirement, not a feature.** |
| Low willingness to pay | Per-tenant fixed infrastructure cost must be near zero. This alone eliminates database-per-tenant. |
| Judged on visible artefacts | The report card PDF and the money receipt *are* the product to the buyer. They must be beautiful and typographically correct in Bangla. |

### Segments, in rough order of fit

| Segment | Size signal | Fit | Note |
|---|---|---|---|
| Private kindergarten / pre-primary | Very large, highly fragmented | **Best** | 80–400 students, one office computer, acute fee-tracking pain, no incumbent software |
| Private English-medium | Large in cities | **Good** | Higher ARPU, higher expectations, more likely to already have something |
| Private Bangla-medium primary/secondary | Large | **Good** | Price-sensitive; board exam and EIIN reporting matter |
| Madrasah (Alia / Qawmi) | Very large | **Deferred** | Different curriculum, different calendar, different grading. The configurable design accommodates it; the seed data does not, yet |
| Government primary | Very large | **No** | Procurement-driven, not a SaaS buyer |
| NGO school networks | Moderate | **Later** | Multi-campus organisation model fits well; long sales cycle |

**[VERIFY]** Segment sizes and the number of private kindergartens in the target
districts. The MVP cut assumes the kindergarten/primary segment is the entry
wedge; if it is not, the assessment engine's priority shifts from descriptive
toward marks-based sooner.

## 2.2 The four pains that actually sell

Ranked by what makes a principal change systems. Everything in §5 that is not on
this list is a retention feature, not an acquisition feature.

1. **"Who hasn't paid?"** Fee defaulters are tracked in a register or a
   spreadsheet, and arrears silently vanish when a student is promoted into next
   year's sheet. The system that answers *how much does this student owe, across
   all years, right now* wins the meeting.
2. **Result preparation.** Tabulation is done by hand on paper sheets and takes
   days to weeks per exam, with arithmetic errors that surface publicly. This is
   the single largest labour cost in a school office.
3. **Telling parents things.** SMS is the only channel that reliably reaches a
   Bangladeshi guardian. Absence alerts and result notifications are what
   guardians perceive as "the school is organised".
4. **Attendance registers.** Cheap to digitise, high daily visibility, and the
   data feeds pains 1 and 2.

Note the ordering against §5: **fees before results before attendance**, and
everything before timetable, library, transport or inventory.

## 2.3 The academic year drives the entire business

The Bangladeshi academic year runs **January to December**. This is not a
detail — it dictates the shape of the company.

```
Nov ──── Dec ──── Jan ──── … ──── Jun ──── … ──── Nov ──── Dec
 │        │        │                │                │       │
 admission│      session          half-yearly       annual  results,
 opens    │      starts            exam              exam   promotion
          └── ONBOARDING WINDOW ──┘
```

**A school switches software in November–January or not at all.** Nobody
migrates mid-session with half a year of marks and fee history in the old
system. That produces:

- A **sales cycle with one shot per year**, which makes missing a December
  deadline cost twelve months, not one.
- A **hard requirement on data import** — a school arriving in December brings
  Excel files and expects them loaded before January.
- The **seasonal load profile** in [§4](04-non-functional-requirements.md):
  write-heavy admission season, then two enormous read spikes on result
  publication days.

Ramadan and the two Eids move against the Gregorian calendar by roughly eleven
days a year, so the exam and vacation calendar shifts annually and is confirmed
only on moon sighting. This is the origin of the `provisional | confirmed`
holiday state in §5.16 — it is not an edge case, it happens twice a year, every
year, to every tenant.

## 2.4 The users and their devices

| Persona | Device reality | What they do daily | Design consequence |
|---|---|---|---|
| **Principal / proprietor** | Desktop in the office, plus a phone | Looks at collection totals and attendance summary | Dashboard must load fast and answer money questions first |
| **Office assistant / accountant** | The one shared office desktop | Enters 40–100 receipts a day, chases dues | Keyboard-first data entry. Mouse-driven forms are a tax paid a hundred times a day |
| **Class teacher** | Personal low-end Android, patchy data | Attendance every morning, marks after exams | **Must work offline and sync.** A failed attendance submission at 08:30 loses the record entirely |
| **Subject teacher** | Same | Bulk mark entry in bursts after exams | Spreadsheet-grade grid, paste from Excel, resumable |
| **Guardian** | Low-end Android, sometimes a feature phone; often semi-literate; frequently shares the handset | Reads SMS. Occasionally opens the portal | **SMS is the primary interface.** The portal is secondary and must be readable in Bangla at a glance |
| **Student (primary)** | None | Nothing | No login below a configurable class level |
| **Platform operator (you)** | Laptop | Onboards tenants, fixes data, answers calls | The support console is a first-class product surface, not an afterthought |

Two facts about guardians drive the identity model in
[§8](08-identity-authn-rbac.md) more than any security consideration:

- **One phone number is shared** between siblings, and often between both
  parents. A phone number therefore cannot be a unique key on a person.
- **A guardian at School A may be a teacher at School B**, and wants one login.
  Tenant-scoped user rows make that impossible without duplicate accounts.

## 2.5 Money moves in cash

**[VERIFY]** — but the design must hold either way.

Most fees in the target segment are collected **in cash at the office counter**,
recorded in a receipt book with a pre-printed serial number. Mobile financial
services are growing and bank deposit is common for larger amounts.

This has consequences the brief already half-anticipates:

- The **money receipt is a legal-feeling document**, and its number must be
  **gapless per school per fiscal year**. A missing serial is read as theft, not
  as a database quirk. Gaplessness forces serialised issuance — acceptable here
  because a school issues hundreds of receipts a day, not thousands a second.
- **Daily collection reconciliation** ("the drawer should hold ৳48,300 — does
  it?") is a core workflow, not a report.
- **Backdated entry must be permitted and audited.** The office will enter
  Saturday's receipts on Monday. Forbidding it means they keep the paper book
  and the software becomes decorative.
- An **online gateway is not required to sell the product**, which is why it sits
  behind cash recording in the MVP cut.

## 2.6 The ubiquitous language

Terms used consistently across all documents and, later, in code. Where a
Bangladeshi convention appears, it is **seed configuration**, never application
logic — per §4 of the brief.

| Term | Meaning here | Modelled as |
|---|---|---|
| **Organization** | An owner of one or more schools | Tenant parent, optional |
| **Tenant** | The unit of isolation and billing. Normally one school | `tenant` |
| **School** | An institution with an EIIN, a curriculum and a calendar | `school` |
| **Campus** | A physical site of a school | `campus` |
| **Shift** | Morning / day. Has its own timetable, calendar and often its own sections | `shift` — first-class, not an attribute |
| **Medium** | Bangla / English / other language of instruction | Configuration on class or section |
| **Academic year / session** | The Jan–Dec cycle. Almost every record is scoped to one | `academic_year` |
| **Class / grade** | Play, Nursery, KG, Class 1–10, or any tenant-defined name | `class_level`, ordered by `sequence` |
| **Section** | A subdivision of a class. The unit a teacher owns | `section` |
| **Roll number** | Position within a section, reassigned on promotion | Attribute of enrolment, **not** of student |
| **Enrolment** | A student's membership of one section in one academic year | `enrolment` — the join that history hangs from |
| **EIIN** | Government institution identification number | Attribute on `school` |
| **BANBEIS** | The statistics bureau schools report to | An export target |
| **NCTB** | The national curriculum and textbook board | Source of seedable curriculum data |
| **CQ / MCQ** | Creative question / multiple choice — separately marked, separately passed exam components | `assessment_component` |
| **Tabulation sheet** | The per-section grid of every subject result for an exam | A generated document |
| **GPA 5.0** | The conventional secondary grade-point scale | A row in `grade_scale` — **seed data, not logic** |
| **Testimonial / TC** | Character certificate / transfer certificate | Generated PDF documents |
| **Admit card** | Per-student exam entry document, often gated on fee clearance | Generated PDF |

### On grading — why this must be configuration

The conventional secondary scale (A+ = 5.00 at 80%, down to F below 33%) is
widely used but is **not universal across the target segment**. Kindergartens
grade descriptively. Primary education has moved between marks-based and
competency-based assessment under recent curriculum revisions, and policy in
this area has changed more than once **[VERIFY — current policy state]**. English-
medium schools frequently use their own letter scales.

A system that treats any one of these as *the* grading model will need code
changes per school. This is exactly the failure the brief warns about in §4, and
it is why [ADR-0012](../adr/0012-assessment-engine.md) makes the scale, the
components, the pass rules and the aggregation all data.

## 2.7 Competition and the switching cost

The realistic alternatives a principal is weighing:

| Alternative | Why they stay | Where it breaks |
|---|---|---|
| Paper registers and receipt books | Free, trusted, works in a power cut | Arrears vanish across years; tabulation takes weeks |
| Excel | Free, flexible, one person owns the file | No concurrency, no audit, no SMS, file lives on one machine |
| Local one-off desktop software | Already paid for, works offline | Single machine, no parent access, vendor often gone |
| A competing SaaS | Already migrated | The switching window is annual — displacement is expensive |

The realistic wedge is **paper and Excel**, not a competitor. That argues for
import fidelity and a familiar, register-like UI over feature breadth.

## 2.8 What the domain analysis changes in the architecture

| Domain fact | Architectural consequence |
|---|---|
| Low ARPU, price-sensitive buyer | Shared-schema tenancy; near-zero per-tenant fixed cost |
| One shared phone across siblings and parents | Global account with tenant memberships; phone not unique per person |
| Teacher on a low-end phone at 08:30 | Offline-capable attendance capture with a client-side queue |
| Fee arrears crossing academic years | Ledger keyed to student, not to enrolment; arrears carry forward as first-class records |
| Receipt serial must be gapless | Serialised issuance under a per-school row lock, inside the payment transaction |
| Eid dates confirmed late; closures declared retroactively | `provisional \| confirmed` holidays and a recompute path over already-recorded attendance |
| Every school grades differently | Assessment as versioned declarative configuration |
| Bangla report cards | Text-shaping-capable PDF pipeline chosen in Phase 1 |
| Onboarding window is Nov–Jan | Import is MVP; the seasonal load model has two distinct peaks |
| Nobody at the school can debug anything | Audit everything; make every state transition reversible by an operator |
