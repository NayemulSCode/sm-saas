# ADR-0019 — Three-way split of translatable text, with bilingual names as two real columns

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1B

## Context

Half the data in this system is authored in Bangla. The brief (§5.21) asks
explicitly which content is translated at the code level and which is stored per
tenant. Getting this wrong is expensive to reverse because it is a schema
decision, not a UI decision.

## Options

### A. Everything in message files
Works for UI strings. Cannot express a school's own name or a teacher's notice.

### B. Everything localised in the database as `jsonb` per field
Uniform and flexible. Applies a *translation* model to data that is not a
translation, and makes every query and index harder.

### C. Three mechanisms for three kinds of text
UI strings in message files; tenant content in paired per-language columns;
genuinely bilingual data in **two independently authoritative columns**.

## Decision

**C.**

| Kind | Mechanism | Example |
|---|---|---|
| UI strings | `next-intl` message files, namespaced per module | "Outstanding dues" |
| Tenant content | Paired nullable columns with a defined fallback | `holiday.title_bn` / `title_en` |
| **Bilingual data** | **Two `NOT NULL` columns, both authoritative** | `person.name_bn` / `name_en` |

The third row is the decision that matters. A student's Bangla name and English
name are **not translations of each other**: the report card prints one, the board
registration list needs the other, and neither is derivable from the other. A
localised field with locale fallback produces a Bangla report card that silently
prints an English name — a defect nobody notices in review and every parent
notices on the document.

Supporting rules fixed at the same time:

- Unicode **NFC normalisation on write**, without exception. Bangla conjuncts
  have multiple valid encodings; without it, identical-looking names do not
  compare equal, unique constraints do not constrain, and duplicate detection
  fails. Must be applied before any index is built.
- ICU plural rules, never `if (n === 1)`. Bangla plurals differ from English.
- Bangla numerals are a **rendering** preference, configurable per surface. Data
  entry and exports are always Latin digits, because a phone keypad emits Latin
  and money must not be ambiguous.
- Export CSV headers are English only — files are opened in Excel and re-imported.

## Consequences

**Makes easy:** correct bilingual documents; indexable, collatable name columns;
`pg_trgm` search per script; a third language added by migration rather than
redesign.

**Makes hard:** two columns to populate and validate on every person form; import
templates must accept both; UI must choose which to display per context. All
accepted — they are the actual domain requirement.

**Forecloses:** treating `name` as a single localised value. Deliberate.

## Revisit when

- A third language is added and the paired-column approach becomes unwieldy at
  more than three — a side table is then the migration, and the *bilingual name*
  decision does not change, because it is a domain fact rather than a
  localisation mechanism.
