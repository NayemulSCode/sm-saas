# Spike OQ-12 — Bangla shaping in the PDF stack

**Run:** 2026-08-24 · **Status: CLOSED — ADR-0009 confirmed, no engine change**

[OQ-12](../../phase-1a/13-open-questions.md) asked whether headless Chromium with
pinned Noto Bengali actually renders Bangla correctly, and warned that
discovering otherwise in Phase 3 would be a crisis. It was the highest-priority
open question in Phase 1. This is the answer.

## Verdict

**Chromium + Noto Bengali shapes Bangla correctly.** All five features from
[§24.1](../../phase-1b/24-documents-pdf-bangla.md) pass. The engine decision in
[ADR-0009](../../adr/0009-pdf-rendering.md) stands unchanged.

The spike also produced three sub-decisions that tighten how the fonts are
shipped, and one measured typographic rule that would otherwise have been
guessed. Those are the parts worth reading.

## Method

| | |
|---|---|
| Fixture | [`fixture.html`](fixture.html) — every feature in §24.1, each paired with a **ZWNJ-forced control** showing what unshaped output looks like |
| Engine | Chromium (the Browser pane), served over `http://127.0.0.1:8099` |
| Fonts | Noto Sans Bengali 400/600 and Noto Serif Bengali 400/600 |
| Font verification | `document.fonts.check()` plus a canvas width comparison against a deliberate fallback |
| Measurement | Canvas `TextMetrics.actualBoundingBox*` for ink extents |

The paired-control design is what makes the fixture readable as evidence: if the
shaped column and the control column look alike, shaping failed. They do not
look alike anywhere.

**Font substitution was ruled out before trusting any rendering.** The same
string measured 296.92px in Noto Sans Bengali, 283.70px in Noto Serif Bengali
and 330.82px in the system fallback — three distinct values, so the pinned faces
were genuinely in use rather than being silently replaced by a Windows Bangla
font.

## Results

| # | Feature | Cases | Result |
|---|---|---|---|
| 1 | Conjuncts | ক্ষ · ঞ্জ · ন্ত্র · স্ত্র · দ্ধ · হ্ম | **Pass** — single fused ligatures; three-consonant stacks form correctly |
| 2 | Ya-phala / ra-phala | ব্য · ব্যবস্থা · প্র · শ্রেণি | **Pass** |
| 3 | **Reph** | র্ক · কার্য · সূর্য · বার্ষিক | **Pass** — ra renders as a hook *above* the following consonant, with no leading র |
| 4 | Matra reordering | কি · কে · কো · কৌ · শিক্ষার্থী | **Pass** — i-matra moves left of its base; ো and ৌ split correctly to both sides |
| 5 | Numerals | ০–৯ · ১,২৩,৪৫৬.৭৮ · ৳ | **Pass** — distinct Bangla glyphs; Indic 2,2,3 grouping renders |

Feature 3 is the one that matters most, because reph is the most commonly broken
Bangla feature and its failure is unmistakable to a reader. In the shaped column
`র্ক` renders as ক carrying a hook; in the control it renders as র + visible
hasant + ক. They are plainly different.

Feature 4 is the one that eliminates a whole class of engine: matra reordering is
*reordering*, not ligature substitution, so a renderer that only does ligatures
still fails it. Chromium passes because it runs HarfBuzz.

## The measured finding — Bangla needs more leading than Latin

Ink extents at 22px, via `TextMetrics`:

| Content | Ascent | Descent | Total ink |
|---|---|---|---|
| Latin — "Class 5 Result" | 17.00 | 1.00 | 18.00 |
| Plain Bangla — বাংলা | 16.00 | 1.00 | 17.00 |
| Reph-bearing — বার্ষিক | **20.93** | 0.00 | 20.93 |
| Deep stack — ন্ত্র | 14.00 | **2.99** | 16.99 |
| Worst case — শিক্ষার্থীর কার্যক্রম | **21.84** | 0.00 | 21.84 |

