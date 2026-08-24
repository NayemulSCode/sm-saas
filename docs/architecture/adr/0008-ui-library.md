# ADR-0008 — shadcn/ui + Radix + Tailwind, with headless tables

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1A

## Context

Two hard requirements decide this, and they pull in different directions:

- **Bundle size.** Guardians and teachers use low-end Android over 3G. The
  budget is ≤ 180 KB gzipped of first-load JS on those routes
  ([§4.4](../phase-1a/04-non-functional-requirements.md)).
- **Table and form density.** Office staff enter dozens of receipts and hundreds
  of marks a day. This is a data-grid-heavy admin product.

Plus: per-tenant branding, WCAG 2.2 AA, and Bangla typography.

## Options

### A. MUI
Comprehensive, excellent DataGrid. Emotion runtime plus component weight blows
the mobile budget. Theming per tenant means a theme provider and runtime style
generation on every render.

### B. Ant Design
The best dense tables and forms of the candidates, and genuinely well suited to
a school admin panel. Rejected on bundle size and on a strong visual identity
that resists per-tenant re-branding.

### C. Chakra UI
Pleasant DX, runtime-CSS cost, no advantage over Radix on accessibility.

### D. shadcn/ui + Radix primitives + Tailwind v4, plus TanStack Table/Virtual
Components are copied into the repository as source. Radix supplies the
accessibility behaviour — focus management, dialogs, menus, combobox — which is
where WCAG 2.2 AA is actually won or lost. Tailwind emits only used classes.
Tenant theming is CSS custom properties. Tables are headless and virtualised.

## Decision

**D.**

The deciding reason: the mobile budget is a *functional* requirement — if
attendance does not load on the teacher's phone, the product does not work — and
only D meets it while still supporting dense admin screens through TanStack
Table.

The secondary reason is theming. With CSS variables, a tenant's colours apply to
the app, PDFs and emails from one source. With a runtime theme provider, PDFs and
emails need a parallel implementation.

## Consequences

**Makes easy:** hitting the bundle budget; per-tenant theming including dark
mode; accessibility via Radix; owning and patching component source when a
Bangla-specific layout issue appears — and it will.

**Makes hard:** no ready-made DataGrid. The marks-entry grid and the fee ledger
table are purpose-built components — roughly two weeks of work, and arguably
necessary anyway, since FR-7.8 requires paste-from-spreadsheet and resumable
entry that no off-the-shelf grid provides. Component source lives in the repo,
so upstream fixes are pulled deliberately rather than by version bump.

**Forecloses:** nothing structurally.

## Revisit when

- The measured first-load bundle exceeds budget despite the headless approach —
  the problem is then elsewhere and the library is not the fix.
- Building and maintaining the data grid exceeds ~3 weeks cumulative, at which
  point buying a commercial headless grid becomes cheaper than the team's time.
