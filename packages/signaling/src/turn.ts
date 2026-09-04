// Cloudflare Realtime TURN credential minting — server-side only.
//
// Chat between two peers survives a NAT/CGNAT boundary because it floods
// through quantum-os's relay overlay (peer -> agent -> peer). A WebRTC media
// track cannot be relayed that way (see CLAUDE.md "Calls must work across
// networks" / quantum-os#126) — a call between two peers who can't form a
// direct ICE pair (symmetric NAT, mobile CGNAT, a NAT'd container) produces
// no video at all, silently. Without a default TURN relay that is most calls
// between two networks, which is most calls this tool is actually for.
//
// TURN_KEY_ID / TURN_KEY_API_TOKEN come from Cloudflare Realtime's TURN
// Service and must be set as environment variables on the signaling
// deployment (Render dashboard -> Environment) — NEVER in render.yaml (it's
// committed to the repo) and never shipped to the browser. What a client gets
// back from GET /turn is a short-lived username/credential pair Cloudflare
// itself mints and expires; the master API token never leaves this process.
type TurnIceServer = { urls: string[]; username: string; credential: string };

const TURN_KEY_ID = process.env.TURN_KEY_ID;
const TURN_KEY_API_TOKEN = process.env.TURN_KEY_API_TOKEN;

// Requested from Cloudflare: how long the minted credential is valid for.
const CREDENTIAL_TTL_S = 24 * 60 * 60; // 24h
// How long THIS PROCESS reuses one minted credential before minting a fresh
// one — well under CREDENTIAL_TTL_S so anything served always has most of its
// life ahead of it, and long enough that a room full of joiners in the same
// hour doesn't mint one credential per join.
const CACHE_MS = 60 * 60 * 1000; // 1h

let cached: { server: TurnIceServer; at: number } | null = null;
let warnedMissing = false;

export function turnConfigured(): boolean {
  return Boolean(TURN_KEY_ID && TURN_KEY_API_TOKEN);
}

/** A short-lived TURN (+ STUN) server entry for GET /turn, or null if unconfigured/unreachable. */
export async function getTurnCredentials(): Promise<TurnIceServer | null> {
  if (!turnConfigured()) {
    if (!warnedMissing) {
      console.warn("[turn] TURN_KEY_ID / TURN_KEY_API_TOKEN not set — /turn serves no relay; "
        + "calls between peers who can't form a direct connection will have no video.");
      warnedMissing = true;
    }
    return null;
  }
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.server;
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: CREDENTIAL_TTL_S }),
      },
    );
    if (!res.ok) throw new Error(`cloudflare turn ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { iceServers: TurnIceServer };
    cached = { server: data.iceServers, at: Date.now() };
    return cached.server;
  } catch (err) {
    console.error("[turn] mint failed:", err instanceof Error ? err.message : err);
    // Serve a stale credential rather than nothing if we have one — Cloudflare
    // is the actual authority on when it expires, so a failure to re-mint on
    // OUR side doesn't mean the last one stopped working.
    return cached?.server ?? null;
  }
}
