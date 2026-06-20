// Reusable persistent QuantumOS peer for Node — the reconnecting analog of
// packages/browser/src/peer.ts, on `ws` + `werift`.
//
// Identity (peerId) is supplied by the caller (so a daemon can keep a stable
// cap:peer across restarts). Mirrors peer.ts: data channel label "qos",
// offer/answer/ice over signaling, signaling reconnect 3s (then 5s on a failed
// retry), and skip re-establishing peers whose channel is still open when the
// server re-sends the peers list after a reconnect.

import WebSocket from "ws";
import { RTCPeerConnection } from "werift";

const DEFAULT_ICE = [{ urls: "stun:stun.l.google.com:19302" }];

export class QOSPeer {
  constructor(config) {
    this.config = config;                 // { signalingUrl, roomId, peerId, iceServers?, on* }
    this.peerId = config.peerId;
    this.ws = null;
    this.connections = new Map();         // remoteId -> RTCPeerConnection
    this.channels = new Map();            // remoteId -> data channel
    this._disconnected = false;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
  }

  connect() {
    this._disconnected = false;
    this._openSignaling().catch(() => this._scheduleReconnect());
  }

  // Reconnect with EXPONENTIAL BACKOFF + JITTER, single-flight. The free signaling
  // server rate-limits: a fixed-interval reconnect makes N agents re-hammer it in
  // lock-step → "rate limit exceeded" → drop → storm. Backoff (3s→6→12→24→cap 60s)
  // gives the limit time to clear; ±50% jitter desyncs the agents so they don't all
  // retry at once. `_reconnectAttempts` only resets once a connection stays up ≥15s
  // (see `_openSignaling`), so a connect-then-immediately-dropped (rate-limited)
  // cycle keeps backing off instead of resetting to 3s and storming again.
  _scheduleReconnect() {
    if (this._disconnected || this._reconnectTimer) return; // single-flight
    const base = Math.min(3000 * 2 ** this._reconnectAttempts, 60000);
    const delay = Math.round(base * (0.5 + Math.random()));
    this._reconnectAttempts++;
    this.config.onReconnectScheduled?.(delay);
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this._reconnect(); }, delay);
  }

  disconnect() {
    this._disconnected = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._signal({ type: "leave", roomId: this.config.roomId, peerId: this.peerId });
    for (const pc of this.connections.values()) { try { pc.close(); } catch {} }
    try { this.ws?.close(); } catch {}
    this.connections.clear();
    this.channels.clear();
  }

  send(targetPeerId, data) {
    const ch = this.channels.get(targetPeerId);
    if (!ch || (ch.readyState && ch.readyState !== "open")) return false;
    try { ch.send(JSON.stringify(data)); return true; } catch { return false; }
  }

  broadcast(data) {
    for (const peerId of this.channels.keys()) this.send(peerId, data);
  }

  _signal(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  async _openSignaling() {
    const ws = new WebSocket(this.config.signalingUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", (e) => reject(e));
    });
    // Only treat the connection as healthy (and reset the backoff) once it has stayed
    // up ≥15s. A rate-limited server opens then immediately drops us; without this gate
    // each such cycle would reset the backoff to 3s and re-storm.
    const stableTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState === WebSocket.OPEN) this._reconnectAttempts = 0;
    }, 15000);
    ws.on("message", (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      this._handleSignal(msg);
    });
    // Heartbeat. The free signaling server can drop an idle/half-open socket WITHOUT a
    // clean close, which would leave us a zombie — still connected to current peers but
    // blind to every new joiner (no offer reaches us, so we never appear in their peer
    // list and never get to greet them). Ping every 30s; terminate only after TWO
    // consecutive missed pongs (~60s of silence) so the "close" handler reconnects.
    // Tolerating a single missed pong matters: the free server is often slow/sleepy and
    // a one-off late pong used to false-terminate a perfectly good connection every few
    // minutes — that was the residual leave/rejoin churn after the storm was fixed.
    let missed = 0;
    ws.on("pong", () => { missed = 0; });
    const heartbeat = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (missed >= 2) { try { ws.terminate(); } catch {} return; }
      missed++;
      try { ws.ping(); } catch {}
    }, 30000);
    ws.on("close", () => {
      clearInterval(heartbeat);
      clearTimeout(stableTimer);
      if (this._disconnected) return;
      this.config.onSignalingClose?.();
      this._scheduleReconnect();
    });
    this._signal({ type: "join", roomId: this.config.roomId, peerId: this.peerId });
    this.config.onSignalingOpen?.();
  }

  async _reconnect() {
    if (this._disconnected) return;
    try { await this._openSignaling(); }
    catch { this._scheduleReconnect(); }
  }

  _handleSignal(msg) {
    switch (msg.type) {
      case "peers":
        for (const peerId of msg.peers) {
          const ch = this.channels.get(peerId);
          if (ch && ch.readyState === "open") continue; // keep working connection
          this.config.onPeerJoined?.(peerId);
          this._initiate(peerId).catch((e) => this.config.onError?.(e));
        }
        break;
      case "joined":
        this.config.onPeerJoined?.(msg.peerId); // newcomer initiates to us
        break;
      case "left":
        this._cleanup(msg.peerId);
        this.config.onPeerLeft?.(msg.peerId);
        break;
      case "offer":  this._handleOffer(msg.from, msg.sdp).catch((e) => this.config.onError?.(e)); break;
      case "answer": this._handleAnswer(msg.from, msg.sdp).catch((e) => this.config.onError?.(e)); break;
      case "ice":    this._handleIce(msg.from, msg.candidate).catch(() => {}); break;
      case "error":  this.config.onError?.(new Error(msg.message)); break;
    }
  }

  _onIce(pc, handler) {
    if (pc.onIceCandidate?.subscribe) pc.onIceCandidate.subscribe((c) => handler(c));
    else pc.onicecandidate = (ev) => handler(ev?.candidate);
  }

  _newPC(remoteId) {
    try { this.connections.get(remoteId)?.close(); } catch {}
    const pc = new RTCPeerConnection({ iceServers: this.config.iceServers ?? DEFAULT_ICE });
    this._onIce(pc, (candidate) => {
      if (!candidate) return;
      this._signal({ type: "ice", roomId: this.config.roomId, from: this.peerId, to: remoteId, candidate: candidate.toJSON ? candidate.toJSON() : candidate });
    });
    const stateEvt = pc.connectionStateChange ?? pc.iceConnectionStateChange;
    if (stateEvt?.subscribe) stateEvt.subscribe((s) => { if (s === "failed") { this._cleanup(remoteId); this.config.onPeerLeft?.(remoteId); } });
    this.connections.set(remoteId, pc);
    return pc;
  }

  _setupChannel(remoteId, ch) {
    const onOpen = () => { this.channels.set(remoteId, ch); this.config.onChannelOpen?.(remoteId); };
    if (ch.stateChanged?.subscribe) {
      ch.stateChanged.subscribe((state) => { if (state === "open") onOpen(); else if (state === "closed") this.channels.delete(remoteId); });
    } else {
      ch.onopen = onOpen;
      ch.onclose = () => this.channels.delete(remoteId);
    }
    const onMsg = (data) => {
      const payload = (data && typeof data === "object" && "data" in data) ? data.data : data;
      let d; try { d = JSON.parse(payload.toString()); } catch { d = payload?.toString?.() ?? payload; }
      this.config.onMessage?.(remoteId, d);
    };
    // werift exposes inbound as `onMessage` (an Event); browsers use `onmessage`.
    if (ch.onMessage?.subscribe) ch.onMessage.subscribe(onMsg);
    else if (ch.message?.subscribe) ch.message.subscribe(onMsg);
    else ch.onmessage = (ev) => onMsg(ev && typeof ev === "object" && "data" in ev ? ev.data : ev);
  }

  async _initiate(remoteId) {
    const pc = this._newPC(remoteId);
    const ch = pc.createDataChannel("qos");
    this._setupChannel(remoteId, ch);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._signal({ type: "offer", roomId: this.config.roomId, from: this.peerId, to: remoteId, sdp: pc.localDescription?.sdp ?? offer.sdp });
  }

  async _handleOffer(fromId, sdp) {
    // Renegotiation on a LIVE connection — e.g. a browser peer started a call and
    // added mic/cam, re-offering on the existing connection. Answer on the existing
    // pc; NEVER tear down a working data channel (the old bug: `_newPC` closes it,
    // so starting a call dropped every agent). Data-only node peers just answer
    // without media; if werift can't renegotiate (glare/unsupported), keep the
    // channel and ignore the offer rather than dropping the peer.
    const existing = this.connections.get(fromId);
    if (existing && this.channels.get(fromId)?.readyState === "open") {
      try {
        await existing.setRemoteDescription({ type: "offer", sdp });
        const answer = await existing.createAnswer();
        await existing.setLocalDescription(answer);
        this._signal({ type: "answer", roomId: this.config.roomId, from: this.peerId, to: fromId, sdp: existing.localDescription?.sdp ?? answer.sdp });
      } catch (e) { this.config.onError?.(e); }
      return;
    }
    const pc = this._newPC(fromId);
    if (pc.onDataChannel?.subscribe) pc.onDataChannel.subscribe((ch) => this._setupChannel(fromId, ch));
    else pc.ondatachannel = (ev) => this._setupChannel(fromId, ev.channel);
    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this._signal({ type: "answer", roomId: this.config.roomId, from: this.peerId, to: fromId, sdp: pc.localDescription?.sdp ?? answer.sdp });
  }

  async _handleAnswer(fromId, sdp) {
    const pc = this.connections.get(fromId);
    if (pc) await pc.setRemoteDescription({ type: "answer", sdp });
  }

  async _handleIce(fromId, candidate) {
    const pc = this.connections.get(fromId);
    if (pc && candidate) { try { await pc.addIceCandidate(candidate); } catch {} }
  }

  _cleanup(peerId) {
    try { this.connections.get(peerId)?.close(); } catch {}
    this.connections.delete(peerId);
    this.channels.delete(peerId);
  }
}
