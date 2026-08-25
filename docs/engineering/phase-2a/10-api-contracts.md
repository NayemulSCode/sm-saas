# 10. API contracts and DTOs — Phase 3a

Conventions are fixed in [§19](../../architecture/phase-1b/19-api-architecture.md).
This is the concrete endpoint catalogue and the Zod schemas for the foundation
modules.

One Zod schema per input, **shared by the client form and the server handler**,
so the two cannot drift. OpenAPI is generated from these — one source of truth.

## 10.1 Shared primitives

```ts
// src/shared/api/primitives.ts
export const zUlid   = <T extends string>() =>
  z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).transform(s => s as Id<T>);

/** Money on the wire is a STRING of minor units. A JSON number is an IEEE 754
 *  double and silently loses precision above 2^53. §19.11 */
export const zMoney  = z.string().regex(/^-?\d{1,18}$/)
                        .transform(s => Money.fromMinor(BigInt(s)));

export const zLocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
                           .transform(s => LocalDate.parse(s).value);

export const zPhoneBd = z.string().transform(normalisePhone);   // → E.164
export const zNameBn  = z.string().trim().min(1).max(120).transform(nfc);
export const zNameEn  = z.string().trim().min(1).max(120).transform(nfc);

export const zPage = z.object({
  limit:  z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
```

`nfc` is Unicode NFC normalisation, applied at the boundary so it can never be
forgotten ([ADR-0019](../../architecture/adr/0019-i18n-content-split.md)). It is
in the *schema*, not in a service, because every write path goes through a schema.

## 10.2 Envelope

```jsonc
{ "data": { … }, "meta": { "requestId": "01J…" } }
{ "data": [ … ], "meta": { "requestId": "01J…", "nextCursor": "…", "hasMore": true } }
{ "error": { "code": "ROLL_NUMBER_TAKEN",
             "message": "এই রোল নম্বরটি ইতিমধ্যে ব্যবহৃত",
             "details": [{ "field": "rollNo", "code": "TAKEN" }],
             "requestId": "01J…" } }
```

`code` is stable and never localised. `message` is localised and never parsed.

## 10.3 Auth

| Method | Path | Permission | Notes |
|---|---|---|---|
| `POST` | `/api/v1/auth/otp/request` | — | Rate limited per phone **and** IP; identical response for unknown numbers |
| `POST` | `/api/v1/auth/otp/verify` | — | Single-use, 5 attempts |
| `POST` | `/api/v1/auth/password` | — | Lockout after 5 failures |
| `POST` | `/api/v1/auth/logout` | authenticated | Revokes the current session |
| `POST` | `/api/v1/auth/logout-all` | authenticated | Revokes every session for the account |
| `GET` | `/api/v1/auth/me` | authenticated | Account, active context, permissions, scope |
| `GET` | `/api/v1/auth/contexts` | authenticated | The switcher list |
| `POST` | `/api/v1/auth/contexts/:membershipId:activate` | authenticated | Server verifies ownership |
| `POST` | `/api/v1/auth/invite/accept` | — | Single-use token; sets the password |

```ts
export const OtpRequestSchema = z.object({ phone: zPhoneBd });

export const OtpVerifySchema = z.object({
  challengeId: zUlid<'otpChallenge'>(),
  code: z.string().regex(/^\d{6}$/),
});

export const PasswordLoginSchema = z.object({
  identifier: z.string().min(3).max(160),      // phone or email; normalised server-side
  password:   z.string().min(8).max(200),
});

export const MeResponse = z.object({
  account:  z.object({ id: zUlid<'account'>(), locale: z.enum(['en','bn']) }),
  context:  z.object({
    tenantId: zUlid<'tenant'>(), tenantName: z.string(),
    personId: zUlid<'person'>(), personName: z.string(),
    roles: z.array(z.string()),
    permissions: z.array(z.string()),
    scope: ScopeSchema,
    readOnly: z.boolean(),                     // suspended tenant
  }),
  contextCount: z.number().int(),              // >1 ⇒ show the switcher
});
```

## 10.4 Structure

