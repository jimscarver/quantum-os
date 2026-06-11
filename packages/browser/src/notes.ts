/// Promissory notes — bearer instruments as ZFA twist sequences.
///
/// A note is a capability `cap:note-<currency>:<balanced hex>` whose
/// denomination is `hex.length / 2`. Conservation falls out of the existing
/// ZFA balance invariant: split and merge preserve `count_pos == count_neg`.
///
/// Lifecycle (after DarkWow's TokenMint → Mint → Transfer → Redeem):
///   declare   — issuer mints `cap:token-<currency>:…` (their authority)
///   grant     — holder of the token mints `cap:note-<currency>:hex(2N)`
///   pass      — transfer to peer; auto-splits if held denomination > N
///   redeem    — return to issuer; receive `cap:receipt-<currency>:hex(2N)`
///   split     — partition (a, N−a) keeping ZFA balance in each half
///   merge     — concatenate two notes of the same currency

import { generateCapability } from "./zfa.js";

export type NoteKind = "note" | "token" | "receipt";

// A note may be stamped with a terms "series": cap:note-<base>~<termsHash8>:<hex>.
// `currency` is the FULL unit id (e.g. "USD~a1b2") — split/merge/balance treat
// each series as its own non-fungible unit. `baseCurrency` is the issuer's
// declared currency ("USD"); `series` is the terms stamp (hex) or null.
export interface ParsedLabel { kind: NoteKind; currency: string; baseCurrency: string; series: string | null; }

export function parseNoteLabel(token: string): ParsedLabel | null {
  const parts = token.split(":");
  if (parts.length < 3 || parts[0] !== "cap") return null;
  const m = parts[1].match(/^(note|token|receipt)-([A-Za-z0-9_]+(?:~[0-9a-f]+)?)$/);
  if (!m) return null;
  const currency = m[2];
  const tilde = currency.indexOf("~");
  const baseCurrency = tilde === -1 ? currency : currency.slice(0, tilde);
  const series = tilde === -1 ? null : currency.slice(tilde + 1);
  return { kind: m[1] as NoteKind, currency, baseCurrency, series };
}

// Deterministic short stamp for a terms text (FNV-1a 32-bit → 8 hex). The
// issuer's dyncap-signed series declaration — not the hash's strength — is what
// authoritatively binds a stamp to its terms text, so a fast hash is fine here;
// this just turns terms into a stable, collision-light series id.
export function termsHash8(text: string): string {
  const s = text.trim().replace(/\s+/g, " ");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function seriesKey(baseCurrency: string, hash8: string): string {
  return `${baseCurrency}~${hash8}`;
}

export function denomination(token: string): number {
  const parts = token.split(":");
  if (parts.length < 3) return 0;
  return Math.floor(parts[2].length / 2);
}

/// Generate a ZFA-balanced hex string of length 2N (N pos + N neg twists).
function balancedHex(n: number): string {
  if (n < 1) throw new Error("denomination must be >= 1");
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) {
    const pos = (b & 0x3) * 2;             // 0, 2, 4, 6 — positive twists
    const neg = ((b >> 2) & 0x3) * 2 + 1;  // 1, 3, 5, 7 — negative twists
    hex += pos.toString(16) + neg.toString(16);
  }
  return hex;
}

export function mintCurrencyToken(currency: string): string {
  return generateCapability(`token-${currency}`);
}

export function mintNote(currency: string, n: number): string {
  return `cap:note-${currency}:${balancedHex(n)}`;
}

// Mint a terms-stamped note: cap:note-<base>~<hash8>:<hex>. The stamp travels
// in the currency segment, so split/merge carry it untouched.
export function mintNoteSeries(baseCurrency: string, hash8: string, n: number): string {
  return `cap:note-${baseCurrency}~${hash8}:${balancedHex(n)}`;
}

export function mintReceipt(currency: string, n: number): string {
  return `cap:receipt-${currency}:${balancedHex(n)}`;
}

/// Split a note into (left of denomination `a`, right of denomination N−a).
/// Both halves are ZFA-balanced by construction: walk the hex once, fill the
/// left with the first `a` positive and first `a` negative digits, route the
/// rest to the right.
export function splitNote(token: string, a: number): [string, string] | null {
  const parsed = parseNoteLabel(token);
  if (!parsed || parsed.kind !== "note") return null;
  const N = denomination(token);
  if (a < 1 || a >= N) return null;
  const hex = token.split(":")[2];
  const POS = new Set(["0", "2", "4", "6"]);
  const left: string[] = [];
  const right: string[] = [];
  let lp = 0, ln = 0;
  for (const c of hex) {
    if (POS.has(c)) {
      if (lp < a) { left.push(c); lp++; } else right.push(c);
    } else {
      if (ln < a) { left.push(c); ln++; } else right.push(c);
    }
  }
  return [
    `cap:note-${parsed.currency}:${left.join("")}`,
    `cap:note-${parsed.currency}:${right.join("")}`,
  ];
}

export function mergeNotes(t1: string, t2: string): string | null {
  const p1 = parseNoteLabel(t1);
  const p2 = parseNoteLabel(t2);
  if (!p1 || !p2 || p1.kind !== "note" || p2.kind !== "note") return null;
  if (p1.currency !== p2.currency) return null;
  return `cap:note-${p1.currency}:${t1.split(":")[2]}${t2.split(":")[2]}`;
}
