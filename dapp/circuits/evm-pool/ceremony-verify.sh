#!/usr/bin/env bash
# Verify a transact.circom phase-2 zkey (any chain head, or the final key) against the genesis r1cs and the
# pinned ptau, and list its contributions. `snarkjs zkey verify` replays the whole transcript embedded in the
# zkey from the r1cs + ptau, so one call covers every contribution back to genesis.
#
#   bash ceremony-verify.sh <zkey>
#
# Env: OUT (genesis at $OUT/genesis), PTAU, BEACON_HASH (+ BEACON_ITERS, default 10) to require that the last
# contribution is exactly that beacon, MIN_CONTRIBUTIONS (default 0), SUMMARY=<path> to write the result as JSON.
set -euo pipefail
source "$(dirname "$0")/ceremony-env.sh"

ZKEY=${1:?usage: ceremony-verify.sh <zkey>}
[ -f "$ZKEY" ] || die "$ZKEY not found"
magic "$ZKEY" 7a6b6579 || die "$ZKEY is not a zkey"
need_tools python3
load_manifest
check_ptau
echo "    circuit_hash $CIRCUIT_HASH"

LOG=$(mktemp -t evm-pool-verify-XXXXXX)
trap 'rm -f "$LOG"' EXIT
t0=$(date +%s)
"$SNARKJS" zkey verify "$R1CS" "$PTAU" "$ZKEY" 2>&1 | nocolor > "$LOG" || true
grep -q "ZKey Ok!" "$LOG" || { tail -30 "$LOG"; die "$ZKEY does not verify against $R1CS + $PTAU_NAME"; }
echo "    ZKey Ok  ($(( $(date +%s) - t0 ))s)"

SUM=${SUMMARY:-$(mktemp -t evm-pool-verify-sum-XXXXXX)}
python3 - "$LOG" "$SUM" <<'PY'
import json, re, sys
lines = open(sys.argv[1]).read().splitlines()
contribs, cur, hexbuf, circuit = [], None, None, []
for ln in lines:
    s = ln.strip()
    m = re.search(r"contribution #(\d+) (.*):$", s)
    if m:
        cur = {"index": int(m.group(1)), "name": m.group(2), "hash": ""}
        contribs.append(cur); hexbuf = cur; continue
    if re.search(r"Circuit [Hh]ash:$", s):
        circuit = []; hexbuf = circuit; continue
    if re.fullmatch(r"([0-9a-f]{8} ?){4}", s) and hexbuf is not None:
        if isinstance(hexbuf, list): hexbuf.append(s.replace(" ", ""))
        else: hexbuf["hash"] += s.replace(" ", "")
        continue
    m = re.search(r"Beacon generator: ([0-9a-fA-F]+)$", s)
    if m and cur: cur["beacon_hash"] = m.group(1).lower()
    m = re.search(r"Beacon iterations Exp: (\d+)$", s)
    if m and cur: cur["beacon_iters"] = int(m.group(1))
    if s.startswith("[INFO]") and "contribution #" not in s: hexbuf = None
contribs.sort(key=lambda c: c["index"])
json.dump({"snarkjs_circuit_hash": "".join(circuit), "contributions": contribs}, open(sys.argv[2], "w"), indent=2)
PY

n=$(jq '.contributions | length' "$SUM")
beacons=$(jq '[.contributions[] | select(.beacon_hash)] | length' "$SUM")
last_beacon=$(jq -r '.contributions[-1].beacon_hash // empty' "$SUM")
[ "$(jq '[.contributions[].index] == [range(1; (.contributions | length) + 1)]' "$SUM")" = true ] || die "contribution indices are not 1..$n"
jq -r '.contributions[] | "    #\(.index) \(.name)  \(.hash)" + (if .beacon_hash then "  beacon \(.beacon_hash) 2^\(.beacon_iters)" else "" end)' "$SUM"

contributors=$((n - beacons))
echo "    contributions $contributors, beacon ${last_beacon:-none}"
[ "$contributors" -ge "${MIN_CONTRIBUTIONS:-0}" ] || die "$contributors contributions, below MIN_CONTRIBUTIONS=$MIN_CONTRIBUTIONS"
if [ -n "${BEACON_HASH:-}" ]; then
  [ "$beacons" = 1 ] || die "expected exactly one beacon, found $beacons"
  [ "$last_beacon" = "$(echo "$BEACON_HASH" | tr 'A-F' 'a-f')" ] || die "final beacon ${last_beacon:-none} is not $BEACON_HASH"
  iters=$(jq -r '.contributions[-1].beacon_iters' "$SUM")
  [ "$iters" = "${BEACON_ITERS:-$BEACON_ITERS_DEFAULT}" ] || die "beacon iterations 2^$iters, expected 2^${BEACON_ITERS:-$BEACON_ITERS_DEFAULT}"
  echo "    beacon ok: last contribution, 2^$iters iterations"
fi

VK=$(mktemp -t evm-pool-vk-XXXXXX)
trap 'rm -f "$LOG" "$VK"' EXIT
"$SNARKJS" zkey export verificationkey "$ZKEY" "$VK" > /dev/null 2>&1 || die "vk export failed"
echo "    zkey sha256 $(sha256 "$ZKEY")  $(bytes "$ZKEY") bytes"
z_cid=$(cid "$ZKEY"); [ -z "$z_cid" ] || echo "    zkey CID $z_cid"
echo "    vk hash $(vk_hash "$VK")"
[ -z "${SUMMARY:-}" ] && rm -f "$SUM"
exit 0
