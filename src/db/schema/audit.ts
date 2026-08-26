/**
 * The audit trail (migration 0011). Both tables are APPEND-ONLY.
 *
 * There is no `update` or `delete` helper anywhere for these, and the app role
 * lacks the privilege, so an attempt fails at the database rather than at
 * review time.
 */
import { pgTable, text, jsonb, index, customType } from 'drizzle-orm/pg-core';
import { instant, ulidCol } from '../types';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
/** `inet`. Stored as text at the language boundary; PostgreSQL validates it. */
const inet = customType<{ data: string; driverData: string }>({ dataType: () => 'inet' });

/**
 * Global authentication trail. Deliberately has NO tenant_id — authentication
 * happens before a tenant is known, and a nullable tenant_id would punch a
 * hole in RLS (ADR-0033).
 */
export const authEvent = pgTable(
  'auth_event',
  {
    id: ulidCol<'authEvent'>('id').primaryKey(),
    at: instant('at').notNull().defaultNow(),
    type: text('type').notNull(),
    outcome: text('outcome').notNull().$type<'success' | 'failure'>(),

    accountId: ulidCol<'account'>('account_id'),
    credentialId: ulidCol<'credential'>('credential_id'),
    sessionId: ulidCol<'session'>('session_id'),

    /** Hashed: the identifier is a phone number or an email, so it is PII. */
    identifierHash: bytea('identifier_hash'),

    reason: text('reason'),
    requestId: text('request_id').notNull(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    detail: jsonb('detail').notNull().default({}).$type<Record<string, unknown>>(),
  },
  (t) => [
    index('auth_event_account_idx').on(t.accountId, t.at),
    index('auth_event_at_idx').on(t.at),
    index('auth_event_identifier_idx').on(t.identifierHash, t.at),
  ],
);

/** Every tenant-scoped mutation. Tenant-owned, RLS enforced. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: ulidCol<'auditLog'>('id').primaryKey(),
    tenantId: ulidCol<'tenant'>('tenant_id').notNull(),
    at: instant('at').notNull().defaultNow(),

    actorPersonId: ulidCol<'person'>('actor_person_id'),
    actorAccountId: ulidCol<'account'>('actor_account_id'),

    entityType: text('entity_type').notNull(),
    entityId: ulidCol<string>('entity_id').notNull(),
    action: text('action').notNull(),

    /** Ids and changed field names only — invariant 12. See db/audit.ts. */
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),

    reason: text('reason'),
    requestId: text('request_id').notNull(),
    impersonatedBy: ulidCol<'account'>('impersonated_by'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.tenantId, t.entityType, t.entityId, t.at),
    index('audit_log_at_idx').on(t.tenantId, t.at),
  ],
);
