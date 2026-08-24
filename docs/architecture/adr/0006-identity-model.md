# ADR-0006 — Global login account, tenant-scoped person, membership between them

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1A

## Context

Five facts from §5.4 of the brief break the conventional tenant-scoped user
model: guardians have no email, one phone is shared between siblings and between
parents, one human holds roles in several tenants, a guardian needs one login
across several children, and young students have no login at all.
Detail in [§8](../phase-1a/08-identity-authn-rbac.md).

## Options

### A. Tenant-scoped `user` keyed by phone
Simplest, and RLS covers everything. Fails immediately: two parents sharing a
handset become one indistinguishable user, and a teacher-at-A/parent-at-B needs
two logins with two passwords.

### B. Global `user` holding personal data, with tenant roles attached
Solves cross-tenant login. Puts names, dates of birth and contact details in a
table outside RLS — the largest privacy surface in the system, holding data
about children.

### C. Global `account` for credentials only, tenant-scoped `person` for the
human, `membership` joining them
One account may map to several persons across several tenants. All personal data
stays behind RLS. Costs an extra join on every context resolution and makes
"who is this?" a two-step question.

## Decision

**C.**

`account` holds a status and nothing personal. `credential` holds `(kind, value)`
— phone or email — unique **globally**, because a phone identifies a *login*.
`person` is tenant-scoped and holds every personal attribute. `membership` binds
account × tenant × person and carries the roles.

The deciding reason is stated as a rule: **a phone number is unique as a login
identifier and non-unique as a contact detail.** Those are different columns in
different tables. Every design that fails here has collapsed them into one.

The privacy consequence is deliberate: a breach of the only non-RLS table yields
a list of phone numbers and Argon2id hashes, not a single student record.

## Consequences

**Makes easy:** one login across schools; a guardian seeing several children; a
teacher who is also a parent; shared handsets; students with no login at all;
and keeping all child data behind row-level security.

**Makes hard:** context resolution is a join, and every session must carry an
*active* context. Person merging (§8.6) is genuinely intricate. "Delete this
user" becomes two questions — remove the membership, or delete the person —
which is correct but must be explained in the UI.

**Forecloses:** treating email as the primary identifier. Deliberate.

## Revisit when

- A tenant requires SSO against their own directory — an additional credential
  kind, which this model already accommodates.
- Cross-tenant person identity is ever needed for a legitimate product reason,
  e.g. a national student ID. That would add a global link table, not change
  this model.
