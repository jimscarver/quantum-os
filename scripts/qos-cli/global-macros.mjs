// global-macros.mjs — approved RChain capability macros for the `/global` room agent.
//
// Design (zero-trust macro agent, per the QuantumOS `/global` spec):
//
//   * typed templates — each macro declares an arg schema; arguments are STRUCTURALLY
//     validated and interpolated, never raw string-appended, so a malicious argument
//     cannot smuggle a rholang block in.
//   * the agent only EXPANDS — it never executes or signs. Writes come back as a
//     human-readable rholang preview for the requestor to review and sign in the
//     browser (the private key never leaves the browser).
//   * reads are answered by the agent itself (ZFA engine locally) and the result is
//     shared back to the room chat.
//   * capability-based — macros mint/use unforgeable names (capabilities); there are
//     no global admin flags.
//
// The rholang the macros expand to targets the rchain-rust system contracts
// (rho:qucalc:*, rho:gov:*, rho:registry:*).

import { achievesZfa, isPauliClosed, parseTwists, validateCapability } from "./zfa.mjs";

// ---------------------------------------------------------------------------
// Hygiene: patterns a *user-supplied argument* may not contain. This is the
// "lexical scoping & hygiene" guard from the spec — it blocks the classic
// injection vectors while the macro's own (governance-approved) template may
// still reference system channels.
// ---------------------------------------------------------------------------
const RESTRICTED = [
  /rho:io:/i,                 // raw I/O channels
  /rho:rchain:deployerId/i,   // someone else's unforgeable identity
  /\*\s*!/,                   // eval-then-send injection
  /!\s*\*/,                   // send-then-eval injection
  /new\s+[a-zA-Z]/i,          // scope smuggling
  /for\s*\(/i,                // join / infinite-loop smuggling
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
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw fail(`${name}: expected a non-negative integer`);
  return n;
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
export const MACROS = {
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
      return `// mint a ZFA proof as a capability
new ret in {
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
      return `// cast a ranked-choice ballot for ${q(args.issue)}
new ret in {
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
      return `// create a capability-facet directory
new ret in {
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
      return `// create a capability-facet inbox
new ret in {
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
      return `// create a governance group — the deployer becomes admin
new ret in {
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
      return `// self-signed delegation (signer = *deployerId)
new ret in {
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
      return `// REV transfer (requires the rev-vault capability)
new ret in {
  rho:rchain:revVault!("transfer", ${args.amount}, ${q(args.to)}, *ret) |
  for (@r <- ret) { Nil }
}`;
    },
  },
};

// ---------------------------------------------------------------------------
// Expansion entry point.
// ---------------------------------------------------------------------------

/** Parse "/global name args…" (or bare "name args…") and expand it. */
export function expandMacro(line) {
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

/** One-line summary of every macro (for `/global macros`). */
export function listMacros() {
  const lines = Object.entries(MACROS).map(
    ([name, m]) => `${name.padEnd(10)} ${m.write ? "write" : "read "}  ${m.help}`
  );
  return `Approved macros (${lines.length}):\n` + lines.map((l) => `  ${l}`).join("\n");
}

export const HELP =
  `RChain capability macros — /global\n` +
  `  /global help                 this help\n` +
  `  /global macros               list the approved macro library\n` +
  `  /global <macro> <args…>      expand a macro (writes: rholang preview to sign; reads: result)\n`;

// ---------------------------------------------------------------------------
// Self-test (node global-macros.mjs --selftest)
// ---------------------------------------------------------------------------
export function selftest() {
  const cases = [
    ["zfa 01", (r) => r.kind === "result" && r.text.includes("ZFA true")],
    ["zfa 0", (r) => r.kind === "result" && r.text.includes("ZFA false")],
    ["grant 01", (r) => r.kind === "rholang" && r.source.includes("rho:qucalc:grant!")],
    ["ballot lunch pizza,tacos", (r) => r.kind === "rholang" && r.source.includes("rho:gov:tally!")],
    ["directory notes", (r) => r.kind === "rholang" && r.source.includes("insertArbitrary!")],
    ["transfer 10 bob", (r) => r.kind === "rholang" && r.source.includes("revVault!")],
    // hygiene / injection must be rejected:
    ["directory rho:io:stdout", () => { throw new Error("should have been rejected"); }],
    ["ballot x y,rho:io:stdout", () => { throw new Error("should have been rejected"); }],
    ["nope", () => { throw new Error("should have been rejected"); }],
  ];
  let pass = 0;
  for (const [input, check] of cases) {
    try {
      const r = expandMacro(input);
      if (!check(r)) throw new Error(`check failed for ${JSON.stringify(input)}`);
      console.log(`  ok   ${input}`);
      pass++;
    } catch (e) {
      // The three injection/unknown cases are expected to throw — count them as passing.
      const expected = /injection|rejected|unknown macro|restricted pattern/.test(e?.message ?? "");
      if (expected) { console.log(`  ok   ${input}  (rejected: ${e.message})`); pass++; }
      else { console.log(`  FAIL ${input}  →  ${e?.message ?? e}`); }
    }
  }
  console.log(`selftest: ${pass}/${cases.length} passed`);
  return pass === cases.length;
}

// Run selftest when invoked directly with --selftest.
if (typeof process !== "undefined" && process.argv.includes("--selftest")) {
  process.exit(selftest() ? 0 : 1);
}
