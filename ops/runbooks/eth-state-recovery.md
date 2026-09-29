# Runbook: the eth-state sidecar

`tacit-eth-state` (`worker-relay/src/eth-state-sidecar.js`) produces the Mode-B "fuel" every Bitcoin-side
reflection attest consumes. Treat it as a tier-1 dependency, because it is one:

> Once the pool's `crossOutCount` has advanced past 0, **every** Bitcoin-side attest must be Mode-B, forever.

That is `ReflectionLib.sol`'s freshness gate, not a policy choice. A forward (`mode_b=0`) batch commits
`foldedCrossOutCount`, and the gate requires it to equal the pool's live `crossOutCount` — true only when
every recorded cross-out has already folded on Bitcoin. A Mode-B batch instead requires the bundle's own
`crossOutCount` to equal the live one. So while any cross-out is outstanding, the only attest that can land
at all is one built from a fresh eth-state candidate.

Everything downstream of a Bitcoin-side attest therefore stops when this service stops: burn-deposit
onboarding, cBTC lock folds, AMM/farm folds, and note availability for anything homed on Bitcoin. No user
can self-serve around it.

## Is it healthy?

```sh
curl -s "$WORKER_BASE/prover-health?kind=eth-state"        # note + age_seconds + healthy
curl -s "$WORKER_BASE/reflection/status?network=mainnet"   # attestedHeight vs tipHeight
cast call "$POOL" "attestedCrossOutCount()(uint256)"       # compare with foldedCrossoutCount above
```

Healthy looks like: a heartbeat under ~10 minutes old, and a `note` cycling through
`idle` / `execute preflight` / `proving (network)`. `tacit-monitor` checks all three prover kinds and pages
on `healthy === false` or on a `note` beginning `error` / containing `STALL`.

## The one failure it cannot recover from by itself

`eth_prove` keeps its own cumulative resume state on the service's disk: `eth_set_state.json` (committed)
and `eth_set_state.pending.json` (this run's candidate). The sidecar commits pending → committed **only**
after independently confirming, via `GET /reflection/eth-state`, that a Bitcoin batch built from that exact
candidate landed on-chain. Committing early would desync the next run's `priorDigest` from what is really
on-chain — the "single-use candidate" trap the file's own header explains.

The gap: that confirmation is matched against `sidecar-inflight.json`, a third local file. **If
`sidecar-inflight.json` is lost while a candidate is pending, and that candidate then lands, the commit
never happens.** Every later `eth_prove` would chain off the stale committed root: each candidate proves
and publishes normally, and only the Bitcoin-side batch built from it fails.

Causes seen or plausible: an ephemeral disk or a disk replacement, `RESET_ETH_PROVE_STATE=1` left set, or a
first run after the service is recreated.

### Detecting it

Before it builds a candidate, the sidecar compares its committed file with the worker's `confirmed`
candidate: the same cumulative cross-outs and consumes, through the same `last_block`. On a mismatch it
builds nothing and reports `STALE RESUME STATE`. The pool's `crossOutCount`/`bitcoinConsumedCount` are not
the reference for this. They include what Ethereum has recorded but no candidate has folded yet, which is
the normal state between two folds.

Corroborate before acting:

```sh
curl -s "$WORKER_BASE/prover-health?kind=eth-state"     # note containing "STALE RESUME STATE"
curl -s -H "Authorization: Bearer $BOX_TOKEN" "$WORKER_BASE/reflection/eth-state?network=mainnet"  # confirmed
cast call "$POOL" "attestedReflectionDigest()(bytes32)" # frozen across several sidecar cycles
```

### Recovering

Two options, cheapest first.

1. **Rebuild the committed state from the confirmed candidate.** `GET /reflection/eth-state` returns the
   `confirmed` candidate the chain actually folded. Reconstruct `eth_set_state.json` to match it:
   `last_block` = its `lastBlock`, the same `crossouts` and `consumeds` in the same order, and
   `bootstrap_slot` = the finalized slot in its `ethPv` (the low 8 bytes of word 5). The published record
   carries only `claimId`/`destCommitment`/`asset` per cross-out, so take each one's `dest_chain` and
   `nullifier` from the pool's own cross-out records. Place the file in `ETH_PROVE_OUT_DIR`, delete
   `sidecar-inflight.json` and `sidecar-stall-watch.json`, and restart. The sidecar compares the file with
   the confirmed candidate before every cycle and builds nothing until they match. Note that
   `proveEthState` deletes `eth_set_state.pending.json` before every network run, so if a run has happened
   since the loss, that file is gone and this reconstruction is by hand.

2. **Full reset.** Set `RESET_ETH_PROVE_STATE=1`, restart once, then unset it. `eth_prove` rescans from
   `DEPLOY_BLOCK` at `SCAN_CHUNK`/`SCAN_DELAY_MS`. **Only for a pool that has never landed a Mode-B batch,
   or a move to a successor deployment** (clear the worker's pending and confirmed records with it). A
   rescan from zero emits a candidate whose prior is the empty genesis accumulator, while the Bitcoin guest
   requires every candidate after the first Mode-B batch to continue the eth digest it committed
   (`reflect.rs`, "eth-reflection prior must continue the committed chain"). On a live pool, every batch
   built from it would panic.

On a live pool, (1) is the recovery. A wrong `eth_set_state.json` reproduces the same stall, which the
sidecar's check reports instead of publishing.

## Other states, and what they are not

- **No pending candidate and none being produced.** Healthy *only* if the sidecar is also beating. A dead
  sidecar with no candidate outstanding reads as "nothing outstanding to fold" to the pending-candidate
  check and "caught up" to the folder — which is why `checkProverKinds` exists.
- **A pending candidate that is old.** The sidecar discards and republishes its own candidate past
  `ETH_STATE_PENDING_STALE_SECS`. The monitor's warn/critical thresholds are derived from that value, so
  they always sit above it. **Do not `POST /reflection/eth-state/clear` a candidate that is merely old** —
  clearing destroys the exact object the next Bitcoin attest chains from. Clear it only when the sidecar's
  own discard-and-republish has demonstrably not happened one full poll interval after it was due.
- **Repeated `cycle error` with backoff.** Each failed cycle may already have spent a network proof, so the
  loop backs off exponentially (60s → 30min cap) and resets on the first success. Read the note: a publish
  failure (control plane down, a 4xx) is different from a prove failure.

## Related

- `worker-relay/src/eth-state-sidecar.js` header — why "is a pending candidate live" is the correct trigger
  and "has crossOutCount changed" is not.
- `contracts/src/ReflectionLib.sol` (`ConsumedCountStale`) — the freshness gate quoted above.
- `docs/BUILD-A-TACIT-DAPP.md` §5f — the integrator-facing consequence, and the `covers` gate.
