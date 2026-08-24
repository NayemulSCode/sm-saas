# 20. Frontend architecture and component strategy

Next.js App Router, TypeScript strict, shadcn/ui + Radix + Tailwind v4
([ADR-0008](../adr/0008-ui-library.md)). The binding constraint is the
performance budget in [§4.4](../phase-1a/04-non-functional-requirements.md), not
aesthetics.

## 20.1 Route structure

```
src/app/
  [locale]/
    (tenant)/                      # resolved from the subdomain
      (staff)/                     # principal, office, teacher
        dashboard/
        students/[id]/
        attendance/[sectionId]/
        marks/[examId]/[sectionId]/
        fees/collect/
        reports/
      (guardian)/
        children/[studentId]/
        results/[examId]/
        fees/
      (auth)/  login/  verify/
    (platform)/                    # operator console, separate host
      tenants/[id]/
  api/
    v1/ …  platform/v1/ …  hooks/ …  public/v1/ …
```

Route groups map to audiences, and each group has its **own layout, its own
navigation and its own bundle budget**. A guardian route must never pull in the
admin table stack; separating them at the route-group level is what makes that
enforceable rather than aspirational.

## 20.2 Server versus client components

The default is server. A component becomes a client component only for a stated
reason.

| Rendering | Use for | Examples |
|---|---|---|
| **Server (RSC)** | Anything that reads data and does not need interactivity | Dashboards, lists, detail pages, report views, printable pages |
| **Client** | Local state, keyboard-driven interaction, offline capture | Marks grid, attendance capture, fee collection form, context switcher |
| **Server action** | Mutations from forms | Every write that is not offline-capable |

RSC reads the database **through the use-case layer in-process** — no HTTP hop
([ADR-0004](../adr/0004-application-framework.md)). A student list page is one
round trip from browser to rendered HTML, which is what makes the 3G budget
achievable.

The rule that keeps this honest: a server component may call a use case; it may
**not** import a repository. Same boundary as everywhere else
([§9.2](../phase-1a/09-domain-boundaries.md)).

## 20.3 Data fetching and mutation

| Concern | Approach |
|---|---|
| Reads on server routes | Direct use-case call in the RSC |
| Reads in client components | `fetch` to `/api/v1`, wrapped in a typed client generated from the Zod schemas |
| Mutations | Server actions for ordinary forms; REST for anything needing an `Idempotency-Key` header or offline queueing |
| Revalidation | Tag-based (`revalidateTag('students:sectionId')`) after mutations |
| Optimistic UI | Only where the operation cannot fail domain validation — attendance toggles yes, payment recording **no** |

Payments are never optimistic. Showing a receipt that does not exist yet is
worse than a two-second wait.

## 20.4 The three screens that decide the product

Most of the frontend is ordinary CRUD. Three screens are not, and they deserve
purpose-built components rather than generic forms.

### Attendance capture

- Whole section on one screen, no pagination, no scroll-jumping
- One tap per student to cycle present → absent → late
- **Bulk default**: "mark all present", then correct the exceptions — which is
  how a register is actually used
- Works fully offline; writes to IndexedDB immediately
  ([§27](27-mobile-offline.md))
- Shows the working-day reason when disabled, never a bare "not available"
- Target: usable one-handed on a 5-inch screen

### Marks entry grid

- Virtualised (TanStack Virtual) — 400 rows × 6 columns must not mount 2,400 cells
- Arrow/Tab/Enter navigation; a full section entered without touching the mouse
- Paste a TSV rectangle from Excel; per-cell validation on paste
- `a` / `e` / `i` type the non-scored states directly
  ([§15.6](15-assessment-engine.md))
- Per-cell local autosave, batched remote sync
- Running progress: entered / absent / remaining

### Fee collection

- Search by name, roll or student code, with `pg_trgm` fuzzy matching for Bangla
- Outstanding heads shown with ages; allocation preview updates live as the
  amount is typed
- Receipt number issued by the server, never predicted by the client
- Print immediately on success — the guardian is standing at the counter

