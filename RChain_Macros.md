# Macros — the plan, and what runs today

> **This document has two halves.** The first describes the macro system being
> designed, tracked in
> [#65](https://github.com/rchain-community/quantum-os/issues/65). The second
> records the `%`-sigil `/global` macros that exist now, which still work and are
> deprecated. Nothing in the first half is implemented yet.

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

## The design

### `$` — the sigil

Macro names and argument names both take `$`:

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

The current `%` sigil does **not** have that property — `%` is rholang's modulo
operator, and `7 % 3` evaluates to `1`. Call sites and arithmetic share a
character today. That is the defect `$` fixes.

### Definitions bind with `match`

A definition names its parameters; `match` binds them. The body is ordinary
rholang, not a template language:

```
define: $hanoi($height)
eval: match [$height] {
  [height] => {
    new result(`rho:io:stdout`), move, ack in {   // towers of hanoi - use EXPLORE
      move!(height, "left", "right", "center", *ack) |
      contract move(@height, @from, @to, @other, ack) = {
        new ack1 in {
          match height {
            1 => {
              result!("Move top disk from " ++ from ++ " to " ++ to) |
              ack!(Nil)
            }
            _ => {
              move!(height-1, from, other, to, *ack1) |
              for ( _ <- ack1 ) {
                move!(1, from, to, other, *ack1) |
                for ( _ <- ack1 ) {
                  move!(height-1, other, to, from, *ack1) |
                  for ( _ <- ack1 ) { ack!(Nil) }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

Binding through `match` means substitution happens in a construct the language
already has, rather than one invented for macros.

**Positional arguments** are worth having for standard components, as rhobot
does it: `match [$a, $b]` binds by position, so a component with a settled
argument order need not be called with names every time.

**A comment following a name introduction enhances the prompt.** The
`// towers of hanoi - use EXPLORE` above is not decoration — a comment attached
to a name is documentation the macro carries with it, and what `explain` (below)
has to work from beyond the code itself.

### Definitions live on the chain, and are read with `eval`

Some macros are built in. The rest live in an **on-chain dictionary**, read with
an ordinary exploratory deploy — `/rholang eval`, which is read-only over
finalized state, costs nothing and signs nothing. Looking a macro up is the same
operation as any other chain read: no new trust surface, no key involved, and it
works against any node you can reach.

### Expansion happens in the browser

Not in the agent. The browser reads the definition, expands, lints and signs, so
a compromised agent still cannot influence what gets signed. Moving the library
on-chain does not weaken the
[zero-trust split](EIES_Legacy.md#what-is-deliberately-different) — it leaves it
exactly where it was.

### `echo` and `explain`

Two ways to see what you are about to sign, answering different questions:

| verb | shows | is |
|---|---|---|
| `echo` | the rholang the expansion actually produced | evidence — mechanical, checkable |
| `explain` | what that program means, in prose | a reading of the evidence |

Neither replaces the other, and the asymmetry decides how they get used. For an
unfamiliar macro out of the dictionary, an explanation is a summary you are also
trusting: most useful for understanding, weakest exactly where the question is
*should I sign this*. `echo` is what answers that one.

`/rholang echo` already exists — today it shows the wrapper
every program is given before signing, and it is where a macro expansion will
appear.

### Libraries are capabilities

A library is a capability. Holding it is access; sharing it is how access
spreads. Rooms, peers and dyncap are already capabilities here, and on the chain
an unforgeable name *is* one — so a macro dictionary behind a cap needs no new
concept.

The tiers fall out of who holds which cap, with no votes involved:

| tier | what it is |
|---|---|
| personal | a library cap you hold and have not shared |
| group | a cap shared with a group |
| public / federated | a published cap, or a well-known registry name |

Promotion is sharing. **Consent is the act of sharing**, rather than a vote that
authorises it. A name resolves in scope order — personal shadows group shadows
public — so collisions are scoping rather than conflicts to arbitrate.

[`/gov`](Governance.md) stays available for a federated tier that eventually
wants "groups agreed to this" rather than "somebody published it", and stays
unnecessary before then. Groups will make their own rules: capabilities are
mechanism, and policy belongs to whichever group lives with it.

### Open questions

Recorded in [#65](https://github.com/rchain-community/quantum-os/issues/65),
unresolved here:

- **Bearer semantics.** A shared cap is held by whoever it reached; there is no
  un-sharing one. Plain bearer is a fine answer for a first cut *as long as it is
  chosen rather than discovered*.
- **Versioning.** Does a group consent to a name or to a definition? A name means
  later edits ride in on an old decision.
- **Nesting.** May a macro body contain `$` sites? If so it needs a depth bound.
- **Offline.** Expansion needs a node read for an unknown macro. What happens
  with no node, and is there a cache?
- **Active text.** `.get` / `.see` / `@(expr)` and text-as-program-equivalence
  were on EIES from the start and have no counterpart here yet. A macro that is
  text, stored as text, expanded into text is that same identity — see
  [EIES_Legacy.md](EIES_Legacy.md).

---

# What runs today

> Everything below documents the `%`-sigil `/global` macros as they exist now.
> They work and are deprecated; the design above replaces them. Kept because it
> is the reference for what is actually deployed, and because the security model
> in the next section survives the redesign unchanged.

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
([`packages/browser/src/global-macros.js`](packages/browser/src/global-macros.js)),
so the rholang you review in chat is the rholang your browser signs. They used to
be separate copies, which meant a macro edited in one and not the other could
make those two things differ.

## Writing macros in rholang

A `/global` body is a rholang program — one line or many. Macro call sites are
written `%name(arg, …)`:

```
/global
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
✗ line 3: unknown macro %nosuch — try /global macros
✗ line 4: amount: expected a non-negative integer (decimal digits only)
```

**Arguments are rholang terms**, which is where quoting comes from: `%directory("New York office")`
works because the term supplies the boundaries. A `term`-typed argument (the
`rho:gov:*` macros take maps) passes through exactly as written.

**One macro can be the whole program.** The bare form still works, and needs no
sigil:

```
/global transfer 100 bob
/global macros            — list the library
/global help
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
/global
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
/global %swap("alice-deposit", "bob-deposit", "to-alice", "to-bob")
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

Point the browser at it with `/global node http://127.0.0.1:40403`, then
`/global` as usual.

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
  `generateKeyPair` / `signPayload` in `global.ts` for a secp256k1
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
- [**#65**](https://github.com/rchain-community/quantum-os/issues/65) — the design
  this document describes, and the discussion behind every decision in it
- [`scripts/qos-cli/README.md`](scripts/qos-cli/README.md) — running the `/global` agent
- [`packages/browser/src/global-macros.js`](packages/browser/src/global-macros.js) — the registry, one source for both halves
- [QuCalc extensions](https://github.com/rchain-community/rchain-rust/blob/dev/docs/src/qucalc/extensions.md) — the system processes these macros call
- [`Governance.md`](Governance.md) — the in-room liquid democracy the `rho:gov:*` macros mirror
- [`SECURITY.md`](SECURITY.md) — threat model
