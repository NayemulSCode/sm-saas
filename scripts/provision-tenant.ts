/**
 * Provision a school from the command line.
 *
 * There is no operator console yet, and a `provisionTenant` nobody can call is
 * the same gap as role templates nobody copies. This is the operator entry
 * point until the console exists — and it is the one that will provision the
 * first real school.
 *
 * Runs on the platform pool, so it needs DATABASE_URL_PLATFORM.
 *
 *   pnpm provision \
 *     --slug dhaka-model \
 *     --name-bn 'ঢাকা আদর্শ বিদ্যালয়' \
 *     --name-en 'Dhaka Model School' \
 *     --plan starter \
 *     --owner-name-bn 'রেহানা পারভীন' \
 *     --owner-name-en 'Rehana Parvin' \
 *     --owner-phone +8801711223344 \
 *     --reason 'signed contract 2026-09-01, ticket SM-412'
 */

import { provisionTenant, suggestSlug } from '../src/modules/platform/index';
import type { AccountId } from '../src/shared/ids';
import type { PlatformContext } from '../src/shared/auth-context';
import { PERMISSIONS } from '../src/shared/permissions';
import { closeAllPools } from '../src/db/index';

function args(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith('--')) {
      const next = argv[i + 1];
      // `--flag --other` is a missing value, not a flag whose value is a flag.
      out.set(a.slice(2), next && !next.startsWith('--') ? next : '');
      if (next && !next.startsWith('--')) i++;
    }
  }
  return out;
}

const a = args(process.argv.slice(2));

const REQUIRED = [
  'slug',
  'name-bn',
  'name-en',
  'plan',
  'owner-name-bn',
  'owner-name-en',
  'owner-phone',
  'reason',
] as const;

const missing = REQUIRED.filter((k) => !a.get(k));
if (missing.length > 0) {
  console.error(`Missing required argument(s): ${missing.map((m) => `--${m}`).join(', ')}\n`);
  console.error('Every one is required, including --reason: provisioning is audited.');
  console.error(
    '\nExample:\n  pnpm provision --slug dhaka-model \\\n' +
      "    --name-bn 'ঢাকা আদর্শ বিদ্যালয়' --name-en 'Dhaka Model School' \\\n" +
      "    --plan starter --owner-name-bn 'রেহানা পারভীন' --owner-name-en 'Rehana Parvin' \\\n" +
      "    --owner-phone +8801711223344 --reason 'signed contract, ticket SM-412'",
  );
  if (a.get('name-en')) console.error(`\nSuggested slug: ${suggestSlug(a.get('name-en')!)}`);
  process.exit(1);
}

if (!process.env.DATABASE_URL_PLATFORM) {
  console.error('Set DATABASE_URL_PLATFORM. Provisioning runs on the platform pool.');
  process.exit(1);
}

/*
 * A CLI run has no operator account unless one is named. `--operator` takes an
 * account ULID and is recorded as the actor; without it the audit row honestly
 * shows a null actor, meaning "whoever held the database credentials".
 */
const operator: PlatformContext = {
  ...(a.get('operator') ? { accountId: a.get('operator') as AccountId } : {}),
  permissions: new Set(PERMISSIONS),
  requestId: `cli-${Date.now()}`,
  reason: a.get('reason')!,
};

const result = await provisionTenant(operator, {
  slug: a.get('slug')!,
  nameBn: a.get('name-bn')!,
  nameEn: a.get('name-en')!,
  planCode: a.get('plan')!,
  owner: {
    nameBn: a.get('owner-name-bn')!,
    nameEn: a.get('owner-name-en')!,
    phone: a.get('owner-phone')!,
    ...(a.get('owner-email') ? { email: a.get('owner-email')! } : {}),
  },
  ...(a.get('eiin') ? { eiin: a.get('eiin')! } : {}),
  ...(a.get('fiscal-month') ? { fiscalYearStartMonth: Number(a.get('fiscal-month')) } : {}),
});

await closeAllPools();

if (!result.ok) {
  console.error(`\nProvisioning failed: ${result.error.code} (${result.error.messageKey})`);
  if (result.error.code === 'INVALID_SLUG') {
    console.error(`Suggested slug: ${suggestSlug(a.get('name-en')!)}`);
  }
  process.exit(1);
}

const v = result.value;
console.log(`
Provisioned "${a.get('name-en')}"

  tenant          ${v.tenantId}
  slug            ${v.slug}
  school          ${v.schoolId}
  academic year   ${v.academicYearName}
  class levels    ${v.classLevelCount}
  roles           ${v.roleCount}
  owner person    ${v.ownerPersonId}
  owner account   ${v.ownerAccountId}${v.ownerAccountReused ? '  (existing login reused)' : ''}

The owner signs in with ${a.get('owner-phone')} by OTP — no password was set,
and none was transmitted. They hold the Principal role and can invite the rest
of the staff.
`);
