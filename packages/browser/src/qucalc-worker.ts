// qucalc-worker.ts — runs the local closure enumerator off the main thread.
//
// #119: `/search` and `/solve` compute in the browser now, and a depth-7 sweep
// is ~2 M odometer steps — a few hundred ms. That is a visible hitch during a
// live call, so the enumeration runs here and streams results back by
// postMessage. The worker touches no DOM and no WASM (the Pauli fold in
// `qucalc-enum` → `zfa` is pure TS), so it is a clean compute island.
//
// Protocol (see qucalc-search.ts for the client half):
//   in : { id, kind: "search", seeds, opts }
//        { id, kind: "solve",  qc, opts, shortlist? }
//   out: { id, batch: Closure[] }            — search, repeated
//        { id, done: SearchReport }          — search, last
//        { id, result: SolveResult, shortlist?: Closure[] }  — solve
//        { id, error: string }               — either

import {
  runSearch, solvePosition,
  type RunSearchOpts, type SearchMode,
} from "./qucalc-enum.js";

interface SearchMsg {
  id: number;
  kind: "search";
  seeds: string[];
  opts: RunSearchOpts;
}
interface SolveMsg {
  id: number;
  kind: "solve";
  qc: string;
  opts: { maxDepth?: number; minTotalLen?: number };
  shortlist?: boolean;
}
type InMsg = SearchMsg | SolveMsg;

const BATCH = 512;

self.onmessage = (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  try {
    if (msg.kind === "search") {
      const gen = runSearch(msg.seeds, msg.opts);
      let batch: unknown[] = [];
      let step = gen.next();
      while (!step.done) {
        batch.push(step.value);
        if (batch.length >= BATCH) {
          (self as unknown as Worker).postMessage({ id: msg.id, batch });
          batch = [];
        }
        step = gen.next();
      }
      if (batch.length) (self as unknown as Worker).postMessage({ id: msg.id, batch });
      (self as unknown as Worker).postMessage({ id: msg.id, done: step.value });
    } else {
      const result = solvePosition(msg.qc, { ...msg.opts, withShortlist: msg.shortlist });
      (self as unknown as Worker).postMessage({ id: msg.id, result });
    }
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: msg.id, error: (e as Error)?.message ?? String(e) });
  }
};

export type { SearchMode };
