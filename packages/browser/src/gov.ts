// Pure governance module — groups, members, issues, and the liquid-democracy
// delegation resolver. No DOM, no storage, no app imports (mirrors polls.ts).
//
// Liquid democracy, governing rule (per issue): if a member casts a ballot their
// own vote counts (it overrides delegation); if they do NOT vote, their vote is
// cast by their standing delegate — transitively, flowing along delegation edges
// to whoever ultimately voted. A chain that reaches no direct voter, or loops,
// abstains. resolveWeights() turns (members, delegations, directVoters) into the
// per-direct-voter weight that feeds the (weighted) poll tally — a deterministic,
// joiner-local computation every peer reproduces from the signed graph it holds.

export type Role = "admin" | "member";
export type IssueStatus = "open" | "closed";

export interface Member { peerId: string; role: Role; label: string; at: number }
export interface Delegation { delegate: string; at: number }      // delegator -> { delegate }
export interface Issue { id: string; title: string; by: string; at: number; status: IssueStatus; pollId?: string }

export interface Group {
  id: string;
  name: string;
  creator: string;                          // creator peerId — admin by construction
  creatorLabel: string;
  createdAt: number;
  members: Record<string, Member>;          // peerId -> Member
  delegations: Record<string, Delegation>;  // delegator peerId -> { delegate, at } — standing/global
  // Optional per-issue delegate that overrides the global one for that issue:
  // issueId -> (delegator peerId -> { delegate, at }).
  topicDelegations?: Record<string, Record<string, Delegation>>;
  // Optional affirmative-trust ratings (the RGOV liquid-*trust* extension): each
  // member rates the trustworthiness of others, rater peerId -> ratee peerId ->
  // non-negative integer (0–TRUST_MAX). Self-signed (you set only your own row).
  // A member's base voting weight grows with the trust others place in them, so
  // delegation flow is weighted by earned trust — not one-person-one-vote.
  trustRatings?: Record<string, Record<string, number>>;
  // Optional accountability censures: censurer peerId -> target peerId -> 1. A
  // member of equal-or-higher standing flags a target as holding *undeserved*
  // trust; when credible censure outweighs the target's level they are
  // discredited (level→0) AND everyone who vouched for them is slashed by the
  // level they staked. Self-signed. This makes conferring trust a stake, not a
  // free action — accountability for assigning undeserved trust.
  censures?: Record<string, Record<string, number>>;
  // Optional `/note` currencies the group uses: a treasury (group funds) and a
  // kudos (reputation) currency. The admin declares them; balances are bearer
  // notes held privately by each member.
  treasury?: string;
  kudos?: string;
  issues: Issue[];
}

/** A valid `/note` currency derived from the group (treasury / kudos), unique per group. */
export function govCurrency(g: Group, suffix: string): string {
  const base = (g.name.replace(/[^A-Za-z0-9]/g, "") || "GRP").slice(0, 16);
  return `${base}_${g.id.slice(-4)}${suffix}`;
}

const normalize = (t: string): string => t.trim().toLowerCase().replace(/\s+/g, " ");

