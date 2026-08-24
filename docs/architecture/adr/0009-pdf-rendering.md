# ADR-0009 — Headless Chromium with pinned Noto Bengali fonts for PDF

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1A

## Context

Report cards, marksheets, tabulation sheets, admit cards and money receipts are
the product's most visible artefacts. All are bilingual.

Bangla is a complex script. Correct rendering requires OpenType shaping —
conjuncts (যুক্তাক্ষর), ya-phala (্য), reph (র্), hasant, and matras that
reorder around the base glyph. Most PDF libraries lay out glyphs left to right
with kerning and no shaping engine, producing text that is **visibly wrong to
every Bangladeshi reader**. The brief is right that this must be settled in
Phase 1.

## Options

### A. pdfmake / PDFKit / jsPDF
Pure JS, light, easy. **No complex-script shaping.** Disqualifying.

### B. Headless Chromium via Playwright
Uses HarfBuzz — the same shaping engine as the browser, so what the designer sees
in preview is what prints. Templates are HTML/CSS, which the team already knows
and which makes per-school layouts data rather than code. Costs 300–500 MB
resident per instance and a large container image.

### C. WeasyPrint (Python, Pango + HarfBuzz)
Correct shaping, far lighter than Chromium, good CSS paged-media support.
Introduces Python into a TypeScript stack and diverges from browser rendering,
so preview and print can differ.

### D. Typst
Fast, low memory, shapes via rustybuzz. A new template language to learn, a
smaller ecosystem, and no browser preview path.

## Decision

**B — headless Chromium in the worker image**, with Noto Sans Bengali and Noto
Serif Bengali **pinned by version and baked into the image**.

Two deciding reasons. First, HTML/CSS templates mean FR-10.4 — per-school layout
without code changes — is satisfied by editing a template row, and the in-app
preview is the same renderer as the output. Second, the failure mode of the
alternatives is silent: a font-substitution difference between the preview and
the PDF worker produces a wrong report card that nobody notices until a parent
does.

**Fonts are pinned and vendored**, never fetched at render time. A font update
that changes shaping would silently alter every future document; a font fetch
that fails at 23:00 during a batch would produce boxes.

## Consequences

**Makes easy:** correct Bangla; designer-editable templates; identical preview
and print; batch generation; any CSS-expressible layout.

**Makes hard:** memory. Chromium runs in its own capped, restartable process
with a bounded page pool, and batches are chunked. Container images are large.
Cold start is seconds, so the pool is kept warm during batch windows.

**Forecloses:** nothing. Templates are HTML; WeasyPrint consumes HTML too, so
option C remains a fallback for the same templates.

## Revisit when

- **[OQ-12](../phase-1a/13-open-questions.md)** — the week-one shaping spike
  fails. Then WeasyPrint or Typst move up immediately.
- **[OQ-13](../phase-1a/13-open-questions.md)** — Chromium memory destabilises
  the host under a 500-document batch. First move the renderer to its own host
  (it is already a separate process); only then reconsider the engine.

## Verification requirement

A **golden-image test in CI** renders a fixture containing reph, ya-phala,
hasant, stacked conjuncts, Bangla numerals and mixed Bangla/Latin text, and
compares against a committed reference image. Font or engine upgrades that
change shaping fail the build rather than reaching a parent.
