// rholang-agent.mjs — the `/rholang` macro agent (a headless room peer).
//
// Joins a QuantumOS room like any other peer, listens for `/rholang macro <name> <args…>`
// chat messages, expands the approved macro, and shares the result back to the
// room chat:
//
//   * read macros  (zfa, verify)  → answered locally, result broadcast to the room.
//   * write macros (grant, ballot, …) → a human-readable rholang preview broadcast
//     for the requestor to review and sign CLIENT-SIDE (the agent never holds keys).
//
// Run:
//   node rholang-agent.mjs --room <cap:room:… | room-URL> [--name rholang] [--signal <url>]

import { generateCapability } from "./zfa.mjs";
import { expandBare, listMacros, HELP } from "./rholang-macros.mjs";

const DEFAULT_SIGNAL = "wss://quantum-os-signaling.onrender.com";
const TAG = "[rholang]";

const USAGE = `qos /rholang macro agent — RChain capability macros in the room chat

  node rholang-agent.mjs --room <cap:room:… | room-URL> [options]

Options:
  --room <cap|url>   Room capability token or a quantum-os URL (#room=…). (required)
  --name <s>         Display name (default: rholang).
  --signal <url>     Signaling server (default: ${DEFAULT_SIGNAL}).
  --verbose          Log inbound chat.
  --help, -h         Show this help.

While connected, any room peer can type:
  /rholang macros
  /rholang macro <name> <args…>
  /rholang eval|deploy   (with %name(…) sites in the program)
The expansion (or read result) is broadcast back into the room chat.`;

export function parseArgs(argv) {
  const a = { name: "rholang", signal: DEFAULT_SIGNAL };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--room") a.room = argv[++i];
    else if (x === "--name") a.name = argv[++i];
    else if (x === "--signal") a.signal = argv[++i];
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

export async function run(args) {
  if (args.help || !args.room) { console.log(USAGE); if (typeof process !== "undefined") process.exit(args.help ? 0 : 1); return; }

  const roomId = extractRoomCap(args.room);
  if (!roomId || !roomId.startsWith("cap:room:")) {
    console.error(`${TAG} could not parse cap:room: from --room`);
    process.exit(1);
    return;
  }

  // Lazy-load the peer so `--help` works without `npm install` (qospeer needs `ws`).
  const { QOSPeer } = await import("./qospeer.mjs");

  const peer = new QOSPeer({
    signalingUrl: args.signal,
    roomId,
    peerId: generateCapability("peer"),
    onSignalingOpen: () => console.log(`${TAG} joined room`),
    onSignalingClose: () => console.warn(`${TAG} signaling dropped`),
    onReconnectScheduled: (ms) => console.warn(`${TAG} reconnecting in ${(ms / 1000).toFixed(1)}s`),
    onPeerJoined: (id) => { if (args.verbose) console.log(`${TAG} peer ${String(id).slice(0, 8)}… joined`); },
    onError: (e) => console.error(TAG, e?.message ?? e),
    onChannelOpen: (id) => {
      if (id === peer.peerId) return;
      // announce our name so the browser labels us in the chat.
      peer.send(id, { kind: "name", name: args.name, agent: "rholang" });
    },
    onMessage: (from, d) => onMessage(from, d),
  });

  function reply(text) {
    peer.broadcast({ kind: "chat", text });
  }

  // Handle a `/rholang …` chat message; return true if it was for us.
  function handleGlobal(text) {
    const s = String(text ?? "").trim();
    if (!/^\/?\s*rholang(\s|$)/i.test(s)) return false;
    try {
      const r = expandBare(s);
      if (r.kind === "help") { reply(HELP); return true; }
      if (r.kind === "list") { reply(listMacros()); return true; }
      if (r.kind === "result") { reply(`✓ ${r.text}`); return true; }
      if (r.kind === "rholang") {
        reply(`/rholang macro ${r.macro} → expanded (review, then sign & deploy client-side):\n\`\`\`\n${r.source}\n\`\`\``);
        return true;
      }
      if (r.kind === "program") {
        // A rholang program with %macro(…) call sites. Errors do not suppress the
        // expansion: the user sees what expanded and what did not, together, so a
        // typo in one call site does not hide the other five.
        const n = r.expansions.length;
        if (!n && !r.errors.length) { reply("no %macro(…) call sites found — `/rholang macros` lists them"); return true; }
        const head = n
          ? `/rholang → expanded ${n} macro${n === 1 ? "" : "s"} (${r.expansions.map((e) => `%${e.name}`).join(", ")}) — review, then sign & deploy client-side:`
          : `/rholang → nothing expanded:`;
        const errs = r.errors.length
          ? `\n✗ ${r.errors.length} error${r.errors.length === 1 ? "" : "s"}:\n` +
            r.errors.map((e) => `  line ${e.line}: ${e.message}`).join("\n")
          : "";
        reply(`${head}\n\`\`\`\n${r.source}\n\`\`\`${errs}`);
        return true;
      }
    } catch (e) {
      reply(`✗ ${e?.message ?? e}`);
      return true;
    }
    return false;
  }

  function onMessage(from, d) {
    if (from === peer.peerId || !d || typeof d !== "object") return;
    if (d.kind === "chat" && typeof d.text === "string") {
      if (args.verbose) console.log(`[chat] ${String(d.text).slice(0, 120)}`);
      handleGlobal(d.text);
    }
  }

  peer.connect();

  const shutdown = () => {
    console.log(`\n${TAG} shutting down…`);
    try { peer.disconnect(); } catch {}
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Run when invoked directly (`node rholang-agent.mjs …`).
if (typeof process !== "undefined" && process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  run(parseArgs(process.argv.slice(2)));
}
