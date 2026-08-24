// rholang.ts — talk to an RChain node from the browser.
//
// Three verbs, and the difference between them is what the node does with your
// program:
//
//   status — ask the node what it is (version, shard, height, phlo floor).
//   eval   — run rholang and read the result back. Nothing is signed, nothing
//            is stored, no block is produced. This is `explore-deploy`.
//   deploy — sign a program and submit it. It costs phlo, it lands in a block,
//            and what it writes outlives every peer in the room.
//
// All three go over the node's HTTP API (`--api-host`, port 40403 by default),
// which sets permissive CORS, so the browser reaches it directly — no relay, no
// agent in the middle. The gRPC API (40402) is not reachable from a browser and
// is not used here.
//
// LIMIT OF `eval`: exploratory deploy runs against already-finalized state in a
// read-only sandbox, and the node's *system processes do not run there*. Pure
// rholang evaluates and returns values; `rho:qucalc:*`, `rho:gov:*`,
// `rho:registry:*` and `rho:rchain:*` all yield nothing. Reaching those means
// `deploy`. The node must also allow exploratory deploy at all: it answers only
// when run as a read-only observer or with `--dev-mode`.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

// ---------------------------------------------------------------------------
// Configuration — where the node is and how a deploy is charged
// ---------------------------------------------------------------------------

export interface NodeConfig {
  /** Base URL of the node's HTTP API. */
  url: string;
  /** Shard the deploy is valid in. A deploy for the wrong shard is rejected. */
  shard: string;
  phloLimit: number;
  phloPrice: number;
  /** secp256k1 deploy key, base16. Held here, never sent — only signatures are. */
  key?: string;
}

const CONFIG_KEY = "qos-rnode-config";

export const DEFAULT_CONFIG: NodeConfig = {
  url: "http://127.0.0.1:40403",
  shard: "root",
  phloLimit: 500_000,
  phloPrice: 1,
};

export function loadConfig(): NodeConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<NodeConfig>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: NodeConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

/** The config as display lines. The key is shown by its public half only. */
export function describeConfig(cfg: NodeConfig): string[] {
  const out = [
    `node   ${cfg.url}`,
    `shard  ${cfg.shard}`,
    `phlo   limit ${cfg.phloLimit}, price ${cfg.phloPrice}`,
  ];
  if (cfg.key) {
    try {
      out.push(`key    ${publicKeyOf(cfg.key).slice(0, 24)}…  (public half; the secret stays here)`);
      out.push(`addr   ${revAddressOf(cfg.key)}`);
    } catch {
      out.push("key    ✗ not a valid secp256k1 key");
    }
  } else {
    out.push("key    (none — /rholang key generate, or /rholang key <hex>)");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const unhex = (s: string): Uint8Array => {
  const t = s.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(t) || t.length % 2) throw new Error("not base16");
  return new Uint8Array((t.match(/../g) ?? []).map((p) => parseInt(p, 16)));
};

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = BASE58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = BASE58[0] + out; }
  return out;
}

export function generateKey(): string {
  return hex(secp256k1.utils.randomSecretKey());
}

/** The uncompressed (65-byte, `04…`) public key a deploy is attributed to. */
export function publicKeyOf(secretHex: string): string {
  return hex(secp256k1.getPublicKey(unhex(secretHex), false));
}

/**
 * The REV address a deploy is charged to, derived the way the node derives it
 * (rholang/src/util/rev_address.rs) so what is shown is what is charged:
 *
 *   eth     = last 20 bytes of keccak256(public key without its 0x04 prefix)
 *   payload = 00000000 ++ keccak256(eth)
 *   address = base58(payload ++ first 4 bytes of blake2b256(payload))
 */
