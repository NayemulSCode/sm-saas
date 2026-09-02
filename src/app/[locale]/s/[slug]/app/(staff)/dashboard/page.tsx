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
 * office actually has. Everything below is `components/ui` + `components/patterns`
 * markup — presentation only, no behaviour moved.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveAuthContext, tokenGenerator } from '../../../../../../../modules/identity/index';
import { getStructure } from '../../../../../../../modules/structure/index';
import {
  listStudents,
  STUDENT_STATUSES,
  type StudentRow,
  type StudentStatus,
} from '../../../../../../../modules/directory/index';
import type { AcademicYearId, SectionId } from '../../../../../../../shared/ids';
import { zUlid } from '../../../../../../../shared/api/primitives';
import { readSessionToken } from '../../../../../../api/_lib/session-cookie';
import { can, isHouseholdOnly } from '../../../../../../../shared/auth-context';
import { appPath } from '../../../../../../../shared/paths';
import {
  Card,
  CardContent,
  Badge,
  buttonVariants,
  Select,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '../../../../../../../components/ui';
import { EmptyState, SectionPicker } from '../../../../../../../components/patterns';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{
    search?: string;
    cursor?: string;
    sectionId?: string;
    academicYearId?: string;
    status?: string;
  }>;
}

/**
 * The filters, taken from the query string and checked before they reach SQL.
 *
 * A query string is user input — it is typed, bookmarked, edited and pasted.
 * `status` lands in a comparison against a Postgres enum, so an unrecognised
 * value is a 500 rather than an empty list; the ids are converted to UUIDs, so
 * a malformed one throws. Both are dropped here instead.
 *
 * A WELL-FORMED id that belongs to another school is deliberately NOT special
 * cased: RLS answers it with no rows, which is the honest reply. Telling the
 * difference between "no students match" and "that section is not yours" is
 * exactly the leak the scope predicate exists to prevent.
 */
function readFilters(raw: {
  search?: string;
  sectionId?: string;
  academicYearId?: string;
  status?: string;
}): {
  search?: string;
  sectionId?: SectionId;
  academicYearId?: AcademicYearId;
  status?: StudentStatus;
} {
  const ulid = (v: string | undefined): string | undefined =>
    v !== undefined && zUlid().safeParse(v).success ? v : undefined;

  const search = raw.search?.trim();
  const sectionId = ulid(raw.sectionId);
  const academicYearId = ulid(raw.academicYearId);
  const status = (STUDENT_STATUSES as readonly string[]).includes(raw.status ?? '')
    ? (raw.status as StudentStatus)
    : undefined;

  return {
    ...(search ? { search } : {}),
    ...(sectionId ? { sectionId: sectionId as SectionId } : {}),
    ...(academicYearId ? { academicYearId: academicYearId as AcademicYearId } : {}),
    ...(status ? { status } : {}),
  };
}

