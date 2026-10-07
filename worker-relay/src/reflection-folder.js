// ─────────────────────────────────────────────────────────────────────────────
// Reflection folder — the incremental Bitcoin-state attester.
//
// Render service type: Cron Job (RUN_MODE=cron drains pending batches, then exits) or
// Background Worker. It keeps reflection INCREMENTAL (1-2 blocks per cycle) so a batch
// never grows too large to prove: every cycle folds only the small gap since the last
// attested height, proves it on the Succinct NETWORK prover, and attests it on-chain.
//
// Cycle:
//   1. GET /reflection/job?network=  → the assembled next batch (worker streaming
//      assembler, bounded memory). jobId = the batch's newDigest.
//   2. Idempotency: read knownReflectionDigest(); if newDigest already landed
//      (a lost ack), just re-ack — a re-submit would revert, never double-attest.
//   3. proveReflection(input) → bitcoin_prove groth16 on Succinct.
//   4. attestBitcoinStateProven(pv, proof) with the RELAY key.
//   5. POST /reflection/ack {attestedTo, txHash, jobId} → worker advances the
//      un-rewindable attested cursor (persists newSnapshot keyed by jobId).
//
// The persisted snapshot advances only on ack, so a failed prove/submit is a safe
// retry — the same job re-serves and completes. A submitted attest is waited on by polling
// the pool's digest rather than trusting one receipt wait, and is recorded with the API so a later run waits on
// it instead of proving the same batch again; a pool that got ahead of the cursor is reconciled, not re-proved.
// ─────────────────────────────────────────────────────────────────────────────

import { CFG } from './lib/config.js';
import { isMatured } from './lib/maturity.js';
import { reflectionJob, reflectionAck, reflectionPending, reflectionAttestState, reflectionSubmitted, reflectionProofPublish, reflectionEthState, heartbeat, heartbeatIdle } from './lib/worker-client.js';
import { awaitAttestLanding, digestDeepEnough } from './lib/attest-wait.js';
import { recoverLostAck } from './lib/reflection-reconcile.js';
import { proveReflection } from './lib/prover.js';
import { relayWallet, publicClient, verifyClient, readPool, readReflectionDigest, POOL, POOL_ABI, gasAboveCap, HEADER_RELAY, RELAY_ABI } from './lib/chain.js';
import { safeErr } from './lib/safe-err.js';
import { withNonceRetry } from './lib/nonce-retry.js';

const log = (...a) => console.log(`[reflection ${new Date().toISOString()}]`, ...a);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// Confirmation depth required before the ack advances the persisted cursor. The ack is one-way — the
// worker has no path back from being ahead of the chain — so this trades a little latency for not
// having to hand-rewind after every shallow reorg. Overridable, but do not set it to 1.
const ATTEST_CONFIRMATIONS = Math.max(1, parseInt(process.env.ATTEST_CONFIRMATIONS || '3', 10));

