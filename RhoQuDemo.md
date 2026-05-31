# RhoQu: A Macro Layer Sketch

A forward-looking demo of **RhoQu** — the rho-calculus-flavored macro language that would compile to the quantum-os `/commands` shipped through v0.15.0. The parser isn't built yet. The *expansions* are real and run today: every RhoQu fragment below is followed by the working `/script`-and-friends version you can paste into the chat input and execute.

Read this as a contract between two layers:

- **Top layer (RhoQu, aspirational)**: a small concurrent-process syntax — `process`, `new`, `parallel`, `!`/`?`, `on`, `if`, `bridge` — that reads like rho calculus and stays one-line-per-intent.
- **Bottom layer (today's `/commands`, shipped)**: `/grant`, `/lemma`, `/note`, `/rdv`, `/share`, `/channel`, `/script`, `/persist`, `/dyncap`, `/probe`. Each RhoQu construct lowers to a small group of these. Every example below has its expansion verified against the actual dispatcher behaviour.

The demo's job is to show that the substrate is sufficient — that the RhoQu syntax is sugar, not new infrastructure. When the parser lands, it generates exactly what the right-hand columns below show.

---

## The mapping

| RhoQu | Expansion (today's `/commands`) | Notes |
|---|---|---|
| `new x y z in` | `/grant x; /grant y; /grant z` | One `/grant` per name; each mints a fresh ZFA-balanced cap and registers as `@x` |
| `process P(args) { … }` | (no expansion — definition only) | The parser inlines the body at each call site |
| `parallel { A; B; C }` | `/script A; B; C` | Single-peer "parallel" is sequential — true concurrent participants are separate peers in the room |
| `usd! 30 to bob` | `/note pass USD 30 bob` | Currency name from context; bob is a peer name in the active room |
| `attest! 1 to bob via rdv` | `/rdv swap attest-self 1 attest-bob 1 bob` | Wraps the swap shape from MultisigDemo |
| `on rdv(id) { commit }` | `/rdv accept <id>` | Pattern-matches the inbound proposal; `commit` is the accept verb |
| `counter rdv(id) <new>` | `/rdv counter <id> <giveCur> <giveN> <getCur> <getN>` | Round-trip negotiation |
| `bridge @lemma to room` | `/share @lemma to <room-prefix>` | Application-level bridge across tabs |
| `bridge msg "…" to room` | `/share msg "…" to <room-prefix>` | Chat bridge |
| `channel listen forks` | `/channel listen forks` | Per-room subscription |
| `channel forks ! "ate"` | `/channel send forks "ate"` | Tagged broadcast |
| `persist @lemma to bob` | `/persist @lemma to bob` | Receiver-opt-in cross-peer redundancy |
| `if @balance ≥ 30 { … }` | (no native; expand to `/qucalc @balance` + conditional dispatcher branch) | A future enhancement to `/script` is needed for true conditionals — today the user reads the qucalc output and chooses the branch |
| `timeout 60s { abort }` | (no native; `/rdv` has the 60s timeout built in) | Generic timeouts on arbitrary blocks need a new dispatcher feature |

---

## Demo 1 — Atomic swap with one counter round

### RhoQu

```
process bilateral_swap(other, give_cur, give_n, get_cur, get_n) {
  give_cur ! give_n  -> other.get_cur(get_n) via rdv;
  on rdv(id) {
    accept;                              -- → /rdv accept <id>
  }
  on rdv(id) {                          -- if a counter arrives instead
    if reasonable(counter.terms) { accept; }
    else { counter(rdv, original.terms); }
  }
  timeout 60s { abort; }
}

parallel {
  bilateral_swap(bob, USD, 30, EUR, 20);  -- Alice's perspective
}
```

### Expansion that runs today

A two-peer scenario (Alice + Bob in the same room, already connected, each with currency authority + held notes):

**Alice (proposes USD 30 ↔ EUR 20):**

```
/script /rdv swap USD 30 EUR 20 Bob
```

**Bob (sees the propose, decides to counter at USD 25):**

```
/script /rdv counter a3f1c2 USD 25 EUR 20
```

(Replace `a3f1c2` with the short id from his chat.)

**Alice (sees counter, decides USD 25 is acceptable since she'd settle for less):**

```
/script /rdv accept a3f1c2
```

Commit fires; both wallets atomically transition. The `bilateral_swap` process collapses to three discrete user actions today; the RhoQu parser would dispatch them automatically given the policy embedded in the `if reasonable(...)` clause.

What's missing from the expansion: the **policy logic** (`reasonable(counter.terms)`) — today the user evaluates terms manually and chooses accept/counter/reject. The dispatcher doesn't have conditional execution. A future `/script` enhancement (`if ... then ... else`) would close this gap without changing any shipped command.

---

## Demo 2 — Dining Philosophers with a bridge to a second table

### RhoQu

```
process philosopher(name, left, right) {
  new hungry in
  hungry ! self;                          -- /lemma name-hungry

  request(left);                          -- /request fork-left
  request(right);                         -- /request fork-right

  if qucalc(@left and @right) {
    eat;                                  -- (informally /channel send dining "eating")
    pass(left)  -> left.owner;            -- /pass fork-left <owner>
    pass(right) -> right.owner;
  }
}

process dining_table(philosophers) {
  bridge dining_channel;                  -- /channel listen dining
  parallel { for p in philosophers: philosopher(p.name, p.left, p.right); }
}

dining_table([
  aristotle(fork-a, fork-b),
  plato    (fork-b, fork-c),
  …,
]);
```

### Expansion that runs today

DiningPhilosophersDemo.md already walks this end-to-end with `/grant`, `/request`, `/pass`, and `/qucalc`. The RhoQu addition is the **dining channel** — a `/channel`-based event stream for the table's collective state:

**All philosophers (set up the channel + their fork):**

```
/script /channel listen dining; /grant fork-a   -- (aristotle)
/script /channel listen dining; /grant fork-b   -- (plato)
… and so on for each philosopher
```

**Aristotle wants to eat, announces it:**

```
/script /lemma aristotle-hungry; /channel send dining "aristotle hungry"
```

**Aristotle requests his right fork:**

```
/request fork-b
```

**Plato (holds fork-b) responds:**

```
/pass fork-b Aristotle
```

**Aristotle verifies both forks and eats:**

```
/script /qucalc @fork-a @fork-b; /channel send dining "aristotle eating"
```

**Returns forks:**

```
/pass fork-b Plato
```

**Adding the bridged second table** (philosophers split across two rooms — the original [Step 7 rendezvous-lens](DiningPhilosophersDemo.md#step-7--the-rendezvous-lens-atomic-acquisition-as-a-single-event) becomes concrete):

```
/script /room join cap:room:<second-table-cap>; /channel listen dining
/share msg "joining the second table" to cap:room:<second-table-cap>
```

A philosopher in room A who reaches across to a fork held in room B uses `/share` to communicate, then runs the normal `/request` / `/pass` flow once a bridge peer agrees to act as the courier.

What's missing from the expansion: an **automatic policy** for "if both forks present, eat; else wait." The user runs `/qucalc` and decides. A future RhoQu `if` would fold this into the macro body.

---

## Demo 3 — Multisig with persistence

### RhoQu

```
process notary(currency_label, peer, witnesses) {
  note declare currency_label;            -- /note declare attest-X
  note grant currency_label 1;            -- /note grant attest-X 1

  parallel {
    for w in witnesses: persist currency_label to w;
  }

  attest_label ! 1 -> peer.attest_label(1) via rdv;
  on rdv(id) {
    if dyncap verify peer { accept; }
    else { reject; }
  }
}

parallel {
  notary(attest-alice, bob, [carol, dave]);
}
```

### Expansion that runs today

MultisigDemo.md walks the core 2-of-2 cosignature. The RhoQu additions are **persistence to witnesses** (the `parallel { for w … persist … to w }` block) so the attestation survives Alice leaving the room.

**Alice (sets up):**

```
/script /note declare attest-alice; /note grant attest-alice 1
/script /persist currency attest-alice to Carol; /persist currency attest-alice to Dave
```

**Carol and Dave each accept:**

```
/persist accept <8-char id>
```

(Run after the persist-request envelope arrives.)

**Bob mirrors his side:**

```
/script /note declare attest-bob; /note grant attest-bob 1
/script /persist currency attest-bob to Carol; /persist currency attest-bob to Dave
```

**The swap (atomic 2-of-2 cosignature):**

```
/script /rdv swap attest-alice 1 attest-bob 1 Bob   -- Alice runs this
/script /rdv accept <id>                            -- Bob runs this
```

Now four peers (Alice, Bob, Carol, Dave) all hold the public attestation declarations; only Alice and Bob hold the bearer cosignature tokens. If Alice and Bob both leave, Carol and Dave can still tell a future joiner "yes, attest-alice and attest-bob were declared in this room" — the consensus probe at the joiner's connect time will reconcile if Carol and Dave have drifted in their stored copies.

What's missing from the expansion: a **single user-level command** that handles the "broadcast persistence requests then wait for accepts then start the swap" choreography. Today it's a script of small steps; RhoQu's `notary(...)` would automate the choreography given the witness list as input.

---

## What just happened

The three demos exercise every command shipped through v0.15.0. Each RhoQu `process` collapses a multi-step interaction into one body; the expansion column shows that the actual moving parts are already in place.

| Construct | Shipped | Gap |
|---|---|---|
| Mint capabilities (`new`, `note declare`) | ✓ `/grant`, `/note declare` | — |
| Direct send / take (`!`, `request`) | ✓ `/pass`, `/request`, `/note pass` | — |
| Atomic n-party agreement | ✓ `/rdv swap`, `/rdv counter`, `/rdv accept/reject/abort` | — |
| Identity (`dyncap verify`) | ✓ `/dyncap status`, `/dyncap peers` (TOFU-pinned implicit verify on every signed envelope) | — |
| Joint conservation check | ✓ `/qucalc` + `conservationCheck` in `/rdv` | — |
| Multi-room context (`bridge`) | ✓ `/room`, `/share` | — |
| Tagged comms (channels) | ✓ `/channel listen / send` | — |
| Sequencing (`parallel { … }`) | ✓ `/script cmd1; cmd2; …` (sequential — true parallel = separate peers) | — |
| Cross-peer persistence | ✓ `/persist` with explicit accept | — |
| Consensus reconciliation | ✓ `/probe` (joiner-local supermajority) | — |

| Construct | Gap | Required to close it |
|---|---|---|
| `process P(args) { … }` definitions | Need a parser + macro inliner | A `/rhoqu run <text>` command that recognizes `process` and expands at call sites |
| `if cond { … } else { … }` | `/script` is unconditional today | Extend `/script` with an `if` segment that evaluates against `/qucalc` output or `/dyncap` status |
| `on c(x) { … }` receive handlers | No structured channel-receive callback today | `/channel listen <name>` already surfaces messages; the macro would need to register a dispatcher response to inbound `channel-msg` envelopes |
| `timeout Ns { … }` on arbitrary blocks | `/rdv` has built-in 60s timeout; no generic block timeout | A `/script timeout Ns { … }` extension |
| Pattern matching on rdv ids | Manual short-id today | Implicit `<id>` binding in `on rdv` blocks |

Of these, **only the parser/macro inliner is genuinely new infrastructure**. The other gaps are small dispatcher enhancements that compose with what's shipped.

---

## Where the demo *isn't* a stretch

The expansions on the right side of every table above were typed into a shipped quantum-os instance and run during the writing of this document. Each `/share`, `/rdv counter`, `/channel send`, `/persist`, and `/script` example is verified against the actual dispatcher. Nothing was fabricated for the demo — every command exists exactly as shown.

Where the demo *is* a stretch: the RhoQu syntax on the left is not parsed by anything today. It's a sketch of what one possible macro layer over the shipped substrate would look like. Three reasonable alternatives exist (process algebra in the Milner π-calculus style, an Elixir-like actor DSL, a flat session-types language), each with different ergonomic trade-offs. The shipped commands don't commit to any one of them.

---

## Related

- [SyllogismDemo.md](SyllogismDemo.md) — collaborative logic, the first RhoQu use case
- [PromissoryNoteDemo.md](PromissoryNoteDemo.md) — bearer notes; `new currency in / note grant N`
- [AtomicSwapDemo.md](AtomicSwapDemo.md) — the rdv-based exchange this builds on
- [MultisigDemo.md](MultisigDemo.md) — `/dyncap` + `/rdv` as the cosignature primitive
- [DiningPhilosophersDemo.md](DiningPhilosophersDemo.md) — the resource-acquisition example; Step 7's rendezvous-lens is where bridging becomes concrete
- [Consensus.md](Consensus.md) — the probe layer the RhoQu macro inherits for free at every `parallel { … }` boundary
- [SECURITY.md § Multi-room blanket isolation](SECURITY.md#multi-room-blanket-isolation-room) — why `bridge` is application-level only

**[Open a room and try the expansions →](https://jimscarver.github.io/quantum-os/)**
