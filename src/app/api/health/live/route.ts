/**
 * Liveness. Is the process running?
 *
 * Touches NOTHING external, on purpose. A liveness probe that checks the
 * database restarts the application every time the database hiccups — which
 * turns a thirty-second database blip into a restart loop that outlasts it.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'live' });
}