| Method | Path | Permission |
|---|---|---|
| `GET`/`POST` | `/api/v1/schools` | `structure.read` / `structure.manage` |
| `GET`/`PATCH` | `/api/v1/schools/:id` | |
| `GET`/`POST` | `/api/v1/campuses` | |
| `GET`/`POST` | `/api/v1/shifts` | |
| `GET`/`POST` | `/api/v1/class-levels` | |
| `POST` | `/api/v1/class-levels:reorder` | `structure.manage` |
| `GET`/`POST` | `/api/v1/sections` | |
| `GET`/`POST` | `/api/v1/academic-years` | `academicYear.manage` |
| `POST` | `/api/v1/academic-years/:id:setCurrent` | `academicYear.manage` |
| `POST` | `/api/v1/academic-years/:id:close` | `academicYear.close` |

```ts
export const CreateSectionSchema = z.object({
  classLevelId: zUlid<'classLevel'>(),
  campusId:     zUlid<'campus'>(),
  shiftId:      zUlid<'shift'>(),              // required — a section without a
                                               // shift is unschedulable (§4.1)
  nameBn: zNameBn, nameEn: zNameEn,
  capacity: z.number().int().positive().optional(),
  classTeacherId: zUlid<'staff'>().optional(),
});

export const CloseAcademicYearSchema = z.object({
  reason: z.string().min(10),                  // dangerous: reason required
});
// 423 YEAR_HAS_OPEN_WORK if any exam is marks_open or any invoice is draft.
```

## 10.5 Directory

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/api/v1/students` | `student.read` | Keyset; scope-narrowed in SQL |
| `POST` | `/api/v1/students` | `student.write` | Creates person + student + enrolment atomically |
| `GET`/`PATCH` | `/api/v1/students/:id` | | `PATCH` takes `version` for optimistic locking |
| `POST` | `/api/v1/students/:id:admit` | `student.transition` | |
| `POST` | `/api/v1/students/:id:withdraw` | `student.transition` | Reason + effective date required |
| `POST` | `/api/v1/students/:id:markAlumni` | `student.transition` | |
| `GET` | `/api/v1/students/:id/guardians` | `guardian.read` | |
| `POST` | `/api/v1/students/:id/guardians` | `guardian.write` | |
| `PATCH` | `/api/v1/guardian-links/:id` | `guardian.write` | Flags: billing / primary contact |
| `GET` | `/api/v1/students/:id/enrolments` | `student.read` | Full history |
| `POST` | `/api/v1/sections/:id:promote` | `enrolment.promote` | **Idempotency-Key required** |
| `GET` | `/api/v1/duplicates/persons` | `student.merge` | Review queue |
| `POST` | `/api/v1/persons/:id:merge` | `student.merge` | Dangerous; reason required |
| `GET`/`POST` | `/api/v1/staff` | `staff.read` / `staff.write` | |

```ts
export const CreateStudentSchema = z.object({
  person: z.object({
    nameBn: zNameBn,                           // BOTH required — ADR-0019
    nameEn: zNameEn,
    dateOfBirth: zLocalDate.optional(),
    gender: z.enum(['male','female','other']).optional(),
    phone: zPhoneBd.optional(),                // CONTACT detail, not a login
    birthRegNo: z.string().max(40).optional(),
    address: AddressSchema.optional(),
  }),
  studentCode: z.string().max(32).optional(),  // generated if absent
  enrolment: z.object({
    sectionId:      zUlid<'section'>(),
    academicYearId: zUlid<'academicYear'>(),
    rollNo: z.number().int().positive().optional(),
    enrolledOn: zLocalDate,
  }),
  guardians: z.array(z.object({
    personId: zUlid<'person'>().optional(),    // link an EXISTING person…
    person: PersonInputSchema.optional(),      // …or create one
    relationship: z.enum(['father','mother','guardian','emergency','other']),
    isBillingGuardian: z.boolean().default(false),
    isPrimaryContact:  z.boolean().default(false),
    canReceiveResults: z.boolean().default(true),
  })).max(6).default([]),
}).refine(g => atMostOne(g.guardians, 'isBillingGuardian'),
          { message: 'errors.guardian.multipleBilling' })
  .refine(g => atMostOne(g.guardians, 'isPrimaryContact'),
          { message: 'errors.guardian.multiplePrimary' });
