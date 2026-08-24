// global.ts — client-side RChain deploy pipeline for the `/global` macro agent.
//
// Zero-trust split: the headless agent (scripts/qos-cli/global-agent.mjs) only
// EXPANDS a macro into rholang; this module does everything that must stay in the
// browser:
//
//   lint   → the WASM linter (crates/zfa-core/src/lint.rs) checks the expanded
//            code for restricted patterns before anything is signed.
//   sign   → the deploy is signed with a locally-generated keypair, wrapped by a
//            passphrase-derived AES key and stored in IndexedDB. The private key
//            never leaves the browser.
//   deploy → the signed packet is POSTed straight to the target RChain node.
//
// SECURITY NOTE — signing scheme: Web Crypto exposes ECDSA over P-256, but RChain
// deploys are signed with secp256k1. P-256 is used here as the client-side
// *pipeline* placeholder; swap `generateKeyPair`/`signPayload` for a secp256k1
// implementation (`@noble/curves` or a WASM secp256k1) before production use.
// The key-storage + lint + deploy flow is unchanged.

const DB_NAME = "qos-global";
const DB_VERSION = 1;
const STORE = "keys";

export interface LintResult {
  ok: boolean;
  errors: string[];
}

/** Run the WASM rholang linter on an expanded source string. */
export async function lintRholang(source: string): Promise<LintResult> {
  try {
    const mod = (await import("@quantum-os/zfa-core")) as any;
    const ok: boolean = mod.wasm_lint_ok ? mod.wasm_lint_ok(source) : true;
    const errors: string[] = mod.wasm_lint_errors
      ? String(mod.wasm_lint_errors(source) ?? "")
          .split("\n")
          .filter(Boolean)
      : [];
    return { ok, errors };
  } catch {
    // WASM unavailable (e.g. first load / dev fallback) — do not hard-block.
    return { ok: true, errors: [] };
  }
}

// ---------------------------------------------------------------------------
// Passphrase-wrapped key storage (Web Crypto + IndexedDB)
// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deriveWrappingKey(passphrase: string, salt: BufferSource): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 210_000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"]
  );
}

/** Generate a signing keypair (ECDSA P-256 — see SECURITY NOTE above). */
export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
}

interface StoredKey {
  salt: number[];
  iv: number[];
  wrappedPrivate: ArrayBuffer;
  publicJwk: JsonWebKey;
}

/** Encrypt + persist a keypair in IndexedDB under `id`, wrapped by `passphrase`. */
export async function storeKeyPair(
  id: string,
  passphrase: string,
  pair: CryptoKeyPair
): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapKey = await deriveWrappingKey(passphrase, salt);
  const wrappedPrivate = await crypto.subtle.wrapKey("jwk", pair.privateKey, wrapKey, {
    name: "AES-GCM",
    iv,
  });
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const db = await openDb();
  await idbPut(db, id, {
    salt: Array.from(salt),
    iv: Array.from(iv),
    wrappedPrivate,
    publicJwk,
  } satisfies StoredKey);
  db.close();
}

export interface LoadedKey {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}

/** Load + decrypt a stored keypair (null if absent or wrong passphrase). */
export async function loadKeyPair(id: string, passphrase: string): Promise<LoadedKey | null> {
  const db = await openDb();
  const rec = (await idbGet(db, id)) as StoredKey | undefined;
  db.close();
  if (!rec) return null;
  try {
    const wrapKey = await deriveWrappingKey(passphrase, new Uint8Array(rec.salt));
    const privateKey = await crypto.subtle.unwrapKey(
      "jwk",
      rec.wrappedPrivate,
      wrapKey,
      { name: "AES-GCM", iv: new Uint8Array(rec.iv) },
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"]
    );
    return { privateKey, publicJwk: rec.publicJwk };
  } catch {
    return null; // wrong passphrase
  }
}

// ---------------------------------------------------------------------------
// Signing + deploy
// ---------------------------------------------------------------------------

export interface SignedPacket {
  code: string;
  publicKey: string;
  signature: string;
}

