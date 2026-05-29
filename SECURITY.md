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
| Bearer-note exfiltration | Held `cap:note-<currency>:…` tokens are pure bearer; URL leakage, clipboard exfil, screen recording, or browser-extension scraping is full compromise |
| Issuer impersonation across sessions | Anyone can `/note declare <currency>`. The room trusts that "Alice's USD" was declared by the peer named Alice; a compromised peer session can mint forgeable authorities |
| Holder double-spend across rooms | A malicious holder can copy a note's bytes before `/note pass`/`/note redeem` and try to spend it in a different room. Same-room re-spend is rejected (token is gone from `noteStore`); cross-room re-spend is undetectable. Wave 3 (dynamic caps) is the planned mitigation. |
| Rendezvous commit divergence | Multi-party commit is best-effort. If `rdv-commit` is lost in flight to some participants, they time out and keep their gives; participants who received it apply the swap, producing transient global conservation violation. True atomicity needs consensus. |
| Proposer-issued asymmetric commits | The proposer signs nothing — each participant validates only its own row. A malicious proposer could in principle deliver mutually inconsistent commits to different participants; downstream inconsistencies surface later but are not prevented at commit time. |
| Sync-envelope authorship forgery | `sync-lemmas` and `sync-currencies` carry per-entry `who` / `issuer` fields. The receiver validates label and ZFA balance but cannot verify the claim. A malicious peer can forward a sync envelope with entries that claim Alice authored a lemma or declared a currency she never touched; receivers will accept these as fact. The live `lemma` and `note-declare` paths are not affected because they derive authorship from the wire-level sender's peer ID. |
| Sync flooding | A malicious peer can stuff a `sync-lemmas` / `sync-currencies` envelope with arbitrarily many balanced entries (each is just a fresh random ZFA-balanced token bearing any claimed label). All pass validation; all land in the receiver's stores. No per-peer or per-envelope cap is enforced. |

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

### Promissory notes, rendezvous, and bearer semantics

The `/note` and `/rdv` features extend the bearer-capability model from peer identity to value-bearing instruments. All defenses scale the same way: possession of bytes is authority; no protocol enforces who *should* possess them.

**Validation at every boundary.** Every inbound envelope that carries a token (`note-declare`, `note-pass`, `note-redeem`, `note-receipt`, `rdv-propose`, `rdv-accept`, `rdv-commit`, `sync-lemmas`, `sync-currencies`) re-parses the label (`parseNoteLabel`), checks the declared currency / denomination matches the embedded twist sequence, and runs `validateCapability` for ZFA balance before mutating local state. Malformed or unbalanced entries are silently dropped.

**Conservation as a typing rule.** `conservationCheck(rows)` rejects rendezvous proposals whose `gives` and `gets` multisets do not match per `(currency, denomination)`. Split and merge on notes preserve `count_pos == count_neg` by construction — a denomination-N note that splits into (a, N−a) produces two ZFA-balanced halves whose lengths sum to the original. The same Lean invariant (`rho_process_always_zfa`) covers these operations.

**Locking, not consensus.** During an in-flight rendezvous, an accepted `gives` token moves from `noteStore` to `lockedNotes`; `/note pass` / `/note redeem` cannot see it. On abort/reject/timeout the lock is released back to `noteStore`. On crash the lock is persisted, but the proposal context is in-memory only — on reload, orphaned locks return to the wallet (so value is never lost across a crash), which means the proposer side may see a stale acceptance that no longer corresponds to a held token. This is the same "best-effort" trust posture as `/note pass`.

