/**
 * The standard tenant column set (§3.1), applied by `app.make_tenant_table` in
 * SQL and mirrored here.
 *
 * Generic in the brand so each table keeps its own `Id<T>` rather than
 * collapsing to `Id<string>` — which is what makes passing a StudentId where an
 * EnrolmentId belongs a compile error (ADR-0016).
 *
 * One definition, imported by every schema file. It was copied into two of them
 * before a third was about to be added; three copies of a column set that must
 * match a SQL function exactly is how they quietly stop matching.
 *
 * NOT for append-only tables — see src/db/schema/audit.ts and ADR-0033.
 */

import { integer, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { instant, ulidCol } from '../types';

export const tenantColumns = <T extends string>() => ({
  id: ulidCol<T>('id').primaryKey(),
  /** Defaulted by the database, but provisioning sets it explicitly: the
   *  platform role has no tenant session to read it from. */
  tenantId: ulidCol<'tenant'>('tenant_id')
    .notNull()
    .default(sql`app.current_tenant_id()`),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  createdBy: ulidCol<'person'>('created_by'),
  updatedBy: ulidCol<'person'>('updated_by'),
  deletedAt: instant('deleted_at'),
  deletedBy: ulidCol<'person'>('deleted_by'),
  deleteReason: text('delete_reason'),
  version: integer('version').notNull().default(1),
});
