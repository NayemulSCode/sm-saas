/**
 * Drizzle definitions for the identity tables (migrations 0004, 0006).
 *
 * SQL migrations are the source of truth; these mirror them for typed access.
 * `pnpm db:check` guards the two against drift.
 */

import { boolean, customType, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { instant, ulidCol } from '../types.js';
import type { Scope } from '../../shared/auth-context.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** Standard column set (§3.1), applied by app.make_tenant_table in SQL. */
const tenantColumns = {
  id: ulidCol('id').primaryKey(),
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
};

// ── global identity: no tenant_id, no RLS ───────────────────────────────────

/** Who logs in. Holds NO personal data — a breach here yields phone numbers
 *  and Argon2id hashes, not a single student record (§7.7). */
export const account = pgTable('account', {
  id: ulidCol<'account'>('id').primaryKey(),
  status: text('status', { enum: ['active', 'locked', 'disabled'] })
    .notNull()
    .default('active'),
  locale: text('locale', { enum: ['bn', 'en'] })
    .notNull()
    .default('bn'),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  mfaSecretEnc: bytea('mfa_secret_enc'),
  lastLoginAt: instant('last_login_at'),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: instant('locked_until'),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});

/**
 * One phone or email is ONE login, globally.
 *
 * A phone is unique as a LOGIN IDENTIFIER here, and non-unique as a CONTACT
 * DETAIL on `person`. Different columns, different tables, different meanings —
 * collapsing them breaks siblings, shared handsets and separated parents.
 */
export const credential = pgTable(
  'credential',
  {
    id: ulidCol<'credential'>('id').primaryKey(),
    accountId: ulidCol<'account'>('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['phone', 'email'] }).notNull(),
    value: text('value').notNull(),
    passwordHash: text('password_hash'), // NULL for OTP-only guardians
    verifiedAt: instant('verified_at'),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('credential_kind_value_key').on(t.kind, t.value),
    index('credential_account_idx').on(t.accountId),
  ],
);

/** Opaque server-side sessions, stored as sha256(token). Not JWTs: revocation
 *  must take effect within 60 s (NFR §4.6). */
export const session = pgTable(
  'session',
  {
    id: ulidCol<'session'>('id').primaryKey(),
    accountId: ulidCol<'account'>('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull(),
    activeMembershipId: ulidCol<'membership'>('active_membership_id'),
    issuedAt: instant('issued_at').notNull().defaultNow(),
    lastSeenAt: instant('last_seen_at').notNull().defaultNow(),
    expiresAt: instant('expires_at').notNull(),
    revokedAt: instant('revoked_at'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('session_account_idx').on(t.accountId)],
);

/** Hashed, single-use, rate-limited. One of only two tables ever hard-deleted. */
export const otpChallenge = pgTable(
  'otp_challenge',
  {
    id: ulidCol<'otpChallenge'>('id').primaryKey(),
    credentialId: ulidCol<'credential'>('credential_id')
      .notNull()
      .references(() => credential.id, { onDelete: 'cascade' }),
    codeHash: bytea('code_hash').notNull(),
    purpose: text('purpose', { enum: ['login', 'verify', 'reset', 'step_up'] }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: instant('expires_at').notNull(),
    consumedAt: instant('consumed_at'),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [index('otp_credential_idx').on(t.credentialId, t.createdAt)],
);

// ── tenant-scoped identity ──────────────────────────────────────────────────

/** The bridge: this account, in this tenant, acts as this person. */
export const membership = pgTable(
  'membership',
  {
    ...tenantColumns,
    accountId: ulidCol<'account'>('account_id').notNull(),
    personId: ulidCol<'person'>('person_id').notNull(),
    status: text('status', { enum: ['active', 'suspended'] })
      .notNull()
      .default('active'),
  },
  (t) => [
    index('membership_account_idx').on(t.accountId),
    index('membership_tenant_account_idx').on(t.tenantId, t.accountId),
  ],
);

export const role = pgTable(
  'role',
  {
    ...tenantColumns,
    code: text('code').notNull(),
    nameBn: text('name_bn').notNull(),
    nameEn: text('name_en').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
  },
  (t) => [uniqueIndex('role_code_unique').on(t.tenantId, t.code)],
);

export const rolePermission = pgTable(
  'role_permission',
  {
    ...tenantColumns,
    roleId: ulidCol<'role'>('role_id').notNull(),
    permissionKey: text('permission_key').notNull(),
  },
  (t) => [index('role_permission_role_idx').on(t.tenantId, t.roleId)],
);

export const membershipRole = pgTable(
  'membership_role',
  {
    ...tenantColumns,
    membershipId: ulidCol<'membership'>('membership_id').notNull(),
    roleId: ulidCol<'role'>('role_id').notNull(),
    /** Absent key = unrestricted within the tenant; present-but-empty denies. */
    scope: jsonb('scope').$type<Scope>().notNull().default({}),
  },
  (t) => [index('membership_role_membership_idx').on(t.tenantId, t.membershipId)],
);

/** Platform-scoped: the closed permission vocabulary, generated from code. */
export const permission = pgTable('permission', {
  key: text('key').primaryKey(),
  module: text('module').notNull(),
  descriptionBn: text('description_bn').notNull().default(''),
  descriptionEn: text('description_en').notNull().default(''),
  isDangerous: boolean('is_dangerous').notNull().default(false),
});
