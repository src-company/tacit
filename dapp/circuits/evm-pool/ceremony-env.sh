# Shared pins and helpers for the transact.circom phase-2 ceremony scripts. Sourced, not run.

CIRCOM_VERSION=2.2.3
CIRCOM=${CIRCOM:-circom}
SNARKJS_VERSION=0.7.6
CIRCOMLIB_VERSION=2.0.5
N_PUBLIC=11
BEACON_ITERS_DEFAULT=10
MIN_CONTRIBUTIONS_DEFAULT=1000

EVM_POOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CIRCUITS_DIR="$(cd "$EVM_POOL_DIR/.." && pwd)"
REPO_DIR="$(cd "$CIRCUITS_DIR/../.." && pwd)"
SNARKJS="$CIRCUITS_DIR/node_modules/.bin/snarkjs"
OUT=${OUT:-$EVM_POOL_DIR/ceremony}
GENESIS="$OUT/genesis"
FINAL="$OUT/final"
WORKER=${WORKER:-https://api.tacit.finance}
GATEWAY=${GATEWAY:-https://content.wrappr.wtf/ipfs}

# Phase 1: Hermez powers of tau, BLAKE2b as published in the snarkjs README. The ceremony uses the 2^16
# truncation. 2^18 is the file already pinned for the AMM ceremony (../pin-pot18.sh), accepted for local dry
# runs. PTAU16_PINNED_CID stays empty until pot16 is pre-pinned; ceremony-init.sh prints the CID to expect.
PTAU16_PINNED_CID="bafybeie73kd3suqjeshnitj6pmr3qxf6ckjbwxxuqyaaixk77ezeoohtau"
PTAU_ARG=${PTAU:-}
select_ptau() {
  PTAU_POWER=$1
  case "$PTAU_POWER" in
    16) PTAU_BLAKE2B="6a6277a2f74e1073601b4f9fed6e1e55226917efb0f0db8a07d98ab01df1ccf43eb0e8c3159432acd4960e2f29fe84a4198501fa54c8dad9e43297453efec125"
        PTAU_CID=$PTAU16_PINNED_CID ;;
    18) PTAU_BLAKE2B="7e6a9c2e5f05179ddfc923f38f917c9e6831d16922a902b0b4758b8e79c2ab8a81bb5f29952e16ee6c5067ed044d7857b5de120a90704c1d3b637fd94b95b13e"
        PTAU_CID="bafybeigb43fb66kxs4wlxwsgasr22g7itd6yzotgtu2dosjt7zcegsizri" ;;
    *) echo "FAIL: no pinned ptau for power $PTAU_POWER" >&2; exit 1 ;;
  esac
  PTAU_NAME="powersOfTau28_hez_final_$PTAU_POWER.ptau"
  PTAU=${PTAU_ARG:-$CIRCUITS_DIR/pot${PTAU_POWER}_final.ptau}
}
select_ptau "${PTAU_POWER:-16}"

die() { echo "FAIL: $*" >&2; exit 1; }
sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
bytes() { stat -f %z "$1" 2>/dev/null || stat -c %s "$1"; }
blake2b() { openssl dgst -blake2b512 "$1" | sed 's/.*= //'; }
# CIDv1 as a default IPFS add of the file produces it; empty without a local ipfs binary (no daemon needed).
cid() { command -v ipfs >/dev/null 2>&1 && ipfs add --only-hash -Q --cid-version 1 "$1" 2>/dev/null || true; }
magic() { [ "$(head -c 4 "$1" | xxd -p)" = "$2" ]; }
nocolor() { perl -pe 's/\e\[[0-9;]*m//g'; }

need_tools() {
  local c v
  for c in node jq openssl shasum xxd perl "$@"; do command -v "$c" >/dev/null 2>&1 || die "missing dependency: $c"; done
  [ -x "$SNARKJS" ] || die "run npm ci in $CIRCUITS_DIR"
  v=$(jq -r .version "$CIRCUITS_DIR/node_modules/snarkjs/package.json")
  [ "$v" = "$SNARKJS_VERSION" ] || die "snarkjs $v installed, ceremony pins $SNARKJS_VERSION"
  v=$(jq -r .version "$CIRCUITS_DIR/node_modules/circomlib/package.json")
  [ "$v" = "$CIRCOMLIB_VERSION" ] || die "circomlib $v installed, ceremony pins $CIRCOMLIB_VERSION"
}

check_ptau() {
  [ -f "$PTAU" ] || die "$PTAU not found (set PTAU=)"
  magic "$PTAU" 70746175 || die "$PTAU is not a ptau file"
  local got
  got=$(blake2b "$PTAU")
  [ "$got" = "$PTAU_BLAKE2B" ] || die "$PTAU is not $PTAU_NAME (blake2b $got)"
  echo "    ptau blake2b ok ($PTAU_NAME)"
}

# Genesis manifest from ceremony-init.sh: later steps take the r1cs, wasm and ptau pins from it.
load_manifest() {
  MANIFEST="$GENESIS/manifest.json"
  [ -f "$MANIFEST" ] || die "$MANIFEST not found (run ceremony-init.sh, or set OUT=)"
  select_ptau "$(jq -r .ptau.power "$MANIFEST")"
  [ "$(jq -r .ptau.blake2b "$MANIFEST")" = "$PTAU_BLAKE2B" ] || die "manifest ptau does not match the $PTAU_NAME pin"
  CIRCUIT_HASH=$(jq -r .circuit_hash "$MANIFEST")
  R1CS="$GENESIS/transact.r1cs"
  WASM="$GENESIS/transact.wasm"
  [ "$(sha256 "$R1CS")" = "$CIRCUIT_HASH" ] || die "$R1CS does not match the manifest circuit_hash"
  [ "$(sha256 "$WASM")" = "$(jq -r .wasm.sha256 "$MANIFEST")" ] || die "$WASM does not match the manifest"
}

# vkHash exactly as dapp/evm-pool-zk-prover.js defines it (the value makeGroth16System({pinnedVkHash}) checks).
vk_hash() {
  node --input-type=module -e "
    import { readFileSync } from 'node:fs';
    import { vkHash } from '$REPO_DIR/dapp/evm-pool-zk-prover.js';
    console.log(vkHash(JSON.parse(readFileSync(process.argv[1], 'utf8'))));
  " "$1"
}
