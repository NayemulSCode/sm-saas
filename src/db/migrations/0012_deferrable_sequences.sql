-- 0012 — make the ordering constraints deferrable.
--
-- THE PROBLEM
--
-- `class_level.sequence` carries promotion order (§14.4), and reordering means
-- swapping values inside one transaction. `UNIQUE (tenant_id, school_id,
-- sequence)` is checked per ROW as each UPDATE lands, so the obvious statement:
--
--     UPDATE class_level SET sequence = v.seq FROM (VALUES …) v WHERE …
--
-- fails the moment two rows exchange sequences, because the intermediate state
-- has a duplicate even though the final state does not.
--
-- THE ALTERNATIVES
--
-- The usual workaround is a two-phase update: move every row to a temporary
-- offset, then to its target. It works, needs no migration, and writes every
-- row twice — and it leaves behind code that reads like a puzzle. Somebody at
-- 02:00 will "simplify" it back into a single statement and discover why it was
-- not one.
--
-- A DEFERRABLE constraint says the same thing declaratively: the invariant must
-- hold at COMMIT, not between two statements inside one transaction. It is a
-- standard PostgreSQL feature and the application code becomes ordinary.
--
-- INITIALLY IMMEDIATE, so nothing changes for any other caller: only a
-- transaction that explicitly runs SET CONSTRAINTS … DEFERRED gets the relaxed
-- behaviour, and the invariant is still enforced at commit for everyone.

SET lock_timeout = '3s';
SET statement_timeout = '5min';

ALTER TABLE class_level DROP CONSTRAINT class_level_sequence_unique;
ALTER TABLE class_level
  ADD CONSTRAINT class_level_sequence_unique
  UNIQUE (tenant_id, school_id, sequence) DEFERRABLE INITIALLY IMMEDIATE;

-- Shifts order the same way and will need the same treatment the first time a
-- school reorders morning and day. Done here so the two do not diverge.
ALTER TABLE shift DROP CONSTRAINT shift_sequence_unique;
ALTER TABLE shift
  ADD CONSTRAINT shift_sequence_unique
  UNIQUE (tenant_id, campus_id, sequence) DEFERRABLE INITIALLY IMMEDIATE;

-- Terms are ordered within an academic year for the same reason.
ALTER TABLE term DROP CONSTRAINT term_sequence_unique;
ALTER TABLE term
  ADD CONSTRAINT term_sequence_unique
  UNIQUE (tenant_id, academic_year_id, sequence) DEFERRABLE INITIALLY IMMEDIATE;

/*
 * Two academic years must not cover the same day.
 *
 * "Which year does 2027-03-14 belong to?" is asked by attendance, results and
 * fee collection, and it must have exactly one answer. The application checks
 * this too, with a clear error message — but an application check is a race
 * between two concurrent opens, and this one is not.
 *
 * btree_gist lets a plain equality column (school_id) sit in the same exclusion
 * constraint as a range. daterange is inclusive-exclusive, so end_date + 1 day
 * makes the stored inclusive end behave correctly.
 */
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE academic_year
  ADD CONSTRAINT academic_year_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    school_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (deleted_at IS NULL);
