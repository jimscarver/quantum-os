# Solving a Syllogism Together

A step-by-step walkthrough of two peers — **Alice** and **Bob** — using [quantum-os](README.md) to collaboratively verify the Aristotelian syllogism:

> All Men are Mortal. Socrates is a Man. Therefore, Socrates is Mortal.

Each step shows both browser windows side by side. The room URL is shared; both peers are connected. Lemmas registered by either peer appear in the **Lemmas** sidebar panel and persist across page reloads for the same room.

> **Tip:** You can omit the twist argument — `/lemma mortality` auto-allocates a deterministic ZFA-balanced sequence from the name, giving the same twists on every client without any coordination. The steps below supply explicit twists to show the logical encoding; both forms produce identical results for `/qucalc` and `/zfa`.

---

## Setup: Both peers connect

Alice opens the room and clicks **Connect**. She copies the share link and sends it to Bob. Bob opens the same URL and connects.

```
┌─────────────────────────────────────────────────────────────┐
│  ⬡ QuantumOS   peer-to-peer · ZFA capability model · WebRTC │
├──────────────┬──────────────────────────────────────────────┤
│ Your name    │  Share room: https://…#room=cap:room:024…    │
│ [Alice     ] │                                              │
│              │  · QLF slash commands:                       │
│ Your ID      │  ·   /help   /id   /room   /cap   /grant     │
│ cap:peer:02… │  ·   /zfa    /braket       /qucalc           │
│              │  ·   /lemma  @name in args                   │
│ Room         │  ·   //message                               │
│ cap:room:02… │  · joined room 024602…                       │
│              │                                              │
│ Signaling    │                                              │
│ [wss://…   ] │                                              │
│ ● connected  │                                              │
│              │                                              │
│ Peers (1)    │                                              │
│ Alice (you)  │                                              │
│ Bob      ←   │                                              │
│              │                                              │
│ Lemmas (0)   │                                              │
│ (none yet)   │                                              │
│              │                                              │
│ Room Process │                                              │
│ parallel(    │  [broadcast a message…]          [Send]      │
│  Alice (you) │                                              │
│  Bob         │                                              │
│ )            │                                              │
│ ZFA: ✓ gap:0 │                                              │
└──────────────┴──────────────────────────────────────────────┘
                          ALICE'S WINDOW
```

Both peers see each other in the **Peers** list. The **Room Process** panel shows `parallel(Alice, Bob)` — their combined ZFA process is already balanced (each peer identity is a 32-twist ZFA token with 16 positive and 16 negative twists).

---

## Step 1 — Alice names the Major Premise

Alice types `/lemma mortality ^v`. The `^v` sequence encodes **"All Men are Mortal"**: `^` (Up, action) asserts the universal category; `v` (Down, lift) closes it — the minimal balanced logical container. Naming it `@mortality` gives both peers a shared, reusable reference to this claim.

```
ALICE TYPES:  /lemma mortality ^v
```

**Alice's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  · lemma registered: @mortality  =  ^v                       │
│  ·   twists: 2  (1+/1-)  ZFA: ✓                             │
│  ·   cap: cap:mortality:01  (share with /zfa to verify)      │
└──────────────────────────────────────────────────────────────┘
```

**Bob's window** — receives the lemma automatically:

```
┌──────────────────────────────────────────────────────────────┐
│  Alice  /lemma mortality ^v                                   │
│  ·   @mortality registered from Alice  [cap: cap:mortality:01]│
└──────────────────────────────────────────────────────────────┘
```

Both sidebars now show:

```
│ Lemmas (1)      │
│ @mortality  ←   │   ← click to prefill /qucalc @mortality
```

**Result:** "All Men are Mortal" is ZFA-balanced (gap = 0), stored as `@mortality`, and auto-minted as `cap:mortality:01` — an unforgeable proof object for this claim.

---

## Step 2 — Bob names the Minor Premise

Bob types `/lemma socrates +-`. The `+-` sequence encodes **"Socrates is a Man"**: `+` (Plus, action) asserts the identity; `-` (Minus, lift) grounds it. Naming it `@socrates` completes the shared premise vocabulary.

```
BOB TYPES:  /lemma socrates +-
```

**Bob's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  · lemma registered: @socrates  =  +-                        │
│  ·   twists: 2  (1+/1-)  ZFA: ✓                             │
│  ·   cap: cap:socrates:67  (share with /zfa to verify)       │
└──────────────────────────────────────────────────────────────┘
```

**Alice's window** — receives Bob's lemma:

```
┌──────────────────────────────────────────────────────────────┐
│  Bob  /lemma socrates +-                                      │
│  ·   @socrates registered from Bob  [cap: cap:socrates:67]   │
└──────────────────────────────────────────────────────────────┘
```

