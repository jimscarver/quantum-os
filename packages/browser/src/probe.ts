/// State-discrepancy detection with joiner-local majority resolution.
///
/// On joining a room, a peer collects sync snapshots from up to SAMPLE_SIZE
/// existing peers within a fixed window. For each key (lemma name, currency
/// token) seen across snapshots, the joiner tallies which peers reported
/// which value. Disagreement is exposed as a `state-discrepancy` broadcast;
/// the joiner adopts the most-voted value as their own (tie-break = first
/// observed value).
///
/// This is not full consensus — there's no finality, no Byzantine-tolerant
/// vote, no resolution rule that binds the room. It's *observable
/// disagreement plus a local majority decision*. The room sees the
/// discrepancy and can adjudicate at the social layer; the joiner doesn't
/// silently inherit a forged sync entry from whichever peer happened to
/// answer first.

export const SAMPLE_SIZE = 5;       // collect up to this many distinct snapshots
export const PROBE_WINDOW_MS = 5000; // close the window after this many ms

export type StoreName = "lemmas" | "currencies";

export interface Observation {
  storeName: StoreName;
  key: string;        // lemma name, or currency token
  value: string;      // JSON-encoded normalized value for set membership
  peer: string;       // sender's peer ID
}

export interface DiscrepancyObservation {
  value: string;      // JSON-encoded (same as Observation.value)
  peers: string[];    // peer IDs that reported this value
  count: number;
}

export interface Discrepancy {
  storeName: StoreName;
  key: string;
  observations: DiscrepancyObservation[]; // sorted by count desc
  winner: string;     // JSON-encoded winning value
}

/// Group observations by (storeName, key); for keys where more than one
/// distinct value was reported, return a Discrepancy. The first element of
/// each `observations` array is the winner (most-voted; ties broken by
/// first-seen order in the input).
export function findDiscrepancies(observations: Observation[]): Discrepancy[] {
  const byKey = new Map<string, Map<string, Set<string>>>();
  // Insertion-order preservation: track first-seen value per key.
  const firstSeen = new Map<string, string>();

  for (const obs of observations) {
    const groupKey = `${obs.storeName}::${obs.key}`;
    let valueMap = byKey.get(groupKey);
    if (!valueMap) { valueMap = new Map(); byKey.set(groupKey, valueMap); }
    let peerSet = valueMap.get(obs.value);
    if (!peerSet) {
      peerSet = new Set();
      valueMap.set(obs.value, peerSet);
      if (!firstSeen.has(groupKey)) firstSeen.set(groupKey, obs.value);
    }
    peerSet.add(obs.peer);
  }

  const out: Discrepancy[] = [];
  for (const [groupKey, valueMap] of byKey) {
    if (valueMap.size < 2) continue;
    const [storeName, key] = groupKey.split("::") as [StoreName, string];
    const observations: DiscrepancyObservation[] = Array.from(valueMap.entries())
      .map(([value, peers]) => ({ value, peers: Array.from(peers), count: peers.size }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        // Tie-break by first-seen order — earlier wins
        if (a.value === firstSeen.get(groupKey)) return -1;
        if (b.value === firstSeen.get(groupKey)) return  1;
        return 0;
      });
    out.push({
      storeName, key,
      observations,
      winner: observations[0].value,
    });
  }
  return out;
}

/// Collect peer IDs whose snapshot landed in a non-winning bucket of any
/// discrepancy. These peers contributed values that lost the vote; per the
/// "losing nodes are ignored" rule, their subsequent sync contributions are
/// dropped going forward.
export function losingPeersIn(discrepancies: Discrepancy[]): Set<string> {
  const losers = new Set<string>();
  for (const d of discrepancies) {
    // Index 0 is the winner; everything from index 1 onward lost.
    for (let i = 1; i < d.observations.length; i++) {
      for (const peer of d.observations[i].peers) losers.add(peer);
    }
  }
  return losers;
}

/// Normalize a value for membership comparison. Keys are sorted to defeat
/// JSON key-order differences from different serializers; an optional list
/// of fields to omit (e.g. peer-local volatile fields) lets us compare the
/// substantive content.
export function normalizeValue(value: unknown, omit: string[] = []): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return JSON.stringify(value.map(v => JSON.parse(normalizeValue(v, omit))));
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    if (omit.includes(k)) continue;
    sorted[k] = JSON.parse(normalizeValue(obj[k], omit));
  }
  return JSON.stringify(sorted);
}
