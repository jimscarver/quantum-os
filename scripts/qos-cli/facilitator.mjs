#!/usr/bin/env node
// QuantumOS group-facilitator daemon (v1, deterministic — no AI).
//
// A persistent peer that joins a room, watches presence + the message stream,
// and posts *measured* facilitation nudges — the runtime of Room_Best_Practices.
// It has NO special authority: it only posts `chat` (and could suggest polls);
// the group decides. Because it is a trust-weighted peer, the group can
// `/gov trust` it up or `/gov censure` it down — its disruption level is
// governed by the room, not hard-coded.
//
// v1 behaviours (all deterministic):
//   • Greet new members (once each, after a short grace).
//   • Prompt the nameless to set a name (/name), once each.
//   • Participation: solicit the "silent quarter"; gently rebalance a dominator
//     (Room_Best_Practices Rules 6 & 12 — even turn-taking, include the absent).
//   • Surface (dis)agreement from `state-discrepancy` broadcasts: name a
//     contested split, or offer to record a converged value.
//
// MEASURED DISRUPTION is the whole point: a global post budget per window, a
// minimum gap between posts, per-behaviour cooldowns, a fair-share check vs the
// humans, and "quiet by default — only speak on a clear signal".
//
// Reuses the qos-cli transport/identity exactly like qos-daemon.mjs.
// State (stable identity + who-we've-greeted) lives under --state.

import fs from "node:fs";
import path from "node:path";
import { QOSPeer } from "./qospeer.mjs";
import { generateCapability, validateCapability } from "./zfa.mjs";
import { newDynCapState, signEnvelope, serializeState, deserializeState } from "./dyncap.mjs";
import { makeAdvisor } from "./facilitator-advisor.mjs";

const DEFAULT_SIGNAL = "wss://quantum-os-signaling.onrender.com";
const SIGNED_KINDS = new Set(["name"]);

const USAGE = `qos facilitator — measured group-facilitation daemon

Usage:
  node facilitator.mjs --room <cap:room:… | room-URL> [options]

Options:
  --room <cap|url>   Room capability token or a quantum-os URL (#room=…). (required)
  --name <s>         Display name (default: "facilitator").
  --signal <url>     Signaling server (default: ${DEFAULT_SIGNAL}).
  --state <dir>      State directory (default: ./.qos-facilitator).
  --budget <n>       Max facilitator posts per 5-min window (default: 4).
  --silent-min <m>   Minutes of silence before soliciting a quiet member (default: 6).
  --quiet            Less assertive (halves budget, longer cooldowns).
  --active           More assertive (raises budget, shorter cooldowns).
  --ai               Enable the AI advisor (stimulate + disagreement-synthesis + /facil ask).
  --ai-backend <b>   api (default; needs ANTHROPIC_API_KEY, pay-as-you-go credits) or
                     claude-code (shells out to the local \`claude\` CLI = your Claude
                     subscription, no API credits — must be installed + logged in).
  --ai-model <m>     Model. api default: claude-haiku-4-5-20251001;
                     claude-code default: the CLI's configured model.
  --verbose          Log every inbound message + suppressed nudges.
  --help, -h         Show this help.

In a room, say \`/facil\` (or "anyone here?") and it replies — that's how you tell it's
present; \`/facil help\` lists commands, \`/facil off\` / \`/facil on\` mute/unmute.
It only posts chat nudges — it cannot force anything. Runs until Ctrl-C.`;