Both sidebars now show:

```
│ Lemmas (2)      │
│ @mortality  ←   │
│ @socrates   ←   │
```

**Result:** "Socrates is a Man" registered as `@socrates`. The shared positive action `+` with Alice's `^` is the **Middle Term** ("Man") — the bridge that will fuse both premises into the conclusion.

---

## Step 3 — Alice deduces from named premises

Alice types `/qucalc @mortality @socrates`. The system expands each `@ref` to its twist sequence, concatenates them, and shows the deduction composition label-by-label.

```
ALICE TYPES:  /qucalc @mortality @socrates
```

**Both windows** show:

```
┌──────────────────────────────────────────────────────────────┐
│  · RhoQuCalc process:                                        │
│  ·   composed: @mortality @socrates                          │
│  ·   deduction composition:                                  │
│  ·     @mortality  →  ^v  (1+/1-)  ZFA: ✓                   │
│  ·     @socrates   →  +-  (1+/1-)  ZFA: ✓                   │
│  ·   composed: ^v+-  (4 total)                               │
│  ·   action (pos): count=2   lift (neg): count=2             │
│  ·   spectral gap: 0  ZFA-balanced: ✓                        │
│  ·   frequency level: 2  C(4,2) = 6 arrangements            │
│  ·   process: parallel(action(Form), lift(Form)) → ZFA stable│
│  ·   achieves_ZFA: ✓  stable under full_zeno_prune           │
│  ·   rho_process_always_zfa: ✓ (Lean-verified)               │
└──────────────────────────────────────────────────────────────┘
```

**Result:** `@mortality` (^v) + `@socrates` (+-) = `^v+-`, gap = 0. The Middle Term cancels internally. **The syllogism is valid** — shown by name, not by raw twist string.

The Room Process panel confirms the joint state:

```
┌─────────────────────┐
│ Room Process        │
│ parallel(           │
│   action(Alice)     │
│     16+/16-         │
│   action(Bob)       │
│     16+/16-         │
│ )                   │
│ ZFA: ✓  gap: 0      │
│ total twists: 64    │
└─────────────────────┘
```

---

## Step 4 — Bob evaluates the Conclusion as a quantum state

Bob evaluates **"Socrates is Mortal"** as a bra-ket superposition. The conclusion synthesises the universal (`|0⟩`) and the particular (`|1⟩`).

```
BOB TYPES:  /braket 0 1
```

**Both windows** show:

```
┌──────────────────────────────────────────────────────────────┐
│  · ket: |0⟩ + |1⟩                                           │
│  ·   RhoProcess: parallel(action(Form_0), action(Form_1))    │
│  ·   eval = Form.toMatrix:                                   │
│  ·   ⎡ 1  0 ⎤                                               │
│  ·   ⎣ 0  1 ⎦                                               │
│  · bra: ⟨0| + ⟨1|  (eval = ket†  =  ket                    │
│  ·   [Hermitian: Form.toMatrix_adjoint ✓])                   │
│  ·   ZFA: action [+,−]  lift [−,+]  both balanced: ✓        │
│  ·   bra_ket_always_balanced: ✓ (BraKetRhoQuCalc.lean)       │
└──────────────────────────────────────────────────────────────┘
```

**Result:** `|0⟩⟨0| + |1⟩⟨1| = I` — the identity matrix. The conclusion spans the full logical space defined by the premises.

---

## Step 5 — Alice seals the conclusion as a named lemma

Alice registers the proved conclusion as `@mortal` — composing it directly from the two named premises. The system resolves the chain, validates ZFA balance, and mints `cap:mortal:0167` as the unforgeable proof object for "Socrates is Mortal."

```
ALICE TYPES:  /lemma mortal @mortality @socrates
```

**Alice's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  · lemma registered: @mortal  =  ^v+-                        │
│  ·   twists: 4  (2+/2-)  ZFA: ✓                             │
│  ·   cap: cap:mortal:0167  (share with /zfa to verify)       │
└──────────────────────────────────────────────────────────────┘
```

**Bob's window** — receives the proved conclusion:

```
┌──────────────────────────────────────────────────────────────┐
│  Alice  /lemma mortal ^v+-                                    │
│  ·   @mortal registered from Alice  [cap: cap:mortal:0167]   │
└──────────────────────────────────────────────────────────────┘
```

Bob verifies by clicking `@mortal` in the Lemmas sidebar (prefills `/qucalc @mortal`), or directly:

```
BOB TYPES:  /zfa cap:mortal:0167
```

**Bob's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  · token: cap:mortal:0167                                     │
│  ·   valid: ✓  spectral gap: 0                               │
│  ·   twists: 4  (2 positive, 2 negative)                     │
└──────────────────────────────────────────────────────────────┘
```

