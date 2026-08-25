/**
 * First-load JS budget, enforced. §4.4.
 *
 * This is a FUNCTIONAL requirement, not a nicety: if the attendance screen does
 * not load on a teacher's low-end Android at 08:30 over 3G, the product does
 * not work. A budget that is not enforced is a wish, so this fails the build.
 *
 * WHAT THIS MEASURES TODAY — and what it does not.
 *
 * Every route pays a SHARED BASELINE: the React runtime, the router and the
 * polyfills. That is the floor under the tightest budget in the product (the
 * 150 KB guardian route), so if the baseline alone approaches it, no amount of
 * per-route care will save the guardian surface. The baseline is measurable
 * from `build-manifest.json` and is enforced here.
 *
 * PER-ROUTE client JS is NOT yet attributable: Next 16 with Turbopack does not
 * emit `app-build-manifest.json`, and with every page currently a server
 * component there are no per-route client chunks to attribute. When the first
 * client components land — the marks grid, the attendance grid — extend this to
 * read the client reference manifests and enforce per surface. The budgets are
 * already declared below so that change is a measurement, not a decision.
 */

import { readFile, stat } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { join } from 'node:path';

const gzipAsync = promisify(gzip);
const NEXT_DIR = '.next';

/** Declared now; enforced per route once client chunks exist. §4.4 */
export const SURFACE_BUDGETS_KB = {
  guardian: 150,
  staff: 180,
  publicSite: 180,
  marketing: 180,
  platform: 500,
} as const;

/** The floor under every route must leave room for the tightest budget. */
const BASELINE_MAX_KB = SURFACE_BUDGETS_KB.guardian;

function surfaceOf(route: string): keyof typeof SURFACE_BUDGETS_KB | 'other' {
  // Route groups survive in app-paths-manifest keys, which is exactly the
  // classification we want: (guardian) vs (staff) is the whole point of
  // separating them.
  if (route.includes('(guardian)')) return 'guardian';
  if (route.includes('(staff)') || route.includes('(auth)')) return 'staff';
  if (route.includes('/platform')) return 'platform';
  if (route.includes('/marketing')) return 'marketing';
  if (/\/s\/\[slug\]\/page$/.test(route)) return 'publicSite';
  return 'other';
}

async function gzippedSize(relPath: string): Promise<number> {
  const full = join(NEXT_DIR, relPath);
  try {
    await stat(full);
  } catch {
    return 0;
  }
  return (await gzipAsync(await readFile(full), { level: 9 })).byteLength;
}

interface BuildManifest {
  rootMainFiles?: string[];
  polyfillFiles?: string[];
}

async function main(): Promise<void> {
  let manifest: BuildManifest;
  try {
    manifest = JSON.parse(
      await readFile(join(NEXT_DIR, 'build-manifest.json'), 'utf8'),
    ) as BuildManifest;
  } catch {
    console.error('No .next/build-manifest.json — run `pnpm build` first.');
    process.exit(1);
  }

  // Polyfills are emitted with `noModule`, so every browser that supports ES
  // modules — including Chrome on the low-end Android this budget exists for —
  // skips the download. Counting them would overstate the real payload by
  // ~38 KB and fail a budget that is actually met. Verified against the
  // generated HTML: <script src="…" noModule="">.
  const baselineFiles = (manifest.rootMainFiles ?? []).filter((f) => f.endsWith('.js'));
  const legacyFiles = (manifest.polyfillFiles ?? []).filter((f) => f.endsWith('.js'));

  const sizes = await Promise.all(baselineFiles.map(gzippedSize));
  const legacySizes = await Promise.all(legacyFiles.map(gzippedSize));
  const baselineKb = sizes.reduce((a, b) => a + b, 0) / 1024;
  const legacyKb = legacySizes.reduce((a, b) => a + b, 0) / 1024;

  console.log('Shared baseline — modern browsers (every route pays this):');
  for (const [i, f] of baselineFiles.entries()) {
    console.log(`  ${((sizes[i] ?? 0) / 1024).toFixed(1).padStart(7)} KB  ${f}`);
  }
  console.log(
    `  ${'-'.repeat(7)}\n  ${baselineKb.toFixed(1).padStart(7)} KB  total (gzipped)` +
      `  · budget ${BASELINE_MAX_KB} KB` +
      `\n  ${legacyKb.toFixed(1).padStart(7)} KB  legacy polyfills (noModule — not downloaded by modern browsers)\n`,
  );

  const headroom = BASELINE_MAX_KB - baselineKb;
  console.log(
    `Headroom for application code on the tightest surface (guardian): ` +
      `${headroom.toFixed(1)} KB\n`,
  );

  // Informational until per-route client chunks exist.
  try {
    const appPaths = JSON.parse(
      await readFile(join(NEXT_DIR, 'server', 'app-paths-manifest.json'), 'utf8'),
    ) as Record<string, string>;

    console.log('Routes by surface:');
    for (const route of Object.keys(appPaths).sort()) {
      if (route.includes('/api/') || route.startsWith('/_')) continue;
      const s = surfaceOf(route);
      const budget = s === 'other' ? '—' : `${SURFACE_BUDGETS_KB[s]} KB`;
      console.log(`  ${s.padEnd(12)} ${budget.padEnd(8)} ${route}`);
    }
    console.log();
  } catch {
    // Manifest shape changed; the baseline check above still holds.
  }

  if (baselineKb > BASELINE_MAX_KB) {
    console.error(
      `Shared baseline is ${baselineKb.toFixed(1)} KB, over the ${BASELINE_MAX_KB} KB ` +
        'floor. Every route pays this, so the guardian surface can never fit.\n' +
        'Look for something pulled into the root layout that belongs in a leaf.',
    );
    process.exit(1);
  }

  console.log('Baseline within budget.');
}

await main();
