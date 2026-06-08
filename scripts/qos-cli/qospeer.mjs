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
  }

  connect() {
    this._disconnected = false;
    this._openSignaling().catch(() => {
      if (!this._disconnected) this._reconnectTimer = setTimeout(() => this._reconnect(), 3000);
    });
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
    ws.on("message", (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      this._handleSignal(msg);
    });
    ws.on("close", () => {
      if (this._disconnected) return;
      this.config.onSignalingClose?.();
      this._reconnectTimer = setTimeout(() => this._reconnect(), 3000);
    });
    this._signal({ type: "join", roomId: this.config.roomId, peerId: this.peerId });
    this.config.onSignalingOpen?.();
  }

  async _reconnect() {
    if (this._disconnected) return;
    try { await this._openSignaling(); }
    catch { this._reconnectTimer = setTimeout(() => this._reconnect(), 5000); }
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
      let d; try { d = JSON.parse(data.toString()); } catch { d = data.toString(); }
      this.config.onMessage?.(remoteId, d);
    };
    if (ch.message?.subscribe) ch.message.subscribe(onMsg);
    else ch.onmessage = (ev) => onMsg(ev.data);
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
