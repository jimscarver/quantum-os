# quantum-os

Peer-to-peer QuantumOS running in the browser. ZFA kernel in Rust/WASM, WebRTC data channels for transport, self-hosted signaling server.

**[Open a room →](https://jimscarver.github.io/quantum-os/)**

### How to connect with another peer

1. Open **https://jimscarver.github.io/quantum-os/** in your browser.
2. Click **Connect** — the app joins a room identified by the URL hash and shows your peer ID.
3. Copy the share link at the bottom of the page and send it to someone, or open it in a second tab.
4. The second browser loads the same room URL and clicks **Connect**.
5. Both peers see each other in the **Peers** list and can send messages.

The room URL encodes a ZFA capability token in the hash (`#room=cap:room:…`). Anyone with the link can join — no account needed. The public signaling server (`wss://quantum-os-signaling.fly.dev`) is used by default; edit the field to point at a self-hosted server.

**Foundation:** [Quantum Logical Framework](https://github.com/jimscarver/quantum-logical-framework) — ZFA (Zero Free Action) is the security model. Every peer identity is a ZFA-balanced capability token. Possessing a token IS authorization (Curry-Howard for capabilities).

---

## Architecture

```
crates/
  zfa-core/          Rust — ZFA kernel
                     → compiles to WASM (browser) and native binary (server)

packages/
  zfa-core-wasm/     wasm-pack output (build artifact, not committed)
  signaling/         TypeScript — WebSocket signaling server (port 4444)
  browser/           TypeScript — WebRTC peer, loads ZFA WASM
```

**Monorepo:** Cargo workspace + pnpm workspace.

---

## ZFA Security Model

The 8-twist alphabet `{^, v, <, >, /, \, +, -}` encodes all processes. A history is **ZFA-balanced** when `count_pos = count_neg` (spectral gap = 0). Every capability token, peer identity, and room ID is ZFA-balanced by construction — unbalanced tokens are algebraically impossible to construct, not merely rejected at runtime.

Key invariants (machine-verified in [QLF](https://github.com/jimscarver/quantum-logical-framework)):
- `achieves_zfa` — the physical ZFA condition
- `spectral_gap = 0 ↔ is_symmetric` — eigenvalue-level stability
- `decoherence_impossibility` — parallel composition stays ZFA-balanced
- `no_magnetic_monopoles` — Gauss law from ZFA (∇·B = 0)

---

## Quick Start

```bash
bash scripts/setup.sh   # installs Rust, wasm-pack, Node, pnpm; builds everything
```

Then in two terminals:

```bash
pnpm dev:signaling      # WebSocket signaling server on ws://localhost:4444
pnpm dev:browser        # browser dev server (Vite)
```

### Manual setup

```bash
# 1. Rust + wasm-pack
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install wasm-pack
rustup target add wasm32-unknown-unknown

# 2. Node + pnpm
# install Node 20+ via nvm or your package manager
npm install -g pnpm

# 3. Build WASM kernel (must run before pnpm install)
pnpm build:wasm

# 4. JS dependencies
pnpm install

# 5. Build signaling server
pnpm build:signaling
```

---

## In-app QLF slash commands

Type these in the chat input after connecting. The `/help` list is shown automatically at startup.

### `/help`
Lists all available commands.
```
QLF slash commands:
  /help        — show this help
  /id          — your peer ID and ZFA proof
  /room        — room capability token
  /cap [label] — generate a new ZFA capability
  /zfa [token] — validate a capability token
  /braket      — bra-ket duality via ZFA
  /qucalc      — your peer as a RhoQuCalc process
  //message    — send a message starting with /
```

### `/id`
Shows your ZFA-balanced peer identity and confirms the `rho_process_always_zfa` invariant holds.
```
peer ID: cap:peer:024602460246024602460246…
  twists: 32  (16 positive, 16 negative)
  ZFA-balanced: ✓  spectral gap: 0
  rho_process_always_zfa: ✓ (Lean-verified)
```
Lean anchor: [`rho_process_always_zfa`](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/RhoQuCalc.lean)

### `/room`
Shows the current room's ZFA capability token.
```
room: cap:room:024602460246024602460246…
  twists: 32  (16 pos, 16 neg)  gap: 0  ZFA: ✓
```

### `/cap [label]`
Generates a fresh ZFA-balanced capability token with the given label (default `cap`).
```
generated: cap:peer:024602460246024602460246…
  twists: 32  (16 pos, 16 neg)  ZFA-balanced: ✓
```
Rust source: [`crates/zfa-core/src/capability.rs`](crates/zfa-core/src/capability.rs)

### `/zfa [token]`
Validates any `cap:label:hex` token — checks ZFA balance and reports the spectral gap.
```
/zfa cap:room:024602460246024602460246…
  valid: ✓  spectral gap: 0
  twists: 32 (16 positive, 16 negative)
```
Lean anchor: [`achieves_ZFA`](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/QLF_Axioms.lean)

### `/braket`
Demonstrates bra-ket duality as ZFA balance: `action(f)` is the ket `|ψ⟩`, `lift(f)` is the bra `⟨ψ|`. Both achieve ZFA by construction. Two fresh capability tokens are generated — one labeled `ket`, one `bra` — each 32 twists, 16 positive / 16 negative.

Input:
```
/braket
```
Output:
```
· bra-ket duality (ZFA / RhoQuCalc):
· |ψ⟩  action(Form)  twists [+,−]  eval = f.toMatrix
· ⟨ψ|  lift(Form)    twists [−,+]  eval = f.toMatrix†
· both ZFA-balanced: ✓  spectral gap: 0
· bra_ket_always_balanced: ✓ (BraKetRhoQuCalc.lean)
· sample ket: cap:ket:47214365214747210367270165450523
· sample bra: cap:bra:43270765472103250765614143652367
```
Lean anchor: [`bra_ket_always_balanced`](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/BraKetRhoQuCalc.lean)

### `/qucalc`
Shows your peer ID as a RhoQuCalc process tree — the same algebra used in the Lean proofs.

Input:
```
/qucalc
```
Output:
```
· RhoQuCalc process (this peer):
· action(f) ≅ |ψ⟩   twist: [+,−]   eval = f.toMatrix
· lift(f)   ≅ ⟨ψ|   twist: [−,+]   eval = f.toMatrix†
· parallel(action,lift)  → ZFA-balanced superposition
· rho_process_always_zfa: ✓ (Lean-verified)
· peer ID: cap:peer:45456323610301276721454361630503
· twists: 32 (16 pos / 16 neg)  spectral gap: 0
```
Lean anchors: [`RhoProcess`](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/RhoQuCalc.lean) · [`BraKetRhoQuCalc`](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/BraKetRhoQuCalc.lean)

### `//message`
Sends a literal message that starts with `/` (escapes the command prefix).

---

## Build commands

| Command | What it does |
|---|---|
| `pnpm test:rust` | Run all Rust unit tests |
| `pnpm build:wasm` | Build `crates/zfa-core` → WASM via wasm-pack |
| `pnpm build:signaling` | Compile signaling server TypeScript |
| `pnpm dev:signaling` | Start signaling server (ws://localhost:4444) |
| `pnpm dev:browser` | Vite dev server for browser peer |
| `pnpm build` | Full build: WASM + signaling + browser |

---

## Using the Browser Peer

```typescript
import { loadZfa, generateCapability, QOSPeer } from "@quantum-os/browser";

// Load ZFA WASM kernel
await loadZfa();

// Every room is identified by a ZFA capability token
const roomId = generateCapability("room");

const peer = new QOSPeer({
  signalingUrl: "ws://localhost:4444",
  roomId,
  onMessage: (from, data) => console.log(`[${from}]`, data),
  onPeerJoined: (id) => console.log("peer joined:", id),
  onPeerLeft:   (id) => console.log("peer left:",   id),
});

await peer.connect();

// Send to a specific peer or broadcast
peer.send(targetPeerId, { type: "hello" });
peer.broadcast({ type: "ping" });
```

---

## Rust ZFA Core

```rust
use zfa_core::{achieves_zfa, spectral_gap, Capability};
use zfa_core::twist::Twist;

let h = vec![Twist::Up, Twist::Down, Twist::Plus, Twist::Minus];
assert!(achieves_zfa(&h));
assert_eq!(spectral_gap(&h), 0);

// Unforgeable ZFA-balanced capability token
let cap = Capability::root("kernel");
assert!(cap.is_valid());
assert_eq!(cap.spectral_gap(), 0);
```

---

## Signaling Protocol

The signaling server is a thin WebSocket relay — it never sees data channel contents. Messages:

| Direction | Type | Purpose |
|---|---|---|
| client → server | `join` | Enter a room with a peer ID |
| server → client | `peers` | List of existing peers in the room |
| server → others | `joined` | Notify existing peers of new arrival |
| client → server | `offer` / `answer` / `ice` | WebRTC handshake relay |
| client → server | `leave` | Exit the room |
| server → others | `left` | Notify peers of departure |

Room IDs are ZFA capability tokens — knowing the room ID is the capability to join.

---

## Rust + WASM Integration

The same `crates/zfa-core` crate compiles to:
- **WASM** (`--target web` via wasm-pack) — loaded by the browser peer
- **Native** (`cargo build`) — for server-side peers and CLI tools

WASM exports (via `wasm-bindgen`, enabled with `--features wasm`):

```typescript
wasm_achieves_zfa(twists: Uint8Array): boolean
wasm_spectral_gap(twists: Uint8Array): number
wasm_div_b(twists: Uint8Array): number
wasm_charge(twists: Uint8Array): number
wasm_capability_from_entropy(bytes: Uint8Array, label: string): string
wasm_capability_valid(hex: string): boolean
```

---

## Status

| Component | Status |
|---|---|
| ZFA Rust kernel | ✓ 19/19 tests pass (all 256 byte values) |
| WASM build | ✓ wasm-pack, wasm-bindgen |
| Signaling server | ✓ deployed — wss://quantum-os-signaling.fly.dev |
| Browser TypeScript | ✓ 0 type errors |
| WebRTC peer | ✓ join/peers/offer/answer/ICE/data channel |
| GitHub Pages | ✓ https://jimscarver.github.io/quantum-os/ |
| Native Rust peer | Planned |

---

## Related

- [quantum-logical-framework](https://github.com/jimscarver/quantum-logical-framework) — Lean 4 formal proofs; ZFA theory, Maxwell equations, Riemann program
- [QuantumOS.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/QuantumOS.md) — capability-secure OS design
- [Maxwell.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/Maxwell.md) — Maxwell equations from ZFA
