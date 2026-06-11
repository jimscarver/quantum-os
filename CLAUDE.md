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
│           ├── capability.rs   cap:label:hex token generation (rejection-sampling) and validation
│           ├── history.rs      achieves_zfa, is_count_balanced, spectral_gap, count_pos/neg, is_symmetric
│           ├── pauli.rs        Pauli matrix algebra: pauli_fold, is_pauli_closed, twist_matrix
│           ├── process.rs      Form (2×2 Hermitian), Process (RhoQuCalc)
│           ├── twist.rs        Twist enum (8-symbol alphabet)
│           └── wasm.rs         wasm-bindgen exports (feature = "wasm")
├── packages/
│   ├── browser/            Vite + TypeScript browser app (GitHub Pages)
│   │   ├── index.html      Layout + CSS (sidebar, chat, share row)
│   │   └── src/
│   │       ├── app.ts      All UI logic, slash commands, lemma/note/rdv stores, peer callbacks
│   │       ├── peer.ts     QOSPeer class — WebRTC + signaling WebSocket
│   │       ├── zfa.ts      Browser-side ZFA helpers (validateCapability, tokenTwists, …)
│   │       ├── notes.ts    Promissory note primitives (mint, split, merge, parseNoteLabel, denomination)
│   │       ├── rendezvous.ts  N-party rendezvous protocol (Proposal/Row/CommitRow types, conservationCheck, cyclicSwap)
│   │       ├── dyncap.ts   Hash-only dynamic capabilities (sign/verify envelopes; SHA-256 only)
│   │       ├── probe.ts    Discrepancy probe — chain-weighted supermajority tally on join
│   │       ├── polls.ts    Group polls — pure approval + ranked-choice (IRV) tally over content-hash option ids
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
| `<` | 2 | even/pos | Left |
| `>` | 3 | odd/neg | Right |
| `/` | 4 | even/pos | Slash |
| `\` | 5 | odd/neg | Backslash |
| `+` | 6 | even/pos | Plus |
| `-` | 7 | odd/neg | Minus |

**ZFA = half-spin closure** (v0.17+): a process whose execution returns a spin-1/2 spinor to itself up to a global phase. The predicate `achieves_zfa(H) = pauli_closed(H) ∧ count_balanced(H)` is the algebraic decomposition of that closure into its two faces:

1. **Pauli closure** (non-abelian face): the ordered matrix product of twists lands in `{+I, −I, +iI, −iI}` — the Pauli scalar group. Each twist maps to an SU(2) generator (`^v` ↔ ±σ_y, `<>` ↔ ∓σ_x, `/\` ↔ ±σ_z, `+-` ↔ ±I). Order matters because Paulis anti-commute. **This is the SU(2)-scalar-return reading of half-spin closure** — the spinor closes up to phase.
2. **Count balance** (abelian face): `count_pos == count_neg`. Spectral gap = `|count_pos − count_neg|` = 0. This is the bra-ket / Hermitian-pair multiset count: each twist is paired with its Hermitian conjugate.

Pauli closure is not a "stronger condition" layered on top of count balance — it IS the SU(2)-scalar-return of the same half-spin closure that count balance reads as a Hermitian-pair multiset. Neither face implies the other in isolation (`σ_x σ_y σ_z = iI` is Pauli-closed but count-imbalanced; `^ < v -` is count-balanced but folds to σ_x); both together are the unique characterisation of a closed half-spin process. The 8-twist alphabet is the SU(2) generator set up to sign (SU(2) ≅ unit quaternions; Hurwitz singles out H as the unique non-commutative associative composition real algebra — see QLF [HALF-SPIN-ZFA-EMBEDDING.md §6](../quantum-logical-framework/HALF-SPIN-ZFA-EMBEDDING.md)).

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

### Multi-room with per-room Markov blankets (`/room` — `app.ts`)

A single browser session can join N rooms simultaneously, each as a tab across the top of the UI. The full reference framing is below; concrete summary for code work:

State model:
- `RoomContext` interface (defined in `app.ts`) collects all per-room state: `lemmaStore`, `noteStore`, `currencyTokens`, `knownCurrencies`, `receiptStore`, `redemptionsHonored`, `lockedNotes`, `proposals`, `proposalTimers`, `dyncapChains`, `probe`, `ignoredForSync`, `chatLog`, `peers`, `peerNames`, `pendingLeaves`, `qpeer`, `signalingUrl`, `hasUnread`, `roomId`.
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

### Removal & retraction (`/forget` — `app.ts`)

Per-item removal of polls, lemmas, and held notes (sidebar ✕ on each row; a `remove` button on poll cards; the `/forget <poll <id> | lemma <name> | note <token|currency denom> | list>` command).

The key problem is that gossiped state (polls, lemmas) *heals back*: a local delete is re-added by the next peer's `sync-*` push. The fix is **tombstones** — a per-room `retracted: Set<"<kind>:<id>">` (persisted `qos-retracted-<roomId>`, checked by `isRetracted`). Inbound `poll-open` / `poll-option` / `poll-ballot` / `mergePollFromSync` and the live `lemma` handler / `sync-lemmas` loop all skip tombstoned ids, so a removed item stays removed locally.

Removal is **authoritative for the owner, local-hide for everyone else**:
- A dyncap-signed `retract {what, id}` envelope is honored only from the owner — `from === poll.creator` for a poll, or the sender's verified dyncap anchor matching the lemma's stored author anchor (`entry.dyncap.anchor`) for a lemma. So a peer can retract its own item for everyone, but only hides others' items from its own view (still tombstoned locally).
- `forgetPoll` / `forgetLemma` broadcast the retract only when you're the owner; otherwise they just tombstone + drop locally.
- **Notes** are private bearer value: `forgetNote` is local-only with a confirm (no broadcast, no tombstone — the same token can legitimately be received again).

Limitation: there is intentionally **no** `sync-retracted` join replay (it would let a joiner push unverified tombstones and wipe a peer's view). So a peer that was *offline* during a retract keeps its own copy until told otherwise; peers that received the retract still ignore that peer's re-sync of it.

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
| `/conj <twists>` | Hermitian adjoint (reverse + parity-flip); flags self-adjoint inputs. The QLF "negation" operator; fixed locus Σ_sa is the operator-side counterpart of the Riemann ξ critical line (see `ReverseMathematics.md` §4.9). |
| `/freq [n\|twists]` | ZFA frequency spectrum (C(2n,n) arrangements) |
| `/lemma [name [tw]]` | Register/list named lemmas; omit twists to auto-allocate |
| `/request <name>` | Broadcast that you need `@name`; holder sees a `/pass` prompt |
| `/pass <name> <peer>` | Transfer `@name` directly to a peer; removes from sender's store, auto-registers on recipient's |
| `/note <sub>` | Promissory notes — `declare`, `grant`, `pass`, `redeem`, `split`, `merge`, `list`, `balance` |
| `/rdv <sub>` | N-party atomic rendezvous — `swap`, `accept`, `reject`, `abort`, `list` |
| `/poll <sub>` | Group decision — `new <q> [\| seeds] [ranked]`, `add <opt>`, `vote [id] <choices>`, `status`, `lock`, `close`, `remove`, `list`. Collect-then-vote with approval / ranked-choice (IRV); deterministic joiner-local tally |
| `/forget <sub>` | Remove an item — `poll <id>`, `lemma <name>`, `note <token\|currency denom>`, `list`. Owner retracts for everyone (dyncap-signed `retract`, tombstoned so it can't re-sync back); others hide locally. Notes delete with confirm |
| `/dyncap <sub>` | Hash-only dynamic capabilities — `status`, `peers` |
| `/probe <sub>` | Joiner-local consensus probe — `status`, `clear` (the probe runs automatically on connect) |
| `/room <sub>` | Multi-room tabs — `list`, `join <cap\|url>`, `leave`, `ref` |
| `/share <selector> to <room>` | Bridge a lemma / chat / note from the active tab into another joined tab (application-level; no cross-room wire kind) |
| `/rdv counter <id> …` | Round-trip negotiation in an in-flight rendezvous — replaces rows, swaps locks, counterer implicitly accepts |
| `/channel <sub>` | Tagged broadcast messaging — `list`, `listen <name>`, `unlisten <name>`, `send <name> <text>`; per-room subscriptions |
| `/script <c1>;…` | Sequential command chain on one line; `//` skips a segment |
| `/persist <sub>` | Agreed cross-peer replication of public state — request, accept, reject pending requests |
| `/rhoqu <text>` | RhoQu macro language: parse `process` / `new` / `\|` parallel / `if` / `on channel` / `for`, transpile to `/command` strings, dispatch in order. `/rhoqu list` and `/rhoqu clear` manage registered `on` handlers (per-room). |
| `/dump` | Summary of all logic shared this session |
| `//message` | Send a message that starts with `/` |

