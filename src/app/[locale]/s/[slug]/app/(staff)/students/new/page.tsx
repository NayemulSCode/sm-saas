/**
 * Admit a student.
 *
 * The section list is fetched on the SERVER and passed in, so the form has
 * everything it needs in the first response. Fetching it from the client would
 * mean an empty dropdown for the first second on a 3G connection, which is
 * exactly when somebody starts typing.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveAuthContext, tokenGenerator } from '../../../../../../../../modules/identity/index';
import { getStructure } from '../../../../../../../../modules/structure/index';
import { readSessionToken } from '../../../../../../../api/_lib/session-cookie';
import { can, isHouseholdOnly } from '../../../../../../../../shared/auth-context';
import { AdmitForm, type SectionOption } from './AdmitForm';
import { appPath } from '../../../../../../../../shared/paths';

export const dynamic = 'force-dynamic';

export default async function NewStudentPage({
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

  /*
   * A household session (Guardian or Student) must never reach a staff page,
   * however it got here — a bookmark, a stale redirect target, a link pasted
   * into a chat. `Librarian` holds the same base permission Guardian does
   * (`student.read`), so a permission check alone cannot tell them apart; only
   * the role can (`isHouseholdOnly`, shared/auth-context.ts).
   */
  if (isHouseholdOnly(ctx.value)) redirect(`${base}/children`);

  // Checked here so the page never renders a form the server would refuse.
  if (!can(ctx.value, 'student.write')) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <p className="text-sm text-[var(--color-text-muted)]">
          You do not have permission to admit students.
        </p>
      </main>
    );
  }

  const structure = await getStructure(ctx.value);
  if (!structure.ok) redirect(`${base}/dashboard`);

  const classById = new Map(structure.value.classLevels.map((c) => [c.id, c.nameEn]));
  const sections: SectionOption[] = structure.value.sections.map((s) => ({
    id: s.id,
    // "Class 6 — A" rather than a ULID: the person choosing knows the class,
    // not the id.
    label: `${classById.get(s.classLevelId) ?? 'Class'} — ${s.nameEn}`,
  }));

  return (
    <main className="mx-auto max-w-2xl p-6">
      <p className="mb-4 text-sm">
        <Link href={`${base}/dashboard`} className="underline">
          ← All students
        </Link>
      </p>
      <h1 className="mb-6 text-xl font-semibold">Admit a student</h1>

      <AdmitForm
        schoolId={structure.value.school.id}
        academicYearId={structure.value.currentYear?.id ?? null}
        sections={sections}
        redirectBase={base}
      />
    </main>
  );
}
