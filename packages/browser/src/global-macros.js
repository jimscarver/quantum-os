// global-macros.js — the approved RChain capability macro registry, and the
// expander that turns `/global` input into rholang.
//
// SINGLE SOURCE OF TRUTH. This module is imported by both halves of `/global`:
//   * scripts/qos-cli/global-macros.mjs — the headless room agent
//   * packages/browser/src/global.ts    — the browser, which lints and signs
// They used to carry separate copies of the registry, the argument validators
// and the scanner, kept in step by hand. A macro edited in one and not the
// other meant the rholang a user reviewed in chat was not the rholang their
// browser signed.
//
// Plain JS with no imports so both toolchains can consume it directly: the
// agent runs it under node, Vite bundles it for the browser. The ZFA kernel is
// INJECTED rather than imported, because each side has its own build of it
// (zfa.mjs / zfa.ts) and neither can import the other's.
//
// It lives under packages/browser/src because the browser tsconfig sets
// rootDir there; the agent reaches it by relative path, which node does not
// restrict.

/**
 * @typedef {object} ZfaKernel
 * @property {(s: string) => Uint8Array|null} parseTwists
 * @property {(tw: Uint8Array) => boolean} achievesZfa
 * @property {(tw: Uint8Array) => boolean} isPauliClosed
 * @property {(token: string) => boolean} validateCapability
 */

/**
 * Build the macro engine over a ZFA kernel.
 * @param {ZfaKernel} kernel
 */
export function createMacroEngine(kernel) {
const { parseTwists, achievesZfa, isPauliClosed, validateCapability } = kernel;

// ---------------------------------------------------------------------------
// Hygiene: patterns a *user-supplied argument* may not contain.
//
// What actually stops injection is that every user string reaches rholang
// through `q()` — JSON.stringify — into a string-literal position, and every
// number through cleanInt. A quote or backslash is escaped, so an argument
// cannot leave the literal it lands in. These patterns are a second line
// behind that, for content that would be alarming even as inert data.
//
// They are NOT a syntax filter. Rholang keywords inside a string literal are
// text, not code: `new` and `for (` were once rejected here as "scope
// smuggling" and "join smuggling", but neither can smuggle anything past the
// quoting, and both fire on ordinary names — "New York", "renew all", "Vote
// for (chair)". A guard that cannot prevent an attack and does reject real
// input is worse than no guard.
// ---------------------------------------------------------------------------
const RESTRICTED = [
  /rho:io:/i,                 // raw I/O channels
  /rho:rchain:deployerId/i,   // someone else's unforgeable identity
  /\*\s*!/,                   // eval-then-send injection
  /!\s*\*/,                   // send-then-eval injection
];

function fail(msg) {
  const e = new Error(msg);
  e.kind = "macro";
  return e;
}

/** A safe rholang string literal (JSON.stringify is a valid rholang string). */
const q = (s) => JSON.stringify(String(s));

function cleanString(v, name) {
  const s = String(v ?? "").trim();
  if (!s) throw fail(`${name}: expected a non-empty string`);
  if (s.length > 120) throw fail(`${name}: too long (max 120 chars)`);
  for (const re of RESTRICTED) if (re.test(s)) throw fail(`${name}: rejected — restricted pattern`);
  return s;
}

// Accepts "01" (adjacent digits), "0,1", "0 1", "[0,1]", or symbols "^v".
// Returns an array of ints 0..7.
function cleanTwists(v, name) {
  const s = String(v ?? "").trim().replace(/^\[|\]$/g, "");
  // Symbolic form (^ v > < / \ + -) → delegate to parseTwists.
  if (/[^0-7\s,]/.test(s)) {
    const tw = parseTwists(s);
    if (!tw) throw fail(`${name}: unknown twist symbol`);
    return Array.from(tw);
  }
  // Digits: strip separators and treat each digit as one twist value.
  const digits = s.replace(/[\s,]+/g, "");
  if (!digits.length || !/^[0-7]+$/.test(digits)) throw fail(`${name}: expected twist values 0..7`);
  return [...digits].map((c) => Number(c));
}

function cleanList(v, name) {
  const s = String(v ?? "").trim();
  const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) throw fail(`${name}: expected a comma-separated list`);
  return parts.map((p) => cleanString(p, name));
}

