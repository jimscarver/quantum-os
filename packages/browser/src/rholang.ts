// rholang.ts — talk to rnode, an RChain node, from the browser.
//
// Three verbs, and the difference between them is what rnode does with your
// program:
//
//   status — ask rnode what it is (version, shard, height, phlo floor).
//   eval   — run rholang and read the result back. Nothing is signed, nothing
//            is stored, no block is produced. This is `explore-deploy`.
//   deploy — sign a program and submit it. It costs phlo, it lands in a block,
//            and what it writes outlives every peer in the room.
//
// All three go over rnode's HTTP API (`--api-host`, port 40403 by default),
// which sets permissive CORS, so the browser reaches it directly — no relay, no
// agent in the middle. The gRPC API (40402) is not reachable from a browser and
// is not used here.
//
// LIMIT OF `eval`: exploratory deploy runs against already-finalized state in a
// read-only sandbox. Pure rholang and the qucalc powerbox both return values
// there. What it cannot give you is a deploy's own identity — `rho:rchain:deployId`
// and `rho:rchain:deployerId` are unbound, an exploratory deploy having no deploy
// to name — and a registry lookup of an unregistered uri simply never answers.
// rnode must also allow exploratory deploy at all: it answers only when run as
// a read-only observer or with `--dev-mode`.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

// ---------------------------------------------------------------------------
// Configuration — where rnode is and how a deploy is charged
// ---------------------------------------------------------------------------