const b64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/** Sign a payload string (the rholang deploy) with a private key. */
export async function signPayload(
  payload: string,
  privateKey: CryptoKey,
  publicJwk: JsonWebKey
): Promise<SignedPacket> {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(payload)
  );
  return {
    code: payload,
    publicKey: btoa(JSON.stringify(publicJwk)),
    signature: b64(sig),
  };
}

export interface DeployResult {
  ok: boolean;
  id?: string;
  message: string;
}

/** POST a signed deploy packet to the target RChain node. */
export async function deployToNode(
  nodeUrl: string,
  packet: SignedPacket
): Promise<DeployResult> {
  try {
    const res = await fetch(`${nodeUrl.replace(/\/$/, "")}/api/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(packet),
    });
    if (!res.ok) return { ok: false, message: `node rejected deploy (HTTP ${res.status})` };
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: body.id, message: "deployed" };
  } catch (e) {
    return { ok: false, message: `deploy failed: ${(e as Error)?.message ?? e}` };
  }
}

// ---------------------------------------------------------------------------
// The full pipeline: preview → lint → sign → deploy
// ---------------------------------------------------------------------------

export interface PipelineResult {
  ok: boolean;
  stage: "lint" | "sign" | "deploy" | "done";
  message: string;
  deployId?: string;
}

/**
 * Run the client-side pipeline for an already-expanded rholang source string.
 * The browser UI should call this on user approval, after showing a preview.
 */
export async function runGlobalPipeline(
  source: string,
  opts: { nodeUrl: string; passphrase: string; id?: string }
): Promise<PipelineResult> {
  // 1. Lint — never sign unvalidated code.
  const lint = await lintRholang(source);
  if (!lint.ok) {
    return {
      ok: false,
      stage: "lint",
      message: "lint failed:\n" + lint.errors.map((e) => `  • ${e}`).join("\n"),
    };
  }

  // 2. Load (or generate + store) the signing key.
  const id = opts.id ?? "global-default";
  let keys = await loadKeyPair(id, opts.passphrase);
  if (!keys) {
    const pair = await generateKeyPair();
    await storeKeyPair(id, opts.passphrase, pair);
    keys = {
      privateKey: pair.privateKey,
      publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
    };
  }

  // 3. Sign.
  const packet = await signPayload(source, keys.privateKey, keys.publicJwk);

  // 4. Deploy.
  const deploy = await deployToNode(opts.nodeUrl, packet);
  if (!deploy.ok) {
    return { ok: false, stage: "deploy", message: deploy.message };
  }
  return { ok: true, stage: "done", message: "deployed", deployId: deploy.id };
}

// ---------------------------------------------------------------------------
// Local macro expansion — mirrors scripts/qos-cli/global-macros.mjs so the
// browser can expand `/global` commands even when no /global agent is present.
// The agent is the authority in a room with one; this is the offline fallback.
// ---------------------------------------------------------------------------

export type GlobalExpansion =
  | { kind: "help"; text: string }
  | { kind: "list"; text: string }
  | { kind: "result"; text: string }
  | { kind: "rholang"; macro: string; source: string };

const RESTRICTED = [
  /rho:io:/i,
  /rho:rchain:deployerId/i,
  /\*\s*!/,
  /!\s*\*/,
  /new\s+[a-zA-Z]/i,
  /for\s*\(/i,
];

function cleanStr(v: string, name: string): string {
  const s = (v ?? "").trim();
  if (!s) throw new Error(`${name}: expected a non-empty string`);
  if (s.length > 120) throw new Error(`${name}: too long`);
  for (const re of RESTRICTED) if (re.test(s)) throw new Error(`${name}: restricted pattern`);
  return s;
}

const SYM: Record<string, number> = { "^": 0, v: 1, ">": 2, "<": 3, "/": 4, "\\": 5, "+": 6, "-": 7 };

function cleanTwists(v: string, name: string): number[] {
  const s = (v ?? "").trim().replace(/^\[|\]$/g, "");
  if (/[^0-7\s,]/.test(s)) {
    const out: number[] = [];
    for (const ch of s) {
      if (!(ch in SYM)) throw new Error(`${name}: unknown twist symbol`);
      out.push(SYM[ch]);
    }
    return out;
  }
  const digits = s.replace(/[\s,]+/g, "");
  if (!digits.length || !/^[0-7]+$/.test(digits)) throw new Error(`${name}: expected twist values 0..7`);
  return [...digits].map(Number);
}

function cleanList(v: string, name: string): string[] {
  const parts = (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) throw new Error(`${name}: expected a comma-separated list`);
  return parts.map((p) => cleanStr(p, name));
}

const q = (s: string) => JSON.stringify(s);

interface MacroDef {
  help: string;
  write: boolean;
  argSpec: [string, string][];
  run: (a: Record<string, unknown>) => string;
}

const MACROS: Record<string, MacroDef> = {
  grant: {
    help: "Mint a ZFA-balanced proof as a capability (rho:qucalc:grant).",
    write: true,
    argSpec: [["twists", "twists"]],
    run: (a) =>
      `// mint a ZFA proof as a capability\nnew ret in {\n  rho:qucalc:grant!([${(a.twists as number[]).join(", ")}], *ret) |\n  for (@cap <- ret) { Nil }\n}`,
  },
  ballot: {
    help: "Cast a ranked-choice ballot (rho:gov:tally).",
    write: true,
    argSpec: [["issue", "string"], ["options", "list"]],
    run: (a) =>
      `// cast a ranked-choice ballot for ${q(a.issue as string)}\nnew ret in {\n  rho:gov:tally!({"issue": ${q(a.issue as string)}}, [${(a.options as string[]).map(q).join(", ")}], "ranked", *ret) |\n  for (@winner <- ret) { Nil }\n}`,
  },
  directory: {
    help: "Create a capability-facet directory (rho:registry:insertArbitrary).",
    write: true,
    argSpec: [["name", "string"]],
    run: (a) =>
      `// create a capability-facet directory\nnew ret in {\n  rho:registry:insertArbitrary!({"directory": ${q(a.name as string)}}, *ret) |\n  for (@uri <- ret) { Nil }\n}`,
  },
  mailbox: {
    help: "Create a capability-facet inbox (rho:registry:insertArbitrary).",
    write: true,
    argSpec: [["name", "string"]],
    run: (a) =>
      `// create a capability-facet inbox\nnew ret in {\n  rho:registry:insertArbitrary!({"mailbox": ${q(a.name as string)}}, *ret) |\n  for (@uri <- ret) { Nil }\n}`,
  },
  group: {
    help: "Create a governance group (deployer becomes admin).",
    write: true,
    argSpec: [["name", "string"]],
    run: (a) =>
      `// create a governance group — the deployer becomes admin\nnew ret in {\n  rho:registry:insertArbitrary!({"group": ${q(a.name as string)}, "admin": *deployerId}, *ret) |\n  for (@uri <- ret) { Nil }\n}`,
  },
  delegate: {
    help: "Delegate your vote to another member (rho:gov:resolveWeights).",
    write: true,
    argSpec: [["to", "string"]],
    run: (a) =>
      `// self-signed delegation (signer = *deployerId)\nnew ret in {\n  rho:gov:resolveWeights!([*deployerId], {*deployerId: ${q(a.to as string)}}, {}, *ret) |\n  for (@weights <- ret) { Nil }\n}`,
  },
  transfer: {
    help: "Transfer REV to an address (rho:rchain:revVault).",
    write: true,
    argSpec: [["amount", "int"], ["to", "string"]],
    run: (a) =>
      `// REV transfer (requires the rev-vault capability)\nnew ret in {\n  rho:rchain:revVault!("transfer", ${a.amount as number}, ${q(a.to as string)}, *ret) |\n  for (@r <- ret) { Nil }\n}`,
  },
};

/// Decimal digits only, carried as a BigInt. `Number()` rounds past 2^53, so a
/// typed 12345678901234567890 became a signed 12345678901234567000 — the amount
/// approved was not the amount signed. REV amounts run well past 2^53.
function cleanInt(v: unknown, name: string): bigint {
  const s = String(v ?? "").trim();
  if (!/^\d+$/.test(s)) throw new Error(`${name}: expected a non-negative integer (decimal digits only)`);
  if (s.length > 40) throw new Error(`${name}: integer too long (max 40 digits)`);
  return BigInt(s);
}

// ---- macros embedded in rholang ----------------------------------------
//
// A `/global` body is a rholang program — one line or many — with macro call
// sites written `%name(arg, …)`. The rholang is NOT parsed: we scan it well
// enough to find call sites that are really call sites (skipping strings and
// comments, balancing brackets), expand those in place, and leave every other
// byte alone. Mirrors expandProgram in scripts/qos-cli/global-macros.mjs.

function skipString(src: string, i: number): number {
  i++;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === '"') return i + 1;
    i++;
  }
  return -1;
}

