#!/usr/bin/env node
// macro-check.mjs — do the macros still do what they advertise, on THIS rnode?
//
// The selftests in rholang-macros.js check that a macro expands to the rholang
// it is supposed to expand to. They cannot check the thing that actually
// matters: that rnode still runs that rholang the way the macro's help text
// says it does. A system process can be renamed, a return shape can change, a
// reduction rule can shift — and every expansion test keeps passing while every
// macro has quietly stopped working.
//
// So this runs each expansion on the node you are pointed at and reports what
// came back. It is deliberately NOT in CI: it needs a live rnode, and a CI that
// cannot reach one would either be red for the wrong reason or skip silently,
// which is worse than not running.
//
//   bash scripts/localnet/run-node.sh --fresh     # in one terminal
//   node scripts/localnet/macro-check.mjs         # in another
//
//   --node <url>   default http://127.0.0.1:40403
//   --verbose      print each expansion and its raw answer
//
// Every case runs as an EXPLORATORY deploy: unsigned, free, no block, nothing
// written. Two consequences worth knowing before reading a result:
//
//   * `rho:rchain:deployerId` is unbound here, so a macro that identifies its
//     caller cannot run. Those are reported `needs-deploy`, not failed.
//   * A `rho:registry:lookup` of a uri that was never registered never answers,
//     so a macro taking capability arguments has nothing to resolve unless you
//     give it real ones. Reported `needs-caps`.
//
// Neither is a defect in the macro. What IS a defect is an `error` row, or a
// `nothing` row for a macro that should have answered.
//
// CHANGE MANAGEMENT. There is no versioning between this library and rnode, and
// there is unlikely to be one soon — so this check is how an outdated macro is
// found. A failure here names the macro, prints what was sent and what came
// back, and points at the definition to change. That is the whole mechanism: a
// macro is current until this says it is not.

import { expandBare, expandProgram } from "../qos-cli/rholang-macros.mjs";

const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const NODE = arg("--node", "http://127.0.0.1:40403");
const VERBOSE = process.argv.includes("--verbose");

// One call per macro, with the arguments its help text implies, and what the
// answer has to look like for the macro to be doing what it advertises.
const CASES = [
  // Read macros — the agent answers these itself, so they never reach rnode.
  { call: "zfa 01",     expect: (r) => r.local?.includes("ZFA true"),  note: "answered locally" },
  { call: "zfa 0",      expect: (r) => r.local?.includes("ZFA false"), note: "answered locally" },

  // Proofs — rho:qucalc:*
  { call: "grant 01",   expect: (r) => r.values.length > 0, why: "a ZFA-closed history mints a uri" },
  { call: "fuse 01 23", expect: (r) => r.values.length > 0, why: "a synthesis returns (geometry, cap) or Nil" },

  // Group decisions — rho:gov:*
  // These take rholang maps, so they only exist in program form — the bare form
  // splits on whitespace and would tear a map in half.
  // Ratings and vouchers are LISTS OF TUPLES, not nested maps — rnode's own
  // parsers say so, and a map is refused outright.
  { program: '%trust([("alice","bob",3)], ["alice"])',             expect: (r) => r.values.length > 0, why: "trustLevels returns a level map" },
  { program: '%weights(["alice","bob"], {"carol": "bob"}, {})',     expect: (r) => r.values.length > 0, why: "resolveWeights returns a weight map" },
  { program: '%tally({"alice": ["keep"]}, {"alice": 1}, "ranked")', expect: (r) => r.values.length > 0, why: "tally returns a result" },
  { program: '%censure([("alice","bob")], {"alice":5,"bob":3}, [("alice","bob",3)])', expect: (r) => r.values.length > 0, why: "censure returns (discredited, newLevels)" },

  // Bearer capabilities — the registry
  { call: "directory notes", expect: (r) => r.values.length > 0, why: "insertArbitrary returns a uri" },
  { call: "mailbox inbox",   expect: (r) => r.values.length > 0, why: "insertArbitrary returns a uri" },
  { call: "issuer USD",      expect: (r) => r.values.length > 0, why: "insertArbitrary returns a uri" },
  { call: "note USD 5",      expect: (r) => r.values.length > 0, why: "insertArbitrary returns a uri" },
  { call: "redeem USD 5",    expect: (r) => r.values.length > 0, why: "insertArbitrary returns a uri" },

  // Structural patterns
  { call: "philosophers a,b,c", expect: (r) => r.values.length > 0, why: "every diner eats" },

  // These identify their caller, so an exploratory deploy cannot run them.
  { call: "ballot lunch pizza,tacos", needsDeploy: true },
  { call: "delegate bob",             needsDeploy: true },
  { call: "group colab",              needsDeploy: true },
  { call: "multisig n1 proposal 2",   needsDeploy: true },
  { call: "transfer 10 1111okLpqMQuvZ6u2P9fk6gez96U1De3x7bh1htdZ186MxbEALAnK", needsDeploy: true },

  // Takes capabilities, which have to exist to be resolved.
  { call: "swap rho:id:a rho:id:b rho:id:c rho:id:d", needsCaps: true },
];

