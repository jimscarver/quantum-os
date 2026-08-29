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
      // Unique per call: two tabs minting the same id would hide the very
      // collision this file is here to rule out.
      contents: "let n = 0;"
              + "export const validateCapability = (t) => typeof t === 'string' && t.startsWith('cap:');"
              + "export const generateCapability = (l) => `cap:${l}:${(++n).toString().padStart(4,'0')}`;",
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
  close() {
    this.connectionState = "closed";
    // A browser fires the state handler on close; that is what made a retry
    // look like the peer leaving.
    this.onconnectionstatechange?.();
  }
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

// --- an identity that survives a phone discarding the tab ---------------------
// sessionStorage is per-tab, which is right, but a mobile browser throws it away
// when it evicts a backgrounded tab — so a phone came back as a NEW peer every
// time and the room filled with ghosts of its previous incarnations.
const session = new Map();
const local = new Map();
provide("sessionStorage", {
  getItem: (k) => session.get(k) ?? null,
  setItem: (k, v) => session.set(k, String(v)),
});
provide("localStorage", {
  getItem: (k) => local.get(k) ?? null,
  setItem: (k, v) => local.set(k, String(v)),
  key: (i) => [...local.keys()][i] ?? null,
  get length() { return local.size; },
});

const first = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246" });
check("an id is leased when it is minted",
      [...local.keys()].some((k) => k.endsWith(first.peerId)), [...local.keys()].join(","));

session.clear();                       // the phone discarded the tab
advance(60_000);                       // and stayed away long enough
const back = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246" });
check("a tab that comes back reclaims its own id rather than becoming a stranger",
      back.peerId === first.peerId, `${back.peerId} vs ${first.peerId}`);

session.clear();
local.set(`qos-peer-lease:${first.peerId}`, String(now));   // the other tab is alive
const second = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246" });
check("a second tab open at the same time gets its own id",
      second.peerId !== first.peerId, `${second.peerId} vs ${first.peerId}`);
first.disconnect(); back.disconnect(); second.disconnect();

// --- a peer in a room --------------------------------------------------------
// This peer's id sorts BELOW "zzz…" and above "aaa…", so both the eager and the
// polite path can be exercised against one peer.
const tick = () => new Promise((r) => setTimeout(r, 0));
const deliver = (msg) => FakeWS.last.onmessage?.({ data: JSON.stringify(msg) });

const left = [];
const peer = new QOSPeer({
  signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "mmm",
  onPeerLeft: (id) => left.push(id),
});
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

// --- a retry is not a departure ----------------------------------------------
// Closing the old connection fires its handlers, which declared the peer gone —
// so every retry manufactured a "left", and the new channel opening
// manufactured a "joined". Peers appeared to flap while nothing had happened.
left.length = 0;
made.forEach((pc) => { pc.connectionState = "failed"; });
advance(200_000);
peer.sweep();
await tick(); await tick();
check("replacing our own connection does not report the peer as gone",
      left.length === 0, JSON.stringify(left));

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

// --- the two rosters can disagree ---------------------------------------------
// A `peers` list replaces this peer's own set wholesale, so somebody the server
// omitted once is dropped here while the room still shows them. Nothing dials
// them, and the room reports a peer no attempt is being made to reach.
deliver({ type: "peers", peers: [] });            // the server forgets somebody
const forgotten = offersTo("aaaa");
advance(200_000);
high.sweep();
await tick(); await tick();
check("a peer dropped from the list is not dialled by the sweep",
      offersTo("aaaa") === forgotten, `${offersTo("aaaa")} vs ${forgotten}`);

high.ensureConnected("aaaa");
await tick(); await tick();
check("but the room can say 'this one, now'", offersTo("aaaa") > forgotten,
      `${offersTo("aaaa")} vs ${forgotten}`);

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