export function revAddressOf(secretHex: string): string {
  const pub = secp256k1.getPublicKey(unhex(secretHex), false);
  const eth = hex(keccak_256(pub.slice(1))).slice(-40);
  const payload = new Uint8Array([0, 0, 0, 0, ...keccak_256(unhex(eth))]);
  const checksum = blake2b(payload, { dkLen: 32 }).slice(0, 4);
  return base58(new Uint8Array([...payload, ...checksum]));
}

// ---------------------------------------------------------------------------
// Protobuf encoding of DeployData
//
// The signature is over blake2b256 of the protobuf encoding of DeployDataProto
// (models/proto/casper.proto), so the bytes must match the node's exactly. proto3
// omits fields at their default value — a zero timestamp is an absent field, not
// a zero-valued one — and fields are written in ascending field number.
// ---------------------------------------------------------------------------

function varint(n: number): number[] {
  const out: number[] = [];
  let v = BigInt(n);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

function fieldVarint(field: number, value: number): number[] {
  if (value === 0) return []; // proto3 default — omitted
  return [...varint((field << 3) | 0), ...varint(value)];
}

function fieldString(field: number, value: string): number[] {
  if (!value) return []; // proto3 default — omitted
  const bytes = new TextEncoder().encode(value);
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
}

export interface DeployData {
  term: string;
  timestamp: number;
  phloPrice: number;
  phloLimit: number;
  validAfterBlockNumber: number;
  shardId: string;
}

/** DeployDataProto: term=2, timestamp=3, phloPrice=7, phloLimit=8, validAfterBlockNumber=10, shardId=11. */
export function encodeDeployData(d: DeployData): Uint8Array {
  return new Uint8Array([
    ...fieldString(2, d.term),
    ...fieldVarint(3, d.timestamp),
    ...fieldVarint(7, d.phloPrice),
    ...fieldVarint(8, d.phloLimit),
    ...fieldVarint(10, d.validAfterBlockNumber),
    ...fieldString(11, d.shardId),
  ]);
}

/** Sign deploy data the way the node verifies it: DER secp256k1 over blake2b256. */
export function signDeployData(d: DeployData, secretHex: string): { deployer: string; signature: string } {
  const digest = blake2b(encodeDeployData(d), { dkLen: 32 });
  const sig = secp256k1.sign(digest, unhex(secretHex), { prehash: false, format: "der" });
  return { deployer: publicKeyOf(secretHex), signature: hex(sig) };
}

// ---------------------------------------------------------------------------
// The powerbox, and the wrapper every program gets
//
// Two problems, one answer. A deploy's output goes to the node's log, which
// nobody running a browser can read; and the node's own capabilities are URNs
// that have to be `new`-bound before anything can be sent to them, which is a
// line of ceremony in front of every program.
//
// So every program is wrapped: `return` is in scope to report on, and so is
// every system process, under a short name. What you type is the body.
// ---------------------------------------------------------------------------

/**
 * The names a program gets for free, and what each one takes.
 *
 * `deployOnly` marks `deployerId`: an eval has no deployer, and merely binding
 * it there fails to normalize ("No value set for rho:rchain:deployerId").
 *
 * The shapes here were read off the node's own argument parsers, not its docs —
 * `docs/src/qucalc/extensions.md` documents `trustLevels` ratings and `censure`
 * censures/vouchers as nested maps, and the node rejects those: it wants tuple
 * lists (`parse_rating_list`, `parse_censure_list`, and `parse_voucher_list`,
 * which is `parse_rating_list` again). Verified against a running node.
 */
interface PowerboxEntry {
  name: string;
  urn: string;
  /** How it is called, with the return channel where the node expects it. */
  sig: string;
  /** What arrives on that channel. */
  returns?: string;
  /** Argument shapes that are not obvious from the signature. */
  note?: string;
  deployOnly?: boolean;
}

const POWERBOX: PowerboxEntry[] = [
  { name: "stdout", urn: "rho:io:stdout", sig: "stdout!(value)",
    returns: "nothing — it prints to the node's log, which you cannot read from here" },
  { name: "stderr", urn: "rho:io:stderr", sig: "stderr!(value)",
    returns: "nothing — same" },

  { name: "zfa", urn: "rho:qucalc:zfa", sig: "zfa!(history, *return)",
    returns: "(isZfa, phase) — phase is +I=1, −I=-1, +iI=2, −iI=-2",
    note: "history is a list of twist values 0..7, or the equivalent string" },
  { name: "grant", urn: "rho:qucalc:grant", sig: "grant!(history, *return)",
    returns: "the minted capability uri, or Nil if the history is not ZFA-closed" },
  { name: "verify", urn: "rho:qucalc:verify", sig: "verify!(uri, *return)",
    returns: "Bool" },
  { name: "fuse", urn: "rho:qucalc:fuse", sig: "fuse!(subject, predicate, *return)",
    returns: "(geometry, cap), or Nil if the synthesis does not close" },

  { name: "resolveWeights", urn: "rho:gov:resolveWeights",
    sig: "resolveWeights!(directVoters, delegations, trust, *return)",
    returns: "map of voter → weight",
    note: "directVoters is a list of ids; delegations a map id → id; trust a map id → int" },
  { name: "trustLevels", urn: "rho:gov:trustLevels", sig: "trustLevels!(ratings, admins, *return)",
    returns: "map of member → level",
    note: "ratings is a LIST of (rater, ratee, level) tuples — not a map; admins a list of ids" },
  { name: "censure", urn: "rho:gov:censure", sig: "censure!(censures, levels, vouchers, *return)",
    returns: "(discredited, newLevels)",
    note: "censures is a list of (censor, target); levels a map member → int; vouchers a list of (voucher, vouchee, level)" },
  { name: "tally", urn: "rho:gov:tally", sig: "tally!(ballots, weights, mode, *return)",
    returns: "the winning option, or Nil when there are no ballots",
    note: "ballots is a map member → [ranked options]; weights a map member → int ({} = one each); mode \"ranked\" or \"approval\"" },

  { name: "lookup", urn: "rho:registry:lookup", sig: "lookup!(uri, *return)",
    returns: "(uri, value), or Nil when nothing is registered there" },
  { name: "insertArbitrary", urn: "rho:registry:insertArbitrary", sig: "insertArbitrary!(data, *return)",
    returns: "the uri the data was stored at — content-addressed and unforgeable" },

  { name: "revVault", urn: "rho:rchain:revVault", sig: "revVault!(method, [args…, *return])",
    returns: "per method",
    note: "the return channel goes INSIDE the list: getBalance [addr, ret] · transfer [from, to, amount, ret] · findOrCreate [addr, ret] · deposit [addr, amount, ret]" },
  { name: "revAddress", urn: "rho:rev:address", sig: "revAddress!(op, arg, *return)",
    returns: "the REV address as a string",
    note: "op is \"fromPublicKey\", \"fromDeployerId\" or \"fromUnforgeable\"" },
  { name: "blockData", urn: "rho:block:data", sig: "blockData!(*return)",
    returns: "blockNumber and sender, as two values: for (@n, @sender <- return)" },

  { name: "deployerId", urn: "rho:rchain:deployerId", sig: "*deployerId",
    returns: "not a channel — an unforgeable name identifying whoever signed this deploy",
    note: "use it as a value (*deployerId); deploy only, an eval has no deployer",
    deployOnly: true },
];

/** The names a program can use without declaring them. */
export function powerboxNames(mode: "eval" | "deploy"): string[] {
  return POWERBOX.filter((e) => mode === "deploy" || !e.deployOnly).map((e) => e.name);
}

/** The full spec, as display lines: how to call each name and what comes back. */
export function powerboxSpec(mode: "eval" | "deploy"): string[] {
  const out: string[] = [];
  for (const e of POWERBOX) {
    const skipped = e.deployOnly && mode !== "deploy";
    out.push(`${e.sig}${skipped ? "   (deploy only)" : ""}`);
    out.push(`    ${e.urn}`);
    if (e.returns) out.push(`    → ${e.returns}`);
    if (e.note) out.push(`    ${e.note}`);
  }
  return out;
}

/** A public name to read a deploy's results back from, unique per deploy. */
export function resultName(): string {
  return `qos-result-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Wrap a program body.
 *
 * eval reads its values straight off `return`, so `return` is left alone.
 *
 * A deploy cannot: its `return` is unforgeable and the deploy is long gone by
 * the time anyone asks. So the deploy wrapper adds a persistent forwarder that
 * copies everything sent to `return` onto a public name — readable afterwards by
 * anyone who knows it, including us a moment later — and to stdout for the log.
 * One receive doing both, because two would compete for the same values.
 */
export function wrapProgram(body: string, mode: "eval" | "deploy", forwardTo?: string): string {
  const decls = ["return", ...POWERBOX.filter((e) => mode === "deploy" || !e.deployOnly).map((e) => `${e.name}(\`${e.urn}\`)`)];
  const indented = body.split("\n").map((l) => (l.trim() ? "  " + l : l)).join("\n");
  const forwarder = forwardTo
    ? `\n  |\n  for (@__value <= return) { @${JSON.stringify(forwardTo)}!(__value) | stdout!(__value) }`
    : "";
  return `new ${decls.join(", ")} in {\n${indented}${forwarder}\n}`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const base = (cfg: NodeConfig): string => cfg.url.replace(/\/+$/, "");

async function getJson(cfg: NodeConfig, path: string): Promise<unknown> {
  const res = await fetch(base(cfg) + path, { headers: { accept: "application/json" } });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text.slice(0, 200) || `HTTP ${res.status}`);
  }
}

