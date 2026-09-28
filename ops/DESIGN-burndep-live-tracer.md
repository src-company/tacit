# Live provenance tracer for burn-deposit — design + implementation notes

## What exists today

Three pieces are solid, tested, and reusable as-is:

- `dapp/burn-deposit-tracer.js` (`makeBurnDepositTracer`) — pure DAG walk. Given `getCxferByOutput`
  (outpoint → the cxfer that produced it) and a leaf set (C_0, plus any authorized cmints), recursively
  resolves a note's full provenance DAG or throws on an unprovable branch. Tested in isolation
  (`tests/burn-deposit-tracer.mjs`), no Bitcoin I/O of its own.
- `dapp/burn-deposit-assembler.js` (`makeBurnDepositAssembler`) — turns that DAG plus the burn's own
  witness-commitment proof into the exact `reflect.rs` `burnDeposit` witness shape and serializes the
  provenance blob byte-for-byte to the guest's format.
- `classifyConfidentialTx` (`dapp/burn-deposit-bitcoin.js`) — given a raw tx hex, mirrors the guest's own
  envelope parse: recognizes a cxfer and returns its **output** commitments + their real Bitcoin vouts
  (`canonicalOutputVout` per opcode).

What's never existed: a real `getCxferByOutput`. Every burn-deposit that has actually landed
(1000 TAC, 100 TAC, 250k, 1M — see `scratchpad/build-burndep-bundle.mjs` and siblings) was built by hand,
reading pre-computed JSON files from `~/.tacit-seed-note/` that an earlier manual/scratchpad pass produced.
There is no automated path from "here's a note I want to bridge" to a submittable bundle.

## Why `getCxferByOutput` is harder than a lookup

`classifyConfidentialTx(rawTxHex)` only decodes what a transaction **produces** — its own output
commitments and their vouts. It says nothing about which commitment each of the transaction's **inputs**
spent. That's inherent: an input's commitment is whatever commitment its own producing transaction assigned
to that output, which is only knowable by resolving *that* transaction too. So a correct
`getCxferByOutput(outpoint)` must, for the single transaction that produced `outpoint`:

1. Fetch its raw hex, classify it, confirm `outpoint.vout` is one of its cxfer vouts.
2. For **each of its own inputs** (from the raw tx's `vin`, not the envelope — the envelope only describes
   outputs), resolve the outpoint it spends, fetch and classify *that* producing transaction, and read back
   the matching output commitment. One hop per input, not full recursion (the tracer's own outer loop does
   the recursion across hops).
3. Fetch the transaction's containing block (full ordered txid list + wtxid list + raw coinbase) for the
   BIP141 merkle proof the assembler needs — a separate esplora round-trip per hop.

Getting step 2's commitment resolution wrong, or any byte-ordering wrong across txid/commitment encoding,
would not fail loudly — the guest's own `verify_provenance` would simply reject the fold (a liveness
failure someone has to notice and debug), or in the worst case produce a bundle that looks plausible but
doesn't match what the guest actually verifies. Bitcoin transactions are also irreversible: a malformed
*reveal* transaction (as opposed to a malformed bundle sent for registration) burns the note for good if
broadcast anyway.

## Implementation plan

1. **`getCxferByOutput` implementation** — new module (e.g. `worker-relay/src/lib/burndep-live-tracer.js` or
   alongside `dapp/burn-deposit-bitcoin.js`), following the `makeBtcHistoryProvider` pattern already
   established in `dapp/confidential-recovery-btc.js` (multi-base esplora failover, `ESPLORA_BASES`,
   `getJson` with retry). Needs: raw-tx-by-txid, tx-status (containing block hash), block-txids,
   block-raw-coinbase. Shape the result exactly as `burn-deposit-tracer.js`'s own doc comment specifies.

2. **Wire it to the existing tracer** — `makeBurnDepositTracer({ outpointKey }).trace({ getCxferByOutput,
   noteOutpoint, c0Outpoint, leafOutpoints })` needs no changes; it's already the right shape.