Both sidebars now show the complete proof vocabulary:

```
│ Lemmas (3)      │
│ @mortality  ←   │   cap:mortality:01   — "All Men are Mortal"
│ @socrates   ←   │   cap:socrates:67    — "Socrates is a Man"
│ @mortal     ←   │   cap:mortal:0167    — "Socrates is Mortal" (proved)
```

**Result:** `cap:mortal:0167` is a valid ZFA-balanced token. Possessing it — or referencing `@mortal` — is proof that the syllogism reached ZFA closure. An invalid argument produces a non-zero spectral gap and cannot be named as a balanced lemma.

---

## Full session view

Both windows at the end of the session:

```
┌──────────────────────────────────┬──────────────────────────────────┐
│  ALICE'S WINDOW                  │  BOB'S WINDOW                    │
├──────────────┬───────────────────┼──────────────┬───────────────────┤
│ Peers (1)    │ · joined room 024…│ Peers (1)    │ · joined room 024…│
│ Alice (you)  │                   │ Bob (you)    │                   │
│ Bob      →   │ · @mortality=^v ✓ │ Alice    →   │ · @mortality from │
│              │                   │              │   Alice ✓         │
│ Lemmas (3)   │ · @socrates from  │ Lemmas (3)   │ · @socrates=+- ✓ │
│ @mortality ← │   Bob ✓           │ @mortality ← │                   │
│ @socrates  ← │                   │ @socrates  ← │ · @mortality      │
│ @mortal    ← │ · @mortality      │ @mortal    ← │   @socrates:      │
│              │   @socrates:      │              │ ·  ^v ✓  +- ✓    │
│ Room Process │ ·  ^v ✓  +- ✓   │ Room Process │ ·  ^v+- ZFA: ✓   │
│ parallel(    │ ·  ^v+- ZFA: ✓  │ parallel(    │                   │
│  Alice (you) │                   │  Bob (you)   │ · braket 0 1:    │
│   16+/16-    │ · braket 0 1:    │   16+/16-    │ ·  ⎡ 1  0 ⎤      │
│  Bob         │ ·  ⎡ 1  0 ⎤      │  Alice       │ ·  ⎣ 0  1 ⎦      │
│   16+/16-    │ ·  ⎣ 0  1 ⎦      │   16+/16-    │                   │
│ )            │                   │ )            │ · token valid ✓   │
│ ZFA: ✓ gap:0 │ · @mortal from   │ ZFA: ✓ gap:0 │   cap:mortal:0167 │
│ twists: 64   │   Alice ✓         │ twists: 64   │                   │
└──────────────┴───────────────────┴──────────────┴───────────────────┘
```

---

## What just happened

The room was the coprocessor. Neither peer needed a shared server, a database, or a trusted third party. The proof emerged from the ZFA structure of their collaboration — named and navigable through lemmas:

| Step | Who | Command | Lemma | Meaning |
|------|-----|---------|-------|---------|
| 1 | Alice | `/lemma mortality ^v` | `@mortality` | "All Men are Mortal" — gap 0 ✓ |
| 2 | Bob | `/lemma socrates +-` | `@socrates` | "Socrates is a Man" — gap 0 ✓ |
| 3 | Alice | `/qucalc @mortality @socrates` | — | Deduction: Middle Term cancels, gap 0 ✓ |
| 4 | Bob | `/braket 0 1` | — | Conclusion: `\|0⟩ + \|1⟩ = I` (completeness) |
| 5 | Alice | `/lemma mortal @mortality @socrates` | `@mortal` | Proof sealed: `cap:mortal:0167` unforgeable |

Steps 1 and 2 use explicit twist sequences to illustrate the ZFA encoding. The same proof works with auto-allocation — just omit the twists:

```
/lemma mortality     ← same as /lemma mortality ^v (or any balanced sequence)
/lemma socrates      ← same as /lemma socrates +-
```

Both peers always derive the same twists for the same name, so the cap tokens match without any coordination.

The Lemmas panel gives both peers a shared, navigable vocabulary of proved claims — click any `@name` to expand it with `/qucalc`. Lemmas persist in localStorage per room, so the proof survives a page reload. An invalid syllogism would produce a non-zero spectral gap at step 3, and the auto-minted capability token would fail `/zfa` verification — unbalanced tokens are algebraically impossible to construct.

The ZFA filter — `full_zeno_prune` — is the same operation that selects physical reality from the space of all possible logical histories.

**[Open a room and try it →](https://jimscarver.github.io/quantum-os/)**

See [AI.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/AI.md) for the theoretical background on ZFA Blanket Fusion and the Neuro-Symbolic architecture.