Broadcasting: commands that broadcast their output via `{kind: "qlf", cmd, arg, lines}` are anything not in this exclusion list: `/help`, `/grant`, `/lemma`, `/note`, `/rdv`, `/poll`, `/dyncap`, `/probe`, `/room`, `/share`, `/channel`, `/script`, `/persist`, `/rhoqu`, `/request`, `/pass`, `/dump`. Excluded commands send purpose-specific envelopes (or are local-only) so a generic qlf rebroadcast would be redundant or noisy. `/rhoqu` itself doesn't broadcast — only the commands it transpiles to do, per their own rules.

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
| `packages/browser/src/app.ts` | All slash commands, lemma/note/rdv stores, UI logic, peer callbacks |
| `packages/browser/src/notes.ts` | Note primitives (mintNote, splitNote, mergeNotes, parseNoteLabel, denomination) |
| `packages/browser/src/rendezvous.ts` | Rendezvous protocol types, conservationCheck, cyclicSwap |
| `packages/browser/src/dyncap.ts` | Dyncap protocol (signEnvelope, verifyEnvelope, anchor / witness derivation) |
| `packages/browser/src/probe.ts` | Discrepancy probe types + `findDiscrepancies` + supermajority constants + `losingPeersIn` |
| `packages/browser/src/polls.ts` | Pure poll-tally module — `optionId`, `tallyApproval`, `tallyRanked` (IRV), `tally`, `liveCounts`, `sortedOptions`, `summarizeWinners` (no DOM/storage) |
| `packages/browser/src/rhoqu.ts` | RhoQu tokenizer, parser (`process`/`new`/`if`/`on`/`for`/`\|`), AST, and `transpile(source, ctx?)` that emits a `string[]` of `/commands`. `RhoQuContext` interface + `OnHandler` for `on channel(x) { … }` dispatcher registration. |
| `Consensus.md` | Reference doc for the joiner-local consensus probe — protocol, trust model, BFT comparison |
| `Group_Decisions.md` | Map of group-decision processes the interface supports — built (poll / probe / rdv / channel / lemma) and sketched (quorum, weighted, quadratic, delegation, sortition, consent, conviction), each mapped to a primitive |
| `RhoQuDemo.md` | End-user walkthrough of `/rhoqu` — atomic swap with conditional accept, dining philosophers, multisig with persistence |
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

