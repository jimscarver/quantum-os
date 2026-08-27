// calls.ts — live calls over the room's WebRTC connections.
//
// The transport is QOSPeer's: `addLocalMedia` adds tracks to every connection
// and renegotiates, `onRemoteStream` brings the other side back. What lives here
// is everything above that — acquiring media, the tiles, the toolbar state, and
// deciding what to do when acquiring fails, which is most of the code because
// it is most of what actually happens to people.
//
// It reaches app.ts through `CallHost` rather than importing it: which peer is
// current changes as the user switches room tabs, so the peer is asked for
// rather than held.

import type { QOSPeer } from "./peer.js";

/** What calls need from the app, asked for rather than held. */
export interface CallHost {
  /** The active room's peer, or null when not connected. */
  peer(): QOSPeer | null;
  /** Put a line in the transcript. */
  say(text: string): void;
  /** Display name for a peer id. */
  label(peerId: string): string;
  /** Agents are data-only: their media is never rendered. */
  isAgent(peerId: string): boolean;
}

export interface CallElements {
  bar: HTMLElement | null;
  tiles: HTMLElement | null;
  mute: HTMLButtonElement | null;
  cam: HTMLButtonElement | null;
}

export interface Calls {
  /** Start if idle, hang up if in a call. */
  toggle(): void;
  end(): void;
  toggleMute(): void;
  toggleCam(): void;
  /** A peer's media arrived. */
  remoteStream(peerId: string, stream: MediaStream): void;
  /** A peer left, or ended their call: drop their tile. */
  peerGone(peerId: string): void;
  inCall(): boolean;
}

// Always request the browser's acoustic echo canceller (+ noise suppression /
// auto gain). `audio: true` *usually* enables AEC, but being explicit guards
// against a driver or profile that left it off — one cause of hearing yourself.
const AUDIO: MediaTrackConstraints = {
  echoCancellation: true, noiseSuppression: true, autoGainControl: true,
};

export function createCalls(host: CallHost, els: CallElements): Calls {
  let localStream: MediaStream | null = null;
  let inCall = false;
  const tiles = new Map<string, HTMLVideoElement>();   // "__local__" | peerId → video

  const showBar = () => { if (els.bar) els.bar.hidden = false; };
  const hideBarIfIdle = () => {
    if (els.bar && !inCall && tiles.size === 0) els.bar.hidden = true;
  };

  function makeTile(key: string, label: string): HTMLVideoElement {
    const wrap = document.createElement("div");
    wrap.className = "call-tile";
    wrap.dataset.key = key;
    const v = document.createElement("video");
    v.autoplay = true; v.playsInline = true;
    const cap = document.createElement("span");
    cap.className = "call-name"; cap.textContent = label;
    wrap.appendChild(v); wrap.appendChild(cap);
    els.tiles?.appendChild(wrap);
    tiles.set(key, v);
    return v;
  }

  function removeTile(key: string): void {
    const v = tiles.get(key);
    if (!v) return;
    v.srcObject = null;
    v.closest(".call-tile")?.remove();
    tiles.delete(key);
  }

  function updateControls(): void {
    const audioOn = localStream?.getAudioTracks()[0]?.enabled ?? false;
    const videoOn = localStream?.getVideoTracks()[0]?.enabled ?? false;
    if (els.mute) {
      els.mute.textContent = audioOn ? "🎤" : "🔇";
      els.mute.title = audioOn ? "Mute mic" : "Unmute mic";
    }
    if (els.cam) {
      const hasVideo = (localStream?.getVideoTracks().length ?? 0) > 0;
      els.cam.disabled = !hasVideo;
      els.cam.textContent = !hasVideo ? "🚫" : videoOn ? "🎥" : "🚫";
      els.cam.title = !hasVideo ? "No camera — audio-only call"
        : videoOn ? "Turn camera off" : "Turn camera on";
    }
  }

  async function start(): Promise<void> {
    const peer = host.peer();
    if (!peer) { host.say("connect to a room before starting a call"); return; }
    if (inCall) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      host.say(`⚠ calls need a secure context — open the site over https:// or localhost${window.isSecureContext ? "" : " (this page is not a secure context)"}`);
      return;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: true });
    } catch {
      // Many devices have no camera (desktops), or video is blocked while audio
      // is allowed — retry audio-only before giving up.
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: false });
        host.say("🎙 camera unavailable — starting an audio-only call");
      } catch (audioErr) {
        host.say(`⚠ could not start call: ${whyMediaFailed(audioErr)}`);
        return;
      }
    }
    inCall = true;
    const local = makeTile("__local__", "you");
    local.muted = true;
    local.srcObject = localStream;
    showBar();
    peer.addLocalMedia(localStream);
    peer.broadcast({ kind: "call-start" });
    host.say("📞 you started a call");
    updateControls();
  }

  function end(): void {
    const peer = host.peer();
    if (peer) { peer.removeLocalMedia(); peer.broadcast({ kind: "call-end" }); }
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    inCall = false;
    removeTile("__local__");
    updateControls();
    hideBarIfIdle();
  }

  return {
    toggle() { if (inCall) end(); else void start(); },
    end,
    toggleMute() {
      const t = localStream?.getAudioTracks()[0];
      if (t) t.enabled = !t.enabled;
      updateControls();
    },
    toggleCam() {
      const t = localStream?.getVideoTracks()[0];
      if (t) t.enabled = !t.enabled;
      updateControls();
    },
    remoteStream(peerId, stream) {
      // Ignore media from AI agents (data-only peers). They don't really stream —
      // werift loops our own audio back, which plays as a strong echo when you
      // are "alone" in a call and spuriously raises the call bar. Humans only.
      if (host.isAgent(peerId)) return;
      let v = tiles.get(peerId);
      if (!v) v = makeTile(peerId, host.label(peerId));
      if (v.srcObject !== stream) v.srcObject = stream;
      showBar();
    },
    peerGone(peerId) { removeTile(peerId); hideBarIfIdle(); },
    inCall: () => inCall,
  };
}

/** Say why getUserMedia refused, in terms of what to do next. */
function whyMediaFailed(err: unknown): string {
  const e = err as DOMException;
  switch (e?.name) {
    case "NotAllowedError":  return "permission denied — click the camera/🔒 icon in the address bar and Allow mic & camera for this site, then retry";
    case "NotFoundError":    return "no microphone or camera was found on this device";
    case "NotReadableError": return "your mic/camera is already in use by another app or tab";
    case "SecurityError":    return "blocked by the browser's permissions policy (needs https:// or localhost)";
    default:                 return e?.message || String(err);
  }
}
