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

## What works, and what does not

**`/rholang eval` works.** It runs the program in a read-only sandbox over
finalized state and hands back whatever reached `return`.

Two things it cannot do. The node refuses exploratory deploy unless it is a
read-only observer or in `--dev-mode`, which is why `run-node.sh` sets that flag.
And the node does not run its **system processes** in that sandbox: pure rholang
returns values, but `rho:qucalc:*`, `rho:gov:*`, `rho:registry:*` and
`rho:rchain:*` yield nothing. The names bind — the wrapper declares them — the
processes simply never reply. Reaching those means a deploy.

**`/rholang deploy` signs correctly and executes nothing.** The signature is
right: the node verifies a secp256k1 signature over blake2b256 of the protobuf
encoding of `DeployDataProto`, and it answers `Success!`. The deploy lands in a
block. It then fails at pre-charge, every time, on every key:

```
errored=True  cost=0  preCharge: insufficient funds (0 < 500000)
```

Genesis funds the **rholang RevVault contract**; pre-charge reads the node's
**native vault state**. Two separate stores, and nothing bridges them —
`set_vault_balance` is called from `pre_charge`, `refund`, `deposit` and the unit
tests, and from nowhere else. So no address on any chain has a native balance.

Setting `--min-phlo-price 0` looks like the way out, since `pre_charge` returns
immediately when the charge is zero. It is not: block production then fails with
`InvalidStateHash` on every propose. Measured on a fresh genesis, one flag apart.

**The fix is upstream**, in rchain-rust: seed the native vault from the genesis
vaults, so `wallet.txt` means what it says. Until then, `eval` is the working
path and a deploy is a signed no-op.
