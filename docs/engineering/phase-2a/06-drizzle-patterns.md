# 6. Drizzle patterns

How the DDL in §3–4 becomes typed TypeScript, and the query conventions that keep
invariants 2, 11 and 15 true in application code.

Drizzle was chosen over Prisma for RLS session variables, partitioning and memory
([ADR-0005](../../architecture/adr/0005-orm.md)). Migrations are hand-written
SQL; `drizzle-kit` is used to *check* drift, never to generate production
migrations.

## 6.1 Custom column types

Three custom types remove three whole bug classes at the type level.

```ts
// src/db/types.ts

/** Money — bigint minor units. Mode 'bigint', NEVER 'number'. */
export const moneyMinor = (name: string) =>
  bigint(name, { mode: 'bigint' });

/** LocalDate ↔ date. Drizzle's default `date` mode returns a JS Date, which
 *  reintroduces the timezone bug this type exists to prevent. */
export const localDate = customType<{ data: LocalDate; driverData: string }>({
  dataType: () => 'date',
  toDriver:   (d) => LocalDate.toISO(d),
  fromDriver: (s) => LocalDate.parse(s).value,
});

/** Branded ULID stored as uuid. */
export const ulid = <T extends string>(name: string) =>
  uuid(name).$type<Id<T>>();

/** Instants. `timestamp without time zone` is banned — lint enforces it. */
export const instant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });
```

`moneyMinor` returning `bigint` means an accidental `amount / 100` is a
TypeScript error (`bigint` and `number` do not mix), which is the point.

## 6.2 The standard column mixin

```ts
// src/db/schema/_shared.ts
export const tenantColumns = {
  id:        ulid('id').primaryKey(),
  tenantId:  ulid<'tenant'>('tenant_id').notNull()
               .default(sql`app.current_tenant_id()`),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  createdBy: ulid<'person'>('created_by'),
  updatedBy: ulid<'person'>('updated_by'),
  deletedAt: instant('deleted_at'),
  deletedBy: ulid<'person'>('deleted_by'),
  deleteReason: text('delete_reason'),
  version:   integer('version').notNull().default(1),
};
```

```ts
// src/db/schema/directory.ts
export const enrolment = pgTable('enrolment', {
  ...tenantColumns,
  studentId:      ulid<'student'>('student_id').notNull().references(() => student.id),
  sectionId:      ulid<'section'>('section_id').notNull().references(() => section.id),
  academicYearId: ulid<'academicYear'>('academic_year_id').notNull(),
  rollNo:         integer('roll_no'),
  enrolledOn:     localDate('enrolled_on').notNull(),
  leftOn:         localDate('left_on'),
  outcome:        text('outcome', {
                    enum: ['promoted','retained','transferred','withdrawn'] }),
}, (t) => ({
  // Invariant 11: every index leads with tenant_id.
  bySection: index().on(t.tenantId, t.sectionId, t.academicYearId),
  byStudent: index().on(t.tenantId, t.studentId),
  uniqRoll: uniqueIndex().on(t.tenantId, t.sectionId, t.academicYearId, t.rollNo)
              .where(sql`deleted_at IS NULL AND roll_no IS NOT NULL`),
  uniqYear: uniqueIndex().on(t.tenantId, t.studentId, t.academicYearId)
              .where(sql`deleted_at IS NULL`),
}));
```

Schema files mirror module ownership: `platform.ts`, `identity.ts`,
`structure.ts`, `directory.ts`. A module's repositories import only its own
schema file plus what it legitimately joins to.

## 6.3 Repositories

The **only** place Drizzle appears outside `db/`. Repositories live in
`modules/*/infrastructure/`, take a `Tx` as their first argument, and never open
their own transaction — the use case owns the transaction boundary.