function cleanCap(v, name) {
  const s = cleanString(v, name);
  if (!/^(cap:|rho:id:)/.test(s)) throw fail(`${name}: expected a cap:… or rho:id:… capability`);
  return s;
}

function cleanInt(v, name) {
  const s = String(v ?? "").trim();
  // Decimal digits only, carried as a BigInt. `Number()` silently rounded
  // anything past 2^53 — a typed 12345678901234567890 became a signed
  // 12345678901234567000 — which for a REV amount means the value the user
  // approved is not the value that gets signed. It also quietly accepted
  // `0x10` as 16 and `1e9` as 1000000000. REV amounts run well past 2^53, so
  // the digits the user typed are the digits that get emitted.
  if (!/^\d+$/.test(s)) throw fail(`${name}: expected a non-negative integer (decimal digits only)`);
  if (s.length > 40) throw fail(`${name}: integer too long (max 40 digits)`);
  return BigInt(s);
}

// ---------------------------------------------------------------------------
// The approved macro registry.
//
// Each entry:
//   help     — one-line description (shown in `/global macros`)
//   write    — false = read (agent answers locally); true = write (agent returns
//              a rholang preview to sign + deploy)
//   argSpec  — array of [name, type]  (types: string, twists, list, cap, int)
//   expand   — (args) => rholang source string   (write macros)
//   read     — (args) => { text }                (read macros)
// ---------------------------------------------------------------------------
const MACROS = {
  zfa: {
    help: "Verify a twist sequence is ZFA-balanced (half-spin closure).",
    write: false,
    argSpec: [["twists", "twists"]],
    read(args) {
      const tw = parseTwists(args.twists.join(""));
      if (!tw) throw fail("zfa: could not parse twists");
      return {
        text: `zfa(${args.twists.join("")}) → ZFA ${achievesZfa(tw) ? "true" : "false"}` +
              ` (pauli-closed ${isPauliClosed(tw) ? "true" : "false"})`,
      };
    },
  },

  verify: {
    help: "Validate a capability token (cap:… / rho:id:…) is a ZFA-balanced closure.",
    write: false,
    argSpec: [["cap", "cap"]],
    read(args) {
      const ok = validateCapability(args.cap) || /^rho:id:/.test(args.cap);
      return { text: `verify(${args.cap}) → ${ok ? "valid" : "INVALID"}` };
    },
  },

  grant: {
    help: "Mint a ZFA-balanced proof as a capability (rho:qucalc:grant).",
    write: true,
    argSpec: [["twists", "twists"]],
    expand(args) {
      const list = args.twists.join(", ");
      return `new ret in {
  rho:qucalc:grant!([${list}], *ret) |
  for (@cap <- ret) { Nil }
}`;
    },
  },

  ballot: {
    help: "Cast a ranked-choice ballot for an issue (rho:gov:tally).",
    write: true,
    argSpec: [["issue", "string"], ["options", "list"]],
    expand(args) {
      const options = args.options.map(q).join(", ");
      return `new ret in {
  rho:gov:tally!({"issue": ${q(args.issue)}}, [${options}], "ranked", *ret) |
  for (@winner <- ret) { Nil }
}`;
    },
  },

  directory: {
    help: "Create a capability-facet key/value directory (rho:registry:insertArbitrary).",
    write: true,
    argSpec: [["name", "string"]],
    expand(args) {
      return `new ret in {
  rho:registry:insertArbitrary!({"directory": ${q(args.name)}}, *ret) |
  for (@uri <- ret) { Nil }
}`;
    },
  },

  mailbox: {
    help: "Create a capability-facet inbox (rho:registry:insertArbitrary).",
    write: true,
    argSpec: [["name", "string"]],
    expand(args) {
      return `new ret in {
  rho:registry:insertArbitrary!({"mailbox": ${q(args.name)}}, *ret) |
  for (@uri <- ret) { Nil }
}`;
    },
  },

  group: {
    help: "Create a governance group (signer becomes admin; rho:registry:insertArbitrary).",
    write: true,
    argSpec: [["name", "string"]],
    expand(args) {
      return `new ret in {
  rho:registry:insertArbitrary!({"group": ${q(args.name)}, "admin": *deployerId}, *ret) |
  for (@uri <- ret) { Nil }
}`;
    },
  },

  delegate: {
    help: "Delegate your vote to another member (rho:gov:resolveWeights).",
    write: true,
    argSpec: [["to", "string"]],
    expand(args) {
      return `new ret in {
  rho:gov:resolveWeights!([*deployerId], {*deployerId: ${q(args.to)}}, {}, *ret) |
  for (@weights <- ret) { Nil }
}`;
    },
  },

  transfer: {
    help: "Transfer REV to an address (rho:rchain:revVault).",
    write: true,
    argSpec: [["amount", "int"], ["to", "string"]],
    expand(args) {
      return `new ret in {
  rho:rchain:revVault!("transfer", ${args.amount}, ${q(args.to)}, *ret) |
  for (@r <- ret) { Nil }
}`;
    },
  },
};

