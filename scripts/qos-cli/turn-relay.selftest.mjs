// Cross-network calls need a default relay, and both halves (packages/signaling
// GET /turn, this file's _loadAutoTurn/_iceServers) have to agree on the wire
// shape. This drives QOSPeer's auto-TURN fetch against a tiny stand-in HTTP
// server (not the real signaling server, not Cloudflare) and checks: it's
// picked up when present, DEFAULT_ICE survives when the endpoint is empty or
// unreachable, and an explicit iceServers config is never overridden. Run:
// node turn-relay.selftest.mjs
import { createServer } from "node:http";
import { QOSPeer } from "./qospeer.mjs";

let failed = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}  (${detail})`); }
};

const stubTurn = { urls: ["turn:example.invalid:3478?transport=udp"], username: "u", credential: "c" };

function serveOnce(handler) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => handler(req, res));
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// --- a relay the endpoint offers is picked up -------------------------------
{
  const srv = await serveOnce((req, res) => {
    if (req.url === "/turn") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ iceServers: [stubTurn] }));
    } else { res.writeHead(404); res.end(); }
  });
  const { port } = srv.address();
  const peer = new QOSPeer({ signalingUrl: `ws://127.0.0.1:${port}`, roomId: "cap:room:0246", peerId: "aaa" });
  check("no iceServers before the fetch resolves", peer._iceServers().length === 1, JSON.stringify(peer._iceServers()));
  await peer._loadAutoTurn();
  check("the relay is merged in after _loadAutoTurn", peer._iceServers().some((s) => JSON.stringify(s.urls) === JSON.stringify(stubTurn.urls)),
        JSON.stringify(peer._iceServers()));
  check("DEFAULT_ICE (STUN) is still present alongside it", peer._iceServers().length === 2, JSON.stringify(peer._iceServers()));
  srv.close();
}

// --- an empty relay list (server up, TURN not configured) changes nothing --
{
  const srv = await serveOnce((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ iceServers: [] }));
  });
  const { port } = srv.address();
  const peer = new QOSPeer({ signalingUrl: `ws://127.0.0.1:${port}`, roomId: "cap:room:0246", peerId: "aaa" });
  await peer._loadAutoTurn();
  check("an empty relay list leaves just DEFAULT_ICE", peer._iceServers().length === 1, JSON.stringify(peer._iceServers()));
  srv.close();
}

// --- an unreachable endpoint fails silently, no throw, no hang -------------
{
  const peer = new QOSPeer({ signalingUrl: "ws://127.0.0.1:1", roomId: "cap:room:0246", peerId: "aaa" });
  let threw = false;
  try { await peer._loadAutoTurn(); } catch { threw = true; }
  check("an unreachable /turn does not throw", !threw, String(threw));
  check("iceServers falls back to DEFAULT_ICE alone", peer._iceServers().length === 1, JSON.stringify(peer._iceServers()));
}

// --- an explicit iceServers config is never overridden by the auto-fetch ---
{
  const srv = await serveOnce((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ iceServers: [stubTurn] }));
  });
  const { port } = srv.address();
  const peer = new QOSPeer({ signalingUrl: `ws://127.0.0.1:${port}`, roomId: "cap:room:0246", peerId: "aaa", iceServers: [] });
  await peer._loadAutoTurn();
  check("an explicit iceServers (even []) is left exactly as passed",
        Array.isArray(peer._iceServers()) && peer._iceServers().length === 0, JSON.stringify(peer._iceServers()));
  srv.close();
}

console.log(failed === 0 ? "\nturn-relay: all passed" : `\nturn-relay: ${failed} FAILED`);
process.exit(failed ? 1 : 0);
