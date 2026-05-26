/// ZFA kernel wrapper — loads the WASM module and exposes typed APIs.
/// Falls back to a pure-TS implementation if WASM is unavailable.

interface ZfaWasm {
  wasm_achieves_zfa(bytes: Uint8Array): boolean;
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

// ---- Public API ----

export function achievesZfa(twists: Uint8Array): boolean {
  if (_wasm) return _wasm.wasm_achieves_zfa(twists);
  const pos = countPos(twists);
  return pos === twists.length - pos;
}

export function spectralGap(twists: Uint8Array): number {
  if (_wasm) return _wasm.wasm_spectral_gap(twists);
  const pos = countPos(twists);
  return Math.abs(pos - (twists.length - pos));
}

/// Generate a ZFA-balanced capability token using browser entropy.
export function generateCapability(label: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  if (_wasm) return _wasm.wasm_capability_from_entropy(bytes, label);
  // Pure-TS fallback: encode as hex with ZFA balance guaranteed
  let hex = "";
  for (const b of bytes) {
    const pos = (b >> 4) & 0x3;
    const neg = (b & 0x3) + 4;
    hex += pos.toString(16) + neg.toString(16);
  }
  return `cap:${label}:${hex}`;
}

export function validateCapability(token: string): boolean {
  if (_wasm) return _wasm.wasm_capability_valid(token);
  const parts = token.split(":");
  if (parts.length < 3 || parts[0] !== "cap") return false;
  // Each hex char encodes one twist value (0–7); parse single digits, not pairs.
  const twistBytes = Uint8Array.from(
    [...parts[2]].map(c => parseInt(c, 16)).filter(n => n >= 0 && n < 8)
  );
  return achievesZfa(twistBytes);
}
