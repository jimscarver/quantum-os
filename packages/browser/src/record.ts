// record.ts — record exactly what is on your screen, with the room's audio.
//
// Not a call feature: it captures the screen, so it records whatever you had up
// — tiles, chat, sidebar, another window entirely — and works with no call in
// progress. That is also why it is not a composite of the call tiles: the
// browser already lays the room out, and what you are looking at is the thing
// worth keeping.
//
// TWO CONSTRAINTS SHAPE EVERYTHING HERE.
//
// 1. Memory, not disk. The usual shape pushes every chunk into an array and
//    builds one Blob at the end, which holds the whole recording in RAM: at the
//    default bitrate that is ~1 GB/hour, on machines that do not have it. So
//    each chunk is written to a file in the origin's private filesystem (OPFS)
//    as it arrives and memory stays flat. At the end the file is handed to the
//    download as a File — object URLs are backed by the file, so the bytes
//    never come back through JS either.
//
// 2. One user gesture. `getDisplayMedia` consumes it, so `showSaveFilePicker`
//    cannot also run on the same click — that is the other reason for OPFS,
//    which needs no gesture at all. The browser's own download is where the
//    user chooses a home for it, after the fact.
//
// Screen content is mostly static frames, so a low frame rate and a modest
// bitrate cost it very little and save a great deal.

import { preferredSurface, rememberSurface } from "./display.js";

/** What recording needs from the app. */
export interface RecordHost {
  /** Put a line in the transcript. */
  say(text: string): void;
  /** Tell the room a recording started or stopped — nobody should be recorded silently. */
  announce(on: boolean): void;
  /**
   * The call's live audio. Capturing a window offers no audio at all, and even
   * a tab share only carries the room because its voices come out of the page —
   * but the app is holding those streams, so they can be mixed in directly and
   * the recording has the room on it whatever surface you picked.
   */
  callAudio(): MediaStreamTrack[];
}

export interface Recorder {
  /** Start if idle, stop and save if recording. */
  toggle(): void;
  /** A peer's media arrived mid-recording: mix their voice in from here on. */
  addAudio(stream: MediaStream): void;
  recording(): boolean;
}

/** Same as calls.ts: ask for the echo canceller explicitly rather than hope. */
const AUDIO: MediaTrackConstraints = {
  echoCancellation: true, noiseSuppression: true, autoGainControl: true,
};

const FPS = 15;
const VIDEO_BPS = 1_200_000;   // ~540 MB/hour, ample for screen content
const AUDIO_BPS = 128_000;
const CHUNK_MS = 1000;         // how often bytes reach the file

// First one the browser will actually encode. Safari has no webm, hence mp4.
const FORMATS = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

/** One scratch file, truncated at each start, so at most one recording is held. */
const SCRATCH = "qos-recording";

// OPFS is newer than the DOM lib this project builds against.
type Writable = { write(d: Blob): Promise<void>; close(): Promise<void>; };
type FileHandle = {
  createWritable(o?: { keepExistingData?: boolean }): Promise<Writable>;
  getFile(): Promise<File>;
};
type Dir = { getFileHandle(n: string, o?: { create?: boolean }): Promise<FileHandle>; };

