/**
 * Fee setup — heads and their prices. §13.1.
 *
 * What an accountant defines before either invoicing or collection means
 * anything: the fee heads a school charges, and what each costs by class
 * (optionally narrowed to a section). A SERVER component + two small client
 * forms, same shape `structure/page.tsx` already uses — the lists ship with
 * no JS, the two "add" panels are the only interactive islands.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveAuthContext, tokenGenerator } from '../../../../../../../modules/identity/index';
import { getStructure } from '../../../../../../../modules/structure/index';
import { listFeeHeads, listFeeStructures } from '../../../../../../../modules/finance/index';
import { readSessionToken } from '../../../../../../api/_lib/session-cookie';
import { can, isHouseholdOnly } from '../../../../../../../shared/auth-context';
import { appPath } from '../../../../../../../shared/paths';
import type { AcademicYearId } from '../../../../../../../shared/ids';
import { Card, CardContent, Badge } from '../../../../../../../components/ui';
import { EmptyState, MoneyText } from '../../../../../../../components/patterns';
import { AddFeeHead, AddFeeStructure, type Option } from './FeeSetupForms';

export const dynamic = 'force-dynamic';

const FREQUENCY_LABEL: Record<string, string> = {
  one_time: 'One-time',
  monthly: 'Monthly',
  term: 'Per term',
  annual: 'Annual',
};

export default async function FeesPage({
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

  if (!can(ctx.value, 'fee.read')) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <p className="text-sm text-[var(--color-text-muted)]">
          You do not have permission to view fee setup.
        </p>
      </main>
    );
  }

  const structure = await getStructure(ctx.value);
  const currentYearId = structure.ok ? (structure.value.currentYear?.id ?? null) : null;

  const [heads, structures] = await Promise.all([
    listFeeHeads(ctx.value),
    currentYearId
      ? listFeeStructures(ctx.value, { academicYearId: currentYearId as AcademicYearId })
      : Promise.resolve({ ok: true as const, value: [] }),
  ]);

  const manage = can(ctx.value, 'fee.structure.manage');
  const headOptions: Option[] = heads.ok
    ? heads.value.map((h) => ({ id: h.id, label: `${h.nameEn} (${h.code})` }))
    : [];
  const classOptions: Option[] = structure.ok
    ? structure.value.classLevels.map((c) => ({ id: c.id, label: c.nameEn }))
    : [];
  const classById = new Map(classOptions.map((c) => [c.id, c.label]));
  const sectionOptions: Option[] = structure.ok
    ? structure.value.sections.map((s) => ({
        id: s.id,
        label: `${classById.get(s.classLevelId) ?? '—'} · ${s.nameEn}`,
      }))
    : [];
  const sectionById = new Map(sectionOptions.map((s) => [s.id, s.label]));
  const headById = new Map(headOptions.map((h) => [h.id, h.label]));

  return (
    <main className="mx-auto max-w-4xl p-6">
      <p className="mb-4 text-sm">
        <Link href={`${base}/dashboard`} className="underline">
          ← Dashboard
        </Link>
      </p>

      <h1 className="mb-1 text-xl font-semibold">Fee setup</h1>
      <p className="mb-8 text-sm text-[var(--color-text-muted)]">
        What this school charges, and what each head costs by class.
      </p>

      <Section title="Fee heads" count={heads.ok ? heads.value.length : 0}>
        {!heads.ok || heads.value.length === 0 ? (
          <EmptyState
            title="No fee heads yet"
            description="Tuition, exam fee, transport — add the first one below."
          />
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {heads.value.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <span className="font-mono text-xs text-[var(--color-text-muted)]">
                  {h.code}
                </span>
                <span className="font-medium">{h.nameEn}</span>
                <Badge>{FREQUENCY_LABEL[h.frequency] ?? h.frequency}</Badge>
                {h.isRefundable && <Badge tone="success">Refundable</Badge>}
              </li>
            ))}
          </ul>
        )}
        {manage && (
          <div className="border-t border-[var(--color-border)] py-4">
            <AddFeeHead />
          </div>
        )}
      </Section>

      <Section
        title="Fee structures"
        count={structures.ok ? structures.value.length : 0}
        hint={
          structure.ok && structure.value.currentYear
            ? `Prices for ${structure.value.currentYear.name}, the current year.`
            : 'No academic year is open, so nothing can be priced yet.'
        }
      >
        {!structures.ok || structures.value.length === 0 ? (
          <EmptyState
            title="No prices set for this year"
            description="A fee head is not charged to anyone until it has a price."
          />
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {structures.value.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
              >
                <span>
                  <span className="font-medium">{headById.get(s.feeHeadId) ?? '—'}</span>{' '}
                  <span className="text-[var(--color-text-muted)]">
                    ·{' '}
                    {s.classLevelId
                      ? (classById.get(s.classLevelId) ?? 'class')
                      : (sectionById.get(s.sectionId ?? '') ?? 'section')}
                  </span>
                  {s.dueDay != null && (
                    <span className="text-[var(--color-text-muted)]"> · due day {s.dueDay}</span>
                  )}
                </span>
                <MoneyText minorUnits={s.amountMinor} className="font-medium" />
              </li>
            ))}
          </ul>
        )}
        {manage && currentYearId && (
          <div className="border-t border-[var(--color-border)] py-4">
            <AddFeeStructure
              academicYearId={currentYearId}
              feeHeads={headOptions}
              classLevels={classOptions}
              sections={sectionOptions}
            />
          </div>
        )}
      </Section>
    </main>
  );
}

function Section({
  title,
  count,
  hint,
  children,
}: {
  title: string;
  count: number;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="mb-10">
      <h2 className="mb-1 text-lg font-semibold">
        {title} <span className="text-sm font-normal text-[var(--color-text-muted)]">({count})</span>
      </h2>
      {hint && <p className="mb-2 text-sm text-[var(--color-text-muted)]">{hint}</p>}
      <Card>
        <CardContent className="pt-5">{children}</CardContent>
      </Card>
    </section>
  );
}
