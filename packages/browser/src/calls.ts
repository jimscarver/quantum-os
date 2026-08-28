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
import { noScreenCapture } from "./record.js";

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
  share: HTMLButtonElement | null;
}

export interface Calls {
  /** Start if idle, hang up if in a call. */
  toggle(): void;
  end(): void;
  toggleMute(): void;
  toggleCam(): void;
  /** Share the screen, or stop sharing and go back to the camera. */
  toggleScreen(): void;
  /** A peer's media arrived. */
  remoteStream(peerId: string, stream: MediaStream): void;
  /** Every peer's live audio — what a recording needs to have the room on it. */
  audioTracks(): MediaStreamTrack[];
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
  /** The camera track, held while the screen is being shared in its place. */
  let cameraTrack: MediaStreamTrack | null = null;
  let screenStream: MediaStream | null = null;
  let inCall = false;
  const tiles = new Map<string, HTMLVideoElement>();   // "__local__" | peerId → video
  /** What each peer is sending, kept so a recording can mix their voice in. */
  const remote = new Map<string, MediaStream>();
  /** Whether our own tile is carrying the screen rather than the camera. */
  const screens = new Set<string>();
  /** The one tile currently shown big, if any. */
  let expanded: string | null = null;

  const showBar = () => { if (els.bar) els.bar.hidden = false; };
  const hideBarIfIdle = () => {
    if (els.bar && !inCall && tiles.size === 0) els.bar.hidden = true;
  };

  const tileOf = (key: string): HTMLElement | null =>
    tiles.get(key)?.closest(".call-tile") as HTMLElement | null;

  function makeTile(key: string, label: string): HTMLVideoElement {
    const wrap = document.createElement("div");
    wrap.className = "call-tile";
    wrap.dataset.key = key;
    wrap.dataset.label = label;
    const v = document.createElement("video");
    v.autoplay = true; v.playsInline = true;
    const cap = document.createElement("span");
    cap.className = "call-name"; cap.textContent = label;
    // The thumbnail row is the right default — it shows everyone at once and
    // stays out of the way. What it needed was a way out of: any tile can be
    // clicked to fill the window. The button is for discovery; the whole tile
    // is the target.
    const zoom = document.createElement("button");
    zoom.className = "call-zoom"; zoom.textContent = "⛶";
    zoom.title = "Show this big";
    zoom.addEventListener("click", (e) => { e.stopPropagation(); toggleExpand(key); });
    wrap.addEventListener("click", () => toggleExpand(key));
    // Double-click goes to the browser's own full screen, where a shared screen
    // is finally shown at something like its real size.
    wrap.addEventListener("dblclick", (e) => {
      e.preventDefault();
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      else void wrap.requestFullscreen?.().catch(() => {});
    });
    wrap.append(v, cap, zoom);
    els.tiles?.appendChild(wrap);
    tiles.set(key, v);
    if (screens.has(key)) markScreen(key, true);
    return v;
  }

  function removeTile(key: string): void {
    const v = tiles.get(key);
    if (!v) return;
    if (expanded === key) setExpanded(null);
    v.srcObject = null;
    v.closest(".call-tile")?.remove();
    tiles.delete(key);
    screens.delete(key);
  }

  /** Label a tile as a screen, and stop cropping it. */
  function markScreen(key: string, on: boolean): void {
    if (on) screens.add(key); else screens.delete(key);
    const wrap = tileOf(key);
    if (!wrap) return;
    if (on) wrap.dataset.screen = "1"; else delete wrap.dataset.screen;
    const base = wrap.dataset.label ?? "";
    const cap = wrap.querySelector(".call-name");
    if (cap) cap.textContent = on ? `${base} — screen` : base;
  }

  function setExpanded(key: string | null): void {
    if (expanded) {
      const was = tileOf(expanded);
      was?.classList.remove("expanded");
      const btn = was?.querySelector(".call-zoom");
      if (btn) btn.textContent = "⛶";
    }
    expanded = key && tiles.has(key) ? key : null;
    const wrap = expanded ? tileOf(expanded) : null;
    if (wrap) {
      wrap.classList.add("expanded");
      const btn = wrap.querySelector(".call-zoom");
      if (btn) { btn.textContent = "✕"; (btn as HTMLElement).title = "Shrink (Esc)"; }
    }
  }

  const toggleExpand = (key: string) => setExpanded(expanded === key ? null : key);

