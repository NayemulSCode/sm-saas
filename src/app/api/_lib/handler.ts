/**
 * The shape every route handler has, written once.
 *
 * Without this, twenty routes each repeat the same fifteen lines: mint a
 * request id, require a session, parse the body, run the use case, map a
 * DomainError to a status, and catch the AuthorizationError that `authorize()`
 * throws. Fifteen lines copied twenty times is fifteen lines that will differ
 * in three of them.
 *
 * The catch matters most. `authorize()` THROWS rather than returning, so a
 * handler that forgets to catch it answers 500 — which reads as a bug to fix
 * rather than as a boundary doing its job.
 *
 * ON PATHS. §10 writes action endpoints as `/class-levels:reorder`. A literal
 * `:` cannot appear in a Windows filename, so the App Router cannot express it
 * as a directory at all. Routes here use `/resource/[id]/verb`, which the auth
 * routes already established. Same resource, same verb, a character that exists
 * on every filesystem.
 */

import type { NextRequest } from 'next/server';
import type { ZodType } from 'zod';
import type { AuthContext } from '../../../shared/auth-context';
import type { DomainError, Result } from '../../../shared/result';
import { fail, failValidation, newRequestId, ok } from './http';
import { requireAuth, toAuthFailure } from './auth';

/** Next passes route params as a promise; a route with none passes nothing. */
type RouteContext<P> = { params: Promise<P> } | undefined;

export interface HandlerOptions {
  /** 201 for creation. Defaults to 200. */
  status?: number;
}

/**
 * An authenticated handler that takes a JSON body.
 *
 * The use case receives the parsed input and the route params; it never sees
 * the request, so it cannot reach for a header nobody validated.
 */
export function authed<TIn, TOut, P = Record<string, string>>(
  schema: ZodType<TIn>,
  run: (ctx: AuthContext, input: TIn, params: P) => Promise<Result<TOut, DomainError>>,
  options: HandlerOptions = {},
) {
  return async (req: NextRequest, context?: RouteContext<P>): Promise<Response> => {
    const requestId = newRequestId();

    const auth = await requireAuth(requestId);
    if (!auth.ok) return auth.response;

    // `.catch` because a malformed body is a 400, not a 500. An empty object
    // lets the schema report which fields are missing rather than "bad JSON".
    const body: unknown = await req.json().catch(() => ({}));
    const parsed = schema.safeParse(body);
    if (!parsed.success) return failValidation(parsed.error.issues, requestId);

    const params = ((await context?.params) ?? {}) as P;

    try {
      const result = await run({ ...auth.ctx, requestId }, parsed.data, params);
      if (!result.ok) return fail(result.error, requestId);
      return ok(result.value, { requestId }, { status: options.status ?? 200 });
    } catch (e) {
      const denied = toAuthFailure(e, requestId);
      if (denied) return denied;
      throw e;
    }
  };
}

/** An authenticated read. No body, so no schema. */
export function authedRead<TOut, P = Record<string, string>>(
  run: (ctx: AuthContext, params: P, req: NextRequest) => Promise<Result<TOut, DomainError>>,
) {
  return async (req: NextRequest, context?: RouteContext<P>): Promise<Response> => {
    const requestId = newRequestId();

    const auth = await requireAuth(requestId);
    if (!auth.ok) return auth.response;

    const params = ((await context?.params) ?? {}) as P;

    try {
      const result = await run({ ...auth.ctx, requestId }, params, req);
      if (!result.ok) return fail(result.error, requestId);
      return ok(result.value, { requestId });
    } catch (e) {
      const denied = toAuthFailure(e, requestId);
      if (denied) return denied;
      throw e;
    }
  };
}