async function cycle() {
  const job = await reflectionJob();
  if (!job || !job.input) return false; // caught up
  const attestedTo = Number(job.attestedTo) | 0;
  const newDigest = job.jobId || job.input.newDigest;

  // Idempotency: batch already on-chain (lost ack) → re-ack and skip.
  const onchain = await readReflectionDigest();
  if (onchain && newDigest && onchain.toLowerCase() === String(newDigest).toLowerCase()) {
    // The cursor cannot be rewound, so it is only moved on a reading a reorg cannot take back: deep enough
    // to be settled, and seen by a second provider. The other two ack paths already insist on both; this
    // one advanced on a bare head-of-chain read from a single endpoint.
    if (!(await landedDeep(onchain)) || !(await confirmDigestOn(verifyClient, onchain))) {
      log(`batch ${onchain} is on-chain but not yet deep enough, or the verify endpoint does not see it — not acking yet`);
      await heartbeat('reflection', `landed batch ${onchain} awaiting depth before re-ack`);
      return false;
    }
    log(`newDigest already attested on-chain — re-acking attestedTo=${attestedTo}`);
    // A refused ack leaves the cursor where it was, so the same batch is served again next cycle. Reporting
    // that as success spends the whole run re-assembling it and exits clean, which is how this lane stalls
    // quietly: the stash expires after 24h and the ack can then never succeed without a re-seed.
    const reack = await reflectionAck({ attestedTo, txHash: '', jobId: newDigest });
    if (!reack?.ok) {
      log(`CRITICAL: re-ack refused (status ${reack?.status}) — cursor still at its old height, batch will be re-served`);
      await heartbeat('reflection', `re-ack refused status=${reack?.status} attestedTo=${attestedTo}`);
      return false;
    }
    return true;
  }

  // DRIFT GUARD. The batch chains off `priorDigest`; if the pool is not sitting on exactly that, the attest
  // CANNOT land (StaleReflectionDigest) and proving it just buys an unusable proof. That is the expensive
  // failure mode: the worker's cursor can end up AHEAD of the chain — a tx that landed, got acked, then was
  // dropped by a reorg — and there is no idempotent recovery for ahead-ness the way there is for behind-ness
  // (the re-ack path above). Proving on a stale prior would only spend the prover balance, so fail loud and
  // cheap instead; recovery is a cursor rewind (re-seed /reflection/seed at the chain's height).
  if (job.priorDigest && onchain && String(job.priorDigest).toLowerCase() !== String(onchain).toLowerCase()) {
    // Ahead-ness caused by a lost ack is recoverable: the API still holds the batch that landed. Adopt it and let
    // the loop rebuild the job from the advanced cursor. Anything else stays a refusal.
    const rec = await recoverLostAck({
      onchain,
      findPending: async (d) => reflectionPending(d),
      ack: (a) => reflectionAck({ attestedTo: a.attestedTo, txHash: '', jobId: a.jobId }),
      deepEnough: async () => (await confirmDigestOn(verifyClient, onchain)) && (await landedDeep(onchain)),
    });
    if (rec.waiting) {
      log(`landed batch not yet deep enough, waiting — pool digest ${onchain} has fewer than ${ATTEST_CONFIRMATIONS} confirmations or is not confirmed by the independent endpoint`);
      await heartbeat('reflection', `landed batch ${onchain} not yet deep enough`);
      return false;
    }
    if (rec.recovered) {
      log(`RECOVERED lost ack: pool digest ${onchain} was a landed batch the API still held — cursor advanced to attestedTo=${rec.attestedTo}`);
      await heartbeat('reflection', `recovered lost ack at ${rec.attestedTo}`);
      return true;
    }
    log(`DRIFT: job builds on prior=${job.priorDigest} but pool is at ${onchain} — refusing to prove `
      + `(worker cursor is out of sync with chain; re-seed it, do not let this loop burn PROVE). ${rec.reason}. Manual recovery: ${rec.hint}`);
    await heartbeat('reflection', `drift prior=${job.priorDigest} onchain=${onchain}`);
    return false;
  }

  // A previous run's attest for this same batch may still be in flight (its receipt wait ran out, not the tx).
  // Proving it again would buy a second proof for a tx that is about to land, so wait on the first one.
  try {
    const sub = (await reflectionAttestState()).submitted;
    if (sub && sub.txHash && newDigest && String(sub.newDigest).toLowerCase() === String(newDigest).toLowerCase()) {
      const st = await txStatus(sub.txHash);
      if (st.state === 'pending') {
        log(`attest ${sub.txHash} for this batch was submitted earlier and is still pending — waiting on it instead of re-proving`);
        return await settleSubmitted({ txHash: sub.txHash, newDigest, attestedTo, nonce: await nonceOf(sub.txHash) });
      }
      log(`earlier attest ${sub.txHash} is ${st.state} and the digest has not moved — proving again`);
    }
  } catch (e) { log(`submitted-attest lookup unavailable (${e.message}) — proceeding`); }

  // MATURITY GUARD. The pool only accepts a batch whose tip is at or below the header relay's tip walked back
  // REFLECTION_CONFIRMATIONS. A batch above that reverts UnanchoredReflection deterministically, and the proof
  // is bought before the submit, so within `confirmations` blocks of the tip every cycle would burn a proof on
  // a revert. Wait for the relay to mature the batch instead — this is decided before any spend.
  try {
    const relayTip = Number(await publicClient.readContract({ address: HEADER_RELAY, abi: RELAY_ABI, functionName: 'tipHeight' }));
    if (relayTip > 0 && !isMatured(attestedTo, relayTip, CFG.reflectionConfirmations)) {
      log(`batch tip ${attestedTo} is not yet matured (relay tip ${relayTip}, needs ${attestedTo + CFG.reflectionConfirmations}) — waiting`);
      await heartbeat('reflection', `waiting for relay tip ${attestedTo + CFG.reflectionConfirmations} (now ${relayTip})`);
      return false;
    }
  } catch (e) { log(`maturity check unavailable (${e.message}) — proceeding`); }

  // Spend guard (opt-in): decided BEFORE a proof is bought, so waiting for cheaper gas wastes nothing.
  const dear = await gasAboveCap();
  if (dear) {
    log(`gas ${dear.toFixed(3)} gwei is above MAX_GAS_GWEI=${CFG.maxGasGwei} — waiting`);
    await heartbeat('reflection', `waiting for gas <= ${CFG.maxGasGwei} gwei (now ${dear.toFixed(3)})`);
    return false;
  }
  // Funds guard: the attest is paid from the relay wallet after the proof is bought, and a node refuses a send
  // whose worst-case fee the wallet cannot cover, so a short wallet turns the proof into a loss. Also decided
  // before any spend.
  const funds = await attestFunds();
  if (funds.short) {
    log(`relay wallet holds ${eth(funds.have)} ETH, under the ${eth(funds.need)} ETH an attest can cost at today's gas — waiting for a top-up`);
    await heartbeat('reflection', `relay wallet short: holds ${eth(funds.have)} ETH, an attest needs ${eth(funds.need)}`);
    return false;
  }
  // Once the pool has attested a cross-out, every forward batch must be Mode-B: a mode_b=0 batch commits
  // the permanent 0 sentinel for crossOutCount and the pool rejects it (ReflectionLib ConsumedCountStale).
  // On-chain that is safe — it reverts, nothing is corrupted — but the proof is bought first, so a sidecar
  // outage would buy one groth16 proof every cycle for a transaction that cannot land. The worker's own
  // guard for this is opt-in and was never switched on; the pool knows the answer, so ask it.
  const crossOuts = await readPool('attestedCrossOutCount').catch(() => null);
  if (crossOuts != null && BigInt(crossOuts) > 0n && !job.input.modeB) {
    log(`CRITICAL: pool has attested ${crossOuts} cross-out(s) so every batch must be Mode-B, but this job is forward-only — not proving it`);
    await heartbeat('reflection', `mode_b required (crossOuts=${crossOuts}) but job is forward-only — eth-state candidate missing?`);
    return false;
  }
  log(`job attestedTo=${attestedTo} pending=${job.pending ?? '?'} — proving (network groth16)...`);
  await heartbeat('reflection', `proving ${newDigest}`);
  const { publicValues, proofBytes } = await proveReflection(job.input);

  // Make the proof available to any wallet before this one tries to land it: a proof that cannot be submitted from
  // here (the wallet is short, the node is down) is still good for as long as the pool sits on its prior.
  if (job.priorDigest && newDigest) {
    const published = await reflectionProofPublish({ priorDigest: job.priorDigest, newDigest, attestedTo, publicValues, proof: proofBytes });
    if (!published) log('could not publish the proof for other wallets (continuing)');
  }
  log('proved — submitting attestBitcoinStateProven...');
  // A bare estimate leaves no headroom if state moves between estimating and inclusion, and a revert here costs the
  // whole proof. Unused gas is refunded, so the pad only insures.
  const attestCall = { address: POOL, abi: POOL_ABI, functionName: 'attestBitcoinStateProven', args: [publicValues, proofBytes] };
  // The proof above is already paid for. SETTLE_KEY is unset in production, so the settle service, the
  // header cron and this one all sign from RELAY_KEY — and settles go out privately, so a public RPC's
  // pending nonce does not see one in flight and a collision here is routine. A bare write throws the whole
  // proof away and re-proves next cycle; retrying the submission costs a few seconds. The same holds after
  // submission: a tx whose nonce a private settle took is dropped, and the proof is simply sent again, for as
  // long as the estimate says it still lands (the pool still sits on this batch's prior).
  for (let attempt = 1; ; attempt++) {
    const attestGas = await publicClient.estimateContractGas({ ...attestCall, account: relayWallet.account });
    const txHash = await withNonceRetry('attest', () => relayWallet.writeContract({ ...attestCall, gas: (attestGas * 125n) / 100n }), { log });
    await reflectionSubmitted({ newDigest, txHash, attestedTo });
    const outcome = await landAttest({ txHash, newDigest, attestedTo, nonce: await nonceOf(txHash) });
    if (outcome !== 'dropped') return outcome === 'acked';
    if (attempt >= CFG.reflectionResubmits) return false;
    log(`sending the same proof again (${attempt + 1}/${CFG.reflectionResubmits})`);
  }
}

