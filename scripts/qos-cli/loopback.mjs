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
const opens = { A: 0, B: 0 };   // onChannelOpen count — a glare rebuild storm shows up here
const mk = (label) => new QOSPeer({
  signalingUrl: url, roomId: ROOM, peerId: generateCapability("peer"), iceServers: [],
  onChannelOpen: (id) => { opens[label]++; console.log(`[${label}] channel open → ${id.slice(0,10)}…; sending chat`); peers[label].broadcast({ kind: "chat", text: `hello-from-${label}` }); },
  onMessage: (from, d) => { if (d && d.kind === "chat") { received[label] = d.text; console.log(`[${label}] received: ${d.text}`); } },
  onError: (e) => console.error(`[${label}]`, e?.message ?? e),
});

const peers = {};
const a = peers.A = mk("A");
peers.B = mk("B");

a.connect();
setTimeout(() => peers.B.connect(), 600);

// Glare: once both are connected, make BOTH dial the other on the same tick —
// exactly what a roster change does to two node peers. Perfect-negotiation
// arbitration (smaller peerId yields, larger keeps its offer) must settle this
// without an endless rebuild. Before the fix this pegged both cores and
// onChannelOpen fired hundreds of times.
setTimeout(() => {
  const bId = peers.B.peerId, aId = peers.A.peerId;
  console.log(`\n-- forcing glare: A(${aId.slice(9,13)}) <-> B(${bId.slice(9,13)}) dial simultaneously --`);
  peers.A._initiate(bId).catch(() => {});
  peers.B._initiate(aId).catch(() => {});
}, 6000);

setTimeout(() => {
  const roundTrip = received.A === "hello-from-B" && received.B === "hello-from-A";
  // After glare, both sides must still hold an open channel…
  const aOpen = peers.A._channelOpen(peers.A.channels.get(peers.B.peerId));
  const bOpen = peers.B._channelOpen(peers.B.channels.get(peers.A.peerId));
  // …and the channel must not have thrashed: 1 open normally, ≤3 tolerates the
  // one legitimate rebuild the polite side does. Hundreds = the old storm.
  const calm = opens.A <= 3 && opens.B <= 3;
  const pass = roundTrip && aOpen && bOpen && calm;
  console.log(`\n${pass ? "PASS" : "FAIL"}  werift↔werift: round-trip + glare survives without a rebuild storm`);
  console.log(`  A received: ${received.A}   B received: ${received.B}`);
  console.log(`  channels open after glare: A→B ${aOpen}  B→A ${bOpen}   onChannelOpen counts: A ${opens.A}  B ${opens.B}`);
  try { peers.A.disconnect(); peers.B.disconnect(); wss.close(); } catch {}
  setTimeout(() => process.exit(pass ? 0 : 1), 200);
}, 12000);
