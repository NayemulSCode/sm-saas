/**
 * The directory module's only importable surface.
 *
 * Persons, students, guardians, siblings, enrolment, promotion, merging. §14.5.
 */

export {
  admitStudent,
  AdmissionErrors,
  type AdmitStudentInput,
  type AdmitStudentResult,
} from './application/admitStudent';

export {
  transitionStudentStatus,
  withdrawStudent,
  TransitionErrors,
  type TransitionInput,
} from './application/transitionStudentStatus';

export {
  promoteSection,
  undoPromotion,
  PromotionErrors,
  type PromoteSectionInput,
  type PromoteSectionResult,
} from './application/promoteSection';

export {
  linkGuardian,
  unlinkGuardian,
  linkSiblings,
  GuardianErrors,
  type LinkGuardianInput,
} from './application/guardians';

export {
  mergePersons,
  unmergePersons,
  MergeErrors,
  type MergePersonsInput,
} from './application/mergePersons';

export { getStudent } from './application/getStudent';

export {
  listStudents,
  type ListStudentsInput,
  type StudentRow,
} from './application/listStudents';

export {
  STUDENT_STATUSES,
  evaluateTransition,
  legalNextStatuses,
  isTerminal,
  isEnrolledStatus,
  type StudentStatus,
} from './domain/studentStatus';

export {
  RELATIONSHIPS,
  evaluateLink,
  evaluateUnlink,
  recipientsFor,
  type Relationship,
} from './domain/guardians';

export {
  OUTCOMES,
  buildPromotionPlan,
  statusForExit,
  type Outcome,
  type Candidate,
  type PromotionPlan,
} from './domain/promotion';

export {
  DEFAULT_PATTERN,
  validatePattern,
  renderCode,
  sequenceOf,
} from './domain/studentCode';

export {
  AdmitStudentSchema,
  TransitionStudentSchema,
  WithdrawStudentSchema,
  LinkGuardianSchema,
  UnlinkGuardianSchema,
  LinkSiblingsSchema,
  PromoteSectionSchema,
  UndoPromotionSchema,
  MergePersonsSchema,
  UnmergePersonsSchema,
} from './application/dto';
