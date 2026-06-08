#!/usr/bin/env node
// QuantumOS persistent "memory peer" daemon.
//
// Stays connected to a room, persists the room's public state + transcript to
// disk, and RE-SERVES that state (name + sync-lemmas + sync-currencies) to every
// peer who joins — giving the otherwise-ephemeral p2p room durable memory. It
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
import { generateCapability, validateCapability, parseTwists, achievesZfa } from "./zfa.mjs";
import {
  newDynCapState, signEnvelope, verifyEnvelope,
  serializeState, deserializeState, serializeChain, deserializeChain,
} from "./dyncap.mjs";

const DEFAULT_SIGNAL = "wss://quantum-os-signaling.onrender.com";
const SIGNED_KINDS = new Set(["name", "lemma", "note-declare", "sync-lemmas", "sync-currencies"]);

const USAGE = `qos-daemon — persistent QuantumOS memory peer

Usage:
  node qos-daemon.mjs --room <cap:room:… | room-URL> [options]

Options:
  --room <cap|url>   Room capability token or a quantum-os URL (#room=…). (required)
  --name <s>         Display name (default: "qos-memory").
  --signal <url>     Signaling server (default: ${DEFAULT_SIGNAL}).
  --state <dir>      State directory (default: ./.qos-state).
  --verbose          Log every inbound message.
  --help, -h         Show this help.

Persists per room: lemmas.json, currencies.json, chains.json, transcript.jsonl.
Re-serves name + sync-lemmas + sync-currencies (dyncap-signed) to each joiner.
Runs until Ctrl-C.`;

