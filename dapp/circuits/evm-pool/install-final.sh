#!/usr/bin/env bash
# Install the sealed ceremony key (finalize.sh output, pinned by pin-final.sh) into the repo: the client artifacts
# the Secret Sats ETH tab and the keepers load (dapp/evm-pool/), the Solidity verifier the deploy script pins, the
# dapp ceremony config, and the integration guide. Run after the coordinator has accepted the finalize.
#
#   BUNDLE_CID=<root CID from pin-final.sh> bash install-final.sh
#
# Env: OUT (default ./ceremony), REPO (default the repo root). Prints the verifier's init code hash for the deploy.
set -euo pipefail
source "$(dirname "$0")/ceremony-env.sh"
REPO=${REPO:-$REPO_DIR}
BUNDLE_CID=${BUNDLE_CID:?set BUNDLE_CID to the bundle root CID printed by pin-final.sh}

for f in pin.json transact_vk.json transact.wasm transact_final.zkey TransactVerifier.sol; do
  [ -f "$FINAL/$f" ] || die "$FINAL/$f missing; run finalize.sh"
done
VK_HASH=$(jq -r .vk_hash "$FINAL/pin.json")
ZKEY_CID=$(jq -r .zkey_cid "$FINAL/pin.json")
CONTRIBUTIONS=$(jq -r .contributions "$FINAL/pin.json")
BEACON_HEIGHT=$(jq -r .beacon.block_height "$FINAL/pin.json")
[ "$(vk_hash "$FINAL/transact_vk.json")" = "$VK_HASH" ] || die "transact_vk.json does not hash to pin.json's vk_hash"
VK_CID=$(ipfs add -Q --cid-version 1 --only-hash "$FINAL/transact_vk.json")
WASM_CID=$(ipfs add -Q --cid-version 1 --only-hash "$FINAL/transact.wasm")

echo "==> dapp/evm-pool (client and keeper artifacts)"
mkdir -p "$REPO/dapp/evm-pool"
# The ETH tab reads names and hashes from pin.json: vk / wasm / zkey with their *_sha256.
jq --arg vk_sha "$(sha256 "$FINAL/transact_vk.json")" --arg bundle "$BUNDLE_CID" \
  '. + { vk_sha256: $vk_sha, bundle_cid: $bundle }' "$FINAL/pin.json" > "$REPO/dapp/evm-pool/pin.json"
cp "$FINAL/transact_vk.json" "$FINAL/transact.wasm" "$FINAL/transact_final.zkey" "$REPO/dapp/evm-pool/"

echo "==> contracts/src/TransactVerifier.sol"
cp "$FINAL/TransactVerifier.sol" "$REPO/contracts/src/TransactVerifier.sol"

echo "==> dapp/tacit.js ceremony config"
python3 - "$REPO/dapp/tacit.js" "$VK_CID" <<'EOF'
import sys
p, cid = sys.argv[1], sys.argv[2]
s = open(p).read()
a = "  finalizedVkCid: null,  // set once finalized"
if s.count(a) != 1: sys.exit('finalizedVkCid line not found')
open(p, 'w').write(s.replace(a, f"  finalizedVkCid: '{cid}',"))
EOF

echo "==> docs/EVM-POOL.md"
python3 - "$REPO/docs/EVM-POOL.md" "$CONTRIBUTIONS" "$BEACON_HEIGHT" "$VK_HASH" "$WASM_CID" "$ZKEY_CID" "$BUNDLE_CID" <<'EOF'
import sys
p, n, beacon, vkh, wasm, zkey, bundle = sys.argv[1:]
s = open(p).read()
pairs = [
  ("""**Status.** The circuit is frozen and its public trusted-setup ceremony runs on tacit.finance. The contracts deploy
when the ceremony finalizes, at the addresses below, which are fixed now.""",
   f"""**Status.** The circuit's public trusted-setup ceremony is closed: {n} contributions, sealed with Bitcoin block
{beacon} as the beacon. The contracts deploy at the addresses below, which are fixed."""),
  ("| `transact.wasm` (witness generator) | ~4.9 MB | pinned on IPFS at finalize |",
   f"| `transact.wasm` (witness generator) | ~4.9 MB | `{wasm}`, and tacit.finance/evm-pool/ |"),
  ("| `transact_final.zkey` (proving key) | ~28.5 MB | pinned on IPFS at finalize |",
   f"| `transact_final.zkey` (proving key) | ~28.5 MB | `{zkey}`, and tacit.finance/evm-pool/ |"),
  ("| verification key hash | 32 B | published at finalize; clients refuse any other key |",
   f"| verification key hash | 32 B | `{vkh}`; clients refuse any other key |\n| ceremony bundle (transcript, keys, verifier) | | `{bundle}` |"),
]
for a, b in pairs:
    if s.count(a) != 1: sys.exit('docs anchor not found: ' + a[:40])
    s = s.replace(a, b)
open(p, 'w').write(s)
EOF

echo
echo "Installed: $CONTRIBUTIONS contributions, beacon $BEACON_HEIGHT, vk_hash $VK_HASH"
echo "Next: forge build, then deploy with EVM_POOL_VERIFIER_INITCODE_HASH=\$(forge inspect src/TransactVerifier.sol:TransactVerifier bytecode | cast keccak)"
