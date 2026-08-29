/**
 * The shape of the school: years, classes, sections, campuses and shifts.
 *
 * §14.4 calls structure "small and boring, and everything else depends on it".
 * The screen reflects that — it is a set of lists with a form beside each,
 * because the interesting part is what the server refuses, not what the page
 * does.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveAuthContext, tokenGenerator } from '../../../../../../../modules/identity/index';
import { getStructure } from '../../../../../../../modules/structure/index';
import { readSessionToken } from '../../../../../../api/_lib/session-cookie';
import { can } from '../../../../../../../shared/auth-context';
import {
  AddClassLevel,
  AddSection,
  AddShift,
  OpenYear,
  CloseYear,
  type Option,
} from './StructureForms';

export const dynamic = 'force-dynamic';

export default async function StructurePage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<React.JSX.Element> {
  const { locale, slug } = await params;
  const base = `/${locale}/s/${slug}/app`;

  const token = await readSessionToken();
  if (!token) redirect(`${base}/login`);

  const ctx = await resolveAuthContext(token, { tokens: tokenGenerator });
  if (!ctx.ok) redirect(`${base}/login`);

  if (!can(ctx.value, 'structure.read')) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <p className="text-sm text-[var(--color-text-muted)]">
          You do not have permission to view the school structure.
        </p>
      </main>
    );
  }

  const result = await getStructure(ctx.value);
  if (!result.ok) redirect(`${base}/dashboard`);
  const s = result.value;

  const manage = can(ctx.value, 'structure.manage');
  const manageYears = can(ctx.value, 'academicYear.manage');
  const closeYears = can(ctx.value, 'academicYear.close');

  const classById = new Map(s.classLevels.map((c) => [c.id, c.nameEn]));
  const campusById = new Map(s.campuses.map((c) => [c.id, c.nameEn]));

  const classOptions: Option[] = s.classLevels.map((c) => ({ id: c.id, label: c.nameEn }));
  const campusOptions: Option[] = s.campuses.map((c) => ({ id: c.id, label: c.nameEn }));
  const shiftOptions = s.shifts.map((sh) => ({
    id: sh.id,
    label: `${sh.nameEn} (${String(sh.startTime).slice(0, 5)}–${String(sh.endTime).slice(0, 5)})`,
    campusId: sh.campusId,
  }));

  return (
    <main className="mx-auto max-w-4xl p-6">
      <p className="mb-4 text-sm">
        <Link href={`${base}/dashboard`} className="underline">
          ← Dashboard
        </Link>
      </p>

      <h1 className="text-xl font-semibold">{s.school.nameBn}</h1>
      <p className="mb-8 text-[var(--color-text-muted)]">{s.school.nameEn}</p>

      <Block
        title="Academic years"
        action={manageYears && <OpenYear schoolId={s.school.id} />}
      >
        {s.years.length === 0 ? (
          <Empty>
            No academic year is open, so nobody can be enrolled.
          </Empty>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {s.years.map((y) => (
              <li key={y.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="font-medium">{y.name}</span>
                <span className="text-sm text-[var(--color-text-muted)]">
                  {String(y.startDate.y)}-
                  {String(y.startDate.m).padStart(2, '0')}-
                  {String(y.startDate.d).padStart(2, '0')} to{' '}
                  {String(y.endDate.y)}-
                  {String(y.endDate.m).padStart(2, '0')}-
                  {String(y.endDate.d).padStart(2, '0')}
                </span>
                {y.isCurrent && <Badge>current</Badge>}
                <Badge muted>{y.status}</Badge>
                {/* Only a demoted year can be closed. Offering the control on
                    the current one would be offering a guaranteed refusal. */}
                {closeYears && !y.isCurrent && y.status !== 'closed' && (
                  <span className="ml-auto">
                    <CloseYear academicYearId={y.id} name={y.name} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block
        title="Classes"
        hint="The order is promotion order — it decides what “the next class up” means."
        action={manage && <AddClassLevel schoolId={s.school.id} />}
      >
        <ol className="divide-y divide-[var(--color-border)]">
          {s.classLevels.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2 text-sm">
              <span className="w-12 font-mono text-xs text-[var(--color-text-muted)]">
                {c.sequence}
              </span>
              <span>{c.nameEn}</span>
            </li>
          ))}
        </ol>
      </Block>

      <Block
        title="Sections"
        action={
          manage && (
            <AddSection
              schoolId={s.school.id}
              classLevels={classOptions}
              campuses={campusOptions}
              shifts={shiftOptions}
            />
          )
        }
      >
        {s.sections.length === 0 ? (
          <Empty>No sections yet. A student has to be enrolled into one.</Empty>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {s.sections.map((sec) => (
              <li key={sec.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="font-medium">
                  {classById.get(sec.classLevelId) ?? 'Class'} — {sec.nameEn}
                </span>
                <span className="text-[var(--color-text-muted)]">
                  {campusById.get(sec.campusId) ?? 'campus'}
                </span>
                {sec.capacity != null && (
                  <span className="ml-auto text-[var(--color-text-muted)]">
                    capacity {sec.capacity}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block
        title="Campuses and shifts"
        hint="A shift is a first-class thing, not a label on a section: it has its own timetable and working-day calendar."
        action={manage && <AddShift campuses={campusOptions} />}
      >
        <ul className="divide-y divide-[var(--color-border)]">
          {s.campuses.map((c) => (
            <li key={c.id} className="py-3">
              <p className="font-medium">
                {c.nameEn} {c.isPrimary && <Badge>primary</Badge>}
              </p>
              <ul className="mt-1 flex flex-wrap gap-2">
                {s.shifts
                  .filter((sh) => sh.campusId === c.id)
                  .map((sh) => (
                    <li key={sh.id} className="text-sm text-[var(--color-text-muted)]">
                      {sh.nameEn} {String(sh.startTime).slice(0, 5)}–
                      {String(sh.endTime).slice(0, 5)}
                    </li>
                  ))}
              </ul>
            </li>
          ))}
        </ul>
      </Block>
    </main>
  );
}

function Block({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="mb-10">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {action}
      </div>
      {hint && <p className="mb-2 text-sm text-[var(--color-text-muted)]">{hint}</p>}
      <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4">
        {children}
      </div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="py-6 text-sm text-[var(--color-text-muted)]">{children}</p>;
}

function Badge({
  children,
  muted,
}: {
  children: React.ReactNode;
  muted?: boolean;
}): React.JSX.Element {
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs ${
        muted
          ? 'border border-[var(--color-border)] text-[var(--color-text-muted)]'
          : 'bg-[var(--brand-primary)] text-[var(--brand-on-primary)]'
      }`}
    >
      {children}
    </span>
  );
}
