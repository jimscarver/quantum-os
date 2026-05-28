# quantum-os

**Create reality together.** Two peers in a room share a ZFA process space — a combined `parallel(peer1, peer2, …)` that is provably ZFA-balanced by construction. The room is not a chat channel; it is a shared physical process where every identity is a capability token and every interaction is a verified quantum logical event.

Peer-to-peer QuantumOS running in the browser. ZFA kernel in Rust/WASM, WebRTC data channels for transport, self-hosted signaling server.

**[Open a room →](https://jimscarver.github.io/quantum-os/)** · **[See it in action: Syllogism Demo →](SyllogismDemo.md)**

### How to create reality together

1. Open **https://jimscarver.github.io/quantum-os/** in your browser.
2. Click **Connect** — you join a room identified by a ZFA capability token in the URL hash. Your peer ID is a ZFA-balanced process.
3. Copy the share link and send it to someone (or open a second tab).
4. The second peer clicks **Connect** — both appear in the **Peers** list.
5. The **Room Process** panel shows the combined `parallel(you, peer)` process — ZFA-balanced across all peers.
6. Run QLF slash commands (`/braket +`, `/qucalc ^v`) — output broadcasts to every peer in the room.
7. Click a peer's name to instantly evaluate their ZFA process with `/qucalc`.
8. Use `/lemma name` to name a logical claim — twists are auto-allocated from the name, or supply them explicitly (`/lemma mortality ^v`). Reference with `@name` in any command (`/qucalc @mortality @socrates` deduces from both). Lemmas sync to all peers and persist across page reloads.
9. Use `/grant [label]` to mint a random ZFA capability token and share it as a proof object.

The room URL encodes a ZFA capability token in the hash (`#room=cap:room:…`). Anyone with the link can join — no account needed. The public signaling server (`wss://quantum-os-signaling.onrender.com`) is used by default; edit the field to point at a self-hosted server.

**Foundation:** [Quantum Logical Framework](https://github.com/jimscarver/quantum-logical-framework) — ZFA (Zero Free Action) is the security model. Every peer identity is a ZFA-balanced capability token. Possessing a token IS authorization (Curry-Howard for capabilities). The room process `parallel(peer1, peer2, …)` is machine-verified to stay ZFA-balanced under composition — decoherence is impossible by construction.

---

## In-app QLF slash commands

Type these in the chat input after connecting. The `/help` list is shown automatically at startup. Commands marked **shared** broadcast their output to all peers in the room.

### `/help`
Lists all available commands.
```
QLF slash commands:
  /help            — show this help
  /id              — your peer ID and ZFA proof
  /room            — room capability token
  /cap [label]     — generate a new ZFA capability
  /grant [label]   — generate and share a ZFA capability token
  /zfa [token]     — validate a capability token
  /braket <state>  — evaluate bra-ket (states: 0 1 + - i -i)
  /qucalc [twists] — evaluate RhoQuCalc twist sequence
  /freq [n|twists] — ZFA frequency spectrum; C(2n,n) arrangements at level n
  /dump            — summary of all logic shared this session
  /lemma           — list named lemmas
  /lemma <n> [tw]  — register @n; omit twists to auto-allocate from name
  @name in args    — expand named lemma (e.g. /qucalc @major @minor)
  //message        — send a message starting with /
```

### `/braket <state>` [shared]
Evaluates a bra-ket expression using the `Form` 2×2 Hermitian matrix algebra from `SpacetimeDynamics.lean`. States: `0`, `1`, `+`, `-`, `i`, `-i`. Multiple states (space-separated) compose as `parallel` (matrix addition = superposition). Output broadcasts to all peers.

`Form.toMatrix = [[t+z, x−iy],[x+iy, t−z]]`

Input:
```
/braket +
```
Output:
```
· ket: |+⟩
·   RhoProcess: action(Form_+)
·   eval = Form.toMatrix:
·   ⎡ 0.5  0.5 ⎤
·   ⎣ 0.5  0.5 ⎦
· bra: ⟨+|  (eval = ket†  =  ket  [Hermitian: Form.toMatrix_adjoint ✓])
·   ZFA: action [+,−]  lift [−,+]  both balanced: ✓
·   bra_ket_always_balanced: ✓ (BraKetRhoQuCalc.lean)
```

Input:
```
/braket 0 1
```
Output:
```
· ket: |0⟩ + |1⟩
·   RhoProcess: parallel(action(Form_0), action(Form_1))
·   eval = Form.toMatrix:
·   ⎡ 1  0 ⎤
·   ⎣ 0  1 ⎦
· bra: ⟨0| + ⟨1|  (eval = ket†  =  ket  [Hermitian: Form.toMatrix_adjoint ✓])
·   ZFA: action [+,−]  lift [−,+]  both balanced: ✓
·   bra_ket_always_balanced: ✓ (BraKetRhoQuCalc.lean)
```

The `|0⟩ + |1⟩` superposition yields the identity matrix — a complete basis. See [BraKetRhoQuCalc.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/BraKetRhoQuCalc.md) for the full bra-ket ↔ RhoQuCalc correspondence.

Lean anchor: [`bra_ket_always_balanced`](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/BraKetRhoQuCalc.lean)

### `/qucalc [twists]` [shared]
Evaluates a RhoQuCalc twist sequence. Accepts symbolic twists (`^v<>/\+-`), hex digits `0-7`, a `cap:label:hex` token, or `@name` references to named lemmas. No argument → show your peer's twist sequence. Click a peer or lemma name in the sidebar to prefill the input.

Twist alphabet: `^`=Up=0, `v`=Down=1, `>`=Right=2, `<`=Left=3, `/`=Slash=4, `\`=BSlash=5, `+`=Plus=6, `-`=Minus=7. Even values are positive (action); odd are negative (lift).

Input (compose named premises — see `/lemma` below):
```
/qucalc @mortality @socrates
```
Output:
```
· RhoQuCalc process:
·   composed: @mortality @socrates
·   deduction composition:
·     @mortality  →  ^v  (1+/1-)  ZFA: ✓
·     @socrates   →  +-  (1+/1-)  ZFA: ✓
·   composed: ^v+-  (4 total)
·   action (pos): count=2   lift (neg): count=2
·   spectral gap: 0  ZFA-balanced: ✓
·   frequency level: 2  C(4,2) = 6 arrangements
·   process: parallel(action(Form), lift(Form))  → ZFA stable
·   achieves_ZFA: ✓  stable under full_zeno_prune
·   rho_process_always_zfa: ✓ (Lean-verified)
```

Input (unbalanced — invalid argument):
```
/qucalc ^v^v^
```
Output:
```
· RhoQuCalc process:
·   input: ^v^v^
·   twists: ^v^v^  (5 total)
·   action (pos): count=3   lift (neg): count=2
·   spectral gap: 1  ZFA-balanced: ✗
·   process: UNBALANCED  → pruned by full_zeno_prune
·   achieves_ZFA: ✗  gap=1  (not a physical process)
```

ZFA balance is the selection principle: `@major @minor` composed (gap=0) is a valid deduction; an unbalanced composition is pruned by `full_zeno_prune` before becoming a physical event. See [BraKetRhoQuCalc.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/BraKetRhoQuCalc.md) and [QuantumOS.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/QuantumOS.md) for the capability-security model built on this invariant.

Lean anchors: [`RhoProcess`](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/RhoQuCalc.lean) · [`rho_process_always_zfa`](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/RhoQuCalc.lean) · [`bra_ket_always_balanced`](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/BraKetRhoQuCalc.lean)

### `/grant [label]` [shared]
Mints a fresh ZFA-balanced capability token with the given label and broadcasts it to all peers. Recipients see the token and a `/zfa` verification prompt. This is how peers share unforgeable capabilities with each other in a room.
```
/grant session
```
Output (you see):
```
granted: cap:session:024602460246024602460246…
  twists: 32  (16 pos, 16 neg)  ZFA-balanced: ✓
```
Output (peers see):
```
· alice granted capability:
·   cap:session:024602460246024602460246…
·   run /zfa cap:session:024602460246024602460246… to verify
```

### `/lemma [name [twists]]` [shared]
Names a logical claim so peers can reference it by `@name` in any command. Lemmas sync to all peers when registered and persist to `localStorage` per room URL — they survive page reloads.

- `/lemma` — list all registered lemmas in the room
- `/lemma name` — register `@name` with auto-allocated twists derived deterministically from the name (any peer typing the same command gets the same twists — no server needed)
- `/lemma name twists` — register `@name` with explicit twists (symbolic, `cap:token`, or `@ref1 @ref2`)
- `@name` anywhere in `/qucalc` args — expand and compose named lemmas

When the twist sequence is ZFA-balanced, a `cap:name:hex` capability token is auto-minted and shown. The Lemmas panel in the sidebar lists all names as clickable items — click `@name` to prefill `/qucalc @name`.

Auto-allocate twists from the name (simplest form):
```
/lemma mortality
```
Output:
```
· lemma registered: @mortality  =  <auto>  (auto-allocated)
·   twists: 18  (9+/9-)  ZFA: ✓
·   cap: cap:mortality:…  (share with /zfa to verify)
```

Or supply explicit twists when you want a specific encoding:
```
/lemma mortality ^v
```
Output:
```
· lemma registered: @mortality  =  ^v
·   twists: 2  (1+/1-)  ZFA: ✓
·   cap: cap:mortality:01  (share with /zfa to verify)
```

```
/lemma socrates +-
```
Output:
```
· lemma registered: @socrates  =  +-
·   twists: 2  (1+/1-)  ZFA: ✓
·   cap: cap:socrates:67  (share with /zfa to verify)
```

Chain lemmas to prove the conclusion ("Socrates is Mortal") from the two named premises:
```
/lemma mortal @mortality @socrates
```
Output:
```
· lemma registered: @mortal  =  ^v+-
·   twists: 4  (2+/2-)  ZFA: ✓
·   cap: cap:mortal:0167  (share with /zfa to verify)
```

List the full proof vocabulary:
```
/lemma
```
Output:
```
· lemmas (3):
·   @mortality  =  ^v     [cap: cap:mortality:01]   (by Alice)
·   @socrates   =  +-     [cap: cap:socrates:67]    (by Bob)
·   @mortal     =  ^v+-   [cap: cap:mortal:0167]    (by Alice)
```

See [SyllogismDemo.md](SyllogismDemo.md) for the full collaborative walkthrough.

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

### `/zfa [token]`
Validates any `cap:label:hex` token — checks ZFA balance and reports the spectral gap.
```
/zfa cap:room:024602460246024602460246…
  valid: ✓  spectral gap: 0
  twists: 32 (16 positive, 16 negative)
```
Lean anchor: [`achieves_ZFA`](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/QLF_Axioms.lean)

### `/cap [label]`
Generates a fresh ZFA-balanced capability token locally (not shared).
```
generated: cap:peer:024602460246024602460246…
  twists: 32  (16 pos, 16 neg)  ZFA-balanced: ✓
```
Rust source: [`crates/zfa-core/src/capability.rs`](crates/zfa-core/src/capability.rs)

### `//message`
Sends a literal message that starts with `/` (escapes the command prefix).

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

See [SECURITY.md](SECURITY.md) for the full threat model, known issues, and vulnerability reporting policy.

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

### Connection reliability

The signaling layer is designed to survive network interruptions without losing the room:

- **Server heartbeat** — the server pings every client every 25 seconds. Browsers respond automatically at the protocol level; connections that miss two consecutive pings are terminated cleanly. This keeps Fly.io's proxy from silently closing idle WebSocket connections.
- **Auto-reconnect** — if the signaling WebSocket drops, the client reconnects after 3 seconds (5 seconds on repeated failure) and re-joins the room. Existing peers detect the rejoin via the `joined` message and re-establish data channels via the normal offer/answer flow.
- **ICE failure detection** — `RTCPeerConnection.onconnectionstatechange` is monitored; a `"failed"` state triggers cleanup and notifies the app, so the peer list stays accurate rather than showing stale connected peers.
- **Free-tier server — hosted on Render (free tier); first connection after 15 min idle may take ~30s to wake. The heartbeat and auto-reconnect logic handles this transparently.

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
| Signaling server | ✓ deployed — wss://quantum-os-signaling.onrender.com |
| Browser TypeScript | ✓ 0 type errors |
| WebRTC peer | ✓ join/peers/offer/answer/ICE/data channel |
| Connection reliability | ✓ WS heartbeat (25s ping), auto-reconnect, ICE failure detection |
| Collaborative QLF broadcast | ✓ `/braket`, `/qucalc`, `/id`, `/room` share output to all peers |
| Room Process panel | ✓ `parallel(peer1, peer2, …)` ZFA balance shown in sidebar |
| Capability token exchange | ✓ `/grant` mints and shares ZFA caps across peers |
| Click-to-qucalc | ✓ click a peer → `/qucalc cap:peer:…` filled in input |
| GitHub Pages | ✓ https://jimscarver.github.io/quantum-os/ |
| Native Rust peer | Planned |

---

## Related

**[quantum-logical-framework](https://github.com/jimscarver/quantum-logical-framework)** — the Lean 4 formal proof repo that underpins this app. Zero `sorry` blocks across 16 modules. Key documents:

| Document | Relevant to |
|---|---|
| [README.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/README.md) | Overview; "Try in the browser" section with `/braket` and `/qucalc` examples |
| [AI.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/AI.md) | Quantum AI and syllogism solving — live collaboration script showing two peers prove "Socrates is Mortal" with `/qucalc`, `/braket`, `/grant` |
| [BraKetRhoQuCalc.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/BraKetRhoQuCalc.md) | `/braket` — `action`=ket, `lift`=bra, `parallel`=superposition; `bra_ket_always_balanced` proof |
| [QuantumOS.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/QuantumOS.md) | `/qucalc` — ZFA as OS kernel; `full_zeno_prune` as security, GC, and error correction |
| [QuCalc.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/QuCalc.md) | The 8-twist alphabet `{^v<>/\+-}`; ZFA generation engine |
| [Maxwell.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/Maxwell.md) | Maxwell equations from ZFA; `no_magnetic_monopoles` (∇·B=0) |
| [Lagrangian_Formulation.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/Lagrangian_Formulation.md) | ZFA as ℒ=0 (null Lagrangian = condition of origin); variational grounding |
| [Philosophy.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/Philosophy.md) | Possibilist ontology; ZFA as the sole selection principle |

**Lean source files** (machine-verified, zero `sorry`):

| File | Theorems |
|---|---|
| [lean/RhoQuCalc.lean](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/RhoQuCalc.lean) | `rho_process_always_zfa`, `action`, `lift`, `parallel` — `/id`, `/qucalc` |
| [lean/BraKetRhoQuCalc.lean](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/BraKetRhoQuCalc.lean) | `bra_ket_always_balanced`, `action_topo_is_ket`, `lift_topo_is_bra` — `/braket` |
| [lean/SpacetimeDynamics.lean](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/SpacetimeDynamics.lean) | `Form.toMatrix_adjoint` — Hermitian matrix used by `/braket` |
| [lean/QLF_Axioms.lean](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/QLF_Axioms.lean) | `achieves_ZFA`, `spectral_gap`, `full_zeno_prune` — `/zfa`, `/qucalc` |
| [lean/QLF_Universality.lean](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/QLF_Universality.lean) | `qlf_universality` — every terminating computation IS a ZFA string |
