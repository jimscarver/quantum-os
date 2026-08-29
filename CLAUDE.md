# CLAUDE.md — [QuantumOS](README.md)

Project context for Claude Code sessions. Read this before making any changes.

---

## Project overview

**QuantumOS** is a peer-to-peer browser application that makes ZFA (Zero Free Action) capability tokens the live security model of a collaborative computing room. Two or more browser peers connect via WebRTC, share a room identified by a ZFA capability token, and run QLF slash commands (`/qucalc`, `/lemma`, `/braket`, `/zfa`, …) whose results broadcast to all peers.

The ZFA kernel is implemented in Rust (compiled to WASM) and is the same algebraic core as the [Quantum Logical Framework](https://github.com/rchain-community/quantum-logical-framework). Possessing a capability token IS authorization — no server, no accounts, no trust.

**Live deployment:** https://rchain-community.github.io/quantum-os/
**Signaling server:** `wss://quantum-os-signaling.onrender.com` (Render.com, auto-deploys from `packages/signaling/`)

---

## Repository layout

```
quantum-os/
├── crates/
│   └── zfa-core/          Rust library: ZFA kernel (twist algebra, capabilities, processes)
│       └── src/
│           ├── capability.rs   cap:label:hex token generation (rejection-sampling) and validation
│           ├── history.rs      achieves_zfa, is_count_balanced, spectral_gap, count_pos/neg, is_symmetric
│           ├── pauli.rs        Pauli matrix algebra: pauli_fold, is_pauli_closed, twist_matrix
│           ├── process.rs      Form (2×2 Hermitian), Process (RhoQuCalc)
│           ├── twist.rs        Twist enum (8-symbol alphabet)
│           └── wasm.rs         wasm-bindgen exports (feature = "wasm")
├── packages/
│   ├── browser/            Vite + TypeScript browser app (GitHub Pages)
│   │   ├── index.html      Layout + CSS (sidebar, chat, share row)
│   │   ├── public/
│   │   │   └── render.html Room animation (the `/render` command) — self-contained canvas, deploys to /quantum-os/render.html
│   │   └── src/
│   │       ├── app.ts      All UI logic, slash commands, lemma/note/rdv stores, peer callbacks
│   │       ├── peer.ts     QOSPeer class — WebRTC + signaling WebSocket
│   │       ├── zfa.ts      Browser-side ZFA helpers (validateCapability, tokenTwists, …)
│   │       ├── notes.ts    Promissory note primitives (mint, split, merge, parseNoteLabel, denomination)
│   │       ├── rendezvous.ts  N-party rendezvous protocol (Proposal/Row/CommitRow types, conservationCheck, cyclicSwap)
│   │       ├── dyncap.ts   Hash-only dynamic capabilities (sign/verify envelopes; SHA-256 only)
│   │       ├── vault.ts    Password-encrypted identity vault (PBKDF2 → AES-GCM over the dyncap seed; /password, /login)
│   │       ├── probe.ts    Discrepancy probe — chain-weighted supermajority tally on join
│   │       ├── polls.ts    Group polls — pure approval + ranked-choice (IRV) tally over content-hash option ids
│   │       ├── macro-lang.js Interact2 `$` macro language — parse, bind, expand; both lexers; --selftest
│   │       ├── rhoqu.ts    RhoQu macro parser + transpiler (process / new / | / if / on / for → /command strings)
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
           ZFA: count balance ∧ Pauli closure (see below)
```

- Generated with `crypto.getRandomValues()` (browser) or `getrandom` crate (Rust); since v0.17, `from_entropy` uses rejection sampling to guarantee Pauli closure (~4 iterations expected per token).
- 128-bit entropy; ZFA constraint still leaves astronomically large space.
- `validateCapability(token)` — checks format, count balance, AND Pauli closure.
- `tokenTwists(token)` — extracts `Uint8Array` of twist values from hex.
- Knowing a room token IS the capability to join (bearer token in URL hash).

### Twist alphabet (8 symbols)

| Symbol | Value | Parity | Name |
|--------|-------|--------|------|
| `^` | 0 | even/pos | Up |
| `v` | 1 | odd/neg | Down |
| `>` | 2 | even/pos | Right |
| `<` | 3 | odd/neg | Left |
| `/` | 4 | even/pos | Slash |
| `\` | 5 | odd/neg | Backslash |
| `+` | 6 | even/pos | Plus |
| `-` | 7 | odd/neg | Minus |

**ZFA = half-spin closure** (v0.17+): a process whose execution returns a spin-1/2 spinor to itself up to a global phase. The predicate `achieves_zfa(H) = pauli_closed(H) ∧ count_balanced(H)` is the algebraic decomposition of that closure into its two faces:

1. **Pauli closure** (non-abelian face): the ordered matrix product of twists lands in `{+I, −I, +iI, −iI}` — the Pauli scalar group. Each twist maps to an SU(2) generator (`^v` ↔ ±σ_y, `<>` ↔ ∓σ_x, `/\` ↔ ±σ_z, `+-` ↔ ±I). Order matters because Paulis anti-commute. **This is the SU(2)-scalar-return reading of half-spin closure** — the spinor closes up to phase.
2. **Count balance** (abelian face): `count_pos == count_neg`. Spectral gap = `|count_pos − count_neg|` = 0. This is the bra-ket / Hermitian-pair multiset count: each twist is paired with its Hermitian conjugate.

Pauli closure is not a "stronger condition" layered on top of count balance — it IS the SU(2)-scalar-return of the same half-spin closure that count balance reads as a Hermitian-pair multiset. Neither face implies the other in isolation (`σ_x σ_y σ_z = iI` is Pauli-closed but count-imbalanced; `^<` is count-balanced — one positive, one negative — but folds to −iσ_z, not a scalar); both together are the unique characterisation of a closed half-spin process. **Aggregate vs pairwise balance.** `count_balanced` above is the *aggregate* count `count_pos == count_neg`. QLF's `is_zfa` requires the stronger *pairwise* balance — the signed action vector `(#^−#v, #>−#<, #/−#\, #+−#-)` vanishing, which is what Zero Free Action names. `achieves_zfa` conjoins Pauli closure with the aggregate count, so it **over-accepts**: at length 6 it admits 20,480 histories where QLF admits 5,120. It is deliberately left as-is — it is what every live room link and minted identity validates against, and narrowing it would invalidate deployed tokens. `is_pairwise_balanced` / `achieves_zfa_pairwise` (Rust) and `isPairwiseBalanced` / `achievesZfaPairwise` (`zfa.ts`) provide QLF's predicate; `signed_action` exposes the vector. `crates/zfa-core/tests/census_conformance.rs` re-derives QLF's exhaustive 8-twist census (`tests/data/census_inventory.json`, provenance to QLF `54fcc9b`) by brute force from this crate's own fold — 266,304 histories at lengths 2/4/6 every `cargo test`, 16.7M at length 8 behind `--ignored`. SECURITY.md records the gap.

**Coupling** (`crates/zfa-core/src/coupling.rs`, `/coupling`). `parallel(peer1, …)` is ZFA-balanced by construction, so its balance distinguishes no room from any other. Cutting a closed join into per-peer factors does: `independent` (each factor closes alone — two closures, not one), `product` (no factor closes but each folds to a Pauli scalar — separable), `coupled` (only the join closes — a shared closure, QLF's entanglement), `open` (the join does not close; no event). This is the census's own cut-and-classify, so a verdict reads against an exact baseline — `COUPLED_BASELINE` = 80.3% of shared closures are coupled. Note the classification uses the **pairwise** predicate. With no arguments `/coupling` cuts the room along **what peers proposed with `/qlf-action`** (`RoomContext.actionProposals`, latest per peer, in-memory only) — *not* along peer capability tokens. A token is a random identity bearer minted against the aggregate predicate (~2.4% are pairwise-balanced), so joining tokens returned `open` for ~99.5% of real rooms and said nothing about the room; a history someone deliberately typed is a contribution, so a join of two peers' proposals closing means they built one closure together. All four verdicts are reachable that way (`^`+`v` → coupled, `+`+`-` → product, `^v`+`><` → independent, `^`+`>` → open).

The 8-twist alphabet is the SU(2) generator set up to sign (SU(2) ≅ unit quaternions; Hurwitz singles out H as the unique non-commutative associative composition real algebra — see QLF [HALF-SPIN-ZFA-EMBEDDING.md §6](../quantum-logical-framework/HALF-SPIN-ZFA-EMBEDDING.md)).

Both faces are checked uniformly in `crates/zfa-core/src/pauli.rs`, `packages/browser/src/zfa.ts`, and the QLF Python core `twist_core.py`.

### Lemma system

Named logical claims shared across peers, persisted to `localStorage` per room URL.

- `/lemma name` — auto-allocate twists deterministically from the name (same result on every client, no server needed)
- `/lemma name twists` — explicit twists (symbolic, hex, `cap:token`, or `@ref1 @ref2`)
- `@name` in any command arg — expands to the stored twist sequence
- Auto-mints `cap:name:hex` when the result is ZFA-balanced
- Broadcasts `{kind: "lemma", name, twists, cap, who}` to all peers on register
- `allocateTwists(name)`: each character yields one pos twist `(code & 3)*2` and one neg twist `((code>>2)&3)*2+1` — always balanced, always deterministic

**Transfer commands** (peer-to-peer, not broadcast):
- `/request name` — broadcasts `{kind: "lemma-request", name, fromName}`; holder's window shows a prompt with the ready-to-type `/pass` command
- `/pass name peer-name` — looks up `peerNames` to find peerId, sends `{kind: "lemma-pass", name, twists, cap}` directly via data channel, deletes from sender's `lemmaStore`; recipient auto-registers and sees confirmation
- `findPeerByName(name)`: exact then prefix match on `peerNames` map (case-insensitive)

### Promissory notes (`/note` — `notes.ts` + `app.ts`)

Bearer instruments as ZFA capabilities. Format `cap:note-<currency>:<balanced hex>`; **denomination = `hex.length / 2`**. Conservation falls out of the existing balance invariant — split/merge preserve `count_pos == count_neg`.

Three label kinds parsed by `parseNoteLabel`: `token` (issuer authority), `note` (bearer denomination), `receipt` (permanent redemption record). Lifecycle vocabulary borrowed from DarkWow's TokenMint → Mint → Transfer → Redeem, but implemented with no ZK, no Pedersen, no consensus.

Stores (per-room `localStorage`):
- `currencyTokens: Map<currency, token>` — currencies *I issue* (private bearer authority)
- `knownCurrencies: Map<token, KnownCurrency>` — *public* registry of every declared currency in the room (populated from `note-declare` broadcasts and `sync-currencies` snapshots)
- `noteStore: Map<token, NoteEntry>` — bearer notes I currently hold
- `receiptStore: Map<token, ReceiptEntry>` — redemption receipts (permanent, non-transferable)
- `redemptionsHonored: Map<token, RedemptionRecord>` — issuer-side accounting

Wire kinds: `note-declare` (broadcast), `note-grant` (broadcast — currency + denomination only, the bearer token stays private), `note-pass` / `note-redeem` / `note-receipt` (direct).

The sidebar's **Currencies** block shows `currencyTokens` entries with `✦` and others' declarations with the issuer's name; **Notes** shows `noteStore`. Click handlers prefill the input. Receipts and redemptions are chat-only.

#### Terms & conditions — terms-stamped series

Notes can carry **terms & conditions**, and different notes of the same currency can carry *different* terms, via **series stamps**. A terms-bearing note's token is `cap:note-<base>~<termsHash8>:<hex>` where `termsHash8 = first 8 hex of FNV-1a(canonicalized terms)` (`termsHash8` in `notes.ts`). `parseNoteLabel` returns `{ currency (full, e.g. "USD~a1b2"), baseCurrency ("USD"), series ("a1b2"|null) }`. **`currency` is the full unit**, so each series is its own non-fungible unit: `splitNote` keeps the stamp on both children (terms inherited); `mergeNotes` already requires a matching currency segment, so it refuses to combine different series (or a series with plain). "Different terms for USD" = **different series under USD**.

- Mint: `/note grant USD 5 | <terms text>` → derives the stamp, mints `cap:note-USD~<hash>`, records the series, and broadcasts it. Plain `/note grant USD 5` is unchanged.
- **Authority/integrity:** the issuer broadcasts a **dyncap-signed `note-series {seriesKey, baseCurrency, termsHash, terms, who}`** (and it rides the join handshake via **`sync-series`**). Inbound is honored only if self-consistent (`termsHash8(terms) === stamp` and `seriesKey === base~hash`) **and** from the currency's issuer (sender's verified dyncap anchor matches the `KnownCurrency.dyncap.anchor`, like the lemma-retract author check). `note-pass` also carries the terms as a self-verifying cache (text must hash to the token's stamp); the signed `note-series` overrides an `(unconfirmed)` cache.
- **Acceptance gate:** `/note redeem` of a stamped note is blocked until the holder runs `/note accept <currency~hash>`; acceptance is recorded in `acceptedTerms`. `/note terms <currency~hash>` shows a series' terms; `/note terms <currency>` lists a currency's series.
- Stores: `seriesTerms: Map<seriesKey, SeriesTerms>` and `acceptedTerms: Map<seriesKey, AcceptedTerms>`, persisted `qos-series-terms-<room>` / `qos-accepted-terms-<room>`. Issuance checks use `baseCurrency` (a `USD~hash` note is issued by whoever issues `USD`). Sidebar notes show a 📜 marker with terms in the tooltip.
- Limitation: terms are fixed at mint (the stamp commits to them); re-terming means minting a new series.

### Rendezvous (`/rdv` — `rendezvous.ts` + `app.ts`)

N-party atomic synchronization. Each participant contributes a `gives` token and receives a `gets` token; `conservationCheck(rows)` enforces `multiset(gives) == multiset(gets)` over the joint composition.

Protocol (5 direct-send wire kinds, never broadcast): `rdv-propose`, `rdv-accept`, `rdv-reject`, `rdv-commit`, `rdv-abort`. The proposer collects accepts (each accept carries the participant's committed gives token), and on all-accepts builds commit rows via the cyclic mapping `row[i].gets = next-row.gives` and dispatches `rdv-commit`. Each participant applies locally: `lockedNotes.delete(givesToken); noteStore.set(getsToken, …)`.

Locking: accepted-but-not-yet-committed tokens move from `noteStore` to `lockedNotes` (so `/note pass` etc. don't see them). Released on abort/reject/timeout. On reload, locks are orphaned (proposal state is in-memory only) and auto-released back to `noteStore` in `loadNotes()` — so value is never lost across a crash.

Atomicity is best-effort, same trust model as `/note pass`. 60s default timeout via `scheduleProposalTimeout` / `proposalTimedOut`.

### Dynamic capabilities (`/dyncap` — `dyncap.ts` + `app.ts`)

Hash-only identity layer. Uses `crypto.subtle.digest("SHA-256", …)` — browser built-in, no external library, no keypairs, no signatures.

State per peer (private, in `localStorage` under `qos-dyncap-state`, cross-room):
- `seed: Uint8Array(32)` — generated at first launch, never broadcast
- `anchor: string` — hex of `H(seed)`, 64 chars; the peer's permanent identity
- `seq: number` — monotonically incremented per signed envelope

Signed envelope grows: `dyncap: { anchor, seq, witness }` where `witness = H(seed || seq_le32 || room_id_bytes || payload_hash)`. `payload_hash` covers a canonical serialization (sorted keys, JSON, dyncap stripped) of the envelope.

Receivers maintain `dyncapChains: Map<peerId, ChainEntry>` per room. TOFU-pin the first observed anchor. Subsequent envelopes must extend the chain — monotonic `seq`, unseen `witness`. Two valid envelopes at the same `seq` under the same anchor are a *fork*; the entry is flagged `contested` and the user is warned via `⚠` chat line.

Outbound wired in: `signedBroadcast` and `signedSend` are drop-in wrappers replacing direct `qpeer.broadcast` / `qpeer.send` for envelope kinds we sign. A `signQueue: Promise` chain serializes outbound signings so `seq` ordering is preserved across concurrent broadcasts.

Currently signed: `name`, `lemma`, `note-declare`, `sync-lemmas`, `sync-currencies`. `LemmaEntry` and `KnownCurrency` gained an optional `dyncap?: DyncapField` field so sync-forwarded entries carry the original author's chain step. Inner-entry verification against the original author's anchor (cross-peer lookup) is a future revision.

Trust ceiling: TOFU at first contact + chain-tamper / replay / fork detection. Cannot mathematically verify the seed (hash-only). Race condition if a clone broadcasts before the real holder. Cross-room continuity not provided. See SECURITY.md for full threat enumeration.

### Identity recovery (`/password` / `/login` — `vault.ts` + `app.ts` + `gov.ts`)

The dyncap seed is the whole identity; `vault.ts` makes it portable without leaving the hash-only model. `encryptVault`/`decryptVault` seal `{ seed, name }` with **PBKDF2-SHA256 (210k) → AES-256-GCM**, emitting `qos-vault:v1:<salt>:<iv>:<ct>` — the app's only `crypto.subtle` AES (SHA-256 stays dyncap's). `/password` produces it (password via a masked dialog, never an inline command arg, so no secret hits the chat log / broadcast) and, for each group you're a member of, replicates it via a self-signed **`gov-vault`** envelope carried on `sync-gov` (the memory daemon persists it inside `groups.json`). `/login <handle>` fetches the ciphertext from synced group state and decrypts; a bare `/login` restores from a pasted (or this browser's saved) string. Both commands are excluded from the `qlf` broadcast.

Group scoping is anchor-bound: `Member` gained `anchor`, `isMember`/`isAdmin`/`memberKeyFor` match by anchor as well as peerId, and `reconcileGroups`/`rekeyMember` (in `gov.ts`) move a returning member (recovered seed, fresh peerId) — plus every peerId-keyed reference (delegations, trust, censures, creator) — onto the live peerId, only ever on a **dyncap-verified** anchor. `Group.vaults: Record<handle, VaultRecord>` is first-write-wins by handle, overwrite only by the same anchor (publisher must be a member and `fromAnchor === vault.anchor`). Pure p2p — no server, no username registry; the daemon holds ciphertext it can't read. Confidentiality is exactly the password's strength (offline-crackable by any ciphertext holder). See SECURITY.md.

### Multi-room with per-room Markov blankets (`/room` — `app.ts`)

A single browser session can join N rooms simultaneously, each as a tab across the top of the UI. The full reference framing is below; concrete summary for code work:

State model:
- `RoomContext` interface (defined in `app.ts`) collects all per-room state: `lemmaStore`, `noteStore`, `currencyTokens`, `knownCurrencies`, `receiptStore`, `redemptionsHonored`, `lockedNotes`, `proposals`, `proposalTimers`, `dyncapChains`, `probe`, `ignoredForSync`, `actionProposals`, `chatLog`, `peers`, `peerNames`, `pendingLeaves`, `qpeer`, `signalingUrl`, `hasUnread`, `roomId`.
- `const rooms: Map<roomId, RoomContext>` — all joined rooms.
- `let activeRoom: RoomContext` — the room whose state is aliased into the module-level `let` bindings (`lemmaStore`, `peers`, …). Temporarily swapped by inbound QOSPeer callbacks via `setActiveRoom(ctx)` so background activity lands in the right room.
- `let uiActiveRoom: RoomContext` — the room the user is *looking at*. Changes only on `switchToRoom`. DOM-touching helpers (`addMessage`, `renderPeers`, `renderLemmas`, `renderNotes`, `renderRoomProcess`, `setStatus`) guard with `isUiActive()` (= `activeRoom === uiActiveRoom`) so a background callback doesn't disturb the visible tab.

Cross-room state (not in `RoomContext`):
- `myName`, `dyncapState` (with `seqByRoom: Record<roomId, number>`), `signQueue`, `sessionLog`. Per-device, shared across all rooms.

Tab UI:
- HTML: `#tab-bar` with `#tab-list` and `#tab-add` (the `+` button). CSS classes `.tab`, `.tab.active`, `.tab.unread`.
- `renderTabs()` paints from `rooms.values()`; the unread indicator is an orange `●` prefix on tabs where `ctx.hasUnread && ctx !== uiActiveRoom`. Tab clicks call `switchToRoom`.
- `switchToRoom(roomId)` calls `setActiveRoom(next)`, sets `uiActiveRoom = next`, clears `next.hasUnread`, and calls `applyActiveRoomToUI()` which re-renders everything from the new active room (replays `chatLog`, updates sidebar, syncs URL hash via `history.replaceState`).

Persistence: `qos-joined-rooms` localStorage key holds the array of joined room IDs. On reload, every room is restored via `loadRoomState(ctx)` (which briefly swaps `activeRoom` to `ctx` while `loadLemmas` / `loadNotes` run). The URL-hash room becomes the initial active room.

Callback model for simultaneous connections:
- Each `connect()` call captures `const ctx = activeRoom` at QOSPeer construction time. Every callback wraps its body in `const prev = activeRoom; setActiveRoom(ctx); try { … } finally { setActiveRoom(prev); }`.
- For `async onMessage`, the same wrapper applies plus a manual `setActiveRoom(ctx)` after each `await verifyDyncapIfPresent(…)` — the binding doesn't survive await suspensions, so we re-assert at each resumption point.
- DOM-touching code (the renderer guards above + direct `msgInput.disabled` / `connectBtn.textContent` writes) checks `isUiActive()` so background-callback DOM noise is suppressed.

The bridge-peer model: there's no protocol-level "cross-room" envelope. A peer in two rooms manually re-declares lemmas / re-grants notes in each room via the dispatcher (which acts on `activeRoom`, i.e. the current tab). Future work: an explicit `/share` command that copies a selected item from the active room into a named tab. Today, manual re-declaration is the bridge primitive.

### Discrepancy probe — joiner-local supermajority (`/probe` — `probe.ts` + `app.ts`)

Partial-consensus layer that runs when a peer joins a room. The full reference doc is [Consensus.md](Consensus.md); the implementation summary for code work:

State (per room, joiner only):
- `probe: ProbeWindow` — `{ open, observations: Observation[], contributors: Set<peerId>, timer }`. Opened in `onSignalingOpen`, closes on `PROBE_WINDOW_MS` (5000) timeout or after `SAMPLE_SIZE` (5) distinct senders.
- `ignoredForSync: Set<peerId>` — peers whose sync envelopes are silently dropped (persisted under `qos-ignored-sync-{room}`).

Constants in `probe.ts`: `SAMPLE_SIZE`, `PROBE_WINDOW_MS`, `SUPERMAJORITY_NUM = 2`, `SUPERMAJORITY_DEN = 3`.

Observation shape: `{ storeName: "lemmas"|"currencies", key, value (JSON-normalized), peer, weight }`. Weight is `dyncapChains.get(peer)?.lastSeq ?? 1` (floor 1), captured by `recordSyncObservations` when each `sync-lemmas` / `sync-currencies` arrives during the window.

`findDiscrepancies` groups by `(storeName, key)`; for each group it buckets by value, sums weights, sorts buckets by weight desc (count desc, first-seen as tiebreak). The leading bucket's value becomes the `winner` only if `leader.weight × DEN > totalWeight × NUM` (strict supermajority). Otherwise `winner: null` (contested, unresolved). `losingPeersIn` returns peers in non-winner buckets only for *resolved* discrepancies — contested discrepancies produce no losers.

On close, `closeProbeWindow`:
- For each resolved discrepancy: apply the winner to `lemmaStore` / `knownCurrencies` locally, broadcast `state-discrepancy { ..., winner: <object> }`, add losers to `ignoredForSync`.
- For each contested discrepancy: broadcast `state-discrepancy { ..., winner: null }`, no local change, no losers added.

The `state-discrepancy` inbound handler logs the broadcast on receipt; non-joining peers do *not* auto-update on receipt (joiner-local resolution).

**Critical preflight: lemma immutability.** Once `@name` is in `lemmaStore`, both the `case "lemma"` dispatcher and the inbound `lemma` handler refuse a re-declaration with different `twists` (idempotent re-declare is silently a no-op). Without this, the probe's notion of "discrepancy" would be meaningless — peers could just overwrite each other's lemma state. The fix is in `app.ts` around the existing dispatcher block and the inbound handler.

### Room state sync on data channel open

When a new data channel opens (`onChannelOpen(peerId)` in `connect()`), the peer sends the new arrival:
- `name` (existing) — display name
- `sync-lemmas` — `Array<{name, twists, who, cap?}>` from `lemmaStore`
- `sync-currencies` — `Array<KnownCurrency>` from `knownCurrencies`

Inbound handlers validate every entry with the same label/ZFA-balance checks as the live `lemma` / `note-declare` flows. First-write-wins dedupe by lemma name; currency dedupe by token. Held notes / receipts / redemptions are *never* gossiped — they're private bearer state.

Polls are also synced here: a `sync-polls` envelope (full `Poll[]`) is pushed to the new arrival so it sees polls created before it joined (see Group polls below).

### Group polls (`/poll` — `polls.ts` + `app.ts`)

On-demand group decisions (e.g. "pizza vs burgers vs salad for lunch") with **collect-then-vote** open nominations and two methods: **approval** and **ranked-choice (IRV)**.

`polls.ts` is a **pure tally module** (no DOM / storage / app imports — mirrors `probe.ts`). The tally is **deterministic and joiner-local**: every peer recomputes the same result from the ballots it holds — no central counter, echoing the consensus probe.

- **Options are referenced by a stable content-hash id** (`optionId(text)` — djb2 over normalized text), *never* by array position. Options are collected by broadcast and arrive in different orders on different peers, so an index would mean different things on different peers; an id also auto-dedupes identical suggestions ("Pizza" ≡ "pizza "). Ballots are `Record<peerId, string[]>` of option ids.
- `tallyApproval` — most-approvals-win, ties listed. `tallyRanked` — IRV over ids: win at majority of continuing ballots, exhausted ballots excluded from the denominator, deterministic tie-break = smallest option id (so every peer agrees regardless of ballot arrival order). `tally` dispatches by method; `liveCounts` gives per-option bars; `sortedOptions` is the deterministic display order (add-time then id); `summarizeWinners` is the chat/foot text.

Lifecycle: `/poll new <q>` opens for nominations (no fixed options); `| a, b` seeds some. Anyone adds options (the card's "add an option" box or `/poll add <opt>`); everyone votes/re-votes live (latest ballot per peer wins) until the creator closes. The creator may `/poll lock` to freeze nominations. On close, every peer **logs the result as a permanent transcript message** (`postPollClosedMessage`) so the outcome survives card re-renders and chat scroll-back — not only the interactive card.

Wire kinds (all dyncap-signed, idempotent, out-of-order tolerant): `poll-open` (with `options: PollOption[]`), `poll-option`, `poll-lock`, `poll-ballot` (id list), `poll-close`, and `sync-polls` (join replay). Options/ballots that arrive before their `poll-open` are buffered (`pollOptionBuffer` / `pollBallotBuffer`) and drained on open. Per-room persistence under `qos-polls-<roomId>`; cards rebuild from live `pollStore` on reload/tab-switch via the `pollId` branch in `renderChatLine`. Only the creator can lock/close (`from === poll.creator`).

For the broader family of group-decision processes this interface supports (approval / ranked-choice / consensus / atomic rendezvous / delegation / sortition / …) — built and sketched, each mapped to its primitive — see [Group_Decisions.md](Group_Decisions.md).

### The room's library (`/file` — `library.ts` + `app.ts`)

Layers 1–5 of [Media_Libraries.md](Media_Libraries.md): **a file's name is its content hash**, and the index of those names is ordinary room state. **Serverless, and no chain anywhere** — durability is *replication*: every peer keeps the index and replays it to joiners, and every peer that fetches a file becomes a holder of it, so a file survives by being wanted. A chain (#102) and an always-on peer are both **enhancements** — one that the library *needed* would be a server whatever it was called. What the design owes instead is legibility about risk: `copiesOf`/`atRisk` mark an entry with a single copy in the list and the sidebar, because that is one closed laptop from none and the moment to make another is while the first is still reachable.

- `hashBlob` (SHA-256, the digest `dyncap` already uses) names an entry, so two peers adding one file agree by construction, a copy from anyone is verifiable, and a fetch is resumable from a different holder later.
- `LibraryEntry = {hash, name, mime, size, addedBy, addedLabel, at, cap?}`. `entryFromWire` validates every field because every entry arrives from a peer; `findEntry` takes a hash, a prefix or a name and **returns null rather than guessing** between two matches; `sortEntries` is newest-first with the hash as tie-break, so every peer lists the same order.
- **Three facts, kept apart, because they fail apart**: `libraryStore` (the index — public, gossiped, `qos-library-<room>`), `heldFiles` (whose bytes this browser has — local, `qos-library-held-<room>`, and **reconciled against OPFS on load**, since claiming to hold bytes you no longer have is the one lie a library must not tell), and availability — `fileHolders` (hash → peers here who say they hold it; live, never persisted, emptied of a peer the moment it leaves) with `holderSeen` (`qos-library-seen-<room>`) so *offline* and *gone* differ. `availabilityOf` folds them into `held ●` / `here ◉` / `known ○` / `gone ⚠` (`GONE_AFTER_MS`, a week), which is what stops a library being a list of broken links. A peer announces its holdings with a signed `library-have` (replace, never merge) on change and on the join handshake.
- Bytes live in **OPFS** (`putBytes`/`getBytes`/`dropBytes`/`heldHashes` in `library.ts`, the filesystem `record.ts` streams into). Every operation answers rather than throws, so a browser that refuses storage still indexes and lists.
- Wire: dyncap-signed `library-entry`, `sync-library` on the join handshake (the index, never the bytes), and removal through the existing tombstone machinery (`retract` kind `"library"`, honored only from the peer who added it).
- **Fetch (`library-fetch.ts`, `/file get`)** — `attachments.ts` with the request turned around: one asker, one holder, one hash, paced against that one connection, so the cap is what a person will wait for (`FETCH_MAX` 64 MB) rather than what a room will tolerate (8 MB, a property of broadcasting). **The hash is the whole trust model**: the arrival is verified against the name it was fetched by and a mismatch is deleted, so nothing has to trust the peer that answered. Written to a `.part` file as it arrives (which `heldHashes` refuses to count, so an interrupted fetch never looks like a held file), sent a slice at a time so neither side holds the file in memory, and **only what was asked for, from whom it was asked** — an unrequested `lib-head` opens nothing, or a peer could write 64 MB into your storage by sending a message. Wire kinds `lib-want`/`lib-head`/`lib-part`/`lib-deny` are unsigned by design: a signature would prove who sent bytes that are checked anyway.
- Verbs, not a feature — `/file add · list [--mine|--here] · get · holders · drop · cancel · forget`, each answering in lines so a room composes its own workflow in a `+command` body.
- **In the sidebar** (`renderLibrary`): a row per entry carrying its availability mark, so what can be had looks different *before* it is clicked. A click does the next sensible thing — play what we hold, fetch what a peer here holds, say why not otherwise. Playing uses an **object URL over the file on disk**, never a `data:` url: the bytes are not copied into the page, which is the difference between a 60 MB recording playing and the tab dying. Dropping on the library adds to the library while dropping on the chat still sends an attachment — two targets because they are two intentions, and the library's drop stops propagating so one drop cannot do both.

### Removal & retraction (`/forget` — `app.ts`)

Per-item removal of polls, lemmas, and held notes (sidebar ✕ on each row; a `remove` button on poll cards; the `/forget <poll <id> | lemma <name> | note <token|currency denom> | list>` command).

The key problem is that gossiped state (polls, lemmas) *heals back*: a local delete is re-added by the next peer's `sync-*` push. The fix is **tombstones** — a per-room `retracted: Set<"<kind>:<id>">` (persisted `qos-retracted-<roomId>`, checked by `isRetracted`). Inbound `poll-open` / `poll-option` / `poll-ballot` / `mergePollFromSync` and the live `lemma` handler / `sync-lemmas` loop all skip tombstoned ids, so a removed item stays removed locally.

Removal is **authoritative for the owner, local-hide for everyone else**:
- A dyncap-signed `retract {what, id}` envelope is honored only from the owner — `from === poll.creator` for a poll, or the sender's verified dyncap anchor matching the lemma's stored author anchor (`entry.dyncap.anchor`) for a lemma. So a peer can retract its own item for everyone, but only hides others' items from its own view (still tombstoned locally).
- `forgetPoll` / `forgetLemma` broadcast the retract only when you're the owner; otherwise they just tombstone + drop locally.
- **Notes** are private bearer value: `forgetNote` is local-only with a confirm (no broadcast, no tombstone — the same token can legitimately be received again).

Limitation: there is intentionally **no** `sync-retracted` join replay (it would let a joiner push unverified tombstones and wipe a peer's view). So a peer that was *offline* during a retract keeps its own copy until told otherwise; peers that received the retract still ignore that peer's re-sync of it.

### Governance — liquid democracy (`/gov` — `gov.ts` + `app.ts`)

Exposes RChain [rgov](https://github.com/rchain-community/rgov)'s governance (groups, members, issues, delegated voting) on quantum-os primitives instead of running its `.rho` — the full rationale + mapping is in `Governance.md`.

Per-room `groupStore: Map<groupId, Group>` (persisted `qos-groups-<roomId>`, synced via `sync-gov`, tombstone-aware with kind `"group"`). `Group = {id,name,creator,members:Record<peerId,{role,label,at}>, delegations:Record<peerId,{delegate,at}>, topicDelegations?, trustRatings?:Record<rater,Record<ratee,0..5>>, censures?:Record<censurer,Record<target,1>>, treasury?, kudos?, uri?, issues:Issue[]}`. Wire kinds (dyncap-signed): `group-open`, `group-member` (admin-gated by `from === creator`/admin), `group-issue`, `group-vote` (links an issue to a `/poll`), and the self-signed (only `from === actor`) **`gov-delegate`**, **`gov-trust`**, **`gov-censure`**. `mergeGroupFromSync` unions members/delegations/issues by latest `at` on join.

**Liquid democracy is the centerpiece.** `gov.ts` `resolveWeights(members, delegations, directVoters, trustWeights?)` implements: *if a member votes, their ballot counts (overrides delegation); if not, their weight flows transitively along delegation edges to whoever ultimately voted*; cycles / dead-ends abstain; `weight(d) = Σ baseWeight(m)` over members `m` flowing to `d`, where `baseWeight = trustWeights[m] ?? 1`. Those weights feed `polls.ts` `tally(poll, weights)` (the approval/IRV engines take an optional `weights` map — no change at weight 1), so a `/gov vote` opens a normal `/poll` bound to an issue but tallies **delegation- and trust-weighted**. Voting *is* the per-issue override. `/gov` subcommands act on a **focused group** (set by `/gov new`/`show` or clicking the Governance sidebar); the group card (`buildGroupCard`) shows members with each member's delegate, trust weight `[wt N]`, and `⚠` discredited flag, plus per-member **delegate** / **trust dropdown** (confer a level ≤ `myLevel−1`) / **censure** toggle controls — so liquid trust + accountability are usable without typing the commands.

**Liquid trust + accountability (Phase 2d).** `gov.ts` `trustLevels(g)` is a 2-phase deterministic fixed point: **phase 1** (increasing LFP) — affirmative trust is an **admin-rooted hierarchy** (admins seed level `TRUST_MAX=5`); a rating `v` from `r` confers `min(v, level(r)−1)` — *strictly below the rater's own level* — so two untrusted members can't bootstrap each other. **Phase 2** (decreasing) — **accountability**: `trustWeightsFor(g)` returns `1 + level` (flat `1` when no ratings → exact one-person-one-vote, backward-compatible). `/gov trust <m> <0–5>` sets a rating (capped to `myLevel−1` at the command, re-capped in aggregation so a forged high rating is auto-capped); `/gov censure <m>` flags undeserved trust and, when a **⅔ quorum of eligible censurers (members of ≥ standing, floored at 2)** is reached, the target is discredited (level→0) and every voucher is **slashed** by the level they staked — so no single member (admin included) acts alone and a disagreeing admin can't block a quorum. `discreditedMembers(g)` lists the discredited; `/gov status` shows `[wt N]` + `⚠ discredited`.

**Per-issue delegation (Phase 2a).** Besides a standing global delegate, a member can set a per-issue delegate (`/gov delegate <m> on <issue>`) stored in `Group.topicDelegations[issueId]`. `gov.ts` `delegationMapFor(g, issueId)` composes topic-over-global into the flat map `resolveWeights` consumes — the resolver is unchanged. `gov-delegate` envelopes carry an optional `issueId`; `mergeGroupFromSync` unions topic delegations by latest `at`.

**The group's on-chain record (`/gov uri`).** A room is ephemeral and a registry entry is not, so a group can record the URI its record was deployed to — `rho:id:…`, validated on the way in (`looksLikeRegistryUri`), set by an admin through the existing `group-meta` envelope, carried on `sync-gov`, and shown on the group card where clicking it prefills `/rholang read`. Recorded rather than derived: the deploy happened in someone's browser with someone's key, and only they can say where it landed. What goes *behind* that URI — a Merkle checkpoint over canonical record hashes, so the room can prove what it agreed and when — is designed in issue #96, not built.

**The group's locker (`/gov locker`).** A locker is a directory somebody installed, and being in a group should be enough to reach the group's: an admin records it through `group-meta` (validated, synced like `uri`), and `/rholang register|bind|resolve|record|grant` fall back to a locker recorded by a group **you are a member of** — the focused group first — naming which group it came from, so it is never a silent substitution of a stranger's directory for your own. Membership is the gate: adopting a locker from a group you merely see would be adopting someone else's.

**Treasury + kudos (Phase 2b).** A group can declare a `/note` treasury currency (`/gov treasury`) and a kudos reputation currency (`/gov kudos`), names recorded on `Group.treasury`/`.kudos` via an admin-gated `group-meta` envelope (synced/merged). The `/gov treasury|kudos` commands are thin orchestration over `/note` (declare → grant → pass → balance) via recursive `handleCommand`; `govCurrency(g, suffix)` derives a valid, group-unique currency name. Balances are bearer-private (you see your own).

**Inbox + daemon persistence (Phase 2c).** `/gov say <msg>` posts a membership-scoped `group-msg` (only fellow members render it — no `/channel` subscription needed). The headless memory **daemon** (`scripts/qos-cli/qos-daemon.mjs`) now persists `groups.json` and re-serves `sync-gov`, applying the same group mutation envelopes (admin/self-gated) and honoring a creator's group `retract` (tombstoned `group:<id>`), so groups survive when every browser leaves. Phase 2e (not yet built): hard role enforcement, more rgov exemplars.

### Signaling server trust model

The signaling server is an **untrusted relay**:
- Routes SDP/ICE between peers; never sees WebRTC data channel contents (DTLS-encrypted)
- `wsIndex: Map<WebSocket, string>` — binds each socket to its peerId at join; validates `msg.from` on every relay to prevent forgery
- Rate-limited per connection as a **token bucket** — `SIGNAL_RATE_LIMIT` sustained (200/s on the public deployment via `render.yaml`, 20/s if unset) with `SIGNAL_RATE_BURST` depth (4× by default). Joining is bursty then quiet — offers plus their ICE candidates arrive in a clump — and a fixed window punished exactly that shape; the sustained rate protects the server, the burst is what lets a legitimate join land. The client also staggers its offers 50ms apart (`QOSPeer.JOIN_STAGGER_MS`), since the burst is otherwise self-inflicted
- Message size capped at 64 KB (`maxPayload: 65_536`)
- Logs show only last 8 chars of IDs

### How many people a room holds

Full mesh: every browser opens a connection to every other, so the cost per person is the room's size and a browser gives out somewhere past ten (fewer on a call, where each link carries media). `ROOM_HOLDS = 10` in `app.ts` is that fact, not a configured cap — nothing is refused at the door. Five is where a group actually thinks together, so the human limit binds first.

What matters is that the room **says so**: a peer in the roster with no data channel is `⚠`/dimmed (`QOSPeer.hasChannel`), the status line counts them, The sweep **never redials an attempt already in flight** (`connecting()`): a connection still negotiating has no open channel either, and redialling sends a fresh offer with a new ICE ufrag, so the far side rebuilds and the negotiation in progress is discarded — a peer whose path is merely slow (mobile: more candidates, longer checks) would be reset before it could ever finish. Answering an offer counts as an attempt for the same reason. `RETRY_MIN_MS` is 20s and an attempt is given `ATTEMPT_PATIENCE_MS` (45s) before it counts as stuck. A handshake still unfinished after `HANDSHAKE_GRACE_MS` (30s — deliberately longer than a retry cycle, since `peer.ts` sweeps every 12s and first retries at 8, so a shorter grace announces a failure while the repair is still running) posts one line per peer, cleared by a `✓ connected after all` when the channel does open — "the room is full" past `ROOM_HOLDS`, "the handshake never completed" below it. Unmarked, this is indistinguishable from chat being broken, which is how it was reported: two browsers each had a channel to the agents and none to each other, so only the agent's replies landed.

Past ten needs a different topology (an SFU for media, a relay or partial-mesh/gossip overlay for data), not a bigger rate limit.

### Whether two peers can connect at all (`/ice`)

STUN only tells each side what its public address looks like; the connection is still made **directly**. Two peers behind symmetric NAT — a corporate network, mobile CGNAT — have no address pair that works, so the handshake fails **permanently** and the retry sweep cannot help: it is not a timing problem. Only a TURN relay crosses that.

`DEFAULT_ICE` is STUN alone, and a relay is **not** defaulted because it carries the traffic (DTLS keeps it unreadable, but whose machine it passes through is the user's decision). `/ice list · test · stun · turn · reset` is where that decision is made — and it is **excluded from the qlf broadcast**, because a TURN entry carries a username and password and the envelope would have carried them to the whole room, persisted per device (`qos-ice`) and merged with the sidebar's STUN field by `iceServersFor`. **`/ice test`** gathers candidates (until gathering completes, or 5s) and names what the network allows — `host` (same LAN), `srflx` (STUN answered), `relay` (a TURN server is available) — which is the difference between "this pair is slow to connect" and "this pair cannot connect". The result is **one fenced block, kept on the device** (`qos-ice-last`) and re-readable with `/ice last`: a diagnostic is only useful once somebody else has read it, and on a phone five separate lines are easy to lose. A failure of the test itself is reported rather than swallowed — silence read as "no candidates", which is a different diagnosis entirely.

### Signaling reconnect / false peer left-right

When the signaling WebSocket drops and reconnects (Render.com sleep, network blip):

- **`peer.ts`**: On receiving the `"peers"` list after reconnect, skip peers where the WebRTC data channel is still open — avoids tearing down a working connection
- **Reconnect = rebuild, not renegotiate (the reload fix)** — `peer.ts` **and** `qospeer.mjs` `handleOffer`: a **reload keeps the peerId** (sessionStorage) but dials in with a **fresh ICE session**. If the answerer still holds an `"open"` stale connection to that peerId (the close not yet detected — racy), answering the fresh offer *as a renegotiation on the dead pc* never resurfaces the peer's **new data channel** (`ondatachannel` doesn't re-fire on renegotiation), so the reloaded peer connects-but-stays-silent — no `name` announce, no messages, just a hex id, and only for the non-deterministic subset of peers whose stale connection lingered. Fix: compare the offer's **`ice-ufrag`** to the live connection's (`iceUfrag`/`_iceUfrag`) — **same ufrag** = a genuine same-session renegotiation (keep the pc, e.g. call media added); **different ufrag** = the peer reconnected/reloaded ⟹ **rebuild a clean pc** (resurfaces the data channel ⟹ `onChannelOpen` fires ⟹ re-announce). Do not "reuse the existing pc on any second offer" — that reintroduces the silent-reload bug. (Browsers are stricter here than werift, which masks it with an implicit ICE restart — so it reproduces in the real browser, not the werift↔werift loopback.)
- **`peer.ts` presence eviction (stale-room fix)**: an *ungraceful* drop (killed tab, network loss) sends no `leave`, and the connection often never reaches `"failed"`. So `declarePeerGone` fires `onPeerLeft` on **data-channel `onclose`** (the reliable signal for a clean tab-close) and on connection state `"failed"`/`"closed"`; `"disconnected"` starts an 8s grace timer (`disconnectTimers`) and evicts only if it doesn't recover to `"connected"`. `declarePeerGone` is idempotent (a had-connection guard), so the channel-close and state-change paths can't double-fire
- **`qospeer.mjs` disconnected-teardown (the pegged-CPU fix)** — the Node-side counterpart of the `peer.ts` presence eviction above, and the same root cause: **werift never escalates `"disconnected"` to `"failed"`** (its ICE layer implements no consent-freshness timer; `iceConnectionStateChange` maps `disconnected → setConnectionState("disconnected")` and nothing moves it on). `_newPC` cleaned up **only** on `"failed"`, so a peer that vanished silently (closed browser, shut lid, dropped wifi) parked a connection in `"disconnected"` **forever**: `pc.close()` was never called ⟹ `sctpTransport.stop()` never ran ⟹ the SCTP association retransmitted its unacked queue at full speed, re-encrypting every chunk through werift's pure-JS DTLS. **One zombie peer pegs a core indefinitely** — measured at 79% CPU on a facilitator with **0 UDP datagrams/s in or out** (the giveaway: it encrypts into a void, since the transport is gone). Fix: also tear down on `"disconnected"` after `DISCONNECT_GRACE_MS` (30s), re-checking that the **same** `pc` is still stuck so a recoverable blip doesn't kill a live peer; `_cleanup` now deletes from the maps *before* closing (`close()` can fire a state change re-entrantly) and routes the `close()` rejection to `onError` instead of swallowing it — `close()` is **async** and awaiting `sctpTransport.stop()` is the whole point. **Diagnosing a recurrence:** compare CPU against UDP throughput (`/proc/net/snmp` `Udp: OutDatagrams`) — high CPU + ~0 pkt/s means an orphaned association, not real traffic; `ps` `%CPU` is a *lifetime average* and understates it, so use `top -bn1` or a `/proc/<pid>/stat` delta. A CPU profile pins it instantly (`Profiler` over the inspector): the stack is `transmit@sctp.js → sendChunk → dtls → encryptPacket → createCipheriv`. Note the burn is **independent of signaling churn** — it recurred after a restart with only ~67 reconnects in 19h.
- **Present is not reachable (`hasChannel`)**: the signaling server lists a peer as soon as it joins, but the WebRTC handshake is separate and can simply never complete — the public server rate-limits the offer/answer/ICE exchange itself, so past a handful of peers in one room some channels never open. Everyone appears in the room and nothing typed reaches them, which reads as "chat is broken" rather than "you are not connected to them" (reported that way: two browsers each had a channel to the agents and none to each other, so only the agent's replies landed). `QOSPeer.hasChannel(peerId)` answers it; `renderPeers` marks those peers `⚠`/`.unreachable` and `connectedLabel` counts them, so the failure is visible where the peer is. `onChannelOpen` repaints unconditionally — a peer already listed from signaling needs the mark cleared.
- **Async command output belongs to a room (`inRoom`)**: `activeRoom` is aliased state that inbound callbacks swap while they work, so a command answering after an `await` can append its lines to whichever room happened to be current — where they are invisible, or rendered and then wiped by the next transcript repaint (which replays the *viewed* room's log). That is what "the message flashed briefly" is. `inRoom(ctx, fn)` captures the room at command time and restores after, the way the peer callbacks already do; `/ice test` and `/rholang explain` use it.
- **`app.ts`**: `onPeerLeft` is debounced 6 seconds via `pendingLeaves: Map<string, timer>` and is idempotent (one pending-leave per peer). If the peer rejoins within the window, suppress both "left" and "joined" messages silently
- **Background-tab recovery + presence polish**: `peer.ts` `wake()` (reconnect now, reset the throttled backoff; floor lowered to 1.5s) is called on `visibilitychange`/`focus`/`pageshow`/`online`, so peers return instantly after a tab switch instead of "eventually"; `app.ts` adds a peer to the roster on **`onChannelOpen`** too (not just signaling-join), so a remote-initiated peer (e.g. an agent that dialed us) shows up; agents are flagged **🤖** in the roster via `peerAgents` (from the `name` envelope's `agent:<role>`); the status line shows a live `connected · N peers` / `reconnecting…`; the "joined" line waits for the peer's **name** (`pendingJoins`, 5s id fallback) so it reads "Jim joined", not a raw id. **Sticky identity caches (survive flaps):** both the display name (`lastKnownNames`) and the agent role (`peerAgents`) are per-`RoomContext` caches that are **never cleared on leave** — only reset when a peer re-announces itself as a non-agent — so a flapping AI daemon keeps its name **and** its 🤖 badge across reconnect churn instead of decaying to a raw hex id (a departed peer's stale entry never renders — the roster only badges ids still in `peers`). Do not re-add a `peerAgents.delete` to the leave-grace timer

### Macros — Interact2 (`/macro`, `+name` — `macro-lang.js` + `app.ts`)

User-written commands. EIES let a user write a command, share it, and watch a
group adopt it; that was the point of the system rather than a feature of it
(`EIES_Legacy.md`). The direct predecessor is **MacRhoLang / @RHO-bot**, which
already had `$` sites, `define:`/`echo:`/`find:` and command-form invocation.
Full reference in [RChain_Macros.md](RChain_Macros.md); summary for code work:

**`/` is what the app ships, `+` is what a person wrote.** The verbs that manage
definitions are built in (`/macro define|list|show|find|echo|remove`); what they
produce is invoked `+name args`. `++text` escapes a literal `+` line to chat, and
only an identifier-shaped name is read as an invocation — so `+1` is agreement,
not a call.

**Two halves, decided by the body.** `bodyKind()` reads the first non-blank
line: starting with `/` or `+` makes a **command** macro (invokable as `+name`);
anything else makes a **rholang** fragment, invokable only as a `$name(…)` call
site inside `/rholang eval|deploy|echo`. Nothing declares the kind — and
`macroFromWire` re-derives it from the body rather than believing the sender, so
peers cannot disagree about what one definition is. A `+command` reaches the
chain by having `/rholang eval` in its body, so the two halves compose with no
third mechanism.

**The two halves have different lexical rules, and this is the subtle part.**
`substitute` and `expandCallSites` take `lexical: "rholang" | "text"`:

- *rholang body* — `"$topic"` is a string literal and `$topic` is text (the
  language's own rule); a call-site argument is a **term**, so `$print("hello")`
  must expand to `stdout!("hello")` with the quotes intact.
- *command body* — there are no string literals. `/gov say on "$topic" now` is a
  line somebody typed and `$topic` **substitutes**; an argument is a **word**, so
  `+standup "Q4 budget"` binds `Q4 budget`. Treating command text as rholang
  produced a command with a literal `$topic` in it, which is the worst kind of
  wrong: it runs.

`bindArgs(def, args, plain)` carries the same split (`plain` = command line).
A nested macro is expanded under **its own** body's rules, not its caller's.

**Binding is textual**, which is what makes quantum-os#65's `match [$height] { [height] =>
… }` work rather than something separate from it — the argument lands in the
match subject and rholang's own `match` binds it, so a body stays ordinary
rholang. Positional by default; if *every* argument is `name=value` they bind by
name; mixing is refused.

**`splitBody`**: a line beginning with `/` or `+` at column 0 starts a command,
anything else continues the one before it — so a multi-line rholang program is
the argument to `/rholang eval` with no terminator.

**Errors never abort.** Every site is attempted and a failed one is left exactly
as written. `$` being lexically illegal in rholang is what makes that safe: an
unexpanded site is a hard error at rnode, never something that quietly means
the wrong thing. (`%` is rholang's modulo operator, so it carries no such guarantee.)

**Storage is the room, not the chain.** `macroStore` is per-`RoomContext`,
persisted `qos-macros-<room>`, broadcast as a dyncap-signed `macro-define`,
replayed to joiners via `sync-macros`, and tombstoned through the existing
`retract` machinery (kind `"macro"`). **First writer wins a name and only that
author may redefine or retract it, matched by dyncap `anchor`** — `MacroDef`
stores the anchor rather than a chain step, because a reload mints a new peerId
and would otherwise cost you your own commands. That is the room ("group") tier
of EIES's personal → group → system hierarchy; the on-chain dictionary (public /
federated tier, behind a capability) is designed and not built.

Recursion is bounded twice: `MAX_DEPTH` inside expansion, and `MACRO_RUN_DEPTH`
in `runMacroLine` for a body that invokes another body at runtime. `runInput()`
is the router — `+` to `runMacroLine`, anything else to `handleCommand` — and is
what `/script` and `/rhoqu` call so their segments can be `+commands` too.

### Reaching a chain (`/rholang` — `rholang.ts` + `rholang-macros.js` + `rholang-pipeline.ts` + `rholang-agent.mjs`)

Bridges a room to an RChain chain: a room's state is ephemeral, a deploy is not.

**`/rholang` is the current command** (`packages/browser/src/rholang.ts`). Three verbs over rnode's HTTP API: `status`, `eval` (exploratory deploy — runs read-only over finalized state; pure rholang and the system processes both return values), and `deploy` (secp256k1 over blake2b256 of the protobuf encoding of `DeployDataProto` — the encoding must match rnode's byte for byte, proto3 default-omission included). `eval`/`deploy` open a syntax-highlighted, live-linted editor (`rholang-editor.ts`) whose header carries **the node and its live status** — version, shard (flagging a mismatch with yours), block height and phlo floor, checked when the editor opens and again on click, because the answer goes stale while the editor is open and pressing Evaluate is the wrong way to find out — and that offers four actions: **Explain** (what the program will do: where it goes, what it costs, which powerbox names it reaches and what each answers, which macro sites expand, and a warning when nothing is sent to `return` so the run would look empty — assembled from what the app knows, never a reading of the program's meaning. What explaining actually wants is somebody who can **read** the program, which is an **AI agent in the room** and not an rnode — so the agent leads: **`/rholang explain [program]`** is the verb, and asking is what it does: the program and the question ("explain this rholang program and any security concerns, briefly") go to the room, where the agent reads them and answers where everyone can see. The editor's **Explain** button gives the same account *without* asking the room, and prefills `/rholang explain …` instead — the difference is who decided to publish the program, which should stay the person rather than the button, and when none is, it says so, because that is the missing piece rather than a missing node. Whether the rnode answers is a footnote after it, since Explain is useful with no rnode at all; a shard mismatch is still flagged, because it rejects a deploy), **Show** (the expanded program in the form it would be sent, sending nothing — the answer to *should I sign this*; `/rholang show` is accepted alongside `echo`, after MacRhoLang's own name for it), Evaluate (Ctrl+Enter) and Sign-and-deploy (Ctrl+Shift+Enter), the typed verb only deciding which is primary, so the choice between running a program and paying to land it in a block is made once you can see the program; it resolves `{source, mode}`, Esc cancels, and it loads a `.rho` from disk, accepts one dropped on it, or saves the program back out; a program written inline runs as typed. Every program is wrapped in `new return, stdout, zfa, grant, verify, fuse in { … }`; a deploy additionally writes what `return` answered to the deployer's own registry slot (`rho:registry:insertSigned:secp256k1`, at the uri `registryUriOf` derives from the key) and to stdout, because a deploy otherwise answers only into rnode's log. `/rholang read` looks that slot up; the nonce advances per write and `/rholang nonce` re-syncs it from the slot. `bin/rnode` ships with the repo and `scripts/localnet/run-node.sh` starts it — no build, no rchain-rust checkout. A deploy executes and is charged there, and both `eval` and `deploy` reach the qucalc powerbox — verified against rchain-rust `dev` at `0a2141be1`. `match` selects the branch it should — first written branch wins, `_` is reached only when nothing before it matches — and a runaway term returns `reduction step budget exceeded (10000 steps)` with rnode still serving, the ceiling nowhere near ordinary work (a terminating recursion returns at depth 2560). **One shape to avoid** ([rchain-rust#19](https://github.com/rchain-community/rchain-rust/issues/19)): a one-binder persistent receive inside a nested `new` does not terminate, so every `contract` takes at least two parameters — `contract c(_, ret) = { … }` where a verb genuinely takes only a return channel. Note the budget error arrives as a bare JSON string where success is a `{expr, block}` object, so a client written for the success shape renders a runaway as an empty result. Several sends to `return` all come back but in no dependable order (`eval` reverses source order; the deploy read path differs) — encode order in the program if it matters, and `/rholang eval` says so whenever it prints more than one value. `renderExpr` turns rnode's wire shape into rholang: `ExprPar` reads as `12 | 14 | 16` (the program's own `|`), and an expression a future build names differently renders its contents rather than printing raw JSON at whoever ran the program (`test/render-expr.test.mjs`, payloads taken from a live node).

**Macro call sites expand before a program is linted or signed.** Two libraries, one pass, built-ins first: `%name(…)` from the approved capability library that ships with the app, `$name(…)` from what the room defined with `/macro` (see the Interact2 section above). `/rholang macros` lists the built-ins, `/rholang macro <name> <args…>` runs one on its own when the whole program is that macro, and `/rholang echo` shows the expansion — which is what answers *should I sign this*. Full reference in [RChain_Macros.md](RChain_Macros.md).

**The body is rholang, not a command line.** A program is one line or many, with call sites written `%name(arg, …)`. The rholang is **not parsed**: `expandProgram` scans only far enough to find call sites that are really call sites (skips string literals and both comment forms, balances `()[]{}`, splits args on top-level commas), expands each in place, and passes every other byte through as written. A sigil is what makes that safe without a grammar — a bare `ballot(…)` is indistinguishable from a real contract call. Errors never abort: every site is attempted, each error carries its line, and a failed site is left exactly as typed. **Note the asymmetry between the sigils:** a leftover `$` is a hard error at rnode, `$` being lexically illegal in rholang; a leftover `%` is rholang's modulo operator and will not be, so the error report is the only thing that catches it. That is why a room's own macros use `$`.

**Single source of truth.** `packages/browser/src/rholang-macros.js` is plain JS with no imports, consumed by **both** halves — `scripts/qos-cli/rholang-macros.mjs` (18-line binding, node) and `packages/browser/src/rholang-pipeline.ts` (browser). The ZFA kernel is *injected* (`createMacroEngine(kernel)`) because each side has its own build (`zfa.mjs` / `zfa.ts`). They were once separate copies; a macro edited in one and not the other meant the rholang a user reviewed in chat was not the rholang their browser signed, and both copies independently carried the same `Number()` precision bug.

**Zero-trust split.** The agent only *expands*, in the open, into room chat. The browser lints (`crates/zfa-core/src/lint.rs` via WASM), signs (key generated locally, wrapped by a passphrase-derived AES key in IndexedDB), and deploys. A compromised agent can post misleading chat text and nothing more.

**20 macros**, mirroring the `qucalc/examples/*.rho` in rchain-rust: proofs (`grant`, `fuse` → `rho:qucalc:*`), group decisions (`trust`, `weights`, `tally`, `censure` → `rho:gov:*`, plus `ballot`/`delegate`), bearer capabilities (`issuer`, `note`, `redeem`, `directory`, `mailbox`, `group`, `transfer`), and structural patterns (`swap`, `philosophers`, `multisig`). Arg types: `string`, `twists`, `list`, `cap`, `int` (BigInt decimal digits), and `term` (a rholang term passed through verbatim — the `rho:gov:*` maps; program-form only, since the bare form splits on whitespace).

**What is not enforced.** There is no forbidden rholang and no forbidden name. The expander does not content-police arguments and the linter checks only delimiter balance. Capability security decides what a deploy can reach; a denylist decided nothing rnode does not already decide while rejecting ordinary input ("New York", `for(`). What *is* enforced: every string reaches rholang through `JSON.stringify` into a literal so it cannot escape its position, and amounts are BigInt so the value approved is the value signed.

**Known gaps.** The browser signs **ECDSA P-256** where RChain needs secp256k1 (Web Crypto has no secp256k1) — a pipeline placeholder, nothing signed today is valid on a real network. Macros expand to *standalone* programs (`new ret in { … }`), so embedding one mid-expression yields rholang the linter rejects. The agent and browser halves are not yet a closed loop.

**Local testing.** A single standalone node runs everything: `rnode run -s --autopropose --no-upnp --host 127.0.0.1 …` (`--host` matters — without it the node guesses an external IP and Kademlia fails to bind). Ports 40401 external gRPC / 40402 internal (eval, propose, repl) / 40403 HTTP. `rnode --grpc-port 40402 eval f.rho` runs rholang with no signing and no block — the fastest loop. `No value set for `rho:qucalc:zfa`` means the node is running a build from before the QuCalc processes landed; a running node keeps its binary image after the file on disk is replaced.

### Room agents + collective optimization (`scripts/qos-cli`)

Headless **agent daemons** join a room as full peers (Node; `werift` + `ws`), reusing `QOSPeer` (`qospeer.mjs`) + dyncap identity. The generalized daemon is **`agent.mjs`**; `facilitator.mjs` is a thin back-compat shim (`--role facilitator`). `scripts/qos-cli` is **outside the pnpm workspace**, so it doesn't affect the TS/Rust CI — test with `node --check` + the `*.selftest.mjs`/`loopback.mjs`/`optimize-demo.mjs` scripts.

- **Roles** (`agent-roles.mjs`): `facilitator`, `scribe`, `greeter`, `skeptic`. A role = default name + command prefix (`cmd`) + AI `persona` + a `duties` map (intro/greet/namePrompt/silentQuarter/dominator/discrepancy/stimulate/synthesize/**verify**). **`verify`** (skeptic only) is the census-backed check: an inbound `lemma` or `/qlf-action`/`/zfa-check` history that passes the room's aggregate `achieves_zfa` but fails QLF's `achieves_zfa_pairwise` gets flagged once, with its signed action vector and the census scale of the gap (at length 6, 20,480 admitted against QLF's 5,120). `zfa.mjs` carries the ported predicate + `CENSUS_ADMITTED`. Adding one = a single registry entry (`resolveRole`/`dutiesOf`). Run: `node agent.mjs --room <cap> --role <r> [--ai --ai-backend claude-code]`.
- **AI advisor** (`facilitator-advisor.mjs`, `makeAdvisor`): backends `api` (Anthropic Messages API, `ANTHROPIC_API_KEY`) or **`claude-code`** (shells out to the local `claude` CLI = a Claude Pro/Max subscription, **no API credits**). Modes: `ask`, `stimulate`, `synthesize`, `optimize`, **`chair`** (per-phase deliberation synthesis + closure decision; phase-aware tokens, NONE-bypass so phases always render). Persona + `cmd` are per-role. The **`ask`** mode's system knowledge (`askKnowledge`) makes the agent an **expert on QuantumOS itself** — the P2P/capability-token room model + the full slash-command set (kernel, messaging/sharing, decisions/gov, `/render`, identity) + the docs — so `/facil ask "how do I …"` names the exact command (e.g. `/render` for "see the room animation").
- **Trust governance** (`gov.mjs` — faithful port of `gov.ts` `trustLevels`): the agent ingests `gov-*`/`group-*`/`sync-gov`, computes its own standing, and **scales its post budget by trust level** (`min(--budget, level)`); a ⅔ censure-discredit makes it stand down. Agents are rated/governed, **not** raters.
- **Multi-agent coexistence**: agents tag their `name` envelope with `agent:<role>`; **lead election** (lowest peerId among agents sharing a duty) de-dups shared proactive duties (intro is same-role-scoped, so each role self-introduces); posts count **collectively** against a human fair-share.
- **Commands** (user-invoked, relayed by the browser as chat — `handleCommand` relays `facil`/`facilitator`/`scribe`/`skeptic`/`greeter`): `/<cmd>` (present?), `/<cmd> help`, `/<cmd> ask <q>`, **`/<cmd> optimize <problem>`**, **`/<cmd> chair <topic>`** (+ `next`/`back`/`close`/`cancel` to steer it), `/<cmd> trust`, **`/<cmd> health`** (uptime/RSS/CPU, signaling + channel state, present peers, budget used, trust standing, last error — CPU as a lifetime average *and* a delta since the previous check, since the average hides a runaway the way `ps` %CPU hid the orphaned-SCTP burn), `/<cmd> off|on`. Replies bypass the nudge throttle; per-peer self-introductions mention the command + `MyRoom`.
- **Reliability**: `qospeer.mjs` has a 30s ping/pong **keepalive** (and a 30s `"disconnected"` teardown grace — see the pegged-CPU fix above) (reconnects a dead/zombie signaling socket — without it a long-running agent goes deaf to new joiners). Persistent identity + greet-state under `--state ./.qos-<role>`. **`run-agents.sh` / `stop-agents.sh`** launch/stop a detached set — `facilitator` + `skeptic`, staggered 15s (`STAGGER=n`); the `/rholang` macro agent is not among them, since the browser expands locally and the agent is only worth a peer when the room wants the expansion posted into chat. **`room-memory.mjs`** holds the durable half of a room (lemmas, currencies, terms-series, gov groups, dyncap chains, transcript; re-served to every joiner) and has two carriers: `qos-daemon.mjs` as a peer that does nothing else (no AI, no subscription), or `agent.mjs --persist <dir>` folding it into a role agent — one fewer peer against the signaling ceiling, at the cost of tying durability to an agent that also talks. Serving is deliberately **not** lead-gated: greeting is lead-only so N agents don't all greet, but state must be served by whoever holds it or a joiner gets nothing. `scribe` is not launched by default because its duties are a strict subset of the facilitator's; `skeptic` is, because it alone carries `verify`. `stop-agents.sh` with no arguments stops everything holding a pidfile rather than a hardcoded role list — a spelled-out list silently omits whatever is not in it, leaving that agent unstoppable by name and outliving every "stop all" around it. The signaling server caps the per-connection message rate (`SIGNAL_RATE_LIMIT`), and a peer joining a room of N sends N−1 offers plus a burst of ICE candidates, so the join cost is superlinear in room size: over the cap, handshakes stop completing while every peer still appears in the room. The **code default is 200/s** (burst 800), because a default that breaks a four-peer room protects nothing — what guards the server is the 64 KB payload cap and the wsIndex relay auth. `render.yaml` also sets it, but **a service Render did not create from that blueprint ignores the file**, so the default is what a hand-created service actually runs, and a deploy proves nothing about the environment. `GET /` reports the enforced `limit`/`burst`, and `scripts/qos-cli/signal-probe.mjs` measures what is really enforced (a manual deploy of the token-bucket code showed 21/s against the 200 the file asked for). The code default, 20/s, blows at about four peers. A browser marks a peer it has no data channel to (`QOSPeer.hasChannel` → `⚠` in the roster, "N unreachable" in the status line), so the failure is visible rather than reading as "chat is broken". **Self-healing identity announce:** the agent signs its `{name, agent:<role>}` envelope **once and caches it** (`announceName`/`signedNameEnv`), so the channel-open announce and the throttled re-announce from the 30s tick loop (`reannounceStale`, ≤ once/90s per present peer) are byte-identical idempotent re-deliveries (same anchor+seq+witness — no seq advance, no fork). This recovers the single channel-open announce when it is lost to a signaling flap (async sign + a closing data channel), which otherwise leaves a fresh browser showing the agent as an unlabelled hex id.
- **Collective optimization** (`Collective_Optimization.md`): the room run as a quantum-annealing-style optimizer — propose → score (`/poll`/`/estimate`, trust-weighted) → anneal → `/probe` → `/lemma`. `/facil optimize` (advisor `optimize` mode) facilitates a round; **`optimize-demo.mjs`** is a runnable room-session demo (named participants + a Facilitator → brute-force TSP optimum). Honest scope: a metaheuristic, **not** an instant/optimal NP solver (`OptimizationDemo.md`).
- **Chaired deliberation** (`/facil chair <topic>`, needs `--ai`; [`scripts/qos-cli/README.md`](scripts/qos-cli/README.md) "Chaired deliberation"): the facilitator becomes the room's **single neutral chair** and walks the group through six phases — **define → alternatives → evaluate → disagreements → agreements → closure** — posting a neutral synthesis at each step and recording a **decision-of-record** receipt (`<state>/rooms/<room>/deliberations/<ts>-<slug>.json` + a `deliberations.json` index; `/lemma` it into a room decision). Steered by `/facil next` (a *participant readiness signal* — anyone sends it, the one chair performs the transition, re-entrancy-guarded via `chair.busy`), `/facil back`/`close`/`cancel`; `/facil status` shows the phase. Phase prompts/syntheses ride the un-throttled `reply()` path, so a session steps briskly while the facilitator stays light-touch otherwise. **One leader by design** — Jim's EIES finding (a computer leader *and* a human leader at once stymies consensus; see `Governance.md` / `Room_Best_Practices.md`): the chair is the sole leader for the session, following best-practice facilitation (neutral framing, equal airtime, surface before converging). The six phases are the substrate's generate-then-close pattern applied to a group (divergent define/alternatives → prune evaluate/disagreements/agreements → ZFA-closed closure receipt). Verified by the live two-peer walk (in-process signaling + the real `agent.mjs` running `claude` + a driver peer through all six phases).

---

## Slash commands (app.ts `handleCommand`)

| Command | Description |
|---------|-------------|
| `/help [command]` | List all commands; `/help <command>` shows per-command detail from the `CMD_HELP` registry (e.g. `/help note`) |
| `/id` | Show your peer ID |
| `/room` | Show room ID |
| `/cap [label]` | Mint a random ZFA capability token |
| `/grant [label]` | Mint and broadcast a capability token |
| `/zfa <token>` | Validate a capability token, show twist stats |
| `/braket <states>` | Evaluate bra-ket (states: 0 1 + - i -i) |
| `/qucalc [twists]` | Evaluate RhoQuCalc twist sequence; accepts `@name` refs |
| `/conj <twists>` | Hermitian adjoint (reverse + parity-flip); flags self-adjoint inputs. The QLF "negation" operator; fixed locus Σ_sa is the operator-side counterpart of the Riemann ξ critical line (see `ReverseMathematics.md` §4.9). |
| `/freq [n\|twists]` | ZFA frequency spectrum (C(2n,n) arrangements) |
| `/lemma [name [tw]]` | Register/list named lemmas; omit twists to auto-allocate |
| `/request <name>` | Broadcast that you need `@name`; holder sees a `/pass` prompt |
| `/pass <name> <peer>` | Transfer `@name` directly to a peer; removes from sender's store, auto-registers on recipient's |
| `/note <sub>` | Promissory notes — `declare`, `grant`, `pass`, `redeem`, `split`, `merge`, `list`, `balance` |
| `/rdv <sub>` | N-party atomic rendezvous — `swap`, `accept`, `reject`, `abort`, `list` |
| `/poll <sub>` | Group decision — `new <q> [\| seeds] [ranked]`, `add <opt>`, `vote [id] <choices>`, `status`, `lock`, `close`, `remove`, `list`. Collect-then-vote with approval / ranked-choice (IRV); deterministic joiner-local tally |
| `/estimate <sub>` | Robust group numeric estimate — `new <q>`, `<number>` (submit), `status` (median + IQR), `close`; `--mean` opt. Mesh-synced (`estimate-open`/`-value`/`-close`); median is whale/outlier-resistant |
| `/coupling [tw …]` | Was the room's closure shared, or several side by side? Cuts a joint history into factors and classifies it `independent` / `product` / `coupled` / `open` against the census baseline. No args = the room's own peers (see the limitation above) |
| `/qlf-action <tw>` · `/zfa-check <tw>` | Collaborative-study verbs over the `zfa-core-wasm` kernel — propose a history string / verify ZFA closure locally (`is_count_balanced ∧ is_pauli_closed`); used by the colab-study macro |
| `/forget <sub>` | Remove an item — `poll <id>`, `lemma <name>`, `note <token\|currency denom>`, `group <name>`, `list`. Owner retracts for everyone (dyncap-signed `retract`, tombstoned so it can't re-sync back); others hide locally. Notes delete with confirm |
| `/gov <sub>` | **Liquid-democracy + liquid-trust governance** (rgov on primitives) — `new <name>`, `show`, `member add\|remove`, `issue <title>`, `delegate <peer> [on <issue>]`/`undelegate`, **`trust <member> <0–5>`** (confer a level below your own), **`censure\|uncensure <member>`** (⅔-quorum accountability), `vote <issue> \| opts [ranked]`, `treasury declare\|grant\|balance`, `kudos <m> <n>\|balance`, `say <msg>`, `status`, `list`. Transitive delegation + trust-weighted tally; treasury/kudos via `/note`; per-group inbox; daemon-persisted; see `Governance.md` |
| `/dyncap <sub>` | Hash-only dynamic capabilities — `status`, `peers` |
| `/probe <sub>` | Joiner-local consensus probe — `status`, `clear` (the probe runs automatically on connect) |
| `/room <sub>` | Multi-room tabs — `list`, `join <cap\|url>`, `leave`, `ref`, **`hide`/`show`**. Hidden is the default: a room cap is a bearer capability, so the address bar (plus the share row and the sidebar line) is in every screen share, screenshot and recording. Hiding keeps it off screen without losing it — `qos-active-room` remembers which room a reload returns to, joined rooms come back as tabs, and copy / `/room ref` still hand out the link. Persisted per browser under `qos-hide-room` |
| `/share <selector> to <room>` | Bridge a lemma / chat / note from the active tab into another joined tab (application-level; no cross-room wire kind) |
| `/rdv counter <id> …` | Round-trip negotiation in an in-flight rendezvous — replaces rows, swaps locks, counterer implicitly accepts |
| `/channel <sub>` | Tagged broadcast messaging — `list`, `listen <name>`, `unlisten <name>`, `send <name> <text>`; per-room subscriptions |
| `/record` (⏺ in the toolbar) | Record what is on your screen, with audio, to a `.webm` download. `getDisplayMedia` + your mic + **every peer's live audio taken from the call** (a window share offers no audio at all, and a tab share only carries the room because its voices come out of the page — so they are mixed in directly instead, and a peer who joins mid-recording is added). Everything else the device is playing reaches a recording only through the picker's own **Share system audio** checkbox on a whole-screen capture (ChromeOS/Windows; Chrome does not offer it on Linux) — a consent decision no constraint can pre-tick, so `systemAudio: "include"` asks that it be offered and the chat line says it is there. 15 fps / 1.2 Mbps ≈ 540 MB/hour. **No `displaySurface` constraint** — Chrome treats it as a filter on what the picker returns rather than a hint about which pane it opens, so naming one takes the choice away from the person making it (asking for a window handed back a window when a whole screen was wanted). What *is* asked for is that the picker offer everything: **`selfBrowserSurface: "include"`** (Chrome excludes the capturing page by default, which hid the room's own tab — the one most worth capturing) and **`monitorTypeSurfaces: "include"`** for whole screens, plus `surfaceSwitching` so the surface can change mid-share. The chat line names what was actually captured — "your entire screen" / "one window" / "one browser tab" — while it can still be redone. Screen capture is desktop-only: Chrome on Android has no `getDisplayMedia`, and `noScreenCapture()` says so in those words rather than reading as a bug. Video is the surface you picked, nothing composited: a peer's video is on it if their tile is on that surface. Needs no call in progress. Broadcasts a `record {on}` line on start and stop: nobody is recorded silently |
| `/render` (alias `/animate`) | Opens `public/render.html` — an animation of the current room: its perspectives (peers, you included) bound to the shared room closure, its closures (lemmas), and groups. Snapshot of live state (peer/lemma names + group/channel counts) passed via URL params; local-only (window.open), not broadcast. The QLF/ER=EPR picture applied to the live room |
| `/script <c1>;…` | Sequential command chain on one line; `//` skips a segment |
| `/persist <sub>` | Agreed cross-peer replication of public state — request, accept, reject pending requests |
| `/rholang <sub>` | **Run rholang on rnode** — `eval` (run it, read values back; unsigned, no block), `deploy` (sign with a browser-held secp256k1 key and submit), `status`, `powerbox`, and the rnode settings `rnode <url>` · `shard <id>` · `phlo <limit> [price]` · `key generate\|<hex>\|show\|forget` · `config`. `eval`/`deploy` open a syntax-highlighted, live-linted editor (`rholang-editor.ts`; Ctrl+Enter runs, Esc cancels, loads or accepts a dropped `.rho`), while a program written inline runs as typed; every program is wrapped in `new return, stdout, zfa, grant, verify, fuse in { … }`. Over rnode's HTTP API (CORS-open), so no relay and no agent in between |
| `/macro <sub>` | **Interact2 — write a `+command`.** `define $name($a) // doc` + a body · `list` · `show <n>` · `find [re]` · `echo <n> [args]` (expand, run nothing) · `remove <n>`. A body of slash commands makes a `+command`; a body of rholang makes a `$name(…)` fragment for `/rholang`. Definitions are dyncap-signed room state (`macro-define` / `sync-macros`, tombstoned by `retract`), first-writer-wins by anchor. See [RChain_Macros.md](RChain_Macros.md) |
| `+name <args>` | Run a command somebody in the room defined. Quotes group an argument, `name=value` binds by name. `++text` sends a literal `+` line; a non-identifier like `+1` is ordinary chat |
| `/rhoqu <text>` | RhoQu macro language: parse `process` / `new` / `\|` parallel / `if` / `on channel` / `for`, transpile to `/command` strings, dispatch in order. `/rhoqu list` and `/rhoqu clear` manage registered `on` handlers (per-room). |
| `/dump` | Summary of all logic shared this session |
| `//message` | Send a message that starts with `/` |

Broadcasting: commands that broadcast their output via `{kind: "qlf", cmd, arg, lines}` are anything not in this exclusion list: `/help`, `/grant`, `/lemma`, `/note`, `/rdv`, `/poll`, `/forget`, `/gov`, `/estimate`, `/dyncap`, `/probe`, `/room`, `/share`, `/channel`, `/record`, `/ice`, `/render`, `/animate`, `/script`, `/persist`, `/rhoqu`, `/macro`, `/rholang`, `/request`, `/pass`, `/dump`. Excluded commands send purpose-specific envelopes (e.g. `/gov` → `group-*`/`gov-*`, `/estimate` → `estimate-*`) or are local-only, so a generic qlf rebroadcast would be redundant or noisy. `/qlf-action` and `/zfa-check` are *not* excluded — broadcasting their kernel verdict to the room is the point. `/rhoqu` itself doesn't broadcast — only the commands it transpiles to do, per their own rules; the same holds for a `+command`, which sends no envelope of its own and is seen through whatever its body runs.

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

**Reaching a local rnode from the browser.** The dev server is https (Web Crypto needs a secure context), and a browser refuses plain http to any host but **loopback** — where loopback means the machine the *browser* runs on. On a Chromebook that is ChromeOS while rnode is inside the Linux VM, so `http://127.0.0.1:40403` finds nothing and the VM's own address is blocked as mixed content. Vite proxies the node at **`/rnode`** for exactly this: `/rholang rnode https://<host>:5173/rnode` is same-origin https on the cert already accepted. `isBlockedMixedContent` in `app.ts` refuses only what is genuinely blocked (http to a non-loopback host) — loopback is exempt and must not be refused, or a node that works is turned away.

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

### Branches

`main` is what is **deployed**: a push to it publishes GitHub Pages and redeploys
the signaling server on Render. So it is not the place to accumulate work.

```
project branch ──┐
project branch ──┼──▶  work  ──PR──▶  main   (deploys)
small change ────┘
```

- **`work`** — the working branch. Small changes go straight here; project
  branches are cut from it and merged back into it. CI runs on every push to it,
  so nothing reaches `main` unrun.
- **project branches** — one per piece of work, cut from `work`, merged to
  `work` (a PR if it wants reading, otherwise directly). Delete them the same
  session.
- **`main`** — reached only by a PR from `work`, which is the moment the batch
  goes live and the place to read it as a whole.

```bash
git checkout work && git pull                 # start from the working branch
git checkout -b some-feature                  # a project branch off work
gh pr create --base work                      # …reviewed into work
gh pr create --base main --head work          # …and work into main, when it should ship
```

An urgent fix still goes straight to `main` — then `git checkout work && git merge main`,
so the two do not drift.

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
| `packages/browser/src/app.ts` | All slash commands, lemma/note/rdv stores, UI logic, peer callbacks |
| `packages/browser/src/notes.ts` | Note primitives (mintNote, splitNote, mergeNotes, parseNoteLabel, denomination) |
| `packages/browser/src/rendezvous.ts` | Rendezvous protocol types, conservationCheck, cyclicSwap |
| `packages/browser/src/dyncap.ts` | Dyncap protocol (signEnvelope, verifyEnvelope, anchor / witness derivation) |
| `packages/browser/src/probe.ts` | Discrepancy probe types + `findDiscrepancies` + supermajority constants + `losingPeersIn` |
| `packages/browser/src/polls.ts` | Pure poll-tally module — `optionId`, `tallyApproval`, `tallyRanked` (IRV), `tally`, `liveCounts`, `sortedOptions`, `summarizeWinners` (no DOM/storage). Tallies take an optional `weights` map for liquid-democracy weighting (no change at weight 1) |
| `packages/browser/src/gov.ts` | Pure governance module — `Group`/`Issue`/`Member` types + **`resolveWeights`** (transitive delegation → per-voter weight, with override + cycle abstention, optional `trustWeights`), **`trustLevels`** (admin-rooted hierarchy + ⅔-quorum censure accountability, 2-phase fixed point), `trustWeightsFor`, `discreditedMembers`, `delegationMapFor`, `issueId`, `delegatorsOf`. Drives `/gov`; see `Governance.md` |
| `packages/browser/src/macro-lang.js` | **The `$` macro language (Interact2).** Plain JS, no imports, node-runnable: `parseDefinition`, `parseInvocation`, `bindArgs`, `substitute`, `expandCallSites`, `expandCommand`, `splitBody`, `findMacros`. Carries BOTH lexers — a rholang body skips string literals and comments, a command body does not (see below). `node packages/browser/src/macro-lang.js --selftest` covers it |
| `packages/browser/src/rholang-macros.js` | **The `%` capability macro registry — one source for both halves.** Plain JS, no imports, ZFA kernel injected via `createMacroEngine(kernel)`. Registry + arg validators + templates + the rholang call-site scanner (`expandProgram`). Edit macros here and nowhere else; `node scripts/qos-cli/rholang-macros.mjs --selftest` covers it |
| `packages/browser/src/rholang.ts` | **The `/rholang` node client** — config (persisted), REV address derivation, DeployDataProto protobuf encoding + secp256k1 signing, `evalTerm` / `deployTerm` / `readResults`, the powerbox table with signatures, and `wrapProgram` |
| `scripts/localnet/macro-check.mjs` | **Do the macros still work?** Runs every expansion on a live rnode; a failure gives the macro, the line it died on, and rnode's answer. An expansion test cannot catch this — it only checks a macro produced the rholang it meant to. Not in CI (needs a node) |
| `scripts/localnet/` | Keys, wallet, and `run-node.sh` that start the **shipped** `bin/rnode` — a checkout of quantum-os alone brings a chain up. `README.md` records the files, `RNODE=` for a candidate build, and why the keys are committed |
| `packages/browser/src/rholang-pipeline.ts` | Browser half of the macro path — WASM lint (`lintRholang`), passphrase-wrapped key store (IndexedDB), sign, deploy. Binds the shared `%` engine |
| `packages/browser/src/rhoqu.ts` | RhoQu tokenizer, parser (`process`/`new`/`if`/`on`/`for`/`\|`), AST, and `transpile(source, ctx?)` that emits a `string[]` of `/commands`. `RhoQuContext` interface + `OnHandler` for `on channel(x) { … }` dispatcher registration. |
| `Consensus.md` | Reference doc for the joiner-local consensus probe — protocol, trust model, BFT comparison |
| `Group_Decisions.md` | Map of group-decision processes the interface supports — built (poll / probe / rdv / channel / lemma) and sketched (quorum, weighted, quadratic, delegation, sortition, consent, conviction), each mapped to a primitive |
| `RhoQuDemo.md` | End-user walkthrough of `/rhoqu` — atomic swap with conditional accept, dining philosophers, multisig with persistence |
| `packages/browser/src/palette.ts` | The toolbar, the command menu, and `CMD_HELP`. Quick actions **ask for their arguments** (`ArgSpec` → one prompt at a time, Enter continues, Esc cancels) and run the assembled line through the box, so it echoes and lands in history like a typed one. Typing past a command's name shows its syntax from `CMD_HELP` instead of a command list — `isPicking()` keeps that hint out of Enter's way, and `justTouched()` keeps a touch on the panel from dismissing it (the panel closes on the input blurring, and touching the panel is how the input blurs — so on a phone, reading it dismissed it; the menu's own items cancel `mousedown` instead, which the hint cannot do without making its text unselectable). Seven buttons, the room first and what outlives it next: Call · Record · Rholang · Poll · Estimate · Commands · **Other**, sectioned: *Group* (the groups you are in, start one, rate a member's trust) · *Value* (mint a note) · *Getting set up* (name, password, login, invite, help) · *If you use a chain*, last and named as a branch — point at a node, make a signing key, claim the locker record, record where a group lives on chain. **A room is whole with no chain**: peers, decisions, notes and groups need no node, no key and no phlo, so nothing chain-dependent sits in the sequence someone reads as "what I have to do to start". Everything else is still in `⌘ Commands` and `/help` |
| `packages/browser/vite.config.ts` | Dev server (https, so Web Crypto works off-loopback), the `/signal` and `/rnode` proxies, and the build stamp: `__APP_VERSION__` from package.json plus **`__APP_BUILD__`, the commit** — shown at the foot of the sidebar, because "are you on the new build?" is the first question of every peer-connection puzzle and a static version number cannot answer it |
| `packages/browser/src/record.ts` | Screen recording — `getDisplayMedia` + mic mixed, `MediaRecorder`, and the two constraints that shape it: chunks stream to an **OPFS scratch file** so memory stays flat (a Blob-at-the-end holds ~1 GB/hour in RAM), and OPFS needs no user gesture where `showSaveFilePicker` would want the one `getDisplayMedia` already consumed. The download is handed the `File`, so the bytes never come back through JS |
| `packages/browser/src/calls.ts` | Live calls — media acquisition, tiles (click one to fill the window), screen share as a track swap, and what to do when acquiring fails |
| `packages/browser/src/peer.ts` | WebRTC connection, signaling reconnect + `wake()`, onPeerJoined/Left/ChannelOpen |
| `packages/browser/public/render.html` | The `/render` room animation — self-contained canvas (no deps), reads the room's live state (perspective/closure names, group/channel counts) from URL params and draws perspectives bound to the shared room closure, closures (lemmas), and groups. Deploys to `/quantum-os/render.html` |
| `Room_Bridges.md` | Sharing information among perspectives *across rooms* — the bridge model (a member of both rooms is the shared closure, ER=EPR), what `bridge.mjs` relays (channels/chat/lemmas/gov), signed-verbatim relay, loop prevention, and honest scope |
| `scripts/qos-cli/agent.mjs` | Generalized room-agent daemon — roles, duties, lead election, trust standing, advisor wiring, commands (ask/optimize/**chair**+next/back/close/cancel/trust/off/on), chaired-deliberation state machine + receipts. `facilitator.mjs` is a shim |
| `scripts/qos-cli/agent-roles.mjs` | Role registry (facilitator/scribe/greeter/skeptic) — `resolveRole`/`dutiesOf`; add a role here |
| `scripts/qos-cli/bridge.mjs` | Room **bridge** — one headless perspective in ≥2 rooms relaying each room's outputs as the others' inputs: channels (default) + `--chat`, plus durable state `--lemmas` (published lemmas + `sync-lemmas` import) and `--gov` (`group-*`/`gov-*` mutations + `sync-gov` import). Signed state relayed **verbatim** so the signer's dyncap chain carries through; origin-labeled text, loop-guarded (`_bridge` tag + `--max-hops` + durable per-item dedupe). ER=EPR at the collaboration layer (a member of both rooms IS the shared closure). See [`Room_Bridges.md`](Room_Bridges.md) |
| `scripts/qos-cli/facilitator-advisor.mjs` | AI advisor `makeAdvisor` — backends `api`/`claude-code`, modes ask/stimulate/synthesize/optimize/**chair** (single-neutral-chair persona, per-phase synthesis + closure decision), per-role persona. The **`ask`** knowledge (`askKnowledge`) makes the agent an **expert on QuantumOS itself** — room model + full slash-command set (incl. `/render`) + docs — so `/facil ask` names the exact command. Keep it in sync when adding commands |
| `scripts/qos-cli/gov.mjs` | Port of `gov.ts` `trustLevels`/`discreditedMembers` so an agent computes its own trust standing |
| `scripts/qos-cli/qospeer.mjs` | Node `QOSPeer` transport (werift+ws) + 30s signaling keepalive + 30s `"disconnected"` teardown grace (`DISCONNECT_GRACE_MS`, stops orphaned SCTP associations pegging a core); shared by agents + the memory daemon |
| `scripts/qos-cli/optimize-demo.mjs` | Runnable collective-optimization demo (room session on TSP → optimum); see `Collective_Optimization.md` |
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

The QLF math substrate has **active inference built into its foundation**: every admissible state is a free-energy-minimizing trajectory of a Markov-blanket agent, with per-event ΔF = −log 2 saturation by half-spin ZFA closure. The kernel here realises that substrate as an executable system — every capability token, every room, every closure is a concrete instance of the active-inference math. The meta-doc claims QLF as a candidate TOE and ZFC-replacement for the part of mathematics with a physical / agent-constructible referent — explicitly excluding what Gödel and the Busy Beaver result establish as ZFC's undecidable interior. The per-event ΔF = −log 2 quantum is now Lean-anchored as `zfa_closure_minimizes_free_energy` in QLF's `lean/QLF_FreeEnergy.lean`, with brute-force numerical verification in `active_inference_vfe_demo.py`. The runtime ZFA check this kernel uses (`is_zfa = is_count_balanced ∧ is_pauli_closed` in `crates/zfa-core` and `packages/browser/src/zfa.ts`) now has Lean anchors at **three layers**: count balance under concatenation (`emergent_blanket_formation` in `lean/QLF_QuCalc.lean`), Pauli closure under concatenation in the abstract scalar group (`pauli_closed_of_admissible_zfa` in `lean/QLF_Pauli.lean`), and the explicit σ-matrix mapping for Hermitian-pair atoms plus their N-pair concatenations (`hermitian_pair_is_pauli_scalar` and `concat_pairs_is_pauli_scalar` in `lean/QLF_TwistAlphabet.lean`). The same twist algebra compiles to runnable Eu:YSO pulse sequences via QLF's `compile_qpu.py` (Crystal-QPU pulse compiler sketch). Relativistic kinematics on the same substrate is sketched in QLF's [Cross_Frequency_Lorentz.md](https://github.com/rchain-community/quantum-logical-framework/blob/main/Cross_Frequency_Lorentz.md), which identifies γ = cosh(rapidity) with a Markov-blanket internal-frequency ratio. The mass-spectrum question is reframed in [Bound_States_QLF.md](https://github.com/rchain-community/quantum-logical-framework/blob/main/Bound_States_QLF.md): free leptons are not direct QLF observables; atomic systems are (positronium, muonium, hydrogen — bound, balanced, joint-ZFA closures). The same structural move that `Delayed_Choice_Eraser.md` makes for photons and `Hadrons_Markov_Blankets.md` makes for quarks now applies to leptons. [Atomic_System_QLF_Closures.md](https://github.com/rchain-community/quantum-logical-framework/blob/main/Atomic_System_QLF_Closures.md) pins each atomic system to a specific joint-closure topology and derives the Bohr reduced-mass scaling `E(Mu)/E(Ps) ≈ 2`, `E(H)/E(Mu) ≈ 1` from the joint-closure-depth decomposition — the first quantitative QLF mass-spectrum derivation on the right targets. [Per_Qubit_Mass_Quantum.md](https://github.com/rchain-community/quantum-logical-framework/blob/main/Per_Qubit_Mass_Quantum.md) captures the per-qubit mass-energy principle (`m_qubit c² = ℏω = E_Planck / R_qubit`) — bound-state masses are sums of constituent-qubit Compton energies, reproducing every measured mass ratio exactly (`m_p/m_e = 1836.15`, `m_μ/m_e = 206.77`, `m_τ/m_μ = 16.82`). [Photon_Energy_Bits.md](https://github.com/rchain-community/quantum-logical-framework/blob/main/Photon_Energy_Bits.md) is the photon-side companion: photons carry gauge-free bits with energy `E = N · ℏω` and mass-equivalence `E/c²` but zero rest mass. The unifying QLF principle: energy = quanta count × per-quantum contribution; gauge folds distinguish mass-carrying qubits from energy-carrying bits. [Information_Energy_Equivalence.md](https://github.com/rchain-community/quantum-logical-framework/blob/main/Information_Energy_Equivalence.md) derives the Wheeler-Fields `ℏω = 1 bit at frequency ω` equivalence from QLF first principles, as the conjunction of the per-event `log 2` information quantum (Lean-anchored) and the per-event `ℏω` energy quantum. Three QLF natural-units quanta now unified: per-event `log 2` information, per-qubit `ℏω` rest energy, per-bit `ℏω` photon energy — all `ℏω` per bit at the event's resolution frequency. `Experimental_Consistency.md` is updated to integrate the atomic-system mass spectrum (§5.5), the information-energy equivalence (§6.4), photon energy and pair production (§6.5), and the cross-frequency Lorentz boost (§4.5 partial closure); `ReverseMathematics.md` §4.8 adds the information-energy reading of the MRE bridge, giving the `Re(s) = 1/2` critical-line locus a third coincident interpretation (info-energy joint saturation) on top of the MRE binary-partition and half-spin-closure fixed-point readings. `ReverseMathematics.md` §4.9 then adds a fourth: the QLF adjoint involution `H ↔ H†` (reverse + parity-flip on twist histories, identity `E + E† ≡ ZFA` per `Hermitian_Conjugacy_Proof.md`) is the operator-side counterpart of the Riemann functional-equation involution `s ↔ 1−s`, and the self-adjoint histories `Σ_sa = {H : H = H†}` are a discrete analog of the critical line. This supplies the Berry-Keating spectral path with its missing Hilbert space: the Markov-blanket depth operator `R̂` is self-adjoint by construction on `ℓ²(Σ_sa)`, with spectrum `{R_e, R_μ, R_p, R_τ, …}`. The runtime kernel exposes the adjoint as the `/conj <twists>` slash command, letting users construct and probe `Σ_sa` directly. The Wigner-Dyson empirical extension of §4.9 (predicting GUE spacing on the observed bound-state depths) was tested directly on PDG hadron and atomic-system masses in [`Wigner_Dyson_QLF_Test.md`](https://github.com/rchain-community/quantum-logical-framework/blob/main/Wigner_Dyson_QLF_Test.md): the data does not support the prediction (variance closer to Poisson than GUE in single-sector cuts). The structural §4.9 correspondence stands; the spacing-statistics extension is honestly recorded as not supported. `VacuumEnergy.md` §6 then names the TOE-completing layer the framework was missing: the vacuum is a near-maximum-entropy background with a structured tail, and admissible signals are those that align with it. ZFA is the alignment condition; MRE per-event `log 2` is the alignment quantum; active inference is the alignment dynamics. Three readings (resonance / quiet-frequency, near-equilibrium thermodynamic / Verlinde-Jacobson, global Bayesian prior) are coordinate projections of one substrate. The per-event Lean anchor `vacuum_alignment_selects_zfa` in [`lean/QLF_VacuumAlignment.lean`](https://github.com/rchain-community/quantum-logical-framework/blob/main/lean/QLF_VacuumAlignment.lean) discharges the iff: KL saturation against the vacuum's max-entropy prior is equivalent to ZFA-closure delta realisation. The N-event trajectory-level lift `global_alignment_selects_zfa` (same module) extends this to lists of recognition densities: cumulative KL saturates `length × log 2` iff every event is a delta. The RhoProcess bridge `rho_process_alignment_saturates` in [`lean/QLF_RhoProcessBridge.lean`](https://github.com/rchain-community/quantum-logical-framework/blob/main/lean/QLF_RhoProcessBridge.lean) closes the third and final formalisation layer: every constructible RhoProcess from `RhoQuCalc.lean` produces an events-trajectory that saturates the cumulative bound, by structural recursion (action → 1, lift → 0, parallel/sequence concatenate). Combined with `rho_process_always_zfa`, the three layers state formally that *the QLF constructible processes are exactly the trajectories of agents maximising cumulative mutual information against the vacuum prior subject to ZFA closure*. The PDG-test result is reframed under §6.1 as a projection effect — observed masses are the vacuum-resonance projection of the abstract `R̂` spectrum, not the spectrum itself. [`Atomic_System_QLF_Closures.md`](https://github.com/rchain-community/quantum-logical-framework/blob/main/Atomic_System_QLF_Closures.md) §7 extends the per-qubit Compton accounting from positronium/muonium/hydrogen to the heavier-atomic-systems panel (¹H through ²³⁸U), tabulating depths `R_X = E_Planck / (M_X c²)` with the `R ∝ 1/A` baseline; under §6.1 the magic-number BE/A peaks (⁴He, ¹⁶O, ⁴⁰Ca, ⁵⁶Fe, ⁹⁰Zr, ¹⁴⁰Ce, ²⁰⁸Pb) are reframed as vacuum-resonance peaks, with the ⁵⁶Fe maximum identifying the cosmological terminator of stellar nucleosynthesis as the deepest stable vacuum resonance. [`Magic_numbers.md`](https://github.com/rchain-community/quantum-logical-framework/blob/main/Magic_numbers.md) closes the magic-number sequence end-to-end: dimensional growth of half-spin closures in d=2,3,4 gives 2, 8, 20 by pure combinatorial logic; for ℓ_max ≥ 3 the vacuum itself acts as the intruder, coupling in at each frequency to select the `j = ℓ_max + 1/2` orbital at the highest ℓ available. The ℓ = 3 threshold is derived algebraically: at major harmonic shell `N_HO = k`, 3D-SHO has degeneracy `(k+1)(k+2)`, the vacuum-selected `j = k + 1/2` multiplet has `2(k+1)` states, and the rest has `k(k+1)` states; the inequality `rest > vacuum-selected` reduces to `k > 2`, with the "3" coming from the d = 3 of `(k+1)(k+2)` — exactly the 3 spatial dimensions encoded by the alphabet's 6 spatial twists. Counterfactual: d = 4 alphabet → threshold ℓ ≥ 2; d = 2 → no threshold. The empirical ℓ = 3 in nuclear physics is a structural prediction of the 8-twist alphabet's 6+2 split. Combined with j-coupling enumeration, this reproduces 2, 8, 20, 28, 50, 82, 126 exactly. Companion script: [`magic_numbers_demo.py`](https://github.com/rchain-community/quantum-logical-framework/blob/main/magic_numbers_demo.py). [`Experimental_Consistency.md`](https://github.com/rchain-community/quantum-logical-framework/blob/main/Experimental_Consistency.md) integrates all this work into the consolidated experimental-status doc: new §5.6 heavier atoms, §6.6 vacuum-alignment TOE-completing layer, §7.1 nuclear magic numbers; six new falsifier rows in §10; five new "Established" bullets in §11. The QLF Bohr derivation in [`Hydrogen.md`](https://github.com/rchain-community/quantum-logical-framework/blob/main/Hydrogen.md) §§2–4 splits cleanly into three tiers. **Tier 1 (structurally derived):** the identity `Ry = (1/2) α² m_e c²` is derived from Coulomb-via-gauge-twist-exchange + ZFA-depth quantization — the *form* of the relationship is QLF first-principles content, not an empirical input. **Tier 2 (numerical from observables):** inverting the Tier-1 identity at the measured hydrogen ionization energy (Ry) and measured electron rest energy (m_e c²) gives `α = sqrt(2 Ry / m_e c²) = 0.0072973526 = 1/137.036` to 10⁻¹⁰ vs CODATA via [`fine_structure_demo.py`](https://github.com/rchain-community/quantum-logical-framework/blob/main/fine_structure_demo.py); the per-qubit `α = sqrt(2 Ry R_e / E_Planck)` and depth-ratio `α² = 2 R_e / R_1` re-expressions involve `E_Planck` only as unit-conversion bookkeeping — it cancels algebraically, leaving the same observable ratio `Ry/(m_e c²)`. The §4.1 subsection reframes the ionization energy as the ground-shell frequency and the full Rydberg series as a discrete vacuum-resonance shell spectrum at Markov-blanket depths `R_n = R_1 · n²`. **Tier 3 (candidate close, substrate-only — 0.026%, Lean-anchored, zero free parameters):** the substrate combinatorial route in QLF's [`Magnetism_Spatial_Dynamics.md`](https://github.com/rchain-community/quantum-logical-framework/blob/main/Magnetism_Spatial_Dynamics.md) §6.1 gives `α_QLF = (1/16) × (1/4) × (1/2) × 1 / (1 + 9α) = 1/128 × 128/137 = 1/137.000`, matching CODATA at **0.026% with no observable input and no fit parameter**. Bare combinatorial 1/α = 128 = 2⁷ from {naive closure rate × gauge selectivity × phase coherence × spatial co-location} on the 8-twist alphabet, corrected by emergent energy conservation as a self-energy-like renormalisation `(1+9α)⁻¹` with N=9 derived structurally from the 3² spatial directional-coupling tensor (3D substrate from the 6+2 alphabet split per `Magic_numbers.md`). Counterfactual: 2D substrate gives N=4 → α off by 4%; 4D gives N=16 → α off by 5%. **Lean-verified** as `alpha_QLF_eq : alpha_QLF = 1/137` in [`lean/QLF_FineStructureSubstrate.lean`](https://github.com/rchain-community/quantum-logical-framework/blob/main/lean/QLF_FineStructureSubstrate.lean), the first Lean theorem for a fundamental constant in the QLF tree. Parallel chirality-hiding pathway via `R_e = R_p · 6π⁵` in [`Proton_Resonance_R_e.md`](https://github.com/rchain-community/quantum-logical-framework/blob/main/Proton_Resonance_R_e.md) — also now **Lean-verified** as `mass_ratio_QLF_eq : mass_ratio_QLF = 6 * Real.pi ^ 5` in [`lean/QLF_LenzMassRatio.lean`](https://github.com/rchain-community/quantum-logical-framework/blob/main/lean/QLF_LenzMassRatio.lean), with `|S_3| = 6` (3-quark Bose permutation) and `hidden_chirality_angles = 5` as named substrate constants. Matches PDG `m_p/m_e = 1836.152` to 0.002%. The 5-angle count is further decomposed in [`lean/QLF_BorromeanAngles.lean`](https://github.com/rchain-community/quantum-logical-framework/blob/main/lean/QLF_BorromeanAngles.lean) as `5 = 3 + 2` (Jacobi internal DOF + chirality-mixing per Pauli scalar 2-axis structure), with bridge theorem `matches_lenz_hidden_chirality_angles` tying the decomposition to the Lenz module's named constant. **γ (Euler-Mascheroni constant)** is the third Lean-anchored fundamental constant, in [`lean/QLF_EulerMascheroni.lean`](https://github.com/rchain-community/quantum-logical-framework/blob/main/lean/QLF_EulerMascheroni.lean) via the harmonic-excess identity (γ_QLF = lim H_N − ln N over the ZFA-stable closure ensemble; 0.017% match via `constants_mapper.emerge_gamma()`). The constants-from-substrate program is now three-deep: α at 0.026%, m_p/m_e at 0.002%, γ at 0.017%, all Lean-anchored. The γ work also bridges substrate to the Riemann zeta function via [`lean/QLF_RiemannZeta.lean`](https://github.com/rchain-community/quantum-logical-framework/blob/main/lean/QLF_RiemannZeta.lean): γ_QLF is identified with ζ's Laurent constant at s = 1, and `critical_line_real_part = 1/2` is Lean-anchored as the count-balance ratio (the structural reason the critical line's real part is exactly 1/2). The doc [`Riemann-Conjecture-Proof.md`](https://github.com/rchain-community/quantum-logical-framework/blob/main/Riemann-Conjecture-Proof.md) now articulates the prime-annihilation structural argument: primes are irreducible ZFA closures; irreducible closures can only contribute zero via Hermitian-pair annihilation with their conjugate; Hermitian-pair annihilation events are balanced (count_pos = count_neg, ratio = 1/2) and live on Σ_sa; therefore prime contributions to ζ can only vanish on Re(s) = 1/2. Under QLF's epistemic stance — where the substrate-constructive part of mathematics has its own foundational adequacy, and ZFC's undecidable interior (per Busy Beaver: BB(745) is independent of ZFC, plus Gödel) is explicitly excluded from the proof-burden — this constitutes proof within QLF's frame: substrate-structural rigour is what proof means for the substrate-constructive part of mathematics. The three bridge axioms in QLF_Riemann.lean (NonTrivialZero, spectral_hilbert_polya, resonant_computation_for) are explicit RCA₀-to-WKL₀ bridges structurally motivated by the primes-irreducibility + balance chain; demanding ZFC-internal proof of spectral_hilbert_polya is asking for what BB/Gödel establishes ZFC cannot always provide. Stance is "sufficient proof for now, to be refined" — the proposed MRE_bridge reformulation and tighter Lean anchoring of the prime-annihilation chain are natural refinements. A mathematician requiring only ZFC-internal proofs has a coherent but different framework; both stances answer to different epistemic commitments. Numerical `c` is differently positioned: under QLF's substrate-first ontology, L_Planck and τ_Planck are substrate primitives (one Planck length and one Planck tick per substrate event, *together*), not defined via {ℏ, G, c}. So `c = L_Planck / τ_Planck` is QLF-derived without observable input — and the cosmic-scale derivation `c = R_cosmic / T_cosmic` with `n ≈ 6 × 10⁶⁰` from Hadronic Depth gives independently QLF-derived cosmic size and age that match observation. The SI numerical value reflects substrate-primitive-to-SI calibration. There is no Tier-3 open for `c` — the substrate event quantum *is* the first-principles content. Two scoping docs applying Hitoshi Kitada's local-time framework (gr-qc/9612043) sharpen this and the broader GR programme: [`Proton_Resonance_R_e.md`](https://github.com/rchain-community/quantum-logical-framework/blob/main/Proton_Resonance_R_e.md) decomposes the open R_e derivation as `R_e = R_p · 6π⁵` under the chirality-hiding-resonance reading — the proton's 3-quark Borromean closure hides individual quark chirality from electron-annihilation probes, and the electron mass is the resonance threshold that threads the needle between chirality-resolution and atomic binding. The `6π⁵ = |S_3| · π⁵` Lenz coincidence (1951, 0.002% agreement to m_p/m_e = 1836.152) recovered as `3!` quark permutation symmetry × 5-angle integration over hidden-chirality configuration space. [`Kitada_Local_Time_GR.md`](https://github.com/rchain-community/quantum-logical-framework/blob/main/Kitada_Local_Time_GR.md) extends the same Kitada lens to QLF's general-relativistic commitments, identifying three structural gaps: (Gap 1) name `R = local clock count` as a foundational identity; (Gap 2) reframe cosmic age = `n × τ_Planck` as the proper time of the cosmic-horizon Markov blanket with `n ≈ 6 × 10⁶⁰` from `HadronicDepth.md`; (Gap 3) derive Einstein equations as the coarse-grained limit of local-clock synchronization failure across a Markov blanket, with `8π = 4π · 2` (solid angle × Hermitian pair) and `G` as the vacuum's per-event entropy-gradient strength under `VacuumEnergy.md` §6.2. Both docs maintain honest-scoping discipline: they decompose the open problems into sharper sub-targets, not derivations themselves. The framework now has shell structure articulated at three scales — nuclear (`Magic_numbers.md`, vacuum-as-intruder), atomic (`Hydrogen.md` §4.1, Bohr spectrum as vacuum-resonance modes), and the unifying vacuum-alignment principle (`VacuumEnergy.md` §6) — all three are discrete frequency spectra of bound-state Markov-blanket depths. The browser app's slash-command + capability-token primitives are sketched as the control plane for a future quiet-frequency crystal QPU in QLF's [Crystal_QuantumOS.md](https://github.com/rchain-community/quantum-logical-framework/blob/main/Crystal_QuantumOS.md); the qubit-register-scale Markov-blanket layer is sketched in [Emergent_Markov_Blankets.md](https://github.com/rchain-community/quantum-logical-framework/blob/main/Emergent_Markov_Blankets.md). See [Active_Inference_Mathematics.md](https://github.com/rchain-community/quantum-logical-framework/blob/main/Active_Inference_Mathematics.md) for the foundations meta-doc.

See [QLF CLAUDE.md](../quantum-logical-framework/CLAUDE.md) and [AI.md](https://github.com/rchain-community/quantum-logical-framework/blob/main/AI.md) for the full theoretical background.

### What NOT to say

- Do not describe the signaling server as trusted — it is an explicit untrusted relay
- Do not describe ZFA tokens as "passwords" or "API keys" — possessing the token IS the capability, with no separate authentication step
- Do not describe lemma auto-allocation as random — it is deterministic from the name, giving identical results on every client
- Do not describe the room as a server — the room is the emergent ZFA process of the peers; the signaling server only routes handshakes