```ts
// modules/directory/infrastructure/enrolmentRepository.ts
export const enrolments = {
  async bySection(tx: Tx, sectionId: SectionId, yearId: AcademicYearId)
    : Promise<Enrolment[]> {
    const rows = await tx.select().from(enrolment)
      .where(and(
        eq(enrolment.sectionId, sectionId),
        eq(enrolment.academicYearId, yearId),
        isNull(enrolment.deletedAt),           // findX excludes soft-deleted
      ))
      .orderBy(asc(enrolment.rollNo));
    return rows.map(toDomain);                 // rows are NOT domain objects
  },

  async insert(tx: Tx, e: NewEnrolment): Promise<Enrolment> { /* … */ },
};
```

Three rules:

| Rule | Reason |
|---|---|
| `tenant_id` is **never** in a `where` clause | RLS adds it. Writing it by hand invites someone to parameterise it |
| Rows are mapped to domain objects at the boundary | A Drizzle row is not a domain entity; leaking it couples the domain to the ORM |
| `find*` excludes soft-deleted; `findIncludingDeleted*` is explicit | A view that silently filters hides the rule ([§10.1](../../architecture/phase-1a/10-database-architecture.md)) |

## 6.4 Query conventions

### Keyset pagination

```ts
export function keyset<T extends PgTable>(
  q: SelectQuery, sortCol: PgColumn, idCol: PgColumn,
  cursor: Cursor | undefined, limit: number,
) {
  const q2 = cursor
    ? q.where(or(lt(sortCol, cursor.sort),
                 and(eq(sortCol, cursor.sort), lt(idCol, cursor.id))))
    : q;
  return q2.orderBy(desc(sortCol), desc(idCol)).limit(Math.min(limit, 100) + 1);
}
```

The `id` tiebreaker is required: without it, rows sharing a sort value are
skipped or repeated across pages — which on a defaulter list being worked through
means a family is missed.

### Scope predicates

Teacher scope is applied **in SQL**, never by filtering in JavaScript
([§8.5](../../architecture/phase-1a/08-identity-authn-rbac.md)):

```ts
const rows = await tx.select().from(enrolment)
  .where(and(
    eq(enrolment.academicYearId, yearId),
    scopeFilter(ctx, 'section'),               // → inArray(section_id, ctx.scope) | undefined
    isNull(enrolment.deletedAt),
  ));
```

### Optimistic locking

```ts
const updated = await tx.update(student)
  .set({ ...patch, version: sql`version + 1`, updatedBy: ctx.personId })
  .where(and(eq(student.id, id), eq(student.version, expectedVersion)))
  .returning();

if (updated.length === 0) return err(Errors.CONCURRENT_MODIFICATION);  // → 409
```

### Bulk inserts

Chunked at 500 rows, always inside the caller's transaction, always with
application-generated ULIDs so the graph is built before the write
([ADR-0024](../../architecture/adr/0024-import-staging-model.md)).

## 6.5 What must never appear

| Banned | Instead | Enforced by |
|---|---|---|
| `db.select()` outside a repository | `withTenant(ctx, tx => repo.x(tx, …))` | Lint: `db` is not exported from `db/index.ts`; only `withTenant` is |
| `tenant_id` in a `where` clause | RLS | Code review; grep in CI as a warning |
| `mode: 'number'` on a money column | `moduleMinor` | Lint rule on `db/schema/**` |
| `timestamp` without timezone | `instant()` | Migration lint |
| Raw string interpolation in SQL | `sql` template parameters | ESLint `no-restricted-syntax` |
| `drizzle-kit push` against production | Hand-written migrations | Not in any npm script |
| A repository opening its own transaction | Take `tx` as an argument | Type signature — repos accept `Tx`, not `Db` |

`db/index.ts` exporting only `withTenant` (and the operator pool, separately
named and separately imported) is the mechanical reason invariant 1 holds: there
is no other handle to reach for.

## 6.6 Drift detection

`drizzle-kit` generates a diff between the TypeScript schema and the migrated
database. CI fails if they differ.

```
pnpm db:check    # drizzle-kit check — schema vs migrations
pnpm db:drift    # migrate a scratch DB, diff against schema/, fail on delta
```

This catches the common failure where a migration is hand-edited and the Drizzle
schema is not updated, which would otherwise surface as a runtime column-not-found
in production.
