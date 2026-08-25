/**
 * Custom Drizzle column types.
 *
 * Three of them exist to remove three whole bug classes at the type level:
 * money that can be divided by accident, a calendar day that is really an
 * instant, and an id that fits any parameter.
 */

import { bigint, customType, timestamp } from 'drizzle-orm/pg-core';
import { type Id, Ids } from '../shared/ids.js';
import { LocalDate } from '../shared/date.js';

/**
 * Money — bigint minor units. Mode 'bigint', NEVER 'number'.
 * `bigint` and `number` do not mix in TypeScript, so `amount / 100` is a
 * compile error rather than a rounding bug (invariant 2).
 */
export const moneyMinor = (name: string) => bigint(name, { mode: 'bigint' });

/**
 * LocalDate ↔ `date`. Drizzle's built-in `date` mode returns a JS Date, which
 * reintroduces the midnight-UTC-is-06:00-in-Dhaka bug this type exists to
 * prevent.
 */
export const localDate = customType<{ data: LocalDate; driverData: string }>({
  dataType: () => 'date',
  toDriver: (d) => LocalDate.toISO(d),
  fromDriver: (s) => {
    const parsed = LocalDate.parse(s);
    if (!parsed.ok) throw new Error(`Invalid date from database: ${s}`);
    return parsed.value;
  },
});

/**
 * Branded ULID stored as `uuid` — with a real conversion, not just a type cast.
 *
 * ADR-0016 keeps ids in Crockford base32 (26 chars) in application code and in
 * `uuid` (16 bytes) in the database. `uuid().$type<Id<T>>()` only *asserts* the
 * TypeScript type and passes the value through untouched, so every insert would
 * hand PostgreSQL a 26-character string for a `uuid` column and be rejected at
 * runtime. The compiler cannot see that, because `$type` is a pure assertion.
 *
 * A `customType` with `toDriver`/`fromDriver` does the base conversion, so
 * application code lives entirely in ULID space and storage stays 16 bytes.
 */
export const ulidCol = <T extends string>(name: string) =>
  customType<{ data: Id<T>; driverData: string }>({
    dataType: () => 'uuid',
    toDriver: (value) => Ids.toUuid(value),
    fromDriver: (value) => Ids.fromUuid<T>(value),
  })(name);

/** Instants. `timestamp without time zone` is banned. */
export const instant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });
