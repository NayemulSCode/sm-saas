/** Staff invitations (migration 0010). Tenant-owned, RLS enforced. */
import { integer, pgTable, text, customType, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { instant, ulidCol } from '../types';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const staffInvite = pgTable(
  'staff_invite',
  {
    id: ulidCol<'staffInvite'>('id').primaryKey(),
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

    accountId: ulidCol<'account'>('account_id').notNull(),
    credentialId: ulidCol<'credential'>('credential_id').notNull(),
    membershipId: ulidCol<'membership'>('membership_id').notNull(),
    personId: ulidCol<'person'>('person_id').notNull(),
    /** Hashed at rest: a leak of this table must not yield usable links. */
    tokenHash: bytea('token_hash').notNull(),
    expiresAt: instant('expires_at').notNull(),
    consumedAt: instant('consumed_at'),
    revokedAt: instant('revoked_at'),
    revokeReason: text('revoke_reason'),
    invitedBy: ulidCol<'person'>('invited_by'),
  },
  (t) => [
    uniqueIndex('staff_invite_token_idx').on(t.tokenHash),
    index('staff_invite_account_idx').on(t.tenantId, t.accountId),
  ],
);
