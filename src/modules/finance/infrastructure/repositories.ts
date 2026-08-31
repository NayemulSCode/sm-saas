/**
 * Fee definition reads and writes. §13.1.
 *
 * Every query runs inside `withTenant`, so RLS narrows it to the caller's
 * tenant and a row from another tenant is simply absent rather than
 * forbidden — same discipline as every other module's repository.
 *
 * `academicYear`, `classLevel` and `section` are the STRUCTURE module's
 * tables, imported directly rather than through `structure/index.ts`. That is
 * allowed — `boundaries/dependencies` permits `infra` to import `db` freely —
 * and it is the same pattern `structure/infrastructure/repositories.ts`
 * already uses in reverse, reading `enrolment` (directory's table) for its own
 * occupancy count. Reaching into another module's *repository functions*
 * would be forbidden; reaching into the shared schema tables for a plain read
 * is not.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../../db/rls';
import { feeHead, feeStructure } from '../../../db/schema/finance';
import { academicYear, classLevel, section } from '../../../db/schema/structure';
import { Ids } from '../../../shared/ids';
import type {
  AcademicYearId,
  ClassLevelId,
  FeeHeadId,
  FeeStructureId,
  PersonId,
  SchoolId,
  SectionId,
} from '../../../shared/ids';

export interface FeeHeadRecord {
  id: FeeHeadId;
  code: string;
  nameBn: string;
  nameEn: string;
  frequency: 'one_time' | 'monthly' | 'term' | 'annual';
  isRefundable: boolean;
  glCode: string | null;
  sequence: number;
}

export interface FeeStructureRecord {
  id: FeeStructureId;
  academicYearId: AcademicYearId;
  feeHeadId: FeeHeadId;
  classLevelId: ClassLevelId | null;
  sectionId: SectionId | null;
  amountMinor: bigint;
  dueDay: number | null;
}

export const finance = {
  // ── fee heads ────────────────────────────────────────────────────────────

  async feeHeadCodeTaken(tx: Tx, code: string): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(feeHead)
      .where(and(eq(feeHead.code, code), isNull(feeHead.deletedAt)));
    return (row?.n ?? 0) > 0;
  },

  async feeHeadExists(tx: Tx, id: FeeHeadId): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(feeHead)
      .where(and(eq(feeHead.id, id), isNull(feeHead.deletedAt)));
    return (row?.n ?? 0) > 0;
  },

  async createFeeHead(
    tx: Tx,
    input: {
      code: string;
      nameBn: string;
      nameEn: string;
      frequency: 'one_time' | 'monthly' | 'term' | 'annual';
      isRefundable: boolean;
      glCode: string | null;
      sequence: number;
      actorId: PersonId;
    },
  ): Promise<FeeHeadId> {
    const id = Ids.generate<'feeHead'>();
    await tx.insert(feeHead).values({
      id,
      code: input.code,
      nameBn: input.nameBn,
      nameEn: input.nameEn,
      frequency: input.frequency,
      isRefundable: input.isRefundable,
      glCode: input.glCode,
      sequence: input.sequence,
      createdBy: input.actorId,
    });
    return id;
  },

  async listFeeHeads(tx: Tx): Promise<FeeHeadRecord[]> {
    return tx
      .select({
        id: feeHead.id,
        code: feeHead.code,
        nameBn: feeHead.nameBn,
        nameEn: feeHead.nameEn,
        frequency: feeHead.frequency,
        isRefundable: feeHead.isRefundable,
        glCode: feeHead.glCode,
        sequence: feeHead.sequence,
      })
      .from(feeHead)
      .where(isNull(feeHead.deletedAt))
      .orderBy(asc(feeHead.sequence), asc(feeHead.nameEn));
  },

  // ── the structure module's tables, read directly (see file header) ───────

  async academicYearSchool(
    tx: Tx,
    id: AcademicYearId,
  ): Promise<{ schoolId: SchoolId } | undefined> {
    const [row] = await tx
      .select({ schoolId: academicYear.schoolId })
      .from(academicYear)
      .where(and(eq(academicYear.id, id), isNull(academicYear.deletedAt)))
      .limit(1);
    return row;
  },

  async classLevelSchool(
    tx: Tx,
    id: ClassLevelId,
  ): Promise<{ schoolId: SchoolId } | undefined> {
    const [row] = await tx
      .select({ schoolId: classLevel.schoolId })
      .from(classLevel)
      .where(and(eq(classLevel.id, id), isNull(classLevel.deletedAt)))
      .limit(1);
    return row;
  },

  async sectionSchool(tx: Tx, id: SectionId): Promise<{ schoolId: SchoolId } | undefined> {
    const [row] = await tx
      .select({ schoolId: classLevel.schoolId })
      .from(section)
      .innerJoin(classLevel, eq(classLevel.id, section.classLevelId))
      .where(and(eq(section.id, id), isNull(section.deletedAt)))
      .limit(1);
    return row;
  },

  // ── fee structures ───────────────────────────────────────────────────────

  /**
   * Mirrors the migration's own guard — `UNIQUE (tenant_id, academic_year_id,
   * fee_head_id, COALESCE(class_level_id, section_id)) WHERE deleted_at IS
   * NULL` — as a pre-check, so a collision reads as a friendly `DomainError`
   * rather than a raw constraint violation. Same idiom as
   * `createClassLevel`'s own name-collision check.
   */
  async feeStructureConflict(
    tx: Tx,
    input: { academicYearId: AcademicYearId; feeHeadId: FeeHeadId; scopeId: string },
  ): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(feeStructure)
      .where(
        and(
          eq(feeStructure.academicYearId, input.academicYearId),
          eq(feeStructure.feeHeadId, input.feeHeadId),
          isNull(feeStructure.deletedAt),
          sql`coalesce(${feeStructure.classLevelId}, ${feeStructure.sectionId}) = ${Ids.toUuid(
            input.scopeId as never,
          )}::uuid`,
        ),
      );
    return (row?.n ?? 0) > 0;
  },

  async createFeeStructure(
    tx: Tx,
    input: {
      academicYearId: AcademicYearId;
      feeHeadId: FeeHeadId;
      classLevelId: ClassLevelId | null;
      sectionId: SectionId | null;
      amountMinor: bigint;
      dueDay: number | null;
      actorId: PersonId;
    },
  ): Promise<FeeStructureId> {
    const id = Ids.generate<'feeStructure'>();
    await tx.insert(feeStructure).values({
      id,
      academicYearId: input.academicYearId,
      feeHeadId: input.feeHeadId,
      classLevelId: input.classLevelId,
      sectionId: input.sectionId,
      amountMinor: input.amountMinor,
      dueDay: input.dueDay,
      createdBy: input.actorId,
    });
    return id;
  },

  async listFeeStructures(
    tx: Tx,
    filter: { academicYearId?: AcademicYearId | undefined },
  ): Promise<FeeStructureRecord[]> {
    const conditions = [isNull(feeStructure.deletedAt)];
    if (filter.academicYearId) {
      conditions.push(eq(feeStructure.academicYearId, filter.academicYearId));
    }
    return tx
      .select({
        id: feeStructure.id,
        academicYearId: feeStructure.academicYearId,
        feeHeadId: feeStructure.feeHeadId,
        classLevelId: feeStructure.classLevelId,
        sectionId: feeStructure.sectionId,
        amountMinor: feeStructure.amountMinor,
        dueDay: feeStructure.dueDay,
      })
      .from(feeStructure)
      .where(and(...conditions));
  },
};