The QLF math substrate has **active inference built into its foundation**: every admissible state is a free-energy-minimizing trajectory of a Markov-blanket agent, with per-event ΔF = −log 2 saturation by half-spin ZFA closure. The kernel here realises that substrate as an executable system — every capability token, every room, every closure is a concrete instance of the active-inference math. The meta-doc claims QLF as a candidate TOE and ZFC-replacement for the part of mathematics with a physical / agent-constructible referent — explicitly excluding what Gödel and the Busy Beaver result establish as ZFC's undecidable interior. The per-event ΔF = −log 2 quantum is now Lean-anchored as `zfa_closure_minimizes_free_energy` in QLF's `lean/QLF_FreeEnergy.lean`, with brute-force numerical verification in `active_inference_vfe_demo.py`. The runtime ZFA check this kernel uses (`is_zfa = is_count_balanced ∧ is_pauli_closed` in `crates/zfa-core` and `packages/browser/src/zfa.ts`) now has Lean anchors at **three layers**: count balance under concatenation (`emergent_blanket_formation` in `lean/QLF_QuCalc.lean`), Pauli closure under concatenation in the abstract scalar group (`pauli_closed_of_admissible_zfa` in `lean/QLF_Pauli.lean`), and the explicit σ-matrix mapping for Hermitian-pair atoms plus their N-pair concatenations (`hermitian_pair_is_pauli_scalar` and `concat_pairs_is_pauli_scalar` in `lean/QLF_TwistAlphabet.lean`). The same twist algebra compiles to runnable Eu:YSO pulse sequences via QLF's `compile_qpu.py` (Crystal-QPU pulse compiler sketch). Relativistic kinematics on the same substrate is sketched in QLF's [Cross_Frequency_Lorentz.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/Cross_Frequency_Lorentz.md), which identifies γ = cosh(rapidity) with a Markov-blanket internal-frequency ratio. The mass-spectrum question is reframed in [Bound_States_QLF.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/Bound_States_QLF.md): free leptons are not direct QLF observables; atomic systems are (positronium, muonium, hydrogen — bound, balanced, joint-ZFA closures). The same structural move that `Delayed_Choice_Eraser.md` makes for photons and `Hadrons_Markov_Blankets.md` makes for quarks now applies to leptons. [Atomic_System_QLF_Closures.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/Atomic_System_QLF_Closures.md) pins each atomic system to a specific joint-closure topology and derives the Bohr reduced-mass scaling `E(Mu)/E(Ps) ≈ 2`, `E(H)/E(Mu) ≈ 1` from the joint-closure-depth decomposition — the first quantitative QLF mass-spectrum derivation on the right targets. [Per_Qubit_Mass_Quantum.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/Per_Qubit_Mass_Quantum.md) captures the per-qubit mass-energy principle (`m_qubit c² = ℏω = E_Planck / R_qubit`) — bound-state masses are sums of constituent-qubit Compton energies, reproducing every measured mass ratio exactly (`m_p/m_e = 1836.15`, `m_μ/m_e = 206.77`, `m_τ/m_μ = 16.82`). [Photon_Energy_Bits.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/Photon_Energy_Bits.md) is the photon-side companion: photons carry gauge-free bits with energy `E = N · ℏω` and mass-equivalence `E/c²` but zero rest mass. The unifying QLF principle: energy = quanta count × per-quantum contribution; gauge folds distinguish mass-carrying qubits from energy-carrying bits. [Information_Energy_Equivalence.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/Information_Energy_Equivalence.md) derives the Wheeler-Fields `ℏω = 1 bit at frequency ω` equivalence from QLF first principles, as the conjunction of the per-event `log 2` information quantum (Lean-anchored) and the per-event `ℏω` energy quantum. Three QLF natural-units quanta now unified: per-event `log 2` information, per-qubit `ℏω` rest energy, per-bit `ℏω` photon energy — all `ℏω` per bit at the event's resolution frequency. `Experimental_Consistency.md` is updated to integrate the atomic-system mass spectrum (§5.5), the information-energy equivalence (§6.4), photon energy and pair production (§6.5), and the cross-frequency Lorentz boost (§4.5 partial closure); `ReverseMathematics.md` §4.8 adds the information-energy reading of the MRE bridge, giving the `Re(s) = 1/2` critical-line locus a third coincident interpretation (info-energy joint saturation) on top of the MRE binary-partition and half-spin-closure fixed-point readings. `ReverseMathematics.md` §4.9 then adds a fourth: the QLF adjoint involution `H ↔ H†` (reverse + parity-flip on twist histories, identity `E + E† ≡ ZFA` per `Hermitian_Conjugacy_Proof.md`) is the operator-side counterpart of the Riemann functional-equation involution `s ↔ 1−s`, and the self-adjoint histories `Σ_sa = {H : H = H†}` are a discrete analog of the critical line. This supplies the Berry-Keating spectral path with its missing Hilbert space: the Markov-blanket depth operator `R̂` is self-adjoint by construction on `ℓ²(Σ_sa)`, with spectrum `{R_e, R_μ, R_p, R_τ, …}`. The runtime kernel exposes the adjoint as the `/conj <twists>` slash command, letting users construct and probe `Σ_sa` directly. The Wigner-Dyson empirical extension of §4.9 (predicting GUE spacing on the observed bound-state depths) was tested directly on PDG hadron and atomic-system masses in [`Wigner_Dyson_QLF_Test.md`](https://github.com/jimscarver/quantum-logical-framework/blob/main/Wigner_Dyson_QLF_Test.md): the data does not support the prediction (variance closer to Poisson than GUE in single-sector cuts). The structural §4.9 correspondence stands; the spacing-statistics extension is honestly recorded as not supported. `VacuumEnergy.md` §6 then names the TOE-completing layer the framework was missing: the vacuum is a near-maximum-entropy background with a structured tail, and admissible signals are those that align with it. ZFA is the alignment condition; MRE per-event `log 2` is the alignment quantum; active inference is the alignment dynamics. Three readings (resonance / quiet-frequency, near-equilibrium thermodynamic / Verlinde-Jacobson, global Bayesian prior) are coordinate projections of one substrate. The per-event Lean anchor `vacuum_alignment_selects_zfa` in [`lean/QLF_VacuumAlignment.lean`](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/QLF_VacuumAlignment.lean) discharges the iff: KL saturation against the vacuum's max-entropy prior is equivalent to ZFA-closure delta realisation. The N-event trajectory-level lift `global_alignment_selects_zfa` (same module) extends this to lists of recognition densities: cumulative KL saturates `length × log 2` iff every event is a delta. The RhoProcess bridge `rho_process_alignment_saturates` in [`lean/QLF_RhoProcessBridge.lean`](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/QLF_RhoProcessBridge.lean) closes the third and final formalisation layer: every constructible RhoProcess from `RhoQuCalc.lean` produces an events-trajectory that saturates the cumulative bound, by structural recursion (action → 1, lift → 0, parallel/sequence concatenate). Combined with `rho_process_always_zfa`, the three layers state formally that *the QLF constructible processes are exactly the trajectories of agents maximising cumulative mutual information against the vacuum prior subject to ZFA closure*. The PDG-test result is reframed under §6.1 as a projection effect — observed masses are the vacuum-resonance projection of the abstract `R̂` spectrum, not the spectrum itself. [`Atomic_System_QLF_Closures.md`](https://github.com/jimscarver/quantum-logical-framework/blob/main/Atomic_System_QLF_Closures.md) §7 extends the per-qubit Compton accounting from positronium/muonium/hydrogen to the heavier-atomic-systems panel (¹H through ²³⁸U), tabulating depths `R_X = E_Planck / (M_X c²)` with the `R ∝ 1/A` baseline; under §6.1 the magic-number BE/A peaks (⁴He, ¹⁶O, ⁴⁰Ca, ⁵⁶Fe, ⁹⁰Zr, ¹⁴⁰Ce, ²⁰⁸Pb) are reframed as vacuum-resonance peaks, with the ⁵⁶Fe maximum identifying the cosmological terminator of stellar nucleosynthesis as the deepest stable vacuum resonance. [`Magic_numbers.md`](https://github.com/jimscarver/quantum-logical-framework/blob/main/Magic_numbers.md) closes the magic-number sequence end-to-end: dimensional growth of half-spin closures in d=2,3,4 gives 2, 8, 20 by pure combinatorial logic; for ℓ_max ≥ 3 the vacuum itself acts as the intruder, coupling in at each frequency to select the `j = ℓ_max + 1/2` orbital at the highest ℓ available. The ℓ = 3 threshold is derived algebraically: at major harmonic shell `N_HO = k`, 3D-SHO has degeneracy `(k+1)(k+2)`, the vacuum-selected `j = k + 1/2` multiplet has `2(k+1)` states, and the rest has `k(k+1)` states; the inequality `rest > vacuum-selected` reduces to `k > 2`, with the "3" coming from the d = 3 of `(k+1)(k+2)` — exactly the 3 spatial dimensions encoded by the alphabet's 6 spatial twists. Counterfactual: d = 4 alphabet → threshold ℓ ≥ 2; d = 2 → no threshold. The empirical ℓ = 3 in nuclear physics is a structural prediction of the 8-twist alphabet's 6+2 split. Combined with j-coupling enumeration, this reproduces 2, 8, 20, 28, 50, 82, 126 exactly. Companion script: [`magic_numbers_demo.py`](https://github.com/jimscarver/quantum-logical-framework/blob/main/magic_numbers_demo.py). [`Experimental_Consistency.md`](https://github.com/jimscarver/quantum-logical-framework/blob/main/Experimental_Consistency.md) integrates all this work into the consolidated experimental-status doc: new §5.6 heavier atoms, §6.6 vacuum-alignment TOE-completing layer, §7.1 nuclear magic numbers; six new falsifier rows in §10; five new "Established" bullets in §11. The QLF Bohr derivation in [`Hydrogen.md`](https://github.com/jimscarver/quantum-logical-framework/blob/main/Hydrogen.md) §§2–4 splits cleanly into three tiers. **Tier 1 (structurally derived):** the identity `Ry = (1/2) α² m_e c²` is derived from Coulomb-via-gauge-twist-exchange + ZFA-depth quantization — the *form* of the relationship is QLF first-principles content, not an empirical input. **Tier 2 (numerical from observables):** inverting the Tier-1 identity at the measured hydrogen ionization energy (Ry) and measured electron rest energy (m_e c²) gives `α = sqrt(2 Ry / m_e c²) = 0.0072973526 = 1/137.036` to 10⁻¹⁰ vs CODATA via [`fine_structure_demo.py`](https://github.com/jimscarver/quantum-logical-framework/blob/main/fine_structure_demo.py); the per-qubit `α = sqrt(2 Ry R_e / E_Planck)` and depth-ratio `α² = 2 R_e / R_1` re-expressions involve `E_Planck` only as unit-conversion bookkeeping — it cancels algebraically, leaving the same observable ratio `Ry/(m_e c²)`. The §4.1 subsection reframes the ionization energy as the ground-shell frequency and the full Rydberg series as a discrete vacuum-resonance shell spectrum at Markov-blanket depths `R_n = R_1 · n²`. **Tier 3 (candidate close, substrate-only — 0.026%, Lean-anchored, zero free parameters):** the substrate combinatorial route in QLF's [`Magnetism_Spatial_Dynamics.md`](https://github.com/jimscarver/quantum-logical-framework/blob/main/Magnetism_Spatial_Dynamics.md) §6.1 gives `α_QLF = (1/16) × (1/4) × (1/2) × 1 / (1 + 9α) = 1/128 × 128/137 = 1/137.000`, matching CODATA at **0.026% with no observable input and no fit parameter**. Bare combinatorial 1/α = 128 = 2⁷ from {naive closure rate × gauge selectivity × phase coherence × spatial co-location} on the 8-twist alphabet, corrected by emergent energy conservation as a self-energy-like renormalisation `(1+9α)⁻¹` with N=9 derived structurally from the 3² spatial directional-coupling tensor (3D substrate from the 6+2 alphabet split per `Magic_numbers.md`). Counterfactual: 2D substrate gives N=4 → α off by 4%; 4D gives N=16 → α off by 5%. **Lean-verified** as `alpha_QLF_eq : alpha_QLF = 1/137` in [`lean/QLF_FineStructureSubstrate.lean`](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/QLF_FineStructureSubstrate.lean), the first Lean theorem for a fundamental constant in the QLF tree. Parallel chirality-hiding pathway via `R_e = R_p · 6π⁵` in [`Proton_Resonance_R_e.md`](https://github.com/jimscarver/quantum-logical-framework/blob/main/Proton_Resonance_R_e.md) — also now **Lean-verified** as `mass_ratio_QLF_eq : mass_ratio_QLF = 6 * Real.pi ^ 5` in [`lean/QLF_LenzMassRatio.lean`](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/QLF_LenzMassRatio.lean), with `|S_3| = 6` (3-quark Bose permutation) and `hidden_chirality_angles = 5` as named substrate constants. Matches PDG `m_p/m_e = 1836.152` to 0.002%. The 5-angle count is further decomposed in [`lean/QLF_BorromeanAngles.lean`](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/QLF_BorromeanAngles.lean) as `5 = 3 + 2` (Jacobi internal DOF + chirality-mixing per Pauli scalar 2-axis structure), with bridge theorem `matches_lenz_hidden_chirality_angles` tying the decomposition to the Lenz module's named constant. **γ (Euler-Mascheroni constant)** is the third Lean-anchored fundamental constant, in [`lean/QLF_EulerMascheroni.lean`](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/QLF_EulerMascheroni.lean) via the harmonic-excess identity (γ_QLF = lim H_N − ln N over the ZFA-stable closure ensemble; 0.017% match via `constants_mapper.emerge_gamma()`). The constants-from-substrate program is now three-deep: α at 0.026%, m_p/m_e at 0.002%, γ at 0.017%, all Lean-anchored. The γ work also bridges substrate to the Riemann zeta function via [`lean/QLF_RiemannZeta.lean`](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/QLF_RiemannZeta.lean): γ_QLF is identified with ζ's Laurent constant at s = 1, and `critical_line_real_part = 1/2` is Lean-anchored as the count-balance ratio (the structural reason the critical line's real part is exactly 1/2). The doc [`Riemann-Conjecture-Proof.md`](https://github.com/jimscarver/quantum-logical-framework/blob/main/Riemann-Conjecture-Proof.md) now articulates the prime-annihilation structural argument: primes are irreducible ZFA closures; irreducible closures can only contribute zero via Hermitian-pair annihilation with their conjugate; Hermitian-pair annihilation events are balanced (count_pos = count_neg, ratio = 1/2) and live on Σ_sa; therefore prime contributions to ζ can only vanish on Re(s) = 1/2. Under QLF's epistemic stance — where the substrate-constructive part of mathematics has its own foundational adequacy, and ZFC's undecidable interior (per Busy Beaver: BB(745) is independent of ZFC, plus Gödel) is explicitly excluded from the proof-burden — this constitutes proof within QLF's frame: substrate-structural rigour is what proof means for the substrate-constructive part of mathematics. The three bridge axioms in QLF_Riemann.lean (NonTrivialZero, spectral_hilbert_polya, resonant_computation_for) are explicit RCA₀-to-WKL₀ bridges structurally motivated by the primes-irreducibility + balance chain; demanding ZFC-internal proof of spectral_hilbert_polya is asking for what BB/Gödel establishes ZFC cannot always provide. Stance is "sufficient proof for now, to be refined" — the proposed MRE_bridge reformulation and tighter Lean anchoring of the prime-annihilation chain are natural refinements. A mathematician requiring only ZFC-internal proofs has a coherent but different framework; both stances answer to different epistemic commitments. Numerical `c` is differently positioned: under QLF's substrate-first ontology, L_Planck and τ_Planck are substrate primitives (one Planck length and one Planck tick per substrate event, *together*), not defined via {ℏ, G, c}. So `c = L_Planck / τ_Planck` is QLF-derived without observable input — and the cosmic-scale derivation `c = R_cosmic / T_cosmic` with `n ≈ 6 × 10⁶⁰` from Hadronic Depth gives independently QLF-derived cosmic size and age that match observation. The SI numerical value reflects substrate-primitive-to-SI calibration. There is no Tier-3 open for `c` — the substrate event quantum *is* the first-principles content. Two scoping docs applying Hitoshi Kitada's local-time framework (gr-qc/9612043) sharpen this and the broader GR programme: [`Proton_Resonance_R_e.md`](https://github.com/jimscarver/quantum-logical-framework/blob/main/Proton_Resonance_R_e.md) decomposes the open R_e derivation as `R_e = R_p · 6π⁵` under the chirality-hiding-resonance reading — the proton's 3-quark Borromean closure hides individual quark chirality from electron-annihilation probes, and the electron mass is the resonance threshold that threads the needle between chirality-resolution and atomic binding. The `6π⁵ = |S_3| · π⁵` Lenz coincidence (1951, 0.002% agreement to m_p/m_e = 1836.152) recovered as `3!` quark permutation symmetry × 5-angle integration over hidden-chirality configuration space. [`Kitada_Local_Time_GR.md`](https://github.com/jimscarver/quantum-logical-framework/blob/main/Kitada_Local_Time_GR.md) extends the same Kitada lens to QLF's general-relativistic commitments, identifying three structural gaps: (Gap 1) name `R = local clock count` as a foundational identity; (Gap 2) reframe cosmic age = `n × τ_Planck` as the proper time of the cosmic-horizon Markov blanket with `n ≈ 6 × 10⁶⁰` from `HadronicDepth.md`; (Gap 3) derive Einstein equations as the coarse-grained limit of local-clock synchronization failure across a Markov blanket, with `8π = 4π · 2` (solid angle × Hermitian pair) and `G` as the vacuum's per-event entropy-gradient strength under `VacuumEnergy.md` §6.2. Both docs maintain honest-scoping discipline: they decompose the open problems into sharper sub-targets, not derivations themselves. The framework now has shell structure articulated at three scales — nuclear (`Magic_numbers.md`, vacuum-as-intruder), atomic (`Hydrogen.md` §4.1, Bohr spectrum as vacuum-resonance modes), and the unifying vacuum-alignment principle (`VacuumEnergy.md` §6) — all three are discrete frequency spectra of bound-state Markov-blanket depths. The browser app's slash-command + capability-token primitives are sketched as the control plane for a future quiet-frequency crystal QPU in QLF's [Crystal_QuantumOS.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/Crystal_QuantumOS.md); the qubit-register-scale Markov-blanket layer is sketched in [Emergent_Markov_Blankets.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/Emergent_Markov_Blankets.md). See [Active_Inference_Mathematics.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/Active_Inference_Mathematics.md) for the foundations meta-doc.

See [QLF CLAUDE.md](../quantum-logical-framework/CLAUDE.md) and [AI.md](https://github.com/jimscarver/quantum-logical-framework/blob/main/AI.md) for the full theoretical background.

### What NOT to say

- Do not describe the signaling server as trusted — it is an explicit untrusted relay
- Do not describe ZFA tokens as "passwords" or "API keys" — possessing the token IS the capability, with no separate authentication step
- Do not describe lemma auto-allocation as random — it is deterministic from the name, giving identical results on every client
- Do not describe the room as a server — the room is the emergent ZFA process of the peers; the signaling server only routes handshakes
