#!/usr/bin/env node
// pushlemma.mjs — broadcast a single lemma to peers ALREADY connected to a room,
// as a live `lemma` envelope (the same kind a browser emits on `/lemma`).
//
// Why this exists: the memory daemon (qos-daemon.mjs) only hands lemmas to a peer
// via `sync-lemmas` when that peer's data channel OPENS (join/refresh). A lemma
// seeded or learned AFTER a peer connected is therefore not pushed to it, and a
// daemon restart does not help — the daemon keeps a stable peerId, so an already
// connected browser treats it as the same open peer and never re-handshakes.
// This tool joins from a FRESH peerId (which every browser will handshake with)
// and broadcasts the lemma live, so connected peers ingest it immediately.
//
// Two modes:
//   1. Forward a lemma the daemon already holds (read from its state file):
//        node pushlemma.mjs --room <cap|url> --select <lemma-name>
//        node pushlemma.mjs --room <cap|url> --cap-prefix cap:QLFv170
//   2. Broadcast an ad-hoc lemma (validated for ZFA before sending):
//        node pushlemma.mjs --room <cap|url> --lemma-name foo --twists "^v<>/\+-"
//
// Pure Node 20 (werift via qospeer.mjs). No deps beyond the qos-cli dir.

import fs from "node:fs";
import path from "node:path";
import { QOSPeer } from "./qospeer.mjs";
import { parseTwists, achievesZfa } from "./zfa.mjs";

const DEFAULT_SIGNAL = "wss://quantum-os-signaling.onrender.com";

function usage() {
  console.log(`pushlemma — live-broadcast one lemma to peers already in a room.

Usage:
  node pushlemma.mjs --room <cap:room:… | room-URL> --select <lemma-name> [options]
  node pushlemma.mjs --room <…> --cap-prefix <cap-prefix> [options]
  node pushlemma.mjs --room <…> --lemma-name <name> --twists <twists> [options]

Options:
  --room <cap|url>   Room capability token, or a URL with a #room=<cap> fragment. (required)
  --select <name>    Forward the held lemma with this exact name (reads --state).
  --cap-prefix <p>   Forward the held lemma whose cap starts with <p> (reads --state).
  --lemma-name <n>   Ad-hoc lemma name (use with --twists).
  --twists <s>       Ad-hoc lemma twists (symbolic ^v<>/\\+-, hex 0-7, or cap:label:hex).
  --cap <token>      Optional cap token to attach to an ad-hoc lemma.
  --state <dir>      Daemon state dir for --select/--cap-prefix (default: ./.qos-state).
  --signal <url>     Signaling server (default: ${DEFAULT_SIGNAL}).
  --as <name>        Display name shown to peers (default: qos-push).
  --linger <ms>      How long to stay and reach peers before leaving (default: 12000).
  -h, --help         Show this help.`);
}

function parseArgs(argv) {
  const a = { signal: DEFAULT_SIGNAL, state: "./.qos-state", as: "qos-push", linger: 12000 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--room") a.room = argv[++i];
    else if (x === "--select") a.select = argv[++i];
    else if (x === "--cap-prefix") a.capPrefix = argv[++i];
    else if (x === "--lemma-name") a.lemmaName = argv[++i];
    else if (x === "--twists") a.twists = argv[++i];
    else if (x === "--cap") a.cap = argv[++i];
    else if (x === "--state") a.state = argv[++i];
    else if (x === "--signal") a.signal = argv[++i];
    else if (x === "--as") a.as = argv[++i];
    else if (x === "--linger") a.linger = Number(argv[++i]) || 12000;
    else if (x === "-h" || x === "--help") a.help = true;
  }
  return a;
}

// Accept a bare cap:room:…, or any URL with a #room=<url-encoded cap> fragment.
function extractRoomCap(s) {
  if (!s) return null;
  if (s.startsWith("cap:room:")) return s;
  const frag = s.includes("#") ? s.slice(s.indexOf("#") + 1) : s;
  const m = /room=([^&]+)/.exec(frag);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  return null;
}

// A fresh peerId every run — this is what makes connected browsers handshake.
function freshPeerId() {
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 32; i++) s += hex[(globalThis.crypto.getRandomValues(new Uint8Array(1))[0]) & 15];
  return `cap:peer:${s}`;
}

function loadHeldLemma(stateDir, roomHex, { select, capPrefix }) {
  const file = path.join(stateDir, "rooms", roomHex, "lemmas.json");
  if (!fs.existsSync(file)) { console.error(`[push] no lemmas.json at ${file}`); return null; }
  const lemmas = JSON.parse(fs.readFileSync(file, "utf8"));
  let hit;
  if (select) hit = Object.entries(lemmas).find(([n]) => n === select);
  else if (capPrefix) hit = Object.entries(lemmas).find(([, v]) => (v.cap || "").startsWith(capPrefix));
  if (!hit) { console.error(`[push] no held lemma matching ${select ? `name "${select}"` : `cap-prefix "${capPrefix}"`}`); return null; }
  const [name, e] = hit;
  return { name, twists: e.twists, cap: e.cap, who: e.who, dyncap: e.dyncap };
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.room) { usage(); process.exit(args.help ? 0 : 1); }

const roomId = extractRoomCap(args.room);
if (!roomId || !roomId.startsWith("cap:room:")) {
  console.error("[push] could not parse a cap:room: token from --room"); process.exit(1);
}
const roomHex = roomId.replace(/^cap:room:/, "");

// Resolve the lemma to broadcast.
let lemma;
if (args.lemmaName && args.twists) {
  const tw = parseTwists(args.twists);
  if (!tw || !achievesZfa(tw)) { console.error(`[push] twists "${args.twists}" do not achieve ZFA (count balance ∧ Pauli closure)`); process.exit(1); }
  lemma = { name: args.lemmaName, twists: args.twists, cap: args.cap, who: args.as };
} else if (args.select || args.capPrefix) {
  lemma = loadHeldLemma(args.state, roomHex, args);
  if (!lemma) process.exit(1);
} else {
  console.error("[push] specify a lemma: --select <name>, --cap-prefix <p>, or --lemma-name <n> --twists <s>");
  usage(); process.exit(1);
}

console.log(`[push] broadcasting lemma "${lemma.name.slice(0, 48)}${lemma.name.length > 48 ? "…" : ""}"  ${lemma.cap ?? "(no cap)"}`);

const peerId = freshPeerId();
const seen = new Set();
const peer = new QOSPeer({
  signalingUrl: args.signal, roomId, peerId,
  onSignalingOpen: () => console.log("[push] signaling connected; joined room"),
  onSignalingClose: () => console.warn("[push] signaling dropped"),
  onChannelOpen: (id) => {
    console.log(`[push] channel open → ${id.slice(0, 14)}… sending name + lemma`);
    peer.send(id, { kind: "name", name: args.as });
    peer.send(id, { kind: "lemma", name: lemma.name, twists: lemma.twists, cap: lemma.cap, who: lemma.who ?? args.as, dyncap: lemma.dyncap });
    seen.add(id);
  },
  onError: (err) => console.error("[push]", err?.message ?? err),
});
peer.connect();

setTimeout(() => {
  console.log(`[push] delivered to ${seen.size} peer(s); leaving`);
  try { peer.leave?.(); } catch {}
  process.exit(0);
}, args.linger);
