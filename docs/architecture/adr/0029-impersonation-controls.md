# ADR-0029 — Impersonation is time-limited, reasoned, and visible to the tenant

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1C

## Context

Supporting a school means seeing what they see — which here means an operator
viewing real children's records. The brief calls impersonation privacy-sensitive
and asks for its controls to be specified explicitly. It is the most
privacy-sensitive capability in the platform.

There is also a commercial pull in the opposite direction: at 1–2 people,
impersonation is the fastest possible support tool, and every control added makes
support slower.

## Options

### A. No impersonation
Support runs on screen-sharing and exported diagnostics. Slowest, zero privacy
surface.

### B. Impersonation with internal audit only
Fast. The audit protects the **company** in a dispute; it does nothing for the
customer, who never learns it happened.

### C. Impersonation with mandatory reason, hard time limit, full audit, and
**notification to the tenant at the moment it starts**

## Decision

**C**, and impersonation is **deferred to Phase 2** — before it exists, support
runs on shared screens and exported diagnostics, which is slower but has no
privacy surface at all.

When it lands, these are the feature, not extras around it:

| Control | Rule |
|---|---|
| **Mandatory reason** | Free text, minimum length, recorded. Ideally a ticket reference |
| **Time limit** | 30 minutes maximum; extension requires a new reason |
| **Read-only by default** | Read-write needs a separate permission and a stronger reason |
| **Tenant notified at the start** | Not afterwards, not in a monthly digest — at the moment it begins |
| Tenant notified at the end | Duration and a summary of actions |
| **Tenant-readable log** | The owner can see every session, always, without asking |
| Every mutation tagged | `audit_log` records both the impersonated person and the real operator |
| Undismissable banner | The operator always knows they are impersonating |
| Cannot bulk-export or mass-download while impersonating | Those are separately-audited operator actions |
| Guardian accounts need elevated permission | A guardian view is one family's private data |
| Repeated impersonation of one tenant raises a review flag | Cooling-off signal |

Two of these carry the decision, and both are about the **tenant** rather than the
operator: **notification at the start** and **a log the tenant can read**.
Controls visible only internally protect the company; a tenant-visible log
protects the customer. The brief asks for tenant visibility explicitly and it is
the right requirement.

The tagging rule matters more than it looks: without it, "who changed this mark"
resolves to a teacher who was not at their desk that day.

## Consequences

**Makes easy:** genuine support without a privacy blind spot; a defensible answer
when a school asks "who looked at our data"; forensic reconstruction of any
operator action.

**Makes hard:** support is slower — a reason must be typed, a session expires
mid-investigation, and some tasks need a second operator's approval
([§38.4](../phase-1c/38-support-console.md)). That friction is the cost of the
capability, not a flaw in it.

**Forecloses:** silent operator access. Deliberately, permanently.

## Revisit when

- Support volume makes the 30-minute limit a genuine obstacle — shorten the
  investigation, or improve the diagnostics view, before loosening the control.
- A tenant contractually requires stricter terms, such as prior consent per
  session rather than notification.
- Regulation sets a specific standard for access to children's records
  ([OQ-1](../phase-1a/13-open-questions.md)).
