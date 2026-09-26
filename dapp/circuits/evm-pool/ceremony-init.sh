#!/usr/bin/env bash
# Phase-2 genesis for transact.circom: a reproducible compile, `groth16 setup` over the pinned Hermez ptau, and
# the files the coordinator's POST /ceremony/init takes. Makes no network calls; prints the next commands.
#
#   PTAU=/path/to/pot16_final.ptau bash ceremony-init.sh
#
# Env: OUT (default ./ceremony), PTAU_POWER (16; 18 for dry runs on the AMM pot18), CIRCOM (circom binary),
# WORKER / GATEWAY (used only in the printed commands), FORCE=1 to replace an existing genesis.
# Output: $OUT/genesis/{transact.r1cs, transact.wasm, transact_0000.zkey, manifest.json}
set -euo pipefail
source "$(dirname "$0")/ceremony-env.sh"
cd "$EVM_POOL_DIR"

need_tools
command -v "$CIRCOM" >/dev/null 2>&1 || die "circom not found (set CIRCOM=)"
got=$("$CIRCOM" --version | awk '{print $NF}')
[ "$got" = "$CIRCOM_VERSION" ] || die "circom $got, ceremony pins $CIRCOM_VERSION"

if [ -e "$GENESIS" ]; then
  [ "${FORCE:-0}" = "1" ] || die "$GENESIS exists; FORCE=1 replaces it (never after /ceremony/init has accepted it)"
  rm -rf "$GENESIS"
fi
mkdir -p "$GENESIS"
WORK=$(mktemp -d "$OUT/.init.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

echo "==> [1/5] Phase 1"
check_ptau
ptau_cid=$(cid "$PTAU")
if [ -n "$PTAU_CID" ] && [ -n "$ptau_cid" ] && [ "$ptau_cid" != "$PTAU_CID" ]; then
  die "ptau CID $ptau_cid, pinned $PTAU_CID"
fi
PTAU_CID=${PTAU_CID:-$ptau_cid}
echo "    ptau sha256 $(sha256 "$PTAU")"
echo "    ptau CID ${PTAU_CID:-unknown (no local ipfs)}"

echo "==> [2/5] Compile (circom $CIRCOM_VERSION, twice, outputs must match)"
t0=$(date +%s)
for run in a b; do
  mkdir -p "$WORK/$run"
  "$CIRCOM" transact.circom --r1cs --wasm --O2 -o "$WORK/$run" > "$WORK/$run.log" 2>&1 || { cat "$WORK/$run.log"; die "circom failed"; }
done
for f in transact.r1cs transact_js/transact.wasm; do
  [ "$(sha256 "$WORK/a/$f")" = "$(sha256 "$WORK/b/$f")" ] || die "$f differs between two identical compiles"
done
R1CS="$GENESIS/transact.r1cs"
WASM="$GENESIS/transact.wasm"
cp "$WORK/a/transact.r1cs" "$R1CS"
cp "$WORK/a/transact_js/transact.wasm" "$WASM"
info=$("$SNARKJS" r1cs info "$R1CS" 2>&1 | nocolor)
constraints=$(echo "$info" | grep '# of Constraints:' | awk '{print $NF}')
pub_in=$(echo "$info" | grep '# of Public Inputs:' | awk '{print $NF}')
pub_out=$(echo "$info" | grep '# of Outputs:' | awk '{print $NF}')
[ $((pub_in + pub_out)) -eq "$N_PUBLIC" ] || die "circuit has $((pub_in + pub_out)) public signals, expected $N_PUBLIC"
[ $((constraints + N_PUBLIC + 1)) -le $((1 << PTAU_POWER)) ] || die "$constraints constraints do not fit 2^$PTAU_POWER"
CIRCUIT_HASH=$(sha256 "$R1CS")
echo "    constraints $constraints, public $N_PUBLIC, fits 2^$PTAU_POWER  ($(( $(date +%s) - t0 ))s)"
echo "    r1cs sha256 $CIRCUIT_HASH"
echo "    wasm sha256 $(sha256 "$WASM")"

echo "==> [3/5] groth16 setup"
t0=$(date +%s)
Z0="$GENESIS/transact_0000.zkey"
"$SNARKJS" groth16 setup "$R1CS" "$PTAU" "$Z0" > "$WORK/setup.log" 2>&1 || { tail -20 "$WORK/setup.log"; die "groth16 setup failed"; }
magic "$Z0" 7a6b6579 || die "setup produced no zkey"
echo "    $Z0  $(bytes "$Z0") bytes  ($(( $(date +%s) - t0 ))s)"

echo "==> [4/5] Verify genesis against r1cs + ptau"
t0=$(date +%s)
"$SNARKJS" zkey verify "$R1CS" "$PTAU" "$Z0" > "$WORK/verify.log" 2>&1 || { tail -20 "$WORK/verify.log"; die "genesis zkey does not verify"; }
grep -q "ZKey Ok!" "$WORK/verify.log" || die "genesis zkey does not verify"
echo "    ZKey Ok  ($(( $(date +%s) - t0 ))s)"

echo "==> [5/5] Manifest"
jq -n \
  --arg circuit "dapp/circuits/evm-pool/transact.circom" \
  --arg circuit_hash "$CIRCUIT_HASH" \
  --arg circom "$CIRCOM_VERSION" --arg snarkjs "$SNARKJS_VERSION" --arg circomlib "$CIRCOMLIB_VERSION" \
  --arg src "$(sha256 transact.circom)" --arg tpl "$(sha256 ../btc-pool/btc_pool_templates.circom)" \
  --argjson constraints "$constraints" --argjson npublic "$N_PUBLIC" \
  --argjson r1cs_bytes "$(bytes "$R1CS")" --arg r1cs_cid "$(cid "$R1CS")" \
  --arg wasm_sha "$(sha256 "$WASM")" --argjson wasm_bytes "$(bytes "$WASM")" --arg wasm_cid "$(cid "$WASM")" \
  --arg ptau_name "$PTAU_NAME" --argjson ptau_power "$PTAU_POWER" --arg ptau_b2 "$PTAU_BLAKE2B" \
  --arg ptau_sha "$(sha256 "$PTAU")" --argjson ptau_bytes "$(bytes "$PTAU")" --arg ptau_cid "$PTAU_CID" \
  --arg z0_sha "$(sha256 "$Z0")" --argjson z0_bytes "$(bytes "$Z0")" --arg z0_cid "$(cid "$Z0")" \
  '{
    circuit: $circuit, circuit_hash: $circuit_hash,
    toolchain: { circom: $circom, circom_flags: "--r1cs --wasm --O2", snarkjs: $snarkjs, circomlib: $circomlib },
    sources: { "transact.circom": $src, "../btc-pool/btc_pool_templates.circom": $tpl },
    constraints: $constraints, n_public: $npublic,
    r1cs: { file: "transact.r1cs", sha256: $circuit_hash, bytes: $r1cs_bytes, cid: $r1cs_cid },
    wasm: { file: "transact.wasm", sha256: $wasm_sha, bytes: $wasm_bytes, cid: $wasm_cid },
    ptau: { file: $ptau_name, power: $ptau_power, blake2b: $ptau_b2, sha256: $ptau_sha, bytes: $ptau_bytes, cid: $ptau_cid },
    zkey0: { file: "transact_0000.zkey", sha256: $z0_sha, bytes: $z0_bytes, cid: $z0_cid }
  }' > "$GENESIS/manifest.json"
