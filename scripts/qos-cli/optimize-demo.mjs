#!/usr/bin/env node
// Collective-optimization DEMO — a ROOM solving a classic problem together.
//
// It prints a simulated room session on the Travelling Salesman Problem: named
// participants propose candidate tours each round, a Facilitator agent scores them
// (trust-weighted) and narrows the "temperature" (explore wide early, refine the
// leader late), and the room converges — checked against the brute-force optimum.
// This is the loop from Collective_Optimization.md, shown as the interaction it
// really is. Self-contained: no deps, no network, no AI key.
//
//   node optimize-demo.mjs [--cities N] [--seed S] [--rounds R]
//
// Honest scope: a metaheuristic — excellent solutions, not a guaranteed-optimal NP
// solver. The "quantum" part is the relaxation to a low-energy consensus, not
// evaluating every answer at once.

function parseArgs(argv) {
  const a = { cities: 9, seed: 42, rounds: 8 };
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
const route = (order) => order.join("→") + "→" + order[0];

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

// One participant's contribution this round: a short local search (Metropolis at the
// round's temperature) starting from the current leader — their own annealing run.
function propose(leader, cities, T, steps, rng) {
  let cur = leader.slice(), curLen = tourLength(cur, cities);
  let best = cur.slice(), bestLen = curLen;
  for (let s = 0; s < steps; s++) {
    const cand = twoOpt(cur, rng);
    const cl = tourLength(cand, cities);
    if (cl < curLen || rng() < Math.exp(-(cl - curLen) / Math.max(T, 1e-9))) { cur = cand; curLen = cl; }
    if (curLen < bestLen) { best = cur.slice(); bestLen = curLen; }
  }
  return { order: best, len: bestLen };
}

function bruteForce(cities) {
  const rest = cities.map((_, i) => i).slice(1);
  let best = Infinity;
  const perm = [], used = new Array(rest.length).fill(false);
  (function rec() {
    if (perm.length === rest.length) { best = Math.min(best, tourLength([0, ...perm], cities)); return; }
    for (let k = 0; k < rest.length; k++) {
      if (used[k]) continue;
      used[k] = true; perm.push(rest[k]); rec(); perm.pop(); used[k] = false;
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

  // The room: a few participants (with earned trust) + a Facilitator agent.
  const people = [
    { name: "Ana", trust: 4 }, { name: "Ben", trust: 3 },
    { name: "Cara", trust: 2 }, { name: "Dee", trust: 1 },
  ];
  const F = "Facilitator";

  console.log(`Collective-optimization demo — a room solving the Travelling Salesman Problem (${N} cities)`);
  console.log(`Participants: ${people.map((p) => `${p.name} [trust ${p.trust}]`).join(", ")}  +  ${F} (an AI agent)`);
  console.log(`Goal: the shortest closed tour. Each round, people propose a route; the Facilitator scores`);
  console.log(`it (trust breaks ties) and cools the temperature — explore wide early, refine the leader late.\n`);

  let leader = cities.map((_, i) => i);             // start: 0,1,2,…
  let leaderLen = tourLength(leader, cities);
  let leaderBy = "the starting order";
  console.log(`${F}: Optimizing the ${N}-city tour. Starting point is ${leaderLen.toFixed(1)} — propose better routes.\n`);

  const T0 = leaderLen / 4;
  const cooling = Math.pow(0.05, 1 / args.rounds);
  let T = T0, stale = 0;
  for (let r = 1; r <= args.rounds; r++) {
    const heat = T > T0 * 0.5 ? "HIGH — explore" : T > T0 * 0.12 ? "cooling — refine" : "LOW — converge";
    console.log(`── Round ${r}  (temperature ${heat}) ──`);
    if (r === 1) console.log(`${F}: Propose any route you like — wild ideas welcome while it's hot.`);
    else console.log(`${F}: Current leader is ${leaderLen.toFixed(1)} (${leaderBy}). Refine it.`);

    // each participant proposes (more internal search while hot)
    const steps = Math.round((10 + 60 * (T / T0)) * N);
    const proposals = people.map((p, i) => {
      const prng = mulberry32(args.seed * 131 + r * 17 + i * 1009);   // distinct, reproducible stream
      return { p, ...propose(leader, cities, T, steps, prng) };
    });
    for (const pr of proposals) console.log(`  ${pr.p.name}: ${route(pr.order)}   (length ${pr.len.toFixed(1)})`);

    // Facilitator scores: best length wins; trust breaks a tie.
    let win = { p: { name: leaderBy, trust: 0 }, order: leader, len: leaderLen };
    for (const pr of proposals) {
      if (pr.len < win.len - 1e-9 || (Math.abs(pr.len - win.len) < 1e-9 && pr.p.trust > win.p.trust)) win = pr;
    }
    if (win.len < leaderLen - 1e-9) { leader = win.order.slice(); leaderLen = win.len; leaderBy = win.p.name; stale = 0; }
    else stale++;
    console.log(`${F}: Scored (trust-weighted). Leader: ${leaderLen.toFixed(1)} — ${leaderBy}.\n`);

    T *= cooling;
    if (stale >= 2) { console.log(`${F}: No one's improved on ${leaderLen.toFixed(1)} for two rounds — looks converged.\n`); break; }
  }

  console.log(`${F}: Converged. \`/probe\` it… ✓  Recording the decision: \`/lemma best-tour = ${route(leader)}\`  \`/persist\``);
  if (N <= 10) {
    const opt = bruteForce(cities);
    const gap = ((leaderLen - opt) / opt) * 100;
    console.log(`${F}: Length ${leaderLen.toFixed(1)} — brute-force optimum is ${opt.toFixed(1)} (gap ${gap.toFixed(2)}%)${gap < 1e-6 ? "  ✓ the room found the optimal tour" : ""}.`);
  } else {
    console.log(`${F}: Length ${leaderLen.toFixed(1)} (N>10 — brute force skipped; best the room found).`);
  }
  console.log(`\nThat's Collective_Optimization.md run as a room: many proposers explore in parallel, a`);
  console.log(`trust-weighted score selects, the agent cools the temperature, /probe converges.`);
}

main();