```

The two `refine`s mirror the partial unique indexes in
[§4.2](04-schema-structure-directory.md). Validating in both places is
deliberate: the schema gives a good error message, the index guarantees the
invariant under concurrency.

```ts
export const PromoteSectionSchema = z.object({
  fromAcademicYearId: zUlid<'academicYear'>(),
  toAcademicYearId:   zUlid<'academicYear'>(),
  defaultTargetSectionId: zUlid<'section'>(),
  rollStrategy: z.enum(['byName','byResult','keepExisting','manual']),
  exceptions: z.array(z.object({
    studentId: zUlid<'student'>(),
    action: z.enum(['retain','transfer','withdraw']),
    targetSectionId: zUlid<'section'>().optional(),
    reason: z.string().min(3),
  })).default([]),
});
// Runs as a chunked job with a recorded batch id and a compensating action:
// "undo the promotion, we ran it on the wrong section" is supported (§14.5).
// Does NOT touch dues — arrears carry forward via finance (§17.6).
```

## 10.6 Platform

Separate host, operator session, MFA, `sm_platform` pool.

| Method | Path | Permission |
|---|---|---|
| `POST` | `/api/platform/v1/tenants` | `platform.tenant.provision` |
| `GET` | `/api/platform/v1/tenants` | `platform.usage.read` |
| `POST` | `/api/platform/v1/tenants/:id:suspend` | `platform.tenant.suspend` |
| `POST` | `/api/platform/v1/tenants/:id:reactivate` | `platform.tenant.suspend` |
| `POST` | `/api/platform/v1/tenants/:id:impersonate` | `platform.impersonate` |
| `PATCH` | `/api/platform/v1/tenants/:id/features` | `platform.plan.manage` |

```ts
export const ProvisionTenantSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/),
  nameBn: zNameBn, nameEn: zNameEn,
  planCode: z.string(),
  owner: z.object({ nameBn: zNameBn, nameEn: zNameEn, phone: zPhoneBd }),
  school: z.object({ eiin: z.string().max(20).optional(),
                     address: AddressSchema.optional() }),
  academicYear: z.object({ name: z.string(), startDate: zLocalDate,
                           endDate: zLocalDate }),
}).strict();

export const ImpersonateSchema = z.object({
  reason: z.string().min(20),                  // mandatory, substantive
  durationMinutes: z.number().int().min(5).max(30).default(30),
});
// Tenant owners are notified. Every action during the session carries
// impersonated_by in audit_log. ADR-0029.
```

## 10.7 Cross-cutting request rules

| Rule | Detail |
|---|---|
| Idempotency | `Idempotency-Key` **required** on `:promote`, `:merge`, import commit, and every money endpoint in 3b |
| Optimistic locking | `PATCH` bodies carry `version`; mismatch → `409 CONCURRENT_MODIFICATION` |
| State transitions | Verbs (`:withdraw`), never `PATCH {status}` — they need a reason, a date and an audit row |
| Tenant | From the Host header only. Never a body field or query parameter |
| Money | Strings of minor units, in and out |
| Dates | `YYYY-MM-DD` for days; RFC 3339 for instants |
| Max body | 1 MB. Uploads use a separate signed-URL flow |
| Locale | `Accept-Language`, overridden by the stored preference |
| Deletes | `DELETE` is a soft delete and requires `reason` |

## 10.8 Uploads

Never through the API body.

```
POST /api/v1/uploads:sign  { ownerType, ownerId, docType, mime, sizeBytes }
  → authorize FIRST, then sign            (invariant 13)
  → { uploadUrl, storageKey, expiresIn: 300 }
PUT  <uploadUrl>                          direct to R2
POST /api/v1/documents     { storageKey, … }   registers the row
```

Authorization is checked **before** the URL is signed, never after. Validation —
MIME sniffing, size cap, image re-encode, EXIF strip — happens on registration
and asynchronously on the object
([ADR-0015](../../architecture/adr/0015-object-storage.md)).
