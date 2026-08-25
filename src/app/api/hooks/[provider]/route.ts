import { NextResponse, type NextRequest } from 'next/server';

/**
 * Inbound webhooks: payment IPN, SMS delivery reports.
 *
 * Rules that hold for every provider (ADR-0020):
 *   1. Verify the signature BEFORE parsing — an unverified payload is
 *      attacker-controlled input.
 *   2. Store the raw payload; disputes are settled by what was actually sent.
 *   3. UNIQUE (provider, provider_ref, event_type) IS the replay protection.
 *   4. Respond 200 fast, process asynchronously — providers retry aggressively
 *      on slow responses and multiply the load.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider } = await params;

  // Signature verification lands with the provider adapters in Phase 3b.
  // Until then this surface accepts nothing.
  return NextResponse.json(
    {
      error: {
        code: 'PROVIDER_NOT_CONFIGURED',
        message: `No adapter registered for '${provider}'`,
        requestId: crypto.randomUUID(),
      },
    },
    { status: 501 },
  );
}