async function postJson(cfg: NodeConfig, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(base(cfg) + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text.slice(0, 200) || `HTTP ${res.status}`);
  }
}

export interface NodeStatus {
  version?: { api?: string; node?: string };
  address?: string;
  networkId?: string;
  shardId?: string;
  peers?: number;
  nodes?: number;
  minPhloPrice?: number;
  latestBlockNumber?: number;
}

export async function nodeStatus(cfg: NodeConfig): Promise<NodeStatus> {
  return (await getJson(cfg, "/api/status")) as NodeStatus;
}

// ---------------------------------------------------------------------------
// eval — exploratory deploy
// ---------------------------------------------------------------------------

export interface EvalResult {
  values: string[];
  blockNumber?: number;
  blockHash?: string;
}

/** Render one Par expression from the node's JSON into readable text. */
export function renderExpr(e: unknown): string {
  if (e === null || e === undefined) return "Nil";
  if (typeof e !== "object") return String(e);
  const o = e as Record<string, unknown>;
  if ("ExprInt" in o) return String(o.ExprInt);
  if ("ExprString" in o) return JSON.stringify(o.ExprString);
  if ("ExprBool" in o) return String(o.ExprBool);
  if ("ExprBytes" in o) return `0x${String(o.ExprBytes)}`;
  if ("ExprUri" in o) return String(o.ExprUri);
  if ("ExprUnforg" in o) return "Unforgeable(…)";
  if ("ExprList" in o) return `[${(o.ExprList as unknown[]).map(renderExpr).join(", ")}]`;
  if ("ExprTuple" in o) return `(${(o.ExprTuple as unknown[]).map(renderExpr).join(", ")})`;
  if ("ExprSet" in o) return `Set(${(o.ExprSet as unknown[]).map(renderExpr).join(", ")})`;
  // A map arrives as a list of [key, value] pairs, not as an object.
  if ("ExprMap" in o) {
    const entries = (o.ExprMap as [string, unknown][]) ?? [];
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${renderExpr(v)}`).join(", ")}}`;
  }
  return JSON.stringify(o);
}

