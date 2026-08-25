import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';

/**
 * Tenant shell — everything under <slug>.sm.example.com.
 *
 * Resolving the slug to a real tenant lands here in the next increment, once
 * the platform module exposes it. An unknown slug returns 404, never 403:
 * a 403 would confirm that a school exists on the platform (§7.3).
 */
export default async function TenantLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;

  // Placeholder for `platform.resolveTenantBySlug(slug)`. The shape of the
  // failure is fixed now so it cannot drift into a 403 later.
  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) notFound();

  return <div data-tenant={slug}>{children}</div>;
}
