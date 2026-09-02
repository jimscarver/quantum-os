// qucalc-search.ts — "what closes next" from a QuCalc position, computed locally.
//
// **#119: quantum-os runs no service for this.** `/search` and `/solve` were a
// thin client over a Render-hosted Python service (`qucalc_search.py`); they now
// compute in the browser, reusing the ZFA primitives the app already has. The
// enumeration is cheap (`qucalc-enum.ts`), and every peer computing the same
// answer from the same algebra is a *stronger* "meeting of minds" than a shared
// service — the `/solve` determinism no longer depends on a service being up and
// honest. No endpoint, no HTTP, no contract-version pin.
//
// This module is the async front door: it runs the enumerator in a Web Worker
// (`qucalc-worker.ts`) so a depth-7 sweep does not hitch the UI, and falls back
// to running it inline where `Worker` is unavailable (Node, tests). The public
// shapes — `qucalcSearch` as an async generator yielding `Closure` and
// returning `SearchDone` — are unchanged from the HTTP-client era so `app.ts`
// barely moved.

import {
  runSearch, solvePosition,
  DEFAULT_MAX_DEPTH, DEFAULT_LIMIT, MAX_DEPTH_CAP, MAX_LIMIT_CAP,
  type Closure, type SearchMode, type Phase, type SearchReport, type SolveResult,
} from "./qucalc-enum.js";

export type { Closure, SearchMode, Phase, SolveResult } from "./qucalc-enum.js";
export {
  DEFAULT_MAX_DEPTH, DEFAULT_LIMIT, MAX_DEPTH_CAP, MAX_LIMIT_CAP,
  MIN_ZFA_LENGTH, TWIST_ORDER, maxExcursion, actionOf, residualToTwists,
} from "./qucalc-enum.js";

/** The `_done` rollup that ends a search. Alias of the enumerator's report. */
export type SearchDone = SearchReport;

export interface SearchOpts {
  /** Max appended twists (clamped to `MAX_DEPTH_CAP`). */
  maxDepth?: number;
  /** Stop after this many closures (clamped to `MAX_LIMIT_CAP`); `null` = no limit. */
  limit?: number | null;
  /** `possibilities` (every closure) or `events` (first closure per branch). */
  mode?: SearchMode;
  /** Rollup spec, e.g. `"phase,depth,capacity:2,capacity:3,head:20"`. */
  listeners?: string;
  /** Abort the run (terminates the worker). */
  signal?: AbortSignal;
}

// --------------------------------------------------------------------------- //
// worker plumbing

type WorkerFactory = () => Worker;

let makeWorker: WorkerFactory | null = null;
try {
  if (typeof Worker !== "undefined") {
    makeWorker = () =>
      new Worker(new URL("./qucalc-worker.ts", import.meta.url), { type: "module" });
  }
} catch {
  makeWorker = null;
}

let nextId = 1;

interface SearchRequest {
  kind: "search";
  seeds: string[];
  opts: { maxDepth?: number; limit?: number | null; mode?: SearchMode; listeners?: string; minTotalLen?: number };
}
interface SolveRequest {
  kind: "solve";
  qc: string;
  opts: { maxDepth?: number; minTotalLen?: number };
  shortlist?: boolean;
}

/** Run one request on a fresh worker, streaming `onBatch` and resolving with the
 *  terminal message. Rejects on worker error or abort. */
function runOnWorker(
  req: SearchRequest | SolveRequest,
  onBatch: ((cs: Closure[]) => void) | null,
  signal?: AbortSignal,
): Promise<{ done?: SearchReport; result?: SolveResult }> {
  return new Promise((resolve, reject) => {
    const w = makeWorker!();
    const id = nextId++;
    const cleanup = () => {
      w.terminate();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => { cleanup(); reject(new DOMException("aborted", "AbortError")); };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);

    w.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      if (m.id !== id) return;
      if (m.error) { cleanup(); reject(new Error(m.error)); return; }
      if (m.batch) { onBatch?.(m.batch as Closure[]); return; }
      if (m.done) { cleanup(); resolve({ done: m.done as SearchReport }); return; }
      if (m.result !== undefined) {
        cleanup();
        resolve({ result: m.result as SolveResult });
      }
    };
    w.onerror = (e) => { cleanup(); reject(new Error(e.message || "qucalc worker crashed")); };
    w.postMessage({ id, ...req });
  });
}

// --------------------------------------------------------------------------- //
// public API

/**
 * Enumerate the admissible next closures from a QuCalc position.
 *
 * `qc` may be a single history or an array — an array is a concurrent search
 * over several seeds (peers' positions) with the listeners aggregating across
 * all of them and each `Closure` carrying its `qc`.
 *
 * Yields `Closure` objects shortest-first; returns the final `SearchDone`.
 */
export async function* qucalcSearch(
  qc: string | string[],
  opts: SearchOpts = {},
): AsyncGenerator<Closure, SearchDone> {
  const seeds = Array.isArray(qc) ? qc : [qc];
  if (!seeds.length || seeds.some(s => !s)) {
    throw new Error("qucalcSearch: no position to search from");
  }
  const maxDepth = clamp(opts.maxDepth ?? DEFAULT_MAX_DEPTH, 1, MAX_DEPTH_CAP);
  const limit = opts.limit === undefined
    ? DEFAULT_LIMIT
    : opts.limit === null ? null : clamp(opts.limit, 1, MAX_LIMIT_CAP);
  const runOpts = { maxDepth, limit, mode: opts.mode ?? "possibilities", listeners: opts.listeners ?? "" };

  if (!makeWorker) {
    // Inline fallback — blocks, but only where there is no Worker (Node/tests).
    const gen = runSearch(seeds, runOpts);
    let step = gen.next();
    while (!step.done) {
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
      yield step.value;
      step = gen.next();
    }
    return step.value;
  }

  // Worker path: buffer batches into a queue the generator drains.
  const queue: Closure[] = [];
  let done: SearchReport | null = null;
  let err: unknown = null;
  let wake: (() => void) | null = null;
  const bump = () => { wake?.(); wake = null; };

  const p = runOnWorker({ kind: "search", seeds, opts: runOpts }, (cs) => { queue.push(...cs); bump(); }, opts.signal)
    .then(r => { done = r.done!; })
    .catch(e => { err = e; })
    .finally(bump);

  for (;;) {
    while (queue.length) yield queue.shift()!;
    if (err) throw err;
    if (done) { await p; return done; }
    await new Promise<void>(r => { wake = r; });
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** The one closure the substrate takes from `qc` — least free action — or the
 *  residual a completion still owes. Deterministic, so every peer agrees.
 *  `withShortlist` also returns the ranked runners-up on `result.shortlist`. */
export async function qucalcSolve(
  qc: string,
  opts: { maxDepth?: number; withShortlist?: boolean; signal?: AbortSignal } = {},
): Promise<SolveResult> {
  const runOpts = { maxDepth: clamp(opts.maxDepth ?? MAX_DEPTH_CAP, 1, MAX_DEPTH_CAP) };
  if (!makeWorker) {
    return solvePosition(qc, { ...runOpts, withShortlist: opts.withShortlist });
  }
  const r = await runOnWorker(
    { kind: "solve", qc, opts: runOpts, shortlist: opts.withShortlist }, null, opts.signal);
  return r.result!;
}
