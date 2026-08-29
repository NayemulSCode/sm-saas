import { Select, type SelectProps } from '../ui/Select';

export interface SectionOption {
  id: string;
  label: string;
}

export interface SectionPickerProps extends Omit<SelectProps, 'children'> {
  sections: SectionOption[];
  /**
   * Label for a leading empty option (e.g. "Every section"), for a filter.
   * Omit for a required field where every option is a real section
   * (an admission form has nothing sensible to enrol a student into
   * otherwise).
   */
  emptyOptionLabel?: string;
}

/**
 * Scope-aware by construction: it renders exactly the `sections` it is
 * given and nothing else, so a teacher can only ever be offered a section
 * already inside `ctx.scope` — the caller does the scoping (structure module
 * + auth context), this only refuses to add options of its own (§12.1).
 */
export function SectionPicker({
  sections,
  emptyOptionLabel,
  name = 'sectionId',
  id = 'sectionId',
  ...props
}: SectionPickerProps): React.JSX.Element {
  return (
    <Select name={name} id={id} {...props}>
      {emptyOptionLabel && <option value="">{emptyOptionLabel}</option>}
      {sections.map((s) => (
        <option key={s.id} value={s.id}>
          {s.label}
        </option>
      ))}
    </Select>
  );
}
