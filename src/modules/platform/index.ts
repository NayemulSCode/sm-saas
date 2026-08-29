/**
 * The platform module's only importable surface.
 *
 * Tenant lifecycle: provisioning today, suspension and reactivation next.
 * Nothing outside reaches past this file (§1.6).
 */

export {
  provisionTenant,
  ProvisionErrors,
  type ProvisionTenantInput,
  type ProvisionTenantResult,
} from './application/provisionTenant';

export {
  isValidSlug,
  suggestSlug,
  defaultAcademicYear,
  DEFAULT_CLASS_LEVELS,
  DEFAULT_SHIFTS,
  type ClassLevelSeed,
  type ShiftSeed,
} from './domain/provisioning';

export { checkReadiness, type Readiness } from './infrastructure/readiness';