**Sync is gossip with structural — not authorship — re-validation.** When a new peer joins, every existing peer sends snapshots of `lemmaStore` and `knownCurrencies` over each new data channel. Each entry is re-validated against the same label and ZFA-balance checks the live `lemma` / `note-declare` handlers use, so malformed or unbalanced entries are silently dropped. **What re-validation does not catch is forged authorship.** A `sync-currencies` entry carries `{ currency, token, issuer }`; a `sync-lemmas` entry carries `{ name, twists, who }`. A malicious peer can construct a fresh ZFA-balanced token of any label and claim any `issuer` / `who`. The receiver will store it as fact because there is no signature scheme that binds the token bytes to a specific identity. The live note-declare and lemma broadcast paths are safe from this — they derive authorship from the wire-level sender's peer ID, which the signaling server validates via `wsIndex` — but the sync envelope's per-entry author claim is structurally untrusted. The planned mitigation is dynamic capabilities (Wave 3): identity becomes a continuously-proven trajectory, and a sync entry's `issuer` field gains a verifiable signature instead of a bare claim.

Held notes, receipts, the issuer's `redemptionsHonored` log, and in-flight rendezvous proposals are *never* gossiped — they're private bearer state.

### The shared root: no consensus

Several of the limits above are facets of the same architectural choice. quantum-os is a peer-to-peer per-room system **with no consensus mechanism**, so it cannot provide global consistency over the room's history. Specifically:

- **Cross-room double-spend** of a bearer note is undetectable because there is no shared nullifier set.
- **Multi-party rendezvous atomicity** is best-effort because there is no agreement protocol that binds all participants to the same commit / abort decision.
- **Sync-envelope authorship forgery** is undetectable because there is no ordered, agreed-upon log of who declared what when.
- **Proposer-issued asymmetric commits** are undetectable at commit time because there is no broadcast-with-equivocation-detection layer.

Each of these has a known solution in the consensus literature — nullifier SMTs in zk-rollups (DarkWow's approach), Byzantine fault tolerant commit (PBFT, HotStuff), append-only signed logs with equivocation detection (CONIKS, Certificate Transparency). quantum-os deliberately omits all of them in exchange for a different set of properties: zero infrastructure, instantaneous per-room operation, and the algebraic guarantee that every individual capability is ZFA-balanced by construction.

**A consensus layer is the right primary mitigation** for the entire class of forge-and-equivocate attacks against the gossip, transfer, and rendezvous flows. The planned wave-3 dynamic-capability work narrows the trust gap by making identity a continuously-proven trajectory (signatures across a ratcheting state), which closes authorship forgery without a global ledger; closing cross-room double-spend and asymmetric commits still requires either consensus or a tamper-evident log.

In the meantime, the bearer-and-room-scoped trust model should be read literally: if you wouldn't hand someone the bytes of a `cap:note-USD:…` token in person, don't `/note pass` it to them, and don't trust a fresh sync envelope from a peer you don't recognize.

---

## Known issues and mitigations

### Current gaps (prioritised)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | No per-message size limit on signaling WebSocket | Medium | Fixed — `maxPayload: 65_536` on `WebSocketServer` |
| 2 | No rate limiting on signaling connections or messages | Medium | Fixed — 20 msg/sec per connection (fixed window) |
| 3 | Peer IDs logged in full on the signaling server | Low | Fixed — logs show last 8 chars only (`…abcd1234`) |
| 4 | Hardcoded Google STUN server leaks peer IPs to Google | Low | Fixed — STUN URL editable in sidebar; empty value disables STUN |
| 5 | Lenient hex parsing in fallback `validateCapability()` | Low | Fixed — rejects tokens with any char outside `[0-7]` |

### Already fixed

| Issue | Fix |
|-------|-----|
| Relay `from` field forgery | `wsIndex` binding in `packages/signaling/src/server.ts` — validates `msg.from` against the sending WebSocket connection |
| No message size limit | `maxPayload: 65_536` on `WebSocketServer` — oversized frames rejected at the protocol layer |
| No rate limiting | Fixed-window rate limiter in `onConnect` — 20 msg/sec per connection; excess messages receive an error and are dropped |
| Full peer/room IDs in logs | Signaling server logs truncated to last 8 chars (`…abcd1234`) |
| Hardcoded Google STUN | STUN URL now user-configurable in the sidebar; defaults to `stun:stun.l.google.com:19302` |
| Lenient hex parsing in `validateCapability()` | Rejects tokens with any char outside `[0-7]` before processing |

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
