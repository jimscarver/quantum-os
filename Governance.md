# Governance — liquid democracy on quantum-os

A governance layer that exposes the functionality of RChain's
[rgov](https://github.com/rchain-community/rgov) — groups, members, issues,
delegated voting — using quantum-os's own primitives, rather than running rgov's
`.rho` contracts. The centerpiece is **delegated (liquid) democracy**: members
delegate their vote, delegation flows transitively, and a non-voter's weight is
cast by their delegate.

This is the same ZFA substrate as everything else: dyncap-signed envelopes plus a
**deterministic, joiner-local tally** (every peer resolves the same delegation
graph from the signed delegations + ballots it holds — no central counter). See
[`Group_Decisions.md`](Group_Decisions.md) for the broader family of decision
processes and [`Group_Decisions_Demo.md`](https://github.com/jimscarver/quantum-logical-framework/blob/main/Group_Decisions_Demo.md)
for a worked multi-peer walkthrough.

---

## Design philosophy — RGOV as a liquid-trust network

The intent ported here predates rgov: it is the **RGOV liquid-trust network
governance** model from [Whitescarver, *Collective Intelligence Best
Practices*](https://docs.google.com/presentation/d/1qFK10rFcCiBO72aeSFIfII0e1TeIXDKgZqwVlP-wREk/edit)
(orig. RChain Governance Forum, 2018). Its principles are what `/gov` is *for*,
not just what it does — an **anti-fragile sociocratic polyarchy**: maximal
distribution of power with effective global coordination, representing **all**
stakeholders through interlinked autonomous teams.

| RGOV principle | How quantum-os realizes it |
|---|---|
| **Liquid democracy** (affirmative trust delegation) | `/gov delegate` — standing, transitive, revocable; direct vote overrides |
| **Self-governance by peer-to-peer agreements** | dyncap-signed envelopes; each group sets its own roster, delegates, currencies — no central authority |
| **Exchange of capabilities (property)** | unforgeable capability tokens (`/cap`/`/grant`), `/note` currencies (treasury, kudos) |
| **Asset pools** — budgets, crowdfunds, staking | `/gov treasury`; *"budgets awarded to teams divided how they decide"* = sub-group autonomy |
| **Chat channels distributing communications & capabilities** | `/channel`, `/gov say` (membership-scoped) |
| **User-programmed — save and share actions** | the [RhoQuCalc macros](RhoQuCalc_Macros.md): name = quoted process = shareable capability |
| **Purposeful transparency + privacy** | public signed decisions of record; bearer-private balances; pseudonymous peers |

**Liquid *trust*, not only liquid democracy (a principled extension).** The RGOV
vision weights alternatives by **voter trust ratings** alongside delegation —
affirmative trust, not just vote-flow. Today's `resolveWeights` is the equal-weight
(`weight = 1 + delegators`) liquid-democracy case; trust-rating weights are the
named next step (Phase 2d), slotting into the same deterministic tally. The
room-side complement — *who* should be in the room and how it closes well — is
[`Room_Best_Practices.md`](Room_Best_Practices.md), grounded in the same talk's
collective-intelligence findings.

---

## Why not run the `.rho` directly?

rgov uses full RChain Rholang — persistent `contract`s, the RSpace tuplespace with
`for`/COMM matching, pattern destructuring, the registry, `rho:` system processes
(`registry`, `deployId`, `deployerId`, RevVault), and signed, phlogiston-metered
deploys ordered by Casper consensus. quantum-os has none of that machinery (its
"RhoQu" is a macro transpiler, `/channel` is fire-and-forget, there's no
tuplespace or global consensus). Literally executing the contracts would mean
embedding a Rholang interpreter or deploying to a real RNode.

Instead we port the **intent**. rgov's governance behavior maps cleanly onto
primitives quantum-os already has:

| rgov | quantum-os |
|---|---|
| `Group` / `WorkingGroup` / `addMember` / `MemberDirectory` | a group record + membership capabilities; `/gov member` |
| `Issue` / `newIssue` | an issue record per group (`/gov issue`) |
| `Ballot` / `castBallot` / `castVote` / `tallyVotes` | `/poll` (approval + ranked-choice IRV), opened via `/gov vote` |
| **`delegateVote`** | **`/gov delegate`** — standing, revocable, transitive delegation (global or per-issue) |
| `RevIssuer` / `makeMint` / `transfer` / `checkBalance` | **`/gov treasury`** — a per-group `/note` currency (declare/grant/balance) |
| `Kudos` / `awardKudos` | **`/gov kudos`** — a per-group `/note` reputation currency |
| `Inbox` / `Chat` / `sendMail` | **`/gov say`** — a membership-scoped `group-msg` (only fellow members see it) |
| `deployerId` identity | `/dyncap` anchor |
| registry lookup / durable link | `/lemma` + the memory-peer daemon |

---

## Liquid democracy — the governing rule

**Per issue:** if a member casts a ballot, their own vote counts (it **overrides**
delegation). If they do **not** vote, their vote is cast by their **delegate** —
transitively: it flows to whoever their delegate's delegate … ultimately voted.
Each member has one standing delegate; direct voting always overrides for that
issue. A chain that reaches no direct voter, or loops, **abstains**.

**Resolution** (pure, in `gov.ts` `resolveWeights`, recomputed by every peer):
- `directVoters` = members who cast a ballot on the issue's poll.
- Each member's vote walks the delegation chain to the first direct voter reached
  (its weight flows there); cycles / dead-ends with no direct voter abstain.
- `weight(d) = 1 + #(members whose chain terminates at d)`.
- The weighted counts feed the existing approval / IRV poll engine (`tally(poll,
  weights)`), so votes are *both* ranked-choice *and* delegation-weighted, with
  the same deterministic tie-breaks.

Example: members A, B, C; B delegates A; C delegates B. If only **A** votes, A
carries weight **3** (self + B + C transitively). If **C** then votes directly, C
reclaims weight 1 and A drops to 2 (self + B). A delegation cycle with no direct
voter abstains.

---

## `/gov` command reference

`/gov` subcommands act on the **focused group** (set by `/gov new`/`show`, by
clicking it in the Governance sidebar, or implicitly when there's only one group).

| Command | Effect |
|---|---|
| `/gov new <name>` | Create a group (you become admin); focus + show its card |
| `/gov show <name>` · `/gov list` | Focus + render a group / list all groups |
| `/gov member add <peer> [admin]` · `member remove <peer>` | Manage roster (admin only); membership is capability-backed |
| `/gov issue <title>` · `/gov issue list` | Record / list issues to decide. Each issue gets its own **issue card** (title, group, weighted result, open-vote/vote) that persists in the transcript and replays on reload, like a poll card |
| `/gov delegate <member> [on <issue>]` · `/gov undelegate [on <issue>]` | Set / clear your **standing delegate**, or a **per-issue** delegate that overrides it for one issue |
| `/gov vote <issue> \| opt1, opt2 [ranked]` | Open a poll bound to the issue (find-or-create the issue) |
| `/gov treasury declare \| grant <member> <n> \| balance` | Group funds — a per-group `/note` currency (admin declares + funds; balances are bearer-private) |
| `/gov kudos <member> <n> \| balance` | Award reputation — a per-group kudos `/note` currency (admin issues; members re-gift what they hold) |
| `/gov say <message>` | Post to the group's inbox — a `group-msg` only fellow members see |
| `/gov status` | Group overview: members, delegations, issue results |
| `/forget group <name>` | Disband (creator) / hide (others) — tombstoned, dyncap-signed |

The **group card** (sidebar → click) shows members with roles and their delegate,
a "your vote flows to … unless you vote" note, each issue's **weighted** leader/
winner, and buttons to delegate, open a vote, vote, add a member / issue, or
disband.

Wire envelopes (all dyncap-signed, synced on join via `sync-gov`, tombstone-aware):
`group-open`, `group-member` (admin-gated), `group-issue`, `group-vote`,
`gov-delegate` (self-signed — only you set your own delegate). Votes themselves are
plain `/poll` envelopes. The headless memory daemon can persist `group-*` later
(Phase 2).

---

## Worked exemplar — rgov `delegateVote.rho` + `castVote.rho` + `tallyVotes.rho`

rgov: a member sends `delegateVote` to point their vote at another member; voting
on an issue casts directly; `tallyVotes` walks delegations to total the result.
The quantum-os equivalent over a P2P room (cast: A admin, B, C, D):

```
A> /gov new Stewards
·  🏛 created group "Stewards" — you are admin.
A> /gov member add Bob          ·  /gov member add Carol     ·  /gov member add Dave
A> /gov issue Adopt the new logo
B> /gov delegate Alice          ·  (B's vote will flow to Alice unless B votes)
C> /gov delegate Bob            ·  (C → Bob → Alice, transitively)
A> /gov vote Adopt the new logo | keep, replace ranked
·  🗳 vote opened on "Adopt the new logo" (ranked)
A> /poll vote keep              ·  Alice votes directly
D> /poll vote replace           ·  Dave votes directly; B and C have not voted
A> /gov status
·  ▸ Adopt the new logo — leading: keep · 4 weight
·    (Alice carries 3 = self + Bob + Carol delegated; Dave carries 1)
C> /poll vote replace            ·  Carol overrides her delegation for this issue
A> /gov status
·  ▸ Adopt the new logo — tie/▸ leading reflects Alice 2 (self + Bob), Dave+Carol 2
```

`tallyVotes` is the deterministic `resolveWeights` + weighted IRV: no contract
deploy, no consensus round — every peer computes the same result from the signed
delegations and ballots. Overriding is just voting; delegation is revocable with
`/gov undelegate`.

---

## Scope

**Phase 1 (shipped):** groups, members, issues, **standing delegation + per-issue
override + weighted liquid-democracy tally**, the Governance UI, and this doc.

**Phase 2a (shipped):** **per-topic (issue-scoped) delegation** — `/gov delegate
<member> on <issue>` sets a delegate that overrides your global one for that issue
only (revoke with `/gov undelegate on <issue>`). The per-issue map overrides the
global map (`gov.ts` `delegationMapFor`); the resolver and weighted tally are
unchanged. So you can delegate finance decisions to one steward and design
decisions to another, while still voting directly to override either.

**Phase 2b (shipped):** **treasury + kudos** — each group can declare a `/note`
treasury currency (`/gov treasury`) and a kudos reputation currency
(`/gov kudos`); both are thin orchestration over `/note` (declare/grant/pass/
balance), with the currency names recorded on the group (`group-meta`, synced).
Because notes are bearer instruments, a balance readout shows *your own* holdings,
not a global ledger.

**Phase 2c (shipped):** a **per-group inbox** (`/gov say` → a membership-scoped
`group-msg`; only fellow members render it) and **daemon persistence of groups** —
the headless memory peer now stores `groups.json` and re-serves `sync-gov`, so a
group's members, delegations, issues, and treasury/kudos currencies survive when
every browser leaves; it also honors a creator's group disband (`retract` /
tombstone) and won't resurrect it.

**Phase 2d (planned):** hard role/permission enforcement; more rgov exemplars; and
**trust-rating weights** — the RGOV liquid-*trust* extension (affirmative voter trust
ratings weighting alternatives alongside delegation), slotting into the same
deterministic `resolveWeights` tally.
