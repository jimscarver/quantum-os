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
import { generateCapability, validateCapability, parseTwists, achievesZfa } from "./zfa.mjs";
import {
  newDynCapState, signEnvelope, verifyEnvelope,
  serializeState, deserializeState, serializeChain, deserializeChain,
} from "./dyncap.mjs";

const DEFAULT_SIGNAL = "wss://quantum-os-signaling.onrender.com";
const SIGNED_KINDS = new Set(["name", "lemma", "note-declare", "sync-lemmas", "sync-currencies", "sync-series", "sync-gov"]);

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
const writeJSON = (p, obj) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); };

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
  const roomHex = roomId.replace(/^cap:room:/, "");
  const roomDir = path.join(stateDir, "rooms", roomHex);
  const identityPath = path.join(stateDir, "identity.json");
  const lemmasPath = path.join(roomDir, "lemmas.json");
  const currenciesPath = path.join(roomDir, "currencies.json");
  const chainsPath = path.join(roomDir, "chains.json");
  const seriesPath = path.join(roomDir, "series.json");
  const groupsPath = path.join(roomDir, "groups.json");
  const retractedPath = path.join(roomDir, "retracted.json");
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
  const seriesTerms = new Map(Object.entries(readJSON(seriesPath, {})));    // seriesKey ("USD~hash") -> {seriesKey,baseCurrency,termsHash,terms,issuer,dyncap?}
  const groups = new Map(Object.entries(readJSON(groupsPath, {})));         // groupId -> Group (members, delegations, topicDelegations, issues, treasury?, kudos?)
  const chains = deserializeChain(fs.existsSync(chainsPath) ? fs.readFileSync(chainsPath, "utf8") : "{}");
  const retracted = new Set(readJSON(retractedPath, []));                  // canonical lemma names + "group:<id>" retracted by their owner
  const peerNames = new Map();
  const persistLemmas = () => writeJSON(lemmasPath, Object.fromEntries(lemmas));
  const persistCurrencies = () => writeJSON(currenciesPath, Object.fromEntries(currencies));
  const persistSeries = () => writeJSON(seriesPath, Object.fromEntries(seriesTerms));
  const persistGroups = () => writeJSON(groupsPath, Object.fromEntries(groups));
  const persistRetracted = () => writeJSON(retractedPath, [...retracted]);
  const groupIsAdmin = (g, peerId) => peerId === g.creator || g.members?.[peerId]?.role === "admin";
  const persistChains = () => writeJSON(chainsPath, JSON.parse(serializeChain(chains)));
  const transcribe = (from, msg) => { try { fs.mkdirSync(roomDir, { recursive: true }); fs.appendFileSync(transcriptPath, JSON.stringify({ t: new Date().toISOString(), from, msg }) + "\n"); } catch {} };

  console.log(`[daemon] room ${roomId.slice(0, 18)}…  ${lemmas.size} lemma(s), ${currencies.size} curr/ies, ${seriesTerms.size} terms-series, ${groups.size} group(s) loaded  state=${stateDir}`);

  // Seed durable lemmas (--lemma). Mint ZFA-valid twists so receiving peers
  // accept them on sync (achievesZfa gate). FWW by name: skip if already held.
  let seeded = 0;
  for (const lraw of args.lemmas ?? []) {
    const lname = canonLemma(lraw);
    if (!lname || lemmas.has(lname) || retracted.has(lname)) continue;
    const label = (lname.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "lemma");
    const cap = generateCapability(label);          // cap:label:hex, hex is ZFA-balanced
    const twists = cap.split(":")[2];
    if (!achievesZfa(parseTwists(twists))) continue; // belt-and-suspenders
    lemmas.set(lname, { twists, who: myName, cap });
    seeded++;
    console.log(`[daemon] seeded lemma "${lname.slice(0, 48)}${lname.length > 48 ? "…" : ""}"  ${cap.slice(0, 22)}…`);
  }
  if (seeded) persistLemmas();

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
    if (seriesTerms.size) signedSend(peerId, { kind: "sync-series", entries: [...seriesTerms.values()] });
    if (groups.size) signedSend(peerId, { kind: "sync-gov", groups: [...groups.values()] });
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
    const name = canonLemma(e.name);
    if (!name || retracted.has(name)) return false;        // tombstoned — don't resurrect
    const tw = parseTwists(e.twists);
    if (!tw || !achievesZfa(tw)) return false;
    const existing = lemmas.get(name);
    if (existing) { return existing.twists === e.twists; } // FWW + immutability
    lemmas.set(name, { twists: e.twists, who: e.who ?? fromName, cap: e.cap, dyncap: e.dyncap });
    return true;
  }
  function ingestCurrency(e, fromName) {
    if (!e || typeof e.token !== "string" || typeof e.currency !== "string") return false;
    // A currency authority token is cap:token-<currency>:<hex> (mintCurrencyToken
    // in notes.ts; the browser checks parseNoteLabel.kind === "token"). The old
    // "cap:currency:" prefix never matched, so currencies were silently dropped.
    if (!e.token.startsWith(`cap:token-${e.currency}:`) || !validateCapability(e.token)) return false;
    if (currencies.has(e.token)) return false; // FWW by token
    currencies.set(e.token, { currency: e.currency, token: e.token, issuer: e.issuer ?? fromName, dyncap: e.dyncap });
    return true;
  }
  // Ingest a note terms-series declaration. `senderAnchor` is the sender's
  // verified dyncap anchor (or undefined). `requireIssuer` is true for a live
  // note-series (the sender claims to BE the issuer) and false for a forwarded
  // sync-series (the stamp self-commits to the terms, so a forwarder can't fake
  // them). FWW by seriesKey.
  function ingestSeries(e, fromName, senderAnchor, requireIssuer) {
    if (!e || typeof e.seriesKey !== "string" || typeof e.terms !== "string") return false;
    const { seriesKey, baseCurrency, termsHash, terms } = e;
    if (typeof baseCurrency !== "string" || typeof termsHash !== "string") return false;
    // Self-consistency: the series id must be base~hash and the stamp must
    // commit to exactly these terms.
    if (termsHash8(terms) !== termsHash || seriesKey !== `${baseCurrency}~${termsHash}`) return false;
    if (requireIssuer) {
      // If we know who issues baseCurrency, the sender must be that issuer.
      const known = [...currencies.values()].find((c) => c.currency === baseCurrency);
      if (known?.dyncap?.anchor && senderAnchor && known.dyncap.anchor !== senderAnchor) return false;
    }
    if (seriesTerms.has(seriesKey)) return false; // FWW by series id
    seriesTerms.set(seriesKey, { seriesKey, baseCurrency, termsHash, terms, issuer: e.issuer ?? fromName, dyncap: e.dyncap });
    return true;
  }
  // Merge a Group from a sync-gov handshake: adopt unknown (unless tombstoned),
  // else union members / delegations / topic delegations / issues / treasury by
  // latest `at`. The daemon only stores + re-serves groups (no tally), so this
  // is a coarse structural merge of the signed group record.
  function mergeGroup(raw) {
    if (!raw || typeof raw !== "object") return false;
    const id = String(raw.id ?? ""); if (!id || retracted.has("group:" + id)) return false;
    const ex = groups.get(id);
    if (!ex) {
      groups.set(id, {
        id, name: String(raw.name ?? ""), creator: String(raw.creator ?? ""), creatorLabel: String(raw.creatorLabel ?? "?"),
        createdAt: raw.createdAt ?? 0,
        members: (raw.members && typeof raw.members === "object") ? raw.members : {},
        delegations: (raw.delegations && typeof raw.delegations === "object") ? raw.delegations : {},
        topicDelegations: (raw.topicDelegations && typeof raw.topicDelegations === "object") ? raw.topicDelegations : {},
        issues: Array.isArray(raw.issues) ? raw.issues : [],
        ...(typeof raw.treasury === "string" ? { treasury: raw.treasury } : {}),
        ...(typeof raw.kudos === "string" ? { kudos: raw.kudos } : {}),
      });
      return true;
    }
    let changed = false;
    for (const [pid, m] of Object.entries((raw.members && typeof raw.members === "object") ? raw.members : {})) {
      const cur = ex.members?.[pid]; if (!cur || (m.at ?? 0) > (cur.at ?? 0)) { (ex.members ??= {})[pid] = m; changed = true; }
    }
    for (const [pid, dl] of Object.entries((raw.delegations && typeof raw.delegations === "object") ? raw.delegations : {})) {
      const cur = ex.delegations?.[pid]; if (dl?.delegate && (!cur || (dl.at ?? 0) > (cur.at ?? 0))) { (ex.delegations ??= {})[pid] = dl; changed = true; }
    }
    for (const [iid, mp] of Object.entries((raw.topicDelegations && typeof raw.topicDelegations === "object") ? raw.topicDelegations : {})) {
      for (const [pid, dl] of Object.entries(mp || {})) { const cur = ex.topicDelegations?.[iid]?.[pid]; if (dl?.delegate && (!cur || (dl.at ?? 0) > (cur.at ?? 0))) { ex.topicDelegations ??= {}; (ex.topicDelegations[iid] ??= {})[pid] = dl; changed = true; } }
    }
    for (const i of Array.isArray(raw.issues) ? raw.issues : []) {
      const iid = String(i.id ?? ""); if (!iid) continue;
      const cur = (ex.issues ??= []).find((x) => x.id === iid);
      if (!cur) { ex.issues.push(i); changed = true; } else if (i.pollId && !cur.pollId) { cur.pollId = String(i.pollId); changed = true; }
    }
    if (typeof raw.treasury === "string" && !ex.treasury) { ex.treasury = raw.treasury; changed = true; }
    if (typeof raw.kudos === "string" && !ex.kudos) { ex.kudos = raw.kudos; changed = true; }
    return changed;
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
      case "note-series": { const senderAnchor = chains.get(from)?.anchor; if (ingestSeries(d, fromName, senderAnchor, true)) { persistSeries(); console.log(`[daemon] +terms-series "${d.seriesKey}"`); } break; }
      case "sync-series": { let n = 0; for (const e of d.entries || []) if (ingestSeries(e, fromName, undefined, false)) n++; if (n) { persistSeries(); console.log(`[daemon] +${n} terms-series via sync`); } break; }
      // Governance: persist + re-serve groups so they survive when every browser
      // leaves. Mutations are gated like the browser (admin by peerId; delegations
      // self-signed). The daemon stores state only — no tally/resolver.
      case "group-open": {
        const id = String(d.id ?? "");
        if (!id || groups.has(id) || retracted.has("group:" + id)) break;
        groups.set(id, { id, name: String(d.name ?? ""), creator: from, creatorLabel: String(d.creatorLabel ?? fromName), createdAt: typeof d.createdAt === "number" ? d.createdAt : 0, members: { [from]: { peerId: from, role: "admin", label: String(d.creatorLabel ?? fromName), at: 0 } }, delegations: {}, topicDelegations: {}, issues: [] });
        persistGroups(); console.log(`[daemon] +group "${groups.get(id).name}"`); break;
      }
      case "group-member": {
        const g = groups.get(String(d.groupId ?? "")); if (!g || !groupIsAdmin(g, from)) break;
        const pid = String(d.peerId ?? ""); if (!pid) break;
        if (d.remove === true) { delete g.members[pid]; if (g.delegations) delete g.delegations[pid]; }
        else g.members[pid] = { peerId: pid, role: d.role === "admin" ? "admin" : "member", label: String(d.label ?? pid.slice(0, 8)), at: 0 };
        persistGroups(); break;
      }
      case "group-meta": {
        const g = groups.get(String(d.groupId ?? "")); if (!g || !groupIsAdmin(g, from)) break;
        if (typeof d.treasury === "string") g.treasury = d.treasury;
        if (typeof d.kudos === "string") g.kudos = d.kudos;
        persistGroups(); break;
      }
      case "gov-delegate": {
        const g = groups.get(String(d.groupId ?? "")); const delegator = String(d.delegator ?? from);
        if (!g || from !== delegator || !g.members?.[delegator]) break;
        const delegate = d.delegate == null ? null : String(d.delegate);
        const iid = d.issueId ? String(d.issueId) : null;
        if (!(delegate === null || (g.members?.[delegate] && delegate !== delegator))) break;
        if (iid) { g.topicDelegations ??= {}; const m = (g.topicDelegations[iid] ??= {}); if (delegate === null) delete m[delegator]; else m[delegator] = { delegate, at: 0 }; if (Object.keys(m).length === 0) delete g.topicDelegations[iid]; }
        else if (delegate === null) delete g.delegations[delegator]; else g.delegations[delegator] = { delegate, at: 0 };
        persistGroups(); break;
      }
      case "group-issue": {
        const g = groups.get(String(d.groupId ?? "")); if (!g || !g.members?.[from]) break;
        const iss = d.issue; if (!iss || typeof iss !== "object" || !iss.title) break;
        const iid = String(iss.id ?? ""); if (!iid) break;
        if (!(g.issues ??= []).find((x) => x.id === iid)) { g.issues.push({ id: iid, title: String(iss.title), by: String(iss.by ?? fromName), at: typeof iss.at === "number" ? iss.at : 0, status: iss.status === "closed" ? "closed" : "open", pollId: iss.pollId ? String(iss.pollId) : undefined }); persistGroups(); }
        break;
      }
      case "group-vote": {
        const g = groups.get(String(d.groupId ?? "")); if (!g || !g.members?.[from]) break;
        const iss = (g.issues ?? []).find((x) => x.id === String(d.issueId ?? "")); if (iss) { iss.pollId = String(d.pollId ?? ""); iss.status = "open"; persistGroups(); } break;
      }
      case "sync-gov": { let n = 0; for (const raw of d.groups || []) if (mergeGroup(raw)) n++; if (n) { persistGroups(); console.log(`[daemon] +${n} group(s) via sync`); } break; }
      case "retract": {
        // Honor owner retractions so an always-on memory peer doesn't resurrect
        // what an author removed. Lemma: author by anchor. Group: creator by peerId.
        if (d.what === "lemma") {
          const name = canonLemma(d.id);
          const entry = lemmas.get(name);
          const senderAnchor = chains.get(from)?.anchor;
          if (!entry || !entry.dyncap?.anchor || !senderAnchor || entry.dyncap.anchor !== senderAnchor) break;
          lemmas.delete(name); retracted.add(name); persistLemmas(); persistRetracted();
          console.log(`[daemon] -lemma "${name}" retracted by author ${fromName}`);
        } else if (d.what === "group") {
          const id = String(d.id ?? ""); const g = groups.get(id);
          if (!g || from !== g.creator) break;            // only the creator disbands
          groups.delete(id); retracted.add("group:" + id); persistGroups(); persistRetracted();
          console.log(`[daemon] -group "${g.name}" disbanded by ${fromName}`);
        }
        break;
      }
    }
  }

  peer.connect();
  console.log(`[daemon] running as "${myName}". Ctrl-C to stop.`);

  const shutdown = () => {
    console.log("\n[daemon] shutting down…");
    try { saveIdentity(); persistLemmas(); persistCurrencies(); persistSeries(); persistGroups(); persistChains(); persistRetracted(); } catch {}
    try { peer.disconnect(); } catch {}
    setTimeout(() => process.exit(0), 250);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
