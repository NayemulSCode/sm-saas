/** Platform-scoped tables (migration 0003). No tenant_id, no RLS. */
import { boolean, char, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { instant, moneyMinor, ulidCol } from '../types';

export const plan = pgTable('plan', {
  id: ulidCol<'plan'>('id').primaryKey(),
  code: text('code').notNull(),
  nameBn: text('name_bn').notNull(),
  nameEn: text('name_en').notNull(),
  priceMinor: moneyMinor('price_minor').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('BDT'),
  billingPeriod: text('billing_period', { enum: ['monthly', 'annual'] }).notNull(),
  isPublic: boolean('is_public').notNull().default(true),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});

export const tenant = pgTable('tenant', {
  id: ulidCol<'tenant'>('id').primaryKey(),
  organizationId: ulidCol<'organization'>('organization_id'),
  slug: text('slug').notNull(),
  nameBn: text('name_bn').notNull(),
  nameEn: text('name_en').notNull(),
  status: text('status', {
    enum: ['trial', 'active', 'past_due', 'suspended', 'cancelled', 'purged'],
  })
    .notNull()
    .default('trial'),
  planId: ulidCol<'plan'>('plan_id').notNull(),
  /** Always 'primary' today — the indirection that lets one large tenant move
   *  to its own database later without touching call sites (§7.6). */
  shardId: text('shard_id').notNull().default('primary'),
  localeDefault: text('locale_default', { enum: ['bn', 'en'] }).notNull().default('bn'),
  timezone: text('timezone').notNull().default('Asia/Dhaka'),
  numerals: text('numerals', { enum: ['bn', 'latin'] }).notNull().default('bn'),
  branding: jsonb('branding').notNull().default({}),
  trialEndsAt: instant('trial_ends_at'),
  suspendedAt: instant('suspended_at'),
  purgeAfter: instant('purge_after'),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});

/**
 * Roles copied into each tenant at provisioning.
 *
 * Templates live OUTSIDE the tenant model rather than as `role` rows with a
 * NULL tenant_id: a NULL matches no RLS policy, so such a row would be
 * invisible to everyone including the tenant that needs it (§3.3).
 */
export const roleTemplate = pgTable('role_template', {
  code: text('code').primaryKey(),
  nameBn: text('name_bn').notNull(),
  nameEn: text('name_en').notNull(),
  /** Permission keys. Seeded from src/shared/permissions.ts by `pnpm seed`. */
  permissions: text('permissions').array().notNull(),
  sequence: integer('sequence').notNull().default(0),
});
