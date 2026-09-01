// qucalc-search.test.mjs — the streaming NDJSON client for the QLF QuCalc
// Search service (qos#117).
//
// The service is a pure function of twist_core.py, so there is nothing to mock
// about the substrate — what this covers is the client's own job: framing the
// NDJSON stream, honouring the contract-version pin, surfacing HTTP errors, and
// the possibilities/events + concurrent-seed shapes.
//
//   node packages/browser/test/qucalc-search.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// A minimal localStorage so loadSearchConfig / saveSearchConfig work under node.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// Stub fetch: each test sets `nextResponse` to the lines (or an {status,error}).
let lastUrl = null;
let nextResponse = null;
globalThis.fetch = async (u) => {
  lastUrl = new URL(u);
  const r = nextResponse;
  if (r.status && r.status >= 400) {
    return {
      ok: false,
      status: r.status,
      json: async () => ({ error: r.error }),
    };
  }
  const body = new ReadableStream({
    start(ctrl) {
      const enc = new TextEncoder();
      for (const line of r.lines) ctrl.enqueue(enc.encode(line + "\n"));
      ctrl.close();
    },
  });
  return { ok: true, status: 200, body };
};

const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "qucalc-search.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const { qucalcSearch, qucalcSearchInfo, loadSearchConfig, saveSearchConfig,
        CONTRACT_VERSION, QucalcContractMismatch } = mod;

let failed = 0;
const ok = (label, cond) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}`); }
};
const meta = (extra = {}) =>
  JSON.stringify({ _meta: true, version: CONTRACT_VERSION, qc: ["^v"], max_depth: 6, ...extra });

// --- happy path: yields each closure, returns the _done rollup ----------------
{
  nextResponse = {
    lines: [
      meta(),
      JSON.stringify({ cont: "v>", history: "^vv>", len: 4, depth: 2, phase: "-1" }),
      JSON.stringify({ cont: "<>", history: "^v<>", len: 4, depth: 2, phase: "+1" }),
      JSON.stringify({ _done: true, found: 2, elapsed_s: 0.01, truncated: false,
                       mode: "possibilities", max_depth: 6, seeds: ["^v"], per_seed: null,
                       listeners: { count: { total: 2 } } }),
    ],
  };
  const got = [];
  const gen = qucalcSearch("http://x:8765", "^v", { maxDepth: 6 });
  let step;
  while (!(step = await gen.next()).done) got.push(step.value);
  const done = step.value;
  ok("yields every closure line", got.length === 2 && got[0].cont === "v>");
  ok("returns the _done rollup", done.found === 2 && done.mode === "possibilities" && done.maxDepth === 6);
  ok("query carries qc + max_depth", lastUrl.searchParams.get("qc") === "^v" && lastUrl.searchParams.get("max_depth") === "6");
}

// --- contract pin: a version the client does not know throws loudly -----------
{
  nextResponse = { lines: [JSON.stringify({ _meta: true, version: "9.9" })] };
  let caught = null;
  try {
    const gen = qucalcSearch("http://x:8765", "^v");
    while (!(await gen.next()).done) { /* drain */ }
  } catch (e) { caught = e; }
  ok("mismatched contract version throws QucalcContractMismatch",
     caught instanceof QucalcContractMismatch && caught.serviceVersion === "9.9");
}

// --- stream=0: no per-closure lines, just the rollup -------------------------
{
  nextResponse = {
    lines: [
      meta({ stream: false }),
      JSON.stringify({ _done: true, found: 5296, elapsed_s: 2.9, truncated: false,
                       mode: "possibilities", seeds: ["^<v>+-"], per_seed: null,
                       listeners: { count: { total: 5296 }, phase: { "+1": 2648, "-1": 2648, "+i": 0, "-i": 0 } } }),
    ],
  };
  const got = [];
  const gen = qucalcSearch("http://x:8765", "^<v>+-", { stream: false, listeners: "phase" });
  let step;
  while (!(step = await gen.next()).done) got.push(step.value);
  ok("stream:false yields nothing", got.length === 0);
  ok("stream:false still returns the rollup", step.value.found === 5296 && step.value.listeners.phase["+1"] === 2648);
  ok("query sets stream=0", lastUrl.searchParams.get("stream") === "0");
}

// --- events mode + concurrent seeds ----------------------------------------
{
  nextResponse = {
    lines: [
      JSON.stringify({ _meta: true, version: CONTRACT_VERSION, mode: "events" }),
      JSON.stringify({ cont: "v", history: "^v", len: 2, depth: 1, phase: "+1", qc: "^" }),
      JSON.stringify({ _done: true, found: 1, elapsed_s: 0.0, truncated: false, mode: "events",
                       seeds: ["^", "+-"], per_seed: { "^": 1, "+-": 0 },
                       listeners: { count: { total: 1 } } }),
    ],
  };
  const gen = qucalcSearch("http://x:8765", ["^", "+-"], { mode: "events" });
  let step, first;
  while (!(step = await gen.next()).done) first ??= step.value;
  ok("concurrent seeds are comma-joined in qc", lastUrl.searchParams.get("qc") === "^,+-");
  ok("mode=events is sent", lastUrl.searchParams.get("mode") === "events");
  ok("closure carries its originating seed", first.qc === "^");
  ok("per_seed comes back on _done", step.value.perSeed["^"] === 1 && step.value.perSeed["+-"] === 0);
}

// --- HTTP 400 surfaces the service's error message --------------------------
{
  nextResponse = { status: 400, error: "qc required (comma-separate for several)" };
  let caught = null;
  try {
    const gen = qucalcSearch("http://x:8765", "");
    while (!(await gen.next()).done) { /* drain */ }
  } catch (e) { caught = e; }
  ok("a 400 throws with the service's error text",
     caught && /400/.test(caught.message) && /qc required/.test(caught.message));
}

// --- a stream that ends before _done is reported, not silently truncated ----
{
  nextResponse = {
    lines: [meta(), JSON.stringify({ cont: "v", history: "^v", len: 2, depth: 1, phase: "+1" })],
  };
  let caught = null;
  try {
    const gen = qucalcSearch("http://x:8765", "^");
    while (!(await gen.next()).done) { /* drain */ }
  } catch (e) { caught = e; }
  ok("a truncated stream (no _done) throws", caught && /_done/.test(caught.message));
}

// --- no endpoint set is a clear error, not a bad fetch ----------------------
{
  let caught = null;
  try {
    const gen = qucalcSearch("", "^v");
    await gen.next();
  } catch (e) { caught = e; }
  ok("empty base URL throws before fetching", caught && /endpoint/.test(caught.message));
}

// --- config round-trips through localStorage -------------------------------
{
  ok("default config is the public Render deployment",
     loadSearchConfig().url === "https://quantum-os-qucalc-search.onrender.com");
  saveSearchConfig({ url: "https://qc.example:8765" });
  ok("saved url loads back", loadSearchConfig().url === "https://qc.example:8765");
}

// --- info probe flags a contract mismatch without throwing -----------------
{
  nextResponse = { lines: [], status: 200, body: null };
  globalThis.fetch = async (u) => {
    lastUrl = new URL(u);
    return { ok: true, status: 200, json: async () => ({
      service: "qucalc_search", version: "9.9",
      caps: { max_depth: 7, max_limit: 100000 }, alphabet: ["^", "v"],
    }) };
  };
  const info = await qucalcSearchInfo("http://x:8765");
  ok("info surfaces a version mismatch as a flag", info.contractMismatch === true && info.version === "9.9");
}

console.log(failed === 0 ? "\nqucalc-search: all passed" : `\nqucalc-search: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
