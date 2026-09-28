// Worker-side reflection attestation: maintains the canonical Bitcoin confidential-pool reflection state
// via the FULL-SCAN model (every tx of every confirmed block) and assembles the prover batches the
// reflection relayer proves + submits to ConfidentialPool.attestBitcoinStateProven.
// Dependency-injected (deps={secp,keccak256,sha256}, storage, getBlockTxs/getHeaders, classifyTx,
// burnDepositKit) so it is testable + deployment-agnostic. The persisted SNAPSHOT (advanced only on ack,
// after the on-chain attestation lands) is the source of truth, so a restart/redeploy is always consistent.

import { makeScanReflectionIndexer } from '../../dapp/confidential-reflection-scan-indexer.js';
import { makeBurnDepositKit } from '../../dapp/burn-deposit-bitcoin.js';
import { SWAP_BATCH_VK } from '../../dapp/confidential-swapbatch-vk.js';
import { splitBlockTxs } from './bitcoin-block-parse.js';
import { makeBurndepAdmission } from './burndep-admission.js';

// ── Full-scan reflection attester (the worker's Bitcoin-state relay) ──
// The canonical state is a SNAPSHOT (the full-scan ScanReflection: live set + accumulators +
// coords) persisted at the ATTESTED height. A cycle assembles the un-attested block range by
// fetching EVERY tx of each block (so the guest's merkle-completeness check holds — no pool spend
// can be omitted), advancing a copy of the snapshot, and proving; the persisted snapshot only
// advances on ack (after the on-chain attestation), so a failed prove/submit is a safe retry.
//
//   deps          : { secp, keccak256, sha256 }
//   storage       : { load(): {snapshot, attestedHeight, tipHeight} | null, save(state) }
//   getBlockTxs   : (height) => Promise<{ txs: [...] }>  — every tx of the block (the worker block-tx shape)
//   getHeaders    : (heights[]) => Promise<hex[]>        — the 80-byte headers, in height order
//   burnDepositKit: (optional) the TAC burn-deposit / cmint-deposit onboarding tooling the scan indexer
//                   needs to assemble a 0x2B burn of a PRE-existing (never-reflected) note — see
//                   makeScanReflectionIndexer's burnDepositKit contract. Absent ⇒ onboarding is inert
//                   (and getBurnDeposits is never consulted, so the indexer can never see a bundle
//                   without its verifier — which would throw).
//   getBurnDeposits: (optional) (txidsDisplay[]) => Promise<Map(txidDisplay → holder-traced bundle)> for
//                   any burn-deposit in the batch. Looked up by the burn's display txid (a bundle is bound
//                   to the burn tx, not a block height). Only consulted when burnDepositKit is wired. The
//                   lookup also covers burns an earlier batch recorded pending, so a bundle registered after
//                   the burn's block was attested still completes the deposit.
//   prove/submit as above. batchSize caps blocks per cycle (a huge backlog proves in chunks).
export function makeScanReflectionAttester({ deps, storage, prove, submit, getBlockTxs, getHeaders, genesisHeight, batchSize = 16, burnDepositKit, getBurnDeposits, listBurnDepositTxids, ethBundleSource, streamBlocks = false, streamWindow = 4 , chainBinding = null }) {
  // Pending burn-deposits whose bundle has been registered. Anyone can add a pending record with a junk 0x2B
  // envelope, so a batch looks up bundles only for records a listing says exist rather than one read per record.
  const norm = (t) => String(t).replace(/^0x/, '').toLowerCase();
  async function registeredPending(idx) {
    const pending = idx.pendingBurnTxids();
    if (!pending.length || !listBurnDepositTxids) return pending;
    const registered = new Set((await listBurnDepositTxids()).map(norm));
    return pending.filter((t) => registered.has(norm(t)));
  }

  const range = (from, to) => { const a = []; for (let h = from; h <= to; h++) a.push(h); return a; };
  // attestedHeight = the last block folded into the persisted snapshot; the next batch starts at
  // attestedHeight+1. Genesis: the pool resumes from GENESIS_REFLECTION_ANCHOR = block `genesisHeight`
  // (the last-reflected PRIOR block), so attestedHeight = genesisHeight and the first folded block is
  // genesisHeight+1 — whose prev_hash IS the anchor. The genesis prior state is seeded to height
  // genesisHeight (below) so its digest equals REFLECTION_RESUME_DIGEST (empty state @ genesisHeight),
  // matching the pool's knownReflectionDigest and the guest's `anchor_height == prior.height + 1`.
  const base = (genesisHeight | 0);
  const init = () => ({ snapshot: null, attestedHeight: base, tipHeight: base });

  // The tip may live in its own small record alongside the snapshot (storage.loadTip/saveTip). Whichever
  // is higher wins: ackJob writes tipHeight into the snapshot record, setTip writes only the small one.
  async function loadState() {
    const s = (await storage.load()) || init();
    if (storage.loadTip) {
      const t = await storage.loadTip();
      if (Number.isInteger(t) && t > s.tipHeight) s.tipHeight = t;
    }
    return s;
  }

  // Record the latest CONFIRMED (finality-buried) tip so cycles know how far to attest. Monotonic.
  //
  // The snapshot record holds the entire reflected Bitcoin state, so reading and rewriting it to move
  // one integer costs a full parse and re-serialise of that state — on every cron tick, per network.
  // When the storage layer offers a separate tip record, bump that instead and never touch the snapshot.
  async function setTip(height) {
    if (storage.loadTip && storage.saveTip) {
      const cur = await storage.loadTip();
      if (Number.isInteger(cur)) {
        if (height > cur) { await storage.saveTip(height); return height; }
        return cur;
      }
      // First call since the split: seed from the snapshot record once, then stay off it.
      const s = (await storage.load()) || init();
      const seeded = Math.max(height, s.tipHeight);
      await storage.saveTip(seeded);
      return seeded;
    }
    const s = await loadState();
    if (height > s.tipHeight) await storage.save({ ...s, tipHeight: height });
    return Math.max(height, s.tipHeight);
  }

  // Assemble the next un-attested block range into a prover input WITHOUT advancing the persisted
  // anchor (the relayer proves + submits, then acks). Returns null if caught up. The returned
  // `newSnapshot` is the post-batch canonical state ackJob will persist.
  async function assembleJob() {
    const s = await loadState();
    if (s.tipHeight <= s.attestedHeight) return null;
    const from = s.attestedHeight + 1;
    const to = Math.min(s.tipHeight, from + batchSize - 1);
    const heights = range(from, to);
    const idx = makeScanReflectionIndexer({ ...deps, burnDepositKit, swapBatchVk: SWAP_BATCH_VK });
    idx.load(s.snapshot);
    // Genesis (no persisted snapshot): seed the prior reflected height to the anchor block so the guest's
    // append-exactly check (anchor_height == prior.height + 1) holds and the prior digest equals the pool's
    // near-tip REFLECTION_RESUME_DIGEST (empty state @ genesisHeight). Later batches restore height from the
    // persisted snapshot, so this only affects the first job.
    if (!s.snapshot) idx.state().setHeight(base);
    // The digest of the state this batch builds ON — i.e. what the pool's knownReflectionDigest MUST equal
    // for the attest to land. Returned with the job so the prover can pre-flight it against the chain and
    // refuse to buy a proof that cannot possibly settle (see reflection-folder's drift guard).
    const priorDigest = idx.digest();
    const headers = await getHeaders(heights);
    let input;
    if (streamBlocks) {
      // STREAMING catch-up: fetch+fold+discard one block at a time (bounded to `streamWindow` in flight), so a
      // large backlog assembles in bounded memory instead of holding every block's txs. Requires no burn-deposit
      // kit (that needs all txids upfront) and a blocks-independent ethBundleSource (fixed Mode-B bundle). The
      // fold is byte-identical to the eager path — only block delivery differs. See assembleBlocks streaming arm.
      // Burn-deposit bundles are keyed by txid + rare (only for holder-submitted 0x2B provenance). Instead of
      // fetching all txids upfront (which would defeat streaming), populate this shared Map per block as each is
      // fetched — getRawBlock runs immediately before the indexer's txSpec, so a block's bundles are present when
      // its txs are specced. Empty for the common (no-bundle) catch-up.
      const burnDeposits = (burnDepositKit && getBurnDeposits) ? new Map() : undefined;
      // Bundles for burns recorded pending by earlier batches are fetched up front; the assembler completes them
      // after the block scan.
      if (burnDeposits) {
        const pendingTxids = await registeredPending(idx);
        const bd = pendingTxids.length ? await getBurnDeposits(pendingTxids, from - 1) : null;
        if (bd) for (const [k, v] of bd) burnDeposits.set(k, v);
      }
      const cache = new Map();
      const ensure = (i) => { if (i >= 0 && i < heights.length && !cache.has(i)) cache.set(i, getBlockTxs(heights[i])); };
      for (let i = 0; i < Math.min(streamWindow, heights.length); i++) ensure(i);
      const source = {
        blockCount: heights.length,
        getRawBlock: async (i) => {
          ensure(i);
          const blk = await cache.get(i);
          cache.delete(i); ensure(i + streamWindow);
          if (burnDeposits) {
            const bd = await getBurnDeposits((blk.txs || []).map((t) => t.txidDisplay), from - 1);
            if (bd) for (const [k, v] of bd) burnDeposits.set(k, v);
          }
          return blk;
        },
      };
      const modeB = ethBundleSource ? await ethBundleSource({ from, to, blocks: null }) : null;
      input = await idx.assembleBlocks(source, {
        headers, anchorHeight: from, burnDeposits,
        ethBundle: modeB && modeB.ethBundle, consumedSources: modeB && modeB.consumedSources,
      chainBinding,
      });
    } else {
      // Fetch blocks in small parallel chunks: fully sequential over the tunnel is too slow for a multi-block
      // catch-up (each block is 3 upstream hops), and fully concurrent spikes memory. A few in flight balances
      // latency vs peak RAM (the fold below holds them all regardless, so the chunk only bounds the fetch burst).
      const blocks = [];
      const FETCH_CHUNK = 4;
      for (let i = 0; i < heights.length; i += FETCH_CHUNK) {
        const part = await Promise.all(heights.slice(i, i + FETCH_CHUNK).map((h) => getBlockTxs(h)));
        for (const b of part) blocks.push(b);
      }
      // Holder-submitted TAC burn-deposit / cmint-deposit provenance bundles for any 0x2B burn of a
      // pre-existing note in this range, keyed by the burn's display txid. Only consulted when a kit is
      // wired (the indexer throws if handed a bundle without one), so this stays a no-op pre-onboarding.
      let burnDeposits;
      if (burnDepositKit && getBurnDeposits) {
        const txids = blocks.flatMap((b) => (b.txs || []).map((t) => t.txidDisplay));
        burnDeposits = await getBurnDeposits([...new Set([...txids, ...(await registeredPending(idx))])], from - 1);
      }
      // Mode-B reverse reflection (ETH→BTC): if an eth-reflection bundle source is wired, fetch the eth
      // proof's attested sets for this range (+ the resolved Bitcoin source note per consumed ν) and assemble
      // a mode_b=1 batch — each 0x65 mint onboards against the crossOutSet, the consumed-ν fast lane folds.
      // Absent (the steady state until Mode-B is operational) ⇒ a forward batch (mode_b=0; every 0x65 skips).
      const modeB = ethBundleSource ? await ethBundleSource({ from, to, blocks }) : null;
      input = await idx.assembleBlocks(blocks, {
        headers, anchorHeight: from, burnDeposits,
        ethBundle: modeB && modeB.ethBundle, consumedSources: modeB && modeB.consumedSources,
      chainBinding,
      });
    }
    // Fail-loud: if any tx in this range carries a Tacit envelope the guest folds but the JS scan does
    // not yet mirror (AMM / cBTC / farm / bid / protocol-fee / crossout / AXFER), the guest would read
    // fold witnesses this assembler never emitted — the prover input is desynced. REFUSE rather than
    // attest a divergent root; the relay halts at this height until the fold is mirrored (the guest is
    // authoritative, so this is liveness, never soundness — no wrong attestation can land).
    if (input.unsupportedEnvelopes && input.unsupportedEnvelopes.length) {
      const ops = [...new Set(input.unsupportedEnvelopes.map((u) => '0x' + (u.opcode || 0).toString(16)))].join(',');
      throw new Error(`reflection: ${input.unsupportedEnvelopes.length} unmirrored guest-folded envelope(s) [${ops}] in blocks ${from}..${to}; mirror the fold in the JS scan before attesting (fail-loud, no divergent attestation)`);
    }
    // A 0x2B burn of a non-live note with no registered provenance bundle is recorded in the pending set, in the guest
    // and here, so it never blocks the batch: anyone can broadcast a junk 161-byte 0x2B envelope, and a real burn
    // registered later completes in whichever batch first sees its bundle. The unregistered burns of this range are
    // returned for alerting, with the completions this batch folds.
    const unresolved = input.unresolvedBurnDeposits || [];
    return {
      jobId: input.newDigest, priorDigest, input, newSnapshot: idx.snapshot(), attestedTo: to, blocks: heights.length,
      pendingBurnDeposits: unresolved, completedBurnDeposits: (input.depositCompletions || []).map((c) => ({ burnedTxid: c.burnedTxid, burnedVout: c.burnedVout })),
    };
  }

  // Advance the attested anchor after the on-chain attestation lands. Idempotent: a stale ack
  // (attestedTo <= attestedHeight) is a no-op, so a retried submit can't skip or re-fold blocks.
  async function ackJob(attestedTo, newSnapshot) {
    const s = await loadState();
    const advanced = attestedTo > s.attestedHeight;
    if (advanced) await storage.save({ snapshot: newSnapshot, attestedHeight: attestedTo, tipHeight: s.tipHeight });
    return { attestedHeight: Math.max(attestedTo, s.attestedHeight), advanced };
  }

  // All-in-worker synchronous model (prove + submit via injected URLs). No-op if caught up.
  async function runCycle() {
    const job = await assembleJob();
    if (!job) return null;
    const { vkey, publicValues, proofBytes } = await prove(job.input);
    const txHash = await submit(publicValues, proofBytes);
    await ackJob(job.attestedTo, job.newSnapshot);
    return { txHash, vkey, newDigest: job.input.newDigest, attestedTo: job.attestedTo, blocks: job.blocks };
  }

  return { setTip, assembleJob, ackJob, runCycle, loadState };
}

