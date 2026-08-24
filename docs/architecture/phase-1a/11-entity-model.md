# 11. Detailed entity model

Schema sketches, not migrations. Conventions from
[§10.1](10-database-architecture.md) — `id`, `tenant_id`, `created_at`,
`updated_at`, `created_by`, `updated_by`, `deleted_at`, `version` — are implied
on every tenant-owned table and omitted below for readability.

Scope key: **[P]** platform, **[G]** global identity, **[T]** tenant-scoped
(RLS enforced).

---

## 11.1 Platform

```sql
-- [P] The unit of isolation, billing and support.
tenant (
  id, organization_id NULL, slug UNIQUE, name_bn, name_en,
  status        CHECK IN ('trial','active','past_due','suspended',
                          'cancelled','purged'),
  plan_id, shard_id DEFAULT 'primary',      -- §7.6 whale extraction
  locale_default CHECK IN ('bn','en'), timezone DEFAULT 'Asia/Dhaka',
  trial_ends_at, suspended_at, purge_after,
  branding jsonb                            -- logo, colours, favicon
)

-- [P] Plans and entitlements. Feature checks are server-side, always.
plan (id, code UNIQUE, name, price_minor, billing_period, is_public)
plan_feature (plan_id, feature_key, enabled, limit_value)
  -- e.g. ('students', true, 500) · ('sms_monthly', true, 5000)
tenant_feature_override (tenant_id, feature_key, enabled, limit_value, reason,
                         expires_at)

-- [P] Platform revenue. NEVER shares a table with school fee collection.
platform_invoice (id, tenant_id, period_start, period_end,
                  amount_minor, tax_minor, status, due_date, issued_at)
platform_payment (id, platform_invoice_id, amount_minor, channel, reference,
                  received_at, recorded_by)
tenant_usage_meter (tenant_id, period_month, metric, value, computed_at)
  -- metric: active_students | sms_sent | storage_bytes
  -- Written once per night by a batch job, never on the request path (FR-13.2)

-- [P] Operator actions, including impersonation.
operator_audit (id, operator_id, tenant_id NULL, action, reason, target,
                started_at, ended_at, ip, user_agent)
```

**Two ledgers, never one.** `platform_invoice` and the school's `invoice` in
§11.7 describe different money owed by different parties. §5.13 of the brief is
explicit about this and it is worth restating in the schema: they share no
tables, no sequences and no reports.

**`shard_id` on day one.** Every row reads `'primary'`. It exists so that moving
a large tenant later is an operations task rather than a refactor
([§7.6](07-multi-tenancy.md)).

---

## 11.2 Identity

```sql
-- [G] Who logs in. Deliberately holds no personal data — see §7.7.
account (
  id, status CHECK IN ('active','locked','disabled'),
  locale, mfa_enabled, last_login_at, failed_attempts, locked_until
)

-- [G] One phone or email is ONE login, globally.
credential (
  id, account_id,
  kind  CHECK IN ('phone','email'),
  value,                                   -- phone normalised to E.164
  password_hash NULL,                      -- argon2id; NULL for OTP-only
  verified_at, is_primary,
  UNIQUE (kind, value)
)

-- [G] Opaque server-side sessions. Not JWTs — revocation must be immediate.
session (id, account_id, token_hash UNIQUE, active_membership_id NULL,
         issued_at, last_seen_at, expires_at, ip, user_agent, revoked_at)

otp_challenge (id, credential_id, code_hash, purpose, attempts,
               expires_at, consumed_at)

-- [T] The bridge: this account, in this tenant, is this person.
membership (
  id, tenant_id, account_id, person_id,
  status CHECK IN ('active','suspended'),
  UNIQUE (tenant_id, account_id, person_id)
)

-- [T] Roles are data. System roles seeded; tenants may add their own.
role (id, tenant_id NULL, code, name_bn, name_en, is_system)
  -- tenant_id NULL = a platform-seeded template role
role_permission (role_id, permission_key)
membership_role (
  membership_id, role_id,
  scope jsonb            -- { campusIds?, classIds?, sectionIds?, subjectIds? }
                         -- absent key = unrestricted within the tenant
)

permission (key PRIMARY KEY, module, description_bn, description_en)
  -- Mirror of the TypeScript union in §8.5, for the role editor UI only.
  -- Code is the source of truth; this table is generated from it.
```

