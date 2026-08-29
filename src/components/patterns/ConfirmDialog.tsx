'use client';

/**
 * A two-step confirm: an idle trigger, then an inline panel in its place.
 *
 * Deliberately NOT an overlay/`<dialog>`. The one confirm flow already
 * shipped (`students/[studentId]/WithdrawButton.tsx`) uses this exact inline
 * shape — no backdrop, no focus trap to get right, and it degrades to plain
 * document flow on a small screen instead of fighting the viewport. This
 * component is that shape, generalised, so the next dangerous action does
 * not re-decide the interaction from scratch.
 *
 * Fully controlled: THIS component owns none of the network call. It hands
 * back the typed reason on confirm and renders whatever busy/error state the
 * caller is already tracking, because the error mapping (`VALIDATION_FAILED`
 * vs `ILLEGAL_TRANSITION`, what happens on success) is specific to the action
 * and cannot be guessed generically (§12.1: "returns it to the caller").
 */

import { useId, type FormEvent, type ReactNode } from 'react';
import { Button, type ButtonVariant } from '../ui/Button';
import { Label } from '../ui/Label';
import { Input } from '../ui/Input';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rendered in the idle state. Typically a `Button` that calls `onOpenChange(true)`. */
  trigger: ReactNode;
  title: string;
  description?: ReactNode;
  /** Omit for an action that needs no reason. */
  reason?: {
    value: string;
    onChange: (value: string) => void;
    label: string;
    placeholder?: string;
    minLength?: number;
  };
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  reason,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  error,
  onConfirm,
}: ConfirmDialogProps): React.JSX.Element {
  const reasonId = useId();

  if (!open) return <>{trigger}</>;

  function submit(e: FormEvent): void {
    e.preventDefault();
    onConfirm();
  }

  const borderTone = destructive ? 'border-[var(--color-danger)]' : 'border-[var(--color-border)]';
  const confirmVariant: ButtonVariant = destructive ? 'destructive' : 'primary';

  return (
    <form onSubmit={submit} className={`rounded-[var(--radius-lg)] border ${borderTone} p-4`}>
      <p className="mb-1 font-medium text-[var(--color-text)]">{title}</p>
      {description && <p className="mb-3 text-sm text-[var(--color-text-muted)]">{description}</p>}

      {reason && (
        <div className="mb-3">
          <Label htmlFor={reasonId}>{reason.label}</Label>
          <Input
            id={reasonId}
            value={reason.value}
            onChange={(e) => reason.onChange(e.target.value)}
            required
            minLength={reason.minLength}
            placeholder={reason.placeholder}
            className="mt-2"
          />
        </div>
      )}

      {error && (
        <p role="alert" className="mb-3 text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" variant={confirmVariant} disabled={busy}>
          {confirmLabel}
        </Button>
        <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
          {cancelLabel}
        </Button>
      </div>
    </form>
  );
}
