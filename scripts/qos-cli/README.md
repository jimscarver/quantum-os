# qos-cli — headless QuantumOS room peer

A standalone Node script that joins a QuantumOS room by its capability token,
connects to the live peers over WebRTC, and broadcasts a chat message — then
exits. Useful for announcements, bots, or scripting from outside the browser.

It speaks the exact protocol of `packages/browser/src/peer.ts`:

- signaling JSON over WebSocket: `join` / `offer` / `answer` / `ice` / `leave`
- data channel label `"qos"`
- chat envelope `{ kind: "chat", text }` (plus an optional `{ kind: "name", name }`)
- peer identity is a freshly generated `cap:peer:…` ZFA token (ported from `zfa.ts`)

> **This directory is intentionally outside the pnpm workspace** (`packages/*`),
> so it does not affect the repo's typecheck or CI. Install its deps locally.

## The one thing to understand first

QuantumOS rooms are **pure peer-to-peer**. The signaling server only routes
WebRTC handshakes — there is **no server-side room and no message history**. A
broadcast reaches only the peers connected *at that moment*. **If nobody is in
the room, the message goes nowhere.** So to announce something, a human (or
another peer) must have the room open when you run this.

## Install

```bash
cd scripts/qos-cli
npm install          # pulls ws + werift (werift = pure-TS headless WebRTC)
```

## Use

```bash
# Announce to the public room (someone must be in it):
node qos-cli.mjs \
  --room "https://jimscarver.github.io/quantum-os/#room=cap%3Aroom%3A05214747236101414325074505234721" \
  --name "release-bot" \
  --message "QLF v1.6.0 released — https://github.com/jimscarver/quantum-logical-framework/releases/tag/v1.6.0"

# A bare cap works too:
node qos-cli.mjs --room cap:room:0521… -m "hello room"

# Listen and print room chat (Ctrl-C to exit):
node qos-cli.mjs --room cap:room:0521… --listen
```

Options: `--room` (cap or URL, required), `--message`/`-m`, `--name`,
`--signal <url>` (default `wss://quantum-os-signaling.onrender.com`),
`--wait <ms>` (give up if no peer reached, default 15000), `--linger <ms>`
(stay after delivery, default 2000), `--listen`, `--help`.

Exit codes: `0` delivered (or listened), `1` error, `2` no peer reached in time.

## Persistent "memory peer" daemon (`qos-daemon.mjs`)

The room has no server and no history — when every browser leaves, its lemmas,
currencies, and chat are gone. The daemon fixes that: it stays connected (with
auto-reconnect), **persists the room's public state + transcript to disk**, and
**re-serves that state to every peer who joins** (`name` + `sync-lemmas` +
`sync-currencies`, all dyncap-signed). It holds a **stable signed identity**
(`cap:peer` + dyncap anchor) across restarts, so peers TOFU-pin it as one
continuous peer.

```bash
node qos-daemon.mjs \
  --room "https://jimscarver.github.io/quantum-os/#room=cap%3Aroom%3A05214747236101414325074505234721" \
  --name "memory" --state ./.qos-state
```

Options: `--room` (cap or URL, required), `--name` (default `qos-memory`),
`--signal <url>`, `--state <dir>` (default `./.qos-state`, gitignored),
`--lemma <name>` (seed a durable lemma the daemon holds + re-serves to
joiners; ZFA twists minted automatically; repeatable), `--verbose`.
Runs until Ctrl-C, then flushes state and leaves.

Seeding a durable announcement (chat is ephemeral; a lemma persists and is
re-served to late joiners):

```bash
node qos-daemon.mjs --room "<…>" --name memory \
  --lemma "QLF v1.6.0 released — …/releases/tag/v1.6.0"
```

State layout (`--state` dir):

