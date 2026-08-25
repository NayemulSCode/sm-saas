import { NextResponse } from 'next/server';

/**
 * Tenant REST surface. Every response uses the one envelope (§19.3):
 *   { data, meta: { requestId } }  |  { error: { code, message, requestId } }
 *
 * `code` is stable and never localised; `message` is localised and never
 * parsed by a client.
 */
export function GET(): NextResponse {
  return NextResponse.json({
    data: { status: 'ok', surface: 'tenant' },
    meta: { requestId: crypto.randomUUID() },
  });
}
