/**
 * The school's PUBLIC site — students, guardians, applicants.
 *
 * No session is read here. Once Puck lands this renders tenant-authored
 * content, which makes it the largest untrusted-input surface in the platform;
 * data-bound blocks read a hand-written PublicProjection and never the
 * tenant's tables (ADR-0022).
 */
export default async function SchoolPublicPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">{slug}</h1>
      <p className="mt-2 text-[var(--color-text-muted)]">
        Public school site — notices, admission, result lookup. Phase 2 (CMS).
      </p>
    </main>
  );
}
