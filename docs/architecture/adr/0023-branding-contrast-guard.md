# ADR-0023 — Tenant branding with a computed contrast guard

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1B

## Context

Tenants choose their own brand colours (§5.22) and the platform targets WCAG 2.2
AA (§5.28). These requirements conflict: a school picks its flag yellow, and
white text on it is unreadable. Something has to give, and it must be decided
rather than discovered by a user.

Compounding it: theme (light/dark/system, chosen by the **user**) and branding
(chosen by the **tenant**) are independent axes that are routinely conflated.

## Options

### A. Trust the tenant's colours
Honest to their intent. Produces unreadable interfaces and fails the stated
accessibility target.

### B. Restrict tenants to a curated palette
Guaranteed accessible, and schools reject it — the brand colour is the point.

### C. Accept any colour, **clamp at render**, compute the foreground

## Decision

**C.**

```ts
const primary = clampToContrast(branding.primary, {
  against: ['--color-surface'], minRatio: 4.5,
});
return {
  '--brand-primary': primary,
  '--brand-on-primary': pickForeground(primary),   // black or white, computed
  '--brand-primary-subtle': mix(primary, surface, 0.9),
};
```

| Rule | Behaviour |
|---|---|
| Foreground on brand is **computed**, never authored | Black or white, whichever passes |
| Brand colour on large surfaces is contrast-clamped | Lightness adjusted, **hue preserved** — the school still recognises its colour |
| The picker shows a live pass/fail badge | The school sees the problem while choosing |
| The chosen value is stored as chosen, clamped at render | Intent preserved, rendering accessible |
| Brand colour is never used for text on white | Surfaces, borders and accents only |

Supporting decisions:

- Tokens are layered: primitives → semantic → brand → component. Components
  reference **semantic and component tokens only**. A component referencing
  `--blue-500` breaks in dark mode; one referencing `--brand-primary` directly
  breaks when a school picks a bad colour.
- Branding is injected **server-side in the initial HTML**, not applied by client
  JavaScript — otherwise every navigation on 3G flashes the default palette.
- Theme preference is stored on the **account**, not the membership: a teacher
  who is also a parent elsewhere wants one preference.
- **Documents always render light-themed** regardless of who triggered them. A
  dark-mode report card wastes toner and looks broken.

Because the PDF renderer is Chromium, documents consume the same tokens
([§24](../phase-1b/24-documents-pdf-bangla.md)). Email resolves the same tokens
to literal hex and inlines them.

## Consequences

**Makes easy:** accessibility that survives a tenant-controlled feature; one
brand definition applied to app, PDF, email and CMS; a testable property rather
than an intention.

**Makes hard:** a school may see a rendered colour slightly different from the hex
it entered. Mitigated by the live badge and by preserving hue. The clamping
function must be correct and is unit-tested against hostile fixture colours.

**Forecloses:** tenant control over typography, layout, spacing and semantic
colours. Deliberate — a configurable application UI makes every support
conversation start with "what does your screen look like?".

## Revisit when

- A tenant requires an exact brand colour for a compliance or trademark reason —
  the answer is a restricted surface where it renders unclamped and no text is
  placed on it, not disabling the guard.
- WCAG 3 / APCA contrast becomes the target, which changes the maths but not the
  architecture.
