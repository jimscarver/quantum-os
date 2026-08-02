// ---------------------------------------------------------------------------
// vault.ts — password-based encryption of a QuantumOS identity.
//
// The durable identity is the 32-byte dyncap seed (see dyncap.ts). To carry it
// to another browser, we encrypt the serialized dyncap state under a password
// and hand the user a self-contained recovery string. Password → key uses
// PBKDF2-SHA256 (high iteration count); the payload is sealed with AES-GCM,
// whose authentication tag doubles as a wrong-password / tamper detector.
//
// This is the only AES usage in the package; SHA-256 lives in dyncap.ts. Hex
// helpers are reused from there so the on-wire encoding matches the rest of the
// substrate (lowercase hex throughout).
// ---------------------------------------------------------------------------

import { toHex, fromHex } from "./dyncap.js";

const VAULT_PREFIX = "qos-vault";
const VAULT_VERSION = "v1";
// OWASP-ish floor for PBKDF2-SHA256 in a browser. High enough to make an
// offline brute-force of a leaked vault costly, low enough to derive in well
// under a second on commodity hardware.
const PBKDF2_ITERS = 210_000;
const SALT_BYTES = 16;
const IV_BYTES = 12; // AES-GCM standard nonce length

// The `as BufferSource` casts quiet TS strictness about Uint8Array possibly
// being SharedArrayBuffer-backed; ours are all ArrayBuffer-backed (mirrors the
// same note in dyncap.ts's sha256).
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/// Encrypt `plaintext` under `password`. Returns a self-contained recovery
/// string `qos-vault:v1:<saltHex>:<ivHex>:<ctHex>` (ct includes the GCM tag).
/// A fresh random salt + IV are drawn per call, so encrypting the same identity
/// twice yields different strings — never reuse a (key, IV) pair.
export async function encryptVault(password: string, plaintext: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext) as BufferSource,
  );
  const ct = new Uint8Array(ctBuf);
  return [VAULT_PREFIX, VAULT_VERSION, toHex(salt), toHex(iv), toHex(ct)].join(":");
}

/// Decrypt a recovery string produced by `encryptVault`. Returns the plaintext,
/// or `null` for any failure — wrong password, tampered ciphertext, or a
/// malformed/unknown-version string — so callers can show one clean message
/// without leaking which failure occurred.
export async function decryptVault(password: string, vault: string): Promise<string | null> {
  const parts = vault.trim().split(":");
  if (parts.length !== 5) return null;
  const [prefix, version, saltHex, ivHex, ctHex] = parts;
  if (prefix !== VAULT_PREFIX || version !== VAULT_VERSION) return null;
  if (!/^[0-9a-f]+$/i.test(saltHex + ivHex + ctHex)) return null;
  try {
    const salt = fromHex(saltHex);
    const iv = fromHex(ivHex);
    const ct = fromHex(ctHex);
    const key = await deriveKey(password, salt);
    const ptBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ct as BufferSource,
    );
    return new TextDecoder().decode(ptBuf);
  } catch {
    // AES-GCM decrypt throws (OperationError) on tag mismatch = wrong password
    // or tampering. fromHex may also throw on odd-length input.
    return null;
  }
}

/// True if `s` looks like a vault recovery string (cheap shape check, no crypto).
export function looksLikeVault(s: string): boolean {
  return s.trim().startsWith(`${VAULT_PREFIX}:${VAULT_VERSION}:`);
}
