/**
 * Directory reads and writes. Everything runs inside `withTenant`.
 */

import { and, asc, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Tx } from '../../../db/rls';
import { enrolment, person, staff } from '../../../db/schema/directory';
import { guardianLink, siblingGroup, siblingMember, student, studentStatusEvent } from '../../../db/schema/directoryStudents';
import { personMerge, promotionBatch } from '../../../db/schema/directoryOps';
import { membership } from '../../../db/schema/identity';
import { academicYear, classLevel, section } from '../../../db/schema/structure';
import type { AuthContext } from '../../../shared/auth-context';
import type { Cursor } from '../../../shared/keyset';
import { Ids } from '../../../shared/ids';
import type {
  AcademicYearId,
  EnrolmentId,
  PersonId,
  SchoolId,
  SectionId,
  StudentId,
} from '../../../shared/ids';
import type { LocalDate } from '../../../shared/date';
import type { StudentStatus } from '../domain/studentStatus';
import type { Relationship, ExistingLink } from '../domain/guardians';
import type { Candidate } from '../domain/promotion';

export const directory = {
  // ── persons ───────────────────────────────────────────────────────────────

  async createPerson(
    tx: Tx,
    input: {
      nameBn: string;
      nameEn: string;
      dateOfBirth?: LocalDate | undefined;
      gender?: 'male' | 'female' | 'other' | undefined;
      phone?: string | undefined;
      email?: string | undefined;
      actorId: PersonId;
    },
  ): Promise<PersonId> {
    const id = Ids.generate<'person'>();
    await tx.insert(person).values({
      id,
      // NFC on write, or two visually identical Bangla names will not compare
      // equal and duplicate detection silently stops working (ADR-0019).
      nameBn: input.nameBn.normalize('NFC'),
      nameEn: input.nameEn.normalize('NFC'),
      dateOfBirth: input.dateOfBirth ?? null,
      gender: input.gender ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      createdBy: input.actorId,
    });
    return id;
  },

  async personExists(tx: Tx, id: PersonId): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(person)
      .where(and(eq(person.id, id), isNull(person.deletedAt)));
    return (row?.n ?? 0) > 0;
  },

  async personById(tx: Tx, id: PersonId) {
    const [row] = await tx
      .select({
        id: person.id,
        nameBn: person.nameBn,
        nameEn: person.nameEn,
        phone: person.phone,
        mergedIntoPersonId: person.mergedIntoPersonId,
      })
      .from(person)
      .where(and(eq(person.id, id), isNull(person.deletedAt)))
      .limit(1);
    return row;
  },

  async setMergedInto(
    tx: Tx,
    loser: PersonId,
    winner: PersonId | null,
    actorId: PersonId,
  ): Promise<void> {
    await tx
      .update(person)
      .set({ mergedIntoPersonId: winner, updatedBy: actorId })
      .where(eq(person.id, loser));
  },

  // ── students ──────────────────────────────────────────────────────────────

  /**
   * The next student-code sequence for a year.
   *
   * `pg_advisory_xact_lock` serialises code generation until the transaction
   * commits. Without it two admissions at two counters read the same maximum,
   * and the second insert fails on the unique constraint — in front of a
   * parent. Transaction-scoped, so COMMIT or ROLLBACK releases it and no error
   * path can leak it.
   *
   * Keyed by TENANT, not by school. `student_code` is unique per
   * (tenant_id, student_code) — there is no school_id on `student`, since a
   * student reaches their school through enrolment — so a per-school lock would
   * let two schools in one tenant race for the same code. Reading every code in
   * the tenant is the same choice for the same reason.
   */
  async nextCodeSequence(
    tx: Tx,
    tenantId: string,
    year: number,
    read: (codes: string[]) => number,
  ): Promise<number> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`student-code:${tenantId}:${year}`}))`,
    );
    const rows = await tx
      .select({ code: student.studentCode })
      .from(student)
      .where(isNull(student.deletedAt));
    return read(rows.map((r) => r.code));
  },

  async createStudent(
    tx: Tx,
    input: {
      personId: PersonId;
      studentCode: string;
      status: StudentStatus;
      admittedOn: LocalDate;
      actorId: PersonId;
    },
  ): Promise<StudentId> {
    const id = Ids.generate<'student'>();
    await tx.insert(student).values({
      id,
      personId: input.personId,
      studentCode: input.studentCode,
      status: input.status,
      admittedOn: input.admittedOn,
      createdBy: input.actorId,
    });
    return id;
  },

  async studentById(tx: Tx, id: StudentId) {
    const [row] = await tx
      .select({
        id: student.id,
        personId: student.personId,
        studentCode: student.studentCode,
        status: student.status,
        nameBn: person.nameBn,
        nameEn: person.nameEn,
      })
      .from(student)
      .innerJoin(person, eq(person.id, student.personId))
      .where(and(eq(student.id, id), isNull(student.deletedAt)))
      .limit(1);
    return row;
  },

  async setStatus(
    tx: Tx,
    id: StudentId,
    status: StudentStatus,
    dateColumn: 'admitted_on' | 'withdrawn_on' | 'alumni_on' | null,
    on: LocalDate,
    actorId: PersonId,
  ): Promise<void> {
    await tx
      .update(student)
      .set({
        status,
        ...(dateColumn === 'admitted_on' ? { admittedOn: on } : {}),
        ...(dateColumn === 'withdrawn_on' ? { withdrawnOn: on } : {}),
        ...(dateColumn === 'alumni_on' ? { alumniOn: on } : {}),
        updatedBy: actorId,
      })
      .where(eq(student.id, id));
  },

  /** The current value lives on `student.status`; this is how it got there. */
  async recordStatusEvent(
    tx: Tx,
    input: {
      studentId: StudentId;
      from: StudentStatus | null;
      to: StudentStatus;
      reason?: string | undefined;
      effectiveDate: LocalDate;
      actorId: PersonId;
    },
  ): Promise<void> {
    await tx.insert(studentStatusEvent).values({
      id: Ids.generate<'studentStatusEvent'>(),
      studentId: input.studentId,
      fromStatus: input.from,
      toStatus: input.to,
      reason: input.reason ?? null,
      effectiveDate: input.effectiveDate,
      actorPersonId: input.actorId,
      createdBy: input.actorId,
    });
  },

  async statusHistory(tx: Tx, studentId: StudentId) {
    return tx
      .select({
        fromStatus: studentStatusEvent.fromStatus,
        toStatus: studentStatusEvent.toStatus,
        reason: studentStatusEvent.reason,
        effectiveDate: studentStatusEvent.effectiveDate,
      })
      .from(studentStatusEvent)
      .where(eq(studentStatusEvent.studentId, studentId))
      .orderBy(desc(studentStatusEvent.effectiveDate));
  },

  // ── enrolments ────────────────────────────────────────────────────────────

  async createEnrolment(
    tx: Tx,
    input: {
      studentId: StudentId;
      sectionId: SectionId;
      academicYearId: AcademicYearId;
      rollNo?: number | undefined;
      enrolledOn: LocalDate;
      promotionBatchId?: string | undefined;
      actorId: PersonId;
    },
  ): Promise<EnrolmentId> {
    const id = Ids.generate<'enrolment'>();
    await tx.insert(enrolment).values({
      id,
      studentId: input.studentId,
      sectionId: input.sectionId,
      academicYearId: input.academicYearId,
      rollNo: input.rollNo ?? null,
      enrolledOn: input.enrolledOn,
      promotionBatchId: (input.promotionBatchId ?? null) as never,
      createdBy: input.actorId,
    });
    return id;
  },

  /** The cohort a promotion run operates on. */
  async candidatesIn(
    tx: Tx,
    sectionId: SectionId,
    yearId: AcademicYearId,
  ): Promise<Candidate[]> {
    return tx
      .select({
        enrolmentId: enrolment.id,
        studentId: enrolment.studentId,
        rollNo: enrolment.rollNo,
        nameEn: person.nameEn,
      })
      .from(enrolment)
      .innerJoin(student, eq(student.id, enrolment.studentId))
      .innerJoin(person, eq(person.id, student.personId))
      .where(
        and(
          eq(enrolment.sectionId, sectionId),
          eq(enrolment.academicYearId, yearId),
          isNull(enrolment.deletedAt),
          // A student already given an outcome has been through a promotion
          // run; including them would move them twice.
          isNull(enrolment.outcome),
        ),
      );
  },

  async setOutcomes(
    tx: Tx,
    ids: readonly string[],
    outcome: 'promoted' | 'retained' | 'transferred' | 'withdrawn',
    leftOn: LocalDate,
    actorId: PersonId,
  ): Promise<void> {
    if (ids.length === 0) return;
    await tx
      .update(enrolment)
      .set({ outcome, leftOn, updatedBy: actorId })
      .where(inArray(enrolment.id, ids as never[]));
  },

  async clearOutcomesFor(
    tx: Tx,
    studentIds: readonly string[],
    yearId: AcademicYearId,
    actorId: PersonId,
  ): Promise<number> {
    if (studentIds.length === 0) return 0;
    const rows = await tx
      .update(enrolment)
      .set({ outcome: null, leftOn: null, updatedBy: actorId })
      .where(
        and(
          inArray(enrolment.studentId, studentIds as never[]),
          eq(enrolment.academicYearId, yearId),
          isNull(enrolment.deletedAt),
        ),
      )
      .returning({ id: enrolment.id });
    return rows.length;
  },

  async enrolmentsFor(tx: Tx, studentId: StudentId) {
    return tx
      .select({
        id: enrolment.id,
        sectionId: enrolment.sectionId,
        academicYearId: enrolment.academicYearId,
        rollNo: enrolment.rollNo,
        outcome: enrolment.outcome,
        enrolledOn: enrolment.enrolledOn,
      })
      .from(enrolment)
      .where(and(eq(enrolment.studentId, studentId), isNull(enrolment.deletedAt)))
      .orderBy(desc(enrolment.enrolledOn));
  },

  async sectionInSchool(tx: Tx, sectionId: SectionId, schoolId: SchoolId): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(section)
      .innerJoin(classLevel, eq(classLevel.id, section.classLevelId))
      .where(
        and(
          eq(section.id, sectionId),
          eq(classLevel.schoolId, schoolId),
          isNull(section.deletedAt),
        ),
      );
    return (row?.n ?? 0) > 0;
  },

  // ── promotion batches ─────────────────────────────────────────────────────

  async createBatch(
    tx: Tx,
    input: {
      sourceSectionId: SectionId;
      fromYearId: AcademicYearId;
      toYearId: AcademicYearId;
      counts: Record<string, number>;
      actorId: PersonId;
    },
  ): Promise<string> {
    const id = Ids.generate<'promotionBatch'>();
    await tx.insert(promotionBatch).values({
      id,
      sourceSectionId: input.sourceSectionId,
      fromYearId: input.fromYearId,
      toYearId: input.toYearId,
      promoted: input.counts['promoted'] ?? 0,
      retained: input.counts['retained'] ?? 0,
      transferred: input.counts['transferred'] ?? 0,
      withdrawn: input.counts['withdrawn'] ?? 0,
      createdBy: input.actorId,
    });
    return id;
  },

  async batchById(tx: Tx, id: string) {
    const [row] = await tx
      .select()
      .from(promotionBatch)
      .where(and(eq(promotionBatch.id, id as never), isNull(promotionBatch.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * The recent runs, newest first, with the names a person recognises.
   *
   * Undo is useless if it only exists on the screen that did the promotion.
   * "We ran it on the wrong section" is realised minutes later, by which time
   * the tab is closed — so the batches have to be findable.
   */
  async recentBatches(tx: Tx, limit: number) {
    const fromYear = alias(academicYear, 'from_year');
    const toYear = alias(academicYear, 'to_year');

    return tx
      .select({
        id: promotionBatch.id,
        sourceSectionId: promotionBatch.sourceSectionId,
        sectionNameEn: section.nameEn,
        className: classLevel.nameEn,
        fromYearName: fromYear.name,
        toYearName: toYear.name,
        promoted: promotionBatch.promoted,
        retained: promotionBatch.retained,
        transferred: promotionBatch.transferred,
        withdrawn: promotionBatch.withdrawn,
        undoneAt: promotionBatch.undoneAt,
        undoReason: promotionBatch.undoReason,
        createdAt: promotionBatch.createdAt,
      })
      .from(promotionBatch)
      // Left joins: a section or a year may have been removed since the run,
      // and a batch that cannot be named is still a batch that must be undoable.
      .leftJoin(section, eq(section.id, promotionBatch.sourceSectionId))
      .leftJoin(classLevel, eq(classLevel.id, section.classLevelId))
      .leftJoin(fromYear, eq(fromYear.id, promotionBatch.fromYearId))
      .leftJoin(toYear, eq(toYear.id, promotionBatch.toYearId))
      .where(isNull(promotionBatch.deletedAt))
      .orderBy(desc(promotionBatch.createdAt))
      .limit(limit);
  },

  /** Exactly the enrolments one run created — never rows added by hand after. */
  async enrolmentsFromBatch(tx: Tx, batchId: string) {
    return tx
      .select({ id: enrolment.id, studentId: enrolment.studentId })
      .from(enrolment)
      .where(
        and(eq(enrolment.promotionBatchId, batchId as never), isNull(enrolment.deletedAt)),
      );
  },

  async softDeleteEnrolments(
    tx: Tx,
    ids: readonly string[],
    reason: string,
    actorId: PersonId,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await tx
      .update(enrolment)
      .set({ deletedAt: new Date(), deletedBy: actorId, deleteReason: reason })
      .where(inArray(enrolment.id, ids as never[]))
      .returning({ id: enrolment.id });
    return rows.length;
  },

  async markBatchUndone(
    tx: Tx,
    id: string,
    reason: string,
    actorId: PersonId,
  ): Promise<void> {
    await tx
      .update(promotionBatch)
      .set({ undoneAt: new Date(), undoReason: reason, updatedBy: actorId })
      .where(eq(promotionBatch.id, id as never));
  },

  // ── guardians ─────────────────────────────────────────────────────────────

  async linksFor(tx: Tx, studentId: StudentId): Promise<ExistingLink[]> {
    return tx
      .select({
        id: guardianLink.id,
        guardianPersonId: guardianLink.guardianPersonId,
        relationship: guardianLink.relationship,
        isBillingGuardian: guardianLink.isBillingGuardian,
        isPrimaryContact: guardianLink.isPrimaryContact,
        canReceiveResults: guardianLink.canReceiveResults,
        canCollectStudent: guardianLink.canCollectStudent,
      })
      .from(guardianLink)
      .where(and(eq(guardianLink.studentId, studentId), isNull(guardianLink.deletedAt)))
      .orderBy(asc(guardianLink.sequence));
  },

  /** Demoted BEFORE the new link is inserted: the index is not deferrable. */
  async demoteLink(
    tx: Tx,
    id: string,
    field: 'billing' | 'primary',
    actorId: PersonId,
  ): Promise<void> {
    await tx
      .update(guardianLink)
      .set({
        ...(field === 'billing' ? { isBillingGuardian: false } : { isPrimaryContact: false }),
        updatedBy: actorId,
      })
      .where(eq(guardianLink.id, id as never));
  },

  async createLink(
    tx: Tx,
    input: {
      studentId: StudentId;
      guardianPersonId: PersonId;
      relationship: Relationship;
      isBillingGuardian: boolean;
      isPrimaryContact: boolean;
      canReceiveResults: boolean;
      canCollectStudent: boolean;
      actorId: PersonId;
    },
  ): Promise<string> {
    const id = Ids.generate<'guardianLink'>();
    await tx.insert(guardianLink).values({
      id,
      studentId: input.studentId,
      guardianPersonId: input.guardianPersonId,
      relationship: input.relationship,
      isBillingGuardian: input.isBillingGuardian,
      isPrimaryContact: input.isPrimaryContact,
      canReceiveResults: input.canReceiveResults,
      canCollectStudent: input.canCollectStudent,
      createdBy: input.actorId,
    });
    return id;
  },

  async softDeleteLink(
    tx: Tx,
    id: string,
    reason: string,
    actorId: PersonId,
  ): Promise<void> {
    await tx
      .update(guardianLink)
      .set({ deletedAt: new Date(), deletedBy: actorId, deleteReason: reason })
      .where(eq(guardianLink.id, id as never));
  },

  // ── siblings ──────────────────────────────────────────────────────────────

  async groupFor(tx: Tx, studentId: StudentId): Promise<string | undefined> {
    const [row] = await tx
      .select({ groupId: siblingMember.siblingGroupId })
      .from(siblingMember)
      .where(and(eq(siblingMember.studentId, studentId), isNull(siblingMember.deletedAt)))
      .limit(1);
    return row?.groupId;
  },

  async createGroup(tx: Tx, actorId: PersonId): Promise<string> {
    const id = Ids.generate<'siblingGroup'>();
    await tx.insert(siblingGroup).values({ id, createdBy: actorId });
    return id;
  },

  async addToGroup(
    tx: Tx,
    groupId: string,
    studentId: StudentId,
    actorId: PersonId,
  ): Promise<void> {
    await tx.insert(siblingMember).values({
      id: Ids.generate<'siblingMember'>(),
      siblingGroupId: groupId as never,
      studentId,
      createdBy: actorId,
    });
  },

  async membersOf(tx: Tx, groupId: string): Promise<StudentId[]> {
    const rows = await tx
      .select({ studentId: siblingMember.studentId })
      .from(siblingMember)
      .where(
        and(eq(siblingMember.siblingGroupId, groupId as never), isNull(siblingMember.deletedAt)),
      );
    return rows.map((r) => r.studentId);
  },

  // ── merging ───────────────────────────────────────────────────────────────

  /**
   * Repoints the DOMAIN references from one person to another.
   *
   * Not `created_by` / `updated_by` / `deleted_by`, and not the audit actor.
   * Those record who did something, historically; rewriting them would falsify
   * the record of who acted, which is the one thing an audit trail must not do.
   */
  async repoint(
    tx: Tx,
    loser: PersonId,
    winner: PersonId,
    actorId: PersonId,
  ): Promise<{ students: string[]; guardianLinks: string[]; staff: string[]; memberships: string[] }> {
    const students = await tx
      .update(student)
      .set({ personId: winner, updatedBy: actorId })
      .where(and(eq(student.personId, loser), isNull(student.deletedAt)))
      .returning({ id: student.id });

    const links = await tx
      .update(guardianLink)
      .set({ guardianPersonId: winner, updatedBy: actorId })
      .where(and(eq(guardianLink.guardianPersonId, loser), isNull(guardianLink.deletedAt)))
      .returning({ id: guardianLink.id });

    const staffRows = await tx
      .update(staff)
      .set({ personId: winner, updatedBy: actorId })
      .where(and(eq(staff.personId, loser), isNull(staff.deletedAt)))
      .returning({ id: staff.id });

    const memberships = await tx
      .update(membership)
      .set({ personId: winner, updatedBy: actorId })
      .where(and(eq(membership.personId, loser), isNull(membership.deletedAt)))
      .returning({ id: membership.id });

    return {
      students: students.map((r) => r.id),
      guardianLinks: links.map((r) => r.id),
      staff: staffRows.map((r) => r.id),
      memberships: memberships.map((r) => r.id),
    };
  },

  async recordMerge(
    tx: Tx,
    input: {
      winner: PersonId;
      loser: PersonId;
      moved: Record<string, string[]>;
      reason: string;
      actorId: PersonId;
    },
  ): Promise<string> {
    const id = Ids.generate<'personMerge'>();
    await tx.insert(personMerge).values({
      id,
      winnerPersonId: input.winner,
      loserPersonId: input.loser,
      moved: input.moved,
      reason: input.reason,
      createdBy: input.actorId,
    });
    return id;
  },

  async mergeById(tx: Tx, id: string) {
    const [row] = await tx
      .select()
      .from(personMerge)
      .where(and(eq(personMerge.id, id as never), isNull(personMerge.deletedAt)))
      .limit(1);
    return row;
  },

  async markMergeReversed(
    tx: Tx,
    id: string,
    reason: string,
    actorId: PersonId,
  ): Promise<void> {
    await tx
      .update(personMerge)
      .set({ reversedAt: new Date(), reverseReason: reason, updatedBy: actorId })
      .where(eq(personMerge.id, id as never));
  },

  /** Puts back exactly the rows a merge moved, by id. */
  async repointBack(
    tx: Tx,
    moved: Record<string, string[]>,
    loser: PersonId,
    actorId: PersonId,
  ): Promise<void> {
    const ids = (key: string) => moved[key] ?? [];

    if (ids('students').length > 0) {
      await tx
        .update(student)
        .set({ personId: loser, updatedBy: actorId })
        .where(inArray(student.id, ids('students') as never[]));
    }
    if (ids('guardianLinks').length > 0) {
      await tx
        .update(guardianLink)
        .set({ guardianPersonId: loser, updatedBy: actorId })
        .where(inArray(guardianLink.id, ids('guardianLinks') as never[]));
    }
    if (ids('staff').length > 0) {
      await tx
        .update(staff)
        .set({ personId: loser, updatedBy: actorId })
        .where(inArray(staff.id, ids('staff') as never[]));
    }
    if (ids('memberships').length > 0) {
      await tx
        .update(membership)
        .set({ personId: loser, updatedBy: actorId })
        .where(inArray(membership.id, ids('memberships') as never[]));
    }
  },

  /**
   * The student list, with scope narrowed IN SQL.
   *
   * `scope.sectionIds` present and non-empty restricts to those sections;
   * present and EMPTY denies everything, because a misconfigured role must fail
   * closed (§9.3); absent is unrestricted within the tenant, which RLS already
   * bounds.
   *
   * The join to `enrolment` is LEFT: an applicant who has not been placed in a
   * section yet still has to appear, or the admissions queue is invisible. It
   * is narrowed to one academic year so a student with four years of history
   * appears once rather than four times.
   */
  async searchStudents(
    tx: Tx,
    ctx: AuthContext,
    input: {
      sectionId?: string | undefined;
      academicYearId?: string | undefined;
      status?: string | undefined;
      search?: string | undefined;
      limit: number;
      cursor?: Cursor | undefined;
    },
  ) {
    const scopedSections = ctx.scope.sectionIds;

    /*
     * An empty scope array denies everything. Expressed as a predicate that
     * matches nothing rather than by returning [] early, so the deny travels
     * with the query and cannot be lost by a later refactor of the caller.
     */
    const scopePredicate =
      scopedSections === undefined
        ? undefined
        : scopedSections.length === 0
          ? sql`false`
          : inArray(enrolment.sectionId, [...scopedSections] as never[]);

    const search = input.search?.trim();
    const searchPredicate = search
      ? or(
          // Both scripts, because a name in one is not a translation of the
          // other and an office assistant types whichever they are looking at.
          ilike(person.nameEn, `%${search}%`),
          ilike(person.nameBn, `%${search}%`),
          ilike(student.studentCode, `%${search}%`),
        )
      : undefined;

    return tx
      .select({
        id: student.id,
        studentCode: student.studentCode,
        nameBn: person.nameBn,
        nameEn: person.nameEn,
        status: student.status,
        rollNo: enrolment.rollNo,
        sectionId: enrolment.sectionId,
        sectionNameEn: section.nameEn,
        classNameEn: classLevel.nameEn,
      })
      .from(student)
      .innerJoin(person, eq(person.id, student.personId))
      .leftJoin(
        enrolment,
        and(
          eq(enrolment.studentId, student.id),
          isNull(enrolment.deletedAt),
          input.academicYearId
            ? eq(enrolment.academicYearId, input.academicYearId as never)
            : undefined,
        ),
      )
      .leftJoin(section, eq(section.id, enrolment.sectionId))
      .leftJoin(classLevel, eq(classLevel.id, section.classLevelId))
      .where(
        and(
          isNull(student.deletedAt),
          input.sectionId ? eq(enrolment.sectionId, input.sectionId as never) : undefined,
          input.status ? eq(student.status, input.status as never) : undefined,
          searchPredicate,
          scopePredicate,
          // Strictly less-than on a ULID id: newest first, and the id is its
          // own tiebreaker because it is unique.
          input.cursor ? lt(student.id, input.cursor.id as never) : undefined,
        ),
      )
      .orderBy(desc(student.id))
      .limit(input.limit);
  },

  /** The editable shape of a student: their own row plus their person row. */
  async studentForEdit(tx: Tx, id: StudentId) {
    const [row] = await tx
      .select({
        personId: student.personId,
        version: student.version,
        nameBn: person.nameBn,
        nameEn: person.nameEn,
        dateOfBirth: person.dateOfBirth,
        gender: person.gender,
        phone: person.phone,
        email: person.email,
        house: student.house,
        religion: student.religion,
        bloodGroup: student.bloodGroup,
      })
      .from(student)
      .innerJoin(person, eq(person.id, student.personId))
      .where(and(eq(student.id, id), isNull(student.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * Bumps `version` only if it still matches what the editor was shown.
   *
   * Returns undefined when it does not — which is a 409, not a retry. Somebody
   * else saved a correction in between, and silently overwriting it is the
   * thing this column exists to prevent.
   *
   * The UPDATE always runs even when `patch` is empty, because bumping the
   * version is how a person-only edit still takes part in the locking.
   */
  async updateStudentVersioned(
    tx: Tx,
    id: StudentId,
    expectedVersion: number,
    patch: { house?: string | null; religion?: string | null; bloodGroup?: string | null },
    actorId: PersonId,
  ): Promise<number | undefined> {
    const rows = await tx
      .update(student)
      .set({
        ...(patch.house !== undefined ? { house: patch.house } : {}),
        ...(patch.religion !== undefined ? { religion: patch.religion } : {}),
        ...(patch.bloodGroup !== undefined ? { bloodGroup: patch.bloodGroup } : {}),
        version: sql`${student.version} + 1`,
        updatedBy: actorId,
      })
      .where(
        and(
          eq(student.id, id),
          eq(student.version, expectedVersion),
          isNull(student.deletedAt),
        ),
      )
      .returning({ version: student.version });
    return rows[0]?.version;
  },

  async updatePerson(
    tx: Tx,
    id: PersonId,
    patch: {
      nameBn?: string;
      nameEn?: string;
      dateOfBirth?: LocalDate | null;
      gender?: 'male' | 'female' | 'other' | null;
      phone?: string | null;
      email?: string | null;
    },
    actorId: PersonId,
  ): Promise<void> {
    await tx
      .update(person)
      .set({
        // NFC on write, here as well as at admission: an edit is a write path
        // too, and a name corrected through this route must compare equal to
        // one entered through the other.
        ...(patch.nameBn !== undefined ? { nameBn: patch.nameBn.normalize('NFC') } : {}),
        ...(patch.nameEn !== undefined ? { nameEn: patch.nameEn.normalize('NFC') } : {}),
        ...(patch.dateOfBirth !== undefined ? { dateOfBirth: patch.dateOfBirth } : {}),
        ...(patch.gender !== undefined ? { gender: patch.gender } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.email !== undefined ? { email: patch.email } : {}),
        updatedBy: actorId,
      })
      .where(eq(person.id, id));
  },

  /** Guardian rows carry the person's name and phone, for the detail screen. */
  async guardiansWithPeople(tx: Tx, studentId: StudentId) {
    return tx
      .select({
        id: guardianLink.id,
        guardianPersonId: guardianLink.guardianPersonId,
        relationship: guardianLink.relationship,
        isBillingGuardian: guardianLink.isBillingGuardian,
        isPrimaryContact: guardianLink.isPrimaryContact,
        canReceiveResults: guardianLink.canReceiveResults,
        canCollectStudent: guardianLink.canCollectStudent,
        nameBn: person.nameBn,
        nameEn: person.nameEn,
        phone: person.phone,
      })
      .from(guardianLink)
      .innerJoin(person, eq(person.id, guardianLink.guardianPersonId))
      .where(and(eq(guardianLink.studentId, studentId), isNull(guardianLink.deletedAt)))
      .orderBy(asc(guardianLink.sequence));
  },
};