---

## 11.3 Structure

```sql
organization (id, tenant_id, name_bn, name_en, owner_person_id)
school (id, tenant_id, organization_id NULL, name_bn, name_en,
        eiin, address, contact, logo_key, settings jsonb)
campus (id, tenant_id, school_id, name_bn, name_en, address, is_primary)
shift  (id, tenant_id, campus_id, name_bn, name_en, start_time, end_time,
        sequence)

academic_year (id, tenant_id, school_id, name,        -- '2026'
               start_date, end_date, is_current, status)
term (id, tenant_id, academic_year_id, name_bn, name_en,
      sequence, start_date, end_date)

-- Arbitrary class naming: 'Play', 'Nursery', 'KG', 'Class 1'…
class_level (id, tenant_id, school_id, name_bn, name_en, sequence,
             medium, curriculum_id NULL)
section (id, tenant_id, class_level_id, campus_id, shift_id,
         name_bn, name_en, capacity, class_teacher_id NULL)
```

`sequence` on `class_level` carries promotion order. Promotion follows
`sequence`, so a school inserting "Class 5B" between existing levels does not
need code changes — it needs a number.

`shift` is a first-class entity rather than an attribute because a shift has its
own timetable, its own weekly-off pattern and often its own working-day
calendar. Modelling it as a column on `section` makes §5.16 unimplementable.

---

## 11.4 Directory — persons, students, guardians, staff

```sql
-- [T] A human, as known to ONE school. Never shared across tenants.
person (
  id, tenant_id,
  name_bn, name_en,                        -- both, always; not translations
  date_of_birth, gender, photo_key,
  phone NULL, email NULL,                  -- CONTACT details — not unique
  national_id_enc NULL, birth_reg_no NULL, -- application-level encryption
  address jsonb,
  merged_into_person_id NULL               -- §8.6; loser of a merge
)

student (
  id, tenant_id, person_id UNIQUE,
  student_code,                            -- school-visible id, per-school pattern
  status CHECK IN ('applicant','admitted','active','on_leave',
                   'withdrawn','alumni'),
  admitted_on, withdrawn_on, alumni_on,
  house NULL, religion NULL, blood_group NULL,
  UNIQUE (tenant_id, student_code)
)

-- Every lifecycle transition, with its reason. FR-4.1.
student_status_event (id, tenant_id, student_id, from_status, to_status,
                      reason, effective_date, actor_person_id, at)

-- [T] The join that all history hangs from. One row per student per year.
enrolment (
  id, tenant_id, student_id, section_id, academic_year_id,
  roll_no,                                 -- attribute of ENROLMENT, not student
  enrolled_on, left_on NULL,
  outcome CHECK IN ('promoted','retained','transferred','withdrawn',NULL),
  UNIQUE (tenant_id, section_id, academic_year_id, roll_no)
    WHERE deleted_at IS NULL,
  UNIQUE (tenant_id, student_id, academic_year_id) WHERE deleted_at IS NULL
)

-- [T] Guardian relationships, with the two flags kept separate.
guardian_link (
  id, tenant_id, guardian_person_id, student_id,
  relationship CHECK IN ('father','mother','guardian','emergency','other'),
  is_billing_guardian  boolean,   -- who owes the fees
  is_primary_contact   boolean,   -- who gets the SMS
  can_receive_results  boolean,   -- custody arrangements — FR-4.10
  can_collect_student  boolean,
  sequence,
  UNIQUE (tenant_id, student_id, guardian_person_id)
)

sibling_group (id, tenant_id)             -- drives sibling discount + SMS dedup
sibling_member (sibling_group_id, student_id)

staff (id, tenant_id, person_id UNIQUE, employee_code,
       designation, department, joined_on, left_on NULL, status)
staff_section_assignment (id, tenant_id, staff_id, section_id,
                          academic_year_id, role)  -- 'class_teacher' | 'assistant'
staff_subject_assignment (id, tenant_id, staff_id, section_id, subject_id,
                          academic_year_id)

document (id, tenant_id, owner_type, owner_id, doc_type, storage_key,
          mime, size_bytes, issued_on, expires_on, verified_at, verified_by)
```

