# ADR-0030 — Manual-first BDT billing, and suspension that never denies student records

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1C

## Context

The platform bills schools in BDT. There are no international card rails in this
market, schools pay by bank transfer and mobile financial services, and at launch
there are fewer than twenty tenants.

There is also a question that is not technical: **what may the platform withhold
from a school that has not paid?**

## Options

### A. Automated subscription billing from day one
Gateway integration, tokenised recurring charges, automatic dunning. Weeks of
work to save an hour a month at twenty tenants.

### B. Manual invoicing, reconciled against a bank statement
An hour of operator time per month at launch volume. Zero integration work.

### C. B now, automated later at a named trigger

## Decision

**C.** Invoices are generated automatically; **collection is reconciled manually**
until **>50 tenants, or reconciliation exceeding half a day per month.**

This is not a compromise. At twenty tenants, a monthly invoice run and a bank
statement is genuinely cheaper than the integration — and the integration is the
same provider abstraction the school-fee module needs anyway
([ADR-0020](0020-payment-provider-abstraction.md)), so building it later costs
nothing extra.

Supporting decisions:

| Decision | Detail |
|---|---|
| **Two ledgers, never one** | Platform revenue and school fee collection share no tables, sequences or reports. Mixing them makes both unauditable |
| Metering off the hot path | `active_students` counted by a nightly batch, never incremented per request |
| Billing on **end-of-period active students** | Trivially explainable to a principal, which is worth more than precision at this ARPU |
| Dunning is gentle | 30 days to suspension. A school office paying by bank transfer on its own rhythm was always going to pay; aggressive dunning costs more goodwill than the float is worth |
| Dunning pauses on an open billing ticket | Otherwise the system suspends a school actively trying to fix a mis-posted transfer |

### Suspension is read-only plus export — never data denial

The part of this decision that is not commercial:

| Capability when suspended | |
|---|---|
| Staff login, read students, attendance, marks | **Yes** |
| **Read published results and money receipts** | **Yes** |
| Full data export | **Yes** |
| Record anything, send SMS, generate documents | No |

A school in a billing dispute still has children whose parents need a report card
and whose transcripts may be requested a decade later. **Withholding a child's
record to force payment is not a lever this platform will pull.**

It is recorded as an ADR rather than a policy note so that it survives a future
commercial conversation in which withholding looks like an obvious lever. The
pressure that *is* applied — no new data in, no SMS out, a banner — is enough: a
school that cannot take attendance will pay or leave, and either is legitimate.

## Consequences

**Makes easy:** launching without a billing integration; explaining an invoice to
a principal; a defensible ethical position; reusing the fee-module payment
abstraction when automation arrives.

**Makes hard:** operator time grows linearly with tenants until the trigger fires
— which is exactly why the trigger is numeric. Suspension applies less commercial
pressure than a hard lockout would.

**Forecloses:** nothing technically.

## Revisit when

- **>50 tenants, or monthly reconciliation exceeds half a day** → automate
  collection through the existing provider abstraction.
- VAT treatment is settled ([OQ-1](../phase-1a/13-open-questions.md)) — the
  invoice template already carries a tax line that can be enabled without a
  schema change.
- A tenant requires invoicing terms the current model cannot express, such as
  annual prepayment or per-campus billing.
