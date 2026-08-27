# Macros — Interact2

> **This document has two halves.** The first is the `$` macro language and the
> `+commands` built on it — what a room writes for itself. The second is the
> `%` capability library that ships with the app and expands inside a
> `/rholang` program. Tracked in
> [#65](https://github.com/rchain-community/quantum-os/issues/65).

## Where this comes from

EIES had a command language, INTERACT, and users wrote hundreds of commands in
it, shared them, and watched groups adopt the ones that proved useful. That was
not a feature of the system so much as the point of it —
[EIES_Legacy.md](EIES_Legacy.md) is the full account, and the argument that the
capability model here is a forty-year-old result rather than a new idea.

Two things from it decide the shape of what follows:

- **`+mypriv`** let a command act with its owner's authority — suid, in Unix
  terms — and that is what made a shared command worth sharing at all. Without
  it a command can only do what its *caller* could already do. A capability is
  the same enabling property with the ambient authority removed.
- **Personal → group → system** was ownership and directory permissions, with a
  human deciding at each boundary. Not a governance system. That is why the
  design below starts with capabilities and defers `/gov`.

The 2008 deck *Back to the Network Nation Future* names the destination
outright, under "Formal Language": **Web 3.0 — Rholang, Interact2?** This is
Interact2.

## The language

### `$` — the sigil

Macro names and parameter names both take `$`:

```
$macroname(name="joe", age=5)
$arg
```

`$` is **lexically illegal in rholang**, which is what makes a scanner safe
without a grammar. The node's own lexer rejects it:

```
new return, $x in { return!("x") }   →   Illegal character $ at 28
```

So a `$` site can never be valid rholang, an unexpanded one cannot silently
become something else, and the node is the backstop if expansion is missed.

The `%` sigil this replaces does **not** have that property — `%` is rholang's
modulo operator, and `7 % 3` evaluates to `1`. Call sites and arithmetic shared
a character.

### `/` is what the app ships, `+` is what a person wrote

A definition is made with a built-in verb, so `/macro define` keeps the slash.
What it produces is invoked with `+`:

```
/macro define $standup($topic)  // opens a standup poll
/poll new $topic | yes, no, later
/gov say standup on "$topic" is open
/channel send team standup: $topic
```

```
+standup "Q4 budget"
```

That is the whole rule, and it is worth stating plainly because it is what the
sigil is *for*: a leading `/` is something the app ships and the repo reviewed;
a leading `+` is something somebody in this room wrote. Quotes group an argument
(`"Q4 budget"` is one topic, not two), and `topic="Q4 budget"` names one instead
of passing it by position.

`++text` sends a literal line beginning with `+`, the way `//` does for `/`.
A `+1` in chat is agreement, not a call — only an identifier-shaped name is read
as an invocation.

### Two halves, decided by the body

A body of slash commands makes a **`+command`**. A body of rholang makes a
**fragment**, which has no meaning as a command and is called as a `$name(…)`
site inside another program, the way MacRhoLang's `$print($expression)` was:

```
/macro define $print($expression)  // stdout one term
new stdout(`rho:io:stdout`) in { stdout!($expression) }
```

```
/rholang eval
new return in { $print("hello") | return!(42) }
```

Nothing declares which half a definition is in — the first line of the body
says. The two are the EIES half and the @RHO-bot half of the same language, and
a `+command` reaches the chain by having `/rholang eval` in its body, so they
compose without a third mechanism.

### The two halves have different lexical rules

This is the one place the language is not uniform, and the asymmetry is real
rather than an implementation detail.

|  | rholang body | command body |
|---|---|---|
| `"$topic"` | a string literal — `$topic` is text | quotes somebody typed — `$topic` substitutes |
| `// $topic` | a comment — text | a line, and `//` only starts a comment at column 0 |
| `$m("hello")` | argument is a **term**: expands to `stdout!("hello")` | argument is a **word**: `"Q4 budget"` binds as `Q4 budget` |

Both rows follow from the same question — whose lexer is this? — and getting it
wrong is silent in the worst way. A command body whose `"$topic"` is skipped as
a string literal produces a command with a literal `$topic` in it, and that
command runs.

### Binding

Textual substitution, which is what makes `match` binding work rather than
something separate from it:

```
/macro define $hanoi($height)  // towers of hanoi - use EXPLORE
/rholang eval
match [$height] {
  [height] => {
    new result(`rho:io:stdout`), move, ack in {
      move!(height, "left", "right", "center", *ack)
    }
  }
}
```

`+hanoi 3` substitutes `3` into the match subject and rholang's own `match`
binds `height`. The body stays ordinary rholang; the substitution happens in a
construct the language already has. **Positional by default**, as rhobot does it
for standard components; if *every* argument is written `name=value` they bind
by name instead. Mixing the two is refused, because then the reading of a call
depends on where you stopped.

**A comment following the name is documentation the macro carries.** The
`// towers of hanoi - use EXPLORE` is not decoration: it is what `/macro find`
searches, what the sidebar shows, and what an LLM composing a program has to
work from beyond the code.

### A line beginning with `/` or `+` starts a command

Inside a command body, anything else continues the line before it. That is what
lets a multi-line rholang program be the argument to `/rholang eval` without a
terminator — as in `$hanoi` above, which is one command, not five.

### `echo` and `explain`

Two ways to see what you are about to run, answering different questions:

| verb | shows | is |
|---|---|---|
| `echo` | what the expansion actually produced | evidence — mechanical, checkable |
| `explain` | what that program means, in prose | a reading of the evidence |

`/macro echo <name> [args]` expands and runs nothing. `/rholang echo` shows the
program including the wrapper, macro sites expanded. Neither replaces the other,
and the asymmetry decides how they get used: for an unfamiliar macro, an
explanation is a summary you are also trusting — most useful for understanding,
weakest exactly where the question is *should I sign this*. `echo` answers that
one. `explain` is not built.

### Errors never abort

Every site is attempted, so one report covers them all, and a site that fails is
left exactly as written rather than silently dropped:

```
✗ line 3: unknown macro $nosuch — try /macro list
```

Because `$` is illegal rholang, a site left in is a hard error at the node
rather than something that quietly means the wrong thing.

## Where definitions live

A definition is **room state**: signed with the author's dyncap, broadcast to
the room, replayed to whoever joins next, and tombstoned when retracted — the
same shape as a lemma, and the same code path. It needs no node, no key and no
chain, so a room can write and share commands the moment two peers are in it.

That maps EIES's hierarchy onto what this system already has:

| tier | what it is | built |
|---|---|---|
| personal | a definition in your browser | yes |
| group | a definition shared with the room | yes |
| public / federated | an on-chain dictionary behind a capability | not yet |

**First writer wins a name, and only that author may redefine it** — matched by
dyncap **anchor**, not peerId, so a reload does not cost you your own commands.
That is EIES's rule too: the owner of the file could edit it and nobody else
could. `/forget macro <name>` retracts yours for everyone and hides anyone
else's from your view, exactly as a lemma does.

### `+mypriv`, and what a capability does with it

EIES's most powerful command let a command act with its owner's authority —
suid, in Unix terms — and that is what made a shared command worth sharing at
all. Without it a command can only do what its *caller* could already do.

A `+command` today has no such thing, and does not need one yet: it composes the
caller's own capabilities. The property becomes load-bearing at the on-chain
tier, where a macro can carry the specific caps its author chose to put in it —
the same enabling property with the ambient authority removed, and no superuser
to administer it.

## Still to build

### The on-chain dictionary

Definitions in a dictionary read with an ordinary `/rholang eval` — read-only
over finalized state, free, unsigned, no key involved. A library is a
capability; holding it is access and sharing it is how access spreads.
Promotion is sharing, and **consent is the act of sharing** rather than a vote
that authorises it. A name would resolve in scope order — personal shadows room
shadows chain — so a collision is scoping rather than a conflict to arbitrate.

[`/gov`](Governance.md) stays available for a federated tier that eventually
wants "groups agreed to this" rather than "somebody published it", and stays
unnecessary before then. Groups will make their own rules: capabilities are
mechanism, and policy belongs to whichever group lives with it.

### Open

- **Bearer semantics.** A shared cap is held by whoever it reached; there is no
  un-sharing one. Plain bearer is a fine answer *as long as it is chosen rather
  than discovered*.
- **Versioning.** Does a group consent to a name or to a definition? A name
  means later edits ride in on an old decision. In the room tier a redefinition
  is visible to everyone as it happens; on-chain it would not be.
- **Offline.** Expansion of an on-chain macro needs a node read. What happens
  with no node, and is there a cache?
- **Active text.** `.get` / `.see` / `@(expr)` and text-as-program equivalence
  were on EIES from the start. A macro that is text, stored as text, expanded
  into text is that same identity, but nothing yet *reads* a message as a
  program — see [EIES_Legacy.md](EIES_Legacy.md).
- **Orchestration.** `$` expansion is the seed, not the destination. The
  destination is interactive orchestration of concurrent rholang processes.
  Matching on prompt text is what INTERACT did because it had no channel to
  bind to; here there is one.

## Where the pieces are

| file | what it holds |
|---|---|
| [`packages/browser/src/macro-lang.js`](packages/browser/src/macro-lang.js) | the whole language: parser, both lexers, binder, expander, `--selftest` |
| [`packages/browser/src/app.ts`](packages/browser/src/app.ts) | `/macro`, `+name` routing, storage, the signed wire envelopes |

`macro-lang.js` is plain JS with no imports for the reason `rholang-macros.js`
is: the agent will want to expand a macro to show a room what a `+command` does,
and the browser expands the one it actually runs. Those must not be able to
differ. Run its tests with:

```bash
node packages/browser/src/macro-lang.js --selftest
```

---

# `%` — the capability library

> The approved macro library that ships with the app, expanded inside a
> `/rholang` program. Where `$` macros are what a room writes for itself, these
> are the reviewed capability templates: typed arguments, one source shared
> between the browser and the room agent. Both sigils expand in the same pass,
> built-ins first, so a room macro may be written in terms of one.
>
> The four-step security model below is the whole reason the split between
> expanding and signing exists, and it covers both halves.

## How the current implementation works

Four steps, and the split between them is the whole security model.

1. **Expand.** A `%name(…)` call site is replaced by that macro's rholang. Every
   other byte of your program is passed through exactly as written.
2. **Lint.** The WASM linter (`crates/zfa-core/src/lint.rs`) checks the result is
   well-formed, so you are never asked to sign something that cannot parse.
3. **Sign.** Your browser signs, with a key generated locally and stored in
   IndexedDB wrapped by a passphrase-derived AES key.
4. **Deploy.** The signed packet goes straight from your browser to the node.

The agent only ever performs step 1, and it does that in the open — it posts the
expansion into the room chat, where anyone can read it before anyone signs it. It
holds no key and cannot deploy. **If the agent is compromised, it can post
misleading text into a chat room and nothing more**; it cannot forge a deploy or
reach your key, because it never had either.

Both halves expand through one shared registry
([`packages/browser/src/rholang-macros.js`](packages/browser/src/rholang-macros.js)),
so the rholang you review in chat is the rholang your browser signs. They used to
be separate copies, which meant a macro edited in one and not the other could
make those two things differ.

## Writing macros in rholang

A `/rholang` program is rholang — one line or many. Macro call sites are
written `%name(arg, …)` and expand in place before it is linted or signed:

```
/rholang eval
new ret, log in {
  %ballot("Q4 budget", ["ship auth", "pay down debt"]) |
  for (@winner <- ret) {
    %mailbox("Q4 results")
  }
}
```

**The rholang is not parsed.** The expander scans only far enough to find call
sites that are really call sites: it skips string literals and both comment
forms, balances `()`, `[]` and `{}`, and splits arguments on top-level commas. A
`%name(` inside a string or a comment is text, not a call site.

The `%` sigil is what makes this work without a rholang grammar — a bare
`ballot(…)` would be indistinguishable from a real contract call.

**Errors never abort.** Every call site is attempted, so one report covers them
all, and a site that fails is left exactly as you typed it rather than silently
dropped:

```
✗ line 3: unknown macro %nosuch — try /rholang macros
✗ line 4: amount: expected a non-negative integer (decimal digits only)
```

**Arguments are rholang terms**, which is where quoting comes from: `%directory("New York office")`
works because the term supplies the boundaries. A `term`-typed argument (the
`rho:gov:*` macros take maps) passes through exactly as written.

**One macro can be the whole program.** The bare form still works, and needs no
sigil:

```
/rholang macro transfer 100 bob
/rholang macros                — list the library
```

## The library as it stands

Twenty macros. Each is a typed template: arguments are structurally validated,
then interpolated — a string always lands inside a rholang string literal, an
amount is always a BigInt of decimal digits.

### Proofs — `rho:qucalc:*`

| macro | expands to | mirrors |
|---|---|---|
| `zfa <twists>` | *(read — the agent answers locally)* | `syllogism.rho` "premise" |
| `verify <cap>` | *(read)* | `syllogism.rho` "verify" |
| `%grant(twists)` | `rho:qucalc:grant` — mint a ZFA closure as a capability | `syllogism.rho` "seal" |
| `%fuse(subject, predicate)` | `rho:qucalc:fuse` — dialectical synthesis | `syllogism.rho` "deduce" |

`grant` returns a registry URI, or `Nil` if the history is not ZFA-closed — it
refuses to mint a proof of something unproven. Because the URI is the hash of the
history, the same history always mints the same capability, and it persists
across deploys.

### Group decisions — `rho:gov:*`

| macro | expands to |
|---|---|
| `%trust(ratings, admins)` | `rho:gov:trustLevels` — admin-rooted web of trust |
| `%weights(voters, delegations, levels)` | `rho:gov:resolveWeights` — transitive delegation |
| `%tally(ballots, weights, mode)` | `rho:gov:tally` — weighted IRV or approval |
| `%censure(censures, levels, vouchers)` | `rho:gov:censure` — ⅔-quorum accountability |
| `%ballot(issue, options)` | a ranked tally, for the common case |
| `%delegate(to)` | a self-signed delegation |

These four take rholang maps, so they are program-form only. Composed, they are
[`liquid_democracy.rho`](https://github.com/rchain-community/rchain-rust/blob/dev/qucalc/examples/liquid_democracy.rho):

```
/rholang eval
new levelsCh, weightsCh in {
  %trust({"alice": {"bob": 3}}, ["alice"]) |
  %weights(["alice", "bob"], {"carol": "bob"}, {}) |
  %tally({"alice": ["keep"], "bob": ["replace"]}, {"alice": 3, "bob": 1}, "ranked")
}
```

This is the same liquid democracy `/gov` runs in-room, deployed on-chain: a
member who votes counts for themselves, a member who does not has their weight
flow along the delegation edge to whoever ultimately voted, and cycles abstain.
Voting *is* the per-issue override.

### Bearer capabilities

| macro | expands to |
|---|---|
| `%issuer(currency)` | issuer authority for a currency |
| `%note(authority, amount)` | a bearer note of a denomination |
| `%redeem(authority, amount)` | a permanent, non-transferable receipt |
| `%directory(name)` · `%mailbox(name)` · `%group(name)` | capability-facet stores |
| `%transfer(amount, to)` | `rho:rchain:revVault` |

`issuer` / `note` / `redeem` are the on-chain form of the room's own `/note`
lifecycle, mirroring [`promissory_note.rho`](https://github.com/rchain-community/rchain-rust/blob/dev/qucalc/examples/promissory_note.rho).
The difference is what backs conservation: in-room it is ZFA twist balance, on-chain
it is the RChain purse machinery.

### Structural patterns

| macro | expands to | mirrors |
|---|---|---|
| `%swap(depositA, depositB, toA, toB)` | a `for`-join over four channels | `atomic_swap.rho` |
| `%philosophers([names])` | N diners around a fork ring | `dining_philosophers.rho` |
| `%multisig(nonce, proposal, quorum)` | a nonce-keyed confirmation set | `multisig.rho` |

`%swap` is the same all-or-nothing exchange as `/rdv swap`, and the join *is* the
atomicity — both deposits are consumed together or neither is. No escrow, no
third party:

```
/rholang eval
%swap("alice-deposit", "bob-deposit", "to-alice", "to-bob")
```

```rholang
for (@a <- @"alice-deposit"; @b <- @"bob-deposit") {
  @"to-alice"!(b) |
  @"to-bob"!(a)
}
```

`%philosophers` takes any number of names and seats them in a ring, each holding
both adjacent forks in one join — deadlock is impossible by construction rather
than by protocol.

## Testing against a local node

You do not need a network. A single standalone node runs everything.

```bash
# in the rchain-rust checkout
cargo build --release -p rchain-node --bin rnode

# a funded single-validator genesis (throwaway keys — local only)
mkdir -p ~/.rnode-local/genesis
echo "<validator-pub> 100" > ~/.rnode-local/genesis/bonds.txt
echo "11112VYAt8rUGNRRZX3eJdgagaAhtWTK8Js7F7X5iqddMVqyDTtYau,1000000000000" \
  > ~/.rnode-local/genesis/wallets.txt

rnode run -s --autopropose --no-upnp --host 127.0.0.1 --api-host 127.0.0.1 \
  --data-dir ~/.rnode-local \
  --bonds-file ~/.rnode-local/genesis/bonds.txt \
  --wallets-file ~/.rnode-local/genesis/wallets.txt \
  --validator-private-key <validator-priv>
```

The keys in [`tools/devnet.sh`](https://github.com/rchain-community/rchain-rust/blob/dev/tools/devnet.sh)
are throwaway keys for exactly this. `--host 127.0.0.1` matters: without it the
node guesses an external IP and the Kademlia server fails to bind.

Ports: **40401** external gRPC (deploy), **40402** internal gRPC (eval, propose,
repl), **40403** HTTP, **40405** admin HTTP.

Check it is alive:

```bash
curl -s http://127.0.0.1:40403/status
```

Run rholang without deploying — the fastest loop, no signing, no block:

```bash
rnode --grpc-host 127.0.0.1 --grpc-port 40402 eval mycontract.rho
```

Point the browser at it with `/rholang node http://127.0.0.1:40403`, then
`/rholang status` to check it answers.

**If a macro expands but the node says `No value set for` rho:qucalc:zfa``,** the
node is running a build from before the QuCalc system processes were installed.
Rebuild and restart it — a running node keeps its binary image even after the
file on disk is replaced.

## What is and is not enforced

**Not enforced: which rholang you may write.** The expander does not inspect what
you name a directory, and the linter checks only that the expansion is
well-formed. There is no forbidden rholang. What a deploy can reach is decided by
the unforgeable names it holds — RChain's security is capability-based, and a
denylist of identifiers decides nothing the node does not already decide, while
refusing legitimate programs.

**Enforced: that an argument cannot escape its position.** Every string reaches
rholang through `JSON.stringify` into a string literal, so quotes and backslashes
are escaped. `%directory("new x in { evil!(1) }")` expands to
`{"directory": "new x in { evil!(1) }"}` — text, not code.

**Enforced: that an amount is the amount you typed.** Amounts are decimal digits
carried as a BigInt. `Number()` would round anything past 2⁵³, which for a REV
transfer means the value you approved is not the value you signed.

### Known limitations

- **The browser signs with ECDSA P-256**, where RChain deploys require
  secp256k1. Web Crypto offers no secp256k1, so this is a working placeholder for
  the pipeline shape. **Nothing signed today is valid on a real network** — swap
  `generateKeyPair` / `signPayload` in `rholang-pipeline.ts` for a secp256k1
  implementation before deploying anywhere that matters.
- **Macros expand to standalone programs.** `%ballot(…)` becomes
  `new ret in { … }`, so embedding one mid-expression produces rholang the linter
  will reject. Composing macros into a single program means giving the templates
  a composable form.
- **The agent and browser halves are not a closed loop.** The agent posts an
  expansion into chat and the browser expands locally as a fallback; a room
  message does not yet flow into the browser's sign-and-deploy pipeline
  automatically.

## See also

- [**EIES_Legacy.md**](EIES_Legacy.md) — where this comes from: Interact, `+mypriv`,
  and why user programming is the point rather than a feature
- [**#65**](https://github.com/rchain-community/quantum-os/issues/65) — the
  discussion behind every decision here, including the ones still open
- [**MacRhoLang / @RHO-bot**](https://docs.google.com/document/d/1mTUQwWV9zW5INaJekf-hrZoukWh8Gt8ggFwIxREp1vk/edit) —
  the direct predecessor: `$` sites, `define:`/`echo:`/`find:`, and command-form
  invocation, on a Discord bot against an RChain node
- [`scripts/qos-cli/README.md`](scripts/qos-cli/README.md) — running the macro agent
- [`packages/browser/src/macro-lang.js`](packages/browser/src/macro-lang.js) — the `$` language
- [`packages/browser/src/rholang-macros.js`](packages/browser/src/rholang-macros.js) — the `%` registry, one source for both halves
- [`packages/browser/src/macro-lang.js`](packages/browser/src/macro-lang.js) — the `$` language
- [QuCalc extensions](https://github.com/rchain-community/rchain-rust/blob/dev/docs/src/qucalc/extensions.md) — the system processes these macros call
- [`Governance.md`](Governance.md) — the in-room liquid democracy the `rho:gov:*` macros mirror
- [`SECURITY.md`](SECURITY.md) — threat model
