// werift-patched.mjs — re-export `werift` with one hot-path fix for
// quantum-os#125, applied to the shared class prototype at import time.
//
// ## The problem
//
// `werift`'s `RTCCertificate.getFingerprints()` re-parses the certificate PEM
// (ASN.1 / x509 decode) and re-hashes it (SHA-256 + colon-format) on **every
// call**. `peerConnection.js` rebuilds the entire offer SDP — and calls this,
// twice, via `addTransportDescription` → `get localParameters` — on **every
// inbound ICE candidate**. A room of a few peers doing ordinary ICE keepalives
// / consent-freshness / trickle is a continuous stream of full-SDP rebuilds,
// and two headless agents co-located on one machine burn ~40% of a core each
// with the room otherwise idle and their logs quiet. Profile tail:
//
//   addIceCandidate → buildOfferSdp → addTransportDescription
//     → get localParameters → getFingerprints
//     → Certificate.fromPEM(certPem)  ·  fingerprint(raw, "sha256")
//
// ## The fix
//
// The fingerprint is a pure function of the certificate. werift generates the
// self-signed cert once in `setupCertificate()` (which already guards against
// regenerating) and never mutates `certPem` afterward. So: memoize the result
// on the instance, keyed on `certPem` so a hypothetical cert swap still
// recomputes. Nothing else about werift's behaviour changes — the returned
// `RTCDtlsFingerprint[]` is byte-identical, just computed once.
//
// Patching the prototype (rather than vendoring werift or a patch-package
// postinstall) keeps this to one small, readable file with no new dependency,
// and it is idempotent: importing this module more than once, or alongside a
// direct `import … from "werift"`, is safe — the class object is shared through
// Node's module cache, so the first import to reach here patches it for the
// whole process. `werift-patched.selftest.mjs` guards against a werift bump
// that renames the method or the property.

import { RTCCertificate } from "werift";

if (RTCCertificate && !RTCCertificate.prototype.__qosFingerprintCache) {
  const original = RTCCertificate.prototype.getFingerprints;

  RTCCertificate.prototype.getFingerprints = function getFingerprints() {
    if (this.__qosFpCache !== undefined && this.__qosFpForCertPem === this.certPem) {
      return this.__qosFpCache;
    }
    this.__qosFpForCertPem = this.certPem;
    this.__qosFpCache = original.call(this);
    return this.__qosFpCache;
  };

  RTCCertificate.prototype.__qosFingerprintCache = true; // idempotence guard
}

export { RTCPeerConnection, RTCCertificate } from "werift";
