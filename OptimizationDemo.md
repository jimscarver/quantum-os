# Optimization Demo — a room solving a classic problem together

A runnable demonstration of [collective optimization](Collective_Optimization.md) on a **classic
optimization problem** — the Travelling Salesman Problem (TSP). It prints a **simulated room session**:
named participants propose candidate routes each round, a **Facilitator** agent scores them
(trust-weighted) and cools the temperature, and the room converges — checked against the brute-force
optimum. It's the [collective-annealing loop](Collective_Optimization.md) shown as the *interaction*
it really is.

## Run it

```bash
cd scripts/qos-cli
node optimize-demo.mjs                  # 9 cities — the room converges to the optimum
node optimize-demo.mjs --cities 14      # bigger instance (brute force skipped)
node optimize-demo.mjs --seed 7
```

No dependencies, no network, no AI key.

## What you see

```
Collective-optimization demo — a room solving the Travelling Salesman Problem (9 cities)
Participants: Ana [trust 4], Ben [trust 3], Cara [trust 2], Dee [trust 1]  +  Facilitator (an AI agent)

── Round 1  (temperature HIGH — explore) ──
Facilitator: Propose any route you like — wild ideas welcome while it's hot.
  Ana:  0→6→4→1→8→7→2→3→5→0   (length 227.1)
  Ben:  0→6→4→1→8→3→7→5→2→0   (length 251.6)
  Cara: 0→2→7→3→5→8→1→4→6→0   (length 217.3)
  Dee:  0→2→7→3→5→8→1→4→6→0   (length 217.3)
Facilitator: Scored (trust-weighted). Leader: 217.3 — Cara.       ← trust breaks the Cara/Dee tie

── Round 2  (temperature HIGH — explore) ──
Facilitator: Current leader is 217.3 (Cara). Refine it.
  ...
Facilitator: Scored (trust-weighted). Leader: 213.4 — Ben.

── Round 3  (temperature cooling — refine) ──
  ... everyone converges on 213.4 ...
Facilitator: No one's improved on 213.4 for two rounds — looks converged.

Facilitator: Converged. `/probe` it… ✓  Recording: `/lemma best-tour = 0→7→2→3→5→8→1→4→6→0`  `/persist`
Facilitator: Length 213.4 — brute-force optimum is 213.4 (gap 0.00%)  ✓ the room found the optimal tour.
```

Early rounds are hot — people throw out wide, diverse routes. As the temperature cools they refine the
leader, the room settles, and it lands exactly on the optimum.

## The demo *is* the room's loop

The demo simulates the participants and the agent so it runs in one process; a real
[room](MyRoom.md) does the same with people + AI agents:

| In the demo | In a real room |
|---|---|
| Ana / Ben / Cara / Dee propose routes | humans + AI agents propose candidate solutions |
| Facilitator scores by length, trust breaks ties | `/estimate` or `/poll` — **trust-weighted** ([Governance](Governance.md)) |
| temperature cools each round | keep the top candidate(s); refine the leaders (the anneal) |
| "looks converged" → `/lemma` + `/persist` | `/probe` confirms; record the decision |

To run it live with a real AI facilitator, ask one in the room: **`/facil optimize <objective +
constraints>`** — it proposes candidates and the next scoring step, round by round (see
[Collective_Optimization.md](Collective_Optimization.md) and [Running agents](scripts/qos-cli/README.md)).

## Honest scope

This is a **metaheuristic**. It reached the optimum here because the instance is small; on large
NP-hard instances it finds excellent — not provably-optimal — solutions. Same scope as the room, and as
a real quantum annealer: relaxation toward a good low-energy answer, not a guaranteed optimum and not a
polynomial-time NP solver. See **[Collective_Optimization.md](Collective_Optimization.md)** (including
*Benefit over traditional quantum computation*).
