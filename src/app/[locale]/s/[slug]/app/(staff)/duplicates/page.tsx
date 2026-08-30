/**
 * The merge review queue. §14.5.
 *
 * The same human gets entered twice all the time — a guardian who registered
 * two children a year apart, a returning student re-admitted as new, a name
 * spelled মোহাম্মদ once and মুহাম্মদ the next time. Left alone the family gets
 * two SMS, misses the sibling discount, and appears twice on every list.
 *
 * The screen exists because the fix is dangerous. `student.merge` fuses two
 * records, and getting it wrong fuses two different CHILDREN. So nothing here
 * merges automatically, however strong the evidence: the queue proposes, says
 * why it proposed, shows what each side would carry, and asks a person who
 * knows the family to choose which record survives.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveAuthContext, tokenGenerator } from '../../../../../../../modules/identity/index';
import { reviewDuplicates, listMerges } from '../../../../../../../modules/directory/index';
import { readSessionToken } from '../../../../../../api/_lib/session-cookie';
import { can } from '../../../../../../../shared/auth-context';
import { appPath } from '../../../../../../../shared/paths';
import { DuplicateQueue, RecentMerges } from './MergeForms';

export const dynamic = 'force-dynamic';

export default async function DuplicatesPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<React.JSX.Element> {
  const { locale } = await params;
  const base = appPath(locale);

  const token = await readSessionToken();
  if (!token) redirect(`${base}/login`);

  const ctx = await resolveAuthContext(token, { tokens: tokenGenerator });
  if (!ctx.ok) redirect(`${base}/login`);

  if (!can(ctx.value, 'student.merge')) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <p className="mb-4 text-sm">
          <Link href={`${base}/dashboard`} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            ← Dashboard
          </Link>
        </p>
        <p className="text-sm text-[var(--color-text-muted)]">
          You do not have permission to merge records.
        </p>
      </main>
    );
  }

  const [pairs, merges] = await Promise.all([
    reviewDuplicates(ctx.value, { limit: 25 }),
    listMerges(ctx.value, { limit: 10 }),
  ]);

  return (
    <main className="mx-auto max-w-4xl p-6">
      <p className="mb-4 text-sm">
        <Link href={`${base}/dashboard`} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          ← Dashboard
        </Link>
      </p>

      <h1 className="font-serif text-2xl text-[var(--color-text)]">Possible duplicates</h1>
      <p className="mt-2 mb-8 text-[var(--color-text-muted)]">
        Records that look like the same person. Nothing is merged until somebody
        chooses which one to keep — the other is kept too, marked as merged, so
        an old reference still resolves to a human.
      </p>

      <DuplicateQueue pairs={pairs.ok ? pairs.value : []} />
      <RecentMerges merges={merges.ok ? merges.value : []} />
    </main>
  );
}
