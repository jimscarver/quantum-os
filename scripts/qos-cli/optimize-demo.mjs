#!/usr/bin/env node
// Collective-annealing optimization DEMO on a classic problem: the Travelling
// Salesman Problem (TSP). It runs the loop from Collective_Optimization.md —
//   generate a candidate (a 2-opt neighbour) → score it (exact tour length) →
//   select & anneal (Metropolis accept, temperature cooling) → converge
// — and checks the result against the brute-force optimum on a small instance.
//
// This is the SAME loop a room runs COLLECTIVELY: in a room, humans + AI agents
// are the proposers, `/estimate` or `/poll` is the (trust-weighted) scorer, and
// `/probe` confirms convergence. Here one process plays every role so you can
// watch it anneal. Honest scope: a metaheuristic — excellent solutions, not a
// guaranteed-optimal NP solver (see Collective_Optimization.md).
//
//   node optimize-demo.mjs [--cities N] [--seed S] [--rounds R]
//
// No dependencies, no network, no AI key.

function parseArgs(argv) {
  const a = { cities: 9, seed: 42, rounds: 60 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cities") a.cities = Number(argv[++i]);
    else if (argv[i] === "--seed") a.seed = Number(argv[++i]);
    else if (argv[i] === "--rounds") a.rounds = Number(argv[++i]);
    else if (argv[i] === "--help" || argv[i] === "-h") a.help = true;
  }
  return a;
}

// mulberry32 — a tiny seeded PRNG so runs are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
function tourLength(order, cities) {
  let d = 0;
  for (let i = 0; i < order.length; i++) d += dist(cities[order[i]], cities[order[(i + 1) % order.length]]);
  return d;
}
// 2-opt move: reverse the segment between two positions — the classic TSP neighbour.
function twoOpt(order, rng) {
  const n = order.length;
  let i = 1 + Math.floor(rng() * (n - 1));
  let j = 1 + Math.floor(rng() * (n - 1));
  if (i > j) [i, j] = [j, i];
  if (i === j) return order;
  const next = order.slice();
  while (i < j) { [next[i], next[j]] = [next[j], next[i]]; i++; j--; }
  return next;
}

// Brute-force optimum (only for small N): fix city 0, permute the rest.
function bruteForce(cities) {
  const rest = cities.map((_, i) => i).slice(1);
  let best = Infinity;
  const perm = [];
  const used = new Array(rest.length).fill(false);
  (function rec() {
    if (perm.length === rest.length) {
      best = Math.min(best, tourLength([0, ...perm], cities));
      return;
    }
    for (let k = 0; k < rest.length; k++) {
      if (used[k]) continue;
      used[k] = true; perm.push(rest[k]);
      rec();
      perm.pop(); used[k] = false;
    }
  })();
  return best;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log("node optimize-demo.mjs [--cities N] [--seed S] [--rounds R]"); return; }
  const N = Math.max(4, Math.min(args.cities, 200));
  const rng = mulberry32(args.seed);
  const cities = Array.from({ length: N }, () => [Math.round(rng() * 100), Math.round(rng() * 100)]);

  console.log(`Collective-annealing demo — Travelling Salesman (${N} cities, seed ${args.seed})`);
  console.log("The loop: generate (2-opt) → score (tour length) → select & anneal (Metropolis) → converge.\n");

  // ---- the annealing loop ----
  let order = cities.map((_, i) => i);          // start: 0,1,2,…
  let cur = tourLength(order, cities);
  let best = order.slice(), bestLen = cur;
  console.log(`initial tour length: ${cur.toFixed(1)}`);

  let T = bestLen / 4;                           // initial "temperature" (problem-scaled)
  const cooling = Math.pow(0.02, 1 / args.rounds);   // cool to ~2% of T0 over the run
  const sweeps = 30 * N;                          // proposals per round
  for (let r = 1; r <= args.rounds; r++) {
    for (let s = 0; s < sweeps; s++) {
      const cand = twoOpt(order, rng);
      const cl = tourLength(cand, cities);
      const dE = cl - cur;
      if (dE < 0 || rng() < Math.exp(-dE / Math.max(T, 1e-9))) { order = cand; cur = cl; }
      if (cur < bestLen) { best = order.slice(); bestLen = cur; }
    }
    if (r % Math.ceil(args.rounds / 12) === 0 || r === args.rounds) {
      console.log(`  round ${String(r).padStart(2)}  T=${T.toFixed(1).padStart(6)}  best=${bestLen.toFixed(1)}`);
    }
    T *= cooling;                                // anneal: lower the temperature
  }

  console.log(`\nconverged: best tour length = ${bestLen.toFixed(1)}`);
  console.log(`  tour: ${best.join("→")}→${best[0]}`);
  if (N <= 10) {
    const opt = bruteForce(cities);
    const gap = ((bestLen - opt) / opt) * 100;
    console.log(`  brute-force optimum = ${opt.toFixed(1)}   gap ${gap.toFixed(2)}%  ${gap < 1e-6 ? "✓ reached the optimum" : ""}`);
  } else {
    console.log(`  (N>10 — brute force skipped; this is the best the metaheuristic found)`);
  }
  console.log(`\nA room runs this SAME loop collectively: humans + AI agents propose, /estimate or /poll`);
  console.log(`(trust-weighted) scores, /probe converges. See Collective_Optimization.md.`);
}

main();