```
identity.json                 # { peerId, name, dyncap:{seed,anchor,seqByRoom} } — cross-room
rooms/<roomhex>/lemmas.json   # { name: { twists, who, cap?, dyncap? } }
rooms/<roomhex>/currencies.json
rooms/<roomhex>/chains.json   # dyncap TOFU pins (fork detection survives restart)
rooms/<roomhex>/series.json   # note terms-series { "USD~hash": { baseCurrency, termsHash, terms, issuer, dyncap? } }
rooms/<roomhex>/groups.json   # governance groups { groupId: { members, delegations, topicDelegations, issues, treasury?, kudos? } }
rooms/<roomhex>/retracted.json     # canonical lemma names + "group:<id>" retracted by their owner (tombstones)
rooms/<roomhex>/transcript.jsonl   # one JSON line per inbound message
```

Ingest rules mirror the browser: lemma names are **canonicalized** (trim +
collapse inner whitespace, matching `@[multi word]` names); lemmas are
first-write-wins by canonical name and immutable (a different-twists redeclare is
rejected); currencies are FWW by token; both are ZFA-validated before storing.
The daemon also honors a **`retract`** for a lemma from its **author** (the
sender's dyncap anchor must match the lemma's stored anchor): it drops the lemma,
tombstones it in `retracted.json`, and stops re-serving it — so an always-on
memory peer can't resurrect a lemma the author removed. **Note terms-series**
(`note-series`) are persisted and re-served via `sync-series`: a declaration is
accepted only when its terms hash to the series stamp (self-verifying), and a
live `note-series` additionally requires the sender to be the currency's issuer
(verified anchor). **Governance groups** are persisted and re-served via
`sync-gov`: the daemon applies the same group mutation envelopes the browser sends
(`group-open` / `group-member` admin-gated / `gov-delegate` self-signed /
`group-issue` / `group-vote` / `group-meta`), and honors a creator's group
disband (`retract` → tombstone), so groups + delegations + treasury/kudos
currencies survive when every browser leaves. Polls and the per-group inbox
(`group-msg`) are ephemeral and not persisted. Held notes/receipts are never
gossiped, so the daemon never stores private bearer value.

**To reset the room's remembered state**, delete the `--state` directory.

## Push a lemma to already-connected peers (`pushlemma.mjs`)

The daemon hands lemmas to a peer via `sync-lemmas` only when that peer's data
channel **opens** (join/refresh). A lemma seeded or learned *after* a peer
connected is therefore not pushed to it — and restarting the daemon does not
help, because it keeps a stable `cap:peer:…` identity, so an already-connected
browser treats it as the same open peer and never re-handshakes.

`pushlemma.mjs` closes that gap: it joins from a **fresh** peerId (which every
browser will handshake with) and broadcasts the lemma live as a `lemma` envelope
— the same kind a browser emits on `/lemma` — so connected peers ingest it
immediately.

```bash
# Forward a lemma the daemon already holds (read from its state file):
node pushlemma.mjs --room "<cap|url>" --select "<lemma-name>"
node pushlemma.mjs --room "<cap|url>" --cap-prefix cap:QLFv170

# Or broadcast an ad-hoc lemma (validated for ZFA before sending):
node pushlemma.mjs --room "<cap|url>" --lemma-name foo --twists "^v<>/\+-"
```

It stays connected for `--linger` ms (default 12000) to reach peers, then leaves.

## Verify offline (no network, no deps)

```bash
node selftest.mjs        # ZFA: 200 peer caps + closure facts + parseTwists
node dyncap.selftest.mjs # dyncap: sign→verify chain, canonicalization, fork detection, state round-trip
```