// What an attest can cost the relay wallet right now against what it holds. The budget covers the padded
// estimate of a large batch; the fee is the cap a send carries (twice the base fee plus the tip), which is what
// the node checks the balance against. An unreadable chain is not a reason to stop.
const ATTEST_GAS_BUDGET = CFG.attestGasBudget;
const eth = (wei) => (Number(wei) / 1e18).toFixed(4);
async function attestFunds() {
  try {
    const [have, blk, tip] = await Promise.all([
      publicClient.getBalance({ address: relayWallet.account.address }),
      publicClient.getBlock({ blockTag: 'latest' }),
      publicClient.estimateMaxPriorityFeePerGas().catch(() => 10n ** 9n),
    ]);
    const need = ATTEST_GAS_BUDGET * (2n * (blk.baseFeePerGas ?? 0n) + tip);
    return { have, need, short: have < need };
  } catch { return { short: false }; }
}

// The nonce a just-sent tx took, read back while the node still holds it; null when it cannot be read.
async function nonceOf(hash) {
  for (let i = 0; i < 4; i++) {
    try { return (await publicClient.getTransaction({ hash })).nonce; } catch { await sleep(2); }
  }
  return null;
}

// Where a submitted attest tx stands, from the chain alone.
async function txStatus(hash) {
  try {
    const r = await publicClient.getTransactionReceipt({ hash });
    if (r.status !== 'success') return { state: 'reverted' };
    return { state: 'mined', confirmations: Number((await publicClient.getBlockNumber()) - r.blockNumber) + 1 };
  } catch { /* no receipt yet */ }
  try { await publicClient.getTransaction({ hash }); return { state: 'pending' }; }
  catch { return { state: 'missing' }; }
}

