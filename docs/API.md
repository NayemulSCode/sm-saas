# API

**Generated — do not edit.** `pnpm docs:api` rebuilds this and
[`openapi.json`](openapi.json) from `src/shared/api/registry.ts`, whose
request shapes are the same Zod schemas the handlers validate with.

## Before anything else

**The tenant is chosen by HOST.** `demo.example.com` is one school,
`other.example.com` is another. No request names a tenant — the server
derives it from the session, which is why a client can never reach across
schools even by guessing an id.

**Branch on `code`, never on `message`.** `code` is stable and never
localised; `message` is localised and never parsed.

```jsonc
{ "data": { }, "meta": { "requestId": "…" } }
{ "error": { "code": "STUDENT_NOT_FOUND", "message": "…", "requestId": "…" } }
```

**Authentication is an `HttpOnly` cookie**, `sm_session`, set by the login
endpoints. It is never in a response body and cannot be read from script.

### Refusals every authenticated endpoint can produce

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | The body does not match the schema. `details` names the fields. |
| 403 | `FORBIDDEN` | No session cookie, or the session lacks the permission. |
| 401 | `SESSION_INVALID` | The session cookie is unknown, expired or revoked. |
| 409 | `TENANT_SUSPENDED` | The school is read-only; reads succeed, writes do not. |

## Endpoints

### Authentication

