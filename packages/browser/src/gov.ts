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
// Each member's single vote flows along delegation edges to the first direct
// voter reached; weight(d) = 1 + #(members flowing to d). Cycles / dead-ends
// with no direct voter abstain.
export function resolveWeights(
  members: string[],
  delegations: Record<string, string>,
  directVoters: Set<string>,
): WeightResolution {
  const memberSet = new Set(members);
  const weightByVoter: Record<string, number> = {};
  const flow: Record<string, string> = {};
  const abstained: string[] = [];

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
      weightByVoter[landed] = (weightByVoter[landed] ?? 0) + 1;
    } else {
      abstained.push(m);
    }
  }
  return { weightByVoter, flow, abstained };
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
