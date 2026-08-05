#!/usr/bin/env node
// bridge.mjs — share information among perspectives, across rooms.
//
// A QuantumOS room is a Markov blanket: peers inside share a closure, peers
// outside see nothing. This bridge is one perspective that stands in TWO (or
// more) rooms at once and relays each room's OUTPUTS as another room's INPUTS.
//
// That standing-in-both IS the shared closure. In QLF terms the bridge realizes
// ER=EPR at the collaboration layer (SharedClosure A B := achieves_ZFA (A++B),
// ER_EPR_QLF): the bridge peer's simultaneous membership entangles the rooms, so
// a channel message that closes in room A becomes an input to room B — exactly
// the "interaction manifold" of two intersecting histories in MultiParticle.py.
//
// Inputs/outputs travel on CHANNELS (the app's `/channel send <name> <text>` →
// `{ kind: "channel-msg", channel, payload }`). By default every channel is
// bridged; restrict with --channel <name> (repeatable). Add --chat to also
// relay ordinary chat. Loops are prevented by tagging forwarded envelopes with
// this bridge's id and a hop count.
//
// Durable state can be bridged too (opt-in):
//   --lemmas  relay published lemmas (`kind:"lemma"`) AND import a room's
//             existing lemma set when the bridge joins (`sync-lemmas`).
//   --gov     relay group/governance mutations (`group-*`, `gov-*`) AND import
//             existing groups (`sync-gov`).
// These envelopes are signed (dyncap); the bridge relays them VERBATIM so the
// original signer's anchor/chain carries through — receivers accept forwarded
// entries on the forwarder's trust (dyncap.ts: witness is not re-hashed by
// receivers). Structured envelopes are never text-mangled; provenance for them
// is the signer's own anchor, not an origin prefix.
//
// Usage:
//   node bridge.mjs --room <A> --room <B> [--room <C> …] \
//     [--channel <name>]… [--chat] [--lemmas] [--gov] \
//     [--name <label>] [--signal <wss url>] [--max-hops <n>]
//
// Rooms may be given as bare caps (cap:room:…) or as full app URLs
// (…/#room=cap%3Aroom%3A…). At least two rooms are required.
//
// This directory is intentionally outside the pnpm workspace, so it does not
// affect the repo's typecheck or CI. Install deps: `npm install` (ws + werift).

import { QOSPeer } from "./qospeer.mjs";
import { generateCapability, validateCapability } from "./zfa.mjs";

const DEFAULT_SIGNAL = "wss://quantum-os-signaling.onrender.com";
const BRIDGE_ID = generateCapability("peer"); // unique tag for loop prevention

const USAGE = `bridge.mjs — relay information among perspectives across rooms

  node bridge.mjs --room <A> --room <B> [--room <C> …] [options]

Options:
  --room <cap|url>   A room to bridge (repeatable; at least two required).
  --channel <name>   Only relay this channel (repeatable). Default: all channels.
  --chat             Also relay ordinary chat messages between rooms.
  --lemmas           Relay published lemmas + import each room's lemma set.
  --gov              Relay group/governance mutations + import existing groups.
  --name <label>     Display name announced in each room (default "room-bridge").
  --signal <url>     Signaling server (default ${DEFAULT_SIGNAL}).
  --max-hops <n>     Drop envelopes already relayed n times (default 1).
  --help             Show this help.

Chat/channel messages are prefixed with their origin room label. Lemma and
governance envelopes are relayed verbatim (signed), so their provenance is the
original signer's anchor.`;

// Signed governance / group state mutations (relayed verbatim under --gov).
const GOV_KINDS = new Set([
  "group-open", "group-member", "group-meta", "group-msg",
  "group-issue", "group-vote",
  "gov-delegate", "gov-trust", "gov-censure", "gov-vault",
]);

