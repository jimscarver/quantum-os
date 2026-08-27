// calls.test.mjs — what a screen share actually sends.
//
// Written after a report from a room with nobody else in it: the camera was
// running, the preview showed it, and sharing refused with "no video is being
// sent". The check had asked the peer connections what they carried, and alone
// there are none — so it confused "nobody is receiving" with "nothing to send".
//
// What matters is not that the code runs but WHAT ENDS UP IN THE STREAM, since
// that stream is what a peer connecting later is given. So the media is stubbed
// and the assertions are about tracks: which one is in the stream we would send,
// and which one each sender carries.
//
//   node packages/browser/test/calls.test.mjs
//
// calls.ts is TypeScript, so it is bundled in-process rather than imported.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "calls.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

// --- stub media -------------------------------------------------------------

class Track {
  constructor(kind, label) { this.kind = kind; this.label = label; this.enabled = true; this._h = {}; }
  stop() { this.stopped = true; }
  addEventListener(n, f) { this._h[n] = f; }
  fire(n) { this._h[n]?.(); }
}
class Stream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); }
  addTrack(t) { this.tracks.push(t); }
  removeTrack(t) { this.tracks = this.tracks.filter((x) => x !== t); }
}
const el = () => ({
  hidden: true, className: "", dataset: {}, style: {}, textContent: "", title: "",
  disabled: false, muted: false, srcObject: null, autoplay: false, playsInline: false,
  children: [], appendChild() {}, addEventListener() {}, closest: () => ({ remove() {} }),
});

// defineProperty, not assignment: node 22 defines `navigator` itself as a
// getter-only property, so `globalThis.navigator = …` throws there while
// working fine on node 20. CI runs 22.
const provide = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

provide("document", { createElement: () => el() });
provide("window", { isSecureContext: true });

const camera = new Track("video", "camera");
const mic    = new Track("audio", "mic");
const screen = new Track("video", "screen");
provide("navigator", { mediaDevices: {
  getUserMedia:    async () => new Stream([mic, camera]),
  getDisplayMedia: async () => new Stream([screen]),
} });

// --- the room: one person, nobody connected ---------------------------------

const sentToJoiners = [];      // what addLocalMedia was handed, by track label
let senders = [];              // what the connections carry, when there are any
const peer = {
  peerId: "abc123",
  addLocalMedia(s) { sentToJoiners.push(s.getVideoTracks().map((t) => t.label)); },
  removeLocalMedia() {}, broadcast() {},
  videoSenders() { return senders; },
};
const said = [];
const calls = mod.createCalls(
  { peer: () => peer, say: (t) => said.push(t), label: () => "peer", isAgent: () => false },
  { bar: el(), tiles: el(), mute: el(), cam: el(), share: el() },
);

let failed = 0;
const settle = () => new Promise((r) => setTimeout(r, 20));
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}  (${detail})`); }
};
const lastSent = () => sentToJoiners[sentToJoiners.length - 1] ?? [];

calls.toggle();
await settle();
check("a call starts", calls.inCall(), "not in a call");

// --- alone in the room ------------------------------------------------------
calls.toggleScreen();
await settle();
check("sharing alone is not refused",
      !said.some((s) => s.includes("nothing to share in its place")), said.join(" | "));
check("it says it is sharing", said.some((s) => s.includes("sharing your screen")), said.join(" | "));
check("a joiner would be given the screen", lastSent().includes("screen"), JSON.stringify(sentToJoiners));
check("a joiner would not be given the camera", !lastSent().includes("camera"), JSON.stringify(sentToJoiners));

// --- with somebody connected ------------------------------------------------
let replaced = [];
senders = [{ track: camera, replaceTrack: async (t) => { replaced.push(t?.label ?? null); } }];

calls.toggleScreen();          // stop
await settle();
check("stopping puts the camera back", replaced.includes("camera"), JSON.stringify(replaced));

calls.toggleScreen();          // share again, now with a sender to swap
await settle();
check("with a peer, the sender is swapped rather than renegotiated",
      replaced.includes("screen"), JSON.stringify(replaced));

replaced = [];
screen.fire("ended");          // the browser's own "stop sharing" control
await settle();
check("the browser's stop-sharing restores the camera",
      replaced.includes("camera"), JSON.stringify(replaced));

console.log(failed === 0 ? "\ncalls: all passed" : `\ncalls: ${failed} FAILED`);
process.exit(failed ? 1 : 0);