The dyncap suite proves the signing port matches the browser byte-for-byte
(so the daemon's signatures verify there).

```bash
npm install && node loopback.mjs   # werift↔werift WebRTC round-trip over a local relay
```

The loopback test spins an in-process signaling relay and two peers that
connect and exchange a chat — exercising the full handshake + data channel
locally (needs `ws` + `werift`).

```bash
node optimize-demo.mjs   # collective-annealing demo on a classic problem (TSP)
```

Runs the collective-optimization loop (generate → score → anneal → converge) on a
small Travelling Salesman instance and checks the result against the brute-force
optimum — the same loop a room runs collectively. No deps. See
[`OptimizationDemo.md`](../../OptimizationDemo.md) and
[`Collective_Optimization.md`](../../Collective_Optimization.md).

## Verified

- **Offline:** ZFA layer, dyncap sign/verify, and `loopback.mjs` (werift↔werift
  data channel) all pass.
- **Live (2026-06-08):** the daemon connected to the public room through the
  Render signaling server, established a WebRTC data channel **with a browser
  peer**, received its `name` + `sync-lemmas`, and persisted the room's lemmas
  to `--state`. werift↔browser interop confirmed. Lemmas that are count-balanced
  but not Pauli-closed are skipped on sync — identical to the browser's own
  `sync-lemmas` gate (`achievesZfa` required), so the daemon mirrors the room
  faithfully.

## Agents (facilitator, scribe, greeter …)

`agent.mjs` is a sibling daemon that joins a room as a **full member** (stable
`cap:peer` + dyncap identity) and posts **measured** nudges according to its
`--role` — effectively the runtime of
[`Room_Best_Practices.md`](../../Room_Best_Practices.md). It has no special
authority (it only posts `chat`); the group decides, and can `/gov trust` it up
or `/gov censure` it down like any peer — so its disruption level is governed by
the room, not hard-coded.

```bash
node agent.mjs --room <cap:room:… | room-URL> [--role facilitator] [--name <s>] \
  [--budget 4] [--silent-min 6] [--quiet | --active] \
  [--ai] [--ai-backend api|claude-code] [--state ./.qos-agent]
```

**Run a persistent trio** (detached, on a Claude subscription): `bash run-agents.sh`
launches facilitator + scribe + skeptic with the `claude-code` backend and stable
per-role identities (logs/pids under `.agents/`); `bash stop-agents.sh` stops them.
Vary it by passing a room then roles: `bash run-agents.sh <room> facilitator skeptic`.
(nohup'd, so they survive closing the terminal; use tmux/screen or a service to
survive logout/reboot.)

**Roles** (`agent-roles.mjs`): `facilitator` (greet, name-prompts, participation
nudges, dis/agreement synthesis), `scribe` (quietly tracks decisions, offers to
record them as `/lemma`), `greeter` (welcomes newcomers, helps set a name), and
`skeptic` (surfaces the unexamined assumption and asks for evidence before the group
closes — the Room Best Practices Skeptic). Each role picks a default name, a command
prefix (`/facil`, `/scribe`, `/greeter`, `/skeptic`), an AI persona, and which
proactive duties it performs. `facilitator.mjs` remains as a
thin back-compat shim (`--role facilitator`, historical `--state ./.qos-facilitator`).

**Multiple agents in one room.** Run several with different `--role` (and distinct
`--state` dirs). They tag their `name` envelope with their role, so they recognize
each other and (a) **elect a single lead** per shared proactive duty — only the
lowest-`peerId` agent that performs a duty acts, so N agents don't all greet — and
(b) count their posts **collectively** against the human fair-share, so adding
agents can't inflate the budget. Direct replies (`/facil`, `/<role> ask`) still
come from each agent for itself.

**Trust-governed membership.** An agent is an ordinary trust-weighted member: the
room governs its voice through the *same* liquid-trust primitives as humans
(`gov.mjs` is a faithful port of the browser's `trustLevels`). It ingests
`group-open` / `group-member` / `gov-trust` / `gov-censure` (and `sync-gov`) and
computes its **own standing**, then applies the rule *operate one level below your
actual rating, at full power for that capped level*: a rated agent posts up to
`min(configured budget, trustLevel)` per window — exactly one rung below a same-rated
human's weight `1 + level` — and **stands down** (posts nothing, direct replies only)
if a ⅔ censure quorum discredits it. With no ratings in its groups it runs at the
configured `--budget` (back-compat). `/<role> trust` reports its standing and its
`peerId` (so an admin can `/gov member add <peerId>` then `/gov trust`). Ingesting
unverified gov envelopes only ever *throttles* the agent's own voice (never exceeds
the operator's `--budget`), and the ⅔ quorum blocks a lone griefer from muting it.
Agents are **rated/governed, not raters** — they don't autonomously `/gov trust` or
`/gov censure` humans.

**Telling it's there / commands.** Because it's mostly silent, say `/facil` (or
"anyone here?", or just "hi") and it replies — that's how you confirm it's
present. `/facil help` lists what it does; `/facil ask <question>` gets a brief AI
answer about the room, facilitation, or decisions (needs `--ai`); `/facil optimize
<objective + constraints>` facilitates an annealing-style optimization round —
proposes candidates and the next `/estimate`/`/poll` step (needs `--ai`; see
[`Collective_Optimization.md`](../../Collective_Optimization.md)); `/facil off` /
`/facil on` mute and unmute it at runtime. These replies *answer a request*, so they're responsive
(rate-limited only by a short per-command cooldown) and work even while muted.

**Many facilitators, each speaks only for itself.** A room may have more than one
facilitator (or none) — `/facil` is broadcast, so each present facilitator replies
on its own. The browser does **not** run facilitation and does not vouch for any
facilitator; it only relays the command, and the `/help facil` text describes the
*relay*, not any facilitator's behaviour. Trust a facilitator's **self-description**
(its `/facil help` / `/facil ask` reply, attributed to its signed `name`/identity),
and judge each by its own replies — the AdvisorSystem prompt likewise tells the
daemon to describe only itself.

Deterministic behaviours (no AI):

- **Greets** new members once each (after a short grace) and **prompts the
  nameless** to set a `/name`. A greet held by the throttle re-queues (bounded).
- **Participation** (Room_Best_Practices Rules 6 & 12): solicits the silent
  quarter, gently rebalances a dominator.
- **Surfaces (dis)agreement** from `state-discrepancy` consensus broadcasts —
  names a contested split, or offers to record a converged value.

**AI advisor (`--ai`, opt-in).** With `--ai`, a pluggable advisor
([`facilitator-advisor.mjs`](facilitator-advisor.mjs)) adds two judgment behaviours —
*stimulate* (re-engage after a lull, invite the quieter voices) and *disagreement →
agreement* (name the crux + a path forward) — plus the `/facil ask` answer. It is
**advisory only**: it proposes a nudge that the same throttle gates, and is called
*only when a post would be allowed*, so usage stays bounded. The daemon is fully
functional without it. Two backends (`--ai-backend`):

- **`api`** (default) — Anthropic Messages API via `fetch` (no SDK dep), key from
  `ANTHROPIC_API_KEY`; pay-as-you-go API credits.
- **`claude-code`** — shells out to the local `claude` CLI in print mode, using your
  **Claude subscription** (Pro/Max) instead of API credits. Requires the `claude` CLI
  installed and logged in (`claude` once interactively to authenticate). No key needed:
  `node facilitator.mjs --room <…> --ai --ai-backend claude-code`.

**Measured disruption** is enforced by a post budget (`--budget` per 5-min
window), a minimum gap between posts, per-behaviour cooldowns, a fair-share check
so it never out-talks the humans in an active thread, and quiet-by-default.
`--quiet` / `--active` shift the whole policy. Stable identity + who-we've-greeted
persist under `--state`.

## Status / caveats

- **ZFA capability layer: tested** (`selftest.mjs`, all pass). Faithful port of
  the `zfa.ts` pure-TS fallback.
- **WebRTC interop: not yet exercised in CI / offline.** It requires a live
  browser peer in the room plus outbound network (STUN + the Render signaling
  server). `werift`'s event API has shifted across versions; the script guards
  both the `.subscribe(...)` and browser-compat (`.onopen`/`onicecandidate`)
  shapes, but if a method is missing on your installed `werift`, that's the
  first place to look. Pinned to `werift ^0.20`.
- **Legacy room token.** The published public-room cap
  `cap:room:05214747236101414325074505234721` predates the v0.17 Pauli-closure
  rule, so it fails `validateCapability` — exactly like the browser, this script
  only **warns** and proceeds (the cap is still a valid rendezvous id).
- Trust model unchanged: possessing the room cap **is** authorization; the
  signaling server is an untrusted relay; data channels are DTLS-encrypted.
