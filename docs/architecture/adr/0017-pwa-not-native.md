# ADR-0017 — PWA, not native mobile apps

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1B

## Context

Guardians are the largest user group and are on low-end Android with
intermittent connectivity. Teachers need attendance and marks entry to survive
connection loss. The team is 1–2 developers.

## Options

### A. Native Android (+ iOS later)
Best offline capability and reliable push. Costs a second codebase, a release
process, store review latency, and a 30–60 MB download over a metered connection
before a guardian sees anything.

### B. PWA — installable web app, service worker, IndexedDB
One codebase, instant updates, zero install friction. Push is unreliable across
the target Android browsers, and storage is subject to eviction.

### C. React Native / Capacitor wrapper
One codebase in principle. In practice a third build target with its own
failure modes, and the offline work is identical either way.

## Decision

**B — PWA**, with offline capability built for **two flows only**: attendance
capture and marks entry ([§27](../phase-1b/27-mobile-offline.md)).

The deciding reason is install friction, not developer cost. A guardian checks
results twice a year; they will open an SMS link and they will not install an
app to do it. Requiring an install would put a Play Store account between the
school and the parent it is trying to reach.

The consequence is accepted deliberately: **push is unreliable, so SMS remains
the primary channel** ([§18](../phase-1b/18-notification-architecture.md)) rather
than a fallback. That is already true of this market for reasons unrelated to
technology.

## Consequences

**Makes easy:** one codebase; instant rollout of fixes; no store review between
a bug and its fix; entry from an SMS link straight to the relevant page.

**Makes hard:** no reliable push to guardians; storage can be evicted under
pressure, mitigated by requesting persistent storage and syncing promptly; no
access to device features such as a fingerprint reader or a camera-based ID
scanner beyond what the browser exposes.

**Forecloses:** nothing permanently. The API and domain layers are transport-
agnostic, so a native client later consumes the same `/api/v1`.

## Revisit when

- Guardian push becomes a required feature and SMS cost makes it economic —
  measure SMS spend against the cost of building and maintaining an app.
- Biometric attendance devices are integrated and a native bridge is genuinely
  needed rather than an ingestion API ([FR-6.8](../phase-1a/03-functional-requirements.md)).
- Measured PWA install-and-retention on target devices proves inadequate for the
  teacher flows.
