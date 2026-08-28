// palette.test.mjs — the line a quick action builds.
//
// The toolbar's job is no longer to paste a prefix into the box: it asks for
// each argument and assembles a command. What matters is the command it
// assembles — a form that looks right and produces `/poll new  | a, b` is worse
// than no form at all — plus the two places the keyboard has to behave: a
// required argument that must not be skipped, and Enter still sending the line
// a usage hint is only hinting about.
//
//   node packages/browser/test/palette.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "palette.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

const el = () => {
  const node = {
    className: "", textContent: "", hidden: true, dataset: {}, title: "",
    children: [], handlers: {}, innerHTML: "",
    appendChild(k) { node.children.push(k); return k; },
    addEventListener(n, f) { node.handlers[n] = f; },
    fire(n, ev = {}) { node.handlers[n]?.({ preventDefault() {}, ...ev }); },
    set innerHTMLSetter(_v) {},
  };
  Object.defineProperty(node, "innerHTML", {
    get: () => "", set: () => { node.children.length = 0; },
  });
  return node;
};
Object.defineProperty(globalThis, "document", {
  value: { createElement: () => el() }, configurable: true, writable: true,
});

const input = { value: "", placeholder: "message · type / for commands", focus() {} };
const said = [];
const ran = [];
const menu = el();
const row = el();
const palette = mod.createPalette({
  input, say: (t) => said.push(t),
  toggleCall: () => ran.push("call"), toggleRecord: () => ran.push("record"),
  run: (t) => ran.push(t),
}, menu);
palette.mountActions(row);

let failed = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}  (${detail})`); }
};
const button = (label) => row.children.find((b) => b.dataset.action === label);

// --- the toolbar itself ------------------------------------------------------
const labels = row.children.map((b) => b.dataset.action);
check("the room comes first and the catch-all closes",
      labels.slice(0, 3).join(",") === "call,record,rholang"
      && labels[labels.length - 1] === "other", labels.join(","));
check("it is a short toolbar", labels.length <= 7, `${labels.length} buttons`);

// --- an action with no arguments just runs -----------------------------------
button("rholang").fire("click");
check("rholang runs straight away", ran.includes("/rholang eval"), JSON.stringify(ran));

// --- an action with arguments asks for them ----------------------------------
ran.length = 0;
button("poll").fire("click");
check("it starts collecting", palette.guiding(), "not guiding");
check("and nothing has run yet", ran.length === 0, JSON.stringify(ran));

// A required argument is the point of asking: an empty box must not pass it.
input.value = "   ";
palette.submitArg();
check("an empty answer does not satisfy a required argument", palette.guiding(), "moved on");
check("and still nothing has run", ran.length === 0, JSON.stringify(ran));

input.value = "Lunch — pizza or burgers?";
palette.submitArg();
check("the second argument is asked for next", palette.guiding(), "finished early");

input.value = "pizza, burgers";
palette.submitArg();
check("the assembled line is what a person would have typed",
      ran[0] === "/poll new Lunch — pizza or burgers? | pizza, burgers", JSON.stringify(ran));
check("the box is left clean", input.value === "", JSON.stringify(input.value));
check("and the placeholder is given back",
      input.placeholder === "message · type / for commands", input.placeholder);

// --- an optional argument may be skipped -------------------------------------
ran.length = 0;
button("poll").fire("click");
input.value = "Where to?";
palette.submitArg();
input.value = "";
palette.submitArg();
check("skipping the optional argument leaves no trailing separator",
      ran[0] === "/poll new Where to?", JSON.stringify(ran));

// --- cancelling leaves nothing behind ----------------------------------------
ran.length = 0;
button("estimate").fire("click");
palette.cancel();
check("cancel stops the collection", !palette.guiding(), "still guiding");
check("cancel runs nothing", ran.length === 0, JSON.stringify(ran));
check("cancel clears the box", input.value === "", JSON.stringify(input.value));

// --- hints while typing ------------------------------------------------------
palette.onInput("/poll");
check("a bare command word offers commands to pick", palette.isPicking(), "not picking");

palette.onInput("/poll new Lunch");
check("past the command name it hints instead", palette.isOpen(), "hint not shown");
check("and a hint is NOT something to pick — Enter must still send",
      !palette.isPicking(), "swallowing Enter");

palette.onInput("hello everyone");
check("ordinary chat shows nothing", !palette.isOpen(), "menu left open");

// --- the getting-started list ------------------------------------------------
ran.length = 0;
button("other").fire("click");
check("other lists what has no button", menu.children.length > 5, `${menu.children.length}`);
const first = menu.children.find((c) => c.className === "cmd-item");
first.fire("mousedown");
check("and its entries start their own action", palette.guiding() || ran.length > 0,
      JSON.stringify(ran));

// A note is three answers, the last of them optional.
palette.cancel();
ran.length = 0;
button("other").fire("click");
const items = () => menu.children.filter((c) => c.className === "cmd-item");
const entry = (text) => items().find((c) => c.children[0].textContent.includes(text));
check("the list is sectioned, group first",
      menu.children[0].className.includes("next-head")
      && menu.children[0].textContent === "Group", menu.children[0].textContent);
entry("Mint a note").fire("mousedown");
input.value = "USD"; palette.submitArg();
input.value = "10";  palette.submitArg();
input.value = "";    palette.submitArg();
check("a note is minted from its answers", ran[0] === "/note grant USD 10", JSON.stringify(ran));

// Trust is two answers and both are required — a level with no member, or a
// member with no level, is not a rating.
ran.length = 0;
button("other").fire("click");
entry("trust").fire("mousedown");
input.value = ""; palette.submitArg();
check("trust will not take an empty member", palette.guiding(), "moved on");
input.value = "Ann"; palette.submitArg();
input.value = "3";   palette.submitArg();
check("trust is conferred from its answers", ran[0] === "/gov trust Ann 3", JSON.stringify(ran));

console.log(failed === 0 ? "\npalette: all passed" : `\npalette: ${failed} FAILED`);
process.exit(failed ? 1 : 0);
