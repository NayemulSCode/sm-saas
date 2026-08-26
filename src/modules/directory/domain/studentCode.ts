/**
 * Student codes. FR-4.4 — "a configurable per-school pattern".
 *
 * Separate from `id` because a ULID is unusable in conversation at a counter:
 * "your son's number is 01JBQ8ZK9M3XN7R2VWD4TYFGHA" is not something anybody
 * says. The code is what appears on the ID card, the receipt and the class
 * list, and it is what a parent quotes on the phone.
 *
 * NOT gapless. Only receipt numbers are (non-negotiable 1), and for a reason:
 * a gap in receipts is an accounting question, whereas a gap in student codes
 * is a child who did not enrol.
 */

import { escapeRegExp } from './escape';

/** Tokens a school may use. Anything else is literal. */
const TOKEN = /\{(YYYY|YY|SEQ:(\d)|SEQ)\}/g;

export const DEFAULT_PATTERN = '{YYYY}-{SEQ:4}';

export interface PatternProblem {
  code: 'NO_SEQUENCE' | 'UNKNOWN_TOKEN' | 'TOO_LONG';
  detail: string;
}

/**
 * Checks a pattern before a school saves it.
 *
 * A pattern without a sequence token produces the same code for every student,
 * which the unique constraint refuses on the second admission — at the counter,
 * with a queue.
 */
export function validatePattern(pattern: string): PatternProblem | null {
  if (pattern.length > 40) {
    return { code: 'TOO_LONG', detail: 'a student code must fit on an ID card' };
  }

  const matches = [...pattern.matchAll(TOKEN)];
  if (!matches.some((m) => m[1]?.startsWith('SEQ'))) {
    return { code: 'NO_SEQUENCE', detail: 'the pattern must contain {SEQ} or {SEQ:n}' };
  }

  // Anything in braces that is not a token we know is a typo, not a literal.
  const unknown = [...pattern.matchAll(/\{([^}]*)\}/g)].filter(
    (m) => !/^(YYYY|YY|SEQ(:\d)?)$/.test(m[1] ?? ''),
  );
  if (unknown.length > 0) {
    return { code: 'UNKNOWN_TOKEN', detail: `unknown token {${unknown[0]![1]}}` };
  }

  return null;
}

/** Renders one code. `sequence` is the next number for this school and year. */
export function renderCode(pattern: string, year: number, sequence: number): string {
  return pattern.replace(TOKEN, (_match, token: string, width?: string) => {
    if (token === 'YYYY') return String(year);
    if (token === 'YY') return String(year).slice(-2);
    const pad = width ? Number(width) : 0;
    return String(sequence).padStart(pad, '0');
  });
}

/**
 * The numeric part of an existing code, for finding the next one.
 *
 * Returns undefined for a code that does not match, which is the honest answer
 * for a school that changed its pattern mid-year: the old codes stay valid and
 * simply do not contribute to the next number.
 */
export function sequenceOf(pattern: string, year: number, code: string): number | undefined {
  const match = patternRegExp(pattern, year).exec(code);
  const digits = match?.[1];
  return digits === undefined ? undefined : Number(digits);
}

/**
 * The pattern as a regular expression with the sequence captured.
 *
 * Built by WALKING the pattern rather than escaping a rendered string
 * afterwards: an escape pass has to distinguish the metacharacters it just
 * inserted from the ones that were already there, and that distinction is
 * exactly the kind of thing that works until a school uses a dot in its prefix.
 */
function patternRegExp(pattern: string, year: number): RegExp {
  let out = '';
  let last = 0;

  for (const m of pattern.matchAll(TOKEN)) {
    out += escapeRegExp(pattern.slice(last, m.index));
    const token = m[1] ?? '';
    if (token === 'YYYY') out += escapeRegExp(String(year));
    else if (token === 'YY') out += escapeRegExp(String(year).slice(-2));
    // String.raw, because a plain template literal turns `\d` into `d` —
    // JavaScript drops the backslash of an unrecognised escape, silently, and
    // the resulting pattern matches the letter d instead of a digit.
    else out += m[2] ? String.raw`(\d{${m[2]},})` : String.raw`(\d+)`;
    last = m.index + m[0].length;
  }
  out += escapeRegExp(pattern.slice(last));

  return new RegExp(`^${out}$`);
}