// Wait for a submitted attest to land, then ack it. Confirmations, not just inclusion: the ack advances the worker's
// canonical cursor and there is no recovery from the cursor being ahead of the chain (see the drift guard above), so
// acking on a one-block receipt strands it permanently the first time that block is reorged.
//
// The wait polls the pool's digest instead of blocking on one receipt call, because a receipt wait that times out
// tells us nothing about the tx: it can still land minutes later. Running out of time here is therefore not an error —
// the tx is left alone and the next run finds it through the recorded submission.
const settleSubmitted = async (args) => (await landAttest(args)) === 'acked';

// -> 'acked' | 'dropped' | 'pending' | 'reverted' | 'unverified'. `nonce` (the tx's own, when known) lets a tx whose
// nonce another sender took count as dropped within a couple of polls instead of after the long miss window.
async function landAttest({ txHash, newDigest, attestedTo, nonce = null }) {
  const nonceSpent = nonce == null ? null
    : async () => (await publicClient.getTransactionCount({ address: relayWallet.account.address, blockTag: 'latest' })) > nonce;
  const res = await awaitAttestLanding({
    newDigest, txHash, readDigest: () => readReflectionDigest(), txStatus, deepEnough: () => landedDeep(newDigest), nonceSpent,
    windowSecs: CFG.reflectionAttestWaitSecs, pollSecs: CFG.reflectionAttestPollSecs, confirmations: ATTEST_CONFIRMATIONS,
  });
  if (res.outcome === 'timeout') {
    log(`attest ${txHash} is still not landed after ${CFG.reflectionAttestWaitSecs}s — leaving it; the next run waits on it rather than re-proving`);
    await heartbeat('reflection', `attest ${txHash} pending past ${CFG.reflectionAttestWaitSecs}s`);
    return 'pending';
  }
  if (res.outcome === 'reverted') {
    // A revert here is almost always "already attested" (digest-chain), which the poll would have seen as landed.
    log(`attest tx reverted (${txHash}) — will retry job next cycle`);
    return 'reverted';
  }
  if (res.outcome === 'dropped') {
    log(`attest ${txHash} was dropped without landing (its nonce went to another transaction)`);
    return 'dropped';
  }

  // A confirmed receipt from publicClient is not yet grounds to ack. publicClient sticks with the FIRST
  // endpoint that answers (viem's fallback() has no reason to move on if RPC_URL keeps returning success),
  // so RPC_URL both submitted this tx and, alone, decided it landed. Ack is unrewindable, so before trusting it, ask an endpoint that had no part in the
  // submission whether the STATE actually changed — not just whether a receipt exists.
  if (!(await confirmDigestOn(verifyClient, newDigest))) {
    log(`WARNING: ${txHash} has ${ATTEST_CONFIRMATIONS} confirmations on the primary RPC, but an independent `
      + `endpoint does not see digest ${newDigest} on-chain — NOT acking (refusing to trust a single endpoint's `
      + `receipt for an unrewindable cursor advance). Will retry next cycle.`);
    await heartbeat('reflection', `unverified attest ${txHash} — primary RPC disagrees with independent read`);
    return 'unverified';
  }

  log(`attested: tx=${txHash} attestedTo=${attestedTo}`);
  const ack = await reflectionAck({ attestedTo, txHash, jobId: newDigest });
  if (!ack?.ok) {
    // The attest is on-chain; only the cursor failed to move. Saying so loudly is what separates this from
    // the silent re-serve loop — recoverLostAck picks it up next cycle while the stash is still alive.
    log(`CRITICAL: ack refused (status ${ack?.status}) after tx=${txHash} — attest landed, cursor did not advance`);
    await heartbeat('reflection', `ack refused status=${ack?.status} tx=${txHash}`);
    return false;
  }
  await heartbeat('reflection', `attested ${newDigest}`);
  return 'acked';
}

