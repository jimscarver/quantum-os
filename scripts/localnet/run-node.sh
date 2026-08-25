#!/usr/bin/env bash
# run-node.sh — a standalone RChain node to develop /rholang against.
#
#   bash run-node.sh          start (reuses existing chain state)
#   bash run-node.sh --fresh  wipe the data dir and rebuild genesis first
#
# The flags are not decoration; each one earns its place:
#
#   --host 127.0.0.1     without it the node guesses an external IP and Kademlia
#                        fails to bind.
#   --api-host 127.0.0.1 the HTTP API the browser talks to. Without it /rholang
#                        cannot reach the node at all.
#   --dev-mode           lets `/rholang eval` work. Exploratory deploy is refused
#                        on a validating node unless dev mode is on. It does not
#                        affect block production — measured, both ways.
#
# NOT set: --min-phlo-price 0. It looks like the way around the pre-charge
# problem below, since at price 0 the charge is zero and pre_charge returns
# before it looks at any balance. But it breaks block production outright: every
# propose then fails with "Validation of self created block failed with reason:
# InvalidStateHash". Measured on a fresh genesis, one flag apart — plain flags
# produce blocks, adding --min-phlo-price 0 produces none.
#
# KNOWN BROKEN, upstream in rchain-rust: a deploy is pre-charged
# phloLimit x phloPrice against the deployer's REV vault, and nothing ever seeds
# that vault. Genesis funds the *rholang* RevVault contract
# (casper/src/genesis/contracts.rs, rev_generator_code, writing into its
# TreeHashMap) while pre_charge reads the node's *native* vault state
# (rholang/src/native_state.rs). Two different stores. `set_vault_balance` is
# called from pre_charge, refund, deposit and the unit tests, and from nowhere
# else — so no address on any chain has a native balance, and every deploy stops
# at "preCharge: insufficient funds (0 < ...)".
#
# wallet.txt is correct and will fund these keys the moment genesis seeds native
# vaults. Until then a deploy is signed, accepted and lands in a block having
# executed nothing, and `/rholang eval` is the working path.
set -euo pipefail
cd "$(dirname "$0")"

DATA_DIR="${QOS_RNODE_DATA:-$HOME/.rnode-local}"
KEY="$(grep '^validator=' pk.txt | cut -d= -f2)"

if [ "${1:-}" = "--fresh" ]; then
  echo "wiping $DATA_DIR"
  rm -rf "$DATA_DIR"
fi
mkdir -p "$DATA_DIR/genesis"
cp bonds.txt "$DATA_DIR/genesis/bonds.txt"
cp wallet.txt "$DATA_DIR/genesis/wallets.txt"

exec rnode run -s \
  --dev-mode \
  --autopropose \
  --no-upnp \
  --host 127.0.0.1 \
  --api-host 127.0.0.1 \
  --data-dir "$DATA_DIR" \
  --bonds-file "$DATA_DIR/genesis/bonds.txt" \
  --wallets-file "$DATA_DIR/genesis/wallets.txt" \
  --validator-private-key "$KEY"
