import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '../globals.css';

/**
 * The root layout.
 *
 * It lives under `[locale]` rather than at `app/` because every request is
 * rewritten to `/<locale>/...` by middleware, and `lang` must reflect the
 * actual locale — a screen reader switching voice depends on it (§28.3).
 */

export const metadata: Metadata = {
  title: 'School Management',
  robots: { index: false, follow: false }, // flipped per surface once real
};

const LOCALES = ['bn', 'en'] as const;

export function generateStaticParams(): Array<{ locale: string }> {
  return LOCALES.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}): Promise<React.JSX.Element> {
  const { locale } = await params;
  const lang = (LOCALES as readonly string[]).includes(locale) ? locale : 'bn';

  return (
    <html lang={lang} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
