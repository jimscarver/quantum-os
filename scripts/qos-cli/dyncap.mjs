// Hash-only dynamic capabilities — Node port of packages/browser/src/dyncap.ts.
// SHA-256 only (globalThis.crypto.subtle), no keypairs, no external crypto.
// Identity = a private 32-byte seed; anchor = H(seed); each signable envelope
// carries { anchor, seq, witness } with
//   witness = H(seed ‖ u32le(seq) ‖ utf8(roomId) ‖ payloadHash)
// and payloadHash = H(canonical-JSON(envelope sans dyncap)).
// Must match the browser byte-for-byte so peers verify the daemon's chain.

const WITNESS_RING = 256;
const HEX = "0123456789abcdef";

export function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    s += HEX[(b >> 4) & 0xf] + HEX[b & 0xf];
  }
  return s;
}

export function fromHex(hex) {
  if (hex.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function sha256(data) {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(buf);
}

function concatBytes(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function u32le(n) {
  const out = new Uint8Array(4);
  out[0] = n & 0xff;
  out[1] = (n >> 8) & 0xff;
  out[2] = (n >> 16) & 0xff;
  out[3] = (n >> 24) & 0xff;
  return out;
}

// Recursively sort keys; drop a top-level `dyncap`. Deterministic across peers.
function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const k of Object.keys(value).sort()) {
    if (k === "dyncap") continue;
    out[k] = canonicalize(value[k]);
  }
  return out;
}

async function payloadHash(envelope) {
  const json = JSON.stringify(canonicalize(envelope));
  return sha256(new TextEncoder().encode(json));
}

export function generateSeed() {
  const seed = new Uint8Array(32);
  globalThis.crypto.getRandomValues(seed);
  return seed;
}

export async function deriveAnchor(seed) {
  return toHex(await sha256(seed));
}

export async function newDynCapState(seed) {
  const s = seed ?? generateSeed();
  return { seed: s, anchor: await deriveAnchor(s), seqByRoom: {} };
}

export function nextSeqFor(state, roomId) {
  return (state.seqByRoom[roomId] ?? 0) + 1;
}

export async function signEnvelope(state, roomId, envelope) {
  const seq = nextSeqFor(state, roomId);
  state.seqByRoom[roomId] = seq;
  const pH = await payloadHash(envelope);
  const witness = await sha256(concatBytes(
    state.seed,
    u32le(seq),
    new TextEncoder().encode(roomId),
    pH,
  ));
  return { anchor: state.anchor, seq, witness: toHex(witness) };
}

export async function verifyEnvelope(prior, _roomId, _envelope, dyncap) {
  if (typeof dyncap.anchor !== "string" || dyncap.anchor.length !== 64
      || typeof dyncap.witness !== "string" || dyncap.witness.length !== 64
      || typeof dyncap.seq !== "number" || !Number.isFinite(dyncap.seq) || dyncap.seq < 1) {
    return { kind: "invalid", reason: "malformed dyncap shape" };
  }
  if (!prior) {
    const entry = { anchor: dyncap.anchor, lastSeq: dyncap.seq, witnesses: new Map([[dyncap.seq, dyncap.witness]]), contested: false };
    return { kind: "tofu", entry };
  }
  if (prior.anchor !== dyncap.anchor) {
    return { kind: "anchor-mismatch", expected: prior.anchor, got: dyncap.anchor };
  }
  const existing = prior.witnesses.get(dyncap.seq);
  if (existing !== undefined) {
    if (existing === dyncap.witness) return { kind: "ok", entry: prior };
    return { kind: "fork", seq: dyncap.seq, existingWitness: existing, newWitness: dyncap.witness };
  }
  const witnesses = new Map(prior.witnesses);
  witnesses.set(dyncap.seq, dyncap.witness);
  if (witnesses.size > WITNESS_RING) {
    const sortedSeqs = Array.from(witnesses.keys()).sort((a, b) => a - b);
    const drop = sortedSeqs.length - WITNESS_RING;
    for (let i = 0; i < drop; i++) witnesses.delete(sortedSeqs[i]);
  }
  const entry = { anchor: prior.anchor, lastSeq: Math.max(prior.lastSeq, dyncap.seq), witnesses, contested: prior.contested };
  return { kind: "ok", entry };
}

// ---- persistence ----

export function serializeState(state) {
  return JSON.stringify({ seed: toHex(state.seed), anchor: state.anchor, seqByRoom: state.seqByRoom });
}

export async function deserializeState(raw) {
  try {
    const data = JSON.parse(raw);
    if (typeof data.seed !== "string" || data.seed.length !== 64) return null;
    const seed = fromHex(data.seed);
    const anchor = typeof data.anchor === "string" && data.anchor.length === 64 ? data.anchor : await deriveAnchor(seed);
    const seqByRoom = {};
    if (data.seqByRoom && typeof data.seqByRoom === "object") {
      for (const [k, v] of Object.entries(data.seqByRoom)) {
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) seqByRoom[k] = v;
      }
    }
    return { seed, anchor, seqByRoom };
  } catch { return null; }
}

export function serializeChain(chains) {
  const obj = {};
  for (const [peer, e] of chains) {
    obj[peer] = { anchor: e.anchor, lastSeq: e.lastSeq, witnesses: Array.from(e.witnesses.entries()), contested: e.contested };
  }
  return JSON.stringify(obj);
}

export function deserializeChain(raw) {
  const out = new Map();
  try {
    const data = JSON.parse(raw);
    for (const [peer, e] of Object.entries(data)) {
      if (typeof e.anchor !== "string" || typeof e.lastSeq !== "number") continue;
      out.set(peer, { anchor: e.anchor, lastSeq: e.lastSeq, witnesses: new Map(Array.isArray(e.witnesses) ? e.witnesses : []), contested: !!e.contested });
    }
  } catch { /* ignore */ }
  return out;
}
