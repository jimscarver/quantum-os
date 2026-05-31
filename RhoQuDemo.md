# RhoQu: A Macro Layer

A demo of **RhoQu** — the rho-calculus-flavored macro language that compiles to quantum-os `/commands`. The parser ships in [`packages/browser/src/rhoqu.ts`](packages/browser/src/rhoqu.ts) and is invoked via `/rhoqu <source>`. Every RhoQu fragment below is followed by the actual command-list it transpiles to today.

Two layers, with a shipped parser between them:

- **Top layer (RhoQu, parsed by `/rhoqu`)**: `process`, `new`, `parallel`, `|`, `on`, `if`/`else` — reads like rho calculus, one-line-per-intent.
- **Bottom layer (existing `/commands`)**: `/grant`, `/lemma`, `/note`, `/rdv`, `/share`, `/channel`, `/script`, `/persist`, `/dyncap`, `/probe`. Each RhoQu construct lowers to a small group of these.

The parser handles four commits' worth of features:
1. **Core constructs** — `process Name(args) { body }` definitions with `$arg` substitution, `new x y z` (→ `/grant`), `parallel { … }`, `Name(args)` calls, raw `/command` passthrough, `//` comments.
2. **Conditionals** — `if expr { … } else { … }` with built-in predicates `has(@x)`, `bal(c)`, `declared(c)`, `peers()`, `connected()`, `seq()`, operators `==`/`!=`/`<`/`<=`/`>`/`>=`, boolean `and`/`or`/`not`. Evaluated at transpile time against the active room's state.
3. **Receive handlers** — `on channel(x) { body }` registers a per-room handler that fires whenever a matching `channel-msg` envelope arrives. Body re-runs with `x` bound to the payload. Manage with `/rhoqu list` and `/rhoqu clear`.
4. **Pipe operator** — `a | b | c` is sugar for `parallel { a; b; c }` (rho-calculus convention). Statements still terminate with `;` for sequential composition.

Still deferred: `timeout Ns { ... }` blocks; first-class `!` / `?` / `->` send/receive shorthand over channels and rendezvous (the underlying `/channel` and `/rdv` commands are reachable today via raw passthrough).

---

## The mapping

| RhoQu | Expansion | Status |
|---|---|---|
| `new x y z;` | `/grant x` → `/grant y` → `/grant z` | ✓ commit 1 |
| `process P(a, b) { body } P(x, y);` | inlined body with `$a`/`$b` substituted | ✓ commit 1 |
| `parallel { A; B; C }` | A then B then C (sequential — single-peer "parallel" is order-irrelevant) | ✓ commit 1 |
| `A \| B \| C` | same — `\|` is sugar for `parallel { A; B; C }` | ✓ commit 4 |
| `/cmd ...;` raw command | dispatched verbatim with `$arg` substitution | ✓ commit 1 |
| `// comment` to end of line | skipped | ✓ commit 1 |
| `if expr { … } else { … }` | evaluates `expr` at transpile time; emits the chosen branch | ✓ commit 2 |
| `has(@x)` / `bal(c)` / `declared(c)` / `peers()` / `connected()` / `seq()` | reads `lemmaStore` / `noteStore` / `knownCurrencies` / `peers` Set / `qpeer` / `dyncapState.seqByRoom` | ✓ commit 2 |
| Comparison ops `==` `!=` `<` `<=` `>` `>=`; boolean `and` `or` `not` | standard precedence; numeric vs string comparison auto-detected | ✓ commit 2 |
| `on channel(x) { body }` | per-room handler; runs body with `x = payload` on every matching `channel-msg` | ✓ commit 3 |
| `/rhoqu list` / `/rhoqu clear` | inspect / drop registered on-handlers | ✓ commit 3 |
| Bridge / channel / persist / rdv-counter operations | use the raw `/share`, `/channel`, `/persist`, `/rdv counter` commands via passthrough | ✓ via passthrough |
| `timeout Ns { … }` | not yet — `/rdv` has built-in 60s; generic block timeouts pending | ✗ deferred |
| First-class `!` / `?` / `->` send/receive shorthand | not yet — use raw `/channel send` / `on c(x)` | ✗ partial deferred |

---

## Demo 1 — Atomic swap with conditional accept

