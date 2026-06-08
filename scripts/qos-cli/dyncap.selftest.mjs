// Offline self-test of the dyncap port (no network, no werift). Validates the
// sign→verify chain, canonicalization determinism, fork detection, and state
// round-trip — i.e. that the daemon's signatures will verify in the browser.
// Run: node dyncap.selftest.mjs
import {
  newDynCapState, signEnvelope, verifyEnvelope,
  serializeState, deserializeState, toHex,
} from "./dyncap.mjs";

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) fail++; };
const ROOM = "cap:room:0521";

// 1. sign → verify = tofu (first sight), then ok (chain extends).
const st = await newDynCapState();
const e1 = { kind: "name", name: "memory" };
const dc1 = await signEnvelope(st, ROOM, e1);
ok(dc1.seq === 1 && dc1.anchor.length === 64 && dc1.witness.length === 64, "signEnvelope yields seq=1, 64-hex anchor+witness");
const v1 = await verifyEnvelope(undefined, ROOM, e1, dc1);
ok(v1.kind === "tofu", "first verify = tofu");

const e2 = { kind: "name", name: "memory2" };
const dc2 = await signEnvelope(st, ROOM, e2);
ok(dc2.seq === 2, "second sign increments seq");
const v2 = await verifyEnvelope(v1.entry, ROOM, e2, dc2);
ok(v2.kind === "ok", "chain extends = ok");

// replay (same seq+witness) is idempotent ok.
const vr = await verifyEnvelope(v2.entry, ROOM, e2, dc2);
ok(vr.kind === "ok", "replay of same (seq,witness) = ok");

// 2. canonicalization determinism: same seed+seq+room, key order swapped → equal witness.
const seed = (await newDynCapState()).seed;
const A = await newDynCapState(seed);
const B = await newDynCapState(seed);
const wa = await signEnvelope(A, ROOM, { kind: "x", a: 1, b: 2, nested: { y: 2, x: 1 } });
const wb = await signEnvelope(B, ROOM, { kind: "x", nested: { x: 1, y: 2 }, b: 2, a: 1 });
ok(wa.seq === wb.seq && wa.witness === wb.witness, "canonicalization is key-order independent (equal witness)");

// 3. fork detection: a different witness at an already-seen seq.
const forged = { anchor: dc1.anchor, seq: 1, witness: "f".repeat(64) };
const vf = await verifyEnvelope(v2.entry, ROOM, e1, forged);
ok(vf.kind === "fork", "different witness at seen seq = fork");

// anchor mismatch.
const vm = await verifyEnvelope(v2.entry, ROOM, e1, { anchor: "a".repeat(64), seq: 9, witness: "b".repeat(64) });
ok(vm.kind === "anchor-mismatch", "different anchor = anchor-mismatch");

// malformed shape.
const vbad = await verifyEnvelope(undefined, ROOM, e1, { anchor: "short", seq: 0, witness: "x" });
ok(vbad.kind === "invalid", "malformed dyncap = invalid");

// 4. state round-trip.
const restored = await deserializeState(serializeState(st));
ok(restored && toHex(restored.seed) === toHex(st.seed) && restored.anchor === st.anchor && restored.seqByRoom[ROOM] === st.seqByRoom[ROOM],
   "serialize→deserialize state round-trips (seed, anchor, seqByRoom)");

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
process.exit(fail === 0 ? 0 : 1);
