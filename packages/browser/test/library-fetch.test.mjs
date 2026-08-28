// library-fetch.test.mjs — what a fetch will and will not accept.
//
// The interesting behaviour is all refusal. A transfer nobody asked for, from
// a peer nobody asked, of a size nobody would wait for, or bytes that are not
// the file they claim to be — each of those has to end with nothing written,
// because the alternative is a peer writing into your storage by sending you a
// message.
//
//   node packages/browser/test/library-fetch.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webcrypto } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "library-fetch.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
});

const provide = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

if (!globalThis.crypto) provide("crypto", webcrypto);
provide("btoa", (s) => Buffer.from(s, "binary").toString("base64"));
provide("atob", (s) => Buffer.from(s, "base64").toString("binary"));

// OPFS, as a map. `openPart` is what a fetch writes through, so this is where
// "nothing was written" is observable.
const parts = new Map();
const opfsDir = {
  async getFileHandle(name) {
    return {
      async createWritable() {
        parts.set(name, []);
        return {
          async write(blob) { parts.get(name).push(blob); },
          async close() {},
        };
      },
      async getFile() {
        const chunks = parts.get(name) ?? [];
        const bytes = Buffer.concat(await Promise.all(
          chunks.map(async (c) => Buffer.from(await c.arrayBuffer()))));
        return Object.assign(new Blob([bytes]), { name });
      },
    };
  },
  async removeEntry(name) { parts.delete(name); },
  async *keys() { for (const k of parts.keys()) yield k; },
};
provide("navigator", {
  storage: { getDirectory: async () => ({ getDirectoryHandle: async () => opfsDir }) },
});

const mod = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));

// --- the room ----------------------------------------------------------------
const sent = [];
const peer = {
  peerId: "cap:peer:me",
  send: (to, env) => { sent.push({ to, env }); return true; },
  hasChannel: () => true,
  maxBufferedAmount: () => 0,
};
const said = [];
const kept = [];
const held = new Map();
const fetcher = mod.createLibraryFetch({
  peer: () => peer,
  say: (t) => said.push(t),
  label: (id) => id.slice(-3),
  bytesFor: async (h) => held.get(h) ?? null,
  received: async (hash, file, name) => { kept.push({ hash, name, size: file.size }); },
});

let failed = 0;
const settle = () => new Promise((r) => setTimeout(r, 30));
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}  (${detail})`); }
};

const sha = async (buf) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (buf) => Buffer.from(buf).toString("base64");

const body = Buffer.from("the recording itself, imagine it is longer");
const HASH = await sha(body);
const OTHER = await sha(Buffer.from("different bytes entirely"));

// --- a fetch nobody asked for -------------------------------------------------
fetcher.inbound("cap:peer:them", { kind: "lib-head", hash: HASH, name: "surprise.wav", size: body.length, total: 1 });
await settle();
check("an unrequested transfer opens nothing", parts.size === 0, [...parts.keys()].join(","));

// --- asking --------------------------------------------------------------------
fetcher.want(HASH, "cap:peer:them", "interview.wav");
check("asking sends a want to that peer",
      sent.some((s) => s.env.kind === "lib-want" && s.to === "cap:peer:them"), JSON.stringify(sent));
check("and says so", said.some((t) => t.includes("asked")), said.join(" | "));

// --- a head from someone else ---------------------------------------------------
fetcher.inbound("cap:peer:stranger", { kind: "lib-head", hash: HASH, name: "interview.wav", size: body.length, total: 1 });
await settle();
check("a stranger cannot answer the ask", parts.size === 0, [...parts.keys()].join(","));

// --- too big ---------------------------------------------------------------------
fetcher.inbound("cap:peer:them", { kind: "lib-head", hash: HASH, name: "huge.wav", size: mod.FETCH_MAX + 1, total: 10 });
await settle();
check("a transfer past the limit is refused",
      parts.size === 0 && said.some((t) => t.includes("over the")), said.join(" | "));

// --- the real thing ---------------------------------------------------------------
fetcher.inbound("cap:peer:them", { kind: "lib-head", hash: HASH, name: "interview.wav", size: body.length, total: 1 });
await settle();
check("the asked-for transfer is opened", parts.size === 1, [...parts.keys()].join(","));
fetcher.inbound("cap:peer:them", { kind: "lib-part", hash: HASH, seq: 0, data: b64(body) });
await settle();
check("it is kept once it is complete", kept.length === 1 && kept[0].hash === HASH, JSON.stringify(kept));
check("and says it was verified", said.some((t) => t.includes("verified and held")), said.join(" | "));

// --- bytes that are not the file --------------------------------------------------
said.length = 0; kept.length = 0;
fetcher.want(OTHER, "cap:peer:them", "song.mp3");
fetcher.inbound("cap:peer:them", { kind: "lib-head", hash: OTHER, name: "song.mp3", size: body.length, total: 1 });
await settle();
fetcher.inbound("cap:peer:them", { kind: "lib-part", hash: OTHER, seq: 0, data: b64(body) });   // wrong bytes
await settle();
check("bytes that do not hash to what was asked for are not kept", kept.length === 0, JSON.stringify(kept));
check("and it says which is which",
      said.some((t) => t.includes("is not what was asked for")), said.join(" | "));
check("nothing is left on disk", parts.size === 0, [...parts.keys()].join(","));

// --- a chunk out of order ----------------------------------------------------------
said.length = 0;
fetcher.want(HASH, "cap:peer:them", "interview.wav");
fetcher.inbound("cap:peer:them", { kind: "lib-head", hash: HASH, name: "interview.wav", size: body.length, total: 2 });
await settle();
fetcher.inbound("cap:peer:them", { kind: "lib-part", hash: HASH, seq: 1, data: b64(body) });
await settle();
check("a gap in an ordered stream ends the fetch",
      said.some((t) => t.includes("arrived where")), said.join(" | "));
check("and leaves nothing behind", parts.size === 0, [...parts.keys()].join(","));

// --- serving what we hold ----------------------------------------------------------
sent.length = 0;
// A File in the browser; here, a Blob with the two fields the sender reads.
const asFile = (buf, name, type) => {
  const b = new Blob([buf], { type });
  Object.defineProperty(b, "name", { value: name });
  return b;
};
held.set(HASH, asFile(body, "interview.wav", "audio/wav"));
fetcher.inbound("cap:peer:asker", { kind: "lib-want", hash: HASH });
await settle();
check("a hash we hold is answered with a head and its parts",
      sent.some((s) => s.env.kind === "lib-head") && sent.some((s) => s.env.kind === "lib-part"),
      JSON.stringify(sent.map((s) => s.env.kind)));

sent.length = 0;
fetcher.inbound("cap:peer:asker", { kind: "lib-want", hash: OTHER });
await settle();
check("a hash we do not hold is denied, not ignored",
      sent.some((s) => s.env.kind === "lib-deny"), JSON.stringify(sent.map((s) => s.env.kind)));

console.log(failed === 0 ? "\nlibrary-fetch: all passed" : `\nlibrary-fetch: ${failed} FAILED`);
process.exit(failed ? 1 : 0);
