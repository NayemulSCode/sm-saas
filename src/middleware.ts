import { NextResponse, type NextRequest } from 'next/server';

/**
 * Host → surface resolution. This is where the four surfaces are separated.
 *
 * Route groups cannot be targeted by a rewrite (they are invisible in the URL),
 * so each surface has a REAL path segment that middleware rewrites into. The
 * user-visible URL stays clean; the filesystem stays explicit.
 *
 *   sm.example.com/            → /<locale>/marketing
 *   admin.sm.example.com/      → /<locale>/platform
 *   dhaka-model.sm.example.com/       → /<locale>/s/dhaka-model
 *   dhaka-model.sm.example.com/app/x  → /<locale>/s/dhaka-model/app/x
 *
 * The platform console lives on its OWN HOSTNAME, not a path. A path-based
 * console is one middleware bug away from a tenant reaching operator routes;
 * a separate host means a separate cookie scope and a separate database pool
 * as well (§5.1).
 */

const LOCALES = ['bn', 'en'] as const;
const DEFAULT_LOCALE = 'bn';
type Locale = (typeof LOCALES)[number];

function isLocale(v: string | undefined): v is Locale {
  return v !== undefined && (LOCALES as readonly string[]).includes(v);
}

/** Host without the port, lowercased. */
function hostname(req: NextRequest): string {
  const raw = req.headers.get('host') ?? '';
  return (raw.split(':')[0] ?? '').toLowerCase();
}

function rootHost(): string {
  // APP_URL is validated at boot; parsing here keeps middleware edge-safe.
  try {
    return new URL(process.env.APP_URL ?? 'http://localhost:3000').hostname.toLowerCase();
  } catch {
    return 'localhost';
  }
}

function platformHost(): string {
  return (process.env.PLATFORM_HOST ?? `admin.${rootHost()}`).split(':')[0]!.toLowerCase();
}

type Surface =
  | { kind: 'marketing' }
  | { kind: 'platform' }
  | { kind: 'tenant'; slug: string }
  | { kind: 'unknown' };

export function resolveSurface(host: string, root: string, platform: string): Surface {
  if (host === platform) return { kind: 'platform' };
  if (host === root || host === `www.${root}`) return { kind: 'marketing' };

  if (host.endsWith(`.${root}`)) {
    const slug = host.slice(0, -(root.length + 1));
    // Only a single label is a tenant slug: a.b.example.com is not a tenant.
    if (slug.length > 0 && !slug.includes('.')) return { kind: 'tenant', slug };
  }

  // Custom domains are Phase 2 (ADR-0022). Until then an unknown host is not
  // silently treated as a tenant.
  return { kind: 'unknown' };
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname, search } = req.nextUrl;

  // API routes carry their own surface in the path and are never rewritten.
  if (pathname.startsWith('/api/')) return NextResponse.next();

  const host = hostname(req);
  const surface = resolveSurface(host, rootHost(), platformHost());

  if (surface.kind === 'unknown') {
    // 404, never 403: a 403 would confirm which hosts exist (§7.3).
    return new NextResponse('Not found', { status: 404 });
  }

  // Pull the locale out of the path, or fall back to the tenant default.
  const segments = pathname.split('/').filter(Boolean);
  const hasLocale = isLocale(segments[0]);
  const locale: Locale = hasLocale ? (segments[0] as Locale) : DEFAULT_LOCALE;
  const rest = hasLocale ? segments.slice(1) : segments;

  const target =
    surface.kind === 'platform'
      ? ['platform', ...rest]
      : surface.kind === 'marketing'
        ? ['marketing', ...rest]
        : ['s', surface.slug, ...rest];

  const url = req.nextUrl.clone();
  url.pathname = `/${locale}/${target.join('/')}`.replace(/\/+$/, '') || `/${locale}`;
  url.search = search;

  const res = NextResponse.rewrite(url);
  // Downstream reads these instead of re-deriving the host. Request headers
  // only — never trusted from the client, always set here.
  res.headers.set('x-sm-surface', surface.kind);
  res.headers.set('x-sm-locale', locale);
  if (surface.kind === 'tenant') res.headers.set('x-sm-tenant-slug', surface.slug);
  return res;
}

export const config = {
  matcher: [
    // Everything except Next internals and static files.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?)$).*)',
  ],
};
