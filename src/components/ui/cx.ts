/**
 * Joins class names, dropping falsy values.
 *
 * Not `clsx`/`tailwind-merge`: this component set has a closed, hand-authored
 * variant list per component (see Button, Badge), so two Tailwind utilities
 * for the same property never collide in one class string. That is what
 * `tailwind-merge` is for — needed once a component accepts an arbitrary
 * `className` override that can CONFLICT with its own utilities, not for
 * joining strings that are already known not to.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