// After a batch lands, the next Mode-B batch waits only on the eth-state sidecar publishing a fresh candidate (a
// minute or two). -> true once one is live, false when none appears within reflectionNextJobWaitSecs.
async function nextCandidate() {
  const until = Date.now() + CFG.reflectionNextJobWaitSecs * 1000;
  while (Date.now() < until) {
    try { if ((await reflectionEthState())?.pending) return true; } catch { return false; }
    await sleep(15);
  }
  return false;
}

// The digest still holds ATTEST_CONFIRMATIONS blocks behind the head, on the primary endpoint.
const landedDeep = (expected) => digestDeepEnough({
  readDigestAt: (blockNumber) => readReflectionDigest(publicClient, blockNumber),
  getBlockNumber: () => publicClient.getBlockNumber(), confirmations: ATTEST_CONFIRMATIONS, expected,
});

// Poll a SEPARATE client for the digest actually landing, tolerating ordinary propagation lag (a real tx
// can legitimately reach one node before another) rather than distinguishing that from a false receipt on
// the first try. Five tries over ~40s is generous next to the ATTEST_CONFIRMATIONS wait already paid above.
async function confirmDigestOn(client, expected, tries = 5, delayMs = 8000) {
  for (let i = 0; i < tries; i++) {
    try {
      const d = await readReflectionDigest(client);
      if (d && String(d).toLowerCase() === String(expected).toLowerCase()) return true;
    } catch { /* endpoint hiccup — retry */ }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function main() {
  log(`starting — worker=${CFG.workerBase} network=${CFG.network} pool=${POOL} poll=${CFG.reflectionPollSecs}s`);
  // Fail loud if the network prover isn't configured (no silent local-GPU fallback).
  if (CFG.sp1Prover === 'network' && !CFG.networkPrivateKey) {
    throw new Error('SP1_PROVER=network but NETWORK_PRIVATE_KEY unset — cannot prove');
  }
  // Cron mode: drain any pending batches (usually 0–1, since a 5-min cron keeps pace with
  // Bitcoin's ~10-min blocks) then exit. Bounded by cronMaxCycles + cronBudgetSecs. A run that has landed a
  // batch is catching up: it waits for the next eth-state candidate rather than exiting, so a backlog closes
  // batch after batch instead of one batch per cron interval, within reflectionRunBudgetSecs.
  if (CFG.runMode === 'cron') {
    const t0 = Date.now();
    let landed = 0, waited = false;
    for (let i = 0; i < CFG.cronMaxCycles; i++) {
      const budget = landed ? CFG.reflectionRunBudgetSecs : CFG.cronBudgetSecs;
      if ((Date.now() - t0) / 1000 > budget) { log('cron budget reached — exiting'); break; }
      let worked;
      try { worked = await cycle(); }
      catch (e) { log('cycle error — exiting cron run:', e.message); await heartbeat('reflection', `error ${safeErr(e)}`); break; }
      if (worked) { landed++; waited = false; continue; }
      if (landed && !waited && await nextCandidate()) { waited = true; continue; }
      log('caught up — cron run done'); await heartbeat('reflection', 'caught up'); break;
    }
    return;
  }
  for (;;) {
    try {
      const worked = await cycle();
      // "Caught up" is the steady state between Bitcoin blocks, not a fault — but a caught-up loop never
      // calls heartbeat() itself, so without this /prover-health goes stale (and "down") every time the
      // chain is quiet for 10+ minutes on an otherwise-healthy reflector.
      if (!worked) { await heartbeatIdle('reflection', 'caught up'); await sleep(CFG.reflectionPollSecs); } // idle or retry backoff
    } catch (e) {
      log('cycle error (continuing):', e.message);
      await heartbeat('reflection', `error ${safeErr(e)}`);
      await sleep(CFG.reflectionPollSecs);
    }
  }
}

main().catch((e) => { console.error('fatal', e); process.exit(1); });