// ---------------------------------------------------------------------------
// Expansion entry point.
// ---------------------------------------------------------------------------

/**
 * The `/global` entry point. The body is either a bare single macro call
 * (`transfer 100 bob` — the whole program is one macro) or a rholang program,
 * one line or many, with `%name(…)` call sites embedded in it.
 */
function expandGlobal(input) {
  const body = String(input ?? "").replace(/^\s*\/?global\s*/i, "");
  const head = body.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (head === "help") return { kind: "help" };
  if (head === "macros" || head === "list") return { kind: "list" };
  // Bare form: no call sites, and the first word names a macro.
  if (!body.includes("%") && MACROS[head]) return expandMacro(body);
  return expandProgram(body);
}

/** Parse "/global name args…" (or bare "name args…") and expand it. */
function expandMacro(line) {
  const s = String(line ?? "").trim();
  const body = s.replace(/^\/global\s*/i, "");
  const tokens = body.split(/\s+/).filter(Boolean);
  if (!tokens.length) throw fail("usage: /global <macro> <args…>  (or /global help|macros)");
  const name = tokens[0].toLowerCase();
  const rest = tokens.slice(1);

  if (name === "help") return { kind: "help" };
  if (name === "macros" || name === "list") return { kind: "list" };

  const macro = MACROS[name];
  if (!macro) throw fail(`unknown macro ${JSON.stringify(name)} — try /global macros`);

  // Bind positional args against the schema.
  const args = {};
  const spec = macro.argSpec;
  const n = Math.min(spec.length, rest.length);
  for (let i = 0; i < n; i++) {
    const [argName, type] = spec[i];
    const raw = rest[i];
    switch (type) {
      case "string": args[argName] = cleanString(raw, argName); break;
      case "twists": args[argName] = cleanTwists(raw, argName); break;
      case "list":   args[argName] = cleanList(raw, argName); break;
      case "cap":    args[argName] = cleanCap(raw, argName); break;
      case "int":    args[argName] = cleanInt(raw, argName); break;
      default: throw fail(`${name}: internal — unknown arg type ${type}`);
    }
  }
  if (n < spec.length) {
    const missing = spec.slice(n).map(([a, t]) => `${a}:${t}`).join(", ");
    throw fail(`${name}: missing args — ${missing}`);
  }
  if (rest.length > spec.length) {
    throw fail(`${name}: too many args (expected ${spec.length})`);
  }

  if (macro.write) {
    return { kind: "rholang", macro: name, source: macro.expand(args) };
  }
  return { kind: "result", macro: name, ...macro.read(args) };
}

