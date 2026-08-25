# 12. Component inventory — the three critical screens

§46.7 item 5. Most of this product is ordinary CRUD that the shared pattern
library covers. Three screens are not, and they are the ones users judge the
product by ([§20.4](../../architecture/phase-1b/20-frontend-architecture.md)).

These specs are **interaction contracts**, not visual design. They are stable
even though the modules behind them ship in 3b–3d, because the interaction model
is driven by how the work is actually done in a school office, not by the schema.

## 12.1 Shared pattern library

Built once, in `components/patterns/`. Each exists so a specific mistake can only
be made in one place.

| Component | Contract | Why it exists |
|---|---|---|
| `MoneyInput` | Accepts/emits **minor units**; parses Bangla or Latin digits; rejects >2 decimals | The only place a money string is parsed. Invariant 2 |
| `MoneyText` | `Money` + locale + numerals → display | The only place `/100` happens |
| `DateInput` | `LocalDate` in `Asia/Dhaka`; never a JS `Date` | Kills the midnight-UTC off-by-one |
| `BanglaNumber` | Digit rendering per tenant preference; **Indic 2,2,3 grouping** | ১,২৩,৪৫৬ — not ১২৩,৪৫৬ |
| `DataTable` | TanStack Table + Virtual; keyset cursor; `aria-rowcount` over the **full** set | Virtualisation that stays accessible ([§28.2](../../architecture/phase-1b/28-accessibility.md)) |
| `PersonSearch` | Debounced `pg_trgm` search over `name_bn`/`name_en` + code | Bangla fuzzy match, one implementation |
| `SectionPicker` | Scope-aware — shows only sections in `ctx.scope` | Prevents a teacher being offered a section they cannot use |
| `WorkingDayBadge` | Renders `DayResolution` with its localised **reason** | "Friday — weekly off", never "unavailable" |
| `ConfirmDialog` | Optional typed reason; returns it to the caller | Dangerous actions always capture a reason |
| `OfflineBanner` | Pending count + last sync + retry | The only offline indicator |
| `SegmentCounter` | Live SMS segment + recipient + cost estimate | Bangla SMS cost visible *while typing* |
| `EmptyState` | Explains why it is empty and the next action | "No students yet. Import or add one." |

`MoneyInput` and `BanglaNumber` are the two worth writing first: they are used by
every finance screen, and both encode a rule that is otherwise re-derived wrongly.

---

## 12.2 Attendance capture

The screen that decides whether the product works at all. If it fails at 08:30 on
a teacher's phone, nothing else matters.

| | |
|---|---|
| **User** | Class teacher |
| **Device** | Low-end Android, 5", patchy or no data |
| **Frequency** | Once per section per working day, ~08:20–08:40 |
| **Budget** | ≤ 180 KB JS; LCP ≤ 3.5 s cold, ≤ 1 s warm; **usable fully offline** |
| **Target** | 40 students marked in ≤ 60 s |
| **Ships** | Phase 3c |

### Data contract

```ts
interface AttendanceScreenData {
  section: { id; nameBn; nameEn; className };
  date: LocalDate;
  day: DayResolution;                    // status + localised reason (§16.1)
  statuses: AttendanceStatus[];          // tenant-defined, ordered
  roster: Array<{
    studentId; rollNo; nameBn; nameEn; photoKey?;
    current?: { statusId; source; supersededBy?: string };
  }>;
  lock: { isLocked: boolean; reason?: string };
}
```

Precached on login and refreshed daily, so the roster is present with no network
([§27.6](../../architecture/phase-1b/27-mobile-offline.md)).

### Interaction model

**Mark-all-present first, then correct the exceptions** — this is how a paper
register is actually used, and it turns 40 interactions into 3.

| Action | Behaviour |
|---|---|
| Open | Defaults every student to Present, **unsaved**, with a visible "40 present — review and submit" |
| Tap a row | Cycles Present → Absent → Late → (tenant statuses) → Present |
| Long-press | Opens the full status list plus a remark field |
| Swipe | **None.** Drag-only interaction fails WCAG 2.5.7 |
| Submit | Writes the whole section as one batch to IndexedDB, returns instantly |
| Non-working day | Grid disabled; `WorkingDayBadge` shows the reason; an override needs `attendance.amend` |
| Already submitted | Shows existing marks; edits become **amendments** with a reason |

