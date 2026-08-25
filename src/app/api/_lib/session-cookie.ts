/**
 * Session cookie handling. §8.5.
 *
 * Opaque random token in an HttpOnly cookie; the database stores sha256 of it.
 * `SameSite=Lax` rather than `Strict` because guardians arrive by following an
 * SMS link from an external context, and `Strict` would drop the session on
 * that first navigation — which is precisely the journey that has to work.
 */

import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';

export const SESSION_COOKIE = 'sm_session';

export async function readSessionToken(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value;
}

export function setSessionCookie(
  res: NextResponse,
  token: string,
  expiresAt: Date,
): NextResponse {
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
  return res;
}

export function clearSessionCookie(res: NextResponse): NextResponse {
  res.cookies.set({
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