## 20.5 Component layers

```
components/
  ui/            shadcn primitives — button, input, dialog, select
  patterns/      composed, domain-agnostic — DataTable, FormField, EmptyState,
                 ConfirmDialog, MoneyInput, DateInput, BanglaNumber
  domain/        module-specific — AttendanceGrid, MarksGrid, FeeAllocator,
                 GuardianPicker, SectionPicker, WorkingDayBadge
  layouts/       shells per route group
```

`patterns/` is where the leverage is. `MoneyInput` accepts and emits **minor
units** and is the only place money is parsed from a string; `DateInput` speaks
`LocalDate` in `Asia/Dhaka` and never a JavaScript `Date`; `BanglaNumber`
formats digits per tenant preference. Each exists so the corresponding mistake
can only be made once.

## 20.6 State management

No global state library. In order of preference:

1. **URL** — filters, pagination cursors, selected section, active tab. Shareable
   and survives reload, which matters when an office worker's browser restarts.
2. **Server** — the source of truth, re-fetched on revalidation.
3. **Local component state** — transient UI.
4. **IndexedDB** — offline queues only ([§27](27-mobile-offline.md)).
5. **React context** — auth context, locale, theme. Read-mostly, rarely changing.

Redux/Zustand/Jotai are not needed: there is no substantial client-side domain
state, because the server holds it. Introducing one would mostly duplicate cache
invalidation that `revalidateTag` already does.

## 20.7 Performance budgets, enforced

| Route group | First-load JS (gzipped) | Enforcement |
|---|---|---|
| `(guardian)` | **≤ 150 KB** | CI bundle check fails the build |
| `(staff)` teacher routes | **≤ 180 KB** | Same |
| `(staff)` admin routes | ≤ 350 KB | Same |
| `(platform)` | ≤ 500 KB | Operator-only, desktop |

Techniques, in order of impact:

- Server components by default — most pages ship almost no JS
- `next/dynamic` for the marks grid, charts and the rich-text editor
- Route-group-scoped dependencies; no chart library in guardian routes
- Subset fonts ([§22](22-i18n-architecture.md)) — Bangla webfonts are large
- No moment/lodash; `date-fns` with per-function imports
- Images through the Next pipeline, AVIF/WebP, explicit dimensions

## 20.8 Loading, error and empty states

Every route defines `loading.tsx` and `error.tsx`. Not optional — on a 3G
connection an undefined loading state is a blank white screen for four seconds,
and users conclude the app is broken.

| State | Requirement |
|---|---|
| Loading | Skeletons matching final layout, so nothing shifts (CLS) |
| Error | Localised message, the `requestId`, and a retry action |
| Empty | Explains *why* it is empty and what to do — "No students in this section yet. Import or add one." |
| Offline | A persistent banner plus a pending-sync count |
| Disabled by domain rule | Always says why: "Marks locked on 12 June by A. Rahman" |

The last row is the difference between a product that feels considered and one
that generates support calls.

## 20.9 Forms

React Hook Form + the shared Zod schema. Conventions:

- Bangla labels are longer than English — layouts are tested in `bn` first, since
  a layout that fits Bangla fits English but not the reverse
  ([§22](22-i18n-architecture.md))
- Errors are inline, adjacent to the field, announced to screen readers
- Destructive actions confirm and require a typed reason where the domain does
- Long forms autosave drafts to local storage; admission forms are long and
  connections drop
- Submit buttons disable on pending and show progress — double-submit is a
  duplicate receipt, and the `Idempotency-Key` is the second line of defence

## 20.10 Print

Report cards, receipts and tabulation sheets are printed constantly, often to a
cheap laser printer.

- Print stylesheets on receipt and report views
- Server-rendered print routes reuse the **same HTML templates** as the PDF
  pipeline ([§24](24-documents-pdf-bangla.md)), so what prints from the browser
  and what downloads as PDF cannot diverge
- Paper defaults to A4; receipts support a narrow roll format
