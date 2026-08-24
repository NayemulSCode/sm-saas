# Spike OQ-13 — PDF renderer memory and throughput

**Run:** 2026-08-24 · **Status: CLOSED — renderer stays on the shared host, with three controls**

[OQ-13](../../phase-1a/13-open-questions.md) asked whether Chromium's memory
profile under a 500-document batch destabilises the host, and therefore whether
the PDF renderer needs its own machine sooner than planned. Unlike
[OQ-12](../oq-12-bangla-shaping/README.md) this is a **capacity** question, not a
correctness one.

## Verdict

**The PDF renderer does not need its own host at MVP scale.** A 500-document
batch completes in **4.1 minutes** against a 10-minute target, with **no memory
leak** and a peak of **~960 MB**.

Three controls are now mandatory rather than advisory, and one line of
[§24.6](../../phase-1b/24-documents-pdf-bangla.md) is corrected.

## Method

| | |
|---|---|
| Target | [`report-card.html`](report-card.html) — realistic A4 Bangla report card: school header, 8-subject component table, summary tiles, signature block |
| Driver | [`bench.mjs`](bench.mjs) — drives Chromium over the DevTools Protocol. **Zero dependencies**: Node 22+ has native `WebSocket` and `fetch`, so no browser download was needed |
| Engine | Chrome 151 headless (`--headless=new`), isolated profile, `Page.printToPDF` at A4 |
| Memory | Whole Chrome process tree working set, sampled every 500 ms |
| Host | Windows 11, 8 logical CPUs, 15.7 GB RAM |

Rendering is sequential — one page at a time — which is the production pattern:
one batch per host, chunked ([§24.6](../../phase-1b/24-documents-pdf-bangla.md)).

## Throughput

| Run | Docs | Recycle | Wall | Docs/min | mean | p50 | p95 | max |
|---|---|---|---|---|---|---|---|---|
| 1 | 200 | never | 102.4 s | 117.2 | 511 ms | 497 | 606 | 1288 |
| 2 | 200 | every 25 | 99.4 s | 120.7 | 494 ms | 480 | 613 | 1190 |
| 3 | **500** | every 25 | **248.5 s** | **120.7** | 493 ms | 476 | 617 | 1356 |

**Perfectly linear.** Throughput at 500 documents is identical to 200, and
per-document time is flat across the whole batch — first quartile 503.2 ms, last
quartile 501.4 ms. Nothing degrades as the batch runs.

**Target check.** [§4.1](../../phase-1a/04-non-functional-requirements.md)
requires ≥500 report cards in ≤10 minutes. Measured: **4.1 minutes — 2.4×
headroom.**

Sensitivity: this host has 8 CPUs; a 4-vCPU VPS will be slower per render. Even
at **half** the measured throughput (60 docs/min) a 500-document batch finishes
in 8.3 minutes, still inside the target. The target survives a considerably
weaker machine.

## Memory

Working set across the whole Chrome process tree:

| Run | Peak | p95 | Mean | Drift (first→last fifth) | Max procs |
|---|---|---|---|---|---|
| 200, **no recycle** | **1393 MB** | 1322 MB | 856 MB | −132 MB | 11 |
| 200, recycle/25 | **829 MB** | 792 MB | 693 MB | −139 MB | 14 |
| 500, recycle/25 | **958 MB** | 801 MB | 726 MB | −65 MB | 14 |

Two findings, both actionable.

### 1. There is no leak

Drift is **negative in all three runs** — memory is lower at the end than at the
start — and per-document time is flat over 500 renders. Whatever accumulates
during a batch is reclaimed. This matters because it means recycling is not
needed to *survive* a batch; it is an optimisation.

### 2. Page recycling cuts peak memory by 40%, free

Recycling the page target every 25 renders drops peak from **1393 MB to 829 MB**
and p95 from 1322 MB to 792 MB — while being *marginally faster* (120.7 vs 117.2
docs/min). Closing a target lets its renderer process exit and return its memory,
so nothing accumulates in one long-lived renderer.

A 40% reduction in peak for zero cost is not a tuning knob. It is the default.

## Correction to §24.6

[§24.6](../../phase-1b/24-documents-pdf-bangla.md) said *"the browser restarts
every N documents to cap memory"*. That was written defensively, before
measurement, and it is **wrong in a way that costs throughput**: a browser
restart pays 1–3 s of startup, and the leak it defends against does not exist.

