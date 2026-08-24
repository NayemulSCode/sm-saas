# 28. Accessibility strategy

Target: **WCAG 2.2 AA**. Two features of this product make accessibility harder
than a typical admin panel, and both are addressed structurally rather than by
audit-and-patch.

1. **Tenant-controlled colours** can break contrast at any time.
2. **Two languages with different scripts** must both work with a screen reader.

## 28.1 Where accessibility is won

Most of it comes from choices already made, which is the cheapest way to get it
at this team size:

| Choice | What it buys |
|---|---|
| **Radix primitives** ([ADR-0008](../adr/0008-ui-library.md)) | Focus trapping, roving tabindex, `aria-*` wiring, escape handling, correct roles on dialogs, menus, comboboxes and tabs — the parts hand-rolled components get wrong |
| **Server-rendered HTML** | Content exists without JavaScript; headings and landmarks are real |
| **Contrast guard** ([§23.4](23-theme-branding.md)) | Tenant branding cannot produce failing contrast |
| **Keyboard-first data entry** ([§20.4](20-frontend-architecture.md)) | Built for office speed; the accessibility benefit is a by-product |
| **Semantic tokens** | Never colour alone as a signal — status carries an icon and text |

## 28.2 Keyboard navigation on data-entry screens

The screens that matter most are the ones staff use hundreds of times a day, and
they are also the hardest to make accessible: large grids.

| Screen | Requirement |
|---|---|
| **Marks grid** | Arrow keys move cells; Tab moves between fields; Enter commits and descends; Escape reverts the cell. A full section entered without a mouse |
| **Attendance** | Space toggles; arrows move; a documented shortcut marks all present |
| Fee collection | Tab order follows visual order; Enter submits; allocation preview announced on change |
| All tables | Sortable headers are buttons, operable by keyboard, with `aria-sort` |
| All modals | Focus moves in on open, is trapped, and returns to the trigger on close |
| Skip link | To main content, first in tab order |

**Virtualised grids need care.** A virtualiser that unmounts off-screen rows
breaks both tab order and screen-reader row counts. The mitigation: the grid uses
`role="grid"` with `aria-rowcount` / `aria-rowindex` reflecting the **full**
dataset rather than the rendered window, and keyboard navigation scrolls
unrendered rows into view before focusing them. This is the single most likely
accessibility defect in the product and is called out here so it is designed for
rather than discovered.

## 28.3 Screen readers in two scripts

| Concern | Approach |
|---|---|
| `lang` attribute | Set on `<html>` per locale, **and on individual elements** where the script differs from the page language |
| Mixed-script content | A Bangla name inside an English page is wrapped with `lang="bn"`, so the reader switches voice instead of spelling it out phonetically in English |
| Names in both scripts | Where both are shown, only the locale-appropriate one is exposed; the other is `aria-hidden` to avoid reading every name twice |
| Bangla digits | When numerals render as Bangla ([§22.3](22-i18n-architecture.md)), the accessible name carries the numeric value |
| Money | Announced as a formatted amount with currency, not as raw digits |
| Abbreviations | "AB" on a report card carries an accessible label — "Absent", not the letters |
| Icon-only buttons | Always have an accessible name in the current locale |

The mixed-script rule is the one most often missed and the most disruptive when
wrong: an English-locale screen reader attempting Bangla glyphs produces
unusable output.

Screen-reader support in Bangla is genuinely uneven across platforms. The
platform's obligation is to emit correct, well-marked-up content; it cannot fix
a reader with poor Bangla voice support. Where a critical flow depends on it, the
fallback is that the same information is available via SMS.

## 28.4 Contrast and visual design

| Rule | Value |
|---|---|
| Body text | ≥ 4.5:1 |
| Large text (≥ 18.66px bold / 24px) | ≥ 3:1 |
| UI components and focus indicators | ≥ 3:1 against adjacent colours |
| Focus indicator | Always visible, never removed. 2px minimum, offset for clarity |
| Colour never the sole signal | Paid/unpaid, present/absent, pass/fail all carry text or an icon |
| Target size | ≥ 24×24 CSS px (WCAG 2.2 §2.5.8); ≥ 44px on touch-primary screens |
| Zoom | Usable at 200% without horizontal scrolling |
| Motion | Respect `prefers-reduced-motion` |

The target-size rule interacts with the attendance screen: 50 students on a
5-inch display is a dense grid, and shrinking rows to fit is the obvious wrong
answer. The screen scrolls instead.

## 28.5 WCAG 2.2 additions specifically covered

The 2.2 criteria most likely to be missed:

| Criterion | How it is met |
|---|---|
| 2.4.11 Focus Not Obscured | Sticky table headers and the offline banner do not overlap the focused element; scroll padding accounts for them |
| 2.5.7 Dragging Movements | No drag-only interaction. Anything draggable has a keyboard/button alternative |
| 2.5.8 Target Size | ≥ 24px minimum, enforced in the component library |
| 3.2.6 Consistent Help | Support contact in the same place on every page |
| 3.3.7 Redundant Entry | Multi-step forms — admission, import — never re-ask for information already given |
| 3.3.8 Accessible Authentication | **OTP login pastes cleanly**; no cognitive puzzle, no CAPTCHA on the guardian path |

3.3.8 is worth noting: the guardian login is phone-OTP with no password
([§8.4](../phase-1a/08-identity-authn-rbac.md)), which happens to be the most
accessible authentication choice available — nothing to remember, nothing to
transcribe.

## 28.6 Verification in CI

Automated checks catch perhaps 30–40% of issues. Both parts are needed.

| Check | Tool | Blocks build? |
|---|---|---|
| Axe rules on key routes | `@axe-core/playwright` | **Yes** |
| Contrast of the full token set, light and dark | Custom test over the token table | **Yes** |
| **Contrast under a set of hostile tenant brand colours** | Same test, with fixture brands including saturated yellow and pale grey | **Yes** |
| Keyboard traversal of marks grid, attendance, fee collection | Playwright, keyboard only, no mouse events | **Yes** |
| Bare JSX text outside `t()` | ESLint | Yes ([§22.2](22-i18n-architecture.md)) |
| Images without alt, icon buttons without a name | ESLint jsx-a11y | Yes |
| `lang` on mixed-script elements | Custom lint on components rendering `name_bn` in an `en` context | Warn |

The hostile-brand-colour fixture is what makes the contrast guard
([§23.4](23-theme-branding.md)) a tested property rather than an intention.

### Manual verification

Automated tests do not tell you whether a screen is *usable*. Per release:

- Full keyboard pass on the three critical screens
- Screen-reader pass on the guardian result view in both locales
- 200% zoom pass on the fee collection screen
- One real low-end Android device, one real session

## 28.7 Honest limitations

| Limitation | Position |
|---|---|
| Bangla screen-reader quality varies by platform | Outside the platform's control. Correct markup is the obligation; SMS is the fallback for critical information |
| Tenant document templates can be authored inaccessibly | Templates produce **print artefacts**, not interactive UI. Platform defaults are accessible; a tenant editing HTML owns the result |
| No formal WCAG audit budgeted at launch | Stated rather than implied. The CI checks and manual passes are the substitute until there is budget for an external audit |
| Guardians with no literacy | Not solvable by WCAG. SMS in Bangla with short, plain sentences is the accommodation ([§18.7](18-notification-architecture.md)) |

The last row is worth stating plainly: a meaningful share of guardians in the
target segment cannot read fluently in any script. Accessibility for them means
**short Bangla SMS and a phone call from the school**, not ARIA. The product's
job is to make sure the school can reach them, not to assume a portal visit.