| | Endpoint | Permission |
|---|---|---|
| `POST` | [`/api/v1/auth/otp/request`](#post-api-v1-auth-otp-request) | — |
| `POST` | [`/api/v1/auth/otp/verify`](#post-api-v1-auth-otp-verify) | — |
| `POST` | [`/api/v1/auth/password`](#post-api-v1-auth-password) | — |
| `POST` | [`/api/v1/auth/invite/accept`](#post-api-v1-auth-invite-accept) | — |
| `GET` | [`/api/v1/auth/me`](#get-api-v1-auth-me) | session |
| `GET` | [`/api/v1/auth/contexts`](#get-api-v1-auth-contexts) | session |
| `POST` | [`/api/v1/auth/contexts/{membershipId}/activate`](#post-api-v1-auth-contexts-membershipId-activate) | session |
| `POST` | [`/api/v1/auth/logout`](#post-api-v1-auth-logout) | session |

### Structure

| | Endpoint | Permission |
|---|---|---|
| `GET` | [`/api/v1/structure`](#get-api-v1-structure) | `structure.read` |
| `POST` | [`/api/v1/academic-years`](#post-api-v1-academic-years) | `academicYear.manage` |
| `POST` | [`/api/v1/academic-years/{academicYearId}/close`](#post-api-v1-academic-years-academicYearId-close) | `academicYear.close` |
| `POST` | [`/api/v1/class-levels`](#post-api-v1-class-levels) | `structure.manage` |
| `POST` | [`/api/v1/class-levels/reorder`](#post-api-v1-class-levels-reorder) | `structure.manage` |
| `POST` | [`/api/v1/shifts`](#post-api-v1-shifts) | `structure.manage` |
| `POST` | [`/api/v1/sections`](#post-api-v1-sections) | `structure.manage` |
| `PATCH` | [`/api/v1/sections/{sectionId}`](#patch-api-v1-sections-sectionId) | `structure.manage` |

### Students

| | Endpoint | Permission |
|---|---|---|
| `GET` | [`/api/v1/students`](#get-api-v1-students) | `student.read` |
| `POST` | [`/api/v1/students`](#post-api-v1-students) | `student.write` |
| `GET` | [`/api/v1/students/{studentId}`](#get-api-v1-students-studentId) | `student.read` |
| `PATCH` | [`/api/v1/students/{studentId}`](#patch-api-v1-students-studentId) | `student.write` |
| `POST` | [`/api/v1/students/{studentId}/transition`](#post-api-v1-students-studentId-transition) | `student.transition` |
| `POST` | [`/api/v1/students/{studentId}/withdraw`](#post-api-v1-students-studentId-withdraw) | `student.transition` |
| `POST` | [`/api/v1/students/{studentId}/siblings`](#post-api-v1-students-studentId-siblings) | `student.write` |

### Guardians

| | Endpoint | Permission |
|---|---|---|
| `POST` | [`/api/v1/students/{studentId}/guardians`](#post-api-v1-students-studentId-guardians) | `guardian.write` |
| `POST` | [`/api/v1/students/{studentId}/guardians/unlink`](#post-api-v1-students-studentId-guardians-unlink) | `guardian.write` |

### Promotion

| | Endpoint | Permission |
|---|---|---|
| `POST` | [`/api/v1/sections/{sectionId}/promote`](#post-api-v1-sections-sectionId-promote) | `enrolment.promote` |
| `POST` | [`/api/v1/promotions/{batchId}/undo`](#post-api-v1-promotions-batchId-undo) | `enrolment.promote` |

### People

| | Endpoint | Permission |
|---|---|---|
| `POST` | [`/api/v1/persons/{personId}/merge`](#post-api-v1-persons-personId-merge) | `student.merge` |
| `POST` | [`/api/v1/merges/{mergeId}/reverse`](#post-api-v1-merges-mergeId-reverse) | `student.merge` |

### Staff and roles

| | Endpoint | Permission |
|---|---|---|
| `GET` | [`/api/v1/members`](#get-api-v1-members) | `staff.read` |
| `GET` | [`/api/v1/roles`](#get-api-v1-roles) | `role.manage` |
| `POST` | [`/api/v1/staff/invites`](#post-api-v1-staff-invites) | `membership.manage` |
| `POST` | [`/api/v1/staff/invites/{membershipId}/revoke`](#post-api-v1-staff-invites-membershipId-revoke) | `membership.manage` |
| `POST` | [`/api/v1/memberships/{membershipId}/roles`](#post-api-v1-memberships-membershipId-roles) | `role.manage` |
| `POST` | [`/api/v1/memberships/{membershipId}/roles/revoke`](#post-api-v1-memberships-membershipId-roles-revoke) | `role.manage` |

### Operations

| | Endpoint | Permission |
|---|---|---|
| `GET` | [`/api/health/live`](#get-api-health-live) | — |
| `GET` | [`/api/health/ready`](#get-api-health-ready) | — |
| `GET` | [`/api/v1/health`](#get-api-v1-health) | — |
| `GET` | [`/api/platform/v1/health`](#get-api-platform-v1-health) | — |
| `GET` | [`/api/public/v1/health`](#get-api-public-v1-health) | — |
| `POST` | [`/api/hooks/{provider}`](#post-api-hooks-provider) | — |

## Authentication

### `POST /api/v1/auth/otp/request`

**Send a login code**

Guardians sign in this way and have no password at all. The response is IDENTICAL whether or not the number belongs to anybody — an endpoint that distinguishes them is a tool for discovering who is enrolled at a school.

_No authentication._

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "identifier": {
      "type": "string",
      "minLength": 3,
      "maxLength": 160
    }
  },
  "required": [
    "identifier"
  ]
}
```

**200** — `{ accepted: true, expiresInSeconds }` — always, even for an unknown number.

**Refusals**

| Status | Code | When |
|---|---|---|
| 429 | `RATE_LIMITED` | Too many requests for this number or IP. `Retry-After` is set. |

> A resend within the validity window reuses the live code rather than minting a second one: two valid codes double both the guessing surface and the SMS bill.

### `POST /api/v1/auth/otp/verify`

**Exchange a code for a session**

_No authentication._

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "identifier": {
      "type": "string",
      "minLength": 3,
      "maxLength": 160
    },
    "code": {
      "type": "string",
      "pattern": "^\\d{6}$"
    }
  },
  "required": [
    "identifier",
    "code"
  ]
}
```

**200** — Sets an `HttpOnly` `sm_session` cookie and returns the contexts this login reaches. The token is never in the body.

**Refusals**

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_CODE` | Wrong, expired, already used, or the number is unknown — deliberately indistinguishable. |
| 423 | `ACCOUNT_LOCKED` | Too many failed attempts. |
| 403 | `NO_MEMBERSHIP` | The account exists but belongs to no school. |

> With exactly one context the session activates it; with several the caller must call `activate`.

### `POST /api/v1/auth/password`

**Sign in with a password**

Staff only. Guardians have no password.

_No authentication._

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "identifier": {
      "type": "string",
      "minLength": 3,
      "maxLength": 160
    },
    "password": {
      "type": "string",
      "minLength": 8,
      "maxLength": 200
    }
  },
  "required": [
    "identifier",
    "password"
  ]
}
```

**200** — Sets the `sm_session` cookie, same shape as OTP verification.

**Refusals**

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_CREDENTIALS` | Wrong password, unknown identifier, or an OTP-only account — all the same answer, in the same time. |
| 423 | `ACCOUNT_LOCKED` | Five failed attempts. Fifteen minutes. |

### `POST /api/v1/auth/invite/accept`

**Accept a staff invite and set a password**

Unauthenticated: the single-use token IS the credential.

_No authentication._

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "token": {
      "type": "string",
      "minLength": 20,
      "maxLength": 200
    },
    "password": {
      "type": "string",
      "minLength": 8,
      "maxLength": 200
    }
  },
  "required": [
    "token",
    "password"
  ]
}
```

**200** — Sets the password, opens a session, and sets the cookie — so the new member lands signed in.

**Refusals**

| Status | Code | When |
|---|---|---|
| 400 | `INVITE_INVALID` | Unknown, expired, revoked or already used — indistinguishable on purpose. |
| 409 | `PASSWORD_ALREADY_SET` | They already had a password; the invite is consumed anyway. |

### `GET /api/v1/auth/me`

**The current session**

_Requires a session._

**200** — `{ accountId, activeMembershipId, readOnly }`. `readOnly` is true for a suspended school.

### `GET /api/v1/auth/contexts`

**Schools this login reaches**

_Requires a session._

**200** — One entry per membership, with the school slug and which is active.

### `POST /api/v1/auth/contexts/{membershipId}/activate`

**Switch school**

The caller supplies a membership id and nothing else. Which tenant the session lands in is derived from that membership server-side; a client can never name a tenant.

_Requires a session._

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "membershipId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    }
  },
  "required": [
    "membershipId"
  ]
}
```

**200** — Success.

**Refusals**

| Status | Code | When |
|---|---|---|
| 404 | `CONTEXT_NOT_FOUND` | The membership belongs to another account, or does not exist. |
| 409 | `TENANT_UNAVAILABLE` | That school is cancelled or purged. |

### `POST /api/v1/auth/logout`

**Revoke this session**

Server-side state, so it takes effect on the very next request — the whole reason for not using JWTs.

_Requires a session._

**200** — Success.

## Structure

### `GET /api/v1/structure`

**The whole shape of a school**

School, current year, campuses, shifts, class levels and sections in one read — four round trips on a 3G connection is the alternative.

_Permission: `structure.read`_

**Query**

| Name | Meaning |
|---|---|
| `schoolId` | Optional. Most tenants have one school, and it is resolved for you. |

**200** — Success.

### `POST /api/v1/academic-years`

**Open an academic year**

_Permission: `academicYear.manage`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "schoolId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 40
    },
    "startDate": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
    },
    "endDate": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
    },
    "makeCurrent": {
      "default": true,
      "type": "boolean"
    }
  },
  "required": [
    "schoolId",
    "name",
    "startDate",
    "endDate"
  ]
}
```

**201** — Success.

**Refusals**

| Status | Code | When |
|---|---|---|
| 409 | `YEAR_NAME_TAKEN` | A year of that name exists at this school. |
| 409 | `YEAR_OVERLAPS` | Two years must not cover the same day — "which year is this date in?" needs one answer. |
| 400 | `INVALID_YEAR_DATES` | Backwards, or longer than 400 days. |

> `makeCurrent` demotes the previous current year in the same transaction, so a school is never left without one.

### `POST /api/v1/academic-years/{academicYearId}/close`

**Close an academic year**

_Permission: `academicYear.close`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "reason": {
      "type": "string",
      "minLength": 10,
      "maxLength": 280
    }
  },
  "required": [
    "reason"
  ]
}
```

**200** — Success.

**Refusals**

| Status | Code | When |
|---|---|---|
| 409 | `YEAR_STILL_CURRENT` | Open the successor first — that moves the flag — then close this one. |
| 409 | `YEAR_ALREADY_CLOSED` | Already closed. |
| 409 | `YEAR_HAS_OPEN_WORK` | Reserved for open exams and draft invoices. Neither module ships in 3a, so this cannot currently occur. |

### `POST /api/v1/class-levels`

**Add a class**

Added at the top of the ladder unless `sequence` says otherwise.

_Permission: `structure.manage`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "schoolId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "nameBn": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "nameEn": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "medium": {
      "type": "string",
      "enum": [
        "bangla",
        "english",
        "other"
      ]
    },
    "loginEnabled": {
      "default": false,
      "type": "boolean"
    },
    "sequence": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "schoolId",
    "nameBn",
    "nameEn"
  ]
}
```

**201** — Success.

**Refusals**

| Status | Code | When |
|---|---|---|
| 409 | `LEVEL_NAME_TAKEN` | That name, or that sequence, is in use. |

### `POST /api/v1/class-levels/reorder`

**Reorder the class ladder**

`sequence` is promotion order — this changes what "the next class up" means.

_Permission: `structure.manage`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "schoolId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "orderedIds": {
      "minItems": 1,
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
      }
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 280
    }
  },
  "required": [
    "schoolId",
    "orderedIds",
    "reason"
  ]
}
```

**200** — Success.

**Refusals**

| Status | Code | When |
|---|---|---|
| 409 | `REORDER_MID_YEAR` | Students are enrolled in the current year. Promotion is keyed to this order. |
| 400 | `LEVEL_ORDER_INCOMPLETE` | The list must name every class exactly once — it is the complete order, not a diff. |
| 404 | `LEVEL_NOT_FOUND` | An id in the list is not a class at this school. |

### `POST /api/v1/shifts`

**Add a shift**

A shift is a first-class entity with its own timetable and working-day calendar, not a label on a section.

_Permission: `structure.manage`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "campusId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "nameBn": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "nameEn": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "startTime": {
      "type": "string",
      "pattern": "^([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?$"
    },
    "endTime": {
      "type": "string",
      "pattern": "^([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?$"
    }
  },
  "required": [
    "campusId",
    "nameBn",
    "nameEn",
    "startTime",
    "endTime"
  ]
}
```

**201** — Success.

**Refusals**

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_SHIFT_TIMES` | Ends before it starts, or not `HH:MM`. |
| 404 | `CAMPUS_NOT_FOUND` | No such campus in this school. |

### `POST /api/v1/sections`

**Create a section**

_Permission: `structure.manage`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "schoolId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "classLevelId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "campusId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "shiftId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "nameBn": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "nameEn": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "capacity": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "classTeacherId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    }
  },
  "required": [
    "schoolId",
    "classLevelId",
    "campusId",
    "shiftId",
    "nameBn",
    "nameEn"
  ]
}
```

**201** — Success.

**Refusals**

| Status | Code | When |
|---|---|---|
| 409 | `SHIFT_WRONG_CAMPUS` | The working-day calendar is keyed by (campus, shift), so a borrowed shift leaves the section with no calendar. |
| 404 | `CLASS_LEVEL_NOT_FOUND` | No such class at this school. |
| 404 | `CAMPUS_NOT_FOUND` | No such campus. |
| 404 | `CLASS_TEACHER_NOT_FOUND` | No such staff member. |
| 400 | `INVALID_CAPACITY` | Capacity must be a positive whole number. |

### `PATCH /api/v1/sections/{sectionId}`

**Update a section**

_Permission: `structure.manage`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "nameBn": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "nameEn": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "capacity": {
      "anyOf": [
        {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "classTeacherId": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
        },
        {
          "type": "null"
        }
      ]
    }
  }
}
```

**200** — Success.

**Refusals**

| Status | Code | When |
|---|---|---|
| 404 | `SECTION_NOT_FOUND` | No such section at this school. |
| 409 | `CAPACITY_BELOW_OCCUPANCY` | Capacity below the students already enrolled. |

> `null` clears a field; omitting it leaves the field alone.

## Students

### `GET /api/v1/students`

**List students**

Keyset paginated, and SCOPE-NARROWED IN SQL — a class teacher scoped to two sections receives two sections of rows, not the school with the rest hidden by the client.

_Permission: `student.read`_

**Query**

| Name | Meaning |
|---|---|
| `sectionId` | Only this section. |
| `academicYearId` | Which year the enrolment columns describe. |
| `status` | One of the lifecycle values. Anything else is ignored rather than rejected — a bookmarked URL should still work. |
| `search` | Matches either name script or the student code. |
| `limit` | 1–100, default 25. Larger values are capped, not refused. |
| `cursor` | From `nextCursor`. Opaque; a malformed one restarts the list rather than erroring. |

**200** — `{ items, nextCursor, hasMore }`. There is deliberately no total — a second count over the same predicate costs as much as the page.

### `POST /api/v1/students`

**Admit a student**

Creates the person, the student, the first enrolment and the opening status event in one transaction.

_Permission: `student.write`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "schoolId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "sectionId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "academicYearId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "nameBn": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "nameEn": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "dateOfBirth": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
    },
    "gender": {
      "type": "string",
      "enum": [
        "male",
        "female",
        "other"
      ]
    },
    "phone": {
      "type": "string",
      "pattern": "^\\+8801[3-9]\\d{8}$"
    },
    "rollNo": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "admittedOn": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
    }
  },
  "required": [
    "schoolId",
    "sectionId",
    "academicYearId",
    "nameBn",
    "nameEn"
  ]
}
```

**201** — `{ studentId, personId, enrolmentId, studentCode }`. The code is generated from the school pattern.

**Refusals**

| Status | Code | When |
|---|---|---|
| 404 | `SECTION_NOT_FOUND` | No such section at this school. |
| 400 | `INVALID_ADMISSION_DATE` | A date is not `YYYY-MM-DD`. |

> Both names are required and neither is a translation of the other: the report card prints one, the board registration list needs the other.

### `GET /api/v1/students/{studentId}`

**One student, with guardians, enrolments and history**

_Permission: `student.read`_

**200** — Includes `student.version`, which `PATCH` requires.

**Refusals**

| Status | Code | When |
|---|---|---|
| 404 | `STUDENT_NOT_FOUND` | Absent, or in another school — RLS makes it invisible rather than forbidden. |

### `PATCH /api/v1/students/{studentId}`

**Correct a student record**

_Permission: `student.write`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "version": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "nameBn": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "nameEn": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "dateOfBirth": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "gender": {
      "anyOf": [
        {
          "type": "string",
          "enum": [
            "male",
            "female",
            "other"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "phone": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^\\+8801[3-9]\\d{8}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "email": {
      "anyOf": [
        {
          "type": "string",
          "format": "email",
          "pattern": "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "house": {
      "anyOf": [
        {
          "type": "string",
          "maxLength": 60
        },
        {
          "type": "null"
        }
      ]
    },
    "religion": {
      "anyOf": [
        {
          "type": "string",
          "maxLength": 60
        },
        {
          "type": "null"
        }
      ]
    },
    "bloodGroup": {
      "anyOf": [
        {
          "type": "string",
          "maxLength": 8
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "version"
  ]
}
```

**200** — The new `version`.

**Refusals**

| Status | Code | When |
|---|---|---|
| 409 | `CONCURRENT_MODIFICATION` | Somebody else saved first. Re-read, re-apply, retry — never overwrite. |
| 400 | `NOTHING_TO_UPDATE` | No field other than `version` was sent. |

> `null` clears a field; omitting it leaves the field alone.

### `POST /api/v1/students/{studentId}/transition`

**Change lifecycle status**

applicant → admitted → active → on_leave → withdrawn → alumni. `alumni` is terminal; `withdrawn → active` is readmission.

_Permission: `student.transition`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "to": {
      "type": "string",
      "enum": [
        "applicant",
        "admitted",
        "active",
        "on_leave",
        "withdrawn",
        "alumni"
      ]
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 280
    },
    "effectiveDate": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
    }
  },
  "required": [
    "to"
  ]
}
```

**200** — Success.

**Refusals**

| Status | Code | When |
|---|---|---|
| 409 | `ILLEGAL_TRANSITION` | Not a legal move. The CHECK constraint permits the value; the school does not. |
| 409 | `ALREADY_IN_STATUS` | Already there. Refused rather than ignored — an event claiming a change that did not happen is worse. |
| 400 | `REASON_REQUIRED` | Withdrawal and leave both require one. |

### `POST /api/v1/students/{studentId}/withdraw`

**Withdraw a student**

A lifecycle event, not a settlement. Outstanding fees are unaffected and handled separately.

_Permission: `student.transition`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 280
    },
    "effectiveDate": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
    }
  },
  "required": [
    "reason"
  ]
}
```

**200** — Success.

### `POST /api/v1/students/{studentId}/siblings`

**Link two siblings**

Drives sibling discounts and SMS deduplication. A student belongs to exactly one group, or a discount applies twice.

_Permission: `student.write`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "siblingStudentId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    }
  },
  "required": [
    "siblingStudentId"
  ]
}
```

**200** — Success.

**Refusals**

| Status | Code | When |
|---|---|---|
| 400 | `SAME_STUDENT` | A student cannot be their own sibling. |
| 409 | `ALREADY_LINKED` | They are already in two different groups — that is a merge, not a link. |

## Guardians

### `POST /api/v1/students/{studentId}/guardians`

**Link a guardian**

`isBillingGuardian` (who owes) and `isPrimaryContact` (who is told) are SEPARATE. Separated parents: one may pay while the other is contacted.

_Permission: `guardian.write`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "guardianPersonId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "person": {
      "type": "object",
      "properties": {
        "nameBn": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "nameEn": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "phone": {
          "type": "string",
          "pattern": "^\\+8801[3-9]\\d{8}$"
        },
        "email": {
          "type": "string",
          "format": "email",
          "pattern": "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
        }
      },
      "required": [
        "nameBn",
        "nameEn"
      ]
    },
    "relationship": {
      "type": "string",
      "enum": [
        "father",
        "mother",
        "guardian",
        "emergency",
        "other"
      ]
    },
    "isBillingGuardian": {
      "default": false,
      "type": "boolean"
    },
    "isPrimaryContact": {
      "default": false,
      "type": "boolean"
    },
    "canReceiveResults": {
      "default": true,
      "type": "boolean"
    },
    "canCollectStudent": {
      "default": true,
      "type": "boolean"
    }
  },
  "required": [
    "relationship"
  ]
}
```

**201** — `{ linkId, demoted }` — `demoted` names any link that lost a flag to this one.

**Refusals**

| Status | Code | When |
|---|---|---|
| 409 | `ALREADY_LINKED` | That person is already a guardian for this student. |
| 409 | `EMERGENCY_CANNOT_BILL` | An emergency contact has not agreed to pay fees; an invoice addressed to a neighbour is a data-entry slip. |
| 404 | `PERSON_NOT_FOUND` | `guardianPersonId` is not a person at this school. |

> Send EXACTLY ONE of `guardianPersonId` or `person`. Naming both is refused rather than resolved by a precedence rule nobody would remember. **This rule is not in the JSON Schema** — a cross-field check cannot be expressed there.

> Claiming either flag demotes the incumbent in the same transaction, so the student is never briefly unbilled.

### `POST /api/v1/students/{studentId}/guardians/unlink`

**Remove a guardian**

_Permission: `guardian.write`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "guardianPersonId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 280
    }
  },
  "required": [
    "guardianPersonId",
    "reason"
  ]
}
```

**200** — Success.

**Refusals**

| Status | Code | When |
|---|---|---|
| 409 | `LAST_CONTACT` | A student with nobody to contact is unreachable — no absence SMS, no results, nobody to call. |
| 409 | `WOULD_LEAVE_NO_BILLER` | Nominate another billing guardian first. |
| 404 | `NOT_LINKED` | Not a guardian of this student. |

## Promotion

### `POST /api/v1/sections/{sectionId}/promote`

**Promote a section**

The riskiest bulk operation in the product. Reassigns roll numbers, and DOES NOT TOUCH DUES — arrears carry forward through finance.

_Permission: `enrolment.promote`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "fromYearId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "toYearId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "targetSectionId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "retainSectionId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "defaultOutcome": {
      "default": "promoted",
      "type": "string",
      "enum": [
        "promoted",
        "retained"
      ]
    },
    "exceptions": {
      "default": {},
      "type": "object",
      "propertyNames": {
        "type": "string",
        "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "additionalProperties": {
        "type": "string",
        "enum": [
          "promoted",
          "retained",
          "transferred",
          "withdrawn"
        ]
      }
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 280
    }
  },
  "required": [
    "fromYearId",
    "toYearId",
    "targetSectionId",
    "reason"
  ]
}
```

**200** — `{ batchId, counts, enrolled }`. Keep `batchId`: it is what undo needs.

**Refusals**

| Status | Code | When |
|---|---|---|
| 409 | `SECTION_EMPTY` | Nobody in that section and year is awaiting an outcome. |
| 400 | `UNKNOWN_EXCEPTION` | An exception names a student who is not in the section — usually the wrong section. |
| 400 | `SAME_YEAR` | Cannot promote into the year being promoted from. |

### `POST /api/v1/promotions/{batchId}/undo`

**Undo a promotion**

Removes exactly the enrolments that batch created, found by batch id — never by (section, year), which would also catch students enrolled by hand afterwards.

_Permission: `enrolment.promote`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 280
    }
  },
  "required": [
    "reason"
  ]
}
```

**200** — Success.

**Refusals**

| Status | Code | When |
|---|---|---|
| 404 | `BATCH_NOT_FOUND` | No such batch at this school. |
| 409 | `BATCH_ALREADY_UNDONE` | Already reversed. |

> A leaver’s status is NOT restored. Reversing a lifecycle event needs its own decision and its own reason.

## People

### `POST /api/v1/persons/{personId}/merge`

**Merge a duplicate person**

The path id SURVIVES; the body names the duplicate. Dangerous — getting it wrong fuses two children’s records.

_Permission: `student.merge`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "loserPersonId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "reason": {
      "type": "string",
      "minLength": 10,
      "maxLength": 280
    }
  },
  "required": [
    "loserPersonId",
    "reason"
  ]
}
```

**200** — `{ mergeId, moved }`. Keep `mergeId` to reverse it.

**Refusals**

| Status | Code | When |
|---|---|---|
| 400 | `SAME_PERSON` | Winner and loser are the same record. |
| 409 | `ALREADY_MERGED` | One of them already lost a merge that is still in force. |
| 403 | `CANNOT_MERGE_SELF` | Neither may be the caller’s own person record. |

> Only DOMAIN references move. `created_by`, `updated_by` and the audit actor stay put — rewriting them would falsify who acted.

### `POST /api/v1/merges/{mergeId}/reverse`

**Reverse a merge**

Puts back exactly the rows that merge moved, by id — never everything currently pointing at the winner, who may have gained rows since.

_Permission: `student.merge`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 280
    }
  },
  "required": [
    "reason"
  ]
}
```

**200** — Success.

**Refusals**

| Status | Code | When |
|---|---|---|
| 404 | `MERGE_NOT_FOUND` | No such merge at this school. |
| 409 | `MERGE_ALREADY_REVERSED` | Already reversed. |

## Staff and roles

### `GET /api/v1/members`

**Who works here**

With their roles, their login identifier, and whether an invite is still outstanding.

_Permission: `staff.read`_

**200** — `isSelf` marks the caller — the one membership they may not edit.

### `GET /api/v1/roles`

**Roles and what each confers**

_Permission: `role.manage`_

**200** — Success.

### `POST /api/v1/staff/invites`

**Invite a member of staff**

No password is ever transmitted. They set their own from the link.

_Permission: `membership.manage`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "personId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "person": {
      "type": "object",
      "properties": {
        "nameBn": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "nameEn": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        }
      },
      "required": [
        "nameBn",
        "nameEn"
      ]
    },
    "identifier": {
      "type": "string",
      "minLength": 3,
      "maxLength": 160
    },
    "roleIds": {
      "default": [],
      "maxItems": 10,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
      }
    }
  },
  "required": [
    "identifier"
  ]
}
```

**201** — `inviteToken` is returned ONCE and never stored in plaintext — put it in the link. It is `null` when the person already had a password: they gained a second school and sign in as they already do.

**Refusals**

| Status | Code | When |
|---|---|---|
| 409 | `ALREADY_A_MEMBER` | That person is already a member here. |
| 400 | `INVALID_IDENTIFIER` | Not a Bangladeshi mobile in E.164, nor an email. |

> Send EXACTLY ONE of `personId` or `person`. **Not expressible in the JSON Schema.**

### `POST /api/v1/staff/invites/{membershipId}/revoke`

**Revoke an outstanding invite**

The link stops working immediately.

_Permission: `membership.manage`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 280
    }
  },
  "required": [
    "reason"
  ]
}
```

**200** — Success.

**Refusals**

| Status | Code | When |
|---|---|---|
| 404 | `INVITE_NOT_FOUND` | No live invite for that membership. |

### `POST /api/v1/memberships/{membershipId}/roles`

**Grant a role**

_Permission: `role.manage`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "roleId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "scope": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
        }
      }
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 280
    }
  },
  "required": [
    "roleId",
    "reason"
  ]
}
```

**201** — Success.

**Refusals**

| Status | Code | When |
|---|---|---|
| 403 | `SELF_GRANT_BLOCKED` | Nobody edits their own membership, however privileged. |
| 403 | `CANNOT_GRANT_BEYOND_OWN` | The role confers a permission the granter does not hold. |
| 409 | `ALREADY_GRANTED` | They already hold it. |
| 404 | `ROLE_NOT_FOUND` | No such role at this school. |
| 404 | `MEMBERSHIP_NOT_FOUND` | No such membership at this school. |

> Both refusals are audited. The attempt is the signal.

### `POST /api/v1/memberships/{membershipId}/roles/revoke`

**Remove a role**

_Permission: `role.manage`_

**Body**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "roleId": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 280
    }
  },
  "required": [
    "roleId",
    "reason"
  ]
}
```

**200** — Success.

**Refusals**

| Status | Code | When |
|---|---|---|
| 403 | `SELF_GRANT_BLOCKED` | Locking yourself out of a one-administrator school is unrecoverable. |
| 404 | `NOT_GRANTED` | They do not hold that role. |

## Operations

### `GET /api/health/live`

**Liveness**

Touches nothing external. A liveness probe that checks the database restarts the app every time the database hiccups.

_No authentication._

**200** — Success.

### `GET /api/health/ready`

**Readiness**

Checks the database as the app role. **503** when not ready, so a deploy cannot shift traffic to a replica that cannot reach it.

_No authentication._

**200** — Success.

### `GET /api/v1/health`

**Tenant surface health**

_No authentication._

**200** — Success.

### `GET /api/platform/v1/health`

**Operator surface health**

_No authentication._

**200** — Success.

### `GET /api/public/v1/health`

**Public surface health**

_No authentication._

**200** — Success.

### `POST /api/hooks/{provider}`

**Provider webhook**

Signature-verified per provider. Not part of the tenant API.

_No authentication._

**200** — Success.