/**
 * Run a term without deploying it.
 *
 * The plain endpoint runs against the last *finalized* block, which a young
 * chain does not have yet ("Finalized fringe is not available"). Rather than
 * make that the user's problem, fall back to the newest block by hash — the
 * same evaluation, just anchored explicitly.
 */
export async function evalTerm(cfg: NodeConfig, term: string): Promise<EvalResult> {
  const unwrap = (r: unknown): EvalResult => {
    if (typeof r === "string") throw new Error(r); // the node reports errors as a bare JSON string
    const o = (r ?? {}) as { expr?: unknown[]; block?: { blockNumber?: number; blockHash?: string } };
    return {
      values: (o.expr ?? []).map(renderExpr),
      blockNumber: o.block?.blockNumber,
      blockHash: o.block?.blockHash,
    };
  };

  const program = wrapProgram(term, "eval");
  try {
    return unwrap(await postJson(cfg, "/api/explore-deploy", program));
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (!/finalized fringe/i.test(msg)) throw e;
    const blocks = (await getJson(cfg, "/api/blocks/1")) as { blockHash?: string }[];
    const blockHash = blocks?.[0]?.blockHash;
    if (!blockHash) throw e;
    return unwrap(
      await postJson(cfg, "/api/explore-deploy-by-block-hash", {
        term: program,
        blockHash,
        usePreStateHash: false,
      })
    );
  }
}

