// lemma-parse.test.mjs — the /lemma grammar (issue #128).
//
// lemma-parse.ts is dependency-free, so it bundles and imports cleanly.
//
//   node packages/browser/test/lemma-parse.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "lemma-parse.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
});
const { parseLemmaDecl, parseRefTokens, splitLemmaNameArg, canonLemma, looksLikeTwistArg } =
  await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));

let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}  (${detail})`); }
};

// decl(input, {name, twistsArg?, text?}) or decl(input, "error")
const decl = (input, expect) => {
  const got = parseLemmaDecl(input);
  const label = `/lemma ${input || "«empty»"}`;
  if (expect === "error") { check(`${label}  → error`, "error" in got, JSON.stringify(got)); return; }
  if ("error" in got) { check(label, false, `unexpected error: ${got.error}`); return; }
  const ok = got.name === expect.name
    && got.twistsArg === (expect.twistsArg ?? "")
    && (got.text ?? undefined) === (expect.text ?? undefined);
  check(label, ok, JSON.stringify(got));
};

// --- the new short forms -------------------------------------------------
decl("All men are @mortal", { name: "mortal", text: "All men are mortal" });
decl("All men are @mortal | ^v<>", { name: "mortal", twistsArg: "^v<>", text: "All men are mortal" });
decl("Socrates is @mortal.", { name: "mortal", text: "Socrates is mortal." });   // trailing "." not part of the handle
decl("@mortality All men are mortal", { name: "mortality", text: "All men are mortal" });
decl("@mortality All men are mortal | +-", { name: "mortality", twistsArg: "+-", text: "All men are mortal" });
decl("All men are @mortal always", { name: "mortal", text: "All men are mortal always" });

// --- bare multi-word name (the core #128 ask) ---------------------------
decl("socrates is a man", { name: "socrates is a man" });
decl("  All   Men   are   Mortal  ", { name: "All Men are Mortal" });            // canonicalised
decl("socrates is a man | ^v", { name: "socrates is a man", twistsArg: "^v" });

// --- @handle that is the whole thing → no separate text ---------------
decl("@mortality", { name: "mortality" });
decl("mortality", { name: "mortality" });

// --- legacy forms parse identically ----------------------------------
decl("mortality ^v", { name: "mortality", twistsArg: "^v" });
decl("socrates +-", { name: "socrates", twistsArg: "+-" });
decl("mortality 0246", { name: "mortality", twistsArg: "0246" });
decl("[all men are mortal] ^v<>", { name: "all men are mortal", twistsArg: "^v<>" });
decl("[all men are mortal]", { name: "all men are mortal" });
decl("concl @premise-a @premise-b", { name: "concl", twistsArg: "@premise-a @premise-b" });
decl("@concl @premise-a @premise-b", { name: "concl", twistsArg: "@premise-a @premise-b" });
decl("concl | @premise-a @premise-b", { name: "concl", twistsArg: "@premise-a @premise-b" });
decl("mortality cap:foo:0246", { name: "mortality", twistsArg: "cap:foo:0246" });

// --- errors ---------------------------------------------------------
decl("", "error");
decl("@a is @b", "error");                       // two @handles
decl("has:a:colon | ^v", "error");               // colon still illegal in a name
decl("a:b:c", "error");                          // ditto, no pipe
decl("Men are @naïve", "error");                 // handle must be identifier-shaped (ASCII word chars)

// --- text dropped when it would equal the name ---------------------
{
  const g = parseLemmaDecl("@foo");
  check("@handle-only: no text field", !("error" in g) && g.name === "foo" && g.text === undefined, JSON.stringify(g));
}

// --- parseRefTokens still tokenises multi-word @[...] --------------
{
  const toks = parseRefTokens("@[all men are mortal] ^v @socrates");
  check("parseRefTokens: @[multi word] is one ref",
    toks.length === 3
    && toks[0].kind === "ref" && toks[0].name === "all men are mortal"
    && toks[1].kind === "lit" && toks[1].text === "^v"
    && toks[2].kind === "ref" && toks[2].name === "socrates",
    JSON.stringify(toks));
}

// --- splitLemmaNameArg unchanged (used by /pass) ------------------
check("splitLemmaNameArg: bare",
  JSON.stringify(splitLemmaNameArg("foo Alice")) === JSON.stringify(["foo", "Alice"]));
check("splitLemmaNameArg: bracketed",
  JSON.stringify(splitLemmaNameArg("[foo bar] Alice")) === JSON.stringify(["foo bar", "Alice"]));

// --- looksLikeTwistArg -------------------------------------------
check("looksLikeTwistArg: symbolic", looksLikeTwistArg("^v<>") === true);
check("looksLikeTwistArg: hex", looksLikeTwistArg("0246") === true);
check("looksLikeTwistArg: @ref", looksLikeTwistArg("@foo") === true);
check("looksLikeTwistArg: cap", looksLikeTwistArg("cap:x:0246") === true);
check("looksLikeTwistArg: prose", looksLikeTwistArg("men are mortal") === false);
check("canonLemma collapses ws", canonLemma("  a   b  ") === "a b");

console.log(failed === 0 ? "\nlemma-parse: all passed" : `\nlemma-parse: ${failed} FAILED`);
process.exit(failed ? 1 : 0);
