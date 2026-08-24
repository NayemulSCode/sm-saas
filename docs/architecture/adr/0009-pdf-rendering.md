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

### Validated 2026-08-24 — spike OQ-12

The spike specified below was run before Phase 2. **All five shaping feature
classes pass**: conjuncts including three-consonant stacks, ya-phala/ra-phala,
reph, matra reordering, and Bangla numerals with Indic grouping. Font
substitution was ruled out by measurement before trusting any rendering. Full
report: [`../spikes/oq-12-bangla-shaping/`](../spikes/oq-12-bangla-shaping/README.md).

This decision is therefore **confirmed rather than provisional**. The spike
additionally fixes three shipping rules, all defending against *silent*
degradation:

| Rule | Reason |
|---|---|
| **Vendor the exact `.ttf` files** under `assets/fonts/` with SHA-256 checksums; do not install a distro font package | `fonts-noto-core` and friends change the shipped font between distribution versions, so an unrelated `apt upgrade` would silently change shaping and metrics |
| **fontconfig configured with no Bengali fallback** beyond the vendored Noto | A missing font must produce visible tofu, not a silent substitution with different metrics that yields subtly wrong documents |
| **Pin the Playwright browser revision** in the lockfile | The golden-image test then gates Chromium upgrades |

It also produced a measured typographic constraint that was previously guessed:
reph-bearing Bangla ascends **~23% higher than Latin** at the same font-size, and
a line mixing an upper mark with a deep stack needs **1.13em of ink**. Bangla
line-height is therefore **≥ 1.5** body / **≥ 1.35** floor in dense tables, set
per script. `line-height: 1.0` clips.

## Consequences

**Makes easy:** correct Bangla; designer-editable templates; identical preview
and print; batch generation; any CSS-expressible layout.

**Makes hard:** memory. Chromium runs in its own capped, restartable process
with a bounded page pool, and batches are chunked. Container images are large.
Cold start is seconds, so the pool is kept warm during batch windows.

**Forecloses:** nothing. Templates are HTML; WeasyPrint consumes HTML too, so
option C remains a fallback for the same templates.

## Revisit when

- ~~OQ-12 — the shaping spike fails.~~ **Closed 2026-08-24: it passed.** This
  trigger can no longer fire; WeasyPrint and Typst remain documented fallbacks
  only for the memory case below.
- ~~OQ-13 — Chromium memory destabilises the host under a 500-document batch.~~
  **Closed 2026-08-24: it does not.** 500 documents in 4.1 minutes, peak 958 MB,
  no leak ([spike](../spikes/oq-13-pdf-memory/README.md)). The renderer stays on
  the shared host under a hard container memory limit, with the page target
  recycled every 25 renders. Extraction triggers — sustained peak above 1.2 GB,
  interactive p95 degrading during batches, or concurrent batches needed — are
  listed in the spike report. Moving the renderer out precedes reconsidering the
  engine in every case.

## Verification requirement

A **golden-image test in CI** renders
[`../spikes/oq-12-bangla-shaping/fixture.html`](../spikes/oq-12-bangla-shaping/fixture.html)
— already committed — through the real PDF path on the Linux runner and compares
against a reference image. Font or engine upgrades that change shaping fail the
build rather than reaching a parent.

The fixture pairs every case with a ZWNJ-forced control, so the test is readable
by a human as well as by a pixel diff: if the shaped column ever comes to
resemble its control, shaping has regressed.
