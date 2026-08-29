'use client';

/**
 * The last-resort error boundary, and the only one that renders its OWN
 * `<html>` and `<body>` — it replaces the root layout rather than nesting
 * inside it, which is why it cannot reuse any of the app's chrome.
 *
 * Without it an unhandled render error shows Next's unstyled default screen.
 * The build does not need this file; it is here so a failure in front of a
 * school looks like a product rather than a stack trace.
 *
 * Deliberately plain: no translations (the locale is exactly what we may have
 * failed to resolve), no brand tokens (`globals.css` may not have loaded), and
 * no error text — it can carry a query, an id or a name. The digest is what
 * support asks for and what appears in the server log.
 */

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          margin: 0,
          display: 'grid',
          placeItems: 'center',
          minHeight: '100vh',
          padding: '1.5rem',
        }}
      >
        <main style={{ maxWidth: '32rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ marginTop: '0.5rem', lineHeight: 1.5 }}>
            The page could not be shown. Nothing you were doing has been saved.
          </p>
          {error.digest && (
            <p style={{ marginTop: '1rem', fontSize: '0.875rem', opacity: 0.7 }}>
              Reference: <code>{error.digest}</code>
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '1.5rem',
              minHeight: '2.75rem',
              padding: '0 1.5rem',
              borderRadius: '0.25rem',
              border: '1px solid currentColor',
              background: 'transparent',
              font: 'inherit',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
