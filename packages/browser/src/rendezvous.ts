/// Rendezvous — n-party atomic synchronization with ZFA conservation over
/// the joint composition.
///
/// A rendezvous is a single composite move across N participants. Each
/// participant contributes a token (`gives`) and receives a token (`gets`).
/// The conservation invariant is that the multiset of `gives` equals the
/// multiset of `gets` — value flows in a closed cycle. ZFA balance is
/// automatic since every individual token is already balanced.
///
/// Protocol (5 wire kinds, all direct sends — never broadcast):
///   rdv-propose — proposer  → each participant (carries the proposal)
///   rdv-accept  — participant → proposer (carries the specific committed token)
///   rdv-reject  — participant → proposer (declines)
///   rdv-commit  — proposer  → each participant (carries final token assignments)
///   rdv-abort   — proposer  → each participant (clean up locks)
///
/// Atomicity is best-effort: the protocol matches `/note pass`'s trust model.
/// True multi-party atomicity needs consensus, which is out of scope.

export interface TokenSpec { currency: string; denomination: number }

export interface Row {
  participant: string;   // peer ID
  gives: TokenSpec;
  gets:  TokenSpec;
}

export interface Proposal {
  id: string;
  proposer: string;      // peer ID
  proposerName: string;  // display name at propose time (informational)
  rows: Row[];
  expiresAt: number;     // epoch ms
}

export interface CommitRow {
  participant: string;
  givesToken: string;
  getsToken:  string;
}

export function newProposalId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/// Multiset equality on (currency, denomination) — conservation across the
/// rendezvous. Every spec in `gives` must be matched by an equal spec in
/// `gets`, with the same counts.
export function conservationCheck(rows: Row[]): boolean {
  const key = (t: TokenSpec) => `${t.currency}:${t.denomination}`;
  const gives = new Map<string, number>();
  const gets  = new Map<string, number>();
  for (const r of rows) {
    gives.set(key(r.gives), (gives.get(key(r.gives)) ?? 0) + 1);
    gets.set(key(r.gets),   (gets.get(key(r.gets))   ?? 0) + 1);
  }
  if (gives.size !== gets.size) return false;
  for (const [k, v] of gives) if (gets.get(k) !== v) return false;
  return true;
}

export function findRowsFor(p: Proposal, peerId: string): Row[] {
  return p.rows.filter(r => r.participant === peerId);
}

export function uniqueParticipants(p: Proposal): string[] {
  return Array.from(new Set(p.rows.map(r => r.participant)));
}

export function shortRdvId(id: string): string {
  return id.slice(0, 8);
}

/// Cyclic 2-party swap: Alice gives X gets Y, Bob gives Y gets X.
/// Returns the two rows; caller is responsible for participant peer IDs.
export function cyclicSwap(
  aliceId: string, alice: TokenSpec,
  bobId:   string, bob:   TokenSpec,
): Row[] {
  return [
    { participant: aliceId, gives: alice, gets: bob   },
    { participant: bobId,   gives: bob,   gets: alice },
  ];
}
