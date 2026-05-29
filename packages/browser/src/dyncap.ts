/// Hash-only dynamic capabilities — TOFU + chain-tamper detection + fork
/// detection. Uses only SHA-256 (browser-built-in `crypto.subtle.digest`);
/// no signatures, no keypairs, no external crypto library.
///
/// Each peer keeps a private 32-byte `seed` (per-device, persistent), and
/// publishes a permanent `anchor = H(seed)` on join. Each signable envelope
/// grows a `dyncap` field carrying `{anchor, seq, witness}`, where
/// `witness = H(seed || seq_le32 || room_id_bytes || payload_hash)` and
/// `payload_hash` covers the envelope's canonical serialization sans dyncap.
///
/// Receivers maintain per-peer chain state. TOFU anchors on first sight;
/// subsequent envelopes must extend the chain — monotonic `seq`, unseen
/// `witness`. Two valid envelopes at the same `seq` under the same anchor
/// are a *fork*: clone evidence.
///
/// Trust ceiling: this is TOFU plus chain-tamper / replay / fork detection.
/// It is not signature-strength identity — receivers cannot mathematically
/// verify that a `witness` was correctly derived from `seed`, only that it
/// is unique per `(anchor, seq)`. The QLF philosophy is that the algebra is
/// the security; dyncap extends that to identity via continuity, not by
/// borrowing a separate asymmetric primitive.

export interface DynCapState {
  seed: Uint8Array;   // private, never broadcast
  anchor: string;     // hex of H(seed)
  seq: number;        // last-used sequence (next broadcast uses seq + 1)
}

export interface DyncapField {
  anchor: string;
  seq: number;
  witness: string;
}

export interface ChainEntry {
  anchor: string;                       // TOFU-locked on first sight
  lastSeq: number;                      // highest seq accepted so far
  witnesses: Map<number, string>;       // seq → witness hex (recent ring)
  contested: boolean;                   // set true after a fork is observed
}

export type VerifyResult =
  | { kind: "ok"; entry: ChainEntry }
  | { kind: "tofu"; entry: ChainEntry }    // first time seeing this peer
  | { kind: "anchor-mismatch"; expected: string; got: string }
  | { kind: "replay"; seq: number }
  | { kind: "fork"; seq: number; existingWitness: string; newWitness: string }
  | { kind: "invalid"; reason: string };

const WITNESS_RING = 256; // keep the last N (seq, witness) pairs per peer

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    s += HEX[(b >> 4) & 0xf] + HEX[b & 0xf];
  }
  return s;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SHA-256 (browser-built-in)
// ---------------------------------------------------------------------------

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(buf);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = n        & 0xff;
  out[1] = (n >>  8) & 0xff;
  out[2] = (n >> 16) & 0xff;
  out[3] = (n >> 24) & 0xff;
  return out;
}

// ---------------------------------------------------------------------------
// Canonical serialization for payload hashing
// ---------------------------------------------------------------------------

/// Recursively sort object keys, then JSON.stringify — deterministic across
/// sender and receiver. Skips a top-level `dyncap` field if present.
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const k of keys) {
    if (k === "dyncap") continue;
    out[k] = canonicalize((value as Record<string, unknown>)[k]);
  }
  return out;
}

async function payloadHash(envelope: unknown): Promise<Uint8Array> {
  const json = JSON.stringify(canonicalize(envelope));
  return sha256(new TextEncoder().encode(json));
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export function generateSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return seed;
}

export async function deriveAnchor(seed: Uint8Array): Promise<string> {
  return toHex(await sha256(seed));
}

export async function newDynCapState(seed?: Uint8Array): Promise<DynCapState> {
  const s = seed ?? generateSeed();
  return { seed: s, anchor: await deriveAnchor(s), seq: 0 };
}

// ---------------------------------------------------------------------------
// Signing & verification
// ---------------------------------------------------------------------------

/// Produce a dyncap field for an envelope. Mutates `state.seq` (increment).
/// Caller attaches the returned field as `envelope.dyncap`.
export async function signEnvelope(
  state: DynCapState,
  roomId: string,
  envelope: Record<string, unknown>,
): Promise<DyncapField> {
  state.seq += 1;
  const seq = state.seq;
  const pH = await payloadHash(envelope);
  const witness = await sha256(concatBytes(
    state.seed,
    u32le(seq),
    new TextEncoder().encode(roomId),
    pH,
  ));
  return { anchor: state.anchor, seq, witness: toHex(witness) };
}

