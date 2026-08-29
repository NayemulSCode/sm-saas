/**
 * Readiness. Should this container receive traffic?
 *
 * Checks the database as the app role. 503 when not ready, so Caddy and the
 * deploy script can both branch on the status code without parsing the body
 * (§35.3 step d).
 */
import { checkReadiness } from '../../../../modules/platform/index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const readiness = await checkReadiness();
  return Response.json(readiness, { status: readiness.ready ? 200 : 503 });
}