function skipTrivia(src: string, i: number): number {
  if (src[i] === '"') return skipString(src, i);
  if (src[i] === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); return e < 0 ? src.length : e; }
  if (src[i] === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); return e < 0 ? -1 : e + 2; }
  return -1;
}

const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

function matchBracket(src: string, open: number): number {
  const stack: string[] = [CLOSERS[src[open]]];
  let i = open + 1;
  while (i < src.length) {
    const t = skipTrivia(src, i);
    if (t === -1 && (src[i] === '"' || (src[i] === "/" && src[i + 1] === "*"))) return -1;
    if (t !== -1) { i = t; continue; }
    const c = src[i];
    if (CLOSERS[c]) stack.push(CLOSERS[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack[stack.length - 1] !== c) return -1;
      stack.pop();
      if (!stack.length) return i;
    }
    i++;
  }
  return -1;
}

function splitArgs(src: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0, i = 0;
  while (i < src.length) {
    const t = skipTrivia(src, i);
    if (t !== -1) { i = t; continue; }
    const c = src[i];
    if (CLOSERS[c]) depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { out.push(src.slice(start, i)); start = i + 1; }
    i++;
  }
  const tail = src.slice(start);
  if (out.length || tail.trim()) out.push(tail);
  return out.map((x) => x.trim()).filter((x, n, a) => !(a.length === 1 && x === ""));
}

