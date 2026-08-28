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
// Enough of an element to hold a tree: the tiles are looked up through it
// (`video.closest(".call-tile")`, `wrap.querySelector(".call-name")`), so a
// stub that answers those with throwaways would assert nothing.
const docHandlers = {};
const el = () => {
  const classes = new Set();
  const node = {
    hidden: true, dataset: {}, style: {}, textContent: "", title: "",
    disabled: false, muted: false, srcObject: null, autoplay: false, playsInline: false,
    children: [], parent: null, handlers: {},
    get className() { return [...classes].join(" "); },
    set className(v) { classes.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c); },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    appendChild(kid) { kid.parent = node; node.children.push(kid); return kid; },
    append(...kids) { kids.forEach((k) => node.appendChild(k)); },
    remove() { node.parent = null; },
    addEventListener(n, f) { node.handlers[n] = f; },
    fire(n, ev = {}) { node.handlers[n]?.({ stopPropagation() {}, preventDefault() {}, ...ev }); },
    querySelector(sel) {
      const want = sel.replace(".", "");
      const hit = node.children.find((k) => k.classList.contains(want));
      return hit ?? node.children.map((k) => k.querySelector(sel)).find(Boolean) ?? null;
    },
    closest(sel) {
      const want = sel.replace(".", "");
      for (let n = node; n; n = n.parent) if (n.classList.contains(want)) return n;
      return null;
    },
  };
  return node;
};

// defineProperty, not assignment: node 22 defines `navigator` itself as a
// getter-only property, so `globalThis.navigator = …` throws there while
// working fine on node 20. CI runs 22.
const provide = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

provide("document", { createElement: () => el(), addEventListener(n, f) { docHandlers[n] = f; } });
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
const sentEnvelopes = [];      // what went out on the wire
let senders = [];              // what the connections carry, when there are any
const peer = {
  peerId: "abc123",
  addLocalMedia(s) { sentToJoiners.push(s.getVideoTracks().map((t) => t.label)); },
  removeLocalMedia() {}, broadcast(env) { sentEnvelopes.push(env); },
  videoSenders() { return senders; },
};
const said = [];
const tilesEl = el();
const calls = mod.createCalls(
  { peer: () => peer, say: (t) => said.push(t), label: () => "peer", isAgent: () => false },
  { bar: el(), tiles: tilesEl, mute: el(), cam: el(), share: el() },
);
const tileFor = (key) => tilesEl.children.find((c) => c.dataset.key === key);

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

// --- a screen is not a thumbnail --------------------------------------------
// 160×120 is unreadable for a shared screen, so the tile says what it is (the
// caption, and `contain` instead of `cover` via the data attribute) and the
// far side is told, since a receiver cannot tell a screen from a face by
// looking at the track.
const localTile = () => tileFor("__local__");

calls.toggleScreen();          // share once more
await settle();
check("the local tile knows it is a screen", localTile()?.dataset.screen === "1",
      JSON.stringify(localTile()?.dataset));
check("and says so", localTile()?.querySelector(".call-name")?.textContent === "you — screen",
      localTile()?.querySelector(".call-name")?.textContent);
check("the room is told a screen started",
      sentEnvelopes.some((e) => e.kind === "call-screen" && e.on === true),
      JSON.stringify(sentEnvelopes));

calls.toggleScreen();          // stop
await settle();
check("the room is told it stopped",
      sentEnvelopes.some((e) => e.kind === "call-screen" && e.on === false),
      JSON.stringify(sentEnvelopes));
check("and the tile is a face again", localTile()?.dataset.screen === undefined,
      JSON.stringify(localTile()?.dataset));

// --- somebody else shares ----------------------------------------------------
// The announce and the track race, so the announce lands first here — the tile
// does not exist yet, and it still has to end up big when the track arrives.
calls.peerScreen("bob", true);
calls.remoteStream("bob", new Stream([new Track("video", "bob-screen")]));
check("their screen comes up big", tileFor("bob")?.classList.contains("expanded"),
      tileFor("bob")?.className);
check("and is not cropped", tileFor("bob")?.dataset.screen === "1",
      JSON.stringify(tileFor("bob")?.dataset));

docHandlers.keydown?.({ key: "Escape" });
check("Esc shrinks it", !tileFor("bob")?.classList.contains("expanded"), tileFor("bob")?.className);

tileFor("bob")?.fire("click");
check("clicking the tile brings it back", tileFor("bob")?.classList.contains("expanded"),
      tileFor("bob")?.className);

calls.peerScreen("bob", false);
check("when they stop sharing it shrinks", !tileFor("bob")?.classList.contains("expanded"),
      tileFor("bob")?.className);
check("only one tile is ever big",
      tilesEl.children.filter((c) => c.classList.contains("expanded")).length === 0,
      tilesEl.children.map((c) => c.className).join(" | "));


console.log(failed === 0 ? "\ncalls: all passed" : `\ncalls: ${failed} FAILED`);
process.exit(failed ? 1 : 0);
