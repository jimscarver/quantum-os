# A local node to develop `/rholang` against

```bash
bash run-node.sh --fresh     # first time: build genesis from bonds.txt + wallet.txt
bash run-node.sh             # after that
```

Then, in the browser:

```
/rholang node http://127.0.0.1:40403
/rholang status
/rholang eval
return!(6 * 7)
                             ← empty line runs it
```

Ports: **40401** deploy gRPC · **40402** eval/propose gRPC · **40403** HTTP (what
the browser uses) · **40405** admin HTTP.

## The files

| file | what it is |
|---|---|
| `pk.txt` | secp256k1 secret keys, `name=hex`. **Throwaway, local only.** |
| `wallet.txt` | `<REV address>,<balance>` for every key in `pk.txt` — the genesis wallets file |
| `bonds.txt` | the validator's public key and stake |
| `keys.mjs` | derives REV addresses; regenerates `wallet.txt` |
| `run-node.sh` | the node invocation, with why each flag is there |

The keys are in the repository on purpose: a local devnet needs a funded key, and
a key nobody can read funds nobody. The validator key is rchain-rust's own
published devnet key; the deployer key was generated here. Both are worthless on
any real network, and using either anywhere with value would hand it away.

```bash
node keys.mjs                              # addresses for the keys in pk.txt
node keys.mjs --generate                   # a fresh key
node keys.mjs --wallet 1000000000000 > wallet.txt
```

A REV address is derived the way the node derives it, so `wallet.txt` funds the
address a deploy is actually charged to:

```
eth     = last 20 bytes of keccak256(public key without its 0x04 prefix)
payload = 00000000 ++ keccak256(eth)
address = base58(payload ++ first 4 bytes of blake2b256(payload))
```

Checked against rchain-rust's own devnet key, which derives to the address its
`tools/devnet.sh` publishes.

## What works

Verified against rchain-rust `dev` at `f3f4759e9`.

**`/rholang eval` works**, including the powerbox. It runs the program in a
read-only sandbox over finalized state and hands back whatever reached `return`,
and the system processes answer there:

```
new return, zfa(`rho:qucalc:zfa`) in { zfa!([0,1], *return) }
  -> (true, -1)
```

One flag earns its place here: the node refuses exploratory deploy unless it is a
read-only observer or in `--dev-mode`, which is why `run-node.sh` sets it.

**`/rholang deploy` executes and is charged.** The node verifies a secp256k1
signature over blake2b256 of the protobuf encoding of `DeployDataProto`, answers
`Success!`, and the deploy lands in a block having run:

```
errored=False  cost=1486
```

A deploy's `return` is unforgeable and the deploy is over by the time anyone
asks, so the wrapper forwards every value onto a public name. Read it back with
`/api/data-at-name-by-block-hash` against the newest block — which is what
`readResults` in `packages/browser/src/rholang.ts` does:

```
zfa!([2,3,0,1])    -> (true, 1)
grant!([2,3,0,1])  -> rho:id:wyncu1hpry1gwfq6hoc1kwezkpycwddk51monimmknu4c6azhi9o
```

Restarting on a chain that already holds an executed deploy is fine — drop the
`--fresh` and it reconnects to its own state, and further deploys still reach the
powerbox.

**Note the API wants JSON.** `POST /api/explore-deploy` rejects a `text/plain`
body with *"Expected request with `Content-Type: application/json`"*; the term
goes up as a JSON string. `rholang.ts` already does this.
