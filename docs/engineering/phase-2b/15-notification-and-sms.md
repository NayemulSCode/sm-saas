# 15. Notification and the SMS provider interface (Phase 3b)

SMS is the primary interface for the largest user group. Two facts make this
harder than it looks: **Bangla SMS costs three times what authors expect**, and
**siblings share a phone**.

## 15.1 Schema

```sql
CREATE TABLE notification_template (
  -- + std   (tenant_id NULL is NOT permitted — platform defaults live in
  --          notification_template_default, copied at provisioning, same
  --          reasoning as role_template in §3.3)
  code       text NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('sms','email','push','in_app')),
  locale     text NOT NULL CHECK (locale IN ('bn','en')),
  subject    text,                              -- email only
  body       text NOT NULL,
  variables  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- declared and validated
  version    integer NOT NULL DEFAULT 1,
  is_active  boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code, channel, locale, version)
);

CREATE TABLE notification_campaign (
  -- + std
  template_id    uuid NOT NULL REFERENCES notification_template(id),
  audience       jsonb NOT NULL,                -- the Audience union (§15.5)
  audience_snapshot jsonb,                      -- resolved recipients, for audit
  scheduled_for  timestamptz,
  status         text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','scheduled','dispatching','sent',
                                     'cancelled','failed')),
  -- Computed BEFORE send and shown to the author (§15.2).
  estimated_recipients integer,
  estimated_segments   integer,
  estimated_cost_minor bigint,
  actual_cost_minor    bigint,
  created_by     uuid REFERENCES person(id)
);

CREATE TABLE notification_message (
  -- + std
  campaign_id    uuid REFERENCES notification_campaign(id),
  channel        text NOT NULL,
  to_value       text NOT NULL,                 -- E.164 or email
  person_id      uuid REFERENCES person(id),
  student_id     uuid REFERENCES student(id),
  body_rendered  text NOT NULL,
  template_version integer NOT NULL,            -- so a message can be explained
  segments       smallint NOT NULL,
  encoding       text NOT NULL CHECK (encoding IN ('gsm7','ucs2')),
  cost_minor     bigint NOT NULL DEFAULT 0,
  priority       text NOT NULL DEFAULT 'bulk'
                   CHECK (priority IN ('transactional','bulk')),
  status         text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','sent','delivered','failed',
                                     'suppressed')),
  provider       text,
  provider_ref   text,
  sent_at        timestamptz,
  delivered_at   timestamptz,
  failure_reason text,
  -- Two absent siblings on one phone must produce ONE message.
  dedup_key      text
);
CREATE UNIQUE INDEX ON notification_message (tenant_id, dedup_key)
  WHERE dedup_key IS NOT NULL AND status IN ('queued','sent','delivered');
CREATE INDEX ON notification_message (tenant_id, campaign_id);
CREATE INDEX ON notification_message (tenant_id, person_id, created_at DESC);
CREATE INDEX ON notification_message (provider, provider_ref);   -- DLR ingest
CREATE INDEX ON notification_message (tenant_id, status) WHERE status = 'queued';

CREATE TABLE notification_suppression (
  -- + std
  channel    text NOT NULL,
  value      text NOT NULL,
  reason     text NOT NULL
               CHECK (reason IN ('opt_out','invalid','bounced','complaint')),
  UNIQUE (tenant_id, channel, value)
);

CREATE TABLE sms_credit_ledger (
  -- + std
  delta_minor   bigint NOT NULL,                -- + top-up, − dispatch
  balance_minor bigint NOT NULL,                -- running balance after this row
  reason        text NOT NULL,
  campaign_id   uuid REFERENCES notification_campaign(id),
  CHECK (delta_minor <> 0)
);
CREATE INDEX ON sms_credit_ledger (tenant_id, created_at DESC);
```

## 15.2 Segment counting — the cost control

```ts
export function countSegments(body: string): { encoding: 'gsm7'|'ucs2'; segments: number } {
  const isGsm7 = /^[\x20-\x7E\n\r£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤§¿äöñüà]*$/.test(body);
  if (isGsm7) {
    const n = body.length;
    return { encoding: 'gsm7', segments: n <= 160 ? 1 : Math.ceil(n / 153) };
  }
  // UCS-2: any Bangla character forces the WHOLE message to 70/67.
  const n = [...body].length;                   // code points, not UTF-16 units
  return { encoding: 'ucs2', segments: n <= 70 ? 1 : Math.ceil(n / 67) };
}
```

A 200-character Bangla notice is **3 segments**. Sent to 400 guardians that is
1,200 billed messages, not 400.

| Control | Where |
|---|---|
| Live segment + recipient + cost, **while typing** | `SegmentCounter` ([§12.1](12-component-inventory.md)) |
| Estimate stored on the campaign before dispatch | `estimated_*` columns |
| Actual summed after dispatch, compared in the spend report | `actual_cost_minor` |
| Template lint: a Bangla character in an `en` template | CI, **fails the build** — it triples the cost |
| Template lint: rendered length crosses a segment boundary for typical values | Warning at save time |

`[...body].length` rather than `body.length` is deliberate: JavaScript string
length counts UTF-16 code units, so characters outside the BMP would be
double-counted and the estimate would be wrong.

## 15.3 Deduplication

```
dedup_key = sha256(tenant_id | event_type | business_date | resolved_phone)
```

Enforced by the partial unique index above: the second insert conflicts and is
dropped. The surviving message uses a **template variant naming both children** —
selected after audience resolution, not concatenated at send time, because Bangla
pluralisation is not English pluralisation.

Dedup applies to absence alerts, result notifications and fee reminders. It
deliberately does **not** apply to per-student artefacts such as an admit card
link, where two children need two distinct links.

## 15.4 Budget and dispatch

