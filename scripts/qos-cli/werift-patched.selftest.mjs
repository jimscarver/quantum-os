// werift-patched.selftest.mjs — the #125 fingerprint memo does what it claims,
// and a werift bump that renames the method / property is caught here.
//
//   node werift-patched.selftest.mjs

import { RTCPeerConnection } from "./werift-patched.mjs";

let failed = 0;
const ok = (label, cond, detail = "") => {
  console.log((cond ? "  ok   " : "  FAIL ") + label + (cond ? "" : `  (${detail})`));
  if (!cond) failed++;
};

// Build a cert the way werift does — an RTCPeerConnection with a data channel,
// then take its DTLS transport's self-signed certificate.
const pc = new RTCPeerConnection({ iceServers: [] });
pc.createDataChannel("probe");
await pc.setLocalDescription(await pc.createOffer());
const cert = pc.sctpTransport.dtlsTransport.localCertificate;

ok("a self-signed certificate was set up", !!cert);
ok("getFingerprints still exists", typeof cert?.getFingerprints === "function");

const a = cert.getFingerprints();
const b = cert.getFingerprints();

ok("returns a non-empty fingerprint list",
  Array.isArray(a) && a.length >= 1 && typeof a[0]?.value === "string",
  JSON.stringify(a));
ok("the value is a colon-formatted SHA-256 (unchanged shape)",
  a[0]?.algorithm === "sha-256" && /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/.test(a[0]?.value ?? ""),
  a[0]?.value);
ok("a second call returns the identical array (memoized)", a === b);

// The cache is keyed on certPem: a change forces a recompute (werift never does
// this, but the guard should hold), and restoring recomputes rather than
// serving a stale value.
const before = cert.getFingerprints();
const realPem = cert.certPem;
cert.certPem = realPem + "\n";
const changed = cert.getFingerprints();
ok("a certPem change invalidates the cache", changed !== before);
cert.certPem = realPem;
ok("restoring certPem recomputes (not stuck stale)", cert.getFingerprints() !== changed);
ok("...and matches the original value again", cert.getFingerprints()[0].value === before[0].value);

// The whole point: the cold call parses the cert PEM (ASN.1) and hashes it —
// ~1.5ms on a laptop — and #125's hot path does it on every inbound ICE
// candidate. The memoized call must be orders of magnitude cheaper. Force a
// genuine cold measurement by clearing the instance memo each time.
const coldSamples = [];
for (let i = 0; i < 25; i++) {
  delete cert.__qosFpCache;
  delete cert.__qosFpForCertPem;
  const t0 = process.hrtime.bigint();
  cert.getFingerprints();
  coldSamples.push(Number(process.hrtime.bigint() - t0));
}
coldSamples.sort((x, y) => x - y);
const cold = coldSamples[12]; // median
let t = process.hrtime.bigint();
for (let i = 0; i < 20000; i++) cert.getFingerprints();
const warm = Number(process.hrtime.bigint() - t) / 20000;
ok(`memoized call is >50x cheaper (cold ${(cold / 1e3).toFixed(0)}µs · warm ${(warm / 1e3).toFixed(3)}µs · ${(cold / warm).toFixed(0)}x)`,
  warm * 50 < cold, `cold=${cold}ns warm=${warm}ns`);

pc.close();
console.log(failed === 0 ? "\nwerift-patched: all passed" : `\nwerift-patched: ${failed} FAILED`);
process.exit(failed ? 1 : 0);
