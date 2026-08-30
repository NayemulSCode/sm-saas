/**
 * My children — the guardian surface's first real screen.
 *
 * A SERVER component, same discipline as the staff dashboard: no client
 * JavaScript, because this is the TIGHTEST bundle budget in the product
 * (150 KB) and the audience is a guardian on whatever handset the household
 * owns, not an office desktop.
 *
 * `listMyChildren` is a dedicated, relationship-scoped read — never
 * `listStudents`/`getStudent`, which answer for any student in the tenant to
 * anyone holding `student.read`. Nothing about which children appear here
 * comes from the URL or the request; it comes entirely from `guardian_link`
 * rows already on file for the caller's own person id.
 *
 * Fees, attendance and results are not shown because they are not real yet —
 * Phase 3b. Saying so plainly here is the honest choice; a guardian screen
 * with blank space where a due amount should be reads as broken, not as
 * "coming soon".
 */

import { redirect } from 'next/navigation';
import { resolveAuthContext, tokenGenerator } from '../../../../../../../modules/identity/index';
import { listMyChildren, type MyChild } from '../../../../../../../modules/directory/index';
import type { StudentStatus } from '../../../../../../../modules/directory/index';
import { readSessionToken } from '../../../../../../api/_lib/session-cookie';
import { can } from '../../../../../../../shared/auth-context';
import { appPath } from '../../../../../../../shared/paths';
import { Card, CardContent, Badge, type BadgeTone } from '../../../../../../../components/ui';
import { EmptyState } from '../../../../../../../components/patterns';

export const dynamic = 'force-dynamic';

/** Full sentences, not the raw lifecycle enum — this audience is not staff. */
const STATUS_LABEL: Record<StudentStatus, string> = {
  applicant: 'Application submitted',
  admitted: 'Admitted — not yet enrolled',
  active: 'Currently enrolled',
  on_leave: 'On leave',
  withdrawn: 'Withdrawn',
  alumni: 'Completed studies here',
};

/** Only a state that needs attention gets colour; the ordinary case does not. */
const STATUS_TONE: Partial<Record<StudentStatus, BadgeTone>> = {
  on_leave: 'warning',
  withdrawn: 'danger',
};

const RELATIONSHIP_LABEL: Record<string, string> = {
  father: 'Father',
  mother: 'Mother',
  guardian: 'Guardian',
  emergency: 'Emergency contact',
  other: 'Other',
};

export default async function GuardianChildrenPage({
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
   * `listMyChildren` authorizes `student.read` and THROWS if it is missing —
   * inside a server component that is a 500 where a sentence was wanted
   * (same pitfall as `getStructure`, `promotions/page.tsx`). The Guardian role
   * template holds `student.read`; the Student template currently does not
   * (its permissions — attendance.read, result.read — are Phase 3b and are
   * not live yet), so a pure-Student account reaching this page has none.
   */
  if (!can(ctx.value, 'student.read')) {
    return (
      <main className="mx-auto max-w-lg p-6">
        <h1 className="text-xl font-semibold">My children</h1>
        <p className="mt-4 text-sm text-[var(--color-text-muted)]">
          You do not have permission to view this yet.
        </p>
      </main>
    );
  }

  const result = await listMyChildren(ctx.value);
  const children: MyChild[] = result.ok ? result.value : [];

  return (
    <main className="mx-auto max-w-lg p-6">
      <h1 className="text-xl font-semibold">My children</h1>
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">
        Fees, attendance and results are not part of this yet — they arrive
        with the next phase. This page shows who is enrolled and where.
      </p>

      {/*
        * `listMyChildren` has no failure path of its own today — everything
        * past the permission check above returns `ok`. This stays anyway: the
        * function's signature is `Result<...>` like every other read here, and
        * a page that trusts `.ok` without checking it is the kind that breaks
        * silently the day a real failure path is added.
        */}
      {!result.ok && (
        <p className="mt-6 rounded-[var(--radius-md)] border border-[var(--color-danger)] px-3 py-2 text-sm text-[var(--color-danger)]">
          Something went wrong loading your children. Try again in a moment.
        </p>
      )}

      {result.ok && children.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title="No children are linked to your account yet."
            description="If this is unexpected, contact the school office — they can check the record."
          />
        </div>
      )}

      {children.length > 0 && (
        <ul className="mt-6 flex flex-col gap-4">
          {children.map((c) => (
            <li key={c.studentId}>
              <ChildCard child={c} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function ChildCard({ child }: { child: MyChild }): React.JSX.Element {
  const tone = STATUS_TONE[child.status];

  const flags = [
    child.isBillingGuardian ? 'Billing guardian' : null,
    child.isPrimaryContact ? 'Primary contact' : null,
  ].filter((v): v is string => v !== null);

  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            {/* Bangla first: it is the name the household uses day to day,
                and neither name is a translation of the other (ADR-0019). */}
            <p className="font-medium">{child.nameBn}</p>
            <p className="text-sm text-[var(--color-text-muted)]">{child.nameEn}</p>
          </div>
          {tone && <Badge tone={tone}>{STATUS_LABEL[child.status]}</Badge>}
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div>
            <dt className="text-[var(--color-text-muted)]">Class</dt>
            <dd>
              {child.classNameEn ?? '—'}
              {child.sectionNameEn ? ` ${child.sectionNameEn}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--color-text-muted)]">Roll</dt>
            <dd>{child.rollNo ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-text-muted)]">Student code</dt>
            <dd className="font-mono text-xs">{child.studentCode}</dd>
          </div>
          {!tone && (
            <div>
              <dt className="text-[var(--color-text-muted)]">Status</dt>
              <dd>{STATUS_LABEL[child.status]}</dd>
            </div>
          )}
        </dl>

        <p className="mt-4 border-t border-[var(--color-border)] pt-3 text-sm text-[var(--color-text-muted)]">
          You are listed as {RELATIONSHIP_LABEL[child.relationship] ?? child.relationship}
          {flags.length > 0 ? ` · ${flags.join(' · ')}` : ''}.
        </p>
      </CardContent>
    </Card>
  );
}
