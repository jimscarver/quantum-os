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
  onSignalingOpen?: () => void;                       // fires on every successful WS connect
  onSignalingClose?: () => void;                      // fires when WS drops (before retry)
  onMessage?: (from: string, data: unknown) => void;
  onPeerJoined?: (peerId: string) => void;
  onPeerLeft?: (peerId: string) => void;
  onChannelOpen?: (peerId: string) => void;
  onRemoteTrack?: (peerId: string, stream: MediaStream) => void;   // live-call media
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
  private _disconnected = false;   // true after explicit disconnect()
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _stableTimer: ReturnType<typeof setTimeout> | null = null;
  // Reconnect backoff: doubles on each failed attempt up to a cap, with ±50% jitter
  // (so concurrent peers/tabs desync instead of retrying in lock-step). The free
  // signaling server rate-limits; a fixed/instant retry makes a dropped tab re-hammer
  // it → "rate limit exceeded" → drop → storm. CRUCIAL: the backoff only RESETS to the
  // floor after a connection stays up ≥ STABLE_MS — a rate-limited open-then-instant-
  // close must keep backing off, not reset to the floor every cycle and re-storm (the
  // old bug: resetting on `open` alone).
  private _reconnectDelay = 1500;
  private static readonly RECONNECT_MIN = 1500;
  private static readonly RECONNECT_MAX = 30000;
  private static readonly STABLE_MS = 15000;   // a connection must survive this long to reset the backoff
  // Live-call media: the local mic/cam stream shared into all connections, and a
  // per-peer "we have an outstanding offer" flag for perfect-negotiation glare.
  private localStream: MediaStream | null = null;
  private makingOffer = new Map<string, boolean>();
  // Per-peer grace timer for a transient ICE "disconnected": WebRTC can briefly
  // flap to "disconnected" and recover to "connected". We only declare the peer
  // gone if it has not recovered within this window — preventing a ghost from
  // lingering (handled) AND a healthy peer from being evicted on a blip.
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly DISCONNECT_GRACE_MS = 8000;

  constructor(config: PeerConfig) {
    this.config = config;
    // ZFA-balanced peer identity, kept stable across page reloads via
    // sessionStorage so peerId-keyed state (group membership, poll creator /
    // ballots) survives a refresh. sessionStorage is per-tab, so two tabs in the
    // same browser still get distinct identities (no signaling collision); a
    // brand-new tab starts fresh.
    let id: string | null = null;
    try { id = sessionStorage.getItem("qos-peer-id"); } catch { /* storage unavailable */ }
    if (!id || !validateCapability(id)) {
      id = generateCapability("peer");
      try { sessionStorage.setItem("qos-peer-id", id); } catch { /* ignore */ }
    }
    this.peerId = id;
  }

  connect(): void {
    this._disconnected = false;
    if (!validateCapability(this.config.roomId)) {
      console.warn(`[qos-peer] roomId ZFA check failed (may be cached token): ${this.config.roomId}`);
    }
    this._openSignaling().catch(() => this._scheduleReconnect());
  }

  disconnect(): void {
    this._disconnected = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._stableTimer) clearTimeout(this._stableTimer);
    this.signal({ type: "leave", roomId: this.config.roomId, peerId: this.peerId });
    for (const pc of this.connections.values()) pc.close();
    this.ws?.close();
    this.connections.clear();
    this.channels.clear();
    for (const t of this.disconnectTimers.values()) clearTimeout(t);
    this.disconnectTimers.clear();
  }

  /// Recover promptly after a background-throttled / frozen tab returns to the
  /// foreground. Browsers throttle hidden tabs (starving WebRTC consent-freshness)
  /// and clamp our reconnect setTimeout, so peers drop and come back only slowly.
  /// Called from a visibilitychange/focus handler: if signaling is dead, reconnect
  /// NOW (cancel the throttled backoff and reset it); if it's alive, re-join so the
  /// server re-sends the peer list and we re-establish any channels that lapsed.
  wake(): void {
    if (this._disconnected) return;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
      this._reconnectDelay = QOSPeer.RECONNECT_MIN;        // reset backoff — we're foreground again
      void this._reconnectSignaling();
    } else if (ws.readyState === WebSocket.OPEN) {
      this.signal({ type: "join", roomId: this.config.roomId, peerId: this.peerId });
    }
  }

  /// Whether the signaling WebSocket is currently open (used to label connection status).
  isSignalingUp(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

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

  /// Largest send-buffer backlog across open channels (bytes) — used to pace
  /// large chunked transfers so we don't overflow the SCTP send buffer.
  maxBufferedAmount(): number {
    let max = 0;
    for (const ch of this.channels.values()) {
      if (ch.readyState === "open" && ch.bufferedAmount > max) max = ch.bufferedAmount;
    }
    return max;
  }

  /// Start sharing a local mic/camera stream into every peer connection (live
  /// call). Adds the tracks and renegotiates each connection.
  addLocalMedia(stream: MediaStream): void {
    this.localStream = stream;
    for (const [peerId, pc] of this.connections) {
      for (const track of stream.getTracks()) {
        if (!pc.getSenders().some((s) => s.track === track)) pc.addTrack(track, stream);
      }
      void this.renegotiate(peerId, pc);
    }
  }

  /// Stop sharing local media: remove our senders from every connection and
  /// renegotiate. The remote sees the tracks end.
  removeLocalMedia(): void {
    const stream = this.localStream;
    this.localStream = null;
    if (!stream) return;
    const mine = new Set(stream.getTracks());
    for (const [peerId, pc] of this.connections) {
      for (const sender of pc.getSenders()) {
        if (sender.track && mine.has(sender.track)) {
          try { pc.removeTrack(sender); } catch { /* already gone */ }
        }
      }
      void this.renegotiate(peerId, pc);
    }
  }

  /// Send a fresh offer on an established connection (media (re)negotiation).
  /// Glare is resolved by handleOffer's polite/impolite rule.
  private async renegotiate(peerId: string, pc: RTCPeerConnection): Promise<void> {
    try {
      this.makingOffer.set(peerId, true);
      const offer = await pc.createOffer();
      if (pc.signalingState !== "stable") return;   // a remote offer landed first
      await pc.setLocalDescription(offer);
      this.signal({
        type: "offer", roomId: this.config.roomId,
        from: this.peerId, to: peerId, sdp: pc.localDescription!.sdp,
      });
    } catch (e) {
      console.warn("[qos-peer] renegotiate failed", e);
    } finally {
      this.makingOffer.set(peerId, false);
    }
  }

  private async _openSignaling(): Promise<void> {
    const ws = new WebSocket(this.config.signalingUrl);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });

    // Reset the backoff only once the connection PROVES stable (≥ STABLE_MS). A
    // rate-limited server opens then immediately drops us; resetting on `open` alone
    // would relaunch the storm at the floor delay every cycle.
    if (this._stableTimer) clearTimeout(this._stableTimer);
    this._stableTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState === WebSocket.OPEN) this._reconnectDelay = QOSPeer.RECONNECT_MIN;
    }, QOSPeer.STABLE_MS);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as SignalMsg;
        this.handleSignal(msg);
      } catch {
        console.error("[qos-peer] invalid signal message");
      }
    };

    ws.onclose = () => {
      if (this._stableTimer) { clearTimeout(this._stableTimer); this._stableTimer = null; }
      if (this._disconnected) return;
      this.config.onSignalingClose?.();
      this._scheduleReconnect();
    };

    // Join the room
    this.signal({ type: "join", roomId: this.config.roomId, peerId: this.peerId });
    this.config.onSignalingOpen?.();
  }

  /// Schedule a reconnect with exponential backoff + ±50% jitter, single-flight.
  /// Grows the delay each call; the stability timer in `_openSignaling` resets it
  /// once a connection has lasted ≥ STABLE_MS.
  private _scheduleReconnect(): void {
    if (this._disconnected || this._reconnectTimer) return;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, QOSPeer.RECONNECT_MAX);
    const delay = Math.round(this._reconnectDelay * (0.5 + Math.random()));
    console.warn(`[qos-peer] signaling disconnected — reconnecting in ${(delay / 1000).toFixed(1)}s`);
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; void this._reconnectSignaling(); }, delay);
  }

  private async _reconnectSignaling(): Promise<void> {
    if (this._disconnected) return;
    try {
      await this._openSignaling();
      console.log("[qos-peer] signaling reconnected");
    } catch {
      this._scheduleReconnect();
    }
  }

  private handleSignal(msg: SignalMsg): void {
    switch (msg.type) {
      case "peers":
        // On signaling reconnect the server re-sends the peers list. Skip peers
        // where the WebRTC data channel is still open — no need to re-establish.
        for (const peerId of msg.peers) {
          const ch = this.channels.get(peerId);
          if (ch?.readyState === "open") continue;
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
    // Reuse the existing connection for a renegotiation (e.g. media tracks added
    // mid-call). Only create a fresh connection for a first-time offer — the old
    // "always recreate" behaviour would have torn down the live data channel.
    let pc = this.connections.get(fromPeerId);
    if (!pc) {
      pc = this.createPeerConnection(fromPeerId);
      pc.ondatachannel = (event) => this.setupDataChannel(fromPeerId, event.channel);
    }

    // Perfect-negotiation glare handling: the peer with the smaller ID is polite.
    const polite = this.peerId < fromPeerId;
    const collision = (this.makingOffer.get(fromPeerId) ?? false) || pc.signalingState !== "stable";
    if (collision && !polite) return;   // impolite peer ignores — its own offer wins

    try {
      if (collision && polite) {
        await pc.setLocalDescription({ type: "rollback" });
      }
      await pc.setRemoteDescription({ type: "offer", sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signal({
        type: "answer",
        roomId: this.config.roomId,
        from: this.peerId,
        to: fromPeerId,
        sdp: pc.localDescription!.sdp,
      });
    } catch (e) {
      console.warn("[qos-peer] handleOffer failed", e);
    }
  }

  private async handleAnswer(fromPeerId: string, sdp: string): Promise<void> {
    const pc = this.connections.get(fromPeerId);
    if (!pc) return;
    if (pc.signalingState !== "have-local-offer") return;   // stray/rolled-back answer
    try { await pc.setRemoteDescription({ type: "answer", sdp }); }
    catch (e) { console.warn("[qos-peer] handleAnswer failed", e); }
  }

  private async handleIce(fromPeerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const pc = this.connections.get(fromPeerId);
    if (!pc) return;
    // Candidates can arrive while a description is being rolled back during glare;
    // tolerate the resulting benign failures.
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch { /* ignore */ }
  }

  private createPeerConnection(remotePeerId: string): RTCPeerConnection {
    // Close any stale connection before creating a new one
    this.connections.get(remotePeerId)?.close();

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

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.config.onRemoteTrack?.(remotePeerId, stream);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`[qos-peer] connection to ${remotePeerId.slice(-8)} → ${state}`);
      if (state === "connected") {
        // Recovered (or first connected) — cancel any pending disconnect grace.
        this.clearDisconnectTimer(remotePeerId);
        return;
      }
      if (state === "failed" || state === "closed") {
        // Hard failure — the peer is gone now. (Signaling reconnect will
        // re-establish via the joined/offer flow if they come back.)
        this.clearDisconnectTimer(remotePeerId);
        this.declarePeerGone(remotePeerId);
        return;
      }
      if (state === "disconnected") {
        // Possibly transient: start a grace timer, evict only if it does not
        // recover. Don't stack timers if one is already running.
        if (!this.disconnectTimers.has(remotePeerId)) {
          const t = setTimeout(() => {
            this.disconnectTimers.delete(remotePeerId);
            const cur = this.connections.get(remotePeerId)?.connectionState;
            if (cur === "connected") return;   // recovered
            this.declarePeerGone(remotePeerId);
          }, QOSPeer.DISCONNECT_GRACE_MS);
          this.disconnectTimers.set(remotePeerId, t);
        }
      }
    };

    this.connections.set(remotePeerId, pc);
    return pc;
  }

  private setupDataChannel(peerId: string, ch: RTCDataChannel): void {
    ch.onopen = () => {
      this.channels.set(peerId, ch);
      this.config.onChannelOpen?.(peerId);
      console.log(`[qos-peer] data channel open with ${peerId}`);
      // If a call is already in progress, push our media to the newcomer.
      if (this.localStream) {
        const pc = this.connections.get(peerId);
        if (pc) {
          for (const t of this.localStream.getTracks()) {
            if (!pc.getSenders().some((s) => s.track === t)) pc.addTrack(t, this.localStream);
          }
          void this.renegotiate(peerId, pc);
        }
      }
    };
    ch.onclose = () => {
      this.channels.delete(peerId);
      console.log(`[qos-peer] data channel closed with ${peerId}`);
      // A closed data channel is the most reliable "peer is gone" signal for a
      // clean tab-close — the underlying connection may never reach "failed".
      // Declare the peer gone (the app debounces with its own short grace, and
      // re-establishment fires onPeerJoined / onChannelOpen again).
      this.declarePeerGone(peerId);
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

  private clearDisconnectTimer(peerId: string): void {
    const t = this.disconnectTimers.get(peerId);
    if (t !== undefined) { clearTimeout(t); this.disconnectTimers.delete(peerId); }
  }

  /// Tear down a peer's connection and notify the app it left. Idempotent: a
  /// data-channel close and a connection-state "failed" for the same peer both
  /// land here, but the second call is a no-op (nothing left to clean up).
  private declarePeerGone(peerId: string): void {
    this.clearDisconnectTimer(peerId);
    const had = this.connections.has(peerId) || this.channels.has(peerId);
    this.cleanup(peerId);
    if (had) this.config.onPeerLeft?.(peerId);
  }

  private signal(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
