// qucalc-enum.ts — the local "what closes next" enumerator.
//
// Ported from quantum-logical-framework/qucalc_search.py (7046c55). Given a
// QuCalc position `qc` (a twist history) it enumerates the admissible
// **continuations** — twist words you can append so the whole history is a ZFA
// closure (count-balanced ∧ Pauli-closed) — shortest first.
//
// **#119: quantum-os runs no service for this.** The enumeration is cheap — a
// depth-6 continuation search is ~260k raw candidates, count-prefiltered to a
// few thousand before any Pauli fold ever runs — and every peer computes the
// same answer from the same algebra, which is a *stronger* "meeting of minds"
// than a shared service could give: the `/solve` determinism no longer depends
// on a service being up and honest. "No server, no trust, just algebra."
//
// **The count-balance gate here is QLF's, not quantum-os's.** It is the signed
// action vector vanishing (`#^=#v ∧ #>=#< ∧ #/=#\ ∧ #+=#−`), which is what
// `qucalc_search.py` enforces — NOT the weaker aggregate `count_pos ==
// count_neg` that `achievesZfa` accepts (`achievesZfa` would admit `^^<<`,
// which the Python rejects — see the zfa.ts header note). Matching the Python
// exactly is the whole point of a port.
//
// The search is the experiment, not a lookup: all admissible histories exist a
// priori as possibility; the enumeration asks the substrate which of them close
// from *here* (QucalcSearch.md § "What search and solve are"). `mode: "events"`
// makes that literal — a closure IS an event, so each branch is reported only
// at its first closure.

import { pauliScalarOf, type PauliScalar } from "./zfa.js";

export type Phase = PauliScalar;
export type SearchMode = "possibilities" | "events";

/** twist_core.TWISTS order — the enumeration emits in this order, and the
 *  `head` listener, `--full` stream, and the lexicographic `/solve` tie-break
 *  all read it. */
export const TWIST_ORDER = ["^", "v", "<", ">", "/", "\\", "+", "-"] as const;

export const MIN_ZFA_LENGTH = 4;
export const MAX_DEPTH_CAP = 7;
export const MAX_LIMIT_CAP = 100_000;
export const DEFAULT_MAX_DEPTH = 6;
export const DEFAULT_LIMIT = 10_000;
/** `/solve` caps the event set it ranks — the winner is always shallow. */
export const SOLVE_CONSIDER = 5_000;

const VALID = new Set<string>(TWIST_ORDER);

// app.ts / zfa.ts byte encoding: ^=0 v=1 >=2 <=3 /=4 \=5 +=6 -=7
const CHAR_TO_BYTE: Record<string, number> = { "^": 0, v: 1, ">": 2, "<": 3, "/": 4, "\\": 5, "+": 6, "-": 7 };
// TWIST_ORDER digit → zfa.ts byte
const DIGIT_TO_BYTE = TWIST_ORDER.map(c => CHAR_TO_BYTE[c]);

export function validateHistory(qc: string): void {
  if (!qc || typeof qc !== "string") throw new Error("history must be a non-empty string");
  for (const ch of qc) {
    if (!VALID.has(ch)) throw new Error(`invalid twist character '${ch}' (allowed: ${TWIST_ORDER.join(" ")})`);
  }
}

/** Signed action vector `(v, h, d, l) = (#^-#v, #>-#<, #/-#\, #+-#-)`.
 *  Mirrors `calculate_action` in twist_core.py, component order included. */
export function actionOf(hist: string): [number, number, number, number] {
  let v = 0, h = 0, d = 0, l = 0;
  for (const ch of hist) {
    switch (ch) {
      case "^": v++; break; case "v": v--; break;
      case ">": h++; break; case "<": h--; break;
      case "/": d++; break; case "\\": d--; break;
      case "+": l++; break; case "-": l--; break;
    }
  }
  return [v, h, d, l];
}

/** Can `depth` appended twists realise the action vector `need` at all?
 *  `depth ≥ Σ|need_i|` and `depth ≡ Σ|need_i| (mod 2)` — see `_feasible`. */
export function feasible(need: readonly number[], depth: number): boolean {
  const s = need.reduce((a, x) => a + Math.abs(x), 0);
  return depth >= s && (depth - s) % 2 === 0;
}

/** Max over prefixes of the total free action `|v|+|h|+|d|+|l|` — how far the
 *  walk strays from ZFA balance. A capacity-`R` horizon hears a closure iff this
 *  is `≤ R` (`QLF_ClosureDepthLaw`). Mirrors `max_excursion` in qucalc_search.py
 *  (and `peakExcursion` in app.ts). */
