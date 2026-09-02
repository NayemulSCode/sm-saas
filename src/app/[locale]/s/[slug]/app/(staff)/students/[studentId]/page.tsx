/**
 * One student. The record an office assistant opens when a parent is at the
 * counter, so everything they will be asked is on one screen: who the child is,
 * which class, who to ring, and what has happened to them.
 *
 * A server component calling the use cases directly. No client JavaScript on
 * the read path — the page is complete when the HTML arrives.
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { resolveAuthContext, tokenGenerator } from '../../../../../../../../modules/identity/index';
import { getStudent } from '../../../../../../../../modules/directory/index';
import { listOutstanding, listPaymentsForStudent } from '../../../../../../../../modules/finance/index';
import type { StudentId } from '../../../../../../../../shared/ids';
import { readSessionToken } from '../../../../../../../api/_lib/session-cookie';
import { can, isHouseholdOnly } from '../../../../../../../../shared/auth-context';
import { WithdrawButton } from './WithdrawButton';
import { Guardians, type GuardianRow } from './Guardians';
import { EditDetails, type EditableStudent } from './EditDetails';
import { CollectPayment } from './CollectPayment';
import { PaymentHistory } from './PaymentHistory';
import { appPath } from '../../../../../../../../shared/paths';

export const dynamic = 'force-dynamic';

interface Enrolment {
  id: string;
  sectionId: string;
  academicYearId: string;
  rollNo: number | null;
  outcome: string | null;
  enrolledOn: unknown;
}

interface HistoryEntry {
  fromStatus: string | null;
  toStatus: string;
  reason: string | null;
  effectiveDate: unknown;
}

interface StudentView {
  student: EditableStudent & {
    id: string;
    studentCode: string;
    status: string;
  };
  enrolments: Enrolment[];
  guardians: GuardianRow[];
  history: HistoryEntry[];
}

export default async function StudentPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string; studentId: string }>;
}): Promise<React.JSX.Element> {
  const { locale, studentId } = await params;
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

  const result = await getStudent(ctx.value, studentId as StudentId);
  // A student in another school is absent, not forbidden — RLS makes the row
  // invisible, and a 403 would confirm the id exists somewhere.
  if (!result.ok) notFound();

  const view = result.value as StudentView;
  const { student, enrolments, guardians, history } = view;
  const current = enrolments[0];

  // `fee.collect` gates the section entirely rather than showing it
  // read-only for `fee.read`-only callers: on the STAFF surface the two sets
  // of holders are identical except Guardian, who never reaches this page
  // (redirected above by `isHouseholdOnly`).
  const canCollect = can(ctx.value, 'fee.collect');
  const outstanding = canCollect ? await listOutstanding(ctx.value, student.id as StudentId) : null;

  const canViewPayments = can(ctx.value, 'fee.read');
  const payments = canViewPayments
    ? await listPaymentsForStudent(ctx.value, student.id as StudentId)
    : null;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <p className="mb-4 text-sm">
        <Link href={`${base}/dashboard`} className="underline">
          ← All students
        </Link>
      </p>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          {/* Bangla first: the name the school uses day to day, and neither is
              a translation of the other (ADR-0019). */}
          <h1 className="text-2xl font-semibold">{student.nameBn}</h1>
          <p className="text-[var(--color-text-muted)]">{student.nameEn}</p>
          <p className="mt-2 font-mono text-sm">{student.studentCode}</p>
        </div>
        <div className="text-right">
          <StatusBadge status={student.status} />
          {current?.rollNo != null && (
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
              Roll {current.rollNo}
            </p>
          )}
        </div>
      </header>

      {/* Actions are permission-gated in the UI AND on the server. The server
          is what enforces it; hiding the button is what stops somebody filling
          in a form they were never allowed to submit. */}
      <div className="mb-8 flex flex-wrap gap-3">
        {can(ctx.value, 'student.write') && (
          <EditDetails studentId={student.id} student={student} />
        )}
        {can(ctx.value, 'student.transition') && student.status !== 'withdrawn' && (
          <WithdrawButton studentId={student.id} redirectTo={`${base}/dashboard`} />
        )}
      </div>

      {canCollect && outstanding && (
        <Section title="Fees" count={outstanding.ok ? outstanding.value.length : 0}>
          {outstanding.ok ? (
            <CollectPayment
              studentId={student.id}
              outstanding={outstanding.value}
              canBackdate={can(ctx.value, 'fee.backdate')}
            />
          ) : (
            <Empty>Something went wrong loading what this student owes.</Empty>
          )}
        </Section>
      )}

      {canViewPayments && payments && (
        <Section title="Payments" count={payments.ok ? payments.value.length : 0}>
          {payments.ok ? (
            <PaymentHistory
              payments={payments.value}
              canReverse={can(ctx.value, 'fee.refund')}
              canBackdate={can(ctx.value, 'fee.backdate')}
            />
          ) : (
            <Empty>Something went wrong loading this student&apos;s payments.</Empty>
          )}
        </Section>
      )}

      <Section title="Guardians" count={guardians.length}>
        <Guardians
          studentId={student.id}
          guardians={guardians}
          canWrite={can(ctx.value, 'guardian.write')}
        />
      </Section>

      <Section title="Enrolments" count={enrolments.length}>
        {enrolments.length === 0 ? (
          <Empty>Not enrolled in any section.</Empty>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {enrolments.map((e) => (
              <li key={e.id} className="flex items-center gap-3 py-3 text-sm">
                <span className="font-mono text-xs">{e.sectionId}</span>
                <span>Roll {e.rollNo ?? '—'}</span>
                {/* The outcome is what turned last year's enrolment into
                    history; a live one has none. */}
                <span className="ml-auto text-[var(--color-text-muted)]">
                  {e.outcome ?? 'current'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="History" count={history.length}>
        <ol className="divide-y divide-[var(--color-border)]">
          {history.map((h, i) => (
            <li key={i} className="py-3 text-sm">
              <span className="font-medium">
                {h.fromStatus ? `${h.fromStatus} → ${h.toStatus}` : `admitted as ${h.toStatus}`}
              </span>
              <span className="ml-2 text-[var(--color-text-muted)]">
                {String(h.effectiveDate).slice(0, 10)}
              </span>
              {/* The reason is the answer to "why did you mark my child
                  withdrawn?", which is the question this table exists for. */}
              {h.reason && <p className="mt-1 text-[var(--color-text-muted)]">{h.reason}</p>}
            </li>
          ))}
        </ol>
      </Section>
    </main>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-lg font-semibold">
        {title}{' '}
        <span className="text-sm font-normal text-[var(--color-text-muted)]">({count})</span>
      </h2>
      <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4">
        {children}
      </div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="py-6 text-sm text-[var(--color-text-muted)]">{children}</p>;
}

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const danger = status === 'withdrawn';
  return (
    <span
      className={`rounded px-2 py-1 text-sm ${
        danger
          ? 'border border-[var(--color-danger)] text-[var(--color-danger)]'
          : 'border border-[var(--color-border)]'
      }`}
    >
      {status.replace('_', ' ')}
    </span>
  );
}
