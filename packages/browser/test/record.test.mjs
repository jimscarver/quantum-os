// record.test.mjs — where the bytes go.
//
// The whole point of this module is that a recording does NOT accumulate in
// memory: at the default bitrate an hour is about a gigabyte, and the machines
// this runs on do not have it. That property is invisible from the outside —
// a version that buffers everything behaves identically until it dies — so it
// is what these assertions are about: every chunk reaches the file as it
// arrives, and what gets downloaded is the file itself rather than a Blob
// rebuilt from the pieces.
//
//   node packages/browser/test/record.test.mjs
//
// record.ts is TypeScript, so it is bundled in-process rather than imported.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "record.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

// --- stubs ------------------------------------------------------------------

const provide = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

const allTracks = [];
class Track {
  constructor(kind, label) { this.kind = kind; this.label = label; this._h = {}; allTracks.push(this); }
  stop() { this.stopped = true; }
  addEventListener(n, f) { this._h[n] = f; }
  fire(n) { this._h[n]?.(); }
}
class Stream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return this.tracks.slice(); }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); }
}
provide("MediaStream", Stream);

// The scratch file: every write is kept so the test can see chunks land as they
// arrive rather than in one lump at the end.
let scratch = null;
const makeScratch = () => ({
  writes: [], closed: false, truncated: null, size: 0,
  fileHandedOut: null,
  createWritable(o) {
    this.truncated = o?.keepExistingData === false;
    const self = this;
    return Promise.resolve({
      async write(d) { self.writes.push(d); self.size += d.size; },
      async close() { self.closed = true; },
    });
  },
  async getFile() {
    // Identity matters: this object is what should reach the download.
    this.fileHandedOut = { size: this.size, opfs: true };
    return this.fileHandedOut;
  },
});

let opfs = true;
provide("navigator", {
  storage: {
    getDirectory: async () => {
      if (!opfs) throw new Error("no OPFS here");
      scratch = makeScratch();
      return { getFileHandle: async () => scratch };
    },
  },
  mediaDevices: {
    getDisplayMedia: async () => displayAnswer(),
    getUserMedia: async () => micAnswer(),
  },
});

let recorder = null;                 // the live MediaRecorder stub
class FakeRecorder {
  static isTypeSupported(m) { return m === "video/webm;codecs=vp9,opus"; }
  constructor(stream, opts) {
    this.stream = stream; this.opts = opts; this.state = "recording";
    recorder = this;
  }
  start(ms) { this.timeslice = ms; }
  stop() { this.state = "inactive"; this.onstop?.(); }
  /** A second of video arrives. */
  chunk(size) { this.ondataavailable?.({ data: { size, type: "video/webm" } }); }
}
provide("MediaRecorder", FakeRecorder);

let mixed = false;
provide("AudioContext", class {
  createMediaStreamDestination() { mixed = true; return { stream: new Stream([new Track("audio", "mix")]) }; }
  createMediaStreamSource() { return { connect() {} }; }
  async close() { this.closed = true; }
});

const downloads = [];
provide("URL", { createObjectURL: (b) => { downloads.push(b); return "blob:x"; }, revokeObjectURL() {} });
provide("Blob", class { constructor(parts) { this.parts = parts; this.size = parts.reduce((n, p) => n + p.size, 0); } });
provide("document", { createElement: () => ({ click() {}, set href(_v) {}, download: "" }) });

// --- the room ---------------------------------------------------------------

const said = [];
const announced = [];
let btnClasses = new Set();
const btn = {
  title: "", classList: { toggle: (c, on) => (on ? btnClasses.add(c) : btnClasses.delete(c)) },
  querySelector: () => ({ textContent: "" }),
};
const host = { say: (t) => said.push(t), announce: (on) => announced.push(on) };

const screenTrack = () => new Track("video", "screen");
let displayAnswer = () => new Stream([screenTrack(), new Track("audio", "tab")]);
let micAnswer = () => new Stream([new Track("audio", "mic")]);