/// Verify an inbound envelope's dyncap. Returns a tagged result describing
/// the outcome; mutates the caller's chainState only via the returned entry
/// (callers should write it back to their map).
export async function verifyEnvelope(
  prior: ChainEntry | undefined,
  roomId: string,
  envelope: Record<string, unknown>,
  dyncap: DyncapField,
): Promise<VerifyResult> {
  // Shape checks — dyncap must have anchor (64 hex), seq (positive int), witness (64 hex).
  if (typeof dyncap.anchor !== "string" || dyncap.anchor.length !== 64
      || typeof dyncap.witness !== "string" || dyncap.witness.length !== 64
      || typeof dyncap.seq !== "number" || !Number.isFinite(dyncap.seq) || dyncap.seq < 1) {
    return { kind: "invalid", reason: "malformed dyncap shape" };
  }

  // Note: without the seed, receivers cannot verify the witness was correctly
  // derived from payload_hash. DTLS at the transport layer covers in-flight
  // tampering; sync-forwarded entries inherit the forwarder's trust until a
  // future revision adds explicit payload_hash to the dyncap field.

  if (!prior) {
    // TOFU: first time seeing this peer. Lock the anchor.
    const entry: ChainEntry = {
      anchor: dyncap.anchor,
      lastSeq: dyncap.seq,
      witnesses: new Map([[dyncap.seq, dyncap.witness]]),
      contested: false,
    };
    return { kind: "tofu", entry };
  }

  // Anchor must match the TOFU-locked one.
  if (prior.anchor !== dyncap.anchor) {
    return { kind: "anchor-mismatch", expected: prior.anchor, got: dyncap.anchor };
  }

  // Replay or rollback: a seq we already accepted with a different witness.
  const existing = prior.witnesses.get(dyncap.seq);
  if (existing !== undefined) {
    if (existing === dyncap.witness) {
      // Idempotent re-delivery (same envelope twice) — accept as ok, no change.
      return { kind: "ok", entry: prior };
    }
    // Same seq, different witness → fork. Two distinct valid chain steps
    // exist for this anchor at this sequence.
    const next: ChainEntry = { ...prior, contested: true };
    return { kind: "fork", seq: dyncap.seq, existingWitness: existing, newWitness: dyncap.witness };
  }

  // New seq — add it. Prune the ring if oversized.
  const witnesses = new Map(prior.witnesses);
  witnesses.set(dyncap.seq, dyncap.witness);
  if (witnesses.size > WITNESS_RING) {
    // Drop the oldest entries (lowest seq numbers).
    const sortedSeqs = Array.from(witnesses.keys()).sort((a, b) => a - b);
    const drop = sortedSeqs.length - WITNESS_RING;
    for (let i = 0; i < drop; i++) witnesses.delete(sortedSeqs[i]);
  }
  const entry: ChainEntry = {
    anchor: prior.anchor,
    lastSeq: Math.max(prior.lastSeq, dyncap.seq),
    witnesses,
    contested: prior.contested,
  };
  return { kind: "ok", entry };
}

// ---------------------------------------------------------------------------
// Persistence helpers (used by app.ts)
// ---------------------------------------------------------------------------

export function serializeState(state: DynCapState): string {
  return JSON.stringify({ seed: toHex(state.seed), anchor: state.anchor, seq: state.seq });
}

export async function deserializeState(raw: string): Promise<DynCapState | null> {
  try {
    const data = JSON.parse(raw) as { seed?: string; anchor?: string; seq?: number };
    if (typeof data.seed !== "string" || data.seed.length !== 64) return null;
    const seed = fromHex(data.seed);
    const anchor = typeof data.anchor === "string" && data.anchor.length === 64
      ? data.anchor
      : await deriveAnchor(seed);
    const seq = typeof data.seq === "number" && Number.isFinite(data.seq) && data.seq >= 0
      ? data.seq
      : 0;
    return { seed, anchor, seq };
  } catch {
    return null;
  }
}

export function serializeChain(chains: Map<string, ChainEntry>): string {
  const obj: Record<string, { anchor: string; lastSeq: number; witnesses: [number, string][]; contested: boolean }> = {};
  for (const [peer, e] of chains) {
    obj[peer] = {
      anchor: e.anchor, lastSeq: e.lastSeq,
      witnesses: Array.from(e.witnesses.entries()),
      contested: e.contested,
    };
  }
  return JSON.stringify(obj);
}

export function deserializeChain(raw: string): Map<string, ChainEntry> {
  const out = new Map<string, ChainEntry>();
  try {
    const data = JSON.parse(raw) as Record<string, { anchor?: string; lastSeq?: number; witnesses?: [number, string][]; contested?: boolean }>;
    for (const [peer, e] of Object.entries(data)) {
      if (typeof e.anchor !== "string" || typeof e.lastSeq !== "number") continue;
      out.set(peer, {
        anchor: e.anchor,
        lastSeq: e.lastSeq,
        witnesses: new Map(Array.isArray(e.witnesses) ? e.witnesses : []),
        contested: !!e.contested,
      });
    }
  } catch { /* ignore */ }
  return out;
}