// Worker-facing factory for the FULL-SCAN attester. Wires getBlockTxs/getHeaders to esplora and
// the canonical-state snapshot to KV. Returns null if reflection attestation isn't configured.
//   env.REFLECTION_ATTEST          = '1'                — enable flag
//   env.REGISTRY_KV                                     — snapshot persistence
//   env.REFLECTION_GENESIS_HEIGHT                       — the first block the reflection scans
//                                                         (= GENESIS_REFLECTION_ANCHOR's height)
// `classifyTx({ txid, vin, vout, rawHex }) => null | {type:'cxfer',assetId,commitments[],kernelSig,
// rangeProof} | {type:'burn',assetId,nullifier,dest}` classifies a tx's confidential envelope, injected so the attester
// stays decode-agnostic. It MUST mirror the guest's reflect.rs classification (the guest re-parses txData
// + is authoritative), and a cxfer MUST surface its kernelSig (64-byte BIP-340 hex) + rangeProof (BP+ hex)
// — the assembler re-verifies value conservation before folding the outputs (REFLECT-1). The worker wires
// `classifyConfidentialTx` (dapp/burn-deposit-bitcoin.js), a faithful cxfer-core port (NOT the lossy
// decodeCXferBppPayload, which drops the kernel sig + range proof). `api` is the esplora text fetcher.
//
// `burnDepositKit` (optional) enables the scan-free TAC burn-deposit / cmint-deposit onboarding (a 0x2B
// burn of a PRE-existing, never-reflected note). It is the raw-tx Bitcoin tooling the scan indexer needs
// — { mirror: makeBurnDepositProvenance(...), assembler: makeBurnDepositAssembler(...),
// parseEtchAnchor(etchTxHex, assetHex), computeTxidInternal(txHex) } (see makeScanReflectionIndexer).
// Absent ⇒ onboarding stays inert (holder bundles are never read, the indexer never throws). When wired,
// holders submit their traced provenance bundle under reflection:burndep:{net}:{burnTxidDisplay}.
export function buildScanReflectionAttester(env, { deps, api, apiRawBytes, network, classifyTx, burnDepositKit, ethBundleSource }) {
  if (!env || env.REFLECTION_ATTEST !== '1' || !env.REGISTRY_KV) return null;
  const genesisHeight = parseInt(env.REFLECTION_GENESIS_HEIGHT || '0', 10);
  if (!genesisHeight) return null;
  // Build the real TAC burn-deposit / cmint-deposit onboarding kit from the same crypto deps (so the worker
  // can assemble a holder-traced provenance bundle into the prover input). Overridable for tests; default is
  // the production kit. Onboarding stays inert until a holder actually submits a bundle (getBurnDeposits).
  const kit = burnDepositKit || makeBurnDepositKit(deps);
  const KEY = `reflection:scan:${network}`;
  // TIP_KEY is deliberately separate from KEY: the cron bumps the tip every 5 minutes per network, and
  // KEY holds the whole reflected state, so folding the tip into it would parse and rewrite that state
  // on every tick.
  const TIP_KEY = `reflection:tip:${network}`;
  const storage = {
    load: async () => { const s = await env.REGISTRY_KV.get(KEY); return s ? JSON.parse(s) : null; },
    save: async (s) => env.REGISTRY_KV.put(KEY, JSON.stringify(s)),
    loadTip: async () => { const t = await env.REGISTRY_KV.get(TIP_KEY); const n = t == null ? NaN : parseInt(t, 10); return Number.isInteger(n) ? n : null; },
    saveTip: async (h) => env.REGISTRY_KV.put(TIP_KEY, String(h | 0)),
  };
  // Holder-traced burn-deposit bundles, keyed by the burn tx's display txid. Returns the subset present
  // for this batch's txids. Only invoked by the attester when burnDepositKit is wired.
  const burnDepKey = (txidDisplay) => `reflection:burndep:${network}:${txidDisplay.replace(/^0x/, '')}`;
  // Shared with POST /reflection/burndep/check (worker/src/index.js) so a pre-flight check and the real
  // fold can never disagree about what "admitted" means. See burndep-admission.js's own header comment for
  // why this also owns the persistent header-chain cache (a submitted bundle physically cannot carry a
  // chain long enough to reach from TAC's etch to the current tip — see index.js's MAX_HEADERS).
  const admission = makeBurndepAdmission({ env, api, apiRawBytes, network, kit, deps });
  const { enrichBurnDeposit, buildOrExtendProvHeaders } = admission;
  // A bad bundle must never be able to stop the lane.
  //
  // This is called with EVERY txid of every block in the scan range, and a bundle is registered by an
  // unauthenticated POST keyed by a caller-chosen txid — so anyone can broadcast a cheap Bitcoin tx and
  // attach a bundle to it. Without this catch, one malformed record (a provenance entry carrying neither
  // blockHash nor blockHeight is enough) throws out of assembleJob, /reflection/job 500s, and since the guest
  // requires anchor_height == prior + 1 the cursor can never advance past that block. There is no route that
  // deletes a burndep row, so recovery would mean direct database access. That is a permanent, remote,
  // unauthenticated halt of Bitcoin->Ethereum reflection reachable for the price of one Bitcoin transaction.
  //
  // Skipping is not a compromise here, it is the already-correct behaviour: a burn whose bundle is missing or
  // unusable stays pending and completes in any later batch that has a good one. So the worst case for an
  // honest holder is a delay, and the worst case for an attacker is that their own junk is ignored.
  const getBurnDeposits = async (txidsDisplay, anchorHeight) => {
    const map = new Map();
    for (const txid of txidsDisplay) {
      const raw = await env.REGISTRY_KV.get(burnDepKey(txid));
      if (!raw) continue;
      try {
        map.set(txid, await buildOrExtendProvHeaders(await enrichBurnDeposit(JSON.parse(raw)), anchorHeight));
      } catch (e) {
        console.log(`[reflection] burn-deposit bundle for ${txid} is unusable, skipping it (stays pending): ${String(e && e.message || e).slice(0, 200)}`);
      }
    }
    return map;
  };
  const prove = async (input) => {
    const r = await fetch(env.REFLECTION_PROVE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    if (!r.ok) throw new Error('reflection prove failed: ' + r.status);
    return r.json();
  };
  const submit = async (publicValues, proofBytes) => {
    if (!env.REFLECTION_SUBMIT_URL) return null;
    const r = await fetch(env.REFLECTION_SUBMIT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicValues, proofBytes }) });
    return r.ok ? (await r.json()).txHash : null;
  };
  const getHeaders = async (heights) => Promise.all(heights.map(async (h) => {
    const hash = (await api(env, `/block-height/${h}`, {}, network)).trim();
    return '0x' + (await api(env, `/block/${hash}/header`, {}, network)).trim();
  }));
  // EVERY tx of the block (in order) with its raw bytes, vins, and protocol classification — the
  // full-scan completeness input. For the pilot's small blocks the per-tx fetch is fine; a mainnet
  // build would page /block/{hash}/txs (25/page) and /block/{hash}/raw instead.
  // Split a raw Bitcoin block into its txs locally — see bitcoin-block-parse.js. A mainnet block is
  // thousands of txs; fetching each individually (2 requests/tx) is far too slow/expensive, so we pull
  // /block/<hash>/raw ONCE (immutable, edge-cached) and walk the bytes instead.
  const _dsha = (b) => deps.sha256(deps.sha256(b));
  const getBlockTxs = async (h) => {
    const hash = (await api(env, `/block-height/${h}`, {}, network)).trim();
    const blockBytes = await apiRawBytes(env, `/block/${hash}/raw`, network);
    const txs = splitBlockTxs(blockBytes, _dsha).map((t) => ({
      ...t, decode: classifyTx ? classifyTx({ txid: t.txidDisplay, rawHex: t.rawHex }) : null,
    }));
    return { txs };
  };
  // batchSize caps blocks per job. The scan target is capped at the relay's matured tip (cron), so the
  // backlog per cycle is bounded by how far the relay is advanced. A batch does NOT have to reach that
  // matured height: the pool anchors a batch on exact chain continuity and accepts a tip well below the
  // matured anchor (REFLECTION_MAX_LAG), so a backlog closes as a sequence of ordinary batches, each landing
  // on-chain and advancing the cursor before the next is assembled — no single job ever has to span a whole
  // outage. Each folded block carries every tx's raw bytes into the prover input (the guest recomputes txids
  // + the block merkle), so peak heap scales with the batch — a large multi-block fold of full mainnet
  // blocks is what exhausts the worker's budget, which is why the cap stays small rather than growing to
  // meet a backlog. Hard-cap at MAX_BATCH so no env value can drive the worker back into an OOM;
  // REFLECTION_BATCH_SIZE tunes within it.
  const MAX_BATCH = 6;
  // OFF-WORKER CATCH-UP (opt-in, REFLECTION_STREAM=1): the streaming assembler folds one block at a time in
  // bounded memory, so a large backlog can be assembled off the worker without the eager-fold OOM the MAX_BATCH
  // cap guards against. In that mode the cap lifts to REFLECTION_MAX_BATCH (proving cycle-limit is the real
  // bound, not worker heap). Production (no flag) is untouched: eager fold, hard cap 6.
  const streamBlocks = env.REFLECTION_STREAM === '1';
  const cap = streamBlocks ? Math.max(1, parseInt(env.REFLECTION_MAX_BATCH || '64', 10)) : MAX_BATCH;
  const batchSize = Math.min(cap, Math.max(1, parseInt(env.REFLECTION_BATCH_SIZE || '6', 10)));
  const listBurnDepositTxids = async () => {
    const prefix = `reflection:burndep:${network}:`;
    const out = [];
    let cursor;
    do {
      const page = await env.REGISTRY_KV.list({ prefix, cursor });
      for (const k of page.keys) out.push(k.name.slice(prefix.length));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out;
  };
  const att = makeScanReflectionAttester({ deps, storage, prove, submit, getBlockTxs, getHeaders, genesisHeight, batchSize, burnDepositKit: kit, getBurnDeposits, listBurnDepositTxids, ethBundleSource, streamBlocks , chainBinding: env.REFLECTION_CHAIN_BINDING || null });
  // Exposed so callers outside the fold path (the cron's header-cache warm-up, POST /reflection/burndep/check)
  // can reuse the exact same admission logic + blockWitness cache without constructing a second kit/instance.
  return { ...att, admission };
}