**`is_billing_guardian` and `is_primary_contact` are separate columns.**
Separated parents are common; one may pay while the other is contacted. A single
"primary guardian" flag forces a wrong answer for a real family.

**`roll_no` lives on `enrolment`.** Rolls are reassigned every promotion
(FR-4.3). Putting it on `student` destroys last year's tabulation sheet the
moment this year's rolls are set.

---

## 11.5 Calendar — the working-day engine

```sql
holiday_category (id, tenant_id NULL, code, name_bn, name_en, is_system)
  -- tenant_id NULL = platform-provided category

-- [P] The importable government calendar, versioned per year.
government_holiday (id, year, category_code, title_bn, title_en,
                    start_date, end_date, is_provisional, version, published_at)

-- [T] A holiday at any level of the hierarchy.
holiday (
  id, tenant_id,
  level CHECK IN ('organization','school','campus','class','section'),
  level_ref_id,
  category_id, title_bn, title_en, description,
  start_date, end_date,
  start_time NULL, end_time NULL, is_full_day,
  state CHECK IN ('provisional','confirmed','cancelled'),
  source_government_holiday_id NULL,
  -- Suppression, not just addition. FR-5.4.
  suppresses_holiday_id NULL,
  effective_from, effective_to,             -- effective dating: history is not rewritten
  approved_by, approved_at
)

-- [T] Weekend is configuration, effective-dated. FR-5.6.
weekly_off_pattern (id, tenant_id, campus_id NULL, shift_id NULL,
                    days_of_week smallint[],   -- {5,6} = Fri, Sat
                    effective_from, effective_to NULL)

-- [T] THE materialized answer. Every module reads this; none recomputes it.
working_day (
  tenant_id, campus_id, shift_id, academic_year_id, date,
  status CHECK IN ('working','weekly_off','holiday','exam_only','partial'),
  source_holiday_id NULL,
  reason_bn, reason_en,                    -- so the UI can explain itself
  computed_at, computation_version,
  PRIMARY KEY (tenant_id, campus_id, shift_id, date)
)

calendar_recompute (id, tenant_id, trigger, affected_from, affected_to,
                    status, started_at, finished_at, changes jsonb)
  -- The audit trail for a retroactive holiday. FR-5.8.

academic_event (id, tenant_id, level, level_ref_id, type, title_bn, title_en,
                start_date, end_date, start_time, end_time, visibility)
```

Resolution order, highest precedence first — the algorithm in
[ADR-0013](../adr/0013-calendar-as-infrastructure.md):

```
section > class > campus > school > organization > platform(government)
```

with a suppression pass applied before precedence, so a school can cancel an
inherited government holiday rather than only add to it.

**Sizing.** 100 schools × 2 campuses × 2 shifts × 365 days ≈ **146,000 rows per
year.** Trivial to store, and it converts the hottest question in the system
into a single indexed lookup.

---

## 11.6 Academics and attendance

```sql
curriculum (id, tenant_id, name_bn, name_en, authority)   -- NCTB, Cambridge, own
subject (id, tenant_id, curriculum_id, code, name_bn, name_en,
         is_optional, sequence)
class_subject (id, tenant_id, class_level_id, subject_id, academic_year_id,
               is_mandatory, is_fourth_subject)
book (id, tenant_id, subject_id, class_level_id, academic_year_id,
      title_bn, title_en, author, publisher, edition, isbn, is_mandatory)

period (id, tenant_id, shift_id, sequence, start_time, end_time, is_break)
timetable_entry (id, tenant_id, section_id, academic_year_id, day_of_week,
                 period_id, subject_id, staff_id, room NULL,
                 effective_from, effective_to)
timetable_substitution (id, tenant_id, timetable_entry_id, date,
                        substitute_staff_id, reason)

attendance_status (id, tenant_id, code, name_bn, name_en,
                   counts_as_present, sequence)     -- tenant-extensible

attendance (
  id, tenant_id, student_id, section_id, academic_year_id,
  date, period_no NULL,                    -- NULL = day-wise (FR-6.1)
  status_id, remark NULL,
  recorded_by, recorded_at,
  source CHECK IN ('manual','offline_sync','device','import'),
  client_ref NULL,                         -- idempotency key from the offline queue
  superseded_by_id NULL,                   -- corrections are new rows (FR-6.5)
  UNIQUE (tenant_id, student_id, date, period_no) WHERE superseded_by_id IS NULL
                                                    AND deleted_at IS NULL
)
```

