/** Platform-scoped tables (migration 0003). No tenant_id, no RLS. */
import { boolean, char, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { instant, moneyMinor, ulidCol } from '../types.js';

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
