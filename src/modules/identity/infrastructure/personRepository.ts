/**
 * Creating the person an invite is for.
 *
 * `directory` owns the person MODEL — its lifecycle, its merges, its
 * duplicates. This writes the two columns an invite needs and nothing else,
 * rather than identity importing directory's use case: the boundary rules
 * forbid reaching into another module's internals, and going through its
 * public surface would make a school unable to invite anybody until the
 * directory module shipped.
 */

import type { Tx } from '../../../db/rls';
import { person } from '../../../db/schema/directory';
import { Ids } from '../../../shared/ids';
import type { PersonId } from '../../../shared/ids';

export const people = {
  async create(
    tx: Tx,
    input: { nameBn: string; nameEn: string; actorId: PersonId },
  ): Promise<PersonId> {
    const id = Ids.generate<'person'>();
    await tx.insert(person).values({
      id,
      // NFC on write, or two visually identical Bangla names will not compare
      // equal and duplicate detection silently stops working (ADR-0019).
      nameBn: input.nameBn.normalize('NFC'),
      nameEn: input.nameEn.normalize('NFC'),
      createdBy: input.actorId,
    });
    return id;
  },
};