**`client_ref`** is what makes offline sync safe. The phone generates a ULID per
record before it has connectivity; replaying the queue is idempotent because the
unique index rejects the duplicate.

**`superseded_by_id`** implements FR-6.5: an amended attendance record is a new
row pointing back at the old one. Nothing is overwritten, so a retroactive
holiday recompute is reversible and the original state is always recoverable.

---

## 11.7 Finance

```sql
fee_head (id, tenant_id, code, name_bn, name_en,
          frequency CHECK IN ('one_time','monthly','term','annual'),
          is_refundable, gl_code NULL, sequence)

fee_structure (id, tenant_id, academic_year_id, class_level_id NULL,
               section_id NULL, fee_head_id, amount_minor, due_day)
fee_assignment (id, tenant_id, student_id, fee_head_id, academic_year_id,
                amount_minor, reason)      -- per-student override

discount (id, tenant_id, student_id, fee_head_id NULL, type, value_minor,
          percent, valid_from, valid_to, reason,
          requested_by, approved_by, approved_at,
          status CHECK IN ('pending','approved','rejected','revoked'))

invoice (id, tenant_id, student_id, academic_year_id, period_label,
         issued_on, due_date,
         total_minor, discount_minor, late_fee_minor, paid_minor,
         status CHECK IN ('draft','issued','partially_paid','paid',
                          'written_off','void'),
         carried_forward_from_invoice_id NULL)     -- arrears across years (FR-8.7)
invoice_line (id, tenant_id, invoice_id, fee_head_id, description,
              amount_minor, discount_minor)

-- Gapless per school per fiscal year. Locked FOR UPDATE inside the payment tx.
receipt_sequence (tenant_id, school_id, fiscal_year, next_value,
                  PRIMARY KEY (tenant_id, school_id, fiscal_year))

payment (
  id, tenant_id, student_id,
  receipt_no,                              -- gapless, from receipt_sequence
  amount_minor, currency DEFAULT 'BDT',
  channel CHECK IN ('cash','bank','cheque','mfs','online'),
  channel_ref NULL,                        -- deposit slip, cheque no, trx id
  collected_by, collected_at,              -- may be backdated (FR-8.11)
  recorded_at,                             -- when it was actually typed
  idempotency_key UNIQUE,
  reversed_by_payment_id NULL,             -- refunds are reversing rows, never deletes
  UNIQUE (tenant_id, school_id, fiscal_year, receipt_no)
)
payment_allocation (id, tenant_id, payment_id, invoice_line_id, amount_minor)
  -- Partial payments spread across heads in a configured order (FR-8.6)

late_fee_accrual (id, tenant_id, invoice_id, accrued_on, amount_minor,
                  rule_id, waived_by NULL, waive_reason NULL)

collection_session (id, tenant_id, collector_person_id, business_date,
                    opened_at, closed_at,
                    expected_minor, counted_minor, variance_minor,
                    deposit_reference, status)   -- daily reconciliation (FR-8.10)

payment_gateway_event (id, tenant_id, provider, provider_ref, event_type,
                       signature_verified, payload jsonb, received_at,
                       processed_at, payment_id NULL,
                       UNIQUE (provider, provider_ref, event_type))
  -- Phase 2. The unique key IS the replay protection (FR-8.15).
```

**`collected_at` and `recorded_at` are different columns.** The office enters
Saturday's cash on Monday. Collapsing them makes every daily collection report
wrong and makes backdating indistinguishable from fraud.

