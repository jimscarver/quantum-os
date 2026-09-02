// qucalc-search.test.mjs — the local "what closes next" enumerator (#119).
//
// `/search` and `/solve` compute in the browser now — no service, no HTTP. This
// covers the enumerator (`qucalc-enum.ts`): the possibilities/events shapes, the
// listener rollups, the deterministic `/solve` cascade and its residual report,
// and — the load-bearing bit — that the count-balance gate is QLF's per-axis
// vector, not quantum-os's weaker aggregate. Plus a conformance block of digests
// captured from `qucalc_search.py` (7046c55) so the TS port cannot silently
// drift.
//
//   node packages/browser/test/qucalc-search.test.mjs

import { build } from "esbuild";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "qucalc-enum.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
  external: ["@quantum-os/zfa-core"],   // WASM — never loaded on this path (pure-TS fold)
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const {
  enumerateClosures, runSearch, solvePosition, actionOf, maxExcursion, residualToTwists,
} = mod;

let failed = 0;
const ok = (label, cond) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}`); }
};
const list = (qc, opts) => [...enumerateClosures(qc, opts)];

// --- possibilities: every closure within depth, shortest first ---------------
{
  const cs = list("^v", { maxDepth: 4, limit: null });
  ok("possibilities yields closures", cs.length === 176);
  ok("shortest first (depth non-decreasing)", cs.every((c, i) => i === 0 || cs[i - 1].depth <= c.depth));
  ok("each is count-balanced (signed action vanishes)",
     cs.every(c => actionOf(c.history).every(x => x === 0)));
  ok("history = qc + cont, len set", cs.every(c => c.history === "^v" + c.cont && c.len === c.history.length));
  ok("phase is a Pauli scalar", cs.every(c => ["+1", "-1", "+i", "-i"].includes(c.phase)));
}

// --- events (absorbing): first closure per branch, prefix-free ---------------
{
  const poss = list("^v", { maxDepth: 4, limit: null });
  const events = list("^v", { maxDepth: 4, limit: null, absorbing: true });
  ok("events ⊂ possibilities", events.length < poss.length && events.length === 112);
  const conts = events.map(e => e.cont);
  ok("event conts are prefix-free",
     conts.every(a => !conts.some(b => b !== a && a.startsWith(b))));
}

// --- limit truncates without a marker --------------------------------------
{
  const capped = list("^v", { maxDepth: 6, limit: 5 });
  ok("limit stops the generator", capped.length === 5);
}

// --- the gate is QLF's per-axis vector, NOT the aggregate ------------------
{
  // `^^<<` folds to +I and is aggregate-balanced (2 pos, 2 neg) — `achievesZfa`
  // accepts it — but its signed action is (2,-2,0,0), so the Python rejects it
  // and so must we: the per-axis `need` filter excludes it before any fold.
  const fromUpUp = list("^^", { maxDepth: 4, limit: null }).map(c => c.history);
  ok("^^<< is never emitted as a closure", !fromUpUp.includes("^^<<"));
  ok("^^ closes only by supplying (-2,0,0,0) on the v axis",
     fromUpUp.every(h => actionOf(h.slice(2)).join() === [-2, 0, 0, 0].join()));
  // and a seed whose only 'balance' is aggregate still has a real residual
  const r = solvePosition("^^<<");
  ok("solve treats ^^<< as open, not closed", r.solved === true && r.alreadyClosed === false);
}

// --- validation -----------------------------------------------------------
{
  let threw = false;
  try { list("xyz", { maxDepth: 2 }); } catch { threw = true; }
  ok("invalid twist chars throw", threw);
}

// --- runSearch report + listeners + concurrent seeds ----------------------
{
  const gen = runSearch(["^", "+-"], { mode: "events", maxDepth: 6, listeners: "phase,depth,capacity:2,capacity:3,head:5" });
  const yielded = [];
  let step;
  while (!(step = gen.next()).done) yielded.push(step.value);
  const rep = step.value;
  ok("report: found matches yield count", rep.found === yielded.length);
  ok("report: mode carried", rep.mode === "events");
  ok("concurrent seeds tag each closure with its qc", yielded.every(c => c.qc === "^" || c.qc === "+-"));
  ok("report: perSeed present and sums to found",
     rep.perSeed && rep.perSeed["^"] + rep.perSeed["+-"] === rep.found);
  ok("listener: count.total = found", rep.listeners.count.total === rep.found);
  ok("listener: phase buckets sum to found",
     Object.values(rep.listeners.phase).reduce((a, b) => a + b, 0) === rep.found);
  ok("listener: depth histogram sums to found",
     Object.values(rep.listeners.depth).reduce((a, b) => a + b, 0) === rep.found);
  const cap3 = rep.listeners["capacity:3"];
  ok("listener: capacity heard+missed = found", cap3.heard + cap3.missed === rep.found);
  ok("listener: capacity R carried", cap3.R === 3);
  ok("listener: head caps its list", rep.listeners.head.conts.length <= 5);
}

// --- single seed: no qc tag, perSeed null --------------------------------
{
  const gen = runSearch(["^v"], { maxDepth: 4 });
  let step; const got = [];
  while (!(step = gen.next()).done) got.push(step.value);
  ok("single seed: closures carry no qc tag", got.every(c => c.qc === undefined));
  ok("single seed: perSeed is null", step.value.perSeed === null);
}

// --- solve: the deterministic cascade -----------------------------------
{
  const r = solvePosition("^^<");
  ok("solve picks a winner", r.solved === true && r.cont === "v>v");
  ok("solve winner is least peak excursion then shortest",
     r.peakExcursion === 3 && r.depth === 3 && r.phase === "+1");
  // determinism: same answer every call
  ok("solve is deterministic", solvePosition("^^<").history === r.history);
}

// --- solve: already-closed --------------------------------------------
{
  const r = solvePosition("^v<>");
  ok("solve recognises an existing closure", r.solved === true && r.alreadyClosed === true && r.cont === "" && r.depth === 0);
}

// --- solve: miss reports the residual --------------------------------
{
  const r = solvePosition("^^^^^^^^<");   // residual (-8,1,0,0), floor 9 > depth cap 7
  ok("solve miss: solved false", r.solved === false);
  ok("solve miss: residual is -signedAction", JSON.stringify(r.residual) === JSON.stringify([-8, 1, 0, 0]));
  ok("solve miss: floor depth", r.floorDepth === 9);
  ok("solve miss: reason beyond max_depth", r.reason === "beyond max_depth");
  ok("solve miss: completion count-balances", r.completion === "vvvvvvvv>" && actionOf(r.completion).join() === [-8, 1, 0, 0].join());
}

// --- solve: --all shortlist -------------------------------------------
{
  const r = solvePosition("^^<", { withShortlist: true });
  ok("shortlist present with withShortlist", Array.isArray(r.shortlist) && r.shortlist.length === r.considered);
  ok("shortlist[0] is the winner", r.shortlist[0].history === r.history);
  ok("shortlist is ranked by peak excursion",
     r.shortlist.every((e, i) => i === 0 || maxExcursion(r.shortlist[i - 1].history) <= maxExcursion(e.history)));
}

// --- residualToTwists round-trips the action vector -----------------
{
  for (const v of [[1, 0, 0, 0], [-2, 1, 0, -1], [0, 0, 3, -3]]) {
    ok(`residualToTwists ${v} count-balances to it`, actionOf(residualToTwists(v)).join() === v.join());
  }
}

// =========================================================================
// conformance — digests captured from quantum-logical-framework qucalc_search.py
// (7046c55). If the port drifts, one of these mismatches.
// =========================================================================
const FIXTURES = {
  search: [
    { seed: "^v", depth: 4, mode: "possibilities", count: 176, phase: { "+1": 32, "-1": 144 }, byDepth: { 2: 8, 4: 168 }, sha256: "bc3648fbe25a0da0" },
    { seed: "^v", depth: 4, mode: "events", count: 112, phase: { "+1": 32, "-1": 80 }, byDepth: { 2: 8, 4: 104 }, sha256: "53efa9b9a3db1f98" },
    { seed: "^^<", depth: 6, mode: "events", count: 149, phase: { "-1": 62, "+1": 87 }, byDepth: { 3: 3, 5: 146 }, sha256: "7c841be94441e115" },
    { seed: "+-", depth: 5, mode: "possibilities", count: 176, phase: { "+1": 32, "-1": 144 }, byDepth: { 2: 8, 4: 168 }, sha256: "bc3648fbe25a0da0" },
    { seed: "^<v>+-", depth: 4, mode: "events", count: 112, phase: { "-1": 32, "+1": 80 }, byDepth: { 2: 8, 4: 104 }, sha256: "2e1bf41fd2e1741b" },
    { seed: "^<v>+-", depth: 6, mode: "possibilities", count: 5296, phase: { "-1": 3664, "+1": 1632 }, byDepth: { 2: 8, 4: 168, 6: 5120 }, sha256: "b255678dd7cf4895" },
    { seed: "^", depth: 5, mode: "events", count: 493, phase: { "+1": 193, "-1": 300 }, byDepth: { 3: 21, 5: 472 }, sha256: "f3af922811c5c8eb" },
    { seed: "/\\", depth: 4, mode: "possibilities", count: 176, phase: { "+1": 32, "-1": 144 }, byDepth: { 2: 8, 4: 168 }, sha256: "bc3648fbe25a0da0" },
  ],
  solve: {
    "^^<": { solved: true, cont: "v>v", history: "^^<v>v", depth: 3, phase: "+1", peak_excursion: 3, arrangements: 20, considered: 149, searched_depth: 5 },
    "^<>": { solved: true, cont: "v", history: "^<>v", depth: 1, phase: "+1", peak_excursion: 2, arrangements: 6, considered: 14, searched_depth: 3 },
    "+": { solved: true, cont: "-+-", history: "+-+-", depth: 3, phase: "+1", peak_excursion: 1, arrangements: 6, considered: 21, searched_depth: 3 },
    "^v<>": { solved: true, cont: "", history: "^v<>", depth: 0, phase: "+1", peak_excursion: 1, arrangements: 6, considered: 0, searched_depth: 0, already_closed: true },
    "/\\/": { solved: true, cont: "\\", history: "/\\/\\", depth: 1, phase: "+1", peak_excursion: 1, arrangements: 6, considered: 14, searched_depth: 3 },
    "^^^": { solved: true, cont: "vvv", history: "^^^vvv", depth: 3, phase: "-1", peak_excursion: 3, arrangements: 20, considered: 58, searched_depth: 5 },
    "^^^^<": { solved: true, cont: "v>vvv", history: "^^^^<v>vvv", depth: 5, phase: "+1", peak_excursion: 5, arrangements: 252, considered: 532, searched_depth: 7 },
    "<<>": { solved: true, cont: ">", history: "<<>>", depth: 1, phase: "+1", peak_excursion: 2, arrangements: 6, considered: 14, searched_depth: 3 },
    "+++---": { solved: true, cont: "", history: "+++---", depth: 0, phase: "-1", peak_excursion: 3, arrangements: 20, considered: 0, searched_depth: 0, already_closed: true },
    "^^^^^^<": { solved: true, cont: "v>vvvvv", history: "^^^^^^<v>vvvvv", depth: 7, phase: "+1", peak_excursion: 7, arrangements: 3432, considered: 7, searched_depth: 7 },
    "^^^^^^^^<": { solved: false, residual: [-8, 1, 0, 0], floor_depth: 9, searched_depth: 7, reason: "beyond max_depth", completion: "vvvvvvvv>" },
  },
};

for (const f of FIXTURES.search) {
  const cs = list(f.seed, { maxDepth: f.depth, limit: null, absorbing: f.mode === "events" });
  const ph = {}, dp = {};
  for (const c of cs) { ph[c.phase] = (ph[c.phase] ?? 0) + 1; dp[c.depth] = (dp[c.depth] ?? 0) + 1; }
  const sha = createHash("sha256")
    .update(cs.map(c => `${c.cont}|${c.phase}|${c.depth}`).sort().join("\n")).digest("hex").slice(0, 16);
  const label = `conformance search ${f.seed} d${f.depth} ${f.mode}`;
  ok(`${label}: count ${f.count}`, cs.length === f.count);
  ok(`${label}: phase histogram`, JSON.stringify(ph) === JSON.stringify(Object.fromEntries(Object.entries(ph).map(([k]) => [k, f.phase[k]]))) && Object.keys(ph).every(k => ph[k] === f.phase[k]));
  ok(`${label}: depth histogram`, Object.keys(dp).every(k => dp[k] === f.byDepth[k]) && Object.keys(dp).length === Object.keys(f.byDepth).length);
  ok(`${label}: closure-set sha256 ${f.sha256}`, sha === f.sha256);
}

for (const [qc, want] of Object.entries(FIXTURES.solve)) {
  const r = solvePosition(qc);
  const label = `conformance solve ${qc}`;
  if (want.solved) {
    ok(`${label}: cont ${want.cont || "(closed)"}`, r.solved && r.cont === want.cont && r.history === want.history);
    ok(`${label}: depth/phase/excursion`, r.depth === want.depth && r.phase === want.phase && r.peakExcursion === want.peak_excursion);
    ok(`${label}: arrangements/considered/searched`,
       r.arrangements === want.arrangements && r.considered === want.considered && r.searchedDepth === want.searched_depth);
    if (want.already_closed) ok(`${label}: already-closed`, r.alreadyClosed === true);
  } else {
    ok(`${label}: miss`, r.solved === false && r.reason === want.reason);
    ok(`${label}: residual/floor/completion`,
       JSON.stringify(r.residual) === JSON.stringify(want.residual)
       && r.floorDepth === want.floor_depth && r.completion === want.completion);
  }
}

console.log(failed === 0 ? "\nqucalc-search: all passed" : `\nqucalc-search: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
