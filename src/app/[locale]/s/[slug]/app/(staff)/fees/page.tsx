/**
 * Fee administration: what a school charges for, and what it costs.
 *
 * Deliberately not the fee COLLECTION screen (§12.4) — that is the one
 * where a guardian is standing at the counter, and it needs its own
 * purpose-built interaction model (search, live allocation preview,
 * receipt printing) rather than a page built alongside something else.
 * This is the simpler, lower-stakes screen behind it: defining fees and
 * their prices, so there is something for collection to charge against.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveAuthContext, tokenGenerator } from '../../../../../../../modules/identity/index';
import { getStructure } from '../../../../../../../modules/structure/index';
import { listFeeHeads, listFeeStructures } from '../../../../../../../modules/finance/index';
import { readSessionToken } from '../../../../../../api/_lib/session-cookie';
import { can } from '../../../../../../../shared/auth-context';
import { appPath } from '../../../../../../../shared/paths';
import type { AcademicYearId } from '../../../../../../../shared/ids';
import { Badge, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../../../../../../components/ui';
import { EmptyState, MoneyText } from '../../../../../../../components/patterns';
import { AddFeeHead, AddFeeStructure, type Option } from './FeeForms';

export const dynamic = 'force-dynamic';

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

  if (!can(ctx.value, 'fee.read')) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <p className="mb-4 text-sm">
          <Link href={`${base}/dashboard`} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            ← Dashboard
          </Link>
        </p>
        <p className="text-sm text-[var(--color-text-muted)]">
          You do not have permission to view fees.
        </p>
      </main>
    );
  }

  const structureResult = await getStructure(ctx.value);
  if (!structureResult.ok) redirect(`${base}/dashboard`);
  const s = structureResult.value;
  const currentYear = s.currentYear;

  const [headsResult, structuresResult] = await Promise.all([
    listFeeHeads(ctx.value),
    currentYear
      ? listFeeStructures(ctx.value, currentYear.id as AcademicYearId)
      : Promise.resolve({ ok: true as const, value: [] }),
  ]);

  const heads = headsResult.ok ? headsResult.value : [];
  const structures = structuresResult.ok ? structuresResult.value : [];
  const canManage = can(ctx.value, 'fee.structure.manage');

  const headById = new Map(heads.map((h) => [h.id, h]));
  const classById = new Map(s.classLevels.map((c) => [c.id, c.nameEn]));
  const sectionById = new Map(s.sections.map((sec) => [sec.id, `${classById.get(sec.classLevelId) ?? '—'} · ${sec.nameEn}`]));

  const headOptions: Option[] = heads.map((h) => ({ id: h.id, label: `${h.nameEn} (${h.code})` }));
  const classOptions: Option[] = s.classLevels.map((c) => ({ id: c.id, label: c.nameEn }));
  const sectionOptions: Option[] = s.sections.map((sec) => ({
    id: sec.id,
    label: `${classById.get(sec.classLevelId) ?? '—'} · ${sec.nameEn}`,
  }));

  return (
    <main className="mx-auto max-w-4xl p-6">
      <p className="mb-4 text-sm">
        <Link href={`${base}/dashboard`} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          ← Dashboard
        </Link>
      </p>

      <h1 className="font-serif text-2xl text-[var(--color-text)]">Fees</h1>
      <p className="mt-2 mb-8 text-[var(--color-text-muted)]">
        What this school charges for, and what it costs by class or section.
        Collecting a payment against these is a separate screen, not built yet.
      </p>

      <section className="mb-10">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-[var(--color-text)]">Fee heads</h2>
          {canManage && <AddFeeHead />}
        </div>

        {heads.length === 0 ? (
          <EmptyState title="No fees defined yet." description="Add one to start pricing it by class." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Frequency</TableHead>
                <TableHead>Order</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {heads.map((h) => (
                <TableRow key={h.id}>
                  <TableCell>
                    {h.nameBn}
                    <span className="block text-[var(--color-text-muted)]">{h.nameEn}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{h.code}</TableCell>
                  <TableCell>
                    {h.frequency.replace('_', '-')}
                    {h.isRefundable && (
                      <Badge tone="neutral" className="ml-2">
                        refundable
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{h.sequence}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-[var(--color-text)]">
            Prices{currentYear ? ` — ${currentYear.name}` : ''}
          </h2>
          {canManage && (
            <AddFeeStructure
              academicYearId={currentYear?.id ?? ''}
              feeHeads={headOptions}
              classLevels={classOptions}
              sections={sectionOptions}
            />
          )}
        </div>

        {!currentYear ? (
          <EmptyState title="No academic year is open, so nothing can be priced yet." />
        ) : structures.length === 0 ? (
          <EmptyState title="No prices set for this year yet." description="Price a fee by class or section above." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fee</TableHead>
                <TableHead>Applies to</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Due day</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {structures.map((st) => (
                <TableRow key={st.id}>
                  <TableCell>{headById.get(st.feeHeadId)?.nameEn ?? '—'}</TableCell>
                  <TableCell>
                    {st.classLevelId
                      ? `${classById.get(st.classLevelId) ?? '—'} (whole class)`
                      : (sectionById.get(st.sectionId!) ?? '—')}
                  </TableCell>
                  <TableCell>
                    <MoneyText minor={st.amountMinor} />
                  </TableCell>
                  <TableCell>{st.dueDay ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </main>
  );
}
