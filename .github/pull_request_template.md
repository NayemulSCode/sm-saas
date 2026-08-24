## What this changes

<!-- One paragraph. What behaviour is different after this merges? -->

## Why

<!-- The problem, not the solution. Link the ADR if this implements or changes one. -->

## Architecture conformance

- [ ] Matches the approved design in `docs/architecture/` — or updates it in this PR
- [ ] No new cross-module import that breaks the boundaries in `09-domain-boundaries.md`
- [ ] Any decision that differs from an ADR is recorded as a new superseding ADR

## Multi-tenancy and data safety

- [ ] Every new table carries `tenant_id` and has RLS enabled, **or** is
      documented as platform-scoped in `10-database-architecture.md`
- [ ] No query bypasses the tenant session context
- [ ] No tenant PII in logs, error messages or analytics payloads
- [ ] Money handled as integer minor units — no floats, no `double precision`

## Verification

<!-- What did you actually run? Paste the command and the result. "Tested locally"
     is not a verification step. -->

## Rollback

<!-- If this breaks in production, what undoes it? Note any migration that is
     not backwards compatible with the previous release. -->
