// library.test.mjs — the index, and what it refuses.
//
// Every entry arrives from a peer, so the module's real job is saying no: a
// hash that is not a hash, a size that is not a size, a name long enough to be
// an attack on the sidebar. The rest is the ordering every peer has to agree
// on and the lookup that must not guess between two files.
//
//   node packages/browser/test/library.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webcrypto } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "library.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
});
const lib = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

let failed = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}  (${detail})`); }
};

const H = (n) => String(n).repeat(64).slice(0, 64);
const entry = (over = {}) => ({
  hash: H("a"), name: "interview.wav", mime: "audio/wav", size: 1024,
  addedBy: "cap:peer:1", addedLabel: "Jim", at: 1000, ...over,
});

// --- the name is the content -------------------------------------------------
const bytes = new Blob([new Uint8Array([1, 2, 3, 4])]);
const h1 = await lib.hashBlob(bytes);
const h2 = await lib.hashBlob(new Blob([new Uint8Array([1, 2, 3, 4])]));
check("the same bytes hash the same, whoever holds them", h1 === h2, `${h1} vs ${h2}`);
check("and it is a sha-256", /^[0-9a-f]{64}$/.test(h1), h1);
const other = await lib.hashBlob(new Blob([new Uint8Array([1, 2, 3, 5])]));
check("different bytes do not", h1 !== other, "collision");

// --- what it refuses ---------------------------------------------------------
check("an entry survives the wire", lib.entryFromWire(entry())?.name === "interview.wav", "lost");
check("a hash that is not one is refused", lib.entryFromWire(entry({ hash: "nope" })) === null, "accepted");
check("a truncated hash is refused", lib.entryFromWire(entry({ hash: "abc" })) === null, "accepted");
check("an uppercase hash is normalized, not refused",
      lib.entryFromWire(entry({ hash: H("A") }))?.hash === H("a"), "refused or left uppercase");
check("a negative size is refused", lib.entryFromWire(entry({ size: -1 })) === null, "accepted");
check("a size that is not a number is refused", lib.entryFromWire(entry({ size: "big" })) === null, "accepted");
check("a nameless entry is refused", lib.entryFromWire(entry({ name: "   " })) === null, "accepted");
check("an overlong name is cut, not refused",
      lib.entryFromWire(entry({ name: "x".repeat(500) }))?.name.length === 200, "not clamped");
check("a cap that is not a cap is dropped",
      lib.entryFromWire(entry({ cap: "javascript:alert(1)" }))?.cap === undefined, "kept");
check("a real cap is kept",
      lib.entryFromWire(entry({ cap: "cap:library:0246" }))?.cap === "cap:library:0246", "dropped");

// --- an order every peer agrees on -------------------------------------------
const many = [
  entry({ hash: H("b"), at: 2000 }),
  entry({ hash: H("a"), at: 3000 }),
  entry({ hash: H("c"), at: 2000 }),
];
const sorted = lib.sortEntries(many).map((e) => e.hash[0]);
check("newest first, ties broken by hash so every peer lists the same",
      sorted.join("") === "abc", sorted.join(""));

// --- the lookup must not guess ------------------------------------------------
const set = [
  entry({ hash: H("a"), name: "interview.wav" }),
  entry({ hash: H("b"), name: "interview-2.wav" }),
  entry({ hash: H("c"), name: "song.mp3" }),
];
check("a full hash finds it", lib.findEntry(set, H("a"))?.name === "interview.wav", "missed");
check("a prefix finds it", lib.findEntry(set, "ccc")?.name === "song.mp3", "missed");
check("an exact name wins over a partial one",
      lib.findEntry(set, "interview.wav")?.hash === H("a"), "matched the wrong one");
check("an ambiguous partial name refuses rather than picks",
      lib.findEntry(set, "interview") === null, "guessed");
check("nothing matching is null", lib.findEntry(set, "nowhere") === null, "invented one");
check("an empty needle is null", lib.findEntry(set, "  ") === null, "matched something");

// --- can it actually be had? --------------------------------------------------
// The states have to be distinguishable, because they are what stops a library
// from being a list of broken links.
const now = 1_000_000_000_000;
const day = 24 * 60 * 60 * 1000;
check("holding it beats every other state",
      lib.availabilityOf(H("a"), true, 0, undefined, now) === "held", "not held");
check("a peer here holding it is available now",
      lib.availabilityOf(H("a"), false, 2, now - day, now) === "here", "not here");
check("no holder present, but seen recently, is known",
      lib.availabilityOf(H("a"), false, 0, now - day, now) === "known", "not known");
check("no holder for a week is gone",
      lib.availabilityOf(H("a"), false, 0, now - 8 * day, now) === "gone", "not gone");
check("a holder never seen at all is gone, not known",
      lib.availabilityOf(H("a"), false, 0, undefined, now) === "gone", "not gone");

// --- what a person reads ------------------------------------------------------
check("each state has its own mark",
      new Set(Object.values(lib.AVAILABILITY_MARK)).size === 4,
      JSON.stringify(lib.AVAILABILITY_MARK));
check("held and merely-indexed look different",
      lib.describeEntry(entry(), "held").startsWith("●") && lib.describeEntry(entry(), "known").startsWith("○"),
      lib.describeEntry(entry(), "held"));
check("a line says how many holders are here",
      lib.describeEntry(entry(), "here", 2).includes("2 holders here"),
      lib.describeEntry(entry(), "here", 2));
check("sizes are readable", lib.fmtSize(1536) === "2 KB" && lib.fmtSize(5 * 1024 * 1024) === "5.0 MB",
      `${lib.fmtSize(1536)} / ${lib.fmtSize(5 * 1024 * 1024)}`);
check("media is told apart from files",
      lib.kindOf("audio/wav") === "audio" && lib.kindOf("application/pdf") === "file",
      lib.kindOf("audio/wav"));

console.log(failed === 0 ? "\nlibrary: all passed" : `\nlibrary: ${failed} FAILED`);
process.exit(failed ? 1 : 0);
