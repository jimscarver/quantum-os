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

## Verify the ZFA layer (no network, no deps)

```bash
node selftest.mjs
```

Generates 200 peer caps and checks each is count-balanced ∧ Pauli-closed,
plus malformed-token rejection and known closure facts (`+-`→−I, `^v`→+I).

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