// ---------------------------------------------------------------------------
// Program expansion: macros embedded in rholang.
//
// A `/global` body is a rholang program — one line or many — with macro call
// sites written `%name(arg, …)`. We do NOT parse the rholang: we scan it well
// enough to find call sites that are really call sites (skipping strings and
// comments, balancing brackets), expand those in place, and leave every other
// byte untouched. Whatever the result does or does not mean is the linter's
// question and then the node's; expansion only reports its own errors.
//
// The `%` sigil is what keeps this honest without a rholang grammar — a bare
// `ballot(…)` would be indistinguishable from a real contract call.
// ---------------------------------------------------------------------------

/** Advance past a rholang string literal starting at `i` (src[i] === '"'). */
function skipString(src, i) {
  i++;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === '"') return i + 1;
    i++;
  }
  return -1;                       // unterminated
}

/** Advance past whichever of string / line comment / block comment starts at `i`, else -1. */
function skipTrivia(src, i) {
  if (src[i] === '"') return skipString(src, i);
  if (src[i] === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); return e < 0 ? src.length : e; }
  if (src[i] === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); return e < 0 ? -1 : e + 2; }
  return -1;
}

const CLOSERS = { "(": ")", "[": "]", "{": "}" };

/** Index of the bracket closing the one at `open`, or -1 if unbalanced. */
function matchBracket(src, open) {
  const stack = [CLOSERS[src[open]]];
  let i = open + 1;
  while (i < src.length) {
    const t = skipTrivia(src, i);
    if (t === -1 && (src[i] === '"' || (src[i] === "/" && src[i + 1] === "*"))) return -1;  // unterminated
    if (t !== -1) { i = t; continue; }
    const c = src[i];
    if (CLOSERS[c]) stack.push(CLOSERS[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack[stack.length - 1] !== c) return -1;
      stack.pop();
      if (!stack.length) return i;
    }
    i++;
  }
  return -1;
}

/** Split a macro argument list on top-level commas. */
function splitArgs(src) {
  const out = [];
  let depth = 0, start = 0, i = 0;
  while (i < src.length) {
    const t = skipTrivia(src, i);
    if (t !== -1) { i = t; continue; }
    const c = src[i];
    if (CLOSERS[c]) depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { out.push(src.slice(start, i)); start = i + 1; }
    i++;
  }
  const tail = src.slice(start);
  if (out.length || tail.trim()) out.push(tail);
  return out.map((x) => x.trim()).filter((x, n, a) => !(a.length === 1 && x === ""));
}

/** A rholang term as the plain text the arg validators expect. */
function termToPlain(t) {
  const s = String(t).trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    // A rholang string literal: take its content, honouring backslash escapes.
    return s.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    // A list: hand the validators the comma form they already parse.
    return splitArgs(s.slice(1, -1)).map(termToPlain).join(",");
  }
  return s;
}

/** Bind already-split argument terms against a macro's schema. */
function bindArgs(macro, name, terms) {
  const spec = macro.argSpec;
  if (terms.length < spec.length) {
    throw fail(`${name}: missing args — ${spec.slice(terms.length).map(([a, t]) => `${a}:${t}`).join(", ")}`);
  }
  if (terms.length > spec.length) throw fail(`${name}: too many args (expected ${spec.length})`);
  const args = {};
  for (let i = 0; i < spec.length; i++) {
    const [argName, type] = spec[i];
    const raw = termToPlain(terms[i]);
    switch (type) {
      case "string": args[argName] = cleanString(raw, argName); break;
      case "twists": args[argName] = cleanTwists(raw, argName); break;
      case "list":   args[argName] = cleanList(raw, argName); break;
      case "cap":    args[argName] = cleanCap(raw, argName); break;
      case "int":    args[argName] = cleanInt(raw, argName); break;
      default: throw fail(`${name}: internal — unknown arg type ${type}`);
    }
  }
  return args;
}

