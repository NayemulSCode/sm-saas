/**
 * The staff dashboard — the first screen after signing in.
 *
 * A SERVER component that calls the use cases directly rather than fetching its
 * own API. The data is on the same machine; going out through HTTP to come back
 * in would add a round trip, a serialisation pass and a second authorisation
 * check to every page load, and on a 3G connection in a district town the round
 * trip is the whole cost.
 *
 * It therefore ships **no client JavaScript at all**. Search is a plain form
 * that navigates, and paging is a link. That is not a limitation to fix later:
 * a list that works before hydration is a list that works on the handset the
 * office actually has.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveAuthContext, tokenGenerator } from '../../../../../../../modules/identity/index';
import { getStructure } from '../../../../../../../modules/structure/index';
import { listStudents, type StudentRow } from '../../../../../../../modules/directory/index';
import { readSessionToken } from '../../../../../../api/_lib/session-cookie';
import { can } from '../../../../../../../shared/auth-context';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ search?: string; cursor?: string }>;
}

export default async function DashboardPage({
  params,
  searchParams,
}: Props): Promise<React.JSX.Element> {
  const { locale, slug } = await params;
  const { search, cursor } = await searchParams;

  const base = `/${locale}/s/${slug}/app`;

  /*
   * Unauthenticated lands on the login page, not on a 403. A 403 on a page is a
   * dead end for a guardian who simply arrived with an expired cookie, which
   * after a fortnight is most of them.
   */
  const token = await readSessionToken();
  if (!token) redirect(`${base}/login`);

  const ctx = await resolveAuthContext(token, { tokens: tokenGenerator });
  if (!ctx.ok) redirect(`${base}/login`);

  const [structure, students] = await Promise.all([
    getStructure(ctx.value),
    can(ctx.value, 'student.read')
      ? listStudents(ctx.value, {
          ...(search ? { search } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 25,
        })
      : Promise.resolve(null),
  ]);

  const school = structure.ok ? structure.value.school : null;
  const currentYear = structure.ok ? structure.value.currentYear : null;
  const page = students?.ok ? students.value : null;

  return (
    <main className="mx-auto max-w-4xl p-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">{school?.nameBn ?? 'School'}</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          {school?.nameEn}
          {currentYear ? ` · ${currentYear.name}` : ' · no academic year is open'}
          {ctx.value.readOnly && ' · read-only'}
        </p>
      </header>

      {/*
        * Invariant 14 made visible. The server refuses writes regardless; a
        * banner is what stops somebody filling in a form for two minutes first.
        */}
      {ctx.value.readOnly && (
        <p
          role="status"
          className="mb-6 rounded border border-[var(--color-border)] px-3 py-2 text-sm"
        >
          This school is read-only. Records can be viewed but not changed.
        </p>
      )}

      <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Classes" value={structure.ok ? structure.value.classLevels.length : 0} />
        <Stat label="Sections" value={structure.ok ? structure.value.sections.length : 0} />
        <Stat label="Campuses" value={structure.ok ? structure.value.campuses.length : 0} />
        <Stat label="Shifts" value={structure.ok ? structure.value.shifts.length : 0} />
      </section>

      {page === null ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          You do not have permission to view students.
        </p>
      ) : (
        <section aria-labelledby="students">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="students" className="text-lg font-semibold">
              Students
            </h2>

            {/*
              * A GET form. It navigates, so the result is a real URL that can be
              * bookmarked and shared, the back button works, and none of it
              * needs JavaScript.
              */}
            <form method="get" className="flex gap-2">
              <label htmlFor="search" className="sr-only">
                Search by name or student code
              </label>
              <input
                id="search"
                name="search"
                defaultValue={search ?? ''}
                placeholder="Name or code"
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-base"
              />
              <button type="submit" className="min-h-11 rounded border border-[var(--color-border)] px-4">
                Search
              </button>
            </form>
          </div>

          {page.items.length === 0 ? (
            <p className="rounded border border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]">
              {search
                ? `Nobody matches “${search}”.`
                : 'No students yet. Admissions will appear here.'}
            </p>
          ) : (
            <StudentTable rows={page.items} base={base} />
          )}

          {page.hasMore && page.nextCursor && (
            <p className="mt-4">
              <Link
                href={`?${new URLSearchParams({
                  ...(search ? { search } : {}),
                  cursor: page.nextCursor,
                }).toString()}`}
                className="underline"
              >
                Next 25
              </Link>
            </p>
          )}
        </section>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4">
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-sm text-[var(--color-text-muted)]">{label}</p>
    </div>
  );
}

function StudentTable({ rows, base }: { rows: StudentRow[]; base: string }): React.JSX.Element {
  return (
    // The table scrolls inside its own container; the page never scrolls
    // sideways on a phone.
    <div className="overflow-x-auto rounded border border-[var(--color-border)]">
      <table className="w-full text-left text-sm">
        <thead className="bg-[var(--color-surface)]">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Name
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Code
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Class
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Roll
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-[var(--color-border)]">
              <td className="px-3 py-2">
                <Link href={`${base}/students/${r.id}`} className="underline">
                  {/* Bangla first: it is the name the school uses day to day,
                      and neither is a translation of the other (ADR-0019). */}
                  {r.nameBn}
                </Link>
                <span className="block text-[var(--color-text-muted)]">{r.nameEn}</span>
              </td>
              <td className="px-3 py-2 font-mono text-xs">{r.studentCode}</td>
              <td className="px-3 py-2">
                {r.classNameEn ?? '—'}
                {r.sectionNameEn ? ` ${r.sectionNameEn}` : ''}
              </td>
              <td className="px-3 py-2">{r.rollNo ?? '—'}</td>
              <td className="px-3 py-2">{r.status.replace('_', ' ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
