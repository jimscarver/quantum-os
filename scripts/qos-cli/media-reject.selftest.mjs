// A node agent is data-only. When a browser peer starts a call, it renegotiates
// with every peer — agents included — adding audio/video to the offer. Without
// _rejectMedia, werift accepts the media, registers SSRC receivers, and burns
// ~20% of a core per call decrypting inbound RTP it will never use (measured
// live: three co-located agents pegged a machine on one call).
//
// This test drives a QOSPeer through an inbound offer that carries audio + video
// alongside the data channel and asserts: (1) the data channel still opens, and
// (2) the answer rejects every media m-line (port 0 / a=inactive), so a
// compliant peer sends no RTP. Run: node media-reject.selftest.mjs
import { WebSocketServer } from "ws";
import { RTCPeerConnection } from "werift";
import { QOSPeer } from "./qospeer.mjs";
import { generateCapability } from "./zfa.mjs";

const PORT = 4459;
const ROOM = "cap:room:" + "0167".repeat(8);

// minimal signaling relay, and a tap on the answer SDP the agent emits
let answerSdp = null;
const rooms = new Map();
const wsPeer = new Map();
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
      if (m.type === "answer") answerSdp = m.sdp;
      rooms.get(m.roomId)?.get(m.to) && send(rooms.get(m.roomId).get(m.to), m);
    }
  });
  ws.on("close", () => {
    const info = wsPeer.get(ws); wsPeer.delete(ws);
    rooms.get(info?.roomId)?.delete(info?.peerId);
  });
});

const url = `ws://localhost:${PORT}`;
const agentId = generateCapability("peer");
let dataOpened = false;

const agent = new QOSPeer({
  signalingUrl: url, roomId: ROOM, peerId: agentId, iceServers: [],
  onChannelOpen: () => { dataOpened = true; },
  onMessage: () => {},
  onError: (e) => console.error("[agent]", e?.message ?? e),
});
agent.connect();

// A "browser" peer: raw werift, offers data + audio + video like a call would.
await new Promise((r) => setTimeout(r, 800));
const browserId = generateCapability("peer");
const bws = new (await import("ws")).WebSocket(url);
await new Promise((r) => bws.on("open", r));
const bpc = new RTCPeerConnection({ iceServers: [] });
bpc.onIceCandidate.subscribe((c) => c && bws.send(JSON.stringify({ type: "ice", roomId: ROOM, from: browserId, to: agentId, candidate: c.toJSON ? c.toJSON() : c })));
bpc.createDataChannel("qos");
bpc.addTransceiver("audio", { direction: "sendrecv" });
bpc.addTransceiver("video", { direction: "sendrecv" });
bws.on("message", async (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "answer") { await bpc.setRemoteDescription({ type: "answer", sdp: m.sdp }); }
  else if (m.type === "ice" && m.candidate) { try { await bpc.addIceCandidate(m.candidate); } catch {} }
});
bws.send(JSON.stringify({ type: "join", roomId: ROOM, peerId: browserId }));
await new Promise((r) => setTimeout(r, 300));
const offer = await bpc.createOffer();
await bpc.setLocalDescription(offer);
bws.send(JSON.stringify({ type: "offer", roomId: ROOM, from: browserId, to: agentId, sdp: bpc.localDescription?.sdp ?? offer.sdp }));

await new Promise((r) => setTimeout(r, 4000));

const mediaLines = (answerSdp ?? "").split("\n").filter((l) => /^m=(audio|video)/.test(l)).map((l) => l.trim());
const allRejected = mediaLines.length >= 2 && mediaLines.every((l) => / 0 /.test(l) || l.split(" ")[1] === "0");
const inactive = (answerSdp ?? "").split("\n").filter((l) => l.trim() === "a=inactive").length >= 2;
const recvTransceivers = agent.connections.get(browserId)?.getTransceivers?.().filter((t) => ["recvonly", "sendrecv"].includes(t.direction)) ?? [];

const pass = dataOpened && !!answerSdp && (allRejected || inactive) && recvTransceivers.length === 0;
console.log(`${pass ? "PASS" : "FAIL"}  agent rejects call media, keeps the data channel`);
console.log(`  data channel opened: ${dataOpened}`);
console.log(`  answer media m-lines: ${JSON.stringify(mediaLines)}`);
console.log(`  a=inactive count: ${inactive}   active recv transceivers: ${recvTransceivers.length}`);

try { agent.disconnect(); bpc.close(); bws.close(); wss.close(); } catch {}
setTimeout(() => process.exit(pass ? 0 : 1), 200);
