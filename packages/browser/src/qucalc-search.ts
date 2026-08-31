// qucalc-search.ts — consume the QLF QuCalc Search service from a browser peer.
//
// The service (quantum-logical-framework/qucalc_search.py) answers one question
// over the QLF substrate:
//
//   From this QuCalc position, what are the admissible next closures?
//
// Given a twist history `qc` it enumerates the continuations — twist words you
// can append so the whole history is a ZFA closure (count-balanced ∧
// Pauli-closed) — shortest first, and streams them as NDJSON.
//
// The search is the experiment, not a lookup. All admissible histories exist a
// priori as possibility; the enumeration asks the substrate which of them close
// from here (QucalcSearch.md § "What the search is"). `mode: "events"` makes
// that literal — a closure IS an event, so each branch is reported only at its
// first closure.
//
// The service is read-only, stateless and CORS-open, and holds no room state —
// it is a pure function of twist_core.py. Nothing here is signed: there is
// nothing to attribute and nothing to trust beyond the substrate itself.
//
// Contract: the service stamps every stream with a `version` on its `_meta`
// line. CONTRACT_VERSION below is what this client was written against; a
// mismatch throws loudly rather than reshaping the data silently (qos#117).

export const CONTRACT_VERSION = "1.0";

const CONFIG_KEY = "qos-qucalc-config";

export interface QucalcSearchConfig {
  /** Base URL of the deployed qucalc_search service, e.g. `https://host:8765`.
   *  Empty until set with `/search url <endpoint>` — there is no default host. */
  url: string;
}

export const DEFAULT_SEARCH_CONFIG: QucalcSearchConfig = { url: "" };

export function loadSearchConfig(): QucalcSearchConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_SEARCH_CONFIG };
    return { ...DEFAULT_SEARCH_CONFIG, ...(JSON.parse(raw) as Partial<QucalcSearchConfig>) };
  } catch {
    return { ...DEFAULT_SEARCH_CONFIG };
  }
}

export function saveSearchConfig(cfg: QucalcSearchConfig): void {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch { /* private mode */ }
}

// --------------------------------------------------------------------------- //

export type Phase = "+1" | "-1" | "+i" | "-i";
export type SearchMode = "possibilities" | "events";

/** One admissible next closure. */
export interface Closure {
  /** The twist word appended to `qc`. */
  cont: string;
  /** The full closed history (`qc + cont`). */
  history: string;
  len: number;
  /** Appended twist count. */
  depth: number;
  /** The Pauli scalar the whole history folds to (always ±1 for a balanced seed). */
  phase: Phase;
  /** Which seed this closure came from — present only on a concurrent search. */
  qc?: string;
}

/** The `_done` rollup that ends every stream. */
export interface SearchDone {
  found: number;
  elapsedS: number;
  /** Did the enumeration hit `limit` before exhausting the depth? */
  truncated: boolean;
  mode: SearchMode;
  seeds: string[];
  /** Per-seed closure counts on a concurrent search, else null. */
  perSeed: Record<string, number> | null;
  /** Listener reports, keyed by listener name (`count` is always present). */
  listeners: Record<string, unknown>;
}

export interface SearchOpts {
  /** Max appended twists (service clamps to its `--max-depth-cap`). */
  maxDepth?: number;
  /** Stop after this many closures (service clamps to 100 000). */
  limit?: number;
  /** `possibilities` (every closure) or `events` (first closure per branch). */
  mode?: SearchMode;
  /** Rollup spec, e.g. `"phase,depth,capacity:2,capacity:3,head:20"`. */
  listeners?: string;
  /** `false` suppresses the per-closure lines — only the `_done` rollup comes back. */
  stream?: boolean;
  signal?: AbortSignal;
}

/** Thrown when the service's contract version is not the one this client expects. */
export class QucalcContractMismatch extends Error {
  constructor(public serviceVersion: string) {
    super(
      `qucalc_search contract is "${serviceVersion}", this client expects "${CONTRACT_VERSION}" — ` +
      `a substrate change may have reshaped the data; update packages/browser/src/qucalc-search.ts ` +
      `before trusting the results`,
    );
    this.name = "QucalcContractMismatch";
  }
}