let failed = 0;
const settle = () => new Promise((r) => setTimeout(r, 20));
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}  (${detail})`); }
};

// --- a recording that streams to disk ---------------------------------------

let rec = mod.createRecorder(host, btn);
rec.toggle();
await settle();
check("it records", rec.recording(), "not recording");
check("the room is told", announced[0] === true, JSON.stringify(announced));
check("tab audio and mic are mixed together", mixed, "no AudioContext was used");
check("the scratch file is truncated, not appended to", scratch?.truncated === true,
      JSON.stringify(scratch?.truncated));
check("bytes are asked for once a second", recorder.timeslice === 1000, String(recorder.timeslice));

recorder.chunk(4_000_000);
recorder.chunk(4_000_000);
await settle();
check("each chunk goes to the file as it arrives", scratch.writes.length === 2,
      `${scratch.writes.length} writes`);

const held = new Set(downloads);
rec.toggle();                       // stop
await settle();
check("the file is closed", scratch.closed, "left open");
check("the download is the file itself, not a Blob rebuilt from the chunks",
      downloads[downloads.length - 1] === scratch.fileHandedOut,
      JSON.stringify(downloads[downloads.length - 1]));
check("nothing new was assembled in memory", downloads.length === held.size + 1, String(downloads.length));
check("it says what was saved", said.some((s) => s.includes("MB, saved as qos-")), said.join(" | "));
check("the room is told it stopped", announced[announced.length - 1] === false, JSON.stringify(announced));
// Everything acquired, not just what the recorder was handed: the mic is not
// in the recorded stream (its audio arrives through the mix) and would be the
// easy one to leave running with the light on.
const acquired = allTracks.filter((t) => ["screen", "tab", "mic"].includes(t.label));
check("every acquired track is released — screen, tab audio and mic",
      acquired.length === 3 && acquired.every((t) => t.stopped === true),
      acquired.map((t) => `${t.label}:${t.stopped}`).join(" "));

// --- the browser's own "Stop sharing" ---------------------------------------
said.length = 0;
rec.toggle();
await settle();
const video = recorder.stream.getVideoTracks()[0];
recorder.chunk(1_000_000);
video.fire("ended");
await settle();
check("Chrome's own stop-sharing ends the recording", !rec.recording(), "still recording");
check("and it is still saved", said.some((s) => s.includes("saved as qos-")), said.join(" | "));

// --- a machine with no mic ---------------------------------------------------
said.length = 0;
micAnswer = () => { throw new Error("no mic"); };
rec.toggle();
await settle();
check("no mic is not a reason to refuse", rec.recording(), said.join(" | "));
rec.toggle();
await settle();

// --- nobody ticked "share tab audio" ----------------------------------------
said.length = 0;
displayAnswer = () => new Stream([screenTrack()]);
micAnswer = () => new Stream([new Track("audio", "mic")]);
rec.toggle();
await settle();
check("it says how to capture the room's voices",
      said.some((s) => s.includes("Share tab audio")), said.join(" | "));
rec.toggle();
await settle();

// --- no OPFS: memory, but it still works ------------------------------------
said.length = 0;
opfs = false;
rec = mod.createRecorder(host, btn);
rec.toggle();
await settle();
recorder.chunk(2_000_000);
rec.toggle();
await settle();
check("without a file to stream to it still saves",
      said.some((s) => s.includes("saved as qos-")), said.join(" | "));
check("and that one is a Blob of the chunks",
      downloads[downloads.length - 1]?.parts?.length === 1,
      JSON.stringify(downloads[downloads.length - 1]));

// --- cancelling the picker ---------------------------------------------------
said.length = 0;
opfs = true;
displayAnswer = () => { const e = new Error("denied"); e.name = "NotAllowedError"; throw e; };
rec.toggle();
await settle();
check("cancelling the picker is silent", said.length === 0, said.join(" | "));
check("and nothing is recording", !rec.recording(), "still recording");

console.log(failed === 0 ? "\nrecord: all passed" : `\nrecord: ${failed} FAILED`);
process.exit(failed ? 1 : 0);