echo "    $GENESIS/manifest.json"

r1cs_cid=$(jq -r .r1cs.cid "$GENESIS/manifest.json")
z0_cid=$(jq -r .zkey0.cid "$GENESIS/manifest.json")
cat <<EOF

Genesis ready. circuit_hash $CIRCUIT_HASH

Next (operator; nothing below has run). The r1cs and zkey0 together exceed the coordinator's inline upload
cap, so all three artifacts go in by CID. Pin them first and confirm each pinned CID equals the one here:
  ptau   $PTAU  ->  ${PTAU_CID:-<ipfs add --only-hash --cid-version 1>}
  r1cs   $R1CS  ->  ${r1cs_cid:-<ipfs add --only-hash --cid-version 1>}
  zkey0  $Z0  ->  ${z0_cid:-<ipfs add --only-hash --cid-version 1>}
  (bash $CIRCUITS_DIR/pin-bundle.sh $GENESIS pins the genesis files; the ptau is pinned once, separately)
$( [ "$PTAU_POWER" = 16 ] && [ -z "$PTAU16_PINNED_CID" ] && echo "  then record the ptau CID as PTAU16_PINNED_CID in $EVM_POOL_DIR/ceremony-env.sh" )

Open the chain:
  CFG=\$(mktemp); chmod 600 "\$CFG"
  printf 'CEREMONY_INIT_TOKEN: '; IFS= read -rs T; echo
  printf 'header = "X-Tacit-Init-Token: %s"\\n' "\$T" > "\$CFG"; unset T
  curl --config "\$CFG" -sS -X POST \\
    -F circuit_hash=$CIRCUIT_HASH \\
    -F ptau_cid=${PTAU_CID:-<ptau CID>} \\
    -F r1cs_cid=${r1cs_cid:-<r1cs CID>} \\
    -F zkey0_cid=${z0_cid:-<zkey0 CID>} \\
    -F initiator_name=tacit-evm-pool-coordinator \\
    $WORKER/ceremony/init
  rm -f "\$CFG"

Check: state.head_cid is the zkey0 CID, state.r1cs_cid and state.ptau_cid as above, contribution_count 0.
  curl -s $WORKER/ceremony/$CIRCUIT_HASH | jq .state
EOF