### Keyboard (desktop fallback)

`↑`/`↓` move · `Space` cycles · `P`/`A`/`L` set directly · `Enter` submits ·
`Ctrl+A` mark all present.

### Offline

Local write first, always. The network is never on the interaction path.

```
tap → IndexedDB (clientRef = ULID) → UI updates instantly
                                   → outbox → sync when online
```

The **business date comes from the server** on sync, never the device clock
([ADR-0018](../../architecture/adr/0018-offline-sync-model.md)). The header shows
the date being captured for, prominently, so a wrong device clock is caught by
the teacher before submit.

### States

| State | Requirement |
|---|---|
| Offline | Banner + pending count. Everything still works |
| Syncing | Per-row subtle indicator; no blocking spinner |
| Rejected (locked/left section) | Row flagged with reason and an action. **Never silently dropped** |
| Conflict | Both values shown with who and when; teacher chooses |
| Holiday | Disabled + reason + amend path |

### Acceptance

1. Aeroplane mode: mark 40 students, close the browser, reopen → data intact.
2. Reconnect → syncs within 60 s, badge clears.
3. Submit twice → one record (idempotent on `clientRef`).
4. Session expired offline → queue survives re-login for the same account.
5. Whole flow one-handed on a 5" screen; targets ≥ 44 px.

---

## 12.3 Marks entry grid

The most complex component in the product.

| | |
|---|---|
| **User** | Subject teacher |
| **Device** | Phone or shared desktop |
| **Frequency** | Bursts after each exam; sessions of 30–60 min |
| **Budget** | Lazy-loaded (`next/dynamic`), outside the teacher route's base bundle |
| **Ships** | Phase 3d |

### Data contract

```ts
interface MarksGridData {
  exam: { id; nameBn; nameEn; status };          // marks_open | marks_locked …
  subject: { id; nameBn; nameEn };
  components: Array<{ id; code; nameBn; fullMarksMinor; passMarkMinor? }>;
  students: Array<{ studentId; rollNo; nameBn; nameEn }>;
  marks: Record<StudentId, Record<ComponentId, MarkValue>>;  // discriminated union
  lock: { isLocked; lockedAt?; lockedBy? };
}
```

`MarkValue` is the discriminated union from
[§1.3](../phase-2a/01-conventions.md) — `score` is unreachable unless the state is
`entered`. The absent state travels from the database, through the grid, into the
PDF context, and prints as **AB**. It is never a zero at any layer.

### Interaction model

| Requirement | Behaviour |
|---|---|
| Virtualised | 400 rows × 6 components must not mount 2,400 cells |
| Keyboard-first | A full section entered without touching the mouse |
| Navigation | `↑↓←→` move · `Tab`/`Enter` advance · `Esc` reverts the cell |
| Non-scored states | Type `a` absent · `e` exempt · `i` incomplete — faster than a menu |
| Validation | Per cell, immediate, against `fullMarksMinor`. Out-of-range blocks and explains |
| Paste | TSV rectangle from Excel maps to the focused cell; **per-cell validation on paste**; a preview shows accepted/rejected before applying |
| Autosave | **Per cell to IndexedDB; batched to the server** |
| Progress | "38 entered · 2 absent · 2 remaining" always visible |
| Locked | Read-only with the lock reason; unlock needs `mark.lock` and a reason |
| Concurrency | Optimistic `version`; conflict shows both values |

The autosave granularity is the key decision: saving each keystroke to the server
on 3G makes the grid unusable; saving only on submit loses an hour of work when
the browser is killed.

### Accessibility — the hard part

A virtualiser that unmounts off-screen rows breaks tab order and screen-reader
row counts. This is the most likely accessibility defect in the product
([§28.2](../../architecture/phase-1b/28-accessibility.md)), so it is designed
rather than discovered:

- `role="grid"` with `aria-rowcount` / `aria-rowindex` reflecting the **full**
  dataset, not the rendered window
