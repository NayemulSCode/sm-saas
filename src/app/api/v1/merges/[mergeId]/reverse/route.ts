/**
 * POST /api/v1/merges/:id/reverse
 *
 * Puts back exactly the rows that merge moved, by id — never everything
 * currently pointing at the winner.
 */
import { unmergePersons, UnmergePersonsSchema } from '../../../../../../modules/directory/index';
import { authed } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed<{ reason: string }, { reversed: boolean }, { mergeId: string }>(
  UnmergePersonsSchema,
  (ctx, input, params) =>
    unmergePersons(ctx, { mergeId: params.mergeId, reason: input.reason }),
);
