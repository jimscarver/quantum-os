// peer.test.mjs — the retry sweep, which has now been wrong twice.
//
// `peer.ts` decides whether two people in a room can reach each other, and it
// had no test. Both of today's failures live here and both were reported from a
// live room rather than caught: a handshake that failed once was never retried,
// and then the retry redialled attempts that were still negotiating, so slow
// paths (phones) could never finish. Neither needs a browser to reproduce —
// only a clock, a socket and a peer connection, all of which are stubs here.
//
//   node packages/browser/test/peer.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// The ZFA kernel is WASM and irrelevant to connecting; stub it at resolve time.
const stubZfa = {
  name: "stub-zfa",
  setup(b) {
    b.onResolve({ filter: /\.\/zfa\.js$/ }, () => ({ path: "zfa-stub", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export const validateCapability = () => true;"
              + "export const generateCapability = (l) => `cap:${l}:0246`;",
      loader: "js",
    }));
  },
};

const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "peer.ts")],
  bundle: true, format: "esm", platform: "node", write: false, plugins: [stubZfa],
});

const provide = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

// --- a clock we control ------------------------------------------------------
let now = 1_000_000;
const realNow = Date.now;
provide("Date", new Proxy(Date, { get: (t, k) => (k === "now" ? () => now : Reflect.get(t, k)) }));
const advance = (ms) => { now += ms; };

// --- a socket that never really opens ---------------------------------------
const sent = [];
class FakeWS {
  static OPEN = 1; static CLOSED = 3; static CLOSING = 2;
  constructor() { this.readyState = 1; FakeWS.last = this; }
  send(data) { sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  addEventListener(n, f) { this[`on${n}`] = f; }
}
provide("WebSocket", FakeWS);

// --- peer connections we can hold in any state -------------------------------
const made = [];
class FakePC {
  constructor() {
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.signalingState = "stable";
    this.localDescription = { sdp: "a=ice-ufrag:AAAA" };
    made.push(this);
  }
  createDataChannel() { return { readyState: "connecting", send() {}, close() {} }; }
  async createOffer() { return { type: "offer", sdp: "a=ice-ufrag:AAAA" }; }
  async createAnswer() { return { type: "answer", sdp: "a=ice-ufrag:BBBB" }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  getSenders() { return []; }
  addTrack() { return {}; }
  close() { this.connectionState = "closed"; }
}
provide("RTCPeerConnection", FakePC);
provide("RTCSessionDescription", class {});

const { QOSPeer } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));

let failed = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}  (${detail})`); }
};
const offersTo = (id) => sent.filter((m) => m.type === "offer" && m.to === id).length;

// --- a peer in a room --------------------------------------------------------
// This peer's id sorts BELOW "zzz…" and above "aaa…", so both the eager and the
// polite path can be exercised against one peer.
const tick = () => new Promise((r) => setTimeout(r, 0));
const deliver = (msg) => FakeWS.last.onmessage?.({ data: JSON.stringify(msg) });

const peer = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "mmm" });
peer.connect();
await tick();                 // the socket is created inside an async open
FakeWS.last.onopen?.();
await tick();                 // handlers are attached after the open resolves
check("joining the room is announced", sent.some((m) => m.type === "join"), JSON.stringify(sent));

deliver({ type: "peers", peers: ["aaa", "zzz"] });
await new Promise((r) => setTimeout(r, 200));   // the join stagger is real time
check("joining dials everyone already in the room", offersTo("aaa") === 1 && offersTo("zzz") === 1,
      `aaa:${offersTo("aaa")} zzz:${offersTo("zzz")}`);

// --- an attempt in flight is left alone --------------------------------------
// This is today's second bug: a connection still negotiating has no open
// channel, and redialling it throws the negotiation away. A phone gathering
// candidates for twenty seconds could never finish.
const before = offersTo("aaa");
advance(30_000);
peer.sweep();
await tick();
check("a connection still negotiating is not redialled", offersTo("aaa") === before,
      `${offersTo("aaa")} vs ${before}`);

// --- until it is clearly stuck ----------------------------------------------
advance(60_000);   // past ATTEMPT_PATIENCE_MS
peer.sweep();
await tick(); await tick();
check("an attempt stuck far too long is retried", offersTo("aaa") === before + 1,
      `${offersTo("aaa")} vs ${before}`);

// --- a failed connection is retried, which is today's first bug --------------
made.forEach((pc) => { pc.connectionState = "failed"; });
const failedAt = offersTo("zzz");
advance(60_000);
peer.sweep();
await tick(); await tick();
check("a failed connection is dialled again", offersTo("zzz") > failedAt,
      `${offersTo("zzz")} vs ${failedAt}`);

// --- both sides retry, and neither waits on the other -------------------------
// Deferring entirely to the lower id assumed the other side also retries, which
// is false whenever builds are mixed — and then nobody dials at all.
const high = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "zzzz" });
high.connect();
await tick();
FakeWS.last.onopen?.();
await tick();
deliver({ type: "peers", peers: ["aaaa"] });
await new Promise((r) => setTimeout(r, 200));
const highBefore = offersTo("aaaa");
made.forEach((pc) => { pc.connectionState = "failed"; });
advance(120_000);
high.sweep();
await tick(); await tick();
check("the higher-id peer retries too, rather than waiting to be dialled",
      offersTo("aaaa") > highBefore, `${offersTo("aaaa")} vs ${highBefore}`);

// --- a peer that left is not chased ------------------------------------------
deliver({ type: "left", peerId: "aaaa" });
const goneAt = offersTo("aaaa");
advance(200_000);
high.sweep();
await tick(); await tick();
check("a peer that left is not dialled", offersTo("aaaa") === goneAt, `${offersTo("aaaa")} vs ${goneAt}`);

Date.now = realNow;
console.log(failed === 0 ? "\npeer: all passed" : `\npeer: ${failed} FAILED`);
process.exit(failed ? 1 : 0);
