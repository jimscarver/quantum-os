#!/usr/bin/env node
// QuantumOS headless CLI peer.
//
// Joins a room by its capability token, connects to the live peers over WebRTC,
// broadcasts a chat message, and exits. Protocol is faithful to
// packages/browser/src/peer.ts:
//   signaling JSON: join / offer / answer / ice / leave
//   data channel label: "qos"
//   chat envelope: { kind: "chat", text }   (+ optional { kind: "name", name })
//
// IMPORTANT — QuantumOS rooms are pure peer-to-peer. The signaling server only
// routes WebRTC handshakes; there is NO server-side room or message history.
// A broadcast reaches only the peers connected *right now*. If nobody is in the
// room, the message goes nowhere. (This is by design — see CLAUDE.md.)

import WebSocket from "ws";
import { RTCPeerConnection } from "werift";
import { generateCapability, validateCapability } from "./zfa.mjs";

const DEFAULT_SIGNAL = "wss://quantum-os-signaling.onrender.com";
const ICE = [{ urls: "stun:stun.l.google.com:19302" }];

const USAGE = `qos-cli — headless QuantumOS room peer

Usage:
  node qos-cli.mjs --room <cap:room:… | room-URL> --message "text" [options]
  node qos-cli.mjs --room <…> --listen        # stay and print room chat

Options:
  --room <cap|url>   Room capability token, or a full jimscarver.github.io/quantum-os
                     URL whose #room=… fragment carries the cap. (required)
  --message, -m <s>  Text to broadcast to the room.
  --name <s>         Display name shown to peers (default: "qos-cli").
  --signal <url>     Signaling server (default: ${DEFAULT_SIGNAL}).
  --wait <ms>        Give up if no peer is reached in this long (default 15000).
  --linger <ms>      Stay this long after delivery before exiting (default 2000).
  --listen           Don't send; stay connected and print incoming messages.
  --help, -h         Show this help.

Note: rooms are p2p — a message only lands if someone is in the room now.`;

function parseArgs(argv) {
  const a = { signal: DEFAULT_SIGNAL, name: "qos-cli", waitMs: 15000, lingerMs: 2000, listen: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--room") a.room = argv[++i];
    else if (x === "--message" || x === "-m") a.message = argv[++i];
    else if (x === "--signal") a.signal = argv[++i];
    else if (x === "--name") a.name = argv[++i];
    else if (x === "--wait") a.waitMs = Number(argv[++i]);
    else if (x === "--linger") a.lingerMs = Number(argv[++i]);
    else if (x === "--listen") a.listen = true;
    else if (x === "--help" || x === "-h") a.help = true;
    else rest.push(x);
  }
  if (!a.message && rest.length) a.message = rest.join(" ");
  return a;
}

