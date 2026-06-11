// Pure poll-tally module — no DOM, no storage, no app imports (mirrors probe.ts).
//
// Options are referenced by a stable content-hash **id**, never by array
// position: options are collected from the group by broadcast and arrive in
// different orders on different peers, so an index would mean different things
// on different peers. Hashing the normalized text also auto-dedupes identical
// suggestions. Given ids, the approval and ranked (IRV) tallies are pure,
// deterministic functions of (options, ballots): every peer computes the same
// result from the ballots it holds — joiner-local, no central counter.

export type PollMethod = "approval" | "ranked";
export type PollStatus = "open" | "closed";

export interface PollOption { id: string; text: string; by: string; at: number }

export interface Poll {
  id: string;
  question: string;
  options: PollOption[];               // collected; referenced by stable id
  method: PollMethod;
  creator: string;                     // creator peerId — authoritative for close/lock
  creatorLabel: string;
  createdAt: number;
  status: PollStatus;
  nominationsLocked?: boolean;         // creator may lock to stop new options
  ballots: Record<string, string[]>;   // peerId -> option ids (approval set / ranked order)
  result?: PollResult;
}

export interface ApprovalResult { method: "approval"; counts: Record<string, number>; winners: string[]; totalBallots: number }
export interface IrvRound { counts: Record<string, number>; eliminated: string | null; exhausted: number }
export interface RankedResult { method: "ranked"; rounds: IrvRound[]; winners: string[]; totalBallots: number }
export type PollResult = ApprovalResult | RankedResult;

const normalize = (t: string): string => t.trim().toLowerCase().replace(/\s+/g, " ");

/** Stable content-hash id for an option (djb2 over normalized text). */
export function optionId(text: string): string {
  const s = normalize(text);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function validIds(poll: Poll): Set<string> { return new Set(poll.options.map((o) => o.id)); }

function cleanBallot(ballot: string[], valid: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ballot) if (valid.has(id) && !seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}

// Each voter's ballot counts `weights[peerId]` times (default 1). At all-1
// weights this is one-person-one-vote, unchanged; the governance layer passes
// liquid-democracy weights resolved from the delegation graph. `totalBallots` is
// the total *weight* cast (== ballot count when unweighted).
const ballotWeight = (weights: Record<string, number> | undefined, peer: string): number =>
  weights ? (weights[peer] ?? 0) : 1;

export function tallyApproval(poll: Poll, weights?: Record<string, number>): ApprovalResult {
  const valid = validIds(poll);
  const counts: Record<string, number> = {};
  for (const o of poll.options) counts[o.id] = 0;
  let total = 0;
  for (const [peer, b] of Object.entries(poll.ballots)) {
    const clean = cleanBallot(b, valid);
    if (clean.length === 0) continue;
    const w = ballotWeight(weights, peer);
    if (w <= 0) continue;
    for (const id of clean) counts[id] += w;
    total += w;
  }
  let max = 0;
  for (const o of poll.options) if (counts[o.id] > max) max = counts[o.id];
  const winners = max > 0 ? poll.options.filter((o) => counts[o.id] === max).map((o) => o.id) : [];
  return { method: "approval", counts, winners, totalBallots: total };
}

export function tallyRanked(poll: Poll, weights?: Record<string, number>): RankedResult {
  const valid = validIds(poll);
  const ids = poll.options.map((o) => o.id);
  const ballots = Object.entries(poll.ballots)
    .map(([peer, b]) => ({ ranks: cleanBallot(b, valid), w: ballotWeight(weights, peer) }))
    .filter((x) => x.ranks.length > 0 && x.w > 0);
  const total = ballots.reduce((s, x) => s + x.w, 0);
  const eliminated = new Set<string>();
  const rounds: IrvRound[] = [];

  for (let guard = 0; guard <= ids.length; guard++) {
    const counts: Record<string, number> = {};
    for (const id of ids) counts[id] = 0;
    let exhausted = 0;
    for (const b of ballots) {
      const top = b.ranks.find((id) => !eliminated.has(id));
      if (top === undefined) exhausted += b.w;
      else counts[top] += b.w;
    }
    const continuing = total - exhausted;
    const display: Record<string, number> = {};
    for (const id of ids) display[id] = eliminated.has(id) ? -1 : counts[id];
    const nonElim = ids.filter((id) => !eliminated.has(id));

    let leaderCount = -1;
    for (const id of nonElim) if (counts[id] > leaderCount) leaderCount = counts[id];

    if (continuing === 0) {
      rounds.push({ counts: display, eliminated: null, exhausted });
      return { method: "ranked", rounds, winners: [], totalBallots: total };
    }
    if (leaderCount * 2 > continuing) {
      rounds.push({ counts: display, eliminated: null, exhausted });
      return { method: "ranked", rounds, winners: nonElim.filter((id) => counts[id] === leaderCount), totalBallots: total };
    }
    if (nonElim.length <= 1) {
      rounds.push({ counts: display, eliminated: null, exhausted });
      return { method: "ranked", rounds, winners: nonElim, totalBallots: total };
    }
    // eliminate the lowest; deterministic tie-break = smallest option id
    let minCount = Infinity;
    for (const id of nonElim) if (counts[id] < minCount) minCount = counts[id];
    const victim = nonElim.filter((id) => counts[id] === minCount).sort()[0];
    eliminated.add(victim);
    rounds.push({ counts: display, eliminated: victim, exhausted });
  }
  return { method: "ranked", rounds, winners: [], totalBallots: total };
}

export function tally(poll: Poll, weights?: Record<string, number>): PollResult {
  return poll.method === "ranked" ? tallyRanked(poll, weights) : tallyApproval(poll, weights);
}

/** Per-option live counts (approval counts, or IRV first-preferences). */
export function liveCounts(poll: Poll): Record<string, number> {
  if (poll.method === "approval") return tallyApproval(poll).counts;
  const first = tallyRanked(poll).rounds[0]?.counts ?? {};
  const out: Record<string, number> = {};
  for (const o of poll.options) out[o.id] = Math.max(0, first[o.id] ?? 0);
  return out;
}

/** Options in a deterministic display order (add-time, then id) — same on every peer. */
export function sortedOptions(poll: Poll): PollOption[] {
  return [...poll.options].sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function summarizeWinners(poll: Poll, result: PollResult): string {
  const text = (ids: string[]) => ids.map((id) => poll.options.find((o) => o.id === id)?.text ?? id).join(", ");
  if (result.winners.length === 0) return "no winner (no votes)";
  if (result.winners.length === 1) return `winner: ${text(result.winners)}`;
  return `tie: ${text(result.winners)}`;
}
