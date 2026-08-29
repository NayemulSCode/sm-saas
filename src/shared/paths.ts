/**
 * Public URLs for the tenant surface.
 *
 * The tenant is carried by the HOST and never by the path: `demo.example.com`
 * plus `/bn/app/dashboard`. Middleware rewrites that onto the internal
 * filesystem route `/bn/s/demo/app/dashboard`, which is where the page
 * components live — and which must never be linked to.
 *
 * Rewriting is not redirecting. Send a browser to the internal path and
 * middleware rewrites it a SECOND time, to `/bn/s/demo/s/demo/app/dashboard`,
 * which does not exist. The symptom is a 404 immediately after a successful
 * sign-in, with a correct-looking URL in the address bar.
 *
 * So every href, redirect and `location.assign` on this surface is built here.
 * `params.slug` is for reading — deciding what to show — never for building a
 * link.
 *
 * The locale stays in the path because it is the one thing the host does NOT
 * carry: drop it and a guardian reading English is silently returned to Bangla
 * on the next click.
 */

/** `/bn/app` + `path`. Pass a leading slash, or nothing for the root. */
export function appPath(locale: string, path = ''): string {
  return `/${locale}/app${path}`;
}
