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
| Envelope authorship after TOFU | `/dyncap` ties each signable envelope to its sender's `H(seed)` anchor; once TOFU-pinned, mismatches and forks are detected and surfaced. Covers `name`, `lemma`, `note-declare`, and the outer `sync-*` envelopes. |

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
| Holder double-spend across rooms | A malicious holder can copy a note's bytes before `/note pass`/`/note redeem` and try to spend it in a different room. Same-room re-spend is rejected (token is gone from `noteStore`); cross-room re-spend is undetectable. Dyncap did not close this — its chain trajectories are per-room by design (see "Multi-room blanket isolation" below). Closing it would require a shared nullifier set, which means consensus — out of scope. |
| Rendezvous commit divergence | Multi-party commit is best-effort. If `rdv-commit` is lost in flight to some participants, they time out and keep their gives; participants who received it apply the swap, producing transient global conservation violation. True atomicity needs consensus. |
| Proposer-issued asymmetric commits | The proposer signs nothing — each participant validates only its own row. A malicious proposer could in principle deliver mutually inconsistent commits to different participants; downstream inconsistencies surface later but are not prevented at commit time. |
| Sync-envelope authorship forgery (further mitigated) | `sync-lemmas` and `sync-currencies` forward per-entry `who` / `issuer` claims and the original signer's `dyncap`. The receiver validates label, ZFA balance, and the *outer* sync envelope's dyncap against the forwarder's TOFU-pinned anchor. **The joiner-local consensus probe (`/probe`) now also tallies inbound sync envelopes from up to 5 peers on join, applies a chain-weighted supermajority resolution, and adds losing peers to `ignoredForSync`** — a forger now needs to command supermajority weight, not merely be first to reply. *Inner-entry* dyncap verification against the original author's anchor (cross-peer anchor lookup) is still not wired; without it, a malicious forwarder can substitute entries authored by peers the receiver has not directly handshaked with, though the probe will surface any disagreement those substitutions cause. Live `lemma` and `note-declare` paths are fully covered by dyncap once the sender's anchor is TOFU-pinned. |
| Sync flooding | A malicious peer can stuff a `sync-lemmas` / `sync-currencies` envelope with arbitrarily many balanced entries (each is just a fresh random ZFA-balanced token bearing any claimed label). All pass validation; all land in the receiver's stores. No per-peer or per-envelope cap is enforced. Dyncap does not address this — it scopes authorship, not volume. |
| Dyncap clone race | An attacker who exfiltrates a peer's seed and broadcasts a `name` envelope *before* the legitimate peer in a fresh room wins the TOFU pin. The legitimate peer's subsequent envelopes will then be rejected as anchor-mismatched in that room. Hash-only identity cannot close this; signature-strength identity could. |

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

### Dynamic capabilities (`/dyncap`) — hash-only identity layer

A peer's identity is a 32-byte secret `seed` (per-device, persisted to `localStorage` outside the per-room namespace) plus a derived public anchor `H(seed)`. Signable envelopes (`name`, `lemma`, `note-declare`, `sync-lemmas`, `sync-currencies`) carry a `dyncap: { anchor, seq, witness }` field, where `witness = H(seed || seq_le32 || room_id_bytes || payload_hash)`. The `room_id_bytes` binding keeps the chain from being replayed across rooms.

Receivers maintain per-peer chain state keyed by peer ID. The first envelope's anchor is TOFU-pinned. Subsequent envelopes must use the same anchor, must carry a strictly higher `seq` than already seen (per `(anchor, seq)`), and must produce a `witness` distinct from any previously accepted at the same seq. Two valid envelopes at the same `seq` under the same anchor — a *fork* — flag the peer's chain `contested` and surface a `⚠` chat warning.

**What dyncap closes.** Live `lemma` and `note-declare` envelopes are now bound to their sender's TOFU-anchored chain; a malicious peer cannot forge an envelope claiming to come from a different peer's anchor (mismatch is detected on receipt). The sync envelope itself is also signed by the forwarder.