export default async function DashboardPage({
  params,
  searchParams,
}: Props): Promise<React.JSX.Element> {
  const { locale } = await params;
  const query = await searchParams;
  const { cursor } = query;
  const filters = readFilters(query);
  const { search } = filters;
  const filtered = Object.keys(filters).length > 0;

  const base = appPath(locale);

  /*
   * Unauthenticated lands on the login page, not on a 403. A 403 on a page is a
   * dead end for a guardian who simply arrived with an expired cookie, which
   * after a fortnight is most of them.
   */
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

  const [structure, students] = await Promise.all([
    getStructure(ctx.value),
    can(ctx.value, 'student.read')
      ? listStudents(ctx.value, {
          ...filters,
          ...(cursor ? { cursor } : {}),
          limit: 25,
        })
      : Promise.resolve(null),
  ]);

  const classById = new Map(
    structure.ok ? structure.value.classLevels.map((c) => [c.id, c.nameEn]) : [],
  );
  const sectionOptions = structure.ok
    ? structure.value.sections.map((sec) => ({
        id: sec.id,
        label: `${classById.get(sec.classLevelId) ?? '—'} · ${sec.nameEn}`,
      }))
    : [];
  const yearOptions = structure.ok
    ? structure.value.years.map((y) => ({
        id: y.id,
        label: `${y.name}${y.isCurrent ? ' (current)' : ''}`,
      }))
    : [];

  const school = structure.ok ? structure.value.school : null;
  const currentYear = structure.ok ? structure.value.currentYear : null;
  const page = students?.ok ? students.value : null;

  return (
    <main className="mx-auto max-w-4xl p-6">
      {/* Plain links, so the whole app works without JavaScript and every
          screen is a URL somebody can bookmark or send to a colleague. */}
      <nav className="mb-6 flex gap-5 border-b border-[var(--color-border)] pb-4 text-sm">
        <Link href={`${base}/structure`} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          Structure
        </Link>
        <Link href={`${base}/staff`} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          Staff
        </Link>
        {can(ctx.value, 'enrolment.promote') && (
          <Link href={`${base}/promotions`} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            Promotion
          </Link>
        )}
        {can(ctx.value, 'fee.read') && (
          <Link href={`${base}/fees`} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            Fees
          </Link>
        )}
      </nav>

      <header className="mb-6">
        <h1 className="font-serif text-2xl text-[var(--color-text)]">{school?.nameBn ?? 'School'}</h1>
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
          className="mb-6 flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-warning)] bg-[color-mix(in_srgb,var(--color-warning)_12%,var(--color-surface-raised))] px-3 py-2 text-sm text-[var(--color-text)]"
        >
          <Badge tone="warning">Read-only</Badge>
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
            <h2 id="students" className="text-lg font-semibold text-[var(--color-text)]">
              Students
            </h2>

            {can(ctx.value, 'student.write') && (
              <Link href={`${base}/students/new`} className={buttonVariants({ size: 'sm' })}>
                Admit a student
              </Link>
            )}
          </div>

          {/*
            * A GET form. It navigates, so the result is a real URL that can be
            * bookmarked and shared, the back button works, and none of it needs
            * JavaScript.
            *
            * There is deliberately NO hidden cursor field. Submitting returns to
            * the first page, which is the only correct answer: a cursor is a
            * keyset position within one predicate, and carrying it across a
            * changed filter would resume in the middle of a different list and
            * silently skip everybody before that point.
            */}
          <form
            method="get"
            className="mb-4 grid gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 sm:grid-cols-4"
          >
            <label htmlFor="search" className="sr-only">
              Search by name or student code
            </label>
            <input
              id="search"
              name="search"
              defaultValue={search ?? ''}
              placeholder="Name or code"
              className="min-h-11 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-base text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]"
            />

            <label htmlFor="sectionId" className="sr-only">
              Section
            </label>
            <SectionPicker
              sections={sectionOptions}
              defaultValue={filters.sectionId ?? ''}
              emptyOptionLabel="Every section"
            />

            <label htmlFor="status" className="sr-only">
              Status
            </label>
            <Select id="status" name="status" defaultValue={filters.status ?? ''}>
              <option value="">Every status</option>
              {STUDENT_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {st.replace('_', ' ')}
                </option>
              ))}
            </Select>

            <label htmlFor="academicYearId" className="sr-only">
              Academic year
            </label>
            <Select id="academicYearId" name="academicYearId" defaultValue={filters.academicYearId ?? ''}>
              {/*
                * "Latest enrolment" rather than "every year": the list shows ONE
                * class and roll per student, so with no year named that is
                * whichever enrolment the join happens to pick. Naming a year is
                * what makes the Class and Roll columns mean something exact.
                */}
              <option value="">Latest enrolment</option>
              {yearOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>

            <div className="flex items-center gap-3 sm:col-span-4">
              <button type="submit" className={buttonVariants({ variant: 'secondary', size: 'md' })}>
                Apply
              </button>
              {filtered && (
                <Link href="?" className="text-sm text-[var(--color-text-muted)] underline hover:text-[var(--color-text)]">
                  Clear filters
                </Link>
              )}
            </div>
          </form>

          {page.items.length === 0 ? (
            <EmptyState
              title={filtered ? 'Nobody matches these filters.' : 'No students yet.'}
              description={filtered ? undefined : 'Admissions will appear here.'}
            />
          ) : (
            <StudentTable rows={page.items} base={base} />
          )}

          {page.hasMore && page.nextCursor && (
            <p className="mt-4">
              <Link
                // Every filter travels with the cursor. Drop one here and page
                // two quietly widens to the whole school.
                href={`?${new URLSearchParams({
                  ...filters,
                  cursor: page.nextCursor,
                }).toString()}`}
                className={buttonVariants({ variant: 'ghost', size: 'sm' })}
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
    <Card>
      <CardContent className="pt-5">
        <p className="text-2xl font-semibold text-[var(--color-text)]">{value}</p>
        <p className="text-sm text-[var(--color-text-muted)]">{label}</p>
      </CardContent>
    </Card>
  );
}

function StudentTable({ rows, base }: { rows: StudentRow[]; base: string }): React.JSX.Element {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Code</TableHead>
          <TableHead>Class</TableHead>
          <TableHead>Roll</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell>
              <Link href={`${base}/students/${r.id}`} className="text-[var(--brand-primary)] underline">
                {/* Bangla first: it is the name the school uses day to day,
                    and neither is a translation of the other (ADR-0019). */}
                {r.nameBn}
              </Link>
              <span className="block text-[var(--color-text-muted)]">{r.nameEn}</span>
            </TableCell>
            <TableCell className="font-mono text-xs">{r.studentCode}</TableCell>
            <TableCell>
              {r.classNameEn ?? '—'}
              {r.sectionNameEn ? ` ${r.sectionNameEn}` : ''}
            </TableCell>
            <TableCell>{r.rollNo ?? '—'}</TableCell>
            <TableCell>{r.status.replace('_', ' ')}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
