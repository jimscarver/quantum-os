# CLAUDE.md — QuantumOS

Project context for Claude Code sessions. Read this before making any changes.

---

## Project overview

**QuantumOS** is a peer-to-peer browser application that makes ZFA (Zero Free Action) capability tokens the live security model of a collaborative computing room. Two or more browser peers connect via WebRTC, share a room identified by a ZFA capability token, and run QLF slash commands (`/qucalc`, `/lemma`, `/braket`, `/zfa`, …) whose results broadcast to all peers.

The ZFA kernel is implemented in Rust (compiled to WASM) and is the same algebraic core as the [Quantum Logical Framework](https://github.com/jimscarver/quantum-logical-framework). Possessing a capability token IS authorization — no server, no accounts, no trust.

**Live deployment:** https://jimscarver.github.io/quantum-os/
**Signaling server:** `wss://quantum-os-signaling.onrender.com` (Render.com, auto-deploys from `packages/signaling/`)

---

## Repository layout

```
quantum-os/
├── crates/
│   └── zfa-core/          Rust library: ZFA kernel (twist algebra, capabilities, processes)
│       └── src/
│           ├── capability.rs   cap:label:hex token generation and validation
│           ├── history.rs      achieves_zfa, spectral_gap, count_pos/neg, is_symmetric
│           ├── process.rs      Form (2×2 Hermitian), Process (RhoQuCalc)
│           ├── twist.rs        Twist enum (8-symbol alphabet)
│           └── wasm.rs         wasm-bindgen exports (feature = "wasm")
├── packages/
│   ├── browser/            Vite + TypeScript browser app (GitHub Pages)
│   │   ├── index.html      Layout + CSS (sidebar, chat, share row)
│   │   └── src/
│   │       ├── app.ts      All UI logic, slash commands, lemma system, peer callbacks
│   │       ├── peer.ts     QOSPeer class — WebRTC + signaling WebSocket
│   │       ├── zfa.ts      Browser-side ZFA helpers (validateCapability, tokenTwists, …)
│   │       └── index.ts    WASM module re-exports
│   ├── signaling/          Node.js WebSocket signaling relay (Render.com)
│   │   └── src/
│   │       ├── server.ts   SignalingServer — join/leave/relay, rate limiting, wsIndex auth
│   │       └── room.ts     Room — peer membership, broadcast helpers
│   └── zfa-core-wasm/      wasm-pack output (generated — do not edit)
├── scripts/                Utility scripts
├── .github/workflows/
│   ├── ci.yml              Rust tests + WASM build + TS typecheck on every push/PR
│   └── pages.yml           Build + deploy to GitHub Pages on every push to main
├── render.yaml             Signaling server deploy config (Render.com)
├── SECURITY.md             Threat model, known issues, dependency audit
└── SyllogismDemo.md        Step-by-step walkthrough of collaborative syllogism proof
```

---

## Key concepts

### ZFA capability tokens

Every peer identity, room ID, and named lemma cap is a `cap:label:hex` token:

```
cap:peer:024602460246024602460246…
     ↑       ↑
  label    hex digits 0–7 only (each is a twist value)
           ZFA-balanced: count of even digits == count of odd digits
```

- Generated with `crypto.getRandomValues()` (browser) or `getrandom` crate (Rust)
- 128-bit entropy; ZFA balance constraint still leaves astronomically large space
- `validateCapability(token)` — checks format and balance
- `tokenTwists(token)` — extracts `Uint8Array` of twist values from hex
- Knowing a room token IS the capability to join (bearer token in URL hash)

### Twist alphabet (8 symbols)

| Symbol | Value | Parity | Name |
|--------|-------|--------|------|
| `^` | 0 | even/pos | Up |
| `v` | 1 | odd/neg | Down |
| `<` | 2 | even/pos | Left |
| `>` | 3 | odd/neg | Right |
| `/` | 4 | even/pos | Slash |
| `\` | 5 | odd/neg | Backslash |
| `+` | 6 | even/pos | Plus |
| `-` | 7 | odd/neg | Minus |

ZFA-balanced = `count_pos == count_neg` (even count == odd count). Spectral gap = `|count_pos - count_neg|`.

### Lemma system

Named logical claims shared across peers, persisted to `localStorage` per room URL.

- `/lemma name` — auto-allocate twists deterministically from the name (same result on every client, no server needed)
- `/lemma name twists` — explicit twists (symbolic, hex, `cap:token`, or `@ref1 @ref2`)
- `@name` in any command arg — expands to the stored twist sequence
- Auto-mints `cap:name:hex` when the result is ZFA-balanced
- Broadcasts `{kind: "lemma", name, twists, cap, who}` to all peers on register
- `allocateTwists(name)`: each character yields one pos twist `(code & 3)*2` and one neg twist `((code>>2)&3)*2+1` — always balanced, always deterministic

### Signaling server trust model

The signaling server is an **untrusted relay**:
- Routes SDP/ICE between peers; never sees WebRTC data channel contents (DTLS-encrypted)
- `wsIndex: Map<WebSocket, string>` — binds each socket to its peerId at join; validates `msg.from` on every relay to prevent forgery
- Rate-limited: 20 msg/sec per connection (fixed window)
- Message size capped at 64 KB (`maxPayload: 65_536`)
- Logs show only last 8 chars of IDs

### Signaling reconnect / false peer left-right

When the signaling WebSocket drops and reconnects (Render.com sleep, network blip):

- **`peer.ts`**: On receiving the `"peers"` list after reconnect, skip peers where the WebRTC data channel is still open — avoids tearing down a working connection
- **`app.ts`**: `onPeerLeft` is debounced 6 seconds via `pendingLeaves: Map<string, timer>`. If the peer rejoins within the window, suppress both "left" and "joined" messages silently

---

## Slash commands (app.ts `handleCommand`)

| Command | Description |
|---------|-------------|
| `/help` | List all commands |
| `/id` | Show your peer ID |
| `/room` | Show room ID |
| `/cap [label]` | Mint a random ZFA capability token |
| `/grant [label]` | Mint and broadcast a capability token |
| `/zfa <token>` | Validate a capability token, show twist stats |
| `/braket <states>` | Evaluate bra-ket (states: 0 1 + - i -i) |
| `/qucalc [twists]` | Evaluate RhoQuCalc twist sequence; accepts `@name` refs |
| `/freq [n\|twists]` | ZFA frequency spectrum (C(2n,n) arrangements) |
| `/lemma [name [tw]]` | Register/list named lemmas; omit twists to auto-allocate |
| `/dump` | Summary of all logic shared this session |
| `//message` | Send a message that starts with `/` |

Broadcasting: all commands except `/help`, `/grant`, `/lemma`, and `/dump` broadcast their output to peers as `{kind: "qlf", cmd, arg, lines}`.

---

## Development workflow

### Local dev

```bash
# 1. Build WASM kernel (required first)
pnpm build:wasm

# 2. Install JS deps
pnpm install

# 3. Run browser dev server (hot reload, port 5173)
pnpm dev:browser

# 4. (Optional) Run signaling server locally
pnpm dev:signaling   # port 4444
```

Change the signaling URL in the sidebar to `ws://localhost:4444` to use a local signaling server.

### Type checking

```bash
cd packages/browser && npx tsc --noEmit
```

Always run before committing browser changes.

### Rust tests

```bash
cargo test --workspace
```

### Build for production

```bash
pnpm build:wasm && pnpm build:browser   # output: packages/browser/dist/
```

### Deployment

- **GitHub Pages**: auto-deploys on every push to `main` via `.github/workflows/pages.yml`
- **Signaling server**: auto-deploys on every push to `main` via `render.yaml` (Render.com watches the repo)
- No manual deploy steps needed

### CI

On every push/PR to `main`:
1. `cargo test --workspace` — Rust unit tests
2. `pnpm build:wasm` + `pnpm build:signaling` + `tsc --noEmit` — WASM build and TS typecheck

Check CI: `gh run list --limit 5`
On failure: `gh run view <run-id> --log-failed`

---

## Key files to know

| File | What to touch it for |
|------|----------------------|
| `packages/browser/src/app.ts` | All slash commands, lemma system, UI logic, peer callbacks |
| `packages/browser/src/peer.ts` | WebRTC connection, signaling reconnect, onPeerJoined/Left |
| `packages/browser/src/zfa.ts` | Browser-side ZFA helpers (validateCapability, twistStats, …) |
| `packages/browser/index.html` | Layout, CSS, sidebar structure |
| `packages/signaling/src/server.ts` | Signaling relay, rate limiting, relay auth |
| `packages/signaling/src/room.ts` | Room membership, broadcast |
| `crates/zfa-core/src/` | ZFA kernel in Rust (capability, twist algebra, WASM exports) |
| `SECURITY.md` | Threat model and known issues — update when fixing security bugs |
| `SyllogismDemo.md` | End-user walkthrough — update when UX or commands change |

---

## Philosophical foundations (shared with QLF)

QuantumOS is the **executable instantiation** of the Quantum Logical Framework. The ZFA capability model is not an analogy — it is the same algebraic invariant that QLF machine-verifies in Lean 4:

- `rho_process_always_zfa` — parallel composition stays ZFA-balanced
- `decoherence_impossibility` — no operation can break ZFA balance
- `bra_ket_always_balanced` — bra-ket well-typedness IS ZFA balance

In a classical OS, security, scheduling, error correction, and garbage collection are separate subsystems. In QuantumOS all five are the same operation — ZFA enforcement — because possessing a capability token IS proof of authorization (Curry-Howard). The room process `parallel(peer1, peer2, …)` is machine-verified to stay balanced under composition.

See [QLF CLAUDE.md](../quantum-logical-framework/CLAUDE.md) and [AI.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/AI.md) for the full theoretical background.

### What NOT to say

- Do not describe the signaling server as trusted — it is an explicit untrusted relay
- Do not describe ZFA tokens as "passwords" or "API keys" — possessing the token IS the capability, with no separate authentication step
- Do not describe lemma auto-allocation as random — it is deterministic from the name, giving identical results on every client
- Do not describe the room as a server — the room is the emergent ZFA process of the peers; the signaling server only routes handshakes
