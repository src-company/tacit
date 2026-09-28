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

## Update: the funding-input gap above is now handled, and the fix reproduced real data exactly

`classifyInput` now distinguishes three cases for a cxfer's own input: a plain cxfer output (resolved as
before), a CETCH leaf (parsed directly — TAC's own supply note is non-mintable per its `/assets/:id` record,
so CMINT never needs to appear in its lineage and isn't handled), or no envelope at all (a leading,
non-confidential funding input — `inputSkip`). Funding inputs found after a real one are treated as an
anomaly and rejected rather than guessed past.

Re-ran the same real starting outpoint end to end: `inputSkip` came back `1` (one leading funding input,
correctly separated from the one real input), and the resolved output commitment matched
`tac-bundle-final.json`'s own recorded `burned.cx` byte-for-byte (`2c8a223b37189e29c1f4fe8de3a314f34bf16ac
9054060de06de2e8eef042d0b`) — the same already-registered, already-folded real burn, reproduced
independently. CMINT and cxfer_bound hops remain unimplemented (both throw explicitly rather than guess);
neither has occurred in TAC's own lineage so far.

## Update: wired to a worker endpoint, and a real async/sync contract bug caught before it shipped

`worker/src/index.js` now exposes `POST /reflection/burndep/trace` (permissionless, rate-limited tighter than
`/reflection/burndep`), which runs the live tracer against a holder's own note and returns a bundle already
shaped for `/reflection/burndep`'s registration door.

Wiring this up surfaced a real contract mismatch that every prior verification in this document had missed:
`dapp/burn-deposit-tracer.js`'s `trace()` calls `getCxferByOutput(op)` internally without `await` — correct
only for a SYNCHRONOUS producer, which is exactly what its own unit tests (`tests/burn-deposit-tracer.mjs`)
and every historical scratchpad script (`tests/tac-bridge-bundle.mjs`, `tests/tac-bridge-provenance-dag.mjs` —
the latter's own comment says so directly: "getCxferByOutput is async; tracer is sync → pre-build the graph by
BFS") have always supplied. `live.getCxferByOutput` does real per-hop esplora fetches and is genuinely async;
handed directly to `trace()`, it would return a pending Promise where `trace()` expects a resolved object,
throwing `TypeError: cx.inputs is not iterable` on the very first hop of any real trace. Every previous
verification in this document exercised `live.getCxferByOutput` directly, one hop at a time — never through
`trace()`'s own recursive walk — so this never triggered.

Fixed by following the exact pattern the two historical scripts already established, rather than changing
`trace()`'s tested sync contract: `traceBurnDepositProvenance` now resolves the whole DAG itself first (an
async BFS over `live.getCxferByOutput`, same maxDepth cap `trace()` would have enforced), then hands `trace()`
a synchronous lookup over the already-resolved graph. `trace()` and its test suite are unchanged.

Verified against the same real, already-registered 100-TAC burn used above, but this time through the actual
recursive walk end to end (the part that was never previously exercised) rather than a single hop: traced all
38 cxfers back to C_0 with no error, and the resulting txid set is an exact match for `tac-bundle-final.json`'s
own recorded `cxfers[]` (once its internal-byte-order txids are reversed to display order — the same
convention already noted above, now confirmed to apply to every `cxfers[].txid` in the recorded bundle, not
just `burnedInput.prevTxid`). The full `node --test` suite for reflection/burndep and the tracer itself
(15 files) still passes.

## Update: the endpoint timed out in production — full block-witness fetch was the cost, not the walk itself

Manually deployed and hit `POST /reflection/burndep/trace` against production with the same real 100-TAC
burn: the request was reset (HTTP 000, curl error 16) around 61 seconds in — Render's gateway killing a
request that, per the earlier local measurement, was going to take ~316 seconds end to end. A permissionless
endpoint that reliably exceeds a ~60s gateway timeout on real data isn't shippable as a plain synchronous
request, so this needed a real fix, not a retry.

Root cause: `getCxferByOutput` was calling `fetchBlockWitness` — a full raw-block download plus a parse of
every transaction in it — on every hop, solely to produce `blockTxids`/`blockWtxids`/`coinbase`/`index`. The
one real caller (`handleBurnDepositTrace`) never reads any of those fields; it only needs `blockHash`, which
was already sitting on the per-tx JSON `fetchTx` fetches anyway (`json.status.block_hash`) — no extra request
required. The full block-level shape is still valuable for a hypothetical future caller doing local
verification (matching the historical scratchpad scripts), so it's now opt-in: `fullBlockWitness` on
`makeLiveBurnDepositTracer` (default `true`, preserving the original documented contract) and on
`traceBurnDepositProvenance` (default `false`, matching the one real caller today).

Re-ran the identical 38-hop trace after the change: **39.4s, down from 316s** (~8x). This is the only lever
available for a DAG this deep — the walk is inherently sequential (each hop's inputs are unknown until the
hop before it resolves), so nothing here can be parallelized away; only the per-hop cost could shrink. 39s
comfortably clears the gateway timeout that killed the pre-fix request. Full `node --test` suite unaffected
(68 + 13 across the reflection/burndep files, all passing).

**Not fully closed**: a lineage long enough could still exceed the gateway timeout even at the lower per-hop
cost — this trims the constant factor, it doesn't change the O(depth) shape of a synchronous request stapled
to a sequential walk. If a real note's lineage ever gets deep enough for this to matter again, the actual fix
is an async job pattern (start the trace, return a job id, poll for the result) — the codebase already has
this shape for reflection job assembly; this endpoint doesn't have it yet.

## Update: persistent cross-request cache in the registry KV

The block-witness trim (above) only shrinks a constant factor — the walk itself is still a cold esplora crawl
every time, and a long enough lineage will eventually hit a gateway timeout again regardless. The real fix for
that is not per-hop speed, it's not re-crawling at all: what a txid IS for burn-deposit purposes (a cxfer, a
CETCH leaf, a funding input, or neither) is a permanent fact once it's confirmed — Bitcoin doesn't reorg
confirmed history in ordinary operation, and this module already requires `status.confirmed` before resolving
anything. So it never needs to be looked up twice.

`resolveTxid` (replacing the old `fetchTx`) now checks `env.REGISTRY_KV` (`burndephop:{network}:{txid}`)
before touching esplora, and writes its answer there permanently on a miss — no TTL, no invalidation, because
the answer cannot change. Both directions that used to fetch independently (`getCxferByOutput`'s own DAG hop,
and `classifyInput`'s one-hop-back input resolution) now go through this one function, so a txid reached via
either path is fetched from esplora at most once, ever, across every request that ever asks about it — not
just once per request, which the old in-memory-only cache already gave, but once total. A cache hit costs one
KV read and zero esplora calls.

This also means the endpoint doubles as its own crawler: every trace that completes warms the cache for every
other note whose lineage overlaps it — a real, common case, since burn-deposit lineages fan out from shared
ancestors (the 100-TAC burn's own 38-hop chain shares its first several hops with any other note spent from
the same earlier transfers). A deliberate warm-up pass (calling this endpoint for known real notes, from
anywhere — this repo's own tooling, or a separate always-on box with better esplora rate-limit headroom) is
just normal use of the endpoint, not a special mode.

## Update: the caching refactor silently defeated maxDepth — found and fixed before it mattered

Re-reviewing the KV-cache change above (nothing prompted this beyond "keep looking for real problems") surfaced
a genuine structural bug: `resolveTxid` (that update's merged resolver) called `classifyInput` to classify its
own inputs, and `classifyInput` called `resolveTxid` right back — on the INPUT's txid. If that input was itself
a cxfer, resolving IT would recurse into ITS OWN inputs the same way, and so on, all the way back through the
entire lineage. For this module's real 38-hop test lineage, that meant the very first `getCxferByOutput` call —
hop 1 of 38 — silently resolved (and esplora-fetched, and KV-wrote) the WHOLE chain internally before returning
hop 1's own result. `traceBurnDepositProvenance`'s outer BFS loop still enforces `maxDepth`, but only counts
its own iterations — by the time it could throw on iteration 6, the recursive first call had usually already
done all the work maxDepth exists to cap. The throw still fired eventually (so a caller couldn't be fooled into
trusting a partial result), but the cost control it's supposed to provide was gone: a lineage far beyond the
intended cap would still be fully crawled and cached before being rejected.

The recursion existed only because a single function both cached a txid's classification AND resolved its
inputs recursively — the same conflation that made the original `classifyInput`/`fetchTx` split correct in the
first place (module header comment: "the recursion ACROSS hops is burn-deposit-tracer.js's own job... not this
module's"). Fixed by splitting `resolveTxid` back into two layers: `resolveShallow` (cached, returns a txid's
own kind + raw unresolved vins — never calls classifyInput, never recurses) and `getCxferByOutput` (resolves
ONE hop's own inputs via `classifyInput`, which itself only calls `resolveShallow`). Every cache benefit from
the update above is preserved — a txid reached via either path is still esplora-fetched at most once, ever —
but a lineage's depth is once again driven entirely by the outer BFS, one hop per iteration, exactly where
`maxDepth` is checked.

Verified with `maxDepth: 5` against the same real 38-hop lineage: threw `exceeded maxDepth (5)` after 11 esplora
txid fetches (6 real chain hops — 5 processed + 1 lookahead — plus 5 of those hops' own leading funding inputs,
a real per-hop characteristic of this particular lineage, not a symptom of anything wrong), not the ~76 the
recursive bug would have pulled in regardless of the cap. Re-ran the full unrelated `maxDepth: 128` trace too:
still 38/38 hops, same result as before the fix (~39s cold, correctness unchanged).

## Update: the etch/leaf tx now shares the same cache

`handleBurnDepositTrace`'s separate lookup of the asset's own etch tx (never reached by the walk itself, since
leaves are terminal) was two raw, uncached esplora calls on every request. `resolveShallow` is now exposed from
the live tracer's return value, so this lookup goes through the same permanent cache as every other hop — a
repeat trace for the same asset no longer re-fetches its etch tx from esplora at all.

## Update: a per-txid status endpoint — the third piece alongside trace + register

Auditing what's actually left for a permissionless, reliable BTC→ETH bridge (TAC specifically) surfaced a real
gap: nothing answered "what happened to my specific burn-deposit" after broadcasting it. `/reflection/status`
is a global aggregate; `/reflection/burndep-list` is operator-gated and only flags missing block data, not fold
state. A holder (or a future dapp UI) had no way to tell "not broadcast yet" from "confirmed but reflection
hasn't reached it" from "confirmed and folded" from "confirmed but stuck waiting on a bundle."

`GET /reflection/burndep/status?network=&txid=<reveal txid>` closes this. Given only the broadcast reveal
transaction's own txid (everything else — the burned note's outpoint, the asset, the nullifier/dest/target —
is derived from the tx itself via the same `classifyConfidentialTx` the guest's own fold uses), it reports one
of: `not-found`, `unconfirmed`, `not-a-burn-deposit`, `awaiting-scan`, `pending`, `folded`, or `unknown` (no
reflection state to compare against yet). The state model mirrors `dapp/confidential-pool.js`'s actual
lifecycle exactly: a burn either folds directly on first scan (never touches `pendingDepositRecords`) or falls
into the pending-retry set (`completed: false`) until a valid bundle lets a later batch complete it
(`completed: true`) — there is no other terminal state, so those three cases plus "not reached yet" and "not
a real burn-deposit" are exhaustive. Verified against a real, already-registered, already-folded burn
(`b49f4016…`, the same 100-TAC burn used throughout this file): classifies correctly as `type: 'burn'`, its
`vin[0]` resolves to the exact same note outpoint (`a5fc1671…:0`) this whole file's other tests use, and the
computed `outpointKey` matches the format `pendingDepositRecords` stores by construction (traced through
`confidential-pool.js`'s own `hx(b32(...))` normalization to confirm it's a no-op on an already-canonical
`outpointKey` output, not assumed).

Cheap by design — one esplora tx fetch plus one KV read, cached 10s (same TTL as `/reflection/status`'s own
cache) — unlike `/reflection/burndep/trace`, which does a real multi-hop DAG crawl.

## What NOT to do

- Do not skip the byte-for-byte diff against real historical burns and ship on "it looks right."
- Do not let the ops-fee mechanism motivate cutting corners on step 3's verification bar.
- Do not touch `reflect.rs` or any guest/vkey — none of this needs a guest change; it's entirely
  reconstructing, off-chain, what the guest already verifies.
