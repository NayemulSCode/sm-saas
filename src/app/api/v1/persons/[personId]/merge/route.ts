/**
 * POST /api/v1/persons/:id/merge
 *
 * The path id is the record that SURVIVES; the body names the duplicate.
 * Dangerous: getting it wrong fuses two children's records together.
 */
import { mergePersons, MergePersonsSchema } from '../../../../../../modules/directory/index';
import type { PersonId } from '../../../../../../shared/ids';
import { authed } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed<
  ReturnType<typeof MergePersonsSchema.parse>,
  unknown,
  { personId: string }
>(MergePersonsSchema, (ctx, input, params) =>
  mergePersons(ctx, {
    winnerPersonId: params.personId as PersonId,
    loserPersonId: input.loserPersonId as PersonId,
    reason: input.reason,
  }),
);