```ts
interface DispatchPolicy {
  messagesPerSecond: number;
  spreadOverMinutes?: number;                   // results: 30–90
  priority: 'transactional' | 'bulk';
  quietHours?: { fromHour: 21; toHour: 8 };     // Asia/Dhaka
}
```

| Class | Policy |
|---|---|
| OTP | `transactional`, immediate, **never queued behind bulk** |
| Payment receipt | `transactional`, immediate |
| Absence alert | `bulk`, batched after the attendance window closes |
| **Result publication** | `bulk`, **spread over 30–90 minutes** |
| Fee reminder | `bulk`, respects quiet hours |

Transactional and bulk use **separate pg-boss queues with separate worker
concurrency**, so a 20,000-message result fan-out cannot delay a login OTP. That
is the difference between a slow evening and users unable to sign in.

Rate shaping is also the platform's main load-shaping lever: the platform sends
the SMS, so it controls when guardians arrive
([§4.3](../../architecture/phase-1a/04-non-functional-requirements.md)).

**Budget refuses rather than overdrafts.** Past the plan's monthly cap, dispatch
stops and alerts. A school that discovers a ৳40,000 SMS bill it did not authorise
will not renew, and recovering the money is worse than not sending.

## 15.5 Audience

```ts
export type Audience =
  | { kind: 'section';     sectionIds: SectionId[] }
  | { kind: 'class';       classLevelIds: ClassLevelId[] }
  | { kind: 'shift';       shiftId: ShiftId }
  | { kind: 'status';      studentStatus: StudentStatus }
  | { kind: 'defaulters';  minOutstandingMinor: string; asOf: LocalDate }
  | { kind: 'individual';  studentIds: StudentId[] }
  | { kind: 'staff';       roleIds: RoleId[] };
```

Resolved at **dispatch time**, not authoring time, so a campaign scheduled for
Thursday reaches Thursday's actual defaulter list. The resolved set is
snapshotted onto the campaign for auditability.

Resolution respects `guardian_link.is_primary_contact` and `can_receive_results`
— a guardian flagged not to receive results does not, regardless of audience
([§4.2](../phase-2a/04-schema-structure-directory.md)).

## 15.6 Provider interface

```ts
export interface SmsProvider {
  readonly code: string;
  send(msg: OutboundSms): Promise<{ providerRef: string; segments: number }>;
  sendBatch(msgs: OutboundSms[]): Promise<BatchResult>;
  parseDeliveryReport(raw: unknown): DeliveryReport[];
  balance?(): Promise<Money>;
}
```

**Two Bangladeshi providers implemented**, selectable per tenant with failover.
The reason is regulatory, not technical: masked-sender approval is a per-provider
process with an unpredictable lead time, and a tenant blocked on one provider's
approval can ship on another
([§18.6](../../architecture/phase-1b/18-notification-architecture.md)).

Provider concerns kept out of the domain: sender id, template pre-registration
where required, segment accounting differences, delivery-report formats. A `mock`
provider is the default in development and CI — no test ever sends a real SMS.

## 15.7 Delivery reports

Ingested at `/api/hooks/sms/:provider`, keyed on `provider_ref`, signature
verified, idempotent.

Persistent failures for a number (invalid, off for weeks) increment a counter and
eventually add it to `notification_suppression` — **with the school notified**,
because a wrong phone number in the student file is a data problem the school can
fix, not a messaging problem the platform should hide.

## 15.8 Opt-out

Guardians may opt out of `bulk` categories. They may **not** opt out of
transactional messages about their own child — payment receipts, OTPs, result
availability — because those are the school discharging an obligation, not
marketing.

Opt-out is per `(tenant, channel, value)`, so a guardian with children at two
schools can silence one without the other.

## 15.9 API contracts

| Method | Path | Permission |
|---|---|---|
| `GET`/`POST` | `/api/v1/notification-templates` | `notice.publish` |
| `POST` | `/api/v1/campaigns:estimate` | `sms.send` |
| `POST` | `/api/v1/campaigns` | `sms.send` |
| `POST` | `/api/v1/campaigns/:id:dispatch` | `sms.send` · **Idempotency-Key** |
| `POST` | `/api/v1/campaigns/:id:cancel` | `sms.send` |
| `GET` | `/api/v1/messages?personId=&from=&to=` | `sms.send` |
| `GET` | `/api/v1/sms-credits` | `sms.budget.manage` |
| `POST` | `/api/v1/sms-credits:topup` | `sms.budget.manage` |
| `POST` | `/api/hooks/sms/:provider` | — signature verified |

```ts
export const EstimateCampaignSchema = z.object({
  templateId: zUlid<'notificationTemplate'>(),
  audience: AudienceSchema,
  variables: z.record(z.string()).default({}),
});

export const EstimateResult = z.object({
  recipients: z.number().int(),
  segmentsPerMessage: z.number().int(),
  encoding: z.enum(['gsm7','ucs2']),
  totalSegments: z.number().int(),
  estimatedCostMinor: z.string(),
  balanceAfterMinor: z.string(),
  wouldExceedCap: z.boolean(),
  sampleRendered: z.string(),                   // what a guardian actually receives
});
```

`sampleRendered` exists because the author should see the real message, in
Bangla, before spending the school's money on 400 copies of it.

## 15.10 Acceptance for Phase 3b

1. A 200-character Bangla template reports **3 segments** and the cost is shown
   before send.
2. Two absent siblings on one phone produce **one** SMS naming both.
3. A campaign that would exceed the monthly cap is refused, not overdrafted.
4. An OTP dispatches immediately while a 5,000-message bulk campaign is running.
5. Delivery reports update status; a permanently failing number is suppressed and
   the school is notified.
6. Switching a tenant's provider requires no domain code change.
7. No test or CI run sends a real SMS.