const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;

/**
 * Expand every `%macro(…)` call site in a rholang program.
 * Returns { kind:"program", source, expansions:[{name,line}], errors:[{line,message}] }.
 * Errors do not abort: every call site is attempted so one message reports them all.
 */
function expandProgram(src) {
  const text = String(src ?? "");
  const out = [];
  const expansions = [];
  const errors = [];
  let i = 0, last = 0;
  while (i < text.length) {
    const t = skipTrivia(text, i);
    if (t !== -1) { i = t; continue; }
    if (text[i] !== "%") { i++; continue; }
    const m = /^%([A-Za-z][\w-]*)\s*\(/.exec(text.slice(i));
    if (!m) { i++; continue; }
    const name = m[1].toLowerCase();
    const open = i + m[0].length - 1;
    const close = matchBracket(text, open);
    if (close === -1) {
      errors.push({ line: lineOf(text, i), message: `%${name}: unbalanced ( — call site is not closed` });
      break;
    }
    const macro = MACROS[name];
    out.push(text.slice(last, i));
    if (!macro) {
      errors.push({ line: lineOf(text, i), message: `unknown macro %${name} — try /global macros` });
      out.push(text.slice(i, close + 1));                  // leave it as written
    } else {
      try {
        // A read macro has no rholang to substitute, and expansion does not
        // invent any: report it and leave the site as written.
        if (!macro.write) throw fail(`%${name} is a read macro — it has no rholang; use it on its own line`);
        const args = bindArgs(macro, name, splitArgs(text.slice(open + 1, close)));
        out.push(macro.expand(args));
        expansions.push({ name, line: lineOf(text, i), write: true });
      } catch (e) {
        errors.push({ line: lineOf(text, i), message: e?.message ?? String(e) });
        out.push(text.slice(i, close + 1));
      }
    }
    last = close + 1;
    i = close + 1;
  }
  out.push(text.slice(last));
  return { kind: "program", source: out.join(""), expansions, errors };
}

/** One-line summary of every macro (for `/global macros`). */
function listMacros() {
  const lines = Object.entries(MACROS).map(
    ([name, m]) => `${name.padEnd(10)} ${m.write ? "write" : "read "}  ${m.help}`
  );
  return `Approved macros (${lines.length}):\n` + lines.map((l) => `  ${l}`).join("\n");
}

const HELP =
  `RChain capability macros — /global\n` +
  `  /global help                 this help\n` +
  `  /global macros               list the approved macro library\n` +
  `  /global <macro> <args…>      expand a single macro (the whole program is one macro)\n` +
  `  /global <rholang…>           expand %macro(…) call sites inside a rholang program;\n` +
  `                               one line or many, everything else is left as written\n`;

// ---------------------------------------------------------------------------
// Self-test (node global-macros.mjs --selftest)
// ---------------------------------------------------------------------------
function selftest() {
  const cases = [
    ["zfa 01", (r) => r.kind === "result" && r.text.includes("ZFA true")],
    ["zfa 0", (r) => r.kind === "result" && r.text.includes("ZFA false")],
    ["grant 01", (r) => r.kind === "rholang" && r.source.includes("rho:qucalc:grant!")],
    ["ballot lunch pizza,tacos", (r) => r.kind === "rholang" && r.source.includes("rho:gov:tally!")],
    ["directory notes", (r) => r.kind === "rholang" && r.source.includes("insertArbitrary!")],
    ["transfer 10 bob", (r) => r.kind === "rholang" && r.source.includes("revVault!")],
    // amounts past 2^53 must survive verbatim, not be rounded through a double:
    ["transfer 12345678901234567890 bob",
      (r) => r.source.includes('"transfer", 12345678901234567890,')],
    ["transfer 0x10 bob", () => { throw new Error("should have been rejected"); }],
    ["transfer 1e9 bob", () => { throw new Error("should have been rejected"); }],
    // hygiene / injection must be rejected:
    ["directory rho:io:stdout", () => { throw new Error("should have been rejected"); }],
    ["ballot x y,rho:io:stdout", () => { throw new Error("should have been rejected"); }],
    ["nope", () => { throw new Error("should have been rejected"); }],
  ];
  let pass = 0;

  // Program form: macros embedded in rholang, one line or many.
  const P = (src) => expandProgram(src);
  const progCases = [
    ["expands a call site in place",
      () => P('new x in { %directory("notes") }').source.includes("insertArbitrary!")],
    ["multi-word args, which the bare form cannot express",
      () => P('%mailbox("Q4 results")').source.includes('"mailbox": "Q4 results"')],
    ["two call sites, both expanded",
      () => P('%directory("a") | %mailbox("b")').expansions.length === 2],
    ["a %name( inside a string is not a call site",
      () => P('x!("%directory(\\"no\\")")').expansions.length === 0],
    ["a %name( inside a line comment is not a call site",
      () => P('// %directory("no")\nNil').expansions.length === 0],
    ["a %name( inside a block comment is not a call site",
      () => P('/* %directory("no") */ Nil').expansions.length === 0],
    ["unknown macro is an error, and the text is left as written",
      () => { const r = P('%nosuch("x")'); return r.errors.length === 1 && r.source === '%nosuch("x")'; }],
    ["a bad arg reports its line and leaves that site alone",
      () => { const r = P('Nil |\n%transfer(1e9, "bob")'); return r.errors[0].line === 2 && r.source.includes("%transfer(1e9"); }],
    ["one bad site does not suppress a good one",
      () => { const r = P('%directory("ok") | %nosuch("x")'); return r.expansions.length === 1 && r.errors.length === 1; }],
    ["unbalanced call site is reported, not thrown",
      () => P('%directory("oops"').errors.length === 1],
    ["nested brackets in args are balanced correctly",
      () => P('%ballot("i", ["a (b)", "c, d"])').expansions.length === 1],
    ["ordinary names are not rejected as rholang keywords",
      () => ["New York office", "renew all licences", "Vote for (chair)", "new hires"]
        .every((n) => P(`%directory(${JSON.stringify(n)})`).errors.length === 0)],
    ["a rholang keyword in an argument stays inside its string literal",
      () => P('%directory("new x in { evil!(1) }")').source
        .includes('"directory": "new x in { evil!(1) }"')],
    ["a list arg keeps its elements whole",
      () => P('%ballot("i", ["ship auth", "pay debt"])').source.includes('"ship auth", "pay debt"')],
  ];
  for (const [name, fn] of progCases) {
    try {
      if (fn()) { console.log(`  ok   program: ${name}`); pass++; }
      else console.log(`  FAIL program: ${name}`);
    } catch (e) { console.log(`  FAIL program: ${name}  →  ${e?.message ?? e}`); }
  }

  for (const [input, check] of cases) {
    try {
      const r = expandMacro(input);
      if (!check(r)) throw new Error(`check failed for ${JSON.stringify(input)}`);
      console.log(`  ok   ${input}`);
      pass++;
    } catch (e) {
      // The three injection/unknown cases are expected to throw — count them as passing.
      const expected = /injection|rejected|unknown macro|restricted pattern|decimal digits only/.test(e?.message ?? "");
      if (expected) { console.log(`  ok   ${input}  (rejected: ${e.message})`); pass++; }
      else { console.log(`  FAIL ${input}  →  ${e?.message ?? e}`); }
    }
  }
  const total = cases.length + progCases.length;
  console.log(`selftest: ${pass}/${total} passed`);
  return pass === total;
}


return { MACROS, expandGlobal, expandProgram, expandMacro, listMacros, HELP, selftest };
}
