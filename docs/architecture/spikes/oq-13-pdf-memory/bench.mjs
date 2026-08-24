// OQ-13 — PDF renderer memory and throughput bench.
//
// Drives an already-running Chromium over the DevTools Protocol and renders the
// same report card N times, optionally recycling the page target every K
// renders. Zero dependencies: Node 22+ has a global WebSocket and fetch, so
// this needs no install step and no browser download.
//
//   node bench.mjs --n=200 --recycle=25 --url=http://127.0.0.1:8100/report-card.html
//
// Prints one JSON summary line at the end; per-render timings go to --csv.

import { writeFileSync, appendFileSync } from 'node:fs';

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const N        = Number(arg('n', 200));
const RECYCLE  = Number(arg('recycle', 0));         // 0 = never recycle the page
const URL_BASE = arg('url', 'http://127.0.0.1:8100/report-card.html');
const PORT     = Number(arg('port', 9222));
const CSV      = arg('csv', 'renders.csv');
const KEEP     = Number(arg('keep', 2));            // how many PDFs to write out

// ---------------------------------------------------------------- CDP plumbing
const { webSocketDebuggerUrl } =
  await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();

const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let nextId = 1;
const pending = new Map();
const waiters = [];                                  // [{ method, sessionId, resolve }]

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i];
    if (w.method === msg.method && (!w.sessionId || w.sessionId === msg.sessionId)) {
      waiters.splice(i, 1);
      w.resolve(msg.params);
    }
  }
};

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId }
                                     : { id, method, params }));
  });

const waitFor = (method, sessionId, timeoutMs = 30000) =>
  new Promise((resolve, reject) => {
    const w = { method, sessionId, resolve };
    waiters.push(w);
    setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timeout ${method}`)); }
    }, timeoutMs);
  });

// ------------------------------------------------------------------ page pool
async function openPage() {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  return { targetId, sessionId };
}
const closePage = (targetId) => send('Target.closeTarget', { targetId });

// ------------------------------------------------------------------- the run
writeFileSync(CSV, 'i,ms,bytes\n');
let page = await openPage();
let recycles = 0;
const times = [];
const t0 = Date.now();

for (let i = 0; i < N; i++) {
  if (RECYCLE > 0 && i > 0 && i % RECYCLE === 0) {
    await closePage(page.targetId);
    page = await openPage();
    recycles++;
  }

  const started = Date.now();
  const loaded = waitFor('Page.loadEventFired', page.sessionId);
  await send('Page.navigate', { url: `${URL_BASE}?i=${i}` }, page.sessionId);
  await loaded;

  // Webfonts must be settled before printing or the first renders measure a
  // different layout than the rest.
  await send('Runtime.evaluate', {
    expression: 'document.fonts.ready.then(() => 1)', awaitPromise: true,
  }, page.sessionId);

  const { data } = await send('Page.printToPDF', {
    printBackground: true,
    paperWidth: 8.27, paperHeight: 11.69,          // A4 inches
    marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    preferCSSPageSize: true,
  }, page.sessionId);

  const ms = Date.now() - started;
  const bytes = Buffer.from(data, 'base64').length;
  times.push(ms);
  appendFileSync(CSV, `${i},${ms},${bytes}\n`);

  if (i < KEEP) writeFileSync(`sample-${i}.pdf`, Buffer.from(data, 'base64'));
  if ((i + 1) % 25 === 0) process.stderr.write(`  ${i + 1}/${N}\n`);
}

const wall = (Date.now() - t0) / 1000;
const sorted = [...times].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

console.log(JSON.stringify({
  n: N, recycleEvery: RECYCLE || null, recycles,
  wallSeconds: +wall.toFixed(1),
  docsPerMinute: +((N / wall) * 60).toFixed(1),
  ms: { mean: +mean(times).toFixed(1), p50: pct(0.5), p95: pct(0.95), max: sorted.at(-1) },
  driftFirstVsLastQuartile: {
    first: +mean(times.slice(0, Math.ceil(N / 4))).toFixed(1),
    last:  +mean(times.slice(-Math.ceil(N / 4))).toFixed(1),
  },
}));

await closePage(page.targetId);
ws.close();
