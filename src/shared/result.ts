/**
 * Result — domain functions return, they do not throw.
 *
 * Exceptions are reserved for programmer error and infrastructure failure.
 * A domain error is a value, so the type system forces the caller to handle it.
 */

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const Result = {
  isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
    return r.ok;
  },

  map<T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E> {
    return r.ok ? ok(f(r.value)) : r;
  },

  flatMap<T, U, E>(r: Result<T, E>, f: (t: T) => Result<U, E>): Result<U, E> {
    return r.ok ? f(r.value) : r;
  },

  /** Fails on the FIRST error. Import row validation uses `partition` instead,
   *  because it must report every bad cell rather than stopping at one. */
  all<T, E>(rs: readonly Result<T, E>[]): Result<T[], E> {
    const values: T[] = [];
    for (const r of rs) {
      if (!r.ok) return r;
      values.push(r.value);
    }
    return ok(values);
  },

  partition<T, E>(rs: readonly Result<T, E>[]): { values: T[]; errors: E[] } {
    const values: T[] = [];
    const errors: E[] = [];
    for (const r of rs) {
      if (r.ok) values.push(r.value);
      else errors.push(r.error);
    }
    return { values, errors };
  },

  unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
    return r.ok ? r.value : fallback;
  },

  /** Throws. Use only in tests and at the transport edge after mapping. */
  unwrap<T, E>(r: Result<T, E>): T {
    if (r.ok) return r.value;
    throw new Error(`Result.unwrap on an error: ${JSON.stringify(r.error)}`);
  },
};

/**
 * HTTP statuses the domain error taxonomy maps to (§19.4). Mapping happens
 * ONCE, at the transport edge — the domain layer knows no status codes.
 *
 * 500 is deliberately absent: an unexpected failure is an exception, not a
 * DomainError. 404 covers "in another tenant" as well as "does not exist",
 * because 403 would confirm the resource is real (§7.3).
 */
export type DomainErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 423 | 429;

export interface DomainError {
  /** Stable, machine-readable, never localised. */
  readonly code: string;
  /** i18n key — localised at the transport edge. */
  readonly messageKey: string;
  readonly httpStatus: DomainErrorStatus;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Declares a module's errors as data, with the shape checked at compile time. */
export function defineErrors<const T extends Record<string, DomainError>>(errors: T): T {
  return errors;
}

export const CommonErrors = defineErrors({
  NOT_FOUND: { code: 'NOT_FOUND', messageKey: 'common.error.notFound', httpStatus: 404 },
  FORBIDDEN: { code: 'FORBIDDEN', messageKey: 'common.error.forbidden', httpStatus: 403 },
  CONCURRENT_MODIFICATION: {
    code: 'CONCURRENT_MODIFICATION',
    messageKey: 'common.error.concurrent',
    httpStatus: 409,
  },
  TENANT_SUSPENDED: {
    code: 'TENANT_SUSPENDED',
    messageKey: 'common.error.tenantSuspended',
    httpStatus: 423,
  },
  IDEMPOTENCY_KEY_REUSED: {
    code: 'IDEMPOTENCY_KEY_REUSED',
    messageKey: 'common.error.idempotencyReuse',
    httpStatus: 409,
  },
  VALIDATION_FAILED: {
    code: 'VALIDATION_FAILED',
    messageKey: 'common.error.validation',
    httpStatus: 400,
  },
});