// Accept a bare cap:room:…, or any URL with a #room=<url-encoded cap> fragment.
function extractRoomCap(s) {
  if (!s) return null;
  if (s.startsWith("cap:room:")) return s;
  const frag = s.includes("#") ? s.slice(s.indexOf("#") + 1) : s;
  const m = /room=([^&]+)/.exec(frag);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  return s.startsWith("cap:") ? s : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.room) { console.log(USAGE); process.exit(args.help ? 0 : 1); }

  const roomId = extractRoomCap(args.room);
  if (!roomId || !roomId.startsWith("cap:room:")) {
    console.error("[qos-cli] could not parse a cap:room: token from --room"); process.exit(1);
  }
  if (!validateCapability(roomId)) {
    console.warn(`[qos-cli] warning: room token failed ZFA validation (continuing): ${roomId}`);
  }
  if (!args.listen && !args.message) {
    console.error("[qos-cli] nothing to do: pass --message <text> or --listen"); process.exit(1);
  }

  const peerId = generateCapability("peer");
  console.log(`[qos-cli] peer ${peerId.slice(0, 18)}…  room ${roomId.slice(0, 18)}…  signal ${args.signal}`);

  const connections = new Map(); // remotePeerId -> RTCPeerConnection
  const channels = new Map();    // remotePeerId -> RTCDataChannel
  const knownPeers = new Set();
  const delivered = new Set();
  let finished = false;

  const ws = new WebSocket(args.signal);
  const signal = (msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

  function finish(code = 0) {
    if (finished) return; finished = true;
    try { signal({ type: "leave", roomId, peerId }); } catch {}
    for (const pc of connections.values()) { try { pc.close(); } catch {} }
    try { ws.close(); } catch {}
    setTimeout(() => process.exit(code), 200);
  }

  function maybeFinishAfterDelivery() {
    if (args.listen) return;
    if (knownPeers.size > 0 && [...knownPeers].every((p) => delivered.has(p))) {
      console.log(`[qos-cli] delivered to ${delivered.size} peer(s); lingering ${args.lingerMs}ms`);
      setTimeout(() => finish(0), args.lingerMs);
    }
  }

  // werift's ICE-candidate event differs slightly across versions; support both.
  function onIceCandidate(pc, handler) {
    if (pc.onIceCandidate?.subscribe) pc.onIceCandidate.subscribe((c) => handler(c));
    else pc.onicecandidate = (ev) => handler(ev?.candidate);
  }

  function setupChannel(remoteId, dc) {
    const onOpen = () => {
      channels.set(remoteId, dc);
      console.log(`[qos-cli] data channel open with ${remoteId.slice(0, 14)}…`);
      if (args.name) { try { dc.send(JSON.stringify({ kind: "name", name: args.name })); } catch {} }
      if (args.message) {
        try {
          dc.send(JSON.stringify({ kind: "chat", text: args.message }));
          delivered.add(remoteId);
          console.log(`[qos-cli] → delivered to ${remoteId.slice(0, 14)}…`);
        } catch (e) { console.error("[qos-cli] send failed:", e?.message ?? e); }
      }
      maybeFinishAfterDelivery();
    };

    if (dc.stateChanged?.subscribe) {
      dc.stateChanged.subscribe((state) => {
        if (state === "open") onOpen();
        else if (state === "closed") channels.delete(remoteId);
      });
    } else {
      dc.onopen = onOpen;
      dc.onclose = () => channels.delete(remoteId);
    }

    if (args.listen) {
      const onMsg = (data) => {
        let d; try { d = JSON.parse(data.toString()); } catch { d = { raw: data.toString() }; }
        if (d.kind === "name") console.log(`[qos-cli] peer ${remoteId.slice(0, 8)}… is "${d.name}"`);
        else if (d.kind === "chat" || "text" in d) console.log(`[${remoteId.slice(0, 8)}…] ${d.text ?? d.raw}`);
        else if (d.kind === "qlf") console.log(`[${remoteId.slice(0, 8)}… /${d.cmd}] ${(d.lines || []).join(" | ")}`);
        else console.log(`[${remoteId.slice(0, 8)}…] ${JSON.stringify(d)}`);
      };
      if (dc.onMessage?.subscribe) dc.onMessage.subscribe(onMsg);
      else if (dc.message?.subscribe) dc.message.subscribe(onMsg);
      else dc.onmessage = (ev) => onMsg(ev && typeof ev === "object" && "data" in ev ? ev.data : ev);
    }
  }

  function newPeerConnection(remoteId) {
    try { connections.get(remoteId)?.close(); } catch {}
    const pc = new RTCPeerConnection({ iceServers: ICE });
    onIceCandidate(pc, (candidate) => {
      if (!candidate) return;
      signal({ type: "ice", roomId, from: peerId, to: remoteId, candidate: candidate.toJSON ? candidate.toJSON() : candidate });
    });
    const stateEvt = pc.connectionStateChange ?? pc.iceConnectionStateChange;
    if (stateEvt?.subscribe) stateEvt.subscribe((s) => console.log(`[qos-cli] conn ${remoteId.slice(0, 12)}… → ${s}`));
    connections.set(remoteId, pc);
    return pc;
  }

  async function initiate(remoteId) {
    const pc = newPeerConnection(remoteId);
    const dc = pc.createDataChannel("qos");
    setupChannel(remoteId, dc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signal({ type: "offer", roomId, from: peerId, to: remoteId, sdp: pc.localDescription?.sdp ?? offer.sdp });
  }

  async function handleOffer(fromId, sdp) {
    const pc = newPeerConnection(fromId);
    if (pc.onDataChannel?.subscribe) pc.onDataChannel.subscribe((ch) => setupChannel(fromId, ch));
    else pc.ondatachannel = (ev) => setupChannel(fromId, ev.channel);
    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    signal({ type: "answer", roomId, from: peerId, to: fromId, sdp: pc.localDescription?.sdp ?? answer.sdp });
  }

  async function handleAnswer(fromId, sdp) {
    const pc = connections.get(fromId); if (!pc) return;
    await pc.setRemoteDescription({ type: "answer", sdp });
  }

  async function handleIce(fromId, candidate) {
    const pc = connections.get(fromId); if (!pc || !candidate) return;
    try { await pc.addIceCandidate(candidate); } catch (e) { /* tolerate format edge cases */ }
  }

  ws.on("open", () => { console.log("[qos-cli] signaling connected; joining room…"); signal({ type: "join", roomId, peerId }); });
  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case "peers":
        if (!msg.peers.length) { console.log("[qos-cli] no peers in room yet — waiting for someone to join…"); break; }
        for (const p of msg.peers) { knownPeers.add(p); if (channels.get(p)) continue; initiate(p).catch((e) => console.error("[qos-cli] initiate:", e?.message ?? e)); }
        break;
      case "joined": knownPeers.add(msg.peerId); console.log(`[qos-cli] peer joined ${msg.peerId.slice(0, 14)}… (they initiate)`); break;
      case "left":
        knownPeers.delete(msg.peerId);
        try { connections.get(msg.peerId)?.close(); } catch {}
        connections.delete(msg.peerId); channels.delete(msg.peerId);
        break;
      case "offer":  handleOffer(msg.from, msg.sdp).catch((e) => console.error("[qos-cli] offer:", e?.message ?? e)); break;
      case "answer": handleAnswer(msg.from, msg.sdp).catch((e) => console.error("[qos-cli] answer:", e?.message ?? e)); break;
      case "ice":    handleIce(msg.from, msg.candidate).catch(() => {}); break;
      case "error":  console.error("[signaling]", msg.message); break;
    }
  });
  ws.on("error", (e) => { console.error("[qos-cli] signaling error:", e?.message ?? e); finish(1); });
  ws.on("close", () => { if (!finished && !args.listen) { /* reconnect not needed for one-shot */ } });

  if (args.listen) {
    console.log("[qos-cli] listening… (Ctrl-C to exit)");
    process.on("SIGINT", () => finish(0));
  } else {
    // Hard deadline so a one-shot send always terminates.
    setTimeout(() => {
      if (delivered.size > 0) { console.log(`[qos-cli] reached ${delivered.size} peer(s) before deadline; exiting.`); finish(0); }
      else { console.error(`[qos-cli] no peers reached within ${args.waitMs}ms — message NOT delivered (rooms are p2p; someone must be in the room).`); finish(2); }
    }, args.waitMs);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