function parseArgs(argv) {
  const a = { rooms: [], channels: [], chat: false, lemmas: false, gov: false,
              name: "room-bridge", signal: DEFAULT_SIGNAL, maxHops: 1, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--room") a.rooms.push(argv[++i]);
    else if (v === "--channel") a.channels.push(argv[++i]);
    else if (v === "--chat") a.chat = true;
    else if (v === "--lemmas") a.lemmas = true;
    else if (v === "--gov") a.gov = true;
    else if (v === "--name") a.name = argv[++i];
    else if (v === "--signal") a.signal = argv[++i];
    else if (v === "--max-hops") a.maxHops = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (v === "--help" || v === "-h") a.help = true;
  }
  return a;
}

function extractRoomCap(s) {
  if (!s) return null;
  if (s.startsWith("cap:room:")) return s;
  const frag = s.includes("#") ? s.slice(s.indexOf("#") + 1) : s;
  const m = /room=([^&]+)/.exec(frag);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  return s.startsWith("cap:") ? s : null;
}

// A short, human-readable label for a room cap.
function roomLabel(cap, index) {
  const tail = cap.replace(/^cap:room:/, "").slice(0, 6);
  return `R${index + 1}:${tail}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(0); }

  const caps = args.rooms.map(extractRoomCap).filter(Boolean);
  const uniq = [...new Set(caps)];
  if (uniq.length < 2) {
    console.error("[bridge] need at least two distinct --room values. Try --help.");
    process.exit(1);
  }
  for (const cap of uniq) {
    if (!cap.startsWith("cap:room:")) {
      console.error(`[bridge] not a room capability: ${cap}`);
      process.exit(1);
    }
    if (!validateCapability(cap)) {
      console.warn(`[bridge] warning: room token failed ZFA validation (continuing): ${cap.slice(0, 24)}…`);
    }
  }

  const channelAllow = new Set(args.channels);
  const allowChannel = (name) => channelAllow.size === 0 || channelAllow.has(name);

  // One perspective, one peer per room (each room is a distinct Markov blanket).
  const nodes = uniq.map((cap, i) => ({
    cap, label: roomLabel(cap, i), peerId: generateCapability("peer"), peer: null, open: 0,
  }));

  // Short-window dedupe for chat/channel bursts (transient, time-boxed).
  const seen = new Map();               // key -> timestamp
  const SEEN_TTL = 8000;
  function firstTime(key) {
    const now = Date.now();
    for (const [k, t] of seen) if (now - t > SEEN_TTL) seen.delete(k);
    if (seen.has(key)) return false;
    seen.set(key, now);
    return true;
  }
  // Durable dedupe for state items — a given lemma/mutation is relayed once per
  // bridge lifetime (prevents a later sync-* echoing it back through the mesh).
  const seenState = new Set();
  function firstState(key) {
    if (seenState.has(key)) return false;
    if (seenState.size > 20000) seenState.clear();   // bounded
    seenState.add(key);
    return true;
  }

  const others = (src) => nodes.filter((n) => n !== src && n.peer);
  function push(src, out, hops) {           // stamp + broadcast to the other rooms
    out._bridge = BRIDGE_ID;
    out._hops = hops + 1;
    for (const dst of others(src)) dst.peer.broadcast(out);
  }
  function stripMeta(d) { const c = { ...d }; delete c._bridge; delete c._hops; return c; }

  // Relay one inbound envelope from `src` to every OTHER room.
  function relay(src, d) {
    const hops = typeof d._hops === "number" ? d._hops : 0;
    if (d._bridge === BRIDGE_ID) return;          // our own echo — never re-relay
    if (hops >= args.maxHops) return;             // hop limit reached
    const kind = d.kind;
    const dstLabels = others(src).map((n) => n.label).join(",");
    const log = (what) => console.log(`[bridge] ${src.label} → ${dstLabels}  ${what}`);

    // --- text: transform with an origin prefix (unsigned) ---
    if (kind === "channel-msg" && allowChannel(d.channel)) {
      const out = { kind: "channel-msg", channel: d.channel, payload: `[${src.label}] ${d.payload}` };
      if (!firstTime(`ch|${src.cap}|${d.channel}|${d.payload}`)) return;
      push(src, out, hops); log(`#${d.channel}: ${String(d.payload).slice(0, 80)}`); return;
    }
    if (kind === "chat" && args.chat) {
      const out = { kind: "chat", text: `[${src.label}] ${d.text}` };
      if (!firstTime(`chat|${src.cap}|${d.text}`)) return;
      push(src, out, hops); log(`chat: ${String(d.text).slice(0, 80)}`); return;
    }

    // --- lemmas: verbatim (keep dyncap so the signer's chain carries through) ---
    if (args.lemmas && kind === "lemma") {
      if (!firstState(`lemma|${d.name}|${d.cap ?? ""}`)) return;
      push(src, stripMeta(d), hops); log(`lemma ${d.name}`); return;
    }
    if (args.lemmas && kind === "sync-lemmas" && Array.isArray(d.entries)) {
      for (const e of d.entries) {
        if (!e || !e.name) continue;
        if (!firstState(`lemma|${e.name}|${e.cap ?? ""}`)) continue;
        const lem = { kind: "lemma", name: e.name, twists: e.twists, cap: e.cap, who: e.who,
                      ...(e.dyncap ? { dyncap: e.dyncap } : {}) };
        push(src, lem, hops);
      }
      log(`lemmas import (${d.entries.length})`); return;
    }

    // --- governance: verbatim signed mutations + group import ---
    if (args.gov && GOV_KINDS.has(kind)) {
      if (!firstState(`${kind}|${d.dyncap?.witness ?? JSON.stringify(d)}`)) return;
      push(src, stripMeta(d), hops); log(`${kind} ${d.groupId ?? ""}`.trim()); return;
    }
    if (args.gov && kind === "sync-gov" && Array.isArray(d.groups)) {
      if (!firstState(`sync-gov|${d.dyncap?.witness ?? d.groups.map((g) => g.id).join(",")}`)) return;
      push(src, stripMeta(d), hops); log(`gov import (${d.groups.length} groups)`); return;
    }
  }

  for (const node of nodes) {
    node.peer = new QOSPeer({
      signalingUrl: args.signal,
      roomId: node.cap,
      peerId: node.peerId,
      onSignalingOpen: () => console.log(`[bridge] ${node.label}: signaling connected`),
      onChannelOpen: (remoteId) => {
        node.open++;
        // Announce ourselves so peers see a name, not a hex id.
        node.peer.send(remoteId, { kind: "name", name: args.name });
        console.log(`[bridge] ${node.label}: peer ${remoteId.slice(0, 10)}… connected (${node.open} live)`);
      },
      onPeerLeft: () => { node.open = Math.max(0, node.open - 1); },
      onMessage: (from, d) => {
        if (!d || typeof d !== "object") return;
        if (from === node.peerId) return;          // ignore our own frames
        relay(node, d);
      },
      onError: (e) => console.warn(`[bridge] ${node.label}: ${e?.message ?? e}`),
    });
    node.peer.connect();
  }

  console.log(`[bridge] bridging ${nodes.length} rooms as "${args.name}"  ` +
              `channels=${channelAllow.size ? [...channelAllow].join(",") : "all"}  ` +
              `chat=${args.chat}  lemmas=${args.lemmas}  gov=${args.gov}  maxHops=${args.maxHops}`);
  console.log(`[bridge] rooms: ${nodes.map(n => n.label).join("  ")}`);
  console.log("[bridge] a message that closes in one room becomes an input to the others. Ctrl-C to stop.");

  const shutdown = () => {
    console.log("\n[bridge] leaving all rooms…");
    for (const n of nodes) { try { n.peer?.disconnect(); } catch {} }
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error("[bridge] fatal:", e); process.exit(1); });