export function maxExcursion(history: string): number {
  let v = 0, h = 0, d = 0, l = 0, m = 0;
  for (const t of history) {
    if (t === "^") v++; else if (t === "v") v--;
    else if (t === ">") h++; else if (t === "<") h--;
    else if (t === "/") d++; else if (t === "\\") d--;
    else if (t === "+") l++; else if (t === "-") l--;
    const e = Math.abs(v) + Math.abs(h) + Math.abs(d) + Math.abs(l);
    if (e > m) m = e;
  }
  return m;
}

/** One concrete continuation supplying exactly the residual action vector —
 *  count-balances the position (its twists may not fold to a Pauli scalar in
 *  that order). Mirrors `_residual_to_twists` / app.ts `residualToTwists`. */
export function residualToTwists(r: readonly number[]): string {
  const axes: Array<[string, string]> = [["^", "v"], [">", "<"], ["/", "\\"], ["+", "-"]];
  let s = "";
  for (let i = 0; i < 4; i++) s += (r[i] >= 0 ? axes[i][0] : axes[i][1]).repeat(Math.abs(r[i]));
  return s;
}

function binomialC(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}
/** `C(2n, n)` — the ZFA arrangement count at half-length `n`. */
export function zfaArrangements(len: number): number {
  return binomialC(len, Math.floor(len / 2));
}

// --------------------------------------------------------------------------- //

/** One admissible next closure. */
export interface Closure {
  /** The twist word appended to `qc`. */
  cont: string;
  /** The full closed history (`qc + cont`). */
  history: string;
  len: number;
  /** Appended twist count. */
  depth: number;
  /** The Pauli scalar the whole history folds to. */
  phase: Phase;
  /** Which seed this closure came from — set only on a concurrent search. */
  qc?: string;
}

export interface EnumOpts {
  maxDepth?: number;
  /** `null` = no limit. */
  limit?: number | null;
  minTotalLen?: number;
  /** `true` = events (first closure per branch); `false` = possibilities. */
  absorbing?: boolean;
}

/**
 * Yield ZFA closures reachable from `qc` by appending 1..`maxDepth` twists,
 * shortest continuations first. Faithful port of `qucalc_search.py:search`.
 *
 * The count-balance constraint (signed action vector = `need`) is applied to
 * the continuation tuple *before* any string is built or Pauli fold is run — the
 * fold only touches the small fraction of candidates that already balance.
 */
export function* enumerateClosures(qc: string, opts: EnumOpts = {}): Generator<Closure> {
  validateHistory(qc);
  const maxDepth = Math.max(1, opts.maxDepth ?? DEFAULT_MAX_DEPTH);
  const limit = opts.limit === undefined ? DEFAULT_LIMIT : opts.limit;
  const minTotalLen = opts.minTotalLen ?? MIN_ZFA_LENGTH;
  const absorbing = !!opts.absorbing;

  const seedAction = actionOf(qc);
  const need: [number, number, number, number] = [-seedAction[0], -seedAction[1], -seedAction[2], -seedAction[3]];
  const need0 = need[0], need1 = need[1], need2 = need[2], need3 = need[3];

  const seedBytes = new Uint8Array([...qc].map(c => CHAR_TO_BYTE[c]));
  let nFound = 0;
  const closedPrefixes = new Set<string>();

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (!feasible(need, depth)) continue;
    if (qc.length + depth < minTotalLen) continue;

    // Odometer over TWIST_ORDER digits (rightmost fastest), with digit counts
    // `cnt` and the zfa.ts-byte continuation `contBytes` kept in sync so the
    // action test and the fold input are both O(1)-updated per step.
    const idx = new Uint8Array(depth);          // all 0 = all "^"
    const cnt = new Int32Array(8);
    cnt[0] = depth;
    const contBytes = new Uint8Array(depth);    // digit 0 → byte 0, already zero
    const full = new Uint8Array(seedBytes.length + depth);
    full.set(seedBytes);
    const prefixLo = Math.max(1, minTotalLen - qc.length);

    for (;;) {
      if (cnt[0] - cnt[1] === need0 && cnt[3] - cnt[2] === need1
        && cnt[4] - cnt[5] === need2 && cnt[6] - cnt[7] === need3) {
        let cont = "";
        for (let i = 0; i < depth; i++) cont += TWIST_ORDER[idx[i]];

        let suppressed = false;
        if (absorbing) {
          for (let k = prefixLo; k < depth; k++) {
            if (closedPrefixes.has(cont.slice(0, k))) { suppressed = true; break; }
          }
        }
        if (!suppressed) {
          full.set(contBytes, seedBytes.length);
          const phase = pauliScalarOf(full);
          if (phase !== null) {
            if (absorbing) closedPrefixes.add(cont);
            const history = qc + cont;
            yield { cont, history, len: history.length, depth, phase };
            nFound++;
            if (limit != null && nFound >= limit) return;
          }
        }
      }

      // increment odometer, maintaining cnt + contBytes
      let p = depth - 1;
      for (; p >= 0; p--) {
        cnt[idx[p]]--;
        if (idx[p] === 7) {
          idx[p] = 0; cnt[0]++; contBytes[p] = DIGIT_TO_BYTE[0];
        } else {
          idx[p]++; cnt[idx[p]]++; contBytes[p] = DIGIT_TO_BYTE[idx[p]];
          break;
        }
      }
      if (p < 0) break;
    }
  }
}

