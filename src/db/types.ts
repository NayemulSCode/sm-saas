/**
 * Custom Drizzle column types.
 *
 * Three of them exist to remove three whole bug classes at the type level:
 * money that can be divided by accident, a calendar day that is really an
 * instant, and an id that fits any parameter.
 */

import { bigint, customType, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { Id } from '../shared/ids.js';
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

/** Branded ULID stored as `uuid`. */
export const ulidCol = <T extends string>(name: string) => uuid(name).$type<Id<T>>();

/** Instants. `timestamp without time zone` is banned. */
export const instant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });
