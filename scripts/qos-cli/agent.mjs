#!/usr/bin/env node
// QuantumOS room-agent daemon — a generalized, trust-governable member.
//
// A persistent peer that joins a room as a FULL MEMBER (stable cap:peer + dyncap
// identity), watches presence + the message stream, and posts *measured* nudges
// according to its --role. The facilitator is one role; `scribe` and `greeter`
// show the generality. It has NO special authority: it only posts `chat`; the
// group decides. Because it is an ordinary trust-weighted peer, the room can
// `/gov trust` it up or `/gov censure` it down (full trust integration: see PR B).
//
// MULTIPLE AGENTS IN ONE ROOM: agents tag their `name` envelope with their role,
// so they recognize each other and (a) elect a single LEAD for each shared
// proactive duty — only the lowest-peerId agent that performs a duty acts, so N
// agents don't all greet — and (b) count their posts COLLECTIVELY against the
// human fair-share, so adding agents can't inflate the budget.
//
// MEASURED DISRUPTION is the whole point: a global post budget per window, a
// minimum gap between posts, per-behaviour cooldowns, a collective fair-share vs
// the humans, and "quiet by default — only speak on a clear signal".
//
// Reuses the qos-cli transport/identity exactly like qos-daemon.mjs.
// State (stable identity + who-we've-greeted) lives under --state.

import fs from "node:fs";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { QOSPeer } from "./qospeer.mjs";
import { generateCapability, validateCapability } from "./zfa.mjs";
import { newDynCapState, signEnvelope, serializeState, deserializeState } from "./dyncap.mjs";
import { makeAdvisor } from "./facilitator-advisor.mjs";
import { ROLES, DEFAULT_ROLE, resolveRole, dutiesOf } from "./agent-roles.mjs";
import { trustLevels, discreditedMembers, isMember, groupHasRatings, normalizeGroup, TRUST_MAX } from "./gov.mjs";

const DEFAULT_SIGNAL = "wss://quantum-os-signaling.onrender.com";
const SIGNED_KINDS = new Set(["name"]);

const USAGE = `qos agent — measured, trust-governable room-agent daemon

Usage:
  node agent.mjs --room <cap:room:… | room-URL> [--role facilitator] [options]

Options:
  --room <cap|url>   Room capability token or a quantum-os URL (#room=…). (required)
  --role <r>         Agent role: ${Object.keys(ROLES).join(", ")} (default: ${DEFAULT_ROLE}).
  --name <s>         Display name (default: the role name).
  --signal <url>     Signaling server (default: ${DEFAULT_SIGNAL}).
  --state <dir>      State directory (default: ./.qos-agent).
  --budget <n>       Max posts per 5-min window (default: 4).
  --silent-min <m>   Minutes of silence before soliciting a quiet member (default: 6).
  --quiet            Less assertive (halves budget, longer cooldowns).
  --active           More assertive (raises budget, shorter cooldowns).
  --ai               Enable the AI advisor (stimulate + disagreement-synthesis + ask).
  --ai-backend <b>   api (default; needs ANTHROPIC_API_KEY, pay-as-you-go credits) or
                     claude-code (shells out to the local \`claude\` CLI = your Claude
                     subscription, no API credits — must be installed + logged in).
  --about <url>      Link to the room's about page, shown in intro/help
                     (default: the QuantumOS MyRoom page).
  --ai-model <m>     Model. api default: claude-haiku-4-5-20251001;
                     claude-code default: the CLI's configured model.
  --verbose          Log every inbound message + suppressed nudges.
  --help, -h         Show this help.

Run several with different --role (and distinct --state dirs) in one room; they
de-conflict shared duties automatically. Say \`/<role>\` (e.g. \`/facil\`, \`/scribe\`)
or "anyone here?" and the agent replies. It is a full trust-weighted member: the room
governs its voice via \`/gov trust\` / \`/gov censure\` (it posts up to its trust level
per window, one rung below a same-rated human; \`/<role> trust\` shows its standing).
Runs until Ctrl-C.`;

export function parseArgs(argv) {
  const a = { signal: DEFAULT_SIGNAL, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--room") a.room = argv[++i];
    else if (x === "--role") a.role = argv[++i];
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
    else if (x === "--about") a.about = argv[++i];
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
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function run(args) {
  if (args.help || !args.room) { console.log(USAGE); if (typeof process !== "undefined") process.exit(args.help ? 0 : 1); return; }

  const roleKey = (args.role ?? DEFAULT_ROLE).toLowerCase();
  const role = resolveRole(roleKey);
  if (!role) { console.error(`[agent] unknown --role "${args.role}". Known: ${Object.keys(ROLES).join(", ")}`); process.exit(1); return; }
  const CMD = role.cmd;                                   // command prefix, e.g. "facil"
  const ABOUT_URL = args.about ?? "https://github.com/jimscarver/quantum-os/blob/main/MyRoom.md";
  const TAG = `[${CMD}]`;                                 // log tag
  const aliases = [...new Set([CMD, role.name])];         // command spellings, e.g. facil|facilitator
  const aliasAlt = aliases.map(escapeRe).join("|");
  const cmdRe = new RegExp(`^/(?:${aliasAlt})\\b\\s*(\\w+)?`, "i");
  const askStripRe = new RegExp(`^/(?:${aliasAlt})\\s+ask\\b\\s*`, "i");
  const optStripRe = new RegExp(`^/(?:${aliasAlt})\\s+(?:optimize|opt)\\b\\s*`, "i");
  const bareNameRe = new RegExp(`^(?:${aliasAlt})\\??$`, "i");
  const anyoneHereRe = new RegExp(`\\b(any\\s?(one|body)|${aliasAlt})\\b[^?]*\\b(here|there|around|online|present|listening)\\b\\??`, "i");
  const greetingRe = /^(hi|hello|hey|hiya|yo|howdy|gm|good\s+(morning|afternoon|evening))[\s!,.]*(all|everyone|folks|there|y'?all)?[\s!,.]*$/;

  const roomId = extractRoomCap(args.room);
  if (!roomId || !roomId.startsWith("cap:room:")) { console.error(`${TAG} could not parse cap:room: from --room`); process.exit(1); return; }
  if (!validateCapability(roomId)) console.warn(`${TAG} warning: room token failed ZFA validation (continuing): ${roomId}`);

  // ---- measured-disruption policy (tunable; --quiet / --active shift it) ----
  const scale = args.quiet ? 1.6 : args.active ? 0.6 : 1.0;     // cooldown multiplier
  const WINDOW_MS   = 5 * 60_000;
  const MAX_POSTS   = Math.max(1, Math.round((args.budget ?? (args.quiet ? 2 : args.active ? 6 : 4))));
  const MIN_GAP_MS  = Math.round(20_000 * scale);
  const SILENT_MS   = Math.max(60_000, Math.round((args.silentMin ?? 6) * 60_000));
  const GREET_DELAY_MS = 4_000;
  const ACTIVE_MS   = 4 * 60_000;
  const DOMINATE_FRAC = 0.6, DOMINATE_MIN = 6;
  const CD = { greet: 0, name: 0, silent: Math.round(10 * 60_000 * scale), dominate: Math.round(8 * 60_000 * scale), discrepancy: Math.round(5 * 60_000 * scale), stimulate: Math.round(12 * 60_000 * scale), synthesize: Math.round(9 * 60_000 * scale) };
  const TICK_MS = 30_000;
  const LULL_MS = Math.round(2 * 60_000 * scale);
  const CHAT_RETAIN_MS = 15 * 60_000;
  const advisor = makeAdvisor({ ai: args.ai, backend: args.aiBackend, model: args.aiModel, persona: role.persona, roleName: role.name, cmd: CMD, log: console.log });

  // ---- identity (stable across restarts), mirroring qos-daemon.mjs ----
  const stateDir = args.state ?? "./.qos-agent";
  const roomHex = roomId.replace(/^cap:room:/, "");
  const identityPath = path.join(stateDir, "identity.json");
  const peersPath = path.join(stateDir, "rooms", roomHex, "peers.json");
  let identity = readJSON(identityPath, null);
  let dyncapState;
  if (identity?.peerId && identity?.dyncap) dyncapState = await deserializeState(JSON.stringify(identity.dyncap));
  if (!identity?.peerId || !dyncapState) {
    identity = { peerId: generateCapability("peer"), name: args.name ?? role.name, dyncap: null };
    dyncapState = await newDynCapState();
    identity.dyncap = JSON.parse(serializeState(dyncapState));
    writeJSON(identityPath, identity);
    console.log(`${TAG} new identity ${identity.peerId.slice(0, 18)}…`);
  } else console.log(`${TAG} loaded identity ${identity.peerId.slice(0, 18)}…`);
  const myName = args.name ?? identity.name ?? role.name;
  identity.name = myName;
  const saveIdentity = () => { identity.dyncap = JSON.parse(serializeState(dyncapState)); writeJSON(identityPath, identity); };

  const known = readJSON(peersPath, {});
  const saveKnown = () => writeJSON(peersPath, known);

  // ---- live room model (in-memory) ----
  const peerNames = new Map();     // peerId -> name
  const agents = new Map();        // peerId -> roleKey (other agents that announced themselves)
  const introduced = new Set();    // human peerIds we've self-introduced to this run (re-intro on reconnect)
  const present = new Set();       // peerIds with an open channel
  const spokeAt = new Map();
  const joinedAt = new Map();
  const chatLog = [];              // {peer, at} for all chats (rolling)
  const recentMsgs = [];           // {name, text, at} for AI context (rolling)
  const realName = (n) => (typeof n === "string" && n.trim()) ? n.trim() : null;   // "" / blank ⇒ no name
  const nameOf = (id) => realName(peerNames.get(id)) ?? realName(known[id]?.name) ?? short(id);
  const hasName = (id) => !!(realName(peerNames.get(id)) ?? realName(known[id]?.name));

  // ---- trust-governed membership (PR B) ----
  // The agent is an ordinary trust-weighted member: the room governs its voice via
  // the SAME liquid-trust primitives as humans. It ingests gov envelopes, computes
  // its own standing, and applies Jim's rule — operate at ONE LEVEL BELOW its actual
  // rating, at full power for that capped level. Concretely a rated agent posts up to
  // `min(configured budget, trustLevel)` per window (= a same-rated human's weight
  // 1+level, minus the one-level dock), 0 if censure-discredited (stand down). With no
  // ratings in its groups it runs at the configured budget (back-compat). Ingesting
  // unverified gov envelopes only ever throttles the agent's OWN voice (never exceeds
  // the operator's --budget ceiling), and the ⅔ censure quorum blocks lone griefers.
  const groups = new Map();    // groupId -> Group model (from gov envelopes / sync-gov)
  let standing = { governed: false, budget: MAX_POSTS, level: null, discredited: false };
  function computeStanding() {
    let governed = false, level = null, discredited = false;
    for (const g of groups.values()) {
      if (!isMember(g, identity.peerId) || !groupHasRatings(g)) continue;
      governed = true;
      const lv = trustLevels(g)[identity.peerId] ?? 0;
      if (level === null || lv > level) level = lv;
      if (discreditedMembers(g).includes(identity.peerId)) discredited = true;
    }
    if (!governed) return { governed: false, budget: MAX_POSTS, level: null, discredited: false };
    const lv = level ?? 0;
    const budget = discredited ? 0 : Math.min(MAX_POSTS, lv);   // 1+effectiveLevel = lv; 0 ⇒ stand down
    return { governed: true, budget, level: lv, discredited };
  }
  function updateStanding() {
    const prev = standing;
    standing = computeStanding();
    if (prev.budget === standing.budget && prev.governed === standing.governed) return;
    console.log(`${TAG} standing: governed=${standing.governed} level=${standing.level ?? "-"} budget=${standing.budget}/5min${standing.discredited ? " (discredited)" : ""}`);
    if (prev.budget === 0 && standing.budget > 0) reply(`Thanks — I'm cleared to take part again (trust level ${standing.level}).`, "govstanding", 30_000);
    else if (prev.budget > 0 && standing.budget === 0) reply(standing.discredited ? `Understood — I've been censured, so I'll stand down (direct replies only). \`/gov trust\` me to restore.` : `I'm not vouched here yet, so I'll stay quiet until an admin \`/gov trust\`s me.`, "govstanding", 30_000);
  }
  function standingText() {
    if (!standing.governed) return `I'm not under room trust yet — running at my configured budget (${MAX_POSTS}/5min). An admin can \`/gov member add ${identity.peerId}\` then \`/gov trust\` me.`;
    if (standing.discredited) return `I've been censured here, so I've stood down (trust 0). \`/gov trust\` me to restore my voice.`;
    return `Room trust level ${standing.level} → I post up to ${standing.budget}/5min — one rung below a same-rated member (\`/gov trust\`/\`/gov censure\` to adjust).`;
  }

  // ---- multi-agent: which duties a peer's role performs; lead election ----
  const isAgentPeer = (id) => id === identity.peerId || agents.has(id);
  function dutiesForPeer(id) {
    if (id === identity.peerId) return role.duties;
    const rk = agents.get(id);
    return rk ? dutiesOf(rk) : null;       // null ⇒ not a known agent
  }
  // Among present agents that perform `duty` (incl. self), the lowest peerId leads.
  // `sameRoleOnly`: compete only with agents of MY role — used for self-introduction,
  // where a facilitator and a scribe should EACH announce themselves (different
  // content), but two facilitators should not double-announce.
  function isLead(duty, sameRoleOnly = false) {
    if (!role.duties[duty]) return false;
    const cands = [identity.peerId];
    for (const id of present) {
      if (id === identity.peerId) continue;
      const rk = agents.get(id);
      if (!rk) continue;                                  // not a known agent
      if (sameRoleOnly && rk !== roleKey) continue;       // only same-role peers compete
      if (dutiesOf(rk)[duty]) cands.push(id);
    }
    cands.sort();
    return cands[0] === identity.peerId;
  }
  const leadGate = (duty, sameRoleOnly = false) => role.duties[duty] && isLead(duty, sameRoleOnly);

  // ---- measured-disruption gate ----
  const postLog = [];
  const cooldown = new Map();
  let lastPostAt = 0;
  let muted = false;               // /<cmd> off → suppress nudges (replies still work)
  const withinBudget = () => { const now = Date.now(); while (postLog.length && now - postLog[0] > WINDOW_MS) postLog.shift(); return postLog.length < standing.budget; };
  const cooled = (key, ms) => Date.now() - (cooldown.get(key) ?? 0) >= ms;
  function purgeRolling() { const now = Date.now(); while (chatLog.length && now - chatLog[0].at > CHAT_RETAIN_MS) chatLog.shift(); while (recentMsgs.length && now - recentMsgs[0].at > CHAT_RETAIN_MS) recentMsgs.shift(); }
  function recentHumanCount(ms = ACTIVE_MS) { purgeRolling(); const now = Date.now(); return chatLog.filter((c) => now - c.at <= ms && !isAgentPeer(c.peer)).length; }
  // Collective agent footprint: my own recent posts + other agents' recent chats.
  function recentAgentPosts(ms = ACTIVE_MS) { const now = Date.now(); const mine = postLog.filter((t) => now - t <= ms).length; const others = chatLog.filter((c) => now - c.at <= ms && c.peer !== identity.peerId && agents.has(c.peer)).length; return mine + others; }
  function overFairShare() { const humans = recentHumanCount(); if (humans < 4) return false; return recentAgentPosts() >= Math.ceil(humans * 0.34); }
  function wouldPost(key, ms) { const now = Date.now(); if (now - lastPostAt < MIN_GAP_MS) return false; if (!withinBudget()) return false; if (key && !cooled(key, ms)) return false; if (overFairShare()) return false; return true; }
  function buildCtx() { const now = Date.now(); const silent = [...present].filter((id) => !isAgentPeer(id) && (now - (spokeAt.get(id) ?? 0)) > LULL_MS).map(nameOf); return { transcript: recentMsgs.slice(-20).map((m) => ({ name: m.name, text: m.text })), silent }; }
  function substantiveChat() { const now = Date.now(); const recent = chatLog.filter((c) => now - c.at <= ACTIVE_MS && !isAgentPeer(c.peer)); return recent.length >= 4 && new Set(recent.map((c) => c.peer)).size >= 2; }

  function say(text, key, cooldownMs = 0) {
    if (muted) { if (args.verbose) console.log(`${TAG} · held (muted): ${text}`); return false; }
    if (standing.budget === 0) { if (args.verbose) console.log(`${TAG} · held (trust stand-down): ${text}`); return false; }
    const now = Date.now();
    if (now - lastPostAt < MIN_GAP_MS) { if (args.verbose) console.log(`${TAG} · held (min-gap): ${text}`); return false; }
    if (!withinBudget())             { if (args.verbose) console.log(`${TAG} · held (budget): ${text}`); return false; }
    if (key && !cooled(key, cooldownMs)) return false;
    if (overFairShare())             { if (args.verbose) console.log(`${TAG} · held (fair-share): ${text}`); return false; }
    peer.broadcast({ kind: "chat", text });
    postLog.push(now); lastPostAt = now; if (key) cooldown.set(key, now);
    console.log(`${TAG} → ${text}`);
    return true;
  }

  // Direct replies to a user's query/command: bypass budget/min-gap/fair-share
  // (rate-limited only by a per-command cooldown) and work even when muted.
  function reply(text, key, cooldownMs = 30_000) {
    if (key && !cooled(key, cooldownMs)) return false;
    peer.broadcast({ kind: "chat", text });
    postLog.push(Date.now()); lastPostAt = Date.now(); if (key) cooldown.set(key, Date.now());
    console.log(`${TAG} ↩ ${text}`);
    return true;
  }

  const askHint = advisor.enabled ? "" : " (needs --ai)";
  const helpText = () => `I'm ${myName}, ${role.blurb} Commands: \`/${CMD}\` (am I here?) · \`/${CMD} help\` · \`/${CMD} ask <question>\`${askHint} · \`/${CMD} optimize <problem>\`${askHint} (facilitate an annealing-style optimization round) · \`/${CMD} trust\` (my standing) · \`/${CMD} off\` / \`/${CMD} on\` (mute/unmute). I'm a full member — \`/gov trust\` me up or \`/gov censure\` me down. About this room (and how to make your own): ${ABOUT_URL}`;
  const statusText = () => `👋 Yes, I'm here — ${myName} (${role.name})${muted ? ` — currently muted (\`/${CMD} on\` to wake me)` : ""}.${standing.governed ? ` Trust ${standing.level}${standing.discredited ? " — stood down" : ` (≤${standing.budget}/5min)`}.` : ""} \`/${CMD} help\` · \`/${CMD} trust\`.`;
  const introText = () => `Hi — I'm ${myName}, ${role.blurb} Say \`/${CMD}\` or \`/${CMD} help\` to reach me${advisor.enabled ? `, or \`/${CMD} ask <q>\` to ask me anything` : ""}. I'm a full room member — \`/gov trust\`/\`/gov censure\` me; \`/${CMD} trust\` shows my standing. About this room: ${ABOUT_URL}`;
  // Self-introduce to a newly-identified human peer, once per peer per run (direct
  // message, so existing members aren't re-pinged each time someone joins).
  function introduceTo(id) {
    if (!role.duties.intro || muted || standing.budget === 0) return;
    if (isAgentPeer(id) || introduced.has(id) || !present.has(id)) return;
    if (!leadGate("intro", true)) { introduced.add(id); return; }   // a co-role agent leads
    if (peer.send(id, { kind: "chat", text: introText() })) { introduced.add(id); console.log(`${TAG} ↪ intro → ${nameOf(id)}`); }
  }
  async function handleAsk(q) {
    if (!q) { reply(`Ask me anything about the room, my role, or decisions — \`/${CMD} ask <question>\`.`, "askhelp", 12_000); return; }
    if (!advisor.enabled) { reply(`I'd need AI mode for that — start me with \`--ai\` (\`--ai-backend claude-code\` to use a Claude subscription, or set \`ANTHROPIC_API_KEY\`). For now, \`/${CMD} help\` lists what I do.`, "asknoai", 20_000); return; }
    if (!cooled("ask", 6_000)) return;
    cooldown.set("ask", Date.now());
    const text = await advisor.advise("ask", { question: q, transcript: recentMsgs.slice(-12).map((mm) => ({ name: mm.name, text: mm.text })) });
    reply(text || `Hmm, I don't have a good answer to that one. \`/${CMD} help\` for what I can do.`, null, 0);
  }
  // Facilitate one step of a collective-optimization round (the room as a quantum-
  // annealing-style optimizer). Stateless: re-reads the recent discussion each call,
  // proposes/refines candidates, and suggests the next scoring step (/estimate or
  // /poll → /probe → /lemma). See Collective_Optimization.md.
  async function handleOptimize(problem) {
    if (!problem) { reply(`Give me something to optimize — \`/${CMD} optimize <objective + constraints>\` (e.g. "pick a sprint plan: ship auth in 2 weeks, 2 engineers"). I'll propose candidates and a way to score them.`, "opthelp", 12_000); return; }
    if (!advisor.enabled) { reply(`I'd need AI mode for that — start me with \`--ai\` (\`--ai-backend claude-code\` for a Claude subscription, or set \`ANTHROPIC_API_KEY\`). For now, \`/${CMD} help\`.`, "optnoai", 20_000); return; }
    if (!cooled("optimize", 6_000)) return;
    cooldown.set("optimize", Date.now());
    const text = await advisor.advise("optimize", { problem, transcript: recentMsgs.slice(-16).map((mm) => ({ name: mm.name, text: mm.text })) });
    reply(text || `Hmm, I couldn't frame that one. Try \`/${CMD} optimize <objective + constraints>\`.`, null, 0);
  }
  function handleCommand(text) {
    const raw = String(text ?? "").trim();
    const lc = raw.toLowerCase();
    const m = cmdRe.exec(lc);
    if (m) {
      const sub = m[1] ?? "";
      if (sub === "off" || sub === "mute" || sub === "quiet") { muted = true; reply(`Muted — I'll stay quiet. Say \`/${CMD} on\` to bring me back.`, "agmute", 0); return true; }
      if (sub === "on" || sub === "unmute" || sub === "wake") { muted = false; reply(`Back on 👋 — \`/${CMD} help\` for what I do.`, "agmute", 0); return true; }
      if (sub === "status" || sub === "here" || sub === "ping") { reply(statusText(), "agstatus", 20_000); return true; }
      if (sub === "trust" || sub === "standing") { reply(standingText(), "agtrust", 15_000); return true; }
      if (sub === "ask") { handleAsk(raw.replace(askStripRe, "").trim()); return true; }
      if (sub === "optimize" || sub === "opt") { handleOptimize(raw.replace(optStripRe, "").trim()); return true; }
      reply(helpText(), "aghelp", 25_000); return true;
    }
    if (bareNameRe.test(lc) || anyoneHereRe.test(lc)) { reply(statusText(), "agstatus", 20_000); return true; }
    // bare greeting → only the lead greet-capable agent replies (so N agents don't all say hi)
    if (greetingRe.test(lc)) {
      if (leadGate("greet")) { reply(`👋 Hi! I'm ${myName}, the room ${role.name} — \`/${CMD} help\` for what I do.`, "aggreet", Math.round(4 * 60_000 * scale)); return true; }
      return false;
    }
    return false;
  }

  const peer = new QOSPeer({
    signalingUrl: args.signal, roomId, peerId: identity.peerId,
    onSignalingOpen: () => console.log(`${TAG} signaling connected; joined room`),
    onSignalingClose: () => console.warn(`${TAG} signaling dropped — reconnecting`),
    onPeerJoined: (id) => { if (args.verbose) console.log(`${TAG} ${short(id)}… joining`); },
    onPeerLeft: (id) => { present.delete(id); introduced.delete(id); agents.delete(id); },
    onError: (e) => console.error(TAG, e?.message ?? e),
    onChannelOpen: (id) => onChannelOpen(id),
    onMessage: (from, d) => onMessage(from, d),
  });

  let signQueue = Promise.resolve();
  function signedSend(target, env) {
    signQueue = signQueue.then(async () => {
      const out = { ...env };
      if (SIGNED_KINDS.has(env.kind)) { try { out.dyncap = await signEnvelope(dyncapState, roomId, env); saveIdentity(); } catch (e) { console.error(`${TAG} sign failed:`, e?.message ?? e); } }
      peer.send(target, out);
    }).catch((e) => console.error(`${TAG} send error:`, e?.message ?? e));
    return signQueue;
  }

  function onChannelOpen(id) {
    if (id === identity.peerId) return;
    present.add(id);
    joinedAt.set(id, Date.now());
    // announce name + our agent role so other agents recognize us
    signedSend(id, { kind: "name", name: myName, agent: roleKey });
    // Self-introduction is delivered per-peer when a human identifies (see introduceTo,
    // called from onMessage) — NOT a one-time startup broadcast — so a browser that joins
    // later, or whose channel opens after a co-agent's, still reliably gets it.
    if (role.duties.greet) {
      const rec = (known[id] ??= { firstSeen: Date.now() });
      if (!rec.greeted) scheduleGreet(id, 0);
    }
  }

  const GREET_RETRIES = 4;
  function scheduleGreet(id, attempt) {
    const delay = attempt === 0 ? GREET_DELAY_MS + 1500 : MIN_GAP_MS + 2000;
    setTimeout(() => {
      const rec = known[id];
      if (!rec || rec.greeted || !present.has(id) || agents.has(id)) return;   // don't greet other agents
      if (!leadGate("greet")) { rec.greeted = Date.now(); saveKnown(); return; } // another agent leads greeting
      if (say(`👋 Welcome, ${nameOf(id)}! Jump in any time — what brings you here?`, `greet:${id}`, CD.greet)) { rec.greeted = Date.now(); saveKnown(); }
      else if (attempt < GREET_RETRIES) scheduleGreet(id, attempt + 1);
    }, delay);
  }

  function maybeNamePrompt(id) {
    if (!leadGate("namePrompt") || agents.has(id)) return;
    const rec = (known[id] ??= { firstSeen: Date.now() });
    if (rec.namePrompted || hasName(id)) return;
    if (say(`(psst ${short(id)}… — set a name with \`/name\` so everyone knows who's talking 🙂)`, `name:${id}`, CD.name)) { rec.namePrompted = Date.now(); saveKnown(); }
  }

  function onMessage(from, d) {
    if (from === identity.peerId || !d || typeof d !== "object") return;
    if (args.verbose) console.log(`${TAG} ⇐ ${short(from)}… ${JSON.stringify(d).slice(0, 160)}`);
    switch (d.kind) {
      case "name":
        if (typeof d.name === "string") { peerNames.set(from, d.name); const r = (known[from] ??= { firstSeen: Date.now() }); r.name = d.name; saveKnown(); }
        if (typeof d.agent === "string") agents.set(from, d.agent.toLowerCase());
        introduceTo(from);   // a human just identified → self-introduce (skips agents/dups)
        if (!isAgentPeer(from) && !hasName(from)) setTimeout(() => maybeNamePrompt(from), 3_000);   // joined nameless → prompt
        break;
      case "chat": {
        spokeAt.set(from, Date.now());
        chatLog.push({ peer: from, at: Date.now() });
        recentMsgs.push({ name: nameOf(from), text: String(d.text ?? "").slice(0, 280), at: Date.now() });
        if (args.verbose) console.log(`[${nameOf(from)}] ${String(d.text).slice(0, 120)}`);
        introduceTo(from);   // covers a human who chats before announcing a name
        if (handleCommand(d.text)) break;
        if (!isAgentPeer(from) && !hasName(from)) setTimeout(() => maybeNamePrompt(from), 2_000);
        checkDominator();
        break;
      }
      case "state-discrepancy": surfaceDiscrepancy(d); break;
      // governance ingestion → recompute the agent's own trust standing (self-throttle only)
      case "group-open":
        if (d.id && !groups.has(d.id)) groups.set(d.id, normalizeGroup({ id: d.id, name: d.name, creator: from, creatorLabel: d.creatorLabel ?? short(from), createdAt: d.createdAt, members: { [from]: { peerId: from, role: "admin", label: d.creatorLabel ?? short(from), at: d.createdAt ?? Date.now() } } }));
        updateStanding();
        break;
      case "group-member": {
        const g = groups.get(d.groupId);
        if (g && d.peerId) {
          if (d.remove) delete g.members[d.peerId];
          else g.members[d.peerId] = { peerId: d.peerId, role: d.role === "admin" ? "admin" : "member", label: d.label ?? short(d.peerId), at: Date.now() };
          updateStanding();
        }
        break;
      }
      case "gov-trust": {
        const g = groups.get(d.groupId);
        if (g && d.rater && d.ratee && typeof d.rating === "number") {
          (g.trustRatings ??= {})[d.rater] ??= {};
          if (d.rating > 0) g.trustRatings[d.rater][d.ratee] = d.rating; else delete g.trustRatings[d.rater][d.ratee];
          updateStanding();
        }
        break;
      }
      case "gov-censure": {
        const g = groups.get(d.groupId);
        if (g && d.censurer && d.target) {
          (g.censures ??= {})[d.censurer] ??= {};
          if (d.on) g.censures[d.censurer][d.target] = 1; else delete g.censures[d.censurer][d.target];
          updateStanding();
        }
        break;
      }
      case "sync-gov":
        if (Array.isArray(d.groups)) { for (const g of d.groups) if (g && g.id) groups.set(g.id, normalizeGroup(g)); updateStanding(); }
        break;
    }
  }

  async function surfaceDiscrepancy(d) {
    if (!leadGate("discrepancy")) return;
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
    if (!leadGate("dominator")) return;
    const now = Date.now();
    const recent = chatLog.filter((c) => now - c.at <= ACTIVE_MS && !isAgentPeer(c.peer));
    if (recent.length < DOMINATE_MIN) return;
    const by = new Map();
    for (const c of recent) by.set(c.peer, (by.get(c.peer) ?? 0) + 1);
    if (by.size < 3) return;
    let top = null, topN = 0;
    for (const [p, n] of by) if (n > topN) { top = p; topN = n; }
    if (topN / recent.length > DOMINATE_FRAC) say(`Lots of good thinking from ${nameOf(top)} — let's make space for other voices too. What do the rest of you make of it?`, "dominate", CD.dominate);
  }

  async function tick() {
    const humans = recentHumanCount();
    if (advisor.enabled) {
      const now = Date.now();
      const lastHuman = (() => { for (let i = chatLog.length - 1; i >= 0; i--) if (!isAgentPeer(chatLog[i].peer)) return chatLog[i].at; return 0; })();
      if (role.duties.synthesize && substantiveChat() && leadGate("synthesize") && wouldPost("synthesize", CD.synthesize)) {
        const text = await advisor.advise("synthesize", buildCtx());
        if (text) say(text, "synthesize", CD.synthesize);
      }
      if (role.duties.stimulate && lastHuman && now - lastHuman > LULL_MS && recentHumanCount(10 * 60_000) >= 3 && leadGate("stimulate") && wouldPost("stimulate", CD.stimulate)) {
        const text = await advisor.advise("stimulate", buildCtx());
        if (text) say(text, "stimulate", CD.stimulate);
      }
      return;
    }
    if (!role.duties.silentQuarter || !leadGate("silentQuarter")) return;
    if (humans < 2) return;
    const now = Date.now();
    const quiet = [...present].filter((id) => !isAgentPeer(id) && (now - (joinedAt.get(id) ?? now)) > SILENT_MS && (now - (spokeAt.get(id) ?? 0)) > SILENT_MS);
    if (!quiet.length) return;
    const names = quiet.slice(0, 2).map(nameOf).join(", ");
    say(`We haven't heard from everyone — ${names}, curious what you're thinking on this?`, "silent", CD.silent);
  }
  const timer = setInterval(() => tick().catch((e) => console.error(`${TAG} tick:`, e?.message ?? e)), TICK_MS);

  peer.connect();
  console.log(`${TAG} running as "${myName}" [role=${role.name}]  budget=${MAX_POSTS}/5min  min-gap=${Math.round(MIN_GAP_MS / 1000)}s  silent=${Math.round(SILENT_MS / 60000)}min  AI=${advisor.enabled ? advisor.model : "off"}. Ctrl-C to stop.`);

  const shutdown = () => { console.log(`\n${TAG} shutting down…`); try { clearInterval(timer); saveIdentity(); saveKnown(); } catch {} try { peer.disconnect(); } catch {} setTimeout(() => process.exit(0), 200); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// CLI entry — only when invoked directly (not when imported by facilitator.mjs).
let invokedDirectly = false;
try { invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (invokedDirectly) run(parseArgs(process.argv.slice(2))).catch((e) => { console.error(e); process.exit(1); });