**Corrected:** recycle the **page target** every ~25 renders. Do not restart the
browser on a schedule. Restart it only on a crash or an unhealthy health check.

## Output characteristics

| Property | Value |
|---|---|
| Size per document | **286 KB** (1 page, A4) |
| Format | PDF 1.4, producer Skia/PDF m151 |
| Embedded fonts | 2 subsetted TrueType faces (`FontFile2`) |
| Text layer | 22 `ToUnicode` CMaps present — **PDFs are searchable and text-extractable** |
| 500-document batch | ≈ 139 MB |

286 KB for a one-page document is large, and it is dominated by the two embedded
Bengali font subsets — Bengali faces carry a big glyph set because of conjunct
ligatures. Pre-subsetting the vendored fonts to the required range (already
required for the web payload in [§22.4](../../phase-1b/22-i18n-architecture.md))
would cut this substantially.

It is not a constraint either way: 100 schools × 500 students × 3 exams ≈ 150,000
documents/year ≈ 43 GB, which is under US$0.70/month on R2 — and report cards
regenerate deterministically from the immutable `result_snapshot`
([§24.8](../../phase-1b/24-documents-pdf-bangla.md)), so storing them at all is an
optimisation.

## Decision and the controls it depends on

**The renderer stays on the shared host.** Conditional on:

| Control | Why |
|---|---|
| **Recycle the page target every 25 renders** | 40% lower peak, free. Mandatory |
| **Hard container memory limit (`mem_limit: 1.5g`)** | **The critical control.** Chromium sizes its caches to available memory — unbounded on a shared host it will expand and starve PostgreSQL. Under a cgroup limit it adapts. Without this, every other number here is optimistic |
| **Renderer concurrency = 1 per host** | One batch at a time. Two concurrent batches roughly double peak |
| **Reserve ~1.2 GB** for the renderer in host sizing | Measured 958 MB peak + headroom |
| Prefer scheduling large batches outside 09:00–15:00 | Result publication is a planned event, not a surprise |

### Host sizing consequence

On an 8 GB VPS ([ADR-0002](../../adr/0002-hosting-and-region.md)):

| Component | Budget |
|---|---|
| PostgreSQL | 2.5–3.0 GB |
| Next.js app | 0.7 GB |
| Worker (non-PDF) | 0.3 GB |
| **PDF renderer (capped)** | **1.2 GB** |
| OS + page cache | 1.5 GB |
| **Total** | **~6.2–6.7 GB of 8 GB** |

**Recommendation: 8 GB is the minimum host size.** On a 4 GB box the renderer
must either move to its own machine or be restricted to off-peak batches. This
is a concrete input to the Phase 1C cost model.

## Revisit / extract triggers

Move the renderer to its own host when any of these fires:

- Sustained peak above **1.2 GB** even under the container limit
- Interactive API p95 degrading measurably **during** PDF batches
- More than one concurrent batch is needed — e.g. several schools publishing
  results the same hour
- Batch completion exceeding **8 minutes** for 500 documents on production hardware

Extraction is deliberately cheap: the renderer is already a separate process with
a queue in front of it ([§6.6](../../phase-1a/06-architecture-overview.md)), so
moving it is deployment work, not redesign.

## What this does not prove

| Residual | Handling |
|---|---|
| Measured on Windows, 8 CPUs, 15.7 GB — not a 4-vCPU Linux container | Linux headless Chromium is typically *lighter* than Windows Chrome, so these figures should be conservative. Re-measure on the provisioned VPS in Phase 2 before fixing `mem_limit` |
| Behaviour **under** a cgroup memory limit not tested | The most important follow-up. Chromium adapts to a limit, but the adaptation must be observed rather than assumed |
| Single template; a heavier multi-page tabulation sheet will differ | Re-run `bench.mjs` against that template when it exists |
| Fonts served from Google Fonts, cached after first render | Production vendors them ([ADR-0009](../../adr/0009-pdf-rendering.md)); if anything this is slightly pessimistic on the first render only |

## Reproducing

```bash
python -m http.server 8100 --bind 127.0.0.1 --directory docs/architecture/spikes/oq-13-pdf-memory
```

Then, with a headless Chromium listening on `--remote-debugging-port=9222`:

```bash
node docs/architecture/spikes/oq-13-pdf-memory/bench.mjs --n=500 --recycle=25 --url=http://127.0.0.1:8100/report-card.html
```

`bench.mjs` is committed and re-runnable against the real VPS in Phase 2 — it is
the tool that answers the residuals above.