export interface NodeConfig {
  /** Base URL of rnode's HTTP API. */
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
    `rnode  ${cfg.url}`,
    `shard  ${cfg.shard}`,
    `phlo   limit ${cfg.phloLimit}, price ${cfg.phloPrice}`,
  ];
  if (cfg.key) {
    try {
      // The REV address only. It is the identifier a balance is held against,
      // the one to share to be paid, and the one to check a deploy's pre-charge
      // against — so it is the whole answer. A truncated public key alongside it
      // was two identifiers for one key, neither checkable against the other by
      // eye. The secret never leaves this browser.
      out.push(`addr   ${revAddressOf(cfg.key)}`);
      // Where this key's identity record lives. Computable from the key alone,
      // writable only by it — so it is worth showing next to the address a
      // balance is held against: both come from the same key.
      out.push(`record ${registryUriOf(cfg.key)}`);
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
 * The REV address a deploy is charged to, derived the way rnode derives it
 * (rholang/src/util/rev_address.rs) so what is shown is what is charged:
 *
 *   eth     = last 20 bytes of keccak256(public key without its 0x04 prefix)
 *   payload = 00000000 ++ keccak256(eth)
 *   address = base58(payload ++ first 4 bytes of blake2b256(payload))
 */
// ---------------------------------------------------------------------------
// Where your own record lives
//
// rnode derives a signed-registry uri from the deployer's public key:
//
//     rho:id: + zbase32(blake2b256(pubkey))
//
// (`registry::build_uri` over `blake2b256(pub_key)` in rnode's
// `registry_insert_signed`.) Two things follow, and both matter.
//
// The uri is computable from the key alone, so a browser knows where its own
// record is BEFORE it deploys anything — no public name to remember it by, and
// nothing to look up to find out. And `insertSigned` will only write there for
// the key the uri came from, so the slot is unforgeable without being secret.
//
// z-base-32: MSB-first 5-bit groups over the full 256 bits, no padding, the
// human-oriented alphabet rather than RFC 4648's. Checked against rnode's own
// vector — an all-zero hash encodes to 'y' repeated 52 times.
// ---------------------------------------------------------------------------

const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";

export function zbase32(data: Uint8Array, bitLength: number): string {
  let out = "";
  for (let p = 0; p < bitLength; p += 5) {
    let v = 0;
    for (let k = 0; k < 5; k++) {
      const i = p + k;
      v <<= 1;
      if (i < bitLength) v |= (data[i >> 3] >> (7 - (i % 8))) & 1;
    }
    out += ZBASE32[v];
  }
  return out;
}

/** The signed-registry uri this secret key writes to, and only this key can. */
export function registryUriOf(secretHex: string): string {
  const pub = secp256k1.getPublicKey(unhex(secretHex), false);
  return "rho:id:" + zbase32(blake2b(pub, { dkLen: 32 }), 256);
}

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
// (models/proto/casper.proto), so the bytes must match rnode's exactly. proto3
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

/** Sign deploy data the way rnode verifies it: DER secp256k1 over blake2b256. */
export function signDeployData(d: DeployData, secretHex: string): { deployer: string; signature: string } {
  const digest = blake2b(encodeDeployData(d), { dkLen: 32 });
  const sig = secp256k1.sign(digest, unhex(secretHex), { prehash: false, format: "der" });
  return { deployer: publicKeyOf(secretHex), signature: hex(sig) };
}

// ---------------------------------------------------------------------------
// The powerbox, and the wrapper every program gets
//
// Two problems, one answer. A deploy's output goes to rnode's log, which
// nobody running a browser can read; and rnode's own capabilities are URNs
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
 * The shapes here were read off rnode's own argument parsers, not its docs —
 * `docs/src/qucalc/extensions.md` documents `trustLevels` ratings and `censure`
 * censures/vouchers as nested maps, and rnode rejects those: it wants tuple
 * lists (`parse_rating_list`, `parse_censure_list`, and `parse_voucher_list`,
 * which is `parse_rating_list` again). Verified against a running node.
 */
interface PowerboxEntry {
  name: string;
  urn: string;
  /** How it is called, with the return channel where rnode expects it. */
  sig: string;
  /** What arrives on that channel. */
  returns?: string;
  /** Argument shapes that are not obvious from the signature. */
  note?: string;
  deployOnly?: boolean;
}

const POWERBOX: PowerboxEntry[] = [
  { name: "stdout", urn: "rho:io:stdout", sig: "stdout!(value)",
    returns: "nothing — it prints to rnode's log" },

  { name: "zfa", urn: "rho:qucalc:zfa", sig: "zfa!(history, *return)",
    returns: "(isZfa, phase) — phase is +I=1, −I=-1, +iI=2, −iI=-2",
    note: "history is a list of twist values 0..7, or the equivalent string" },
  { name: "grant", urn: "rho:qucalc:grant", sig: "grant!(history, *return)",
    returns: "the minted capability uri, or Nil if the history is not ZFA-closed" },
  { name: "verify", urn: "rho:qucalc:verify", sig: "verify!(uri, *return)",
    returns: "Bool" },
  { name: "fuse", urn: "rho:qucalc:fuse", sig: "fuse!(subject, predicate, *return)",
    returns: "(geometry, cap), or Nil if the synthesis does not close" },
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

/** Render one Par expression from rnode's JSON into readable text. */
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
    if (typeof r === "string") throw new Error(r); // rnode reports errors as a bare JSON string
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
  /** The deploy's signature — how to find it in a block once one carries it. */
  sig?: string;
}

/** What a block says happened to a deploy, once one carries it. */
export interface DeployFate {
  blockNumber: number;
  errored: boolean;
  cost?: number;
  systemDeployError?: string;
}

/**
 * Read what a deploy sent to `return`.
 *
 * A deploy answers in the tuplespace, not in the reply to the submission: the
 * block has to be produced first. So this polls the newest block for data at the
 * deploy's result name, and gives up rather than waiting forever — the value is
 * still there to read later.
 */
/**
 * Read whatever is at a public name right now, without waiting.
 *
 * A deploy's result outlives the deploy: it sits on the name until something
 * consumes it. So a read is a question you can ask at any time, not a window
 * you have to catch — which is what makes `/rholang read` a real answer to "my
 * deploy hasn't reported yet".
 */
export async function readName(cfg: NodeConfig, name: string): Promise<string[]> {
  const blocks = (await getJson(cfg, "/api/blocks/1")) as { blockHash?: string }[];
  const blockHash = blocks?.[0]?.blockHash;
  if (!blockHash) return [];
  const r = await postJson(cfg, "/api/data-at-name-by-block-hash", {
    name: { ExprString: name },
    blockHash,
    usePreStateHash: false,
  });
  if (typeof r === "string") return [];
  const expr = ((r ?? {}) as { expr?: unknown[] }).expr ?? [];
  return expr.map(renderExpr);
}

/**
 * Find what a block made of a deploy, by its signature.
 *
 * A deploy that fails sends nothing to `return`, so its result name stays empty
 * forever and looks identical to one still waiting on consensus. The block knows
 * the difference — it carries `errored` per deploy — and this is the only way to
 * tell the two apart from outside rnode.
 *
 * `systemDeployError` carries the reducer's first error since rchain-rust#15 —
 * before that it was always empty, and "it errored, and cost this much" was the
 * whole of what a deployer could learn. Treat it as optional: an rnode older than
 * that fix reports nothing there.
 */
export async function deployFate(cfg: NodeConfig, sig: string, depth = 12): Promise<DeployFate | null> {
  const blocks = (await getJson(cfg, `/api/blocks/${depth}`)) as { blockHash?: string }[];
  for (const b of blocks ?? []) {
    if (!b.blockHash) continue;
    const full = (await getJson(cfg, `/api/block/${b.blockHash}`)) as {
      blockInfo?: { blockNumber?: number };
      deploys?: { sig?: string; errored?: boolean; cost?: number; systemDeployError?: string }[];
    };
    const hit = (full?.deploys ?? []).find((d) => d.sig === sig);
    if (hit) {
      return {
        blockNumber: full?.blockInfo?.blockNumber ?? -1,
        errored: hit.errored === true,
        cost: hit.cost,
        systemDeployError: hit.systemDeployError || undefined,
      };
    }
  }
  return null;
}

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
    // A deploy is valid only after a block rnode already has; the current
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
  // Success and failure both come back as a JSON string; rnode says "Success!"
  // on the happy path and names the reason otherwise.
  const text = typeof reply === "string" ? reply : JSON.stringify(reply);
  const ok = /success/i.test(text);
  return { ok, message: text, resultName: ok ? forwardTo : undefined, sig: ok ? signature : undefined };
}