### RhoQu (runs today via `/rhoqu`)

```
process propose(other, give_cur, give_n, get_cur, get_n) {
  /rdv swap $give_cur $give_n $get_cur $get_n $other;
}

process accept_if_have(get_cur, get_n) {
  if bal($get_cur) >= $get_n {
    on rdv(id) { /rdv accept $id; }
  } else {
    on rdv(id) { /rdv reject $id; }
  }
}
```

### What you type

**Alice (proposes USD 30 ↔ EUR 20):**

```
/rhoqu process propose(other, give_cur, give_n, get_cur, get_n) { /rdv swap $give_cur $give_n $get_cur $get_n $other; } propose(Bob, USD, 30, EUR, 20);
```

Expands to:

```
/rdv swap USD 30 EUR 20 Bob
```

**Bob (sees the propose; counters at USD 25 if his held EUR 20 wouldn't cover the counter, otherwise accepts):**

```
/rhoqu if bal(EUR) >= 20 { /rdv accept a3f1c2; } else { /rdv counter a3f1c2 USD 25 EUR 20; }
```

The `if` predicate evaluates at transpile time against Bob's `noteStore`, so the right branch is the only one that runs. Bob's chat shows the chosen command and its output exactly as if he'd typed it.

**Alice (sees Bob's counter, accepts the new terms if `>= USD 25` total is what she can spare):**

```
/rhoqu if bal(USD) >= 25 { /rdv accept a3f1c2; } else { /rdv abort a3f1c2; }
```

The whole flow takes three `/rhoqu` invocations instead of three rounds of manual command typing — but each invocation embeds the policy that decides which command runs.

What's still manual: **the proposal id `a3f1c2`** — the parser doesn't have a `$LAST_ID` binding (commands run sequentially but the id from a /rdv swap isn't reflected back into the RhoQu env). For now, copy the short id from the chat output into the next invocation. A `let id = /rdv swap ...` variable-binding extension would close this gap; it's a candidate for commit 5.

---

## Demo 2 — Dining Philosophers with a bridge to a second table

### RhoQu

### RhoQu (runs today via `/rhoqu`)

```
process setup(name, my_fork) {
  /channel listen dining;
  /grant $my_fork;
  /lemma $name-thinking;
}

process try_to_eat(name, left, right) {
  if has(@$left) and has(@$right) {
    /qucalc @$left @$right;
    /channel send dining "ate";
  } else {
    /channel send dining "waiting";
  }
}
```

### What you type

Each philosopher runs setup once on join:

```
/rhoqu process setup(name, my_fork) { /channel listen dining; /grant $my_fork; /lemma $name-thinking; } setup(aristotle, fork-a);
```

When Aristotle wants to eat, he requests the right fork and then `try_to_eat` checks whether he holds both. The `if has(@fork-a) and has(@fork-b)` predicate evaluates against his current `lemmaStore`:

```
/request fork-b
(plato responds: /pass fork-b aristotle)
/rhoqu process try_to_eat(name, left, right) { if has(@$left) and has(@$right) { /qucalc @$left @$right; /channel send dining "ate"; } else { /channel send dining "waiting"; } } try_to_eat(aristotle, fork-a, fork-b);
```

When done, return the fork with raw `/pass fork-b plato;`.

**Background event handler.** Any philosopher can register an on-handler that fires when the dining channel reports activity:

```
/rhoqu on dining(msg) { // log the dining channel into chat as system lines
                        /script // received: $msg }
```

(Today the body just no-ops as a comment placeholder; a future commit-5 sugar would let the handler do something with the bound `$msg`.)

**Adding the bridged second table** — philosophers split across rooms can `/share msg` between tables. The bridge stays application-level: a peer in both rooms re-broadcasts `dining` messages manually:

```
/rhoqu on dining(msg) { /share msg $msg to <other-room-prefix>; }
```

What's still manual: **a $LAST_ID-style binding for the proposal id** would make the request/pass loop self-driving. Today the user copies the id between commands.

---

## Demo 3 — Multisig with persistence

### RhoQu (runs today via `/rhoqu`)

```
process notary_setup(label, witness_1, witness_2) {
  /note declare $label;
  /note grant $label 1;
  // Replicate the public declaration to two witnesses so it survives
  // any one peer leaving. Each witness must /persist accept on receipt.
  /persist currency $label to $witness_1 | /persist currency $label to $witness_2;
}
```

### What you type

**Alice (sets up her notary, asks two witnesses to persist her authority):**

```
/rhoqu process notary_setup(label, witness_1, witness_2) { /note declare $label; /note grant $label 1; /persist currency $label to $witness_1 | /persist currency $label to $witness_2; } notary_setup(attest-alice, Carol, Dave);
```

Note the `|` — both `/persist` envelopes are parallel-composed (no ordering dependency), which in single-peer execution still runs sequentially.

**Carol and Dave each accept (after the persist-request arrives):**

```
/persist accept <8-char id>
```

**Bob mirrors his side**:

```
/rhoqu notary_setup(attest-bob, Carol, Dave);
```

(`notary_setup` is still defined from Alice's invocation — but only inside her tab. Each peer who wants the macro available types it once.)

**The atomic 2-of-2 cosignature swap**, with conditional fallback:

```
/rhoqu if bal(attest-alice) >= 1 and bal(attest-bob) == 0 { /rdv swap attest-alice 1 attest-bob 1 Bob; }
```

The `if bal(attest-alice) >= 1 and bal(attest-bob) == 0` guard checks Alice's wallet at transpile time: she holds her own attest token but not Bob's yet. If true, the swap fires.

Now four peers (Alice, Bob, Carol, Dave) all hold the public attestation declarations; only Alice and Bob hold the bearer cosignature tokens after commit. If Alice and Bob both leave, Carol and Dave can still tell a future joiner "yes, attest-alice and attest-bob were declared in this room" — the consensus probe reconciles any drift.

What's still manual: the choreography of "wait for both /persist accepts before triggering the swap" — RhoQu evaluates `if` at transpile time, not at exec time, so a single `/rhoqu` invocation can't observe an envelope arrival mid-script. The user runs the swap after seeing the accept lines in chat. A future async/await or exec-time `if` would close this.

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

| Construct | Status | Where it lives |
|---|---|---|
| `process P(args) { … }` definitions | ✓ shipped | `/rhoqu` (commit 1) — parsed by `packages/browser/src/rhoqu.ts`, expanded inline at call sites |
| `parallel { … }` and `|` operator | ✓ shipped | `/rhoqu` (commits 1 & 4) — `|` between statements groups them as parallel; sequential commits inside a group |
| `if cond { … } else { … }` | ✓ shipped (transpile-time) | `/rhoqu` (commit 2) — evaluates `bal(@name)`, `peers`, `connected`, `seq`, `hasLemma(@name)` against current room state |
| `on c(x) { … }` receive handlers | ✓ shipped | `/rhoqu` (commit 3) — registers a channel-msg dispatcher on the room; payload bound as `x`; `/rhoqu list` / `/rhoqu clear` manage handlers |
| `timeout Ns { … }` on arbitrary blocks | ✗ deferred | `/rdv` has built-in 60s timeout; a generic `timeout` wrapper would be a small `/script` extension |
| Pattern matching on rdv ids | ✗ deferred | Implicit `<id>` binding in `on rdv` blocks is still manual short-id |
| Exec-time `if` (await an envelope, then branch) | ✗ deferred | `if` resolves at transpile, so a `/rhoqu` invocation can't observe an inbound envelope mid-script |

The remaining deferred items are small composable extensions, not new infrastructure.

---

## Where the demo *isn't* a stretch

Every `/rhoqu` invocation and every primitive command (`/grant`, `/note declare`, `/pass`, `/rdv`, `/share`, `/channel`, `/persist`, `/probe`, `/script`) above was typed into a shipped quantum-os instance and run during the writing of this document. The RhoQu parser is live in `packages/browser/src/rhoqu.ts` and reachable via the `/rhoqu` dispatcher.

Where the demo *is* still a stretch: `if` evaluates against current room state at transpile time, not against inbound envelope arrivals at exec time. So choreographies that need "wait for the persist accept, *then* fire the swap" still require the user to manually run the next `/rhoqu` after the accept lands. Exec-time `if` (or an `await`-style extension to `on` handlers) is the natural next step.

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
