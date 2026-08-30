export function FieldError({ children }: { children?: string | undefined }): React.JSX.Element | null {
  if (!children) return null;
  return <p className="mt-1 text-sm text-[var(--color-danger)]">{children}</p>;
}

export function FieldHint({
  id,
  children,
}: {
  id?: string | undefined;
  children?: string | undefined;
}): React.JSX.Element | null {
  if (!children) return null;
  return (
    <p id={id} className="mt-1 text-sm text-[var(--color-text-muted)]">
      {children}
    </p>
  );
}
