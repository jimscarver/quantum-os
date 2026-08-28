import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Room, type Peer } from "./room.js";

/// Wire message types for WebRTC signaling.
type SignalMsg =
  | { type: "join";      roomId: string; peerId: string }
  | { type: "offer";     roomId: string; from: string; to: string; sdp: string }
  | { type: "answer";    roomId: string; from: string; to: string; sdp: string }
  | { type: "ice";       roomId: string; from: string; to: string; candidate: unknown }
  | { type: "leave";     roomId: string; peerId: string }
  | { type: "peers";     roomId: string; peers: string[] }   // server → client
  | { type: "joined";    roomId: string; peerId: string }    // server → others
  | { type: "left";      roomId: string; peerId: string }    // server → others
  | { type: "error";     message: string };

/**
 * Validate an inbound frame before dispatching it.
 *
 * `SignalMsg` is a *claim* about parsed JSON, not a guarantee: the wire is
 * untrusted and a peer can send `{"type":"join"}` with no roomId or peerId.
 * Without this check that join registered a peer under the key `undefined`
 * (the throw inside `onJoin` was swallowed by the `invalid JSON` catch, after
 * the index had already been poisoned), and the socket's later `close` ran
 * `onLeave` with an undefined peerId — outside any try/catch, so the
 * `peerId.slice(-8)` TypeError killed the process. Any client could take the
 * signaling server down for every room by connecting, sending a malformed
 * join, and hanging up.
 */
function isWellFormed(msg: SignalMsg): boolean {
  const str = (v: unknown): boolean => typeof v === "string" && v.length > 0;
  switch (msg.type) {
    case "join":
    case "leave":
      return str(msg.roomId) && str(msg.peerId);
    case "offer":
    case "answer":
    case "ice":
      return str(msg.roomId) && str(msg.from) && str(msg.to);
    default:
      return true;   // unknown types are answered by the dispatcher below
  }
}

// Max messages per window per connection. The default is what the public
// deployment runs and is deliberately tight, but it is also the ceiling on how
// many peers a room can hold: a peer joining a room of N sends N-1 offers and
// then a burst of ICE candidates, so the join cost per peer is superlinear and
// blows the window well before the room feels large. Over it, handshakes stop
// completing while every peer still appears in the room — indistinguishable,
// from a browser, from the other peers never having started.
//
// Env-overridable, and the public deployment sets SIGNAL_RATE_LIMIT=200 in
// render.yaml, which comfortably holds a full cast. The code default stays
// tight for anyone running this unconfigured.
const RATE_LIMIT = parseInt(process.env.SIGNAL_RATE_LIMIT ?? "20", 10);
const RATE_WINDOW_MS = parseInt(process.env.SIGNAL_RATE_WINDOW_MS ?? "1000", 10);
// Joining is bursty and then quiet: offers and their ICE candidates arrive in a
// clump and nothing follows. A fixed window punishes exactly that shape, so the
// limit is a token bucket — RATE_LIMIT per window sustained, with a bucket deep
// enough to absorb one join. The sustained rate is what protects the server;
// the burst is what makes a legitimate join land.
const RATE_BURST = parseInt(process.env.SIGNAL_RATE_BURST ?? String(RATE_LIMIT * 4), 10);

// Build marker — surfaced at GET / so a deploy can be confirmed from outside
// (`curl https://…/` shows the live build). Bump this string on each meaningful deploy.
const BUILD = "2026-08-28-rate-limit-200";

export class SignalingServer {
  private wss: WebSocketServer;
  private rooms = new Map<string, Room>();
  // peerId → { roomId, ws } for cleanup on disconnect
  private peerIndex = new Map<string, { roomId: string; ws: WebSocket }>();
  // ws → peerId for relay authentication
  private wsIndex = new Map<WebSocket, string>();
  // ws → rate-limit state
  private rateMap = new Map<WebSocket, { tokens: number; last: number }>();

