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

export class SignalingServer {
  private wss: WebSocketServer;
  private rooms = new Map<string, Room>();
  // peerId → { roomId, ws } for cleanup on disconnect
  private peerIndex = new Map<string, { roomId: string; ws: WebSocket }>();

  constructor(private port: number) {
    // HTTP server handles both health checks (GET /) and WS upgrades.
    const http = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", rooms: this.rooms.size }));
    });
    this.wss = new WebSocketServer({ server: http });
    this._http = http;
  }

  private _http: ReturnType<typeof createServer>;

  start(): void {
    this.wss.on("connection", (ws) => this.onConnect(ws));
    this._http.listen(this.port, () => {
      console.log(`[quantum-os signaling] listening on ws://0.0.0.0:${this.port}`);
    });
  }

  private onConnect(ws: WebSocket): void {
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as SignalMsg;
        this.handle(ws, msg);
      } catch {
        this.send(ws, { type: "error", message: "invalid JSON" });
      }
    });

    ws.on("close", () => this.onDisconnect(ws));
  }

  private handle(ws: WebSocket, msg: SignalMsg): void {
    switch (msg.type) {
      case "join":
        this.onJoin(ws, msg.roomId, msg.peerId);
        break;
      case "offer":
      case "answer":
      case "ice":
        this.relay(msg);
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

    // Tell the joiner who else is in the room.
    this.send(ws, { type: "peers", roomId, peers: room.peerIds().filter(id => id !== peerId) });

    // Tell existing peers that someone joined.
    room.broadcast(peerId, { type: "joined", roomId, peerId });

    console.log(`[join]  room=${roomId} peer=${peerId} size=${room.size}`);
  }

  private onLeave(roomId: string, peerId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.remove(peerId);
    this.peerIndex.delete(peerId);
    room.broadcast(peerId, { type: "left", roomId, peerId });
    if (room.isEmpty) this.rooms.delete(roomId);
    console.log(`[leave] room=${roomId} peer=${peerId}`);
  }

  private onDisconnect(ws: WebSocket): void {
    // Find the single peer on this socket and remove only them.
    for (const [peerId, { roomId, ws: peerWs }] of this.peerIndex) {
      if (peerWs !== ws) continue;
      this.onLeave(roomId, peerId);
      break;
    }
  }

  private relay(msg: Extract<SignalMsg, { to: string; from: string; roomId: string }>): void {
    const room = this.rooms.get(msg.roomId);
    if (!room) return;
    room.send(msg.to, msg);
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify(msg));
    }
  }
}