**Refunds are reversing rows.** `reversed_by_payment_id` preserves both sides.
A deleted payment is an unexplainable gap in a gapless sequence.

### On double-entry (FR-8.17)

Not built now. The upgrade path, so the decision stays open: `payment`,
`invoice_line`, `discount` and `late_fee_accrual` already carry an optional
`gl_code` and every row is immutable-with-reversal. A future `ledger_entry`
table can be **derived** from these rows for any historical period, because no
information has been destroyed. Had rows been mutated in place, that derivation
would be impossible.

---

## 11.8 Assessment

The highest-risk module. Rules are data; the engine is a pure function
([ADR-0012](../adr/0012-assessment-engine.md)).

```sql
grade_scale (id, tenant_id, name, kind CHECK IN ('gpa','letter','pass_fail',
                                                 'descriptive'))
grade_band (id, tenant_id, grade_scale_id, min_percent, max_percent,
            label_bn, label_en, grade_point, is_failing, sequence)

-- A named, versioned bundle of rules. Editing a published scheme forks a version.
assessment_scheme (
  id, tenant_id, name, academic_year_id, class_level_id NULL,
  grade_scale_id, version, status CHECK IN ('draft','published','archived'),
  aggregation_rule jsonb,      -- weighted_sum | best_of_n | average
  optional_subject_rule jsonb, -- { thresholdPercent, contributesAbove, maxContribution }
  ranking_rule jsonb,          -- { scope, tieBreak: ['total','subjectId:...','dob'] }
  promotion_rule jsonb         -- { minAttendancePercent, maxCarryForwardSubjects }
)

-- Per-subject components: CQ, MCQ, practical, viva, continuous assessment.
assessment_component (
  id, tenant_id, assessment_scheme_id, subject_id,
  code, name_bn, name_en,
  full_marks_minor, weight_percent,
  pass_mark_minor NULL,          -- component-level pass requirement (FR-7.2)
  is_required_to_pass boolean,
  sequence
)

exam (id, tenant_id, academic_year_id, term_id, name_bn, name_en,
      assessment_scheme_id, class_level_id,
      status CHECK IN ('planned','scheduled','in_progress','marks_open',
                       'marks_locked','tabulated','published','revised'),
      marks_locked_at, marks_locked_by, published_at, published_by)

exam_schedule (id, tenant_id, exam_id, subject_id, section_id NULL,
               date, start_time, end_time, duration_minutes, room,
               invigilator_staff_id NULL)

-- The row FR-7.5 turns on. See the CHECK constraint in §10.11.
mark (
  id, tenant_id, exam_id, student_id, subject_id, assessment_component_id,
  score_minor NULL,
  state CHECK IN ('entered','absent','exempt','incomplete'),
  entered_by, entered_at,
  UNIQUE (tenant_id, exam_id, student_id, assessment_component_id)
)

mark_adjustment (id, tenant_id, mark_id, kind CHECK IN ('grace','moderation',
                 'recheck','correction'),
                 delta_minor, reason, requested_by, approved_by, approved_at)

-- Competency/rubric assessment lives beside marks, not instead of them (FR-7.1).
competency (id, tenant_id, curriculum_id, subject_id NULL, code,
            statement_bn, statement_en, class_level_id)
competency_scale_level (id, tenant_id, grade_scale_id, label_bn, label_en,
                        sequence)
competency_assessment (id, tenant_id, exam_id, student_id, competency_id,
                       level_id, remark, assessed_by, assessed_at)

-- Immutable published output. Revisions create a new version.
result_snapshot (
  id, tenant_id, exam_id, student_id,
  scheme_version, computed_at, computation_hash,
  total_minor, percent, grade_label, grade_point, position_in_section,
  position_in_class, is_passed, failed_subject_ids uuid[],
  payload jsonb,                 -- full per-subject breakdown as computed
  version, superseded_by_id NULL,
  UNIQUE (tenant_id, exam_id, student_id, version)
)

result_publication (id, tenant_id, exam_id, version, audience,
                    visible_from, visible_to, published_by, revoked_at,
                    revoke_reason)
  -- Publication is a reversible EVENT with a per-audience window (FR-7.11)
```

