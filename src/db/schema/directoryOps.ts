/**
 * The two directory operations that must be undoable (migration 0013).
 *
 * An audit row says a promotion occurred; it does not let you put 40 children
 * back. These record what the operation DID.
 */
import { integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { instant, ulidCol } from '../types';
import { tenantColumns } from './columns';

export const promotionBatch = pgTable('promotion_batch', {
  ...tenantColumns<'promotionBatch'>(),
  sourceSectionId: ulidCol<'section'>('source_section_id').notNull(),
  fromYearId: ulidCol<'academicYear'>('from_year_id').notNull(),
  toYearId: ulidCol<'academicYear'>('to_year_id').notNull(),
  promoted: integer('promoted').notNull().default(0),
  retained: integer('retained').notNull().default(0),
  transferred: integer('transferred').notNull().default(0),
  withdrawn: integer('withdrawn').notNull().default(0),
  undoneAt: instant('undone_at'),
  undoReason: text('undo_reason'),
});

export const personMerge = pgTable('person_merge', {
  ...tenantColumns<'personMerge'>(),
  winnerPersonId: ulidCol<'person'>('winner_person_id').notNull(),
  loserPersonId: ulidCol<'person'>('loser_person_id').notNull(),
  /** Ids only — a repointing record, not a second copy of the data. */
  moved: jsonb('moved').notNull().default({}).$type<Record<string, string[]>>(),
  reason: text('reason').notNull(),
  reversedAt: instant('reversed_at'),
  reverseReason: text('reverse_reason'),
});