Two numbers matter:

- **Reph-bearing Bangla ascends ~23% higher than Latin** at the same font-size
  (20.93 vs 17.00).
- **The worst case uses 21.84px of a 22px line box at `line-height: 1.0`** —
  99.3% consumed, 0.16px of headroom. And a line mixing a reph-bearing word with
  a deep stack needs 21.84 + 2.99 = **24.83px of ink, or 1.13em** — which clips
  by roughly 13%.

So `line-height: 1.0` on Bangla is not "tight", it is *actively clipping* as soon
as one line contains both an upper mark and a descender. Sub-pixel rounding makes
the margin at 1.0 meaningless even for the ascent-only case.

**Rule adopted:** Bangla line-height **≥ 1.5** for body text, **≥ 1.35** as an
absolute floor in dense table rows. Set **per script**, not globally — Latin at
1.2 is fine and matching Bangla's leading everywhere would waste vertical space
on a report card that has to fit one page.

This is the kind of thing that would otherwise have been discovered as "the
report cards look slightly wrong" three months into Phase 3.

## Sub-decisions this spike forces

**1. Vendor the exact font files; do not install a distro package.**
`fonts-noto-core` and similar packages change the shipped font across
distribution versions, which would silently change shaping and metrics on an
unrelated `apt upgrade`. The exact `.ttf` files are committed under
`assets/fonts/` with SHA-256 checksums, and the Dockerfile copies them in.

**2. Configure fontconfig with no Bengali fallback beyond the vendored Noto.**
If the font is missing from the image, the correct outcome is **tofu boxes** — a
loud, obvious failure — not a silent substitution with different metrics that
produces subtly wrong documents nobody notices. Fail loudly, at build time.

**3. Pin the Playwright browser revision in the lockfile.**
The golden-image test gates the upgrade: a Chromium bump that changes shaping
fails CI rather than reaching a parent.

All three exist because the failure mode being defended against is *silent*
degradation. Every one converts it into a loud one.

## What this does and does not prove

Stated precisely, because overclaiming here would defeat the purpose of running
the spike at all.

**Proved:**

- Chromium's shaping (HarfBuzz) with Noto Bengali renders all five feature
  classes correctly. HarfBuzz is bundled inside Chromium rather than taken from
  the OS, and the font file is the same artefact that will be vendored — so the
  engine + font combination is validated.
- The specific typographic constraint on line-height, with numbers.

**Not proved, and deliberately out of scope here:**

| Residual | Where it is handled |
|---|---|
| Rendered on Windows, not in the Linux container | Fonts vendored + fontconfig fail-loud (sub-decisions 1–2); the golden-image test runs on the CI Linux runner |
| Fonts loaded over the network for the spike; production bakes them in | Explicit in [ADR-0009](../../adr/0009-pdf-rendering.md); the spike used the network path only to avoid a binary download |
| Screen raster, not `page.pdf()` output | PDF embeds the same shaped glyph run; covered by the golden-image test rendering through the real PDF path |
| Chromium memory under a 500-document batch | **[OQ-13](../../phase-1a/13-open-questions.md) — still open.** Separable: it is a capacity question, not a correctness one |

The residual risk reduces to *"was the font actually installed in the image"* —
which is a Dockerfile line, verified at build time, and caught by CI.

## Reproducing

```bash
python -m http.server 8099 --bind 127.0.0.1 \
  --directory docs/architecture/spikes/oq-12-bangla-shaping
```

Open `http://127.0.0.1:8099/fixture.html`. Every row must differ visibly from its
red control.

`fixture.html` is committed as the **CI golden-image fixture** specified in
[§24.5](../../phase-1b/24-documents-pdf-bangla.md). Phase 3 renders it through
the real PDF path on the Linux runner and diffs against a committed reference,
so font, engine or CSS changes that alter shaping fail the build.
