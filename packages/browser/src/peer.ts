import { generateCapability, validateCapability } from "./zfa.js";

type SignalMsg =
  | { type: "peers";   roomId: string; peers: string[] }
  | { type: "joined";  roomId: string; peerId: string }
  | { type: "left";    roomId: string; peerId: string }
  | { type: "offer";   roomId: string; from: string; to: string; sdp: string }
  | { type: "answer";  roomId: string; from: string; to: string; sdp: string }
  | { type: "ice";     roomId: string; from: string; to: string; candidate: RTCIceCandidateInit }
  | { type: "error";   message: string };

export interface PeerConfig {
  signalingUrl: string;    // ws://localhost:4444
  roomId: string;          // ZFA capability token identifying the room
  iceServers?: RTCIceServer[];
  onMessage?: (from: string, data: unknown) => void;
  onPeerJoined?: (peerId: string) => void;
  onPeerLeft?: (peerId: string) => void;
  onChannelOpen?: (peerId: string) => void;
}

const DEFAULT_ICE: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

/// A QuantumOS browser peer.
/// Identity is a ZFA capability token — possessing the peer ID IS authorization.
export class QOSPeer {
  readonly peerId: string;
  private ws: WebSocket | null = null;
  private connections = new Map<string, RTCPeerConnection>();
  private channels = new Map<string, RTCDataChannel>();
  private config: PeerConfig;

  constructor(config: PeerConfig) {
    this.config = config;
    // Generate ZFA-balanced peer identity
    this.peerId = generateCapability("peer");
  }

  async connect(): Promise<void> {
    if (!validateCapability(this.config.roomId)) {
      console.warn(`[qos-peer] roomId ZFA check failed (may be cached token): ${this.config.roomId}`);
    }

    this.ws = new WebSocket(this.config.signalingUrl);

    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => resolve();
      this.ws!.onerror = (e) => reject(e);
    });

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as SignalMsg;
        this.handleSignal(msg);
      } catch {
        console.error("[qos-peer] invalid signal message");
      }
    };

    this.ws.onclose = () => console.log("[qos-peer] signaling disconnected");

    // Join the room
    this.signal({ type: "join", roomId: this.config.roomId, peerId: this.peerId });
  }

  disconnect(): void {
    this.signal({ type: "leave", roomId: this.config.roomId, peerId: this.peerId });
    for (const pc of this.connections.values()) pc.close();
    this.ws?.close();
  }

  /// Send data to a specific peer via their data channel.
  send(targetPeerId: string, data: unknown): boolean {
    const ch = this.channels.get(targetPeerId);
    if (!ch || ch.readyState !== "open") return false;
    ch.send(JSON.stringify(data));
    return true;
  }

  /// Broadcast to all connected peers.
  broadcast(data: unknown): void {
    for (const peerId of this.channels.keys()) {
      this.send(peerId, data);
    }
  }

  private handleSignal(msg: SignalMsg): void {
    switch (msg.type) {
      case "peers":
        // Notify app and initiate connections to existing peers in the room
        for (const peerId of msg.peers) {
          this.config.onPeerJoined?.(peerId);
          this.initiateConnection(peerId);
        }
        break;
      case "joined":
        this.config.onPeerJoined?.(msg.peerId);
        break;
      case "left":
        this.cleanup(msg.peerId);
        this.config.onPeerLeft?.(msg.peerId);
        break;
      case "offer":
        this.handleOffer(msg.from, msg.sdp);
        break;
      case "answer":
        this.handleAnswer(msg.from, msg.sdp);
        break;
      case "ice":
        this.handleIce(msg.from, msg.candidate);
        break;
      case "error":
        console.error("[signaling]", msg.message);
        break;
    }
  }

  private async initiateConnection(remotePeerId: string): Promise<void> {
    const pc = this.createPeerConnection(remotePeerId);

    const ch = pc.createDataChannel("qos");
    this.setupDataChannel(remotePeerId, ch);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.signal({
      type: "offer",
      roomId: this.config.roomId,
      from: this.peerId,
      to: remotePeerId,
      sdp: offer.sdp!,
    });
  }

  private async handleOffer(fromPeerId: string, sdp: string): Promise<void> {
    const pc = this.createPeerConnection(fromPeerId);

    pc.ondatachannel = (event) => {
      this.setupDataChannel(fromPeerId, event.channel);
    };

    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.signal({
      type: "answer",
      roomId: this.config.roomId,
      from: this.peerId,
      to: fromPeerId,
      sdp: answer.sdp!,
    });
  }

  private async handleAnswer(fromPeerId: string, sdp: string): Promise<void> {
    const pc = this.connections.get(fromPeerId);
    if (!pc) return;
    await pc.setRemoteDescription({ type: "answer", sdp });
  }

  private async handleIce(fromPeerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const pc = this.connections.get(fromPeerId);
    if (!pc) return;
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  private createPeerConnection(remotePeerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: this.config.iceServers ?? DEFAULT_ICE,
    });

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.signal({
        type: "ice",
        roomId: this.config.roomId,
        from: this.peerId,
        to: remotePeerId,
        candidate: event.candidate.toJSON(),
      });
    };

    this.connections.set(remotePeerId, pc);
    return pc;
  }

  private setupDataChannel(peerId: string, ch: RTCDataChannel): void {
    ch.onopen = () => {
      this.channels.set(peerId, ch);
      this.config.onChannelOpen?.(peerId);
      console.log(`[qos-peer] data channel open with ${peerId}`);
    };
    ch.onclose = () => {
      this.channels.delete(peerId);
      console.log(`[qos-peer] data channel closed with ${peerId}`);
    };
    ch.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.config.onMessage?.(peerId, data);
      } catch {
        this.config.onMessage?.(peerId, event.data);
      }
    };
  }

  private cleanup(peerId: string): void {
    this.connections.get(peerId)?.close();
    this.connections.delete(peerId);
    this.channels.delete(peerId);
  }

  private signal(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