/**
 * Stream the admissible next closures from a QuCalc position.
 *
 * `qc` may be a single history or an array — an array is a concurrent search
 * over several seeds (peers' individual positions), with the listeners
 * aggregating across all of them and each `Closure` carrying its `qc`.
 *
 * Yields `Closure` objects shortest-first; returns the final `SearchDone`.
 * Aborting the `signal` (or `.return()`ing the generator) closes the socket and
 * the service stops enumerating.
 */
export async function* qucalcSearch(
  base: string,
  qc: string | string[],
  opts: SearchOpts = {},
): AsyncGenerator<Closure, SearchDone> {
  if (!base) {
    throw new Error("no qucalc_search endpoint — set one with /search url <endpoint>");
  }
  const u = new URL("/search", base);
  u.searchParams.set("qc", Array.isArray(qc) ? qc.join(",") : qc);
  if (opts.maxDepth != null) u.searchParams.set("max_depth", String(opts.maxDepth));
  if (opts.limit != null) u.searchParams.set("limit", String(opts.limit));
  if (opts.mode) u.searchParams.set("mode", opts.mode);
  if (opts.listeners) u.searchParams.set("listeners", opts.listeners);
  if (opts.stream === false) u.searchParams.set("stream", "0");

  let res: Response;
  try {
    res = await fetch(u, { signal: opts.signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new Error(`qucalc_search unreachable at ${base} — ${(e as Error)?.message ?? e}`);
  }
  if (!res.ok) {
    let msg = String(res.status);
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not JSON */ }
    throw new Error(`qucalc_search ${res.status}: ${msg}`);
  }
  if (!res.body) throw new Error("qucalc_search: response had no body to stream");

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let sawMeta = false;
  let done: SearchDone | null = null;
  try {
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj._meta) {
          sawMeta = true;
          if (obj.version !== CONTRACT_VERSION) {
            throw new QucalcContractMismatch(String(obj.version));
          }
          continue;
        }
        if (obj._done) {
          done = {
            found: (obj.found as number) ?? 0,
            elapsedS: (obj.elapsed_s as number) ?? 0,
            truncated: !!obj.truncated,
            mode: (obj.mode as SearchMode) ?? "possibilities",
            seeds: (obj.seeds as string[]) ?? [],
            perSeed: (obj.per_seed as Record<string, number> | null) ?? null,
            listeners: (obj.listeners as Record<string, unknown>) ?? {},
          };
          continue;
        }
        yield obj as unknown as Closure;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  if (!sawMeta) {
    throw new Error("qucalc_search: stream ended before the _meta line — is this the search service?");
  }
  if (!done) {
    throw new Error("qucalc_search: stream ended before the _done line — response was truncated");
  }
  return done;
}

// --------------------------------------------------------------------------- //

export interface ServiceInfo {
  service: string;
  version: string;
  caps: { max_depth: number; max_limit: number };
  alphabet: string[];
  listeners?: string[];
  /** Set by `qucalcSearchInfo` when the reported version is not CONTRACT_VERSION. */
  contractMismatch?: boolean;
}

/** Probe `GET /` — the service's version and per-deployment caps. */
export async function qucalcSearchInfo(base: string, signal?: AbortSignal): Promise<ServiceInfo> {
  if (!base) throw new Error("no qucalc_search endpoint — set one with /search url <endpoint>");
  let res: Response;
  try {
    res = await fetch(new URL("/", base), { signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new Error(`qucalc_search unreachable at ${base} — ${(e as Error)?.message ?? e}`);
  }
  if (!res.ok) throw new Error(`qucalc_search ${res.status}`);
  const info = (await res.json()) as ServiceInfo;
  info.contractMismatch = info.version !== CONTRACT_VERSION;
  return info;
}