/** Stable content-hash id for an issue title (djb2 over normalized text). */
export function issueId(title: string): string {
  const s = normalize(title);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function isMember(g: Group, peerId: string): boolean { return peerId in g.members; }
export function isAdmin(g: Group, peerId: string): boolean {
  return peerId === g.creator || g.members[peerId]?.role === "admin";
}
export function memberLabel(g: Group, peerId: string): string {
  return g.members[peerId]?.label ?? peerId.slice(0, 8);
}
export function findIssue(g: Group, id: string): Issue | undefined {
  return g.issues.find((i) => i.id === id || issueId(i.title) === id);
}

export interface WeightResolution {
  weightByVoter: Record<string, number>;   // direct voter -> effective weight (1 + delegated subtree)
  flow: Record<string, string>;            // member -> the direct voter their vote flows to
  abstained: string[];                     // members whose chain dead-ends or loops with no direct voter
}

// Resolve effective voting weights for one issue.
//  - `members`: the electorate (peerIds). Only members carry weight.
//  - `delegations`: delegator -> delegate (delegate must be a member to count).
//  - `directVoters`: members who cast a ballot on this issue (override delegation).
//  - `trustWeights` (optional): member -> base weight. Default 1 per member, which
//    reproduces one-person-one-vote liquid democracy exactly. With trust ratings
//    (trustWeightsFor) a member carries the trust others place in them, so the
//    delegation flow is trust-weighted (the RGOV liquid-*trust* extension).
// Each member's vote flows along delegation edges to the first direct voter
// reached; weight(d) = Σ baseWeight(m) over members m flowing to d. Cycles /
// dead-ends with no direct voter abstain.
export function resolveWeights(
  members: string[],
  delegations: Record<string, string>,
  directVoters: Set<string>,
  trustWeights: Record<string, number> = {},
): WeightResolution {
  const memberSet = new Set(members);
  const weightByVoter: Record<string, number> = {};
  const flow: Record<string, string> = {};
  const abstained: string[] = [];

  const baseWeight = (m: string): number => {
    const w = trustWeights[m];
    return typeof w === "number" && w >= 0 ? w : 1;   // default / guard
  };

  for (const m of members) {
    const seen = new Set<string>();
    let node: string | undefined = m;
    let landed: string | null = null;
    while (node !== undefined) {
      if (directVoters.has(node)) { landed = node; break; }  // reached someone who voted
      if (seen.has(node)) break;                             // cycle, no direct voter
      seen.add(node);
      const next: string | undefined = delegations[node];
      if (next === undefined || !memberSet.has(next)) break; // dead-end (no / non-member delegate)
      node = next;
    }
    if (landed) {
      flow[m] = landed;
      weightByVoter[landed] = (weightByVoter[landed] ?? 0) + baseWeight(m);
    } else {
      abstained.push(m);
    }
  }
  return { weightByVoter, flow, abstained };
}

/** Trust levels: admins are the root (TRUST_MAX); each rating confers a level
 *  strictly below the rater's own. So 0..TRUST_MAX is the full rank ladder. */
export const TRUST_MAX = 5;

// Affirmative trust as a HIERARCHICAL web of trust rooted at the group's admins:
// a member may only confer a trust level **strictly below their own**. Admins are
// the trust root (level TRUST_MAX); a rating `v` from rater `r` confers
// `min(v, level(r) − 1)` on the ratee; a member's level is the highest level
// conferred on them. This is a monotone relaxation toward the least fixed point
// ≥ the admin seed, so it is deterministic (order-independent) and two untrusted
// members CANNOT bootstrap each other — trust must descend from an admin, and it
// strictly decreases at each hop. Returns peerId -> level (0..TRUST_MAX).
export function trustLevels(g: Group): Record<string, number> {
  const ids = Object.keys(g.members);
  const memberSet = new Set(ids);
  const ratings = g.trustRatings;

  // Phase 1 — positive trust: admin-rooted increasing least fixed point. A rating
  // v from r confers min(v, level(r)−1) — strictly below the rater's own level.
  const pos: Record<string, number> = {};
  for (const m of ids) pos[m] = isAdmin(g, m) ? TRUST_MAX : 0;     // admins seed the root
  if (ratings) {
    const maxRounds = ids.length * (TRUST_MAX + 1) + 1;            // LFP converges well within this
    for (let round = 0; round < maxRounds; round++) {
      let changed = false;
      for (const rater of ids) {
        const cap = pos[rater] - 1;                                // strictly below the rater's own level
        if (cap < 0) continue;                                     // level-0 members can confer nothing
        const row = ratings[rater];
        if (!row) continue;
        for (const ratee of Object.keys(row)) {
          if (ratee === rater || !memberSet.has(ratee)) continue;  // no self / non-member
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

  // Phase 2 — accountability: a decreasing fixed point. A censure from c against m
  // is credible when c's *current* standing ≥ m's; when credible censure weight
  // (Σ of censurers' levels) ≥ m's level, m is discredited (level→0) and every
  // member who conferred trust on m is slashed by the level they staked. Slashing
  // a voucher can in turn discredit them — the loop converges because levels only
  // fall (bounded by the phase-1 ceiling).
  const eff: Record<string, number> = { ...pos };
  const maxRounds = ids.length + 2;
  for (let round = 0; round < maxRounds; round++) {
    const against: Record<string, number> = {};
    for (const c of ids) {
      if (eff[c] <= 0) continue;
      const row = censures[c];
      if (!row) continue;
      for (const t of Object.keys(row)) {
        if (t === c || !memberSet.has(t) || !row[t]) continue;
        if (eff[c] >= eff[t]) against[t] = (against[t] ?? 0) + eff[c];   // credible: censurer outranks-or-ties target
      }
    }
    let changed = false;
    for (const m of ids) {
      if (eff[m] > 0 && (against[m] ?? 0) >= eff[m]) {              // discredited
        eff[m] = 0;
        changed = true;
        for (const v of ids) {                                     // slash everyone who vouched for m
          const stake = ratings?.[v]?.[m];
          if (typeof stake === "number" && stake > 0 && eff[v] > 0) {
            eff[v] = Math.max(0, eff[v] - Math.min(stake, pos[v]));
          }
        }
      }
    }
    if (!changed) break;
  }
  return eff;
}

/** Members discredited by accountability censure (level driven to 0 despite a
 *  positive phase-1 standing). Useful for status readouts. */
export function discreditedMembers(g: Group): string[] {
  if (!g.censures) return [];
  const eff = trustLevels(g);
  return Object.keys(g.members).filter(
    (m) => !isAdmin(g, m) && eff[m] === 0 &&
      Object.values(g.trustRatings ?? {}).some((row) => row && (row[m] ?? 0) > 0),
  );
}

// Per-member base voting weight for resolveWeights: `1 + trustLevel(m)`. With NO
// ratings anywhere the group is flat (weight 1 each) — trust weighting is opt-in
// and backward-compatible; once any rating exists the admin-rooted hierarchy
// (trustLevels) applies and admins carry the root weight `1 + TRUST_MAX`.
export function trustWeightsFor(g: Group): Record<string, number> {
  const ids = Object.keys(g.members);
  const out: Record<string, number> = {};
  const hasRatings = !!g.trustRatings &&
    Object.values(g.trustRatings).some((row) => row && Object.keys(row).length > 0);
  if (!hasRatings) { for (const m of ids) out[m] = 1; return out; }
  const level = trustLevels(g);
  for (const m of ids) out[m] = 1 + (level[m] ?? 0);
  return out;
}

/** Members (excluding self) whose vote flowed to `voter`, for a "self + A + B" readout. */
export function delegatorsOf(res: WeightResolution, voter: string): string[] {
  return Object.entries(res.flow).filter(([m, d]) => d === voter && m !== voter).map(([m]) => m);
}

// The effective delegation map for one issue: each member's per-issue delegate
// (topicDelegations[issueId]) overrides their standing/global delegate. Feed the
// result straight into resolveWeights — the resolver itself is unchanged.
export function delegationMapFor(g: Group, issueIdStr: string): Record<string, string> {
  const topic = g.topicDelegations?.[issueIdStr] ?? {};
  const out: Record<string, string> = {};
  for (const peerId of Object.keys(g.members)) {
    const d = topic[peerId]?.delegate ?? g.delegations[peerId]?.delegate;
    if (d) out[peerId] = d;
  }
  return out;
}
