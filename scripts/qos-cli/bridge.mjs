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
// Usage:
//   node bridge.mjs --room <A> --room <B> [--room <C> …] \
//     [--channel <name>]… [--chat] [--name <label>] [--signal <wss url>] \
//     [--max-hops <n>]
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
  --name <label>     Display name announced in each room (default "room-bridge").
  --signal <url>     Signaling server (default ${DEFAULT_SIGNAL}).
  --max-hops <n>     Drop envelopes already relayed n times (default 1).
  --help             Show this help.

Each relayed message is prefixed with its origin room label so every
perspective sees where the input came from.`;

function parseArgs(argv) {
  const a = { rooms: [], channels: [], chat: false, name: "room-bridge",
              signal: DEFAULT_SIGNAL, maxHops: 1, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--room") a.rooms.push(argv[++i]);
    else if (v === "--channel") a.channels.push(argv[++i]);
    else if (v === "--chat") a.chat = true;
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

  // Recent-forward dedupe so a burst can't echo-storm across the mesh.
  const seen = new Map();               // key -> timestamp
  const SEEN_TTL = 8000;
  function firstTime(key) {
    const now = Date.now();
    for (const [k, t] of seen) if (now - t > SEEN_TTL) seen.delete(k);
    if (seen.has(key)) return false;
    seen.set(key, now);
    return true;
  }

  // Relay one inbound envelope from `src` to every OTHER room.
  function relay(src, d) {
    const hops = typeof d._hops === "number" ? d._hops : 0;
    if (d._bridge === BRIDGE_ID) return;          // our own echo — never re-relay
    if (hops >= args.maxHops) return;             // hop limit reached

    let out = null;
    if (d.kind === "channel-msg" && allowChannel(d.channel)) {
      out = { kind: "channel-msg", channel: d.channel,
              payload: `[${src.label}] ${d.payload}` };
    } else if (d.kind === "chat" && args.chat) {
      out = { kind: "chat", text: `[${src.label}] ${d.text}` };
    }
    if (!out) return;

    const key = `${src.cap}|${out.kind}|${out.channel ?? ""}|${out.payload ?? out.text}`;
    if (!firstTime(key)) return;

    out._bridge = BRIDGE_ID;
    out._hops = hops + 1;
    for (const dst of nodes) {
      if (dst === src || !dst.peer) continue;
      dst.peer.broadcast(out);
    }
    const what = out.kind === "chat" ? "chat" : `#${out.channel}`;
    console.log(`[bridge] ${src.label} → ${nodes.filter(n => n !== src).map(n => n.label).join(",")}  ${what}: ${(out.payload ?? out.text).slice(0, 80)}`);
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
              `chat=${args.chat}  maxHops=${args.maxHops}`);
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
