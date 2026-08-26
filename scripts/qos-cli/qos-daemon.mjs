#!/usr/bin/env node
// QuantumOS persistent "memory peer" daemon.
//
// Stays connected to a room, persists the room's public state + transcript to
// disk, and RE-SERVES that state (name + sync-lemmas + sync-currencies +
// sync-series + sync-gov) to every peer who joins — giving the otherwise-
// ephemeral p2p room durable memory. It
// holds a stable signed identity (cap:peer + dyncap anchor) across restarts, so
// peers TOFU-pin it as one continuous peer.
//
// Faithful to packages/browser/src: data channel "qos", sync envelopes from
// app.ts onChannelOpen, dyncap signing from dyncap.ts, reconnect from peer.ts.
//
// NOTE: rooms are p2p — the daemon only sees/serves peers while it is connected
// and at least one other peer is present. It is the room's persistence layer,
// not a server. State lives under --state (default ./.qos-state).

import fs from "node:fs";
import path from "node:path";
import { QOSPeer } from "./qospeer.mjs";
import { openRoomMemory, MEMORY_SIGNED_KINDS } from "./room-memory.mjs";
import { generateCapability, validateCapability, parseTwists, achievesZfa } from "./zfa.mjs";
import {
  newDynCapState, signEnvelope, verifyEnvelope,
  serializeState, deserializeState, serializeChain, deserializeChain,
} from "./dyncap.mjs";

const DEFAULT_SIGNAL = "wss://quantum-os-signaling.onrender.com";
const SIGNED_KINDS = new Set(["name", ...MEMORY_SIGNED_KINDS]);

const USAGE = `qos-daemon — persistent QuantumOS memory peer

Usage:
  node qos-daemon.mjs --room <cap:room:… | room-URL> [options]

Options:
  --room <cap|url>   Room capability token or a quantum-os URL (#room=…). (required)
  --name <s>         Display name (default: "qos-memory").
  --signal <url>     Signaling server (default: ${DEFAULT_SIGNAL}).
  --state <dir>      State directory (default: ./.qos-state).
  --lemma <name>     Seed a durable lemma the daemon holds + re-serves to
                     joiners (ZFA twists are minted automatically). Repeatable.
  --verbose          Log every inbound message.
  --help, -h         Show this help.

Persists per room: lemmas.json, currencies.json, series.json, groups.json,
chains.json, retracted.json, transcript.jsonl. Re-serves name + sync-lemmas +
sync-currencies + sync-series + sync-gov (dyncap-signed) to each joiner, and
honors author lemma / creator group retractions (won't re-serve them). Runs
until Ctrl-C.`;

function parseArgs(argv) {
  const a = { name: "qos-memory", signal: DEFAULT_SIGNAL, state: "./.qos-state", verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--room") a.room = argv[++i];
    else if (x === "--name") a.name = argv[++i];
    else if (x === "--signal") a.signal = argv[++i];
    else if (x === "--state") a.state = argv[++i];
    else if (x === "--verbose") a.verbose = true;
    else if (x === "--lemma") (a.lemmas ??= []).push(argv[++i]);
    else if (x === "--help" || x === "-h") a.help = true;
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

const readJSON = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } };
// Atomic: write a temp file in the same directory, then rename over the target.
// identity.json holds the dyncap seed — a crash mid-write leaves it truncated,
// readJSON falls back to null, and the daemon mints a FRESH identity: a forked
// dyncap chain against every peer's TOFU pin, and its `/gov trust` standing
// (keyed by peerId) silently gone.
const writeJSON = (p, obj) => {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(p)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
};

// Lemma names are canonicalized (trim + collapse inner whitespace) to match the
// browser's canonLemma, so multi-word names (referenced as @[name with spaces])
// key identically here and the daemon's first-write-wins agrees with the browser.
const canonLemma = (name) => String(name ?? "").trim().replace(/\s+/g, " ");

