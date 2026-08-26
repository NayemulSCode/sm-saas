-- 0013 — the two directory operations that must be undoable.
--
-- §14.5 calls `promoteSection` "the riskiest bulk operation in the product". It
-- rewrites a whole cohort's enrolment, and "undo the promotion, we ran it on
-- the wrong section" has to be a supported operation rather than a restore from
-- backup at 02:00. `mergePersons` is the same shape: it repoints every
-- reference from one person to another, and the spec says it is reversible.
--
-- Both need a record of WHAT THEY DID, not merely that they happened. An audit
-- row says a promotion occurred; it does not let you put 40 children back.

SET lock_timeout = '3s';
SET statement_timeout = '5min';

-- ── promotion batches ───────────────────────────────────────────────────────

CREATE TABLE promotion_batch (
  id                uuid PRIMARY KEY,
  source_section_id uuid NOT NULL,
  from_year_id      uuid NOT NULL,
  to_year_id        uuid NOT NULL,
  -- Counts, for the confirmation screen and for the audit trail. The rows
  -- themselves are found through enrolment.promotion_batch_id.
  promoted          integer NOT NULL DEFAULT 0,
  retained          integer NOT NULL DEFAULT 0,
  transferred       integer NOT NULL DEFAULT 0,
  withdrawn         integer NOT NULL DEFAULT 0,
  undone_at         timestamptz,
  undo_reason       text,
  CONSTRAINT promotion_batch_undo_has_reason
    CHECK (undone_at IS NULL OR undo_reason IS NOT NULL)
);
SELECT app.make_tenant_table('promotion_batch');

CREATE INDEX promotion_batch_section_idx
  ON promotion_batch (tenant_id, source_section_id, from_year_id);

SELECT app.tenantize_fk('promotion_batch', 'source_section_id', 'section');
SELECT app.tenantize_fk('promotion_batch', 'from_year_id', 'academic_year');
SELECT app.tenantize_fk('promotion_batch', 'to_year_id',   'academic_year');

/*
 * Which batch CREATED this enrolment.
 *
 * Undo needs to find exactly the rows one run produced. Deriving them from
 * (section, year) would also catch students enrolled by hand afterwards, and
 * removing those is precisely the accident undo exists to avoid.
 */
ALTER TABLE enrolment ADD COLUMN promotion_batch_id uuid;
SELECT app.tenantize_fk('enrolment', 'promotion_batch_id', 'promotion_batch');
CREATE INDEX enrolment_batch_idx ON enrolment (tenant_id, promotion_batch_id)
  WHERE promotion_batch_id IS NOT NULL;

-- ── person merges ───────────────────────────────────────────────────────────

/*
 * `person.merged_into_person_id` already records that a merge happened. This
 * records what MOVED, which is what reversing needs — and `student.merge` is a
 * dangerous permission precisely because getting it wrong fuses two children's
 * records together.
 */
CREATE TABLE person_merge (
  id               uuid PRIMARY KEY,
  winner_person_id uuid NOT NULL,
  loser_person_id  uuid NOT NULL,
  -- { students: [...ids], guardianLinks: [...ids], staff: [...ids] } — ids
  -- only, so this is a repointing record and not a second copy of the data.
  moved            jsonb NOT NULL DEFAULT '{}'::jsonb
                     CHECK (jsonb_typeof(moved) = 'object'),
  reason           text NOT NULL,
  reversed_at      timestamptz,
  reverse_reason   text,
  CONSTRAINT person_merge_not_self CHECK (winner_person_id <> loser_person_id),
  CONSTRAINT person_merge_reverse_has_reason
    CHECK (reversed_at IS NULL OR reverse_reason IS NOT NULL)
);
SELECT app.make_tenant_table('person_merge');

-- A person may lose only one merge that is still in force. Merging the same
-- loser twice would make the first reversal put rows back on a person who has
-- since moved on again.
CREATE UNIQUE INDEX person_merge_one_live_idx
  ON person_merge (tenant_id, loser_person_id)
  WHERE reversed_at IS NULL AND deleted_at IS NULL;

CREATE INDEX person_merge_winner_idx ON person_merge (tenant_id, winner_person_id);

SELECT app.tenantize_fk('person_merge', 'winner_person_id', 'person');
SELECT app.tenantize_fk('person_merge', 'loser_person_id',  'person');