- Keyboard navigation scrolls unrendered rows into view **before** focusing them
- Each cell has an accessible name: "Rahim, CQ, 56 of 70"
- `AB` carries the label "Absent", not the letters

### Acceptance

1. 400 × 6 grid scrolls at 60 fps on the target device.
2. A section entered entirely by keyboard.
3. Paste 40 rows from Excel; invalid cells reported per cell, valid ones applied.
4. Kill the browser mid-entry → reopen → nothing lost.
5. An absent mark renders `AB` and **never** 0, end to end into the PDF.
6. Screen reader announces correct row numbers while virtualised.

---

## 12.4 Fee collection

Where the school's trust is won or lost, at a counter with a guardian waiting.

| | |
|---|---|
| **User** | Office assistant / accountant |
| **Device** | Shared office desktop, keyboard-heavy |
| **Frequency** | 40–100 receipts/day, higher at term start |
| **Budget** | Admin route, ≤ 350 KB |
| **Ships** | Phase 3b |

### Flow

```
search student → outstanding heads (aged) → enter amount
  → live allocation preview → confirm → receipt issued → PRINT
```

### Data contract

```ts
interface FeeCollectionData {
  student: { id; code; nameBn; nameEn; className; sectionName; photoKey? };
  outstanding: Array<{
    invoiceLineId; feeHeadName; periodLabel;
    amountMinor; paidMinor; dueMinor; dueDate; ageDays;
    isCarriedForward: boolean;                 // from a previous academic year
  }>;
  totalDueMinor: string;                       // minor units, as a STRING
  allocationPolicy: AllocationOrder;
  channels: PaymentChannel[];
}
```

### Interaction model

| Requirement | Behaviour |
|---|---|
| Search | By name (Bangla or English, fuzzy), roll, or student code. `/` focuses it |
| Aged display | Oldest first, carried-forward lines flagged — the number the principal asks about |
| Amount | `MoneyInput`; Bangla or Latin digits |
| **Live allocation preview** | Updates as the amount is typed, showing exactly which heads clear and what remains |
| Manual override | Per-line, when policy is `manual` |
| Channel | Cash default; bank/cheque/MFS reveal a reference field |
| Backdating | `collected_at` editable with `fee.backdate`; **`recorded_at` is never editable** |
| Confirm | Receipt number issued **by the server**, never predicted by the client |
| Print | Fires immediately on success — the guardian is standing there |
| Idempotency | `Idempotency-Key` per attempt; submit disabled on pending |

### Never optimistic

Payment recording shows a real pending state and waits. Showing a receipt number
that does not exist yet is worse than a two-second wait — the number is the
school's audit trail, and it must be gapless
([§17.4](../../architecture/phase-1b/17-finance-architecture.md)).

### Keyboard

`/` search · `Tab` through heads · `Alt+A` amount · `Alt+C` channel ·
`Ctrl+Enter` confirm · `Ctrl+P` reprint last.

### Acceptance

1. A receipt recorded end to end without the mouse.
2. Double-submit on a slow connection → **one** receipt.
3. Allocation preview matches the server's actual allocation exactly.
4. Receipt prints with correct Bangla shaping and amount-in-words.
5. Partial payment across four heads and three months allocates per policy.
6. Backdating requires the permission and writes an audit row.

---

## 12.5 What these three share

| Property | Why |
|---|---|
| Keyboard-first | All three are used dozens of times a day |
| Purpose-built, not a generic grid | Paste, per-cell states and allocation preview exist in no off-the-shelf component ([ADR-0008](../../architecture/adr/0008-ui-library.md)) |
| Explicit disabled reasons | "Marks locked on 12 June by A. Rahman", never a bare disabled control |
| Server owns identity | Receipt numbers and business dates come from the server, never the client |
| Deterministic under retry | Idempotency keys on every write path |

## 12.6 Build order

Follows the roadmap, not this document's order: **fee collection** (3b) →
**attendance** (3c) → **marks grid** (3d).

The shared pattern library is built alongside fee collection, because that screen
needs `MoneyInput`, `MoneyText`, `BanglaNumber`, `PersonSearch` and `DataTable` —
five of the twelve — and building them properly there makes the other two screens
substantially cheaper.