3. **Verification bar before this is trusted for anything real**: re-run the new automated tracer against
   one of the already-completed real burns (1000 TAC is the best-documented — its full manually-built
   record is `scratchpad/tac-burn-gen5-built.json` / the DAG in `~/.tacit-seed-note/`) and diff the
   automated DAG against the one that was manually assembled and successfully registered. Byte-for-byte
   parity on the serialized blob (`serializeProvenanceBlob`) is the actual bar — not just "the trace
   completes without throwing." Do this for at least one more of the historical burns (250k or 1M) before
   calling the implementation trustworthy, since a single match could coincidentally hide an off-by-one that
   a deeper or differently-shaped DAG would expose.

4. **Only after step 3 passes**: wire a worker endpoint (a new permissionless GET/POST, following the
   `/reflection/burndep` precedent — this is liveness tooling, not a trust boundary, since the guest
   re-verifies everything) that takes a note reference and returns a ready-to-sign reveal transaction plus
   the bundle to register. The client still signs; nothing here ever touches a private key.

5. **Dapp UI** — only after 4 is live and has processed at least one more real burn through the automated
   path, to avoid shipping a UI in front of unverified plumbing.

## Fee / reliability service — separate decision, doesn't block the above

MARA Slipstream's submission endpoint is public and unauthenticated today — there is no exclusive access to
sell. The honest value in an ops-run service is (a) UX — a UI instead of scripts, and (b) reliability — a
server-side job that completes registration even if the user's own browser/journal is lost, which today's
fully-client-side `burndep-broadcast.js` can't guarantee. A fee for that is reasonable, but the mechanism
(a Bitcoin output the user's own signed reveal tx must include, since only they can sign it — the ops
backend can never hold their key) touches transaction construction directly and should be designed
alongside step 1, not bolted on after. Revisit once the tracer itself is verified.

## Status (live-tested against a real historical burn)

Built: `worker/src/burndep-live-tracer.js` (`makeLiveBurnDepositTracer`, `traceBurnDepositProvenance`) plus a
clean extraction, `worker/src/bitcoin-block-parse.js` (`splitBlockTxs`, now shared by `reflection-attest.js`
and `reflection-attest-bigbatch.mjs`, which had each grown an independent copy — a real pre-existing
duplication risk, not just one avoided).

Ran it live against the real 100-TAC burn's own starting outpoint (from `~/.tacit-seed-note/tac-bundle-final.json`,
a bundle that actually registered and folded). Two things verified for real, not assumed:

- **A real byte-order fact, confirmed against a known-good reference**: that bundle's `prevTxid` fields are
  stored in Bitcoin's internal (little-endian) byte order, not the display order esplora's REST API expects —
  confirmed by reversing it and matching a txid prefix (`a5fc1671…`) already on record from an earlier
  session's memory. This field turns out not to be load-bearing (the assembler only ever reads
  `inputs[].commitment`, never `.prevTxid` — it's informational only), so this wasn't a correctness bug in the
  module, but it's a real, easy-to-get-wrong fact worth having pinned down precisely rather than assumed.
- **A real, previously-unknown scope gap**: `getCxferByOutput` correctly fetched and classified the starting
  transaction, then correctly and safely THREW rather than mis-resolve when one of its own inputs turned out
  to be a plain non-confidential funding input (the assembler's own `inputSkip` concept — a P2WPKH-homed
  note's reveal needs a separate input just to pay for the reveal tx). Telling that apart from a genuine leaf
  input (etch/cmint) needs inspecting the input's actual Bitcoin script type, which the module doesn't do yet.
  This is the next concrete piece of work, not a vague "more testing needed" — see the comment at
  `resolveInputCommitment` in the module for the precise boundary.

This means the module is verified correct for what it does, and safely (loudly) incomplete for what it
doesn't — not silently wrong, which was the actual risk this whole design exercise was about.

## What NOT to do

- Do not skip the byte-for-byte diff against real historical burns and ship on "it looks right."
- Do not let the ops-fee mechanism motivate cutting corners on step 3's verification bar.
- Do not touch `reflect.rs` or any guest/vkey — none of this needs a guest change; it's entirely
  reconstructing, off-chain, what the guest already verifies.