const wrap = (body) =>
  "new return, stdout(`rho:io:stdout`), zfa(`rho:qucalc:zfa`), grant(`rho:qucalc:grant`), " +
  "verify(`rho:qucalc:verify`), fuse(`rho:qucalc:fuse`) in {\n" + body + "\n}";

async function explore(term) {
  const res = await fetch(NODE + "/api/explore-deploy", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(wrap(term)),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { return { error: text.slice(0, 160) }; }
  // rnode reports an error as a bare JSON string where success is an object.
  if (typeof j === "string") return { error: j.slice(0, 160) };
  return { values: (j.expr ?? []).map((e) => JSON.stringify(e).slice(0, 120)) };
}

const status = { ok: "ok       ", fail: "OUTDATED ", err: "OUTDATED ", skip: "skipped  " };
let pass = 0, fail = 0, skipped = 0;
/** Macros that no longer do what they advertise, with why, for the summary. */
const outdated = [];

/** A failure has to be actionable: what was sent, what came back, what to edit. */
function reportOutdated(name, call, why, sent, got) {
  outdated.push({ name: name.trim(), why });
  console.log(`${status.fail}${name}${why}`);
  console.log(`         called as: ${call}`);
  if (sent) console.log(sent.split("\n").map((l) => "         │ " + l).join("\n"));
  if (got)  console.log(`         rnode answered: ${got}`);
  console.log(`         fix in packages/browser/src/rholang-macros.js\n`);
}

console.log(`macro-check — ${NODE}\n`);
try {
  const s = await (await fetch(NODE + "/api/status")).json();
  console.log(`rnode ${s.version?.node ?? "?"} · shard ${s.shardId} · height ${s.latestBlockNumber}\n`);
} catch {
  console.error(`cannot reach ${NODE} — is rnode running? (bash scripts/localnet/run-node.sh)`);
  process.exit(2);
}

for (const c of CASES) {
  const label = c.call ?? c.program;
  const name = label.replace(/^%/, "").split(/[\s(]/)[0].padEnd(14);
  let expansion;
  try {
    expansion = c.program
      ? (() => {
          const p = expandProgram(c.program);
          if (p.errors.length) throw new Error(p.errors[0].message);
          return { kind: "rholang", source: p.source };
        })()
      : expandBare(c.call);
  } catch (e) {
    reportOutdated(name, label, `expansion refused: ${e.message}`, null, null);
    fail++;
    continue;
  }

  if (expansion.kind === "result") {
    const okr = c.expect ? c.expect({ local: expansion.text, values: [] }) : true;
    console.log(`${okr ? status.ok : status.fail}${name}${expansion.text}`);
    okr ? pass++ : fail++;
    continue;
  }

  if (c.needsDeploy || c.needsCaps) {
    console.log(`${status.skip}${name}${c.needsDeploy ? "needs-deploy (identifies its caller)" : "needs-caps (arguments must be registered)"}`);
    skipped++;
    continue;
  }

  const r = await explore(expansion.source);
  if (VERBOSE) console.log("\n--- " + label + "\n" + expansion.source + "\n--- answer: " + JSON.stringify(r) + "\n");
  if (r.error) {
    reportOutdated(name, label, "rnode refused the expansion", expansion.source, r.error);
    fail++;
  } else if (c.expect(r)) {
    console.log(`${status.ok}${name}${c.why ?? ""}`);
    pass++;
  } else {
    reportOutdated(name, label, `no answer, but it advertises: ${c.why}`,
                   expansion.source, r.values.length ? r.values.join(", ") : "(nothing)");
    fail++;
  }
}

console.log(`\n${pass} ok, ${fail} outdated, ${skipped} skipped (need a signed deploy or registered capabilities)`);
if (outdated.length) {
  console.log(`\nOutdated against rnode as it runs today:`);
  for (const o of outdated) console.log(`  %${o.name.trim()} — ${o.why}`);
  console.log(`\nEach is a caller that has fallen behind rnode, not a node fault.`);
  console.log(`Fix the definition, then update this check's case for it — a case`);
  console.log(`left agreeing with the old shape passes while the macro stays broken.`);
}
process.exit(fail === 0 ? 0 : 1);
