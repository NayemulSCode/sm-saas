/**
 * The structure module's only importable surface.
 *
 * Organizations, schools, campuses, shifts, class levels, sections, academic
 * years. §14.4 — small, boring, and everything else depends on it.
 */

export {
  openAcademicYear,
  closeAcademicYear,
  YearErrors,
  type OpenAcademicYearInput,
  type CloseAcademicYearInput,
} from './application/academicYears';

export {
  createClassLevel,
  reorderClassLevels,
  ClassLevelErrors,
  type CreateClassLevelInput,
  type ReorderClassLevelsInput,
} from './application/classLevels';

export {
  createShift,
  createSection,
  updateSection,
  SectionErrors,
  type CreateShiftInput,
  type CreateSectionInput,
  type UpdateSectionInput,
} from './application/sections';

export { getStructure } from './application/getStructure';

export {
  evaluateOpen,
  evaluateClose,
  yearForDate,
  MAX_YEAR_DAYS,
  type ExistingYear,
  type CloseBlockers,
} from './domain/academicYear';

export {
  evaluateReorder,
  nextSequence,
  SEQUENCE_STEP,
  type ExistingLevel,
} from './domain/classLevel';