**What dyncap does not close.** The MVP does not actively re-verify forwarded sync entries against the *original* author's anchor — a malicious forwarder can substitute entries authored by peers the receiver hasn't directly handshaked with (see threat row above). The fork-detection guarantee holds only against equivocation that both halves of the fork eventually reach the same receiver; clones broadcasting to disjoint subsets of the room remain invisible to each other until those subsets compare notes. And the initial TOFU is racy: a clone with a stolen seed who broadcasts first in a fresh room wins the anchor.

**Why hash-only.** The QLF philosophy is that the algebra is the security; importing an asymmetric primitive (Ed25519 etc.) would put a fundamentally different trust mechanism alongside ZFA balance. Hash-only dyncap stays within the same algebraic universe at the cost of TOFU semantics and the clone-race vulnerability. Use [MultisigDemo.md](MultisigDemo.md) as a guide to what dyncap + rendezvous together can attest to in practice.

### Discrepancy probe (`/probe`) — joiner-local supermajority resolution

The full reference is [Consensus.md](Consensus.md); the security-architecture summary:

When a peer joins a room, `onSignalingOpen` opens a probe window that collects inbound `sync-lemmas` / `sync-currencies` envelopes from up to `SAMPLE_SIZE` (5) distinct peers within `PROBE_WINDOW_MS` (5 s). On close, `findDiscrepancies` tallies each contested key by **weight**, not by count: each contributor's vote weight is their dyncap chain depth (`dyncapChains[peer].lastSeq`, floor 1). The winning value must clear a strict **2/3 supermajority** of total weight. If it does, the joiner adopts the winner locally, broadcasts a `state-discrepancy` envelope so the room sees the disagreement, and adds the peers behind every losing bucket to `ignoredForSync` — their subsequent sync envelopes are silently dropped. If no value clears the threshold, the discrepancy is broadcast with `winner: null` and the joiner keeps its existing local state.

This raises the bar on three attacks: single-Sybil sync forgery (must now command supermajority weight, not just arrive first), sync flooding with fresh identities (each weighted at the floor of 1, so the forger needs many aged identities), and equivocating peers (the discrepancy is broadcast even when no winner clears the threshold, so the room sees the disagreement).

**It is not classical Byzantine fault tolerance.** Resolution is *joiner-local*: non-joining peers log the broadcast but do not auto-update. Each new joiner reaches their own decision; the room's views can persistently diverge. Coordinated aged-identity Sybils can still buy their way to supermajority weight; the dyncap clone-race remains; cross-room resolution is absent. The probe also relies on **lemma immutability** — once `@name` is declared, both the dispatcher and the inbound `lemma` handler refuse re-declaration with different twists. Without that fix the probe would be tallying accidental overwrites rather than real disagreement.

For full BFT (Castro-Liskov, HotStuff, Tendermint, …) the system would need real signed messages, a stable peer view with `n ≥ 3f + 1`, and a global ordered log with finality. Each is outside the QLF philosophy of algebra-as-security. The probe is the highest layer this project pushes "consensus" before that boundary; deeper is a different system.

### Multi-room blanket isolation (`/room`)

