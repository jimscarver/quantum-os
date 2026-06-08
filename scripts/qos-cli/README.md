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
rooms/<roomhex>/transcript.jsonl   # one JSON line per inbound message
```

Ingest rules mirror the browser: lemmas are first-write-wins by name and
immutable (a different-twists redeclare is rejected); currencies are FWW by
token; both are ZFA-validated before storing. Held notes/receipts are never
gossiped, so the daemon never stores private bearer value.

**To reset the room's remembered state**, delete the `--state` directory.

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