// Terms-series stamp: FNV-1a 32-bit → 8 hex, byte-for-byte the browser's
// termsHash8 (notes.ts). A note-series declaration is trustworthy when its terms
// hash to the stamp baked in the series id (self-verifying commitment).
const termsHash8 = (text) => {
  const s = String(text ?? "").trim().replace(/\s+/g, " ");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.room) { console.log(USAGE); process.exit(args.help ? 0 : 1); }

  const roomId = extractRoomCap(args.room);
  if (!roomId || !roomId.startsWith("cap:room:")) { console.error("[daemon] could not parse cap:room: from --room"); process.exit(1); }
  if (!validateCapability(roomId)) console.warn(`[daemon] warning: room token failed ZFA validation (continuing): ${roomId}`);

  const stateDir = args.state;
  const identityPath = path.join(stateDir, "identity.json");

  // ---- identity (stable across restarts) ----
  let identity = readJSON(identityPath, null);
  let dyncapState;
  if (identity?.peerId && identity?.dyncap) {
    dyncapState = await deserializeState(JSON.stringify(identity.dyncap));
  }
  if (!identity?.peerId || !dyncapState) {
    identity = { peerId: generateCapability("peer"), name: args.name, dyncap: null };
    dyncapState = await newDynCapState();
    identity.dyncap = JSON.parse(serializeState(dyncapState));
    writeJSON(identityPath, identity);
    console.log(`[daemon] new identity ${identity.peerId.slice(0, 18)}…  anchor ${dyncapState.anchor.slice(0, 12)}…`);
  } else {
    if (args.name && args.name !== "qos-memory") identity.name = args.name;
    console.log(`[daemon] loaded identity ${identity.peerId.slice(0, 18)}…  anchor ${dyncapState.anchor.slice(0, 12)}…`);
  }
  const myName = identity.name || "qos-memory";
  const saveIdentity = () => { identity.dyncap = JSON.parse(serializeState(dyncapState)); identity.name = myName; writeJSON(identityPath, identity); };

  const TAG = "[daemon]";
  const mem = openRoomMemory({
    roomId, stateDir, myName,
    signedSend: (t, e) => signedSend(t, e),
    log: (m) => console.log(`${TAG} ${m}`),
    warn: (m) => console.warn(`${TAG} ${m}`),
    verbose: args.verbose,
    seedLemmas: args.lemmas ?? [],
  });
  console.log(`${TAG} room ${roomId.slice(0, 18)}…  ${mem.summary()} loaded  state=${stateDir}`);

  const peer = new QOSPeer({
    signalingUrl: args.signal, roomId, peerId: identity.peerId,
    onSignalingOpen: () => console.log("[daemon] signaling connected; joined room"),
    onSignalingClose: () => console.warn("[daemon] signaling dropped"),
    onReconnectScheduled: (ms) => console.warn(`[daemon] reconnecting in ${(ms / 1000).toFixed(1)}s`),
    onPeerJoined: (id) => console.log(`[daemon] peer ${id.slice(0, 12)}… joined`),
    onPeerLeft: (id) => console.log(`[daemon] peer ${id.slice(0, 12)}… left`),
    onError: (e) => console.error("[daemon]", e?.message ?? e),
    onChannelOpen: (id) => mem.serveStateTo(id),
    onMessage: (from, d) => { void mem.ingest(from, d); },
  });

  // ---- signed send (serialized so dyncap seq stays monotonic) ----
  let signQueue = Promise.resolve();
  function signedSend(target, env) {
    signQueue = signQueue.then(async () => {
      const out = { ...env };
      if (SIGNED_KINDS.has(env.kind)) {
        try { out.dyncap = await signEnvelope(dyncapState, roomId, env); saveIdentity(); }
        catch (e) { console.error("[daemon] sign failed:", e?.message ?? e); }
      }
      peer.send(target, out);
    }).catch((e) => console.error("[daemon] send error:", e?.message ?? e));
    return signQueue;
  }

  peer.connect();
  console.log(`[daemon] running as "${myName}". Ctrl-C to stop.`);

  const shutdown = () => {
    console.log("\n[daemon] shutting down…");
    try { saveIdentity(); mem.flush(); } catch {}
    try { peer.disconnect(); } catch {}
    setTimeout(() => process.exit(0), 250);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