A single browser session can join N rooms simultaneously. Each room is a **separate Markov blanket** — independent peer set, lemma store, currency registry, dyncap chain trajectory, consensus probe, and signaling connection. Per the QLF philosophy: external (other rooms) is conditionally independent of internal (this room's interior) given the room's sensory/active envelope surface.

What this gives:
- **No cross-room signaling backchannel.** Each room has its own `QOSPeer` and signaling WebSocket. Messages routed by the relay never cross rooms.
- **No cross-room state sync.** A lemma declared in room A doesn't auto-propagate to room B. Sync envelopes stay scoped to the room they were authored in.
- **No cross-room consensus.** The probe runs per-room; a discrepancy in room A is invisible to room B.
- **Independent chain trajectories.** A peer's dyncap anchor (`H(seed)`) is the same across rooms (same per-device seed) but the `seq` counter is per-room. Witnesses (`H(seed ‖ seq ‖ room_id ‖ payload_hash)`) are algebraically independent — a peer's chain in room A reveals nothing about their chain in room B.
- **Background-room state mutations are correctly isolated.** Callbacks from a non-viewed tab's QOSPeer execute against the room that owns them (via `setActiveRoom(ctx)` at callback entry, with try/finally restoration and per-`await` re-assertion in `onMessage`). DOM-touching code further guards with `isUiActive()` so the visible tab isn't disturbed.

What remains the user's responsibility (cross-room is by design **explicit**):
- **Bridge peers are application-level.** A peer in rooms A and B can manually re-declare a lemma or re-grant a note in each room; that re-declaration produces a fresh chain step in the target room with that peer's dyncap signature *in that room*. There's no protocol-level cross-room envelope.
- **Cross-room replay is undetectable.** A note minted in room A whose bytes are copied into room B will validate (it's a ZFA-balanced cap) but its issuer's authority in room A means nothing in room B. The room B audience must independently TOFU the issuer's dyncap anchor in room B.
- **Resource: simultaneous WebRTC connections.** Each joined+connected room holds an active signaling socket + data channels. Practical cap is dozens of rooms per browser session; beyond that, memory and battery start to matter.

This is not a *threat* mitigated — it's a *design choice* that the threat model articulates: cross-room continuity is deliberately absent. The Markov-blanket framing makes the absence explicit and turns the previously-vague "out of scope" cross-room rows in this document into a coherent invariant: *the algebra cannot reach across blankets without an explicit bridge peer.*

### The shared root: no consensus

Several of the limits above are facets of the same architectural choice. quantum-os is a peer-to-peer per-room system **with no consensus mechanism**, so it cannot provide global consistency over the room's history. Specifically:

- **Cross-room double-spend** of a bearer note is undetectable because there is no shared nullifier set.
- **Multi-party rendezvous atomicity** is best-effort because there is no agreement protocol that binds all participants to the same commit / abort decision.
- **Sync-envelope authorship forgery** is undetectable because there is no ordered, agreed-upon log of who declared what when.
- **Proposer-issued asymmetric commits** are undetectable at commit time because there is no broadcast-with-equivocation-detection layer.

Each of these has a known solution in the consensus literature — nullifier SMTs in zk-rollups (DarkWow's approach), Byzantine fault tolerant commit (PBFT, HotStuff), append-only signed logs with equivocation detection (CONIKS, Certificate Transparency). quantum-os deliberately omits all of them in exchange for a different set of properties: zero infrastructure, instantaneous per-room operation, and the algebraic guarantee that every individual capability is ZFA-balanced by construction.

**A consensus layer is the right primary mitigation** for the entire class of forge-and-equivocate attacks against the gossip, transfer, and rendezvous flows. The shipped joiner-local consensus probe (chain-weighted supermajority on a 5-peer sample) is a partial step in that direction — it raises the attacker cost on the sync path but does not bind non-joining peers and does not provide finality. Dyncap closed authorship forgery on the live broadcast path; closing cross-room double-spend and asymmetric commits still requires real signatures with a stable view (classical BFT) or a global ordered log (a blockchain consensus layer).

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
| 6 | Sync inner-entry dyncap not re-verified against original author's anchor | Medium | Open — `sync-lemmas` / `sync-currencies` carry forwarded entries with the original signer's dyncap, but the receiver only verifies the outer envelope. A malicious forwarder can substitute entries authored by peers the receiver has not directly handshaked with. Fix requires a cross-peer anchor lookup table. |
| 7 | Dyncap seed clone wins TOFU race | High (if seed leaks) | Mitigated only by seed secrecy. Fundamental for hash-only identity; full mitigation requires signature-strength identity (out of scope for the QLF philosophy). |

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
