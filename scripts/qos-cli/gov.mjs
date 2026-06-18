// Faithful port of the trust math from packages/browser/src/gov.ts (the parts an
// agent needs to compute ITS OWN standing). No DOM, no app imports. Kept byte-for-
// byte equivalent to the browser's trustLevels / discreditedMembers so an agent's
// self-assessment matches what every browser computes from the same signed graph.
//
// A Group here is the same shape the browser sends/persists:
//   { id, name, creator, creatorLabel, createdAt,
//     members:        { peerId: { peerId, role:"admin"|"member", label, at } },
//     trustRatings?:  { raterPeerId: { rateePeerId: level(0..TRUST_MAX) } },
//     censures?:      { censurerPeerId: { targetPeerId: 1 } },
//     delegations?, issues? } — only members/trustRatings/censures matter here.

export const TRUST_MAX = 5;

export function isMember(g, peerId) { return !!g.members && peerId in g.members; }
export function isAdmin(g, peerId) {
  return peerId === g.creator || g.members?.[peerId]?.role === "admin";
}

/** True if the group has any non-empty trust rating row (⇒ the hierarchy is active). */
export function groupHasRatings(g) {
  return !!g.trustRatings && Object.values(g.trustRatings).some((row) => row && Object.keys(row).length > 0);
}

/** peerId -> trust level (0..TRUST_MAX). Admin-rooted positive trust (phase 1) then
 *  ⅔-quorum accountability censure (phase 2). Port of gov.ts trustLevels. */
export function trustLevels(g) {
  const ids = Object.keys(g.members ?? {});
  const memberSet = new Set(ids);
  const ratings = g.trustRatings;

  // Phase 1 — positive trust: admin-rooted increasing least fixed point.
  const pos = {};
  for (const m of ids) pos[m] = isAdmin(g, m) ? TRUST_MAX : 0;
  if (ratings) {
    const maxRounds = ids.length * (TRUST_MAX + 1) + 1;
    for (let round = 0; round < maxRounds; round++) {
      let changed = false;
      for (const rater of ids) {
        const cap = pos[rater] - 1;
        if (cap < 0) continue;
        const row = ratings[rater];
        if (!row) continue;
        for (const ratee of Object.keys(row)) {
          if (ratee === rater || !memberSet.has(ratee)) continue;
          const v = row[ratee];
          if (typeof v !== "number" || !(v > 0)) continue;
          const conferred = Math.min(v, cap);
          if (conferred > pos[ratee]) { pos[ratee] = conferred; changed = true; }
        }
      }
      if (!changed) break;
    }
  }

  const censures = g.censures;
  if (!censures) return pos;

  // Phase 2 — accountability: ⅔-supermajority (min 2) censure discredit + slashing.
  const eff = { ...pos };
  const maxRounds = ids.length + 2;
  for (let round = 0; round < maxRounds; round++) {
    const toDiscredit = [];
    for (const t of ids) {
      if (eff[t] <= 0) continue;
      let eligible = 0, censured = 0;
      for (const c of ids) {
        if (c === t || eff[c] < eff[t]) continue;
        eligible++;
        if (censures[c]?.[t] && memberSet.has(t)) censured++;
      }
      const quorum = Math.max(2, Math.ceil((2 * eligible) / 3));
      if (censured >= quorum) toDiscredit.push(t);
    }
    if (toDiscredit.length === 0) break;
    for (const t of toDiscredit) {
      eff[t] = 0;
      for (const v of ids) {
        const stake = ratings?.[v]?.[t];
        if (typeof stake === "number" && stake > 0 && eff[v] > 0) {
          eff[v] = Math.max(0, eff[v] - Math.min(stake, pos[v]));
        }
      }
    }
  }
  return eff;
}

/** Members discredited by censure (level driven to 0 despite a positive phase-1 standing). */
export function discreditedMembers(g) {
  if (!g.censures) return [];
  const eff = trustLevels(g);
  return Object.keys(g.members ?? {}).filter(
    (m) => !isAdmin(g, m) && eff[m] === 0 &&
      Object.values(g.trustRatings ?? {}).some((row) => row && (row[m] ?? 0) > 0),
  );
}

/** Ensure a group object received over the wire has the maps the math expects. */
export function normalizeGroup(g) {
  return {
    id: g.id, name: g.name ?? "", creator: g.creator, creatorLabel: g.creatorLabel ?? "",
    createdAt: g.createdAt ?? 0,
    members: g.members ?? {}, trustRatings: g.trustRatings ?? {}, censures: g.censures ?? {},
    delegations: g.delegations ?? {}, issues: g.issues ?? [],
  };
}
