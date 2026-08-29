import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor, toPage } from './keyset';

describe('cursors', () => {
  it('round-trips', () => {
    const c = { sort: '2027-03-14', id: '01JBQ8ZK9M3XN7R2VWD4TYFGHA' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('survives a sort value containing spaces', () => {
    // Split on the FIRST space, so anything after it is the id and anything
    // before it is the sort value however many spaces it has.
    const c = { sort: 'Mohammad Rahman', id: 'x' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('survives Bangla in the sort value', () => {
    const c = { sort: 'রুমানা হক', id: '01JBQ8ZK9M3XN7R2VWD4TYFGHA' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('is url-safe, because it lives in a query string', () => {
    const encoded = encodeCursor({ sort: 'a/b+c=d', id: 'x' });
    expect(encoded).not.toMatch(/[+/=]/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });

  /*
   * A cursor arrives in a URL, which means it gets bookmarked, truncated and
   * pasted. A stale one should restart the list, not 500.
   */
  describe('malformed input restarts the list rather than throwing', () => {
    it.each([
      ['undefined', undefined],
      ['empty', ''],
      ['not base64', '!!!!'],
      ['no separator', Buffer.from('nospace', 'utf8').toString('base64url')],
      ['empty id', Buffer.from('sort ', 'utf8').toString('base64url')],
      ['empty sort', Buffer.from(' id', 'utf8').toString('base64url')],
    ])('%s', (_label, input) => {
      expect(decodeCursor(input)).toBeUndefined();
    });
  });
});

describe('toPage', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, sort: 's' }));
  const cursorOf = (r: { id: string; sort: string }) => ({ sort: r.sort, id: r.id });

  it('reports no more when the extra row is absent', () => {
    const page = toPage(rows(3), 5, cursorOf);
    expect(page.items).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  /*
   * Querying limit + 1 is how "is there a next page?" gets answered without a
   * second count(*) over the same predicate.
   */
  it('trims the probe row and reports more', () => {
    const page = toPage(rows(6), 5, cursorOf);
    expect(page.items).toHaveLength(5);
    expect(page.hasMore).toBe(true);
    expect(decodeCursor(page.nextCursor!)?.id).toBe('id-4');
  });

  it('is exact at the boundary', () => {
    const page = toPage(rows(5), 5, cursorOf);
    expect(page.items).toHaveLength(5);
    expect(page.hasMore).toBe(false);
  });

  it('handles an empty result', () => {
    const page = toPage([], 25, cursorOf);
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  // The cursor points at the LAST row returned, never the probe row.
  it('takes the cursor from the last visible row', () => {
    const page = toPage(rows(11), 10, cursorOf);
    expect(decodeCursor(page.nextCursor!)?.id).toBe('id-9');
  });
});