function parseArgs(argv) {
  const a = { name: "facilitator", signal: DEFAULT_SIGNAL, state: "./.qos-facilitator", verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--room") a.room = argv[++i];
    else if (x === "--name") a.name = argv[++i];
    else if (x === "--signal") a.signal = argv[++i];
    else if (x === "--state") a.state = argv[++i];
    else if (x === "--budget") a.budget = Number(argv[++i]);
    else if (x === "--silent-min") a.silentMin = Number(argv[++i]);
    else if (x === "--quiet") a.quiet = true;
    else if (x === "--active") a.active = true;
    else if (x === "--ai") a.ai = true;
    else if (x === "--ai-backend") a.aiBackend = argv[++i];
    else if (x === "--ai-model") a.aiModel = argv[++i];
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

const readJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } };
const writeJSON = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2)); };
const short = (id) => String(id ?? "").slice(0, 8);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.room) { console.log(USAGE); process.exit(args.help ? 0 : 1); }

  const roomId = extractRoomCap(args.room);
  if (!roomId || !roomId.startsWith("cap:room:")) { console.error("[facil] could not parse cap:room: from --room"); process.exit(1); }
  if (!validateCapability(roomId)) console.warn(`[facil] warning: room token failed ZFA validation (continuing): ${roomId}`);

  // ---- measured-disruption policy (tunable; --quiet / --active shift it) ----
  const scale = args.quiet ? 1.6 : args.active ? 0.6 : 1.0;     // cooldown multiplier
  const WINDOW_MS   = 5 * 60_000;
  const MAX_POSTS   = Math.max(1, Math.round((args.budget ?? (args.quiet ? 2 : args.active ? 6 : 4))));
  const MIN_GAP_MS  = Math.round(20_000 * scale);              // never two nudges back-to-back
  const SILENT_MS   = Math.max(60_000, Math.round((args.silentMin ?? 6) * 60_000));
  const GREET_DELAY_MS = 4_000;
  const ACTIVE_MS   = 4 * 60_000;                              // "room is active" if a human spoke this recently
  const DOMINATE_FRAC = 0.6, DOMINATE_MIN = 6;                // one voice > 60% of ≥6 recent msgs (≥3 speakers)
  const CD = { greet: 0, name: 0, silent: Math.round(10 * 60_000 * scale), dominate: Math.round(8 * 60_000 * scale), discrepancy: Math.round(5 * 60_000 * scale), stimulate: Math.round(12 * 60_000 * scale), synthesize: Math.round(9 * 60_000 * scale) };
  const TICK_MS = 30_000;
  const LULL_MS = Math.round(2 * 60_000 * scale);        // silence after activity before an AI stimulate
  const CHAT_RETAIN_MS = 15 * 60_000;                    // how long chat text/timestamps are kept for context
  const advisor = makeAdvisor({ ai: args.ai, backend: args.aiBackend, model: args.aiModel, log: console.log });

  // ---- identity (stable across restarts), mirroring qos-daemon.mjs ----
  const stateDir = args.state;
  const roomHex = roomId.replace(/^cap:room:/, "");
  const identityPath = path.join(stateDir, "identity.json");
  const peersPath = path.join(stateDir, "rooms", roomHex, "peers.json"); // who we've greeted / name-prompted
  let identity = readJSON(identityPath, null);
  let dyncapState;
  if (identity?.peerId && identity?.dyncap) dyncapState = await deserializeState(JSON.stringify(identity.dyncap));
  if (!identity?.peerId || !dyncapState) {
    identity = { peerId: generateCapability("peer"), name: args.name, dyncap: null };
    dyncapState = await newDynCapState();
    identity.dyncap = JSON.parse(serializeState(dyncapState));
    writeJSON(identityPath, identity);
    console.log(`[facil] new identity ${identity.peerId.slice(0, 18)}…`);
  } else console.log(`[facil] loaded identity ${identity.peerId.slice(0, 18)}…`);
  const myName = (args.name && args.name !== "facilitator") ? args.name : (identity.name || "facilitator");
  identity.name = myName;
  const saveIdentity = () => { identity.dyncap = JSON.parse(serializeState(dyncapState)); writeJSON(identityPath, identity); };

  // known[peerId] = { firstSeen, greeted, namePrompted } — persisted so we don't re-greet across restarts.
  const known = readJSON(peersPath, {});
  const saveKnown = () => writeJSON(peersPath, known);

  // ---- live room model (in-memory) ----
  const peerNames = new Map();     // peerId -> name (from `name` envelopes)
  const present = new Set();       // peerIds with an open channel
  const spokeAt = new Map();       // peerId -> last time they sent chat
  const joinedAt = new Map();      // peerId -> channel-open time
  const chatLog = [];              // {peer, at} for human chats (rolling window, for share/active checks)
  const recentMsgs = [];           // {name, text, at} for AI context (rolling)
  const nameOf = (id) => peerNames.get(id) ?? known[id]?.name ?? short(id);

  // ---- measured-disruption gate ----
  const postLog = [];              // timestamps of our own posts
  const cooldown = new Map();      // behaviour-key -> last fire time
  let lastPostAt = 0;
  let muted = false;               // /facil off → suppress nudges (replies still work)
  const withinBudget = () => { const now = Date.now(); while (postLog.length && now - postLog[0] > WINDOW_MS) postLog.shift(); return postLog.length < MAX_POSTS; };
  const cooled = (key, ms) => Date.now() - (cooldown.get(key) ?? 0) >= ms;
  function recentHumanCount(ms = ACTIVE_MS) { const now = Date.now(); while (chatLog.length && now - chatLog[0].at > CHAT_RETAIN_MS) chatLog.shift(); while (recentMsgs.length && now - recentMsgs[0].at > CHAT_RETAIN_MS) recentMsgs.shift(); return chatLog.filter((c) => now - c.at <= ms).length; }
  function wouldPost(key, ms) { const now = Date.now(); if (now - lastPostAt < MIN_GAP_MS) return false; if (!withinBudget()) return false; if (key && !cooled(key, ms)) return false; if (overFairShare()) return false; return true; }
  function buildCtx() { const now = Date.now(); const silent = [...present].filter((id) => id !== identity.peerId && (now - (spokeAt.get(id) ?? 0)) > LULL_MS).map(nameOf); return { transcript: recentMsgs.slice(-20).map((m) => ({ name: m.name, text: m.text })), silent }; }
  function substantiveChat() { const now = Date.now(); const recent = chatLog.filter((c) => now - c.at <= ACTIVE_MS); return recent.length >= 4 && new Set(recent.map((c) => c.peer)).size >= 2; }
  // fair-share: in an ACTIVE conversation, don't let the facilitator out-talk the humans.
  function overFairShare() { const humans = recentHumanCount(); if (humans < 4) return false; const now = Date.now(); const mine = postLog.filter((t) => now - t <= ACTIVE_MS).length; return mine >= Math.ceil(humans * 0.34); }

  function say(text, key, cooldownMs = 0) {
    if (muted) { if (args.verbose) console.log(`[facil] · held (muted): ${text}`); return false; }
    const now = Date.now();
    if (now - lastPostAt < MIN_GAP_MS) { if (args.verbose) console.log(`[facil] · held (min-gap): ${text}`); return false; }
    if (!withinBudget())             { if (args.verbose) console.log(`[facil] · held (budget): ${text}`); return false; }
    if (key && !cooled(key, cooldownMs)) return false;
    if (overFairShare())             { if (args.verbose) console.log(`[facil] · held (fair-share): ${text}`); return false; }
    peer.broadcast({ kind: "chat", text });
    postLog.push(now); lastPostAt = now; if (key) cooldown.set(key, now);
    console.log(`[facil] → ${text}`);
    return true;
  }

  // Direct replies to a user's query/command. Unlike nudges, these *answer a
  // request*, so they bypass the budget/min-gap/fair-share gate (rate-limited only
  // by a per-command cooldown) and work even when muted — so you can always tell
  // the facilitator is there.
  function reply(text, key, cooldownMs = 30_000) {
    if (key && !cooled(key, cooldownMs)) return false;
    peer.broadcast({ kind: "chat", text });
    postLog.push(Date.now()); lastPostAt = Date.now(); if (key) cooldown.set(key, Date.now());
    console.log(`[facil] ↩ ${text}`);
    return true;
  }
  const helpText = () => `I'm ${myName}, a light-touch facilitator — I mostly stay quiet and only nudge to keep everyone included and decisions clear. Commands: \`/facil\` (am I here?) · \`/facil help\` · \`/facil ask <question>\`${advisor.enabled ? "" : " (needs --ai)"} · \`/facil off\` / \`/facil on\` (mute/unmute). \`/gov censure\` me if I'm noisy.`;
  async function handleAsk(q) {
    if (!q) { reply(`Ask me anything about the room, facilitation, or decisions — \`/facil ask <question>\`.`, "askhelp", 12_000); return; }
    if (!advisor.enabled) { reply(`I'd need AI mode for that — start me with \`--ai\` (\`--ai-backend claude-code\` to use a Claude subscription, or set \`ANTHROPIC_API_KEY\`). For now, \`/facil help\` lists what I do.`, "asknoai", 20_000); return; }
    if (!cooled("ask", 6_000)) return;                     // anti-flood before the API call
    cooldown.set("ask", Date.now());
    const text = await advisor.advise("ask", { question: q, transcript: recentMsgs.slice(-12).map((mm) => ({ name: mm.name, text: mm.text })) });
    reply(text || `Hmm, I don't have a good answer to that one. \`/facil help\` for what I can do.`, null, 0);
  }
  const statusText = () => `👋 Yes, I'm here${muted ? " — currently muted (\`/facil on\` to wake me)" : ""}. \`/facil help\` for what I do.`;
  function handleCommand(text) {
    const raw = String(text ?? "").trim();
    const lc = raw.toLowerCase();
    const m = /^\/facil(?:itator)?\b\s*(\w+)?/.exec(lc);
    if (m) {
      const sub = m[1] ?? "";
      if (sub === "off" || sub === "mute" || sub === "quiet") { muted = true; reply(`Muted — I'll stay quiet. Say \`/facil on\` to bring me back.`, "facmute", 0); return true; }
      if (sub === "on" || sub === "unmute" || sub === "wake") { muted = false; reply(`Back on 👋 — \`/facil help\` for what I do.`, "facmute", 0); return true; }
      if (sub === "status" || sub === "here" || sub === "ping") { reply(statusText(), "facstatus", 20_000); return true; }
      if (sub === "ask") { handleAsk(raw.replace(/^\/facil(?:itator)?\s+ask\b\s*/i, "").trim()); return true; }
      reply(helpText(), "fachelp", 25_000); return true;   // `/facil` or `/facil help`
    }
    // natural presence query, e.g. "anyone here?" / "is the facilitator around?"
    if (/^facil(?:itator)?\??$/.test(lc) || /\b(any\s?(one|body)|facil(?:itator)?)\b[^?]*\b(here|there|around|online|present|listening)\b\??/.test(lc)) { reply(statusText(), "facstatus", 20_000); return true; }
    // a bare greeting → a measured, rate-limited hello (so newcomers learn it's here)
    if (/^(hi|hello|hey|hiya|yo|howdy|gm|good\s+(morning|afternoon|evening))[\s!,.]*(all|everyone|folks|there|y'?all)?[\s!,.]*$/.test(lc)) { reply(`👋 Hi! I'm ${myName}, the room facilitator — \`/facil help\` for what I do.`, "facgreet", Math.round(4 * 60_000 * scale)); return true; }
    return false;
  }

  const peer = new QOSPeer({
    signalingUrl: args.signal, roomId, peerId: identity.peerId,
    onSignalingOpen: () => console.log("[facil] signaling connected; joined room"),
    onSignalingClose: () => console.warn("[facil] signaling dropped — reconnecting"),
    onPeerJoined: (id) => { if (args.verbose) console.log(`[facil] ${short(id)}… joining`); },
    onPeerLeft: (id) => { present.delete(id); },
    onError: (e) => console.error("[facil]", e?.message ?? e),
    onChannelOpen: (id) => onChannelOpen(id),
    onMessage: (from, d) => onMessage(from, d),
  });

  let signQueue = Promise.resolve();
  function signedSend(target, env) {
    signQueue = signQueue.then(async () => {
      const out = { ...env };
      if (SIGNED_KINDS.has(env.kind)) { try { out.dyncap = await signEnvelope(dyncapState, roomId, env); saveIdentity(); } catch (e) { console.error("[facil] sign failed:", e?.message ?? e); } }
      peer.send(target, out);
    }).catch((e) => console.error("[facil] send error:", e?.message ?? e));
    return signQueue;
  }

  function onChannelOpen(id) {
    if (id === identity.peerId) return;
    present.add(id);
    joinedAt.set(id, Date.now());
    signedSend(id, { kind: "name", name: myName });
    // one-time room intro when the first peer arrives this run
    if (!onChannelOpen._introduced) {
      onChannelOpen._introduced = true;
      setTimeout(() => say(`Hi — I'm ${myName}, a light-touch facilitator for this room. I'll mostly stay quiet and only nudge to keep everyone included and decisions clear. \`/gov censure\` me if I'm noisy.`), GREET_DELAY_MS);  // once-only via _introduced
    }
    // greet newcomers we haven't greeted before (after a grace, if still here)
    const rec = (known[id] ??= { firstSeen: Date.now() });
    if (!rec.greeted) scheduleGreet(id, 0);
  }

  // Greet, re-queuing if the measured-disruption gate held it (so a newcomer
  // whose welcome collides with another post still gets greeted once the gap
  // clears) — bounded, and abandoned if they leave or get greeted meanwhile.
  const GREET_RETRIES = 4;
  function scheduleGreet(id, attempt) {
    const delay = attempt === 0 ? GREET_DELAY_MS + 1500 : MIN_GAP_MS + 2000;
    setTimeout(() => {
      const rec = known[id];
      if (!rec || rec.greeted || !present.has(id)) return;
      if (say(`👋 Welcome, ${nameOf(id)}! Jump in any time — what brings you here?`, `greet:${id}`, CD.greet)) { rec.greeted = Date.now(); saveKnown(); }
      else if (attempt < GREET_RETRIES) scheduleGreet(id, attempt + 1);
    }, delay);
  }

  function maybeNamePrompt(id) {
    const rec = (known[id] ??= { firstSeen: Date.now() });
    if (rec.namePrompted || peerNames.has(id)) return;     // already named or already asked
    if (say(`(psst ${short(id)}… — set a name with \`/name\` so everyone knows who's talking 🙂)`, `name:${id}`, CD.name)) { rec.namePrompted = Date.now(); saveKnown(); }
  }

  function onMessage(from, d) {
    if (from === identity.peerId || !d || typeof d !== "object") return;
    if (args.verbose) console.log(`[facil] ⇐ ${short(from)}… ${JSON.stringify(d).slice(0, 160)}`);
    switch (d.kind) {
      case "name":
        if (typeof d.name === "string") { peerNames.set(from, d.name); const r = (known[from] ??= { firstSeen: Date.now() }); r.name = d.name; saveKnown(); }
        break;
      case "chat": {
        spokeAt.set(from, Date.now());
        chatLog.push({ peer: from, at: Date.now() });
        recentMsgs.push({ name: nameOf(from), text: String(d.text ?? "").slice(0, 280), at: Date.now() });
        if (args.verbose) console.log(`[${nameOf(from)}] ${String(d.text).slice(0, 120)}`);
        if (handleCommand(d.text)) break;     // answered a /facil command or a greeting/presence query
        // nameless speaker → gentle one-time name prompt
        if (!peerNames.has(from)) setTimeout(() => maybeNamePrompt(from), 2_000);
        // dominator: one voice taking the room
        checkDominator();
        break;
      }
      case "state-discrepancy": surfaceDiscrepancy(d); break;
    }
  }

  // (Dis)agreement surfacing from the consensus probe (app.ts / Consensus.md).
  // When the AI advisor is on and a post is allowed, try a synthesis of the real
  // positions first; otherwise fall back to the deterministic line.
  async function surfaceDiscrepancy(d) {
    const key = `disc:${d.storeName}:${d.key}`;
    const label = d.key ?? d.storeName ?? "that";
    if (d.winner == null) {
      if (advisor.enabled && wouldPost(key, CD.discrepancy)) {
        const text = await advisor.advise("synthesize", buildCtx());
        if (text && say(text, key, CD.discrepancy)) return;
      }
      say(`We don't have consensus on **${label}** yet — want to deliberate it, or defer and record it as unresolved?`, key, CD.discrepancy);
    } else say(`Looks like we've converged on **${label}**. Want me to flag it so someone can record the decision (\`/lemma\`)?`, key, CD.discrepancy);
  }

  function checkDominator() {
    const now = Date.now();
    const recent = chatLog.filter((c) => now - c.at <= ACTIVE_MS);
    if (recent.length < DOMINATE_MIN) return;
    const by = new Map();
    for (const c of recent) by.set(c.peer, (by.get(c.peer) ?? 0) + 1);
    if (by.size < 3) return;                                  // need a real group
    let top = null, topN = 0;
    for (const [p, n] of by) if (n > topN) { top = p; topN = n; }
    if (topN / recent.length > DOMINATE_FRAC) say(`Lots of good thinking from ${nameOf(top)} — let's make space for other voices too. What do the rest of you make of it?`, "dominate", CD.dominate);
  }

  // Periodic facilitation. AI calls happen ONLY when a post would be allowed
  // (gated by the same budget/cooldowns), so usage stays bounded.
  async function tick() {
    const humans = recentHumanCount();
    if (advisor.enabled) {
      const now = Date.now();
      const lastHuman = chatLog.length ? chatLog[chatLog.length - 1].at : 0;
      // disagreement → agreement: name the crux + a path forward
      if (substantiveChat() && wouldPost("synthesize", CD.synthesize)) {
        const text = await advisor.advise("synthesize", buildCtx());
        if (text) say(text, "synthesize", CD.synthesize);
      }
      // stimulate after a lull that followed real activity (subsumes the v1 silent nudge)
      if (lastHuman && now - lastHuman > LULL_MS && recentHumanCount(10 * 60_000) >= 3 && wouldPost("stimulate", CD.stimulate)) {
        const text = await advisor.advise("stimulate", buildCtx());
        if (text) say(text, "stimulate", CD.stimulate);
      }
      return;
    }
    // v1 deterministic silent-quarter
    if (humans < 2) return;
    const now = Date.now();
    const quiet = [...present].filter((id) => id !== identity.peerId && (now - (joinedAt.get(id) ?? now)) > SILENT_MS && (now - (spokeAt.get(id) ?? 0)) > SILENT_MS);
    if (!quiet.length) return;
    const names = quiet.slice(0, 2).map(nameOf).join(", ");
    say(`We haven't heard from everyone — ${names}, curious what you're thinking on this?`, "silent", CD.silent);
  }
  const timer = setInterval(() => tick().catch((e) => console.error("[facil] tick:", e?.message ?? e)), TICK_MS);

  peer.connect();
  console.log(`[facil] running as "${myName}"  budget=${MAX_POSTS}/5min  min-gap=${Math.round(MIN_GAP_MS / 1000)}s  silent=${Math.round(SILENT_MS / 60000)}min  AI=${advisor.enabled ? advisor.model : "off"}. Ctrl-C to stop.`);

  const shutdown = () => { console.log("\n[facil] shutting down…"); try { clearInterval(timer); saveIdentity(); saveKnown(); } catch {} try { peer.disconnect(); } catch {} setTimeout(() => process.exit(0), 200); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
