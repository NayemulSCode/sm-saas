import { NextResponse } from 'next/server';

/** Unauthenticated and heavily rate-limited. Serves the public school site. */
export function GET(): NextResponse {
  return NextResponse.json({
    data: { status: 'ok', surface: 'public' },
    meta: { requestId: crypto.randomUUID() },
  });
}