  // Esc shrinks whatever is big. Full screen swallows its own Esc, so this only
  // ever fires for the in-page version.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && expanded && !document.fullscreenElement) setExpanded(null);
  });

  /** The senders carrying our video — one per peer, all of which a share replaces. */
  function videoSenders(): RTCRtpSender[] {
    return host.peer()?.videoSenders() ?? [];
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
      els.cam.disabled = !hasVideo || !!screenStream;
      els.cam.textContent = !hasVideo ? "🚫" : videoOn ? "🎥" : "🚫";
      els.cam.title = !hasVideo ? "No camera — audio-only call"
        : screenStream ? "Sharing your screen — stop sharing to use the camera"
        : videoOn ? "Turn camera off" : "Turn camera on";
    }
    if (els.share) {
      els.share.disabled = !inCall;
      els.share.textContent = screenStream ? "🛑" : "🖥";
      els.share.title = !inCall ? "Start a call first"
        : screenStream ? "Stop sharing your screen" : "Share your screen";
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
    stopScreenTracks();
    cameraTrack = null;
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    inCall = false;
    removeTile("__local__");
    updateControls();
    hideBarIfIdle();
  }

  function stopScreenTracks(): void {
    screenStream?.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }

  /**
   * Share the screen in place of the camera.
   *
   * `localStream` is the truth of what we are sending: existing connections
   * carry its tracks, and a peer that connects later is given them
   * (`QOSPeer` re-adds from its own reference to the same object). So sharing
   * swaps the track *in that stream* and not only on the senders — otherwise
   * whoever joined next would get the camera while everyone already here saw
   * the screen.
   *
   * On senders that already carry video, `replaceTrack` does it with no
   * renegotiation and nothing torn down. Where there is no video sender — an
   * audio-only call, or nobody connected yet — the track is new to the
   * connection, so `addLocalMedia` negotiates it.
   *
   * Being alone is not a reason to refuse. The camera runs, the preview shows
   * it, and there is simply nobody receiving yet; sharing has to work then too,
   * or it fails exactly when someone sets up before a call.
   *
   * The cost of this shape is that it is a swap: you cannot send your face and
   * your screen at once. That wants a second track and per-track tile identity,
   * which is a bigger change than the button is worth today.
   */
  async function startScreen(): Promise<void> {
    if (!inCall) { host.say("start a call before sharing your screen"); return; }
    if (screenStream) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      host.say(noScreenCapture("share"));
      return;
    }
    try {
      // No `displaySurface`: Chrome treats it as a filter on what the picker
      // returns rather than a hint about where it opens, so naming one takes
      // the choice away from the person making it.
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        surfaceSwitching: "include",
      } as DisplayMediaStreamOptions);
    } catch (e) {
      // Cancelling the picker is an ordinary thing to do, not an error to report.
      if ((e as DOMException)?.name !== "NotAllowedError") {
        host.say(`⚠ could not share the screen: ${whyMediaFailed(e)}`);
      }
      return;
    }
    const track = screenStream.getVideoTracks()[0];
    if (!track) { stopScreenTracks(); return; }

    // Swap it into what we are sending, keeping the camera track to put back.
    cameraTrack = localStream?.getVideoTracks()[0] ?? null;
    if (localStream) {
      if (cameraTrack) localStream.removeTrack(cameraTrack);
      localStream.addTrack(track);
    }
    const senders = videoSenders();
    if (senders.length) {
      await Promise.all(senders.map((s) => s.replaceTrack(track).catch(() => {})));
    } else if (localStream) {
      // No video sender to swap — the track is new to every connection.
      host.peer()?.addLocalMedia(localStream);
    }

    // The browser's own "stop sharing" control ends the track without telling us.
    track.addEventListener("ended", () => { void stopScreen(); });
    const local = tiles.get("__local__");
    if (local && localStream) local.srcObject = localStream;
    markScreen("__local__", true);
    const kind = (track.getSettings?.() as { displaySurface?: string } | undefined)?.displaySurface;
    host.say(`🖥 you are sharing ${kind === "monitor" ? "your entire screen"
      : kind === "window" ? "one window" : kind === "browser" ? "one browser tab" : "your screen"}`);
    updateControls();
  }

  async function stopScreen(): Promise<void> {
    if (!screenStream) return;
    const shared = screenStream.getVideoTracks()[0] ?? null;
    stopScreenTracks();
    if (localStream) {
      if (shared) localStream.removeTrack(shared);
      if (cameraTrack) localStream.addTrack(cameraTrack);
    }
    // `replaceTrack(null)` where there is no camera: stop sending video rather
    // than leaving the far side on a frozen last frame of the screen.
    const cam = cameraTrack;
    await Promise.all(videoSenders().map((s) => s.replaceTrack(cam).catch(() => {})));
    cameraTrack = null;
    const local = tiles.get("__local__");
    if (local && localStream) local.srcObject = localStream;
    markScreen("__local__", false);
    if (expanded === "__local__") setExpanded(null);
    if (inCall) host.say("🖥 you stopped sharing your screen");
    updateControls();
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
    toggleScreen() { if (screenStream) void stopScreen(); else void startScreen(); },
    remoteStream(peerId, stream) {
      // Ignore media from AI agents (data-only peers). They don't really stream —
      // werift loops our own audio back, which plays as a strong echo when you
      // are "alone" in a call and spuriously raises the call bar. Humans only.
      if (host.isAgent(peerId)) return;
      let v = tiles.get(peerId);
      if (!v) v = makeTile(peerId, host.label(peerId));
      if (v.srcObject !== stream) v.srcObject = stream;
      remote.set(peerId, stream);
      showBar();
    },
    audioTracks() {
      return [...remote.values()].flatMap((s) => s.getAudioTracks());
    },
    peerGone(peerId) { remote.delete(peerId); removeTile(peerId); hideBarIfIdle(); },
    inCall: () => inCall,
  };
}

/** Say why getUserMedia/getDisplayMedia refused, in terms of what to do next. */
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
