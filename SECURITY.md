# Security

## Threat model

quantum-os is a peer-to-peer browser application. The security boundary is the **ZFA capability token** — a cryptographically unguessable, algebraically unforgeable identifier. Possessing a token IS the capability to act (Curry-Howard for capabilities). The signaling server is an untrusted relay and is explicitly outside the trust boundary.

### What the system defends against

| Threat | Mechanism |
|--------|-----------|
| Identity forgery | Peer IDs are 128-bit random ZFA-balanced tokens; guessing one is computationally infeasible |
| Unauthorized room access | Room IDs are ZFA capability tokens; no token = no join |
| SDP/ICE relay forgery | Signaling server binds each `peerId` to its WebSocket; relayed `from` fields are validated server-side |
| Eavesdropping on peer data | WebRTC DTLS + SRTP encrypt all data channel traffic end-to-end; the signaling server never sees payloads |
| Capability decoherence | `decoherence_impossibility` (machine-verified in Lean 4): `parallel(peer1, peer2, …)` stays ZFA-balanced by construction |

### What the system does NOT defend against

| Threat | Notes |
|--------|-------|
| Compromised browser / OS | If the client environment is compromised, RNG and capability storage are untrusted |
| Sybil attacks | Anyone with the room URL can join; the signaling server imposes no per-identity limit |
| Signaling server operator | The operator can observe room membership (who joined when) and disrupt signaling; they cannot read peer data |
| STUN server IP disclosure | ICE candidate gathering uses `stun.l.google.com`; Google observes peer IPs. Use a self-hosted STUN/TURN server to avoid this. |
| Physical link intercept | Signaling channel uses WSS (TLS) in production; a CA compromise could allow MITM of signaling (but not WebRTC data channels) |

---

## Security architecture

### ZFA capability tokens

Every peer identity, room ID, and granted capability is a `cap:label:hex` token:

```
cap:room:024602460246024602460246…
     ↑       ↑
  label    32 hex digits (16 bytes = 128-bit entropy)
           ZFA-balanced (count_pos == count_neg)
```

Tokens are generated using `crypto.getRandomValues()` (browser) or the `getrandom` crate (Rust/WASM), which calls `crypto.getRandomValues()` internally. Entropy: 128 bits. The ZFA balance constraint reduces the output space, but the remaining space is still astronomically large for 32-twist tokens.

The ZFA balance invariant is machine-verified in [Lean 4](https://github.com/jimscarver/quantum-logical-framework):

- `achieves_ZFA` — the physical balance condition
- `rho_process_always_zfa` — parallel composition stays balanced
- `decoherence_impossibility` — no operation can break ZFA balance

Rust source: [`crates/zfa-core/src/capability.rs`](crates/zfa-core/src/capability.rs)

### Signaling server trust model

The signaling server (`packages/signaling/`) is a **thin WebSocket relay**. It:

- Routes SDP offers, answers, and ICE candidates between peers
- Tracks room membership (peer join/leave)
- Never sees WebRTC data channel contents (these are DTLS-encrypted peer-to-peer)

**Relay forgery protection:** the server maintains a `ws → peerId` index populated at join time. Every relay message (`offer`, `answer`, `ice`) is rejected with an error if the `from` field does not match the peer ID registered for the sending connection. A peer cannot forge messages as if they came from another peer.

```typescript
// packages/signaling/src/server.ts
if (this.wsIndex.get(ws) !== msg.from) {
  this.send(ws, { type: "error", message: "relay from mismatch" });
  return;
}
```

**Room ID as capability:** the signaling server does not enforce authentication. Knowing the room ID IS the capability to join — consistent with the ZFA model. The room URL hash (`#room=cap:room:…`) is the bearer token.

### WebRTC transport security

All peer-to-peer data channel traffic is protected by the WebRTC security stack:

- **DTLS 1.2** for key exchange and authentication
- **SRTP** for data channel encryption
- ICE candidates are gathered via STUN (`stun.l.google.com:19302` by default)

The signaling server's SDP relay cannot be used to MITM the WebRTC connection — each peer's DTLS certificate fingerprint is included in the SDP and verified during the DTLS handshake.

---

## Known issues and mitigations

### Current gaps (prioritised)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | No per-message size limit on signaling WebSocket | Medium | Fixed — `maxPayload: 65_536` on `WebSocketServer` |
| 2 | No rate limiting on signaling connections or messages | Medium | Fixed — 20 msg/sec per connection (fixed window) |
| 3 | Peer IDs logged in full on the signaling server | Low | Open — truncate to last 8 chars |
| 4 | Hardcoded Google STUN server leaks peer IPs to Google | Low | Open — allow custom STUN config |
| 5 | Lenient hex parsing in fallback `validateCapability()` | Low | Open — strict 0-7 char validation |

### Already fixed

| Issue | Fix |
|-------|-----|
| Relay `from` field forgery | `wsIndex` binding in `packages/signaling/src/server.ts` — validates `msg.from` against the sending WebSocket connection |
| No message size limit | `maxPayload: 65_536` on `WebSocketServer` — oversized frames rejected at the protocol layer |
| No rate limiting | Fixed-window rate limiter in `onConnect` — 20 msg/sec per connection; excess messages receive an error and are dropped |

---

## Dependency security

| Dependency | Version | Role | Notes |
|------------|---------|------|-------|
| `ws` | ^8.17.0 | WebSocket server | Actively maintained; no known CVEs |
| `wasm-bindgen` | 0.2 | Rust ↔ JS bridge | Standard; generated by wasm-pack |
| `getrandom` | 0.2 | Cryptographic RNG | Uses OS entropy (`/dev/urandom` / `crypto.getRandomValues()`) |
| `vite` | ^5.0.0 | Browser bundler | Dev/build only; not in production bundle |

Dependencies are pinned via `pnpm-lock.yaml` and `Cargo.lock`. Run `cargo audit` and `pnpm audit` to check for known vulnerabilities.

```bash
cargo install cargo-audit
cargo audit
pnpm audit
```

---

## Reporting a vulnerability

Please report security vulnerabilities by opening a [GitHub issue](https://github.com/jimscarver/quantum-os/issues) marked **[security]**, or by emailing the maintainer directly. Do not include exploit code in public issues.

Responsible disclosure: allow 30 days for a fix before public disclosure.