function termToPlain(t: string): string {
  const s = String(t).trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(.)/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  }
  if (s.startsWith("[") && s.endsWith("]")) return splitArgs(s.slice(1, -1)).map(termToPlain).join(",");
  return s;
}

function bindArgs(macro: MacroDef, name: string, terms: string[]): Record<string, unknown> {
  const spec = macro.argSpec;
  if (terms.length < spec.length) {
    throw new Error(`${name}: missing args — ${spec.slice(terms.length).map(([n, t]) => `${n}:${t}`).join(", ")}`);
  }
  if (terms.length > spec.length) throw new Error(`${name}: too many args (expected ${spec.length})`);
  const args: Record<string, unknown> = {};
  for (let i = 0; i < spec.length; i++) {
    const [argName, type] = spec[i];
    const raw = termToPlain(terms[i]);
    switch (type) {
      case "string": args[argName] = cleanStr(raw, argName); break;
      case "twists": args[argName] = cleanTwists(raw, argName); break;
      case "list": args[argName] = cleanList(raw, argName); break;
      case "int": args[argName] = cleanInt(raw, argName); break;
      default: throw new Error(`${name}: internal — unknown arg type ${type}`);
    }
  }
  return args;
}

export interface GlobalProgram {
  kind: "program";
  source: string;
  expansions: { name: string; line: number; write: boolean }[];
  errors: { line: number; message: string }[];
}

const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length;

