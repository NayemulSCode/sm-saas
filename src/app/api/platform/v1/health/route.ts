import { NextResponse } from 'next/server';

/** Operator REST surface. Operator session + MFA + the sm_platform pool. */
export function GET(): NextResponse {
  return NextResponse.json({
    data: { status: 'ok', surface: 'platform' },
    meta: { requestId: crypto.randomUUID() },
  });
}
