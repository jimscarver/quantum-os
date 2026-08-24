# RChain capability macros — `/global`

`/global` takes a rholang program, expands the macro call sites in it, and hands
the result to your browser to lint, sign and deploy to an RChain node. The room
agent does the expanding; **your browser does the signing, and the key never
leaves it.**

```
/global
new ret in {
  %ballot("Q4 budget", ["ship auth", "pay down debt"]) |
  %directory("Q4 notes")
}
```

This is the bridge between a room and a chain. A room's own state is
ephemeral — when the last peer leaves, it is gone unless a memory daemon held
it. A deploy is not: it lands in the registry as an unforgeable,
content-addressed capability that outlives every peer that was present.

- [How it works](#how-it-works)
- [Writing macros in rholang](#writing-macros-in-rholang)
- [The macro library](#the-macro-library)
- [Testing against a local node](#testing-against-a-local-node)
- [What is and is not enforced](#what-is-and-is-not-enforced)

## How it works

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

## The macro library

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

- [`scripts/qos-cli/README.md`](scripts/qos-cli/README.md) — running the `/global` agent
- [`packages/browser/src/global-macros.js`](packages/browser/src/global-macros.js) — the registry, one source for both halves
- [QuCalc extensions](https://github.com/rchain-community/rchain-rust/blob/dev/docs/src/qucalc/extensions.md) — the system processes these macros call
- [`Governance.md`](Governance.md) — the in-room liquid democracy the `rho:gov:*` macros mirror
- [`SECURITY.md`](SECURITY.md) — threat model