// ---------------------------------------------------------------------------
// deploy — signed, charged, permanent
// ---------------------------------------------------------------------------

export interface DeployOutcome {
  ok: boolean;
  message: string;
  /** The public name this deploy's `return` values were forwarded to. */
  resultName?: string;
}

/**
 * Read what a deploy sent to `return`.
 *
 * A deploy answers in the tuplespace, not in the reply to the submission: the
 * block has to be produced first. So this polls the newest block for data at the
 * deploy's result name, and gives up rather than waiting forever — the value is
 * still there to read later.
 */
export async function readResults(cfg: NodeConfig, name: string, attempts = 12): Promise<string[]> {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const blocks = (await getJson(cfg, "/api/blocks/1")) as { blockHash?: string }[];
      const blockHash = blocks?.[0]?.blockHash;
      if (!blockHash) continue;
      const r = await postJson(cfg, "/api/data-at-name-by-block-hash", {
        name: { ExprString: name },
        blockHash,
        usePreStateHash: false,
      });
      if (typeof r === "string") continue;
      const expr = ((r ?? {}) as { expr?: unknown[] }).expr ?? [];
      if (expr.length) return expr.map(renderExpr);
    } catch {
      // a block in flight, or the name not written yet — keep waiting
    }
  }
  return [];
}

export async function deployTerm(cfg: NodeConfig, term: string): Promise<DeployOutcome> {
  if (!cfg.key) {
    return { ok: false, message: "no deploy key — /rholang key generate, or /rholang key <hex>" };
  }
  const status = await nodeStatus(cfg).catch(() => ({} as NodeStatus));
  const forwardTo = resultName();
  const data: DeployData = {
    term: wrapProgram(term, "deploy", forwardTo),
    timestamp: Date.now(),
    phloPrice: cfg.phloPrice,
    phloLimit: cfg.phloLimit,
    // A deploy is valid only after a block the node already has; the current
    // height is always safe, and 0 (genesis) is the floor.
    validAfterBlockNumber: Math.max(0, (status.latestBlockNumber ?? 0) - 1),
    shardId: cfg.shard,
  };
  const { deployer, signature } = signDeployData(data, cfg.key);
  const reply = await postJson(cfg, "/api/deploy", {
    data,
    deployer,
    signature,
    sigAlgorithm: "secp256k1",
  });
  // Success and failure both come back as a JSON string; the node says "Success!"
  // on the happy path and names the reason otherwise.
  const text = typeof reply === "string" ? reply : JSON.stringify(reply);
  const ok = /success/i.test(text);
  return { ok, message: text, resultName: ok ? forwardTo : undefined };
}
