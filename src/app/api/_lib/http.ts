/**
 * The transport edge. §19.3, §19.4.
 *
 * Domain errors carry a stable `code` and an i18n `messageKey`; they know no
 * HTTP status codes. The mapping to HTTP happens HERE, once, so the domain
 * layer stays transport-agnostic and a module could be served over something
 * other than HTTP without touching its errors.
 */

import { NextResponse } from 'next/server';
import type { DomainError } from '../../../shared/result';

export interface Meta {
  requestId: string;
  [key: string]: unknown;
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Localisation lands with next-intl. Until then the key is returned as the
 * message so the contract shape is already correct: clients read `code` and
 * never parse `message`.
 */
function localise(messageKey: string): string {
  return messageKey;
}

export function ok<T>(data: T, meta: Partial<Meta> = {}, init?: ResponseInit): NextResponse {
  return NextResponse.json(
    { data, meta: { requestId: meta.requestId ?? newRequestId(), ...meta } },
    init,
  );
}

export function fail(
  error: DomainError,
  requestId: string = newRequestId(),
  details?: unknown,
): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: error.code,
        message: localise(error.messageKey),
        ...(details !== undefined ? { details } : {}),
        requestId,
      },
    },
    { status: error.httpStatus },
  );
}

/** A 400 for a Zod failure, with per-field codes so a form can mark the field. */
export function failValidation(
  issues: Array<{ path: PropertyKey[]; message: string; code: string }>,
  requestId: string = newRequestId(),
): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'common.error.validation',
        details: issues.map((i) => ({
          field: i.path.join('.'),
          code: i.code,
          message: i.message,
        })),
        requestId,
      },
    },
    { status: 400 },
  );
}

export function failRateLimited(
  retryAfterSeconds: number,
  requestId: string = newRequestId(),
): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: 'RATE_LIMITED',
        message: 'common.error.rateLimited',
        requestId,
      },
    },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

/**
 * The client IP, for per-IP rate limiting.
 *
 * Behind Cloudflare and Caddy the socket address is the proxy, so the header
 * is the only useful source. It is attacker-controllable in principle, which
 * is why per-IP limits are always paired with a per-identifier limit that does
 * not depend on it (§8.2).
 */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || req.headers.get('cf-connecting-ip') || 'unknown';
}