function parseArgs(argv) {
  const a = { name: "qos-memory", signal: DEFAULT_SIGNAL, state: "./.qos-state", verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--room") a.room = argv[++i];
    else if (x === "--name") a.name = argv[++i];
    else if (x === "--signal") a.signal = argv[++i];
    else if (x === "--state") a.state = argv[++i];
    else if (x === "--verbose") a.verbose = true;
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
const writeJSON = (p, obj) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.room) { console.log(USAGE); process.exit(args.help ? 0 : 1); }

  const roomId = extractRoomCap(args.room);
  if (!roomId || !roomId.startsWith("cap:room:")) { console.error("[daemon] could not parse cap:room: from --room"); process.exit(1); }
  if (!validateCapability(roomId)) console.warn(`[daemon] warning: room token failed ZFA validation (continuing): ${roomId}`);

  const stateDir = args.state;
  const roomHex = roomId.replace(/^cap:room:/, "");
  const roomDir = path.join(stateDir, "rooms", roomHex);
  const identityPath = path.join(stateDir, "identity.json");
  const lemmasPath = path.join(roomDir, "lemmas.json");
  const currenciesPath = path.join(roomDir, "currencies.json");
  const chainsPath = path.join(roomDir, "chains.json");
  const transcriptPath = path.join(roomDir, "transcript.jsonl");

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

  // ---- per-room stores ----
  const lemmas = new Map(Object.entries(readJSON(lemmasPath, {})));       // name -> {twists,who,cap?,dyncap?}
  const currencies = new Map(Object.entries(readJSON(currenciesPath, {})));// token -> {currency,token,issuer,dyncap?}
  const chains = deserializeChain(fs.existsSync(chainsPath) ? fs.readFileSync(chainsPath, "utf8") : "{}");
  const peerNames = new Map();
  const persistLemmas = () => writeJSON(lemmasPath, Object.fromEntries(lemmas));
  const persistCurrencies = () => writeJSON(currenciesPath, Object.fromEntries(currencies));
  const persistChains = () => writeJSON(chainsPath, JSON.parse(serializeChain(chains)));
  const transcribe = (from, msg) => { try { fs.mkdirSync(roomDir, { recursive: true }); fs.appendFileSync(transcriptPath, JSON.stringify({ t: new Date().toISOString(), from, msg }) + "\n"); } catch {} };

  console.log(`[daemon] room ${roomId.slice(0, 18)}…  ${lemmas.size} lemma(s), ${currencies.size} curr/ies loaded  state=${stateDir}`);

  const peer = new QOSPeer({
    signalingUrl: args.signal, roomId, peerId: identity.peerId,
    onSignalingOpen: () => console.log("[daemon] signaling connected; joined room"),
    onSignalingClose: () => console.warn("[daemon] signaling dropped — reconnecting"),
    onPeerJoined: (id) => console.log(`[daemon] peer ${id.slice(0, 12)}… joined`),
    onPeerLeft: (id) => console.log(`[daemon] peer ${id.slice(0, 12)}… left`),
    onError: (e) => console.error("[daemon]", e?.message ?? e),
    onChannelOpen: (id) => { onChannelOpen(id); },
    onMessage: (from, d) => { onMessage(from, d); },
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

  function onChannelOpen(peerId) {
    console.log(`[daemon] serving state to ${peerId.slice(0, 12)}…`);
    signedSend(peerId, { kind: "name", name: myName });
    signedSend(peerId, { kind: "sync-lemmas", entries: [...lemmas.entries()].map(([name, e]) => ({ name, twists: e.twists, who: e.who, cap: e.cap, dyncap: e.dyncap })) });
    signedSend(peerId, { kind: "sync-currencies", entries: [...currencies.values()] });
  }

  async function verifyChain(from, d) {
    if (!d || typeof d !== "object" || !d.dyncap) return;
    const res = await verifyEnvelope(chains.get(from), roomId, d, d.dyncap);
    if (res.kind === "fork") { console.warn(`[daemon] ⚠ fork from ${from.slice(0, 12)}… at seq ${res.seq} (identity contested)`); }
    else if (res.kind === "anchor-mismatch") { console.warn(`[daemon] ⚠ anchor mismatch from ${from.slice(0, 12)}…`); }
    if (res.entry) { chains.set(from, res.entry); persistChains(); }
  }

  function ingestLemma(e, fromName) {
    if (!e || typeof e.name !== "string" || typeof e.twists !== "string") return false;
    const tw = parseTwists(e.twists);
    if (!tw || !achievesZfa(tw)) return false;
    const existing = lemmas.get(e.name);
    if (existing) { return existing.twists === e.twists; } // FWW + immutability
    lemmas.set(e.name, { twists: e.twists, who: e.who ?? fromName, cap: e.cap, dyncap: e.dyncap });
    return true;
  }
  function ingestCurrency(e, fromName) {
    if (!e || typeof e.token !== "string" || typeof e.currency !== "string") return false;
    if (!e.token.startsWith("cap:currency:") || !validateCapability(e.token)) return false;
    if (currencies.has(e.token)) return false; // FWW by token
    currencies.set(e.token, { currency: e.currency, token: e.token, issuer: e.issuer ?? fromName, dyncap: e.dyncap });
    return true;
  }

  async function onMessage(from, d) {
    if (args.verbose) console.log(`[daemon] ⇐ ${from.slice(0, 8)}… ${typeof d === "object" ? JSON.stringify(d).slice(0, 200) : d}`);
    transcribe(from, d);
    if (!d || typeof d !== "object") return;
    await verifyChain(from, d);
    const fromName = peerNames.get(from) ?? from.slice(0, 8);
    switch (d.kind) {
      case "name": if (typeof d.name === "string") peerNames.set(from, d.name); break;
      case "chat": console.log(`[${peerNames.get(from) ?? from.slice(0, 8)}…] ${d.text}`); break;
      case "qlf": console.log(`[${peerNames.get(from) ?? from.slice(0, 8)}… /${d.cmd}] ${(d.lines || []).join(" | ")}`); break;
      case "lemma": if (ingestLemma(d, fromName)) { persistLemmas(); console.log(`[daemon] +lemma "${d.name}"`); } break;
      case "note-declare": if (ingestCurrency({ currency: d.currency, token: d.token, dyncap: d.dyncap }, fromName)) { persistCurrencies(); console.log(`[daemon] +currency "${d.currency}"`); } break;
      case "sync-lemmas": { let n = 0; for (const e of d.entries || []) if (ingestLemma(e, fromName)) n++; if (n) { persistLemmas(); console.log(`[daemon] +${n} lemma(s) via sync`); } break; }
      case "sync-currencies": { let n = 0; for (const e of d.entries || []) if (ingestCurrency(e, fromName)) n++; if (n) { persistCurrencies(); console.log(`[daemon] +${n} currency/ies via sync`); } break; }
    }
  }

  peer.connect();
  console.log(`[daemon] running as "${myName}". Ctrl-C to stop.`);

  const shutdown = () => {
    console.log("\n[daemon] shutting down…");
    try { saveIdentity(); persistLemmas(); persistCurrencies(); persistChains(); } catch {}
    try { peer.disconnect(); } catch {}
    setTimeout(() => process.exit(0), 250);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
