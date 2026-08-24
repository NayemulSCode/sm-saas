# 23. Theme and branding architecture

Two independent axes that are often conflated:

- **Theme** — light / dark / system. Chosen by the *user*.
- **Branding** — logo, colours, school name. Set by the *tenant*.

A tenant's brand colour must work in both themes, and a user's dark-mode choice
must not be overridden by a school's branding. Treating them as one dimension
produces unreadable text on someone's phone.

## 23.1 Token layers

```
Layer 1  primitives     --blue-500, --gray-100, --red-600      fixed palette
Layer 2  semantic       --color-surface, --color-text,          theme-dependent
                        --color-border, --color-danger
Layer 3  brand          --brand-primary, --brand-accent         tenant-dependent
Layer 4  component      --button-bg, --table-header-bg          derived
```

Components reference **layer 2 and 4 only**. A component that hardcodes
`--blue-500` breaks in dark mode; one that references `--brand-primary` directly
breaks when a school picks a colour with insufficient contrast.

```css
:root {
  --color-surface: var(--gray-50);
  --color-text: var(--gray-900);
  --color-border: var(--gray-200);
  --brand-primary: #1e40af;          /* overridden per tenant at runtime */
  --brand-on-primary: #ffffff;       /* COMPUTED, never authored — see §23.4 */
}

:root[data-theme="dark"],
:root:not([data-theme="light"]) {
  /* only the tokens that change are redefined */
}
```

Following the same three-state discipline used for published pages: an explicit
choice sets `data-theme`, the default "system" setting sets nothing and relies on
`prefers-color-scheme`. Every token has a definition on bare `:root`, so no colour
exists only inside a media query.

## 23.2 Applying tenant branding

Branding lives in `tenant.branding jsonb` and is injected as CSS custom
properties in the tenant layout — **server-side, in the initial HTML**:

```tsx
<html data-theme={userTheme} style={brandVars(tenant.branding)}>
```

Server-side injection matters: applying brand colours from client JavaScript
produces a visible flash of the default palette on a slow connection, which on
3G is a second of the wrong colours on every navigation.

| Asset | Where it appears |
|---|---|
| Logo | App header, login page, PDF headers, email headers, CMS site |
| Favicon | Browser tab, PWA icon |
| Primary / accent colour | App chrome, buttons, PDF accents, email buttons |
| School name (`bn` and `en`) | Everywhere a document or message identifies the school |
| Address, phone, EIIN | Document headers and footers |

## 23.3 One brand, four render targets

The same branding must apply to surfaces with very different capabilities.

| Target | Mechanism | Constraint |
|---|---|---|
| App | CSS custom properties | Full support |
| **PDF** | Same CSS variables — the renderer is Chromium ([ADR-0009](../adr/0009-pdf-rendering.md)) | Print colour space; always light theme |
| **Email** | Inlined styles, computed from the same tokens at render time | No custom properties in most clients; no dark-mode control |
| CMS site | CSS custom properties | Full support |

Because the PDF renderer *is* a browser, PDFs and the app share stylesheets and
tokens rather than maintaining a parallel design system. This is one of the
strongest practical arguments for the Chromium choice, and it only holds if
components stay on layer-2 tokens.

Emails are the awkward target: tokens are resolved to literal hex values during
render and inlined. The resolution function is shared, so a brand change
propagates without a second colour table.

**Documents are always light-themed.** A dark-mode report card wastes toner and
looks broken. The document renderer forces `data-theme="light"` regardless of who
triggered the render.

## 23.4 The contrast guard

Tenant-chosen colours will fail WCAG contrast. A school picks its flag yellow;
white text on it is unreadable.

The platform does not permit that outcome:

```ts
function brandVars(branding: Branding): CSSProperties {
  const primary = clampToContrast(branding.primary, {
    against: ['--color-surface'],
    minRatio: 4.5,                     // WCAG 2.2 AA, normal text
  });
  return {
    '--brand-primary': primary,
    '--brand-on-primary': pickForeground(primary),   // black or white, computed
    '--brand-primary-subtle': mix(primary, surface, 0.9),
  };
}
```

| Rule | Behaviour |
|---|---|
| Foreground on brand is **computed**, never authored | Black or white, whichever passes |
| Brand colour used for large surfaces is contrast-clamped | Lightness adjusted, hue preserved — the school still recognises its colour |
| The brand picker shows a live **pass/fail badge** | The school sees the problem while choosing, not after |
| A failing colour is stored as chosen, clamped at render | The school's intent is preserved; the rendering is accessible |
| Brand colour is never used for text on white | Only for surfaces, borders and accents |

This is the mechanism behind FR-X.4 — "WCAG 2.2 AA including under tenant custom
branding" — and it is the reason accessibility survives a feature the tenant
controls ([§28](28-accessibility.md)).

## 23.5 Theme selection

| Setting | Behaviour |
|---|---|
| System (default) | Follows `prefers-color-scheme`; no attribute set |
| Light / Dark | Explicit, stored per account, applied server-side from the session |
| Per tenant default | A tenant may set the default for new users; users may override |

Stored on the **account**, not the membership — a teacher who is also a parent at
another school wants one theme preference, not two.

The initial paint uses the value from the session cookie, so there is no
flash of the wrong theme.

## 23.6 What tenants cannot change

Deliberately constrained. A page builder for the *application* would make every
support conversation start with "what does your screen look like?".

| Configurable | Fixed |
|---|---|
| Logo, favicon | Layout, navigation structure |
| Primary and accent colour | Typography (Bangla coverage is a correctness constraint) |
| School name, address, contact | Component behaviour, spacing scale |
| Document header/footer content | Semantic colours — danger stays red |
| Document layout, per template | Focus indicators, contrast floors |
| Default theme, numeral preference | Dark-mode palette |

Document templates are the deliberate exception: report card layout genuinely
varies per school and is authored as HTML ([§24](24-documents-pdf-bangla.md)).
That is bounded — it affects a printed artefact, not the operational UI.