Three properties this schema buys:

- **`computation_hash`** over the inputs and the scheme version means a
  recomputation that produces a different number is *detectable*, not silent.
- **`result_snapshot` is immutable.** A post-publication correction writes
  version 2 and points version 1 at it. The guardian who screenshotted the
  original can always be shown what they saw and why it changed.
- **Publication is revocable.** `revoked_at` plus a visibility window makes
  "unpublish the Class 6 results, the tabulation was wrong" a supported action
  rather than a database emergency.

---

## 11.9 Notification, documents, import

```sql
notification_template (id, tenant_id NULL, code, channel, locale,
                       subject NULL, body, variables jsonb, version)
notification_campaign (id, tenant_id, template_id, audience_query jsonb,
                       scheduled_for, status, created_by,
                       estimated_segments, estimated_cost_minor)
notification_message (id, tenant_id, campaign_id NULL, channel,
                      to_value, person_id NULL, body_rendered,
                      segments, cost_minor,
                      status CHECK IN ('queued','sent','delivered','failed',
                                       'suppressed'),
                      provider, provider_ref, sent_at, delivered_at,
                      failure_reason, dedup_key)
notification_suppression (id, tenant_id, channel, value, reason, created_at)
sms_credit_ledger (id, tenant_id, delta_minor, balance_minor, reason, at)

document_template (id, tenant_id NULL, code, kind, name, engine DEFAULT 'html',
                   body_html, styles_css, page_size, version, is_active)
document_render (id, tenant_id, template_id, subject_type, subject_id,
                 params jsonb, storage_key, page_count, rendered_at,
                 rendered_by, status, expires_at)

import_batch (id, tenant_id, kind, filename, storage_key, row_count,
              status CHECK IN ('uploaded','validating','validated','committing',
                               'committed','failed','rolled_back'),
              dry_run_report jsonb, committed_at, actor_person_id)
import_row (id, tenant_id, import_batch_id, row_no, raw jsonb,
            status CHECK IN ('pending','valid','invalid','committed','skipped'),
            errors jsonb,          -- localised messages, per cell (FR-11.3)
            target_type, target_id NULL,
            duplicate_of_id NULL, duplicate_score)

export_job (id, tenant_id, kind, requested_by, status, storage_key,
            expires_at, completed_at)
```

`dedup_key` on `notification_message` is how FR-9.4 works: two siblings absent
on the same day produce one key, so one SMS reaches the shared phone.

`estimated_segments` and `estimated_cost_minor` on the campaign are computed
**before** send and shown to the author, per FR-9.2.

---

## 11.10 Cross-cutting

```sql
-- [T] Every mutation. Partitioned by month once §10.7's trigger is hit.
audit_log (
  id, tenant_id, at, actor_person_id NULL, actor_account_id NULL,
  entity_type, entity_id, action,
  before jsonb, after jsonb,          -- redacted: no PII values, ids only
  reason NULL, request_id, ip, user_agent
)

-- [T] Idempotency for every money-moving and bulk endpoint (FR-X.6).
idempotency_key (
  tenant_id, key, endpoint, request_hash,
  response_status, response_body jsonb, created_at, expires_at,
  PRIMARY KEY (tenant_id, key)
)

-- [T] Outbound domain events, for observability and replay.
domain_event (id, tenant_id, type, aggregate_type, aggregate_id,
              payload jsonb, occurred_at, published_at)
```

---

## 11.11 Entity count and what it implies

| Module | Approx. tables |
|---|---|
| platform + identity | 18 |
| structure | 8 |
| directory | 12 |
| calendar | 8 |
| academics + attendance | 12 |
| finance | 12 |
| assessment | 14 |
| notification + documents + dataport | 14 |
| cross-cutting | 4 |
| **MVP total** | **≈ 102** |

About a hundred tables for the MVP. Worth stating plainly, because it is the
same scope observation as [§1](01-executive-summary.md) in a different unit:
this is not a small system, and no architecture makes it one. What the
architecture *can* do is ensure that none of these hundred tables can leak
across tenants, lose money, or turn an absent student into a zero.