// --------------------------------------------------------------------------- //
// listeners — one enumeration, several rollups reporting in parallel
// --------------------------------------------------------------------------- //

interface Listener {
  name: string;
  feed(c: Closure): void;
  report(): unknown;
}

function makeListeners(spec: string): Listener[] {
  const out: Listener[] = [{
    name: "count",
    n: 0,
    feed() { (this as any).n++; },
    report() { return { total: (this as any).n }; },
  } as any];

  for (const raw of (spec || "").split(",")) {
    const tok = raw.trim();
    if (!tok) continue;
    const [kind, arg] = tok.split(":");
    if (kind === "count") continue;
    if (kind === "phase") {
      out.push({
        name: "phase",
        c: { "+1": 0, "-1": 0, "+i": 0, "-i": 0 } as Record<string, number>,
        feed(c: Closure) { (this as any).c[c.phase]++; },
        report() { return { ...(this as any).c }; },
      } as any);
    } else if (kind === "depth") {
      out.push({
        name: "depth",
        c: {} as Record<number, number>,
        feed(c: Closure) { const m = (this as any).c; m[c.depth] = (m[c.depth] ?? 0) + 1; },
        report() {
          const m = (this as any).c as Record<number, number>;
          const o: Record<string, number> = {};
          for (const k of Object.keys(m).map(Number).sort((a, b) => a - b)) o[k] = m[k];
          return o;
        },
      } as any);
    } else if (kind === "capacity") {
      const r = Math.max(0, parseInt(arg || "0", 10) || 0);
      out.push({
        name: `capacity:${r}`,
        r, heard: 0, missed: 0,
        feed(c: Closure) {
          if (maxExcursion(c.history) <= (this as any).r) (this as any).heard++;
          else (this as any).missed++;
        },
        report() { return { R: (this as any).r, heard: (this as any).heard, missed: (this as any).missed }; },
      } as any);
    } else if (kind === "head") {
      const n = Math.max(1, parseInt(arg || "10", 10) || 10);
      out.push({
        name: "head",
        n, items: [] as string[],
        feed(c: Closure) { if ((this as any).items.length < (this as any).n) (this as any).items.push(c.cont); },
        report() { return { n: (this as any).n, conts: (this as any).items }; },
      } as any);
    } else {
      throw new Error(`unknown listener '${tok}' (phase|depth|capacity:R|head:N)`);
    }
  }
  return out;
}

export interface SearchReport {
  seeds: string[];
  maxDepth: number;
  mode: SearchMode;
  found: number;
  truncated: boolean;
  elapsedS: number;
  /** Per-seed closure counts on a concurrent search, else `null`. */
  perSeed: Record<string, number> | null;
  /** Listener reports, keyed by name (`count` is always present). */
  listeners: Record<string, unknown>;
}

export interface RunSearchOpts {
  maxDepth?: number;
  limit?: number | null;
  mode?: SearchMode;
  listeners?: string;
  minTotalLen?: number;
}

/**
 * Run `enumerateClosures` over one or more seeds, feeding every listener.
 * Yields each `Closure` (with `qc` set when there is more than one seed) and
 * returns the assembled `SearchReport`. Mirrors `qucalc_search.py:run_search` —
 * `limit` is the total across all seeds; seeds run in sequence; the listeners
 * aggregate across all of them (the "concurrent search, one set of listeners"
 * shape).
 */
export function* runSearch(
  seeds: string[],
  opts: RunSearchOpts = {},
): Generator<Closure, SearchReport> {
  const t0 = Date.now();
  const maxDepth = Math.max(1, Math.min(opts.maxDepth ?? DEFAULT_MAX_DEPTH, MAX_DEPTH_CAP));
  const limit = opts.limit === undefined ? DEFAULT_LIMIT : opts.limit;
  const absorbing = (opts.mode ?? "possibilities") === "events";
  const listeners = makeListeners(opts.listeners ?? "");
  const multi = seeds.length > 1;

  let n = 0;
  const perSeed: Record<string, number> = {};
  for (const qc of seeds) {
    let seedN = 0;
    const remaining = limit == null ? null : Math.max(0, limit - n);
    if (remaining === 0) { perSeed[qc] = 0; continue; }
    for (const rec of enumerateClosures(qc, {
      maxDepth, limit: remaining, minTotalLen: opts.minTotalLen, absorbing,
    })) {
      const out = multi ? { ...rec, qc } : rec;
      for (const L of listeners) L.feed(out);
      yield out;
      n++; seedN++;
    }
    perSeed[qc] = seedN;
  }

  const report: Record<string, unknown> = {};
  for (const L of listeners) report[L.name] = L.report();
  return {
    seeds,
    maxDepth,
    mode: absorbing ? "events" : "possibilities",
    found: n,
    truncated: limit != null && n >= limit,
    elapsedS: Math.round((Date.now() - t0)) / 1000,
    perSeed: multi ? perSeed : null,
    listeners: report,
  };
}