export function createRecorder(host: RecordHost, btn: HTMLElement | null): Recorder {
  let rec: MediaRecorder | null = null;
  /** Everything acquired for this recording, all of it stopped at the end. */
  let sources: MediaStreamTrack[] = [];
  let audioCtx: AudioContext | null = null;
  let mixDest: MediaStreamAudioDestinationNode | null = null;
  /** Tracks already in the mix — a renegotiation re-delivers a peer's stream. */
  const mixed = new Set<string>();
  let handle: FileHandle | null = null;
  let file: Writable | null = null;
  /** Chunks only live here when there is no file to stream them to. */
  let parts: Blob[] = [];
  /** Writes are serialized: a chunk can arrive while the last is still going. */
  let writes: Promise<void> = Promise.resolve();
  let bytes = 0;
  let startedAt = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let ext = "webm";

  const mb = (n: number) => (n / 1_048_576).toFixed(n < 10_485_760 ? 1 : 0);
  const clock = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  function paint(): void {
    if (!btn) return;
    const ico = btn.querySelector(".ico");
    const lab = btn.querySelector(".act-label");
    const t = rec ? clock(Date.now() - startedAt) : "";
    if (ico) ico.textContent = rec ? "\u23f9" : "\u23fa";
    if (lab) lab.textContent = rec ? t : "Record";
    btn.title = rec
      ? `Recording — ${t}, ${mb(bytes)} MB. Click to stop and save.`
      : "Record your screen with audio";
    btn.classList.toggle("recording", !!rec);
  }

  /**
   * One audio track out of however many we have: your mic, the call's other
   * voices, and the surface's own audio where the picker offered it.
   *
   * Everything goes through the mixer even when there is only one source, so a
   * peer who joins after the recording started can still be added to it.
   */
  function beginMix(tracks: MediaStreamTrack[]): MediaStreamTrack | null {
    if (tracks.length === 0) return null;
    audioCtx = new AudioContext();
    mixDest = audioCtx.createMediaStreamDestination();
    mixed.clear();
    tracks.forEach(addToMix);
    return mixDest.stream.getAudioTracks()[0] ?? null;
  }

  function addToMix(t: MediaStreamTrack): void {
    if (!audioCtx || !mixDest || mixed.has(t.id)) return;
    mixed.add(t.id);
    audioCtx.createMediaStreamSource(new MediaStream([t])).connect(mixDest);
  }

  /** The scratch file, or null where OPFS is unavailable (then memory it is). */
  async function openScratch(): Promise<void> {
    const storage = (navigator as unknown as { storage?: { getDirectory?(): Promise<Dir> } }).storage;
    if (!storage?.getDirectory) return;
    try {
      const dir = await storage.getDirectory();
      handle = await dir.getFileHandle(`${SCRATCH}.${ext}`, { create: true });
      // Truncating is what frees the previous recording's bytes.
      file = await handle.createWritable({ keepExistingData: false });
    } catch {
      handle = null; file = null;
    }
  }

  async function start(): Promise<void> {
    if (rec) return;
    if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === "undefined") {
      host.say("⚠ this browser cannot record (getDisplayMedia or MediaRecorder is unavailable)");
      return;
    }
    const mimeType = FORMATS.find((m) => MediaRecorder.isTypeSupported(m));
    if (!mimeType) { host.say("⚠ this browser offers no recording format"); return; }
    ext = mimeType.startsWith("video/mp4") ? "mp4" : "webm";

    let display: MediaStream;
    try {
      // `audio: true` is what makes the room audible — it is the picker's
      // "share tab audio" box, and only a tab share offers it on Linux.
      //
      // `displaySurface` only says which pane the picker opens on, and "window"
      // is where people are going: Chrome opens on the tab list otherwise, so
      // every recording of an application costs an extra click. Switching pane
      // is still one click, and `surfaceSwitching` lets it change mid-recording.
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: FPS, displaySurface: preferredSurface() },
        audio: true,
        surfaceSwitching: "include",
      } as DisplayMediaStreamOptions);
    } catch (e) {
      // Cancelling the picker is an ordinary thing to do, not an error.
      if ((e as DOMException)?.name !== "NotAllowedError") {
        host.say(`⚠ could not start recording: ${(e as Error)?.message || String(e)}`);
      }
      return;
    }
    const video = display.getVideoTracks()[0];
    if (!video) { display.getTracks().forEach((t) => t.stop()); return; }
    rememberSurface(video);
    sources = display.getTracks();

    // A recording with no mic is worth having; one that refuses to start
    // because a laptop has no mic is not.
    let mic: MediaStreamTrack | null = null;
    try {
      const m = await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
      mic = m.getAudioTracks()[0] ?? null;
      if (mic) sources.push(mic);
    } catch { /* no mic, carry on */ }

    const shared = display.getAudioTracks();
    // The call's voices come from the call, not from whatever was captured.
    const voices = host.callAudio();
    const audio = beginMix([...shared, ...(mic ? [mic] : []), ...voices]);
    const stream = new MediaStream(audio ? [video, audio] : [video]);

    await openScratch();

    try {
      rec = new MediaRecorder(stream, {
        mimeType, videoBitsPerSecond: VIDEO_BPS, audioBitsPerSecond: AUDIO_BPS,
      });
    } catch (e) {
      host.say(`⚠ could not start recording: ${(e as Error)?.message || String(e)}`);
      await discard();
      return;
    }
    bytes = 0; parts = []; writes = Promise.resolve();
    rec.ondataavailable = (e) => {
      if (!e.data?.size) return;
      bytes += e.data.size;
      // Straight to the file, in order. Memory stays flat; without one, the
      // chunk has nowhere else to go.
      if (file) writes = writes.then(() => file!.write(e.data)).catch(() => {});
      else parts.push(e.data);
    };
    rec.onstop = () => { void finish(); };
    rec.start(CHUNK_MS);
    // The browser's own "Stop sharing" ends the track without telling us.
    video.addEventListener("ended", () => { if (rec) stop(); });

    startedAt = Date.now();
    ticker = setInterval(paint, 1000);
    paint();
    host.announce(true);
    const on = ["your mic"];
    if (voices.length) on.push(`${voices.length} voice${voices.length === 1 ? "" : "s"} from the call`);
    if (shared.length) on.push("the captured audio");
    host.say(`⏺ recording your screen — ${on.join(" + ")} on it. Click ⏹ to stop and save.`);
  }

  function stop(): void {
    if (!rec) return;
    if (rec.state !== "inactive") rec.stop();   // → onstop → finish()
    else void finish();
  }

  /** Stop everything acquired, whether or not there is anything to save. */
  async function release(): Promise<void> {
    sources.forEach((t) => t.stop());
    sources = [];
    if (audioCtx) { await audioCtx.close().catch(() => {}); audioCtx = null; }
    mixDest = null; mixed.clear();
    if (ticker) { clearInterval(ticker); ticker = null; }
  }

  async function discard(): Promise<void> {
    rec = null;
    await release();
    try { await file?.close(); } catch { /* nothing written */ }
    file = null; handle = null; parts = [];
    paint();
  }

  async function finish(): Promise<void> {
    const took = clock(Date.now() - startedAt);
    const size = bytes;
    rec = null;
    await release();

    let blob: Blob | null = null;
    if (file) {
      try { await writes; await file.close(); } catch { /* keep what landed */ }
      // A File from the handle, not a Blob built in memory: the download reads
      // it off disk, so an hour-long recording never occupies RAM.
      try { blob = (await handle?.getFile()) ?? null; } catch { blob = null; }
    } else if (parts.length) {
      blob = new Blob(parts, { type: parts[0].type });
    }
    file = null; parts = [];

    if (!blob || blob.size === 0) {
      host.say("⏹ recording stopped — nothing was captured");
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `qos-${stamp}.${ext}`;
      a.click();
      // Late enough for the download to have taken the file, soon enough not
      // to strand it: the URL is a handle, not a copy.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      host.say(`⏹ recording stopped — ${took}, ${mb(size)} MB, saved as ${a.download}`);
    }
    host.announce(false);
    paint();
  }

  paint();
  return {
    toggle() { if (rec) stop(); else void start(); },
    addAudio(stream) { if (rec) stream.getAudioTracks().forEach(addToMix); },
    recording: () => !!rec,
  };
}
