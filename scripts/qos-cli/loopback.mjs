// Local loopback integration test: a tiny in-process signaling relay + two
// QOSPeer instances in the same room, exchanging a chat over WebRTC. Verifies
// the werift↔werift handshake and the inbound-message hook end to end, with no
// browser and no external server. Run: node loopback.mjs
import { WebSocketServer } from "ws";
import { QOSPeer } from "./qospeer.mjs";
import { generateCapability } from "./zfa.mjs";

const PORT = 4456;
const ROOM = "cap:room:" + "0167".repeat(8); // any well-formed-ish room id

// ---- minimal signaling relay (join/peers/joined/left/offer/answer/ice/leave) ----
const rooms = new Map();           // roomId -> Map<peerId, ws>
const wsPeer = new Map();          // ws -> { roomId, peerId }
const wss = new WebSocketServer({ port: PORT });
const send = (ws, m) => { try { ws.send(JSON.stringify(m)); } catch {} };

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "join") {
      const room = rooms.get(m.roomId) ?? new Map();
      rooms.set(m.roomId, room);
      wsPeer.set(ws, { roomId: m.roomId, peerId: m.peerId });
      const others = [...room.keys()];
      room.set(m.peerId, ws);
      send(ws, { type: "peers", roomId: m.roomId, peers: others });
      for (const [pid, pws] of room) if (pid !== m.peerId) send(pws, { type: "joined", roomId: m.roomId, peerId: m.peerId });
    } else if (m.type === "offer" || m.type === "answer" || m.type === "ice") {
      const room = rooms.get(m.roomId);
      const target = room?.get(m.to);
      if (target) send(target, m);
    } else if (m.type === "leave") {
      const room = rooms.get(m.roomId);
      room?.delete(m.peerId);
      if (room) for (const pws of room.values()) send(pws, { type: "left", roomId: m.roomId, peerId: m.peerId });
    }
  });
  ws.on("close", () => {
    const info = wsPeer.get(ws); wsPeer.delete(ws);
    if (!info) return;
    const room = rooms.get(info.roomId); room?.delete(info.peerId);
    if (room) for (const pws of room.values()) send(pws, { type: "left", roomId: info.roomId, peerId: info.peerId });
  });
});

// ---- two peers ----
const url = `ws://localhost:${PORT}`;
const received = { A: null, B: null };
const mk = (label) => new QOSPeer({
  signalingUrl: url, roomId: ROOM, peerId: generateCapability("peer"), iceServers: [],
  onChannelOpen: (id) => { console.log(`[${label}] channel open → ${id.slice(0,10)}…; sending chat`); peers[label].broadcast({ kind: "chat", text: `hello-from-${label}` }); },
  onMessage: (from, d) => { if (d && d.kind === "chat") { received[label] = d.text; console.log(`[${label}] received: ${d.text}`); } },
  onError: (e) => console.error(`[${label}]`, e?.message ?? e),
});

const peers = {};
const a = peers.A = mk("A");
peers.B = mk("B");

a.connect();
setTimeout(() => peers.B.connect(), 600);

setTimeout(() => {
  const pass = received.A === "hello-from-B" && received.B === "hello-from-A";
  console.log(`\n${pass ? "PASS" : "FAIL"}  werift↔werift data channel round-trip (A↔B chat)`);
  console.log(`  A received: ${received.A}   B received: ${received.B}`);
  try { peers.A.disconnect(); peers.B.disconnect(); wss.close(); } catch {}
  setTimeout(() => process.exit(pass ? 0 : 1), 200);
}, 12000);