// --------------------------------------------------------------------------- //
// solve — the complement of search: the one closure the substrate takes
// --------------------------------------------------------------------------- //

const PHASE_RANK: Record<Phase, number> = { "+1": 0, "-1": 1, "+i": 2, "-i": 3 };

export interface SolveWin {
  solved: true;
  qc: string;
  alreadyClosed: boolean;
  cont: string;
  history: string;
  depth: number;
  phase: Phase;
  peakExcursion: number;
  arrangements: number;
  considered: number;
  truncated: boolean;
  searchedDepth: number;
}

export interface SolveMiss {
  solved: false;
  qc: string;
  residual: [number, number, number, number];
  floorDepth: number;
  searchedDepth: number;
  reason: "beyond max_depth" | "no short event";
  completion: string | null;
}

export type SolveResult = (SolveWin | SolveMiss) & {
  /** The ranked shortlist — present only when `withShortlist` was set (`/solve --all`). */
  shortlist?: Closure[];
};

function rankEvents(events: Closure[]): void {
  events.sort((a, b) =>
    maxExcursion(a.history) - maxExcursion(b.history)
    || a.depth - b.depth
    || PHASE_RANK[a.phase] - PHASE_RANK[b.phase]
    || (a.history < b.history ? -1 : a.history > b.history ? 1 : 0));
}

/**
 * Pick the one closure the substrate takes from `qc` — **least free action** —
 * or report the residual a completion still owes. Faithful port of
 * `qucalc_search.py:solve`.
 *
 * Deterministic cascade, so independent peers agree without coordinating:
 *
 *     least peak excursion → shortest depth → phase +1 → lexicographic
 *
 * Depth strategy: the natural closure depths are `floor` and `floor + 2`
 * (parity), `floor = Σ|residual|`; search there first, only pay for the full
 * `maxDepth` sweep if that misses.
 */
export function solvePosition(
  qc: string,
  opts: { maxDepth?: number; minTotalLen?: number; withShortlist?: boolean } = {},
): SolveResult {
  validateHistory(qc);
  const minTotalLen = opts.minTotalLen ?? MIN_ZFA_LENGTH;
  const maxDepth = Math.max(1, Math.min(opts.maxDepth ?? MAX_DEPTH_CAP, MAX_DEPTH_CAP));

  const seedAction = actionOf(qc);
  const residual: [number, number, number, number] =
    [-seedAction[0], -seedAction[1], -seedAction[2], -seedAction[3]];
  const floor = residual.reduce((a, x) => a + Math.abs(x), 0);

  if (seedAction.every(x => x === 0) && qc.length >= minTotalLen) {
    const phase = pauliScalarOf(new Uint8Array([...qc].map(c => CHAR_TO_BYTE[c])));
    if (phase !== null) {
      return {
        solved: true, qc, alreadyClosed: true,
        cont: "", history: qc, depth: 0, phase,
        peakExcursion: maxExcursion(qc),
        arrangements: zfaArrangements(qc.length),
        considered: 0, truncated: false, searchedDepth: 0,
      };
    }
  }

  const first = Math.min(Math.max(floor + 2, 2), maxDepth);
  const tries = first < maxDepth ? [first, maxDepth] : [maxDepth];
  let events: Closure[] = [];
  let searched = 0;
  for (const w of tries) {
    searched = w;
    events = [...enumerateClosures(qc, { maxDepth: w, limit: SOLVE_CONSIDER, minTotalLen, absorbing: true })];
    if (events.length) break;
  }

  if (!events.length) {
    const completion = residualToTwists(residual);
    return {
      solved: false, qc, residual, floorDepth: floor, searchedDepth: searched,
      reason: floor > searched ? "beyond max_depth" : "no short event",
      completion: completion || null,
    };
  }

  rankEvents(events);
  const best = events[0];
  return {
    solved: true, qc, alreadyClosed: false,
    cont: best.cont, history: best.history, depth: best.depth, phase: best.phase,
    peakExcursion: maxExcursion(best.history),
    arrangements: zfaArrangements(best.len),
    considered: events.length,
    truncated: events.length >= SOLVE_CONSIDER,
    searchedDepth: searched,
    ...(opts.withShortlist ? { shortlist: events } : {}),
  };
}
