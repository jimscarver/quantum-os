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

const RATE_LIMIT = 20;       // max messages per window per connection
const RATE_WINDOW_MS = 1_000; // window size in ms

// Build marker — surfaced at GET / so a deploy can be confirmed from outside
// (`curl https://…/` shows the live build). Bump this string on each meaningful deploy.
const BUILD = "2026-06-23-heartbeat-2miss";

export class SignalingServer {
  private wss: WebSocketServer;
  private rooms = new Map<string, Room>();
  // peerId → { roomId, ws } for cleanup on disconnect
  private peerIndex = new Map<string, { roomId: string; ws: WebSocket }>();
  // ws → peerId for relay authentication
  private wsIndex = new Map<WebSocket, string>();
  // ws → rate-limit state
  private rateMap = new Map<WebSocket, { count: number; windowStart: number }>();

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

    this.rateMap.set(ws, { count: 0, windowStart: Date.now() });

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

    ws.on("close", () => this.onDisconnect(ws));
  }

  private checkRate(ws: WebSocket): boolean {
    const now = Date.now();
    const state = this.rateMap.get(ws);
    if (!state) return false;
    if (now - state.windowStart >= RATE_WINDOW_MS) {
      state.count = 1;
      state.windowStart = now;
      return true;
    }
    return ++state.count <= RATE_LIMIT;
  }

  private handle(ws: WebSocket, msg: SignalMsg): void {
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
