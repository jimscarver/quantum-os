/// ZFA kernel wrapper — loads the WASM module and exposes typed APIs.
/// Falls back to a pure-TS implementation if WASM is unavailable.
///
/// ZFA is the conjunction of two algebraic conditions:
///   1. Count balance — count_pos == count_neg
///   2. Pauli closure — the matrix product of twists folds to a scalar
///      multiple of identity (closure in the Pauli group up to phase ±1, ±i)
///
/// Count balance alone admits sequences whose non-commutative matrix product
/// is not a scalar. Pauli closure enforces the order-sensitive algebraic
/// structure of the 8-twist alphabet. Mirrors the QLF Python core
/// (`twist_core.py`) and the Rust crate (`crates/zfa-core/src/pauli.rs`).

interface ZfaWasm {
  wasm_achieves_zfa(bytes: Uint8Array): boolean;
  wasm_is_pauli_closed(bytes: Uint8Array): boolean;
  wasm_spectral_gap(bytes: Uint8Array): number;
  wasm_div_b(bytes: Uint8Array): number;
  wasm_charge(bytes: Uint8Array): number;
  wasm_capability_from_entropy(bytes: Uint8Array, label: string): string;
  wasm_capability_valid(hex: string): boolean;
}

let _wasm: ZfaWasm | null = null;

export async function loadZfa(): Promise<void> {
  try {
    // wasm-pack output lands in @quantum-os/zfa-core
    const mod = await import("@quantum-os/zfa-core");
    await (mod as any).default?.();   // init() for wasm-pack modules
    _wasm = mod as unknown as ZfaWasm;
  } catch {
    console.warn("[zfa] WASM unavailable, using pure-TS fallback");
  }
}

// ---- Twist encoding (must match crates/zfa-core/src/twist.rs) ----
const enum T {
  Up = 0, Down = 1, Right = 2, Left = 3,
  Slash = 4, BSlash = 5, Plus = 6, Minus = 7,
}
const POS = new Set([T.Up, T.Right, T.Slash, T.Plus]);

function countPos(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) if (POS.has(b as T)) n++;
  return n;
}

function isCountBalanced(twists: Uint8Array): boolean {
  const pos = countPos(twists);
  return pos === twists.length - pos;
}

// ---- Pauli matrix algebra (pure TS, mirrors pauli.rs / twist_core.py) ----

// A complex number as [re, im].
type C = [number, number];
const PAULI_TOL = 1e-9;

const ZC: C = [0, 0];
const OC: C = [1, 0];
const NOC: C = [-1, 0];
const IC: C = [0, 1];
const NIC: C = [0, -1];

function cMul(a: C, b: C): C {
  return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
}
function cAdd(a: C, b: C): C { return [a[0] + b[0], a[1] + b[1]]; }
function cApproxEq(a: C, b: C): boolean {
  return Math.abs(a[0] - b[0]) < PAULI_TOL && Math.abs(a[1] - b[1]) < PAULI_TOL;
}

// A 2x2 complex matrix [[a, b], [c, d]].
type M2 = [C, C, C, C];
const IDENTITY_M: M2 = [OC, ZC, ZC, OC];

function mMul(m: M2, n: M2): M2 {
  return [
    cAdd(cMul(m[0], n[0]), cMul(m[1], n[2])),
    cAdd(cMul(m[0], n[1]), cMul(m[1], n[3])),
    cAdd(cMul(m[2], n[0]), cMul(m[3], n[2])),
    cAdd(cMul(m[2], n[1]), cMul(m[3], n[3])),
  ];
}

// Twist → Pauli matrix per Maxwell.md axis assignments.
function twistMatrix(t: T): M2 {
  switch (t) {
    case T.Up:     return [ZC, NIC, IC, ZC];        // +σ_y
    case T.Down:   return [ZC, IC, NIC, ZC];        // -σ_y
    case T.Right:  return [ZC, OC, OC, ZC];         // +σ_x
    case T.Left:   return [ZC, NOC, NOC, ZC];       // -σ_x
    case T.Slash:  return [OC, ZC, ZC, NOC];        // +σ_z
    case T.BSlash: return [NOC, ZC, ZC, OC];        // -σ_z
    case T.Plus:   return IDENTITY_M;               // +I
    case T.Minus:  return [NOC, ZC, ZC, NOC];       // -I
  }
}

function pauliFold(twists: Uint8Array): M2 {
  let m = IDENTITY_M;
  for (const t of twists) m = mMul(m, twistMatrix(t as T));
  return m;
}

export function isPauliClosed(twists: Uint8Array): boolean {
  if (_wasm) return _wasm.wasm_is_pauli_closed(twists);
  const [a, b, c, d] = pauliFold(twists);
  if (!cApproxEq(b, ZC) || !cApproxEq(c, ZC)) return false;
  if (!cApproxEq(a, d)) return false;
  return [OC, NOC, IC, NIC].some(s => cApproxEq(a, s));
}

// ---- Public API ----

export function achievesZfa(twists: Uint8Array): boolean {
  if (_wasm) return _wasm.wasm_achieves_zfa(twists);
  return isCountBalanced(twists) && isPauliClosed(twists);
}

export function spectralGap(twists: Uint8Array): number {
  if (_wasm) return _wasm.wasm_spectral_gap(twists);
  const pos = countPos(twists);
  return Math.abs(pos - (twists.length - pos));
}

/// Generate a ZFA-balanced capability token using browser entropy.
/// Uses deterministic rejection sampling so the result is also Pauli-closed.
export function generateCapability(label: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  if (_wasm) return _wasm.wasm_capability_from_entropy(bytes, label);
  // Pure-TS fallback: same rejection-sampling logic as Capability::from_entropy
  // in Rust. ~25% of random count-balanced sequences are Pauli-closed, so
  // expected iterations ≈ 4.
  for (let counter = 0; counter < 1_000_000; counter++) {
    const twists = entropyToTwists(bytes, counter);
    if (isPauliClosed(twists)) {
      let hex = "";
      for (const t of twists) hex += t.toString(16);
      return `cap:${label}:${hex}`;
    }
  }
  throw new Error("Pauli closure rejection sampling exceeded budget");
}

function entropyToTwists(bytes: Uint8Array, counter: number): Uint8Array {
  // Mirror Capability::entropy_to_twists in Rust: XOR-salt the bytes with
  // a little-endian counter so each rejection-sampling iteration produces a
  // deterministically different candidate.
  const twists = new Uint8Array(bytes.length * 2);
  const salt = new Uint8Array(8);
  // Pack counter as little-endian u64 (counter fits in u32 here, high bytes 0)
  for (let i = 0; i < 4; i++) salt[i] = (counter >>> (i * 8)) & 0xff;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ^ salt[i % 8];
    const pos = ((b >> 4) & 0x3) * 2;        // → 0,2,4,6  (all positive)
    const neg = ((b & 0x3) * 2) + 1;         // → 1,3,5,7  (all negative)
    twists[i * 2] = pos;
    twists[i * 2 + 1] = neg;
  }
  return twists;
}

export function validateCapability(token: string): boolean {
  if (_wasm) return _wasm.wasm_capability_valid(token);
  const parts = token.split(":");
  if (parts.length < 3 || parts[0] !== "cap") return false;
  // Each char encodes one twist value (0–7). Reject any char outside that range
  // rather than silently filtering, which would let malformed tokens pass.
  const hexStr = parts[2];
  if (hexStr.length === 0 || !/^[0-7]+$/.test(hexStr)) return false;
  const twistBytes = Uint8Array.from([...hexStr].map(c => parseInt(c, 10)));
  return achievesZfa(twistBytes);
}
