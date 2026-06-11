// Pure poll-tally module — no DOM, no storage, no app imports (mirrors probe.ts).
//
// Approval and ranked-choice (IRV) tallies are deterministic functions of
// (options, ballots): every peer computes the same result from the ballots it
// holds, regardless of arrival order. That is what lets the tally be
// joiner-local with no central counter, the same model as the consensus probe.

export type PollMethod = "approval" | "ranked";
export type PollStatus = "open" | "closed";

export interface Poll {
  id: string;
  question: string;
  options: string[];                 // ballots reference options by index
  method: PollMethod;
  creator: string;                   // creator peerId — authoritative for close
  creatorLabel: string;
  createdAt: number;
  closesAt?: number;
  status: PollStatus;
  // peerId -> option indices.  approval: a set (order ignored).
  //                            ranked:   preference order, most-preferred first.
  ballots: Record<string, number[]>;
  result?: PollResult;               // cached on close; also recomputable live
}

export interface ApprovalResult {
  method: "approval";
  counts: number[];                  // approvals per option index
  winners: number[];                 // option indices tied at the max (empty if no votes)
  totalBallots: number;
}

export interface IrvRound {
  counts: number[];                  // continuing first-choices; -1 = eliminated
  eliminated: number | null;         // option eliminated this round (null on terminal round)
  exhausted: number;                 // ballots with no continuing preference
}

export interface RankedResult {
  method: "ranked";
  rounds: IrvRound[];
  winners: number[];                 // usually 1; >1 only on an unbreakable terminal tie
  totalBallots: number;
}

export type PollResult = ApprovalResult | RankedResult;

/** Drop out-of-range and duplicate indices, preserving order. */
function dedupeInRange(ballot: number[], n: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const idx of ballot) {
    if (Number.isInteger(idx) && idx >= 0 && idx < n && !seen.has(idx)) {
      seen.add(idx);
      out.push(idx);
    }
  }
  return out;
}

export function tallyApproval(poll: Poll): ApprovalResult {
  const n = poll.options.length;
  const counts = new Array<number>(n).fill(0);
  let total = 0;
  for (const ballot of Object.values(poll.ballots)) {
    const clean = dedupeInRange(ballot, n);
    if (clean.length === 0) continue;
    for (const idx of clean) counts[idx]++;
    total++;
  }
  let max = 0;
  for (const c of counts) if (c > max) max = c;
  const winners: number[] = [];
  if (max > 0) for (let i = 0; i < n; i++) if (counts[i] === max) winners.push(i);
  return { method: "approval", counts, winners, totalBallots: total };
}

export function tallyRanked(poll: Poll): RankedResult {
  const n = poll.options.length;
  const ballots = Object.values(poll.ballots)
    .map((b) => dedupeInRange(b, n))
    .filter((b) => b.length > 0);
  const total = ballots.length;
  const eliminated = new Set<number>();
  const rounds: IrvRound[] = [];

  // At most n elimination rounds; guard bounds the loop regardless.
  for (let guard = 0; guard <= n; guard++) {
    const counts = new Array<number>(n).fill(0);
    let exhausted = 0;
    for (const b of ballots) {
      const top = b.find((idx) => !eliminated.has(idx));
      if (top === undefined) exhausted++;
      else counts[top]++;
    }
    const continuing = total - exhausted;
    const display = counts.map((c, i) => (eliminated.has(i) ? -1 : c));

    let leader = -1, leaderCount = -1;
    for (let i = 0; i < n; i++) {
      if (eliminated.has(i)) continue;
      if (counts[i] > leaderCount) { leaderCount = counts[i]; leader = i; }
    }
    const nonElim: number[] = [];
    for (let i = 0; i < n; i++) if (!eliminated.has(i)) nonElim.push(i);

    if (continuing === 0) {                 // every ballot exhausted — no winner
      rounds.push({ counts: display, eliminated: null, exhausted });
      return { method: "ranked", rounds, winners: [], totalBallots: total };
    }
    if (leaderCount * 2 > continuing) {     // majority of continuing ballots
      rounds.push({ counts: display, eliminated: null, exhausted });
      return { method: "ranked", rounds, winners: nonElim.filter((i) => counts[i] === leaderCount), totalBallots: total };
    }
    if (nonElim.length <= 1) {              // cannot reduce further
      rounds.push({ counts: display, eliminated: null, exhausted });
      return { method: "ranked", rounds, winners: nonElim, totalBallots: total };
    }

    // eliminate the lowest; deterministic tie-break = lowest option index
    let minCount = Infinity;
    for (const i of nonElim) if (counts[i] < minCount) minCount = counts[i];
    let victim = nonElim[0];
    for (const i of nonElim) if (counts[i] === minCount) { victim = i; break; }
    eliminated.add(victim);
    rounds.push({ counts: display, eliminated: victim, exhausted });
  }
  return { method: "ranked", rounds, winners: [], totalBallots: total };
}

export function tally(poll: Poll): PollResult {
  return poll.method === "ranked" ? tallyRanked(poll) : tallyApproval(poll);
}

/** Per-option counts for the live card (approval counts, or IRV first-preferences). */
export function liveCounts(poll: Poll): number[] {
  if (poll.method === "approval") return tallyApproval(poll).counts;
  const r = tallyRanked(poll);
  return r.rounds[0]?.counts.map((c) => (c < 0 ? 0 : c)) ?? new Array<number>(poll.options.length).fill(0);
}

/** Human-readable winner summary for chat / closed-card text. */
export function summarizeWinners(poll: Poll, result: PollResult): string {
  const names = (idxs: number[]) => idxs.map((i) => poll.options[i] ?? `#${i}`).join(", ");
  if (result.winners.length === 0) return "no winner (no votes)";
  if (result.winners.length === 1) return `winner: ${names(result.winners)}`;
  return `tie: ${names(result.winners)}`;
}
