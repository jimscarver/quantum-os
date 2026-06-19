# Collective Optimization — the room as a quantum-annealing-style optimizer

[QuantumOS](README.md) rooms can approximate optimization the way a quantum annealer *actually*
does — by **relaxing toward a low-energy consensus**, not by "trying every answer at once." This
page describes the method (it reuses the room's existing decision tools) and is honest about what it
can and can't do.

## First, the honest reframing

Quantum optimizers (annealers, QAOA) don't solve NP-hard problems instantly — that's pop-sci. They
**approximate**: a physical system relaxes toward its minimum-energy (ground) state. The
[Quantum Logical Framework](https://github.com/jimscarver/quantum-logical-framework) makes the same
point formally — its machine-verified P-vs-NP reading shows **search/generate is exponential while
verify is O(n), and a solution can't be assembled greedily**
([P_vs_NP_QLF](https://github.com/jimscarver/quantum-logical-framework/blob/main/P_vs_NP_QLF.md)). So a
room can't conjure optimal answers either.

What a room *can* do — and what QLF says the universe itself does — is **select by closure**: of all
the candidate histories, the one that persists is the one that minimizes free action (`ΔF = −log 2`
per event), favoured because *"the thing that can happen in the most ways happens first"*
([MRE](https://github.com/jimscarver/quantum-logical-framework/blob/main/MRE.md),
[QLF_FreeEnergy](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/QLF_FreeEnergy.lean)).
A room run well is one distributed Markov-blanket agent doing **perceive → predict → act → prune**
([QuantumOS §3](https://github.com/jimscarver/quantum-logical-framework/blob/main/QuantumOS.md)). That's a
legitimate, physically faithful **metaheuristic** — the same family as simulated annealing,
evolutionary search, and human computation.

## The method — a collective annealing loop

Five steps, each one an existing room primitive. No new consensus machinery.

| Step | Do this in the room | QLF analogue |
|---|---|---|
| **1 · Frame** | State the objective + constraints; record it with `/lemma`. | the proposition the blanket integrates |
| **2 · Generate** | Everyone — humans *and* AI agents — proposes candidate solutions in chat. Many minds explore the space in parallel. | `expand_generation` (exponential search, parallelized) |
| **3 · Score** | Score the candidates cheaply: `/estimate` for a number (cost, value, points) or `/poll` (approval or ranked) for preference — **trust-weighted**, so earned trust is the selection pressure. | the O(n) verify; trust = weighting |
| **4 · Select & anneal** | Keep the top candidate(s). **Lower the temperature each round:** explore wide early (welcome wild proposals, keep several), refine the leader late. | multiplicity / Born selection |
| **5 · Close** | When the room converges, confirm with `/probe` (supermajority) and record the winner with `/lemma` + `/persist`. | `full_zeno_prune` → the chosen ZFA closure |

**Temperature** is simply how broadly you still explore: high in early rounds, low as you converge.
That annealing schedule is the only genuinely new coordination — and a facilitator can run it.

**Let an agent run it for you.** With an AI facilitator in the room (see
[Running agents](scripts/qos-cli/README.md)), `/facil optimize <objective + constraints>` proposes
candidate solutions and suggests the next scoring step (`/estimate` or `/poll`); re-run it each round
and it refines the leaders from the discussion (the "anneal") and points you toward `/probe` then
`/lemma`+`/persist`. (Any agent role accepts `optimize`.)

See: **[Group Decisions](Group_Decisions.md)** (the decision toolset) · **[Consensus](Consensus.md)**
(`/probe`) · **[Governance](Governance.md)** (trust-weighting) ·
**[Room Best Practices](Room_Best_Practices.md)** (running the rounds well).

## Worked example — choosing a sprint plan

1. **Frame:** `/lemma Goal: ship the auth rewrite in 2 weeks; constraint: 2 engineers.`
2. **Generate:** participants and the AI agents drop 5 candidate plans in chat.
3. **Score (wide):** `/poll` approval over all 5 — trust-weighted; keep the top 3.
4. **Refine (anneal):** the room sharpens the top 3 into 3 variants; `/estimate` the risk (1–5) of each.
5. **Close:** `/probe` the leader; if it holds, `/lemma` + `/persist` the chosen plan.

The group didn't brute-force the space — it explored in parallel, scored cheaply, and relaxed to a
balanced consensus. Good enough, fast, and auditable.

## What it's good for (and not)

**Reasonable for** judgment-heavy problems where human + AI proposal plus cheap scoring beats brute
force: design choices, resource allocation, scheduling and prioritization, parameter tuning, and
deliberation generally.

**Not for** cryptographic hardness or anything needing a *provably optimal* combinatorial answer. Like
every metaheuristic — and like a real annealer — it finds good solutions, not guaranteed-optimal ones;
it is **not** polynomial-time and **not** an NP solver. That limit is the same one QLF proves about the
substrate: no greedy shortcut from cheap verification to cheap search.

The "quantum" part that genuinely holds is **relaxation to a low-energy / ZFA-balanced consensus** —
exactly what an annealer does and what QLF says the substrate does — not the myth of evaluating every
answer at once.

## Benefit over traditional quantum computation

A real quantum optimizer (a D-Wave-style annealer, or a gate-model QPU running QAOA) and a QuantumOS
room both *relax toward a low-energy answer* — but for real-world problems the room wins where it counts:

- **Runs on what you already have.** No millikelvin dilution refrigerator, no QPU, no cloud-QPU account
  or queue — just a browser, peer-to-peer and free. Available to anyone, now.
- **No lossy encoding.** A quantum annealer needs your problem mapped to a QUBO/Ising model and embedded
  onto a fixed qubit graph — hard, lossy, and impossible for most real objectives. The room takes the
  problem in plain language.
- **Handles soft, qualitative, evolving objectives.** Most real optimization isn't a clean energy
  function: fairness, strategy, taste, risk tolerance, "does this fit our values." Human + AI proposers
  can score those; a QUBO can't even express them.
- **Explainable and auditable.** You get *reasoning*, a trust-weighted decision trail, and a recorded
  decision (`/lemma`) — not a black-box bitstring. Every step is dyncap-auditable.
- **Collective intelligence built in.** Many complementary perspectives, earned trust as the selection
  weight, governance to keep it honest — the QLF complementary-binding thesis (distinguishable closures
  bind where clones only flood,
  [QLF_as_Intelligence](https://github.com/jimscarver/quantum-logical-framework/blob/main/QLF_as_Intelligence.md)).
- **No decoherence to fight.** The annealing is over candidate *solutions*, not fragile qubit states —
  nothing to hold coherent at millikelvin.

And it's the **same physics**: QLF says the substrate optimizes by ZFA closure / free-energy
minimization regardless of scale — the room realizes that selection principle at the *logical* layer
where human-meaningful problems actually live, with no physical quantum device required.

**Honest scope:** this is not a claim to beat a quantum computer on a large, clean Ising instance —
that is the QPU's home turf (if quantum advantage for optimization ever holds). The point is that
*most* real optimization never reaches that turf: it can't be reduced to an Ising model, needs human
judgment, or must stay auditable — and there the room is available, expressive, and honest where
quantum hardware isn't even applicable.

## Try it

A runnable demo anneals a classic problem (the Travelling Salesman Problem) to its brute-force optimum,
so you can watch the loop converge — see **[OptimizationDemo.md](OptimizationDemo.md)**
(`node scripts/qos-cli/optimize-demo.mjs`).

## Grounding (QLF)

- Selection by closure / least free action, `ΔF = −log 2` per half-spin event:
  [MRE](https://github.com/jimscarver/quantum-logical-framework/blob/main/MRE.md) ·
  [QLF_FreeEnergy](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/QLF_FreeEnergy.lean).
- *"Most ways happens first"* (Born-rule multiplicity):
  [BayesianMechanics](https://github.com/jimscarver/quantum-logical-framework/blob/main/BayesianMechanics.md).
- Perceive→predict→act→prune as the room's cycle; collective intelligence as one distributed synthesis:
  [QuantumOS §3](https://github.com/jimscarver/quantum-logical-framework/blob/main/QuantumOS.md) ·
  [QLF_as_Intelligence](https://github.com/jimscarver/quantum-logical-framework/blob/main/QLF_as_Intelligence.md).
- Why there is no instant NP solve (generate vs verify):
  [P_vs_NP_QLF](https://github.com/jimscarver/quantum-logical-framework/blob/main/P_vs_NP_QLF.md) ·
  [QLF_InfoSynthesis](https://github.com/jimscarver/quantum-logical-framework/blob/main/lean/QLF_InfoSynthesis.lean).