  constructor(private port: number) {
    // HTTP server handles both health checks (GET /) and WS upgrades.
    const http = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", build: BUILD, rooms: this.rooms.size }));
    });
    this.wss = new WebSocketServer({ server: http, maxPayload: 65_536 });
    this._http = http;
  }

  private _http: ReturnType<typeof createServer>;

  start(): void {
    this.wss.on("connection", (ws) => this.onConnect(ws));
    this._http.listen(this.port, () => {
      console.log(`[quantum-os signaling] listening on ws://0.0.0.0:${this.port}`);
    });

    // Ping every 30s to keep the proxy from closing idle WebSocket connections.
    // Browsers (and the Node `ws` client) respond to protocol-level pings automatically.
    // Terminate only after TWO consecutive missed pongs (~60s of silence), NOT one: a
    // free/throttled host is often slow or sleepy, and a single late pong used to
    // false-terminate a perfectly good connection — dropping every peer at once and
    // producing the correlated join/leave churn. This mirrors the agent's own heartbeat
    // (`qospeer.mjs`), which was hardened the same way for the same reason.
    const heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) {
        const w = ws as WebSocket & { _missed?: number };
        if ((w._missed ?? 0) >= 2) { w.terminate(); continue; }
        w._missed = (w._missed ?? 0) + 1;
        try { w.ping(); } catch { /* socket already closing */ }
      }
    }, 30_000);
    this.wss.on("close", () => clearInterval(heartbeat));
  }

  private onConnect(ws: WebSocket): void {
    const w = ws as WebSocket & { _missed?: number };
    w._missed = 0;
    w.on("pong", () => { w._missed = 0; });

    this.rateMap.set(ws, { tokens: RATE_BURST, last: Date.now() });

    ws.on("message", (data) => {
      if (!this.checkRate(ws)) {
        this.send(ws, { type: "error", message: "rate limit exceeded" });
        return;
      }
      try {
        const msg = JSON.parse(data.toString()) as SignalMsg;
        this.handle(ws, msg);
      } catch {
        this.send(ws, { type: "error", message: "invalid JSON" });
      }
    });

    // A throw here runs outside the message handler's try/catch, so an
    // uncaught one ends the process and every room with it. Contain it.
    ws.on("close", () => {
      try {
        this.onDisconnect(ws);
      } catch (err) {
        console.error("[disconnect] cleanup failed:", err);
      }
    });
  }

  private checkRate(ws: WebSocket): boolean {
    const now = Date.now();
    const state = this.rateMap.get(ws);
    if (!state) return false;
    // Refill by however long it has been, cap at the bucket depth, spend one.
    const refill = ((now - state.last) / RATE_WINDOW_MS) * RATE_LIMIT;
    state.tokens = Math.min(RATE_BURST, state.tokens + refill);
    state.last = now;
    if (state.tokens < 1) return false;
    state.tokens -= 1;
    return true;
  }

  private handle(ws: WebSocket, msg: SignalMsg): void {
    if (!msg || typeof msg.type !== "string") {
      this.send(ws, { type: "error", message: "malformed message" });
      return;
    }
    if (!isWellFormed(msg)) {
      this.send(ws, { type: "error", message: `malformed ${msg.type}: missing required field` });
      return;
    }
    switch (msg.type) {
      case "join":
        this.onJoin(ws, msg.roomId, msg.peerId);
        break;
      case "offer":
      case "answer":
      case "ice":
        this.relay(ws, msg);
        break;
      case "leave":
        this.onLeave(msg.roomId, msg.peerId);
        break;
      default:
        this.send(ws, { type: "error", message: `unknown message type` });
    }
  }

  private onJoin(ws: WebSocket, roomId: string, peerId: string): void {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId);
      this.rooms.set(roomId, room);
    }

    const peer: Peer = { id: peerId, ws, joinedAt: Date.now() };
    room.add(peer);
    this.peerIndex.set(peerId, { roomId, ws });
    this.wsIndex.set(ws, peerId);

    // Tell the joiner who else is in the room.
    this.send(ws, { type: "peers", roomId, peers: room.peerIds().filter(id => id !== peerId) });

    // Tell existing peers that someone joined.
    room.broadcast(peerId, { type: "joined", roomId, peerId });

    console.log(`[join]  room=…${roomId.slice(-8)} peer=…${peerId.slice(-8)} size=${room.size}`);
  }

  private onLeave(roomId: string, peerId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const entry = this.peerIndex.get(peerId);
    room.remove(peerId);
    this.peerIndex.delete(peerId);
    if (entry) this.wsIndex.delete(entry.ws);
    room.broadcast(peerId, { type: "left", roomId, peerId });
    if (room.isEmpty) this.rooms.delete(roomId);
    console.log(`[leave] room=…${roomId.slice(-8)} peer=…${peerId.slice(-8)}`);
  }

  private onDisconnect(ws: WebSocket): void {
    this.rateMap.delete(ws);
    // Find the single peer on this socket and remove only them.
    for (const [peerId, { roomId, ws: peerWs }] of this.peerIndex) {
      if (peerWs !== ws) continue;
      this.onLeave(roomId, peerId);
      break;
    }
  }

  private relay(ws: WebSocket, msg: Extract<SignalMsg, { to: string; from: string; roomId: string }>): void {
    const room = this.rooms.get(msg.roomId);
    if (!room) return;
    if (this.wsIndex.get(ws) !== msg.from) {
      this.send(ws, { type: "error", message: "relay from mismatch" });
      return;
    }
    room.send(msg.to, msg);
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify(msg));
    }
  }
}
