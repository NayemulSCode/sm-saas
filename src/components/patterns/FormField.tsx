import { Label } from '../ui/Label';
import { Input } from '../ui/Input';
import { FieldError, FieldHint } from '../ui/FieldError';

export interface FormFieldProps {
  name: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  type?: string;
  required?: boolean;
  defaultValue?: string;
  placeholder?: string;
}

/**
 * Label + hint + input + error, wired together once: `aria-describedby` and
 * `aria-invalid` are easy to get right on one field and easy to drop on the
 * twentieth. One caller already needed exactly this by hand per field
 * (`students/new/AdmitForm.tsx`) — this is that, extracted so the next form
 * does not re-derive it.
 *
 * Composes `Input`; a field built on `Select` or `Textarea` instead is
 * assembled from `Label` + `FieldHint` + `FieldError` directly rather than
 * forced through this one shape.
 */
export function FormField({
  name,
  label,
  hint,
  error,
  type = 'text',
  required,
  defaultValue,
  placeholder,
}: FormFieldProps): React.JSX.Element {
  const hintId = hint ? `${name}-hint` : undefined;

  return (
    <div>
      <Label htmlFor={name}>{label}</Label>
      <FieldHint id={hintId}>{hint}</FieldHint>
      <Input
        id={name}
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        invalid={Boolean(error)}
        aria-describedby={hintId}
        aria-invalid={error ? true : undefined}
        className="mt-2"
      />
      <FieldError>{error}</FieldError>
    </div>
  );
}
