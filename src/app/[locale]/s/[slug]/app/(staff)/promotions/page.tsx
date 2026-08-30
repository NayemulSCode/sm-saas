/**
 * Promotion: move a section's cohort into next year. §14.5, FR-4.6.
 *
 * The riskiest bulk operation in the product, so the screen is built around
 * two ideas rather than around the form.
 *
 * NOTHING MOVES UNTIL THE ROSTER IS ON SCREEN. Choosing the section is a plain
 * GET — the roster arrives as a page you can read, send to a colleague, or
 * bookmark, and the outcome controls only appear beside real names. A promotion
 * form that lets you pick a section from a dropdown and press Promote without
 * ever seeing who is in it is how the wrong section gets promoted.
 *
 * UNDO IS PART OF THE SCREEN, not a consolation. The recent runs are listed
 * whether or not you are the person who ran them, because "we promoted the
 * wrong section" is realised minutes later by somebody who has closed the tab.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveAuthContext, tokenGenerator } from '../../../../../../../modules/identity/index';
import { getStructure } from '../../../../../../../modules/structure/index';
import { listStudents, listPromotionBatches } from '../../../../../../../modules/directory/index';
import type { AcademicYearId, SectionId } from '../../../../../../../shared/ids';
import { readSessionToken } from '../../../../../../api/_lib/session-cookie';
import { can, isHouseholdOnly } from '../../../../../../../shared/auth-context';
import { appPath } from '../../../../../../../shared/paths';
import { PromotionRun, RecentRuns, type Option, type Candidate } from './PromotionForms';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ fromYearId?: string; sectionId?: string }>;
}

export default async function PromotionsPage({
  params,
  searchParams,
}: Props): Promise<React.JSX.Element> {
  const { locale } = await params;
  const { fromYearId, sectionId } = await searchParams;
  const base = appPath(locale);

  const token = await readSessionToken();
  if (!token) redirect(`${base}/login`);

  const ctx = await resolveAuthContext(token, { tokens: tokenGenerator });
  if (!ctx.ok) redirect(`${base}/login`);

  /*
   * A household session (Guardian or Student) must never reach a staff page,
   * however it got here — a bookmark, a stale redirect target, a link pasted
   * into a chat. `Librarian` holds the same base permission Guardian does
   * (`student.read`), so a permission check alone cannot tell them apart; only
   * the role can (`isHouseholdOnly`, shared/auth-context.ts).
   */
  if (isHouseholdOnly(ctx.value)) redirect(`${base}/children`);

  /*
   * Both permissions, because the page needs both. `getStructure` authorizes
   * `structure.read` and THROWS if it is missing — inside a server component
   * that is a 500 where a sentence was wanted.
   */
  if (!can(ctx.value, 'enrolment.promote') || !can(ctx.value, 'structure.read')) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <p className="mb-4 text-sm">
          <Link href={`${base}/dashboard`} className="underline">
            ← Dashboard
          </Link>
        </p>
        <p className="text-sm text-[var(--color-text-muted)]">
          You do not have permission to promote students.
        </p>
      </main>
    );
  }

  const chosen = fromYearId !== undefined && sectionId !== undefined;

  const [structureResult, rosterResult, batchesResult] = await Promise.all([
    getStructure(ctx.value),
    chosen
      ? listStudents(ctx.value, {
          sectionId: sectionId as SectionId,
          academicYearId: fromYearId as AcademicYearId,
          // A section is a few dozen students; the cap is a guard, not a page.
          limit: 100,
        })
      : Promise.resolve(null),
    listPromotionBatches(ctx.value, { limit: 10 }),
  ]);

  if (!structureResult.ok) redirect(`${base}/dashboard`);
  const s = structureResult.value;

  const classById = new Map(s.classLevels.map((c) => [c.id, c.nameEn]));
  const sectionOptions: Option[] = s.sections.map((sec) => ({
    id: sec.id,
    label: `${classById.get(sec.classLevelId) ?? '—'} · ${sec.nameEn}`,
  }));

  /*
   * A closed year cannot receive a promotion, and offering it produces a
   * refusal the person cannot act on. Source years are NOT filtered the same
   * way: promoting out of the year that has just closed is the normal case.
   */
  const yearOptions: Option[] = s.years.map((y) => ({
    id: y.id,
    label: `${y.name}${y.isCurrent ? ' (current)' : ''}${y.status === 'closed' ? ' — closed' : ''}`,
  }));
  const openYearOptions: Option[] = s.years
    .filter((y) => y.status !== 'closed')
    .map((y) => ({ id: y.id, label: `${y.name}${y.isCurrent ? ' (current)' : ''}` }));

  /*
   * Ordered by CURRENT ROLL, matching `buildPromotionPlan` — which is also the
   * order the new roll numbers will be handed out in. `listStudents` returns
   * newest admission first, which is the right default for the student list
   * and the wrong one here: a head teacher checking a promotion reads down the
   * roll, and a list in a different order from the operation it describes is
   * one the reader has to distrust. A student with no roll sorts last, by name.
   *
   * The server still decides. This only makes the page agree with it.
   */
  const roster: Candidate[] = (rosterResult?.ok ? rosterResult.value.items : [])
    .map((r) => ({
      id: r.id,
      nameBn: r.nameBn,
      nameEn: r.nameEn,
      studentCode: r.studentCode,
      rollNo: r.rollNo,
    }))
    .sort((a, b) => {
      if (a.rollNo !== null && b.rollNo !== null) return a.rollNo - b.rollNo;
      if (a.rollNo !== null) return -1;
      if (b.rollNo !== null) return 1;
      return a.nameEn.localeCompare(b.nameEn);
    });

  const sourceLabel = sectionOptions.find((o) => o.id === sectionId)?.label ?? '';
  const fromYearLabel = yearOptions.find((o) => o.id === fromYearId)?.label ?? '';

  return (
    <main className="mx-auto max-w-4xl p-6">
      <p className="mb-4 text-sm">
        <Link href={`${base}/dashboard`} className="underline">
          ← Dashboard
        </Link>
      </p>

      <h1 className="text-xl font-semibold">Promotion</h1>
      <p className="mt-2 mb-8 text-[var(--color-text-muted)]">
        Moves a section into the next academic year. Roll numbers are reassigned
        in the order of the current ones. Dues are not touched — arrears carry
        forward on their own.
      </p>

      {/* A plain GET, so the roster is a URL. No JavaScript on this path. */}
      <form method="get" className="mb-8 grid gap-4 rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="font-medium">Promote from year</span>
          <select
            name="fromYearId"
            defaultValue={fromYearId ?? ''}
            required
            className="mt-2 min-h-11 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
          >
            <option value="">Choose…</option>
            {yearOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="font-medium">Section</span>
          <select
            name="sectionId"
            defaultValue={sectionId ?? ''}
            required
            className="mt-2 min-h-11 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
          >
            <option value="">Choose…</option>
            {sectionOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-end">
          <button
            type="submit"
            className="min-h-11 w-full rounded border border-[var(--color-border)] px-4 font-medium"
          >
            Show the roster
          </button>
        </div>
      </form>

      {chosen && roster.length === 0 && (
        <p className="mb-8 rounded border border-[var(--color-border)] px-4 py-3 text-sm text-[var(--color-text-muted)]">
          Nobody is enrolled in that section for that year. Check the year before
          checking the section — an empty roster is far more often the wrong year.
        </p>
      )}

      {chosen && roster.length > 0 && (
        <PromotionRun
          sourceSectionId={sectionId!}
          fromYearId={fromYearId!}
          sourceLabel={sourceLabel}
          fromYearLabel={fromYearLabel}
          roster={roster}
          sections={sectionOptions}
          years={openYearOptions}
        />
      )}

      <RecentRuns batches={batchesResult.ok ? batchesResult.value : []} />
    </main>
  );
}
