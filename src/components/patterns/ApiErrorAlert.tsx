/**
 * The one error-display shape used after every mutating POST in this app:
 * a resolved message plus the request id, when the server sent one.
 *
 * The RESOLUTION (`MESSAGES[error.code] ?? error.message`) stays at the call
 * site — each action provokes different codes and means something different
 * by each — this only renders the result, so that part is not duplicated too.
 * Lifted out of `PromotionForms.tsx` and `MergeForms.tsx`, which had this
 * defined identically, byte for byte, in both files.
 */
export interface ApiError {
  code: string;
  message: string;
  requestId: string;
}

export function ApiErrorAlert({
  text,
  requestId,
  className,
}: {
  text: string;
  requestId?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <p
      role="alert"
      className={`rounded-[var(--radius-md)] border border-[var(--color-danger)] px-3 py-2 text-sm text-[var(--color-danger)] ${className ?? ''}`}
    >
      {text}
      {requestId && (
        <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
          Reference: {requestId}
        </span>
      )}
    </p>
  );
}
