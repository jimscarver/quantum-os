# Optimization Demo — watching the annealing loop converge

A runnable demonstration of [collective optimization](Collective_Optimization.md) on a **classic
optimization problem** — the Travelling Salesman Problem (TSP) — so you can watch the loop relax to the
answer and check it against the brute-force optimum. It's the same loop a [room](MyRoom.md) runs
collectively, played by one process so you can see it.

## Run it

```bash
cd scripts/qos-cli
node optimize-demo.mjs                  # 9 cities — converges to the brute-force optimum
node optimize-demo.mjs --cities 14      # bigger instance (brute force skipped)
node optimize-demo.mjs --seed 7 --rounds 80
```

No dependencies, no network, no AI key.

## What you see

```
Collective-annealing demo — Travelling Salesman (9 cities, seed 42)
The loop: generate (2-opt) → score (tour length) → select & anneal (Metropolis) → converge.

initial tour length: 454.9
  round  5  T=  87.6  best=222.5
  round 10  T=  63.2  best=217.3
  round 15  T=  45.7  best=213.4
  ...
  round 60  T=   2.4  best=213.4

converged: best tour length = 213.4
  tour: 0→7→2→3→5→8→1→4→6→0
  brute-force optimum = 213.4   gap 0.00%  ✓ reached the optimum
```

The temperature cools each round; early on the room accepts worse tours to explore, then settles onto
the best — and lands exactly on the optimum.

## The demo loop *is* the room's loop

The demo plays every role in one process. A room runs the same loop **collectively**:

| Demo (one process) | Room (collective) |
|---|---|
| propose a 2-opt neighbour | humans + AI agents propose candidate solutions |
| score = exact tour length | `/estimate` or `/poll` — **trust-weighted** |
| Metropolis accept + cooling | keep the top candidates; lower the temperature each round |
| converged best tour | `/probe` confirms; `/lemma` + `/persist` records it |

## Honest scope

Simulated annealing is a **metaheuristic**. It reached the optimum here because the instance is small;
on large NP-hard instances it finds excellent — not provably-optimal — solutions. That is the same
scope as the room, and as a real quantum annealer: relaxation toward a good low-energy answer, not a
guaranteed optimum and not a polynomial-time NP solver. See **[Collective_Optimization.md](Collective_Optimization.md)**
(including *Benefit over traditional quantum computation*).
