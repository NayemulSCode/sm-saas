/**
 * Invoice generation — the trigger for §13.6's idempotent batch run.
 *
 * There is no list of past runs to show: no `listInvoices` use case exists
 * yet, and the audit log (`invoice.generated`) is not a UI surface. So this
 * is a single form, gated on the same `fee.structure.manage` permission
 * `generateInvoices` itself authorizes against — a server component for the
 * year picker's data, a small client island for the form and its result.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveAuthContext, tokenGenerator } from '../../../../../../../modules/identity/index';
import { getStructure } from '../../../../../../../modules/structure/index';
import { readSessionToken } from '../../../../../../api/_lib/session-cookie';
import { can, isHouseholdOnly } from '../../../../../../../shared/auth-context';
import { appPath } from '../../../../../../../shared/paths';
import { Card, CardContent } from '../../../../../../../components/ui';
import { GenerateInvoicesForm, type Option } from './GenerateInvoicesForm';

export const dynamic = 'force-dynamic';

export default async function InvoicesPage({
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

  if (isHouseholdOnly(ctx.value)) redirect(`${base}/children`);

  if (!can(ctx.value, 'fee.structure.manage')) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <p className="text-sm text-[var(--color-text-muted)]">
          You do not have permission to generate invoices.
        </p>
      </main>
    );
  }

  const structure = await getStructure(ctx.value);
  const years: Option[] = structure.ok
    ? structure.value.years.map((y) => ({ id: y.id, label: y.name }))
    : [];
  const currentYearId = structure.ok ? (structure.value.currentYear?.id ?? null) : null;

  return (
    <main className="mx-auto max-w-4xl p-6">
      <p className="mb-4 text-sm">
        <Link href={`${base}/dashboard`} className="underline">
          ← Dashboard
        </Link>
      </p>

      <h1 className="mb-1 text-xl font-semibold">Generate invoices</h1>
      <p className="mb-8 text-sm text-[var(--color-text-muted)]">
        Every active enrolment in the chosen year gets a line for each fee head
        that applies to it — a fee structure, an assignment override, an
        approved discount. Running this twice for the same period adds
        nothing the second time.
      </p>

      <Card>
        <CardContent className="pt-5">
          {years.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              No academic year is open at this school yet.
            </p>
          ) : (
            <GenerateInvoicesForm years={years} defaultAcademicYearId={currentYearId ?? ''} />
          )}
        </CardContent>
      </Card>
    </main>
  );
}
