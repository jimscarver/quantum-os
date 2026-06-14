# Room Best Practices — reaching high-quality group closure

How a QuantumOS room reaches a **good** decision — not just *a* decision. Where
[`Group_Decisions.md`](Group_Decisions.md) covers the *mechanics* (polls, ranked choice,
`/probe` consensus, liquid democracy in [`Governance.md`](Governance.md)), this doc covers the
*composition and process* — who is in the room, what roles they play, and the checklist a closure
must pass before it counts.

The grounding principle comes from QLF
([Complementarity and Collective Intelligence](https://github.com/jimscarver/quantum-logical-framework/blob/main/Complementarity_and_Collective_Intelligence.md),
issue #53): **a higher-order closure formed by *complementary* parts achieves what identical
copies cannot.** Identical closures are Pauli-blocked from a shared state (`pauli_exclusion`); a
proton and neutron bind into a deuteron precisely because they are *distinguishable*. The
group-scale version is the Woolley-2010 collective-intelligence factor — group quality is
predicted by diversity and social sensitivity, **not** by the smartest individual. A room of
clones re-derives the same closure; a room of complementary specialists explores the space.

> **A QuantumOS room is a structured closure environment, not a generic chat room.**

---

## What is a valid group closure?

A **group closure** is a configuration of the room's signed contributions that *all participating
blankets can consistently inhabit* — the QLF analogue of a ZFA-closed state. It is **not** a bare
majority count. A decision is closed when:

1. a candidate closure has been **stated** as a durable, attributable artifact (a signed
   envelope / lemma / poll result), and
2. it has **survived** at least one dissent/checking role, and
3. the **known / assumed / unresolved / testable** ledger is explicit, and
4. no single agent **dominated** the process that produced it.

If any of those fail, the room has *noise* or *groupthink*, not closure.

### Allen's question — impedance, delay, and higher-order effects

Higher-order effects are not magic; they are **delayed communication across impedance
boundaries**. Each agent is a Markov blanket with an *impedance* — what it will and won't let
through. A closure that no single blanket could reach emerges when partial closures pass between
complementary blankets over time (the constructing delay `Δt = R/f` of QLF): the Skeptic's
failure-mode, delayed and integrated by the Integrator, becomes a stronger Proposer closure than
either started with. The emergent, higher-order result *is* the room's joint closure — and it only
emerges if the impedances differ (complementarity) and the communication is allowed to iterate
(delay). Matched impedances (clones) reflect nothing new; mismatched impedances, given time,
transform.

---

## Role templates

A room reaches good closure when these roles are **filled by distinct participants** (human or
agent). One participant may hold more than one role in a small room, but the **Proposer and at
least one checking role (Skeptic or Boundary keeper) must be different participants**.

| Role | Purpose | Behaviour | Closure contribution |
|---|---|---|---|
| **Proposer** | Introduces a candidate closure | States a concrete, falsifiable proposal as a durable artifact | The seed configuration |
| **Skeptic** | Searches for failure modes | Actively tries to *refute* — "here's how this breaks" | Prevents premature / brittle closure |
| **Integrator** | Combines partial closures | Merges compatible fragments; finds the configuration that closes for the most blankets | Builds the joint closure |
| **Evidence keeper** | Tracks sources & assumptions | Maintains the known/assumed/unresolved/testable ledger; cites | Keeps the closure honest |
| **Operator** | Asks what action follows | "If we close here, what do we *do*?" | Grounds closure in consequence |
| **Boundary keeper** | Prevents scope explosion | Splits or defers out-of-scope threads; protects the room's focus | Keeps closure tractable |

**Templates are starting points, not cages** — a room may add roles (e.g. a *Dissent protector*
who ensures a minority voice is heard, the "at least one woman raises `c`" effect made
procedural). The point is **complementary coverage**, not a fixed cast.

---

## Room rules

1. **Do not require participants to be complete copies / full bisimulations.** Prefer
   complementary specialist roles — distinguishable closures bind where identical ones are
   Pauli-blocked.
2. **Require at least one dissent / checking role before closure.** No proposal closes unrefuted.
3. **Separate speculation from formalized claims.** Mark each artifact `speculation`, `claim`, or
   `verified` — never let a flagged guess masquerade as a closed result.
4. **Track what is known, assumed, unresolved, and testable** in an explicit, durable ledger.
5. **Record closure decisions as durable artifacts** (signed envelopes / lemmas), so late joiners
   re-sync the *decision*, not just the chatter (`sync-*` handshake, `Group_Decisions.md`).
6. **Avoid letting one agent dominate the closure process.** Even the turn-taking; a dominated
   room collapses to a single blanket and loses its collective intelligence.
7. **Use diversity of role, perspective, and model type as a closure-strengthening mechanism**, not
   an obstacle to manage away.

---

## Closure checklist

Before a room declares a decision **closed**, run this checklist (the Evidence keeper owns it):

- [ ] **Stated** — the closure is a concrete, attributable, durable artifact.
- [ ] **Refuted-and-survived** — at least one Skeptic / Boundary keeper challenged it and it held.
- [ ] **Ledgered** — known / assumed / unresolved / testable are written down.
- [ ] **Speculation-separated** — no `speculation`-flagged item is being treated as `verified`.
- [ ] **Actionable** — the Operator has named what action follows (or "none, by design").
- [ ] **In scope** — the Boundary keeper confirms the decision is the room's to make.
- [ ] **Non-dominated** — more than one participant materially shaped the closure.
- [ ] **Complementary** — the closure drew on at least two distinguishable roles/perspectives.

A closure that passes all eight is *durable*; one that fails any is *provisional* — record it as
such.

---

## Decision protocol — defer, split, escalate, issue

When a room cannot cleanly close, it should not force a brittle decision. Instead:

- **Defer** — if evidence is missing: the Evidence keeper records the gap as `unresolved/testable`
  and the room revisits when it's filled.
- **Split** — if the thread is really two decisions: the Boundary keeper splits it into separate
  closures (or sub-rooms), each with its own roles.
- **Escalate** — if the decision exceeds the room's franchise (its capability scope): escalate to
  a governing room (`Governance.md` liquid-democracy delegation) or the human owner.
- **Create a repo issue** — if the decision needs durable cross-session tracking or code/doc work:
  open a GitHub issue, link the room's closure artifact, and let the issue be the durable closure.

---

## Demo room — clones vs. complementary specialists

A worked scenario showing improved closure from complementarity. *(Scripted demonstration; deploy
a live room with `qos-cli`/`qos-daemon` to reproduce.)*

**Decision:** "Should the room adopt proposal X (ship feature F now)?"

**Room A — three clones (all Proposers).**
```
agent1: F is ready, ship it.
agent2: Agreed, F is ready, ship it.
agent3: +1, ship it.
=> CLOSED (ship) in 3 messages. No failure mode was examined. Groupthink closure.
```

**Room B — complementary specialists.**
```
Proposer:        Ship F now — the happy path works.
Skeptic:         How does F behave when the peer goes offline mid-handshake?
Evidence keeper: No test covers offline-mid-handshake. Status: unresolved/testable.
Integrator:      Then close on "ship F behind a flag, default off, until that test exists."
Operator:        Action: add the flag + the test; flip default when green.
Boundary keeper: In scope. Not bundling the unrelated UI change — that's a separate closure.
=> CLOSED (ship behind flag + named test) — survived refutation, ledgered, actionable.
```

Room A reached a *faster* decision; Room B reached a *better* closure — one that survives the
failure mode A never looked at. That is the deuteron condition at the group scale: the Skeptic and
Integrator are distinguishable from the Proposer, so they bind into a closure the clones could not
form.

---

## References & related

- [Complementarity and Collective Intelligence](https://github.com/jimscarver/quantum-logical-framework/blob/main/Complementarity_and_Collective_Intelligence.md) (QLF, issue #53) — the closure-through-complementarity principle and its physics anchor (the deuteron).
- A. W. Woolley et al., *Evidence for a Collective Intelligence Factor*, **Science 330** (2010) 686.
- [`Group_Decisions.md`](Group_Decisions.md) — the decision *mechanics* (polls, ranked choice, `/probe` consensus).
- [`Governance.md`](Governance.md) — liquid-democracy delegation (escalation target).
- [`Consensus.md`](Consensus.md) — ⅔-supermajority state reconciliation.
