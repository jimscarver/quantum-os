#!/usr/bin/env node
// signal-probe.mjs — what rate does a signaling server actually enforce?
//
//   node signal-probe.mjs [wss://host]        (default: the public server)
//
// The limit is the room ceiling: a peer joining a room of N sends N-1 offers
// and their ICE candidates, so a tight limit stops handshakes completing while
// every peer still appears in the room. It comes from the environment, so a
// deploy proves nothing about it — this measures what is enforced.
//
// `GET /` reports `limit`/`burst` directly on servers new enough to. This is
// for the ones that do not, and for confirming they are telling the truth.
//
// The limiter is per-connection, so this only ever throttles this probe.
import { WebSocket } from "ws";

const url = process.argv[2] ?? "wss://quantum-os-signaling.onrender.com";
const GAP_MS = 8;            // between sends
const CAP = 300;             // give up after this many

const ws = new WebSocket(url);
let sent = 0, refused = 0, firstRefusalAt = null;
const t0 = Date.now();

ws.on("open", () => {
  const tick = setInterval(() => {
    if (sent >= CAP || firstRefusalAt !== null && sent > firstRefusalAt + 20) {
      clearInterval(tick);
      setTimeout(report, 400);
      return;
    }
    // An unknown type is answered, counted by the limiter, and changes nothing.
    ws.send(JSON.stringify({ type: "probe" }));
    sent++;
  }, GAP_MS);
});

ws.on("message", (d) => {
  let m; try { m = JSON.parse(d.toString()); } catch { return; }
  if (m.type === "error" && /rate limit/.test(m.message ?? "")) {
    refused++;
    if (firstRefusalAt === null) firstRefusalAt = sent;
  }
});

ws.on("error", (e) => { console.error("probe failed:", e.message); process.exit(1); });

function report() {
  const secs = (Date.now() - t0) / 1000;
  console.log(`${url}`);
  console.log(`  sent ${sent} in ${secs.toFixed(1)}s · refused ${refused}` +
    (firstRefusalAt === null ? "" : ` · first refusal at message ${firstRefusalAt}`));
  if (firstRefusalAt === null) {
    console.log(`  → nothing refused: the sustained limit is at or above ${Math.round(sent / secs)}/s`);
  } else {
    // A token bucket of 4L, refilling L per second, sending one per GAP_MS,
    // empties at n ≈ 4L / (1 - L·GAP). Inverting gives the limit it implies.
    const gap = GAP_MS / 1000;
    const L = Math.round(firstRefusalAt / (4 + firstRefusalAt * gap));
    console.log(`  → implies a sustained limit near ${L}/s`);
    console.log(`     (20/s is the code default — a room stops connecting everyone at about four peers)`);
  }
  process.exit(0);
}