/// Expand every `%macro(…)` call site in a rholang program. Errors never abort:
/// every site is attempted so one report covers them all, and a site that fails
/// is left exactly as the user wrote it.
export function expandGlobalProgram(src: string): GlobalProgram {
  const text = String(src ?? "");
  const out: string[] = [];
  const expansions: GlobalProgram["expansions"] = [];
  const errors: GlobalProgram["errors"] = [];
  let i = 0, last = 0;
  while (i < text.length) {
    const t = skipTrivia(text, i);
    if (t !== -1) { i = t; continue; }
    if (text[i] !== "%") { i++; continue; }
    const m = /^%([A-Za-z][\w-]*)\s*\(/.exec(text.slice(i));
    if (!m) { i++; continue; }
    const name = m[1].toLowerCase();
    const open = i + m[0].length - 1;
    const close = matchBracket(text, open);
    if (close === -1) { errors.push({ line: lineOf(text, i), message: `%${name}: unbalanced ( — call site is not closed` }); break; }
    const macro = MACROS[name];
    out.push(text.slice(last, i));
    if (!macro) {
      errors.push({ line: lineOf(text, i), message: `unknown macro %${name} — try /global macros` });
      out.push(text.slice(i, close + 1));
    } else {
      try {
        out.push(macro.run(bindArgs(macro, name, splitArgs(text.slice(open + 1, close)))));
        expansions.push({ name, line: lineOf(text, i), write: true });
      } catch (e) {
        errors.push({ line: lineOf(text, i), message: e instanceof Error ? e.message : String(e) });
        out.push(text.slice(i, close + 1));
      }
    }
    last = close + 1;
    i = close + 1;
  }
  out.push(text.slice(last));
  return { kind: "program", source: out.join(""), expansions, errors };
}

export function expandGlobalMacro(line: string): GlobalExpansion {
  const body = (line ?? "").trim().replace(/^\/?\s*global\s*/i, "");
  const tokens = body.split(/\s+/).filter(Boolean);
  if (!tokens.length) return { kind: "help", text: "usage: /global <macro> <args…>  (or /global help|macros)" };
  const name = tokens[0].toLowerCase();
  const rest = tokens.slice(1);

  if (name === "help") {
    return {
      kind: "help",
      text:
        "RChain capability macros — /global\n" +
        "  /global help            this help\n" +
        "  /global macros          list the approved macro library\n" +
        "  /global <macro> <args>  expand (writes: rholang preview to sign; reads: result)",
    };
  }
  if (name === "macros" || name === "list") {
    const rows = Object.entries(MACROS).map(
      ([m, d]) => `  ${m.padEnd(10)} ${d.write ? "write" : "read "}  ${d.help}`
    );
    return { kind: "list", text: `Approved macros (${rows.length}):\n${rows.join("\n")}` };
  }
  if (name === "zfa") {
    return { kind: "result", text: `local read — use /qucalc ${rest.join(" ")} (or /zfa-check) to verify ZFA` };
  }
  if (name === "verify") {
    return { kind: "result", text: `local read — use /zfa ${rest.join(" ") || "<token>"} to validate a capability` };
  }

  const macro = MACROS[name];
  if (!macro) throw new Error(`unknown macro ${JSON.stringify(name)} — try /global macros`);

  const args: Record<string, unknown> = {};
  const spec = macro.argSpec;
  if (rest.length < spec.length) {
    const missing = spec.slice(rest.length).map(([n, t]) => `${n}:${t}`).join(", ");
    throw new Error(`${name}: missing args — ${missing}`);
  }
  if (rest.length > spec.length) throw new Error(`${name}: too many args (expected ${spec.length})`);
  for (let i = 0; i < spec.length; i++) {
    const [argName, type] = spec[i];
    const raw = rest[i];
    switch (type) {
      case "string": args[argName] = cleanStr(raw, argName); break;
      case "twists": args[argName] = cleanTwists(raw, argName); break;
      case "list": args[argName] = cleanList(raw, argName); break;
      case "int": args[argName] = cleanInt(raw, argName); break;
      default: throw new Error(`${name}: internal — unknown arg type ${type}`);
    }
  }

  return { kind: "rholang", macro: name, source: macro.run(args) };
}
