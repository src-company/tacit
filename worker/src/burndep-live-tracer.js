// Live implementation of dapp/burn-deposit-tracer.js's `getCxferByOutput` dependency — the piece that never
// existed (see ops/DESIGN-burndep-live-tracer.md for the full design rationale). Every burn-deposit that has
// actually landed (1000 TAC, 100 TAC, 250k, 1M) was built by hand from pre-computed JSON files; this is the
// automated equivalent, built from public esplora data alone.
//
// classifyConfidentialTx only decodes what a transaction PRODUCES (its own output commitments + their real
// vouts). It says nothing about which commitment each of the transaction's INPUTS spent — that's only knowable
// by resolving the input's own producing transaction, one hop further back. This module does exactly that one
// hop per input; the recursion ACROSS hops is burn-deposit-tracer.js's own job (its outer queue/loop), not
// this module's.
//
// Returns the FULL shape burn-deposit-tracer.js's own doc comment specifies (tx + inputs + outputs +
// block-level merkle data) by default — lets a caller run the SAME local verification the scratchpad scripts
// that built every real burn already do (re-deriving the guest's own checks before ever submitting). The
// block-level portion of that shape costs a full raw-block download+parse per hop, on top of the per-tx
// fetches, so a caller that only needs the minimal {tx, blockHash} shape /reflection/burndep's registration
// door actually requires (the server fills in the rest automatically at fold time via enrichBurnDeposit/
// blockWitness — see reflection-attest.js) can skip it via `fullBlockWitness: false` — the only lever that
// shortens total trace time, since a DAG walk is inherently sequential (each hop's inputs are unknown until
// the hop before it resolves). traceBurnDepositProvenance, the one real caller today, defaults to skipping it.

import { classifyConfidentialTx, extractTaprootEnvelope, parseCetch } from '../../dapp/burn-deposit-bitcoin.js';
import { splitBlockTxs } from './bitcoin-block-parse.js';

const stripHexPrefix = (h) => String(h).replace(/^0x/, '');
const withHexPrefix = (h) => (String(h).startsWith('0x') ? String(h) : '0x' + h);
const hexToBytes = (h) => { const s = stripHexPrefix(h); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; };
const reverseBytes = (b) => Uint8Array.from(b).reverse();

// outpointKey(txidDisplayHex-or-0x, vout) — the same function `dapp/confidential-pool.js`'s makeConfidentialPool
// exports (keccak(txid ‖ vout_le), mirroring cxfer-core::outpoint_key). Injected so this module never has an
// opinion about which secp/keccak/sha256 implementation the caller is already using.
export function makeLiveBurnDepositTracer({ env, apiText, apiRawBytes, network, outpointKey, sha256, fullBlockWitness = true }) {
  if (typeof apiText !== 'function' || typeof apiRawBytes !== 'function') throw new Error('burndep-live-tracer: apiText and apiRawBytes required');
  if (typeof outpointKey !== 'function') throw new Error('burndep-live-tracer: outpointKey required (from makeConfidentialPool)');
  if (!env) throw new Error('burndep-live-tracer: env required (apiText/apiRawBytes read env.MAINNET_API/SIGNET_API for upstream selection)');
  const dsha256 = (b) => sha256(sha256(b));
  const fetchText = (path) => apiText(env, path, {}, network);
  const fetchRawBytes = (path) => apiRawBytes(env, path, network);

  // Per-txid cache: a producing tx is fetched once whether the tracer reaches it via a direct DAG hop or via
  // an input-commitment resolution one hop earlier (both paths converge on the same txid for any tx with more
  // than one confidential output feeding the lineage).
  const txCache = new Map(); // txidDisplay (no 0x, lowercase) -> { hex, json, decode }
  async function fetchTx(txidDisplay) {
    const key = stripHexPrefix(txidDisplay).toLowerCase();
    let rec = txCache.get(key);
    if (rec) return rec;
    const [hex, jsonText] = await Promise.all([
      fetchText(`/tx/${key}/hex`),
      fetchText(`/tx/${key}`),
    ]);
    const json = JSON.parse(jsonText);
    const decode = classifyConfidentialTx(withHexPrefix(hex.trim()));
    rec = { hex: hex.trim(), json, decode };
    txCache.set(key, rec);
    return rec;
  }

  // Per-block cache: coinbase + every tx's wtxid, needed once per block regardless of how many DAG hops it
  // contains. Mirrors reflection-attest.js's own blockWitnessCache exactly (same shape), but this module keeps
  // its own copy rather than importing reflection-attest.js's internal closure — this is liveness tooling with
  // no business depending on, or being depended on by, the live scanning path.
  const blockCache = new Map(); // blockHash (no 0x) -> { coinbase, blockTxids: [bytes], blockWtxids: [bytes] }
  async function fetchBlockWitness(blockHash) {
    const key = stripHexPrefix(blockHash).toLowerCase();
    let rec = blockCache.get(key);
    if (rec) return rec;
    const raw = await fetchRawBytes(`/block/${key}/raw`);
    const parsed = splitBlockTxs(raw, dsha256);
    rec = {
      coinbase: parsed[0].rawHex,
      blockTxids: parsed.map((t) => reverseBytes(hexToBytes(t.txidDisplay))),
      blockWtxids: parsed.map((t) => reverseBytes(hexToBytes(t.wtxidDisplay))),
    };
    blockCache.set(key, rec);
    return rec;
  }

  // Classify ONE input: fetch its producing tx and work out what (if anything) it commits. A cxfer's own
  // inputs are not always all confidential — a P2WPKH-homed note's reveal needs a separate, leading
  // non-confidential funding input to pay for the reveal tx (the assembler's own `inputSkip` field exists
  // for exactly this — see buildBurnDepositStatic's comment). That input's producing tx carries no envelope
  // at all, which is exactly how classifyConfidentialTx reports a genuine leaf too (it only recognizes
  // cxfer/burn/AMM fold types, not CETCH/CMINT) — so a `null` decode is checked further here rather than
  // treated as one specific case: try CETCH (the asset's own supply note, opcode 0x21) before concluding
  // there is no envelope at all and this is a plain funding input.
  // Scope: plain cxfer (opcode 0x24/0x25/…) and CETCH leaves only — not CMINT (issuer-authorized top-up
  // mints, a separate provenance branch the assembler tracks via its own `cmints[]` array, not through a
  // cxfer's inputs) and not cxfer_bound (0x39, deployment-bound assets) or the AMM/farm/bid fold types
  // classifyConfidentialTx also recognizes. TAC — the only asset burn-deposit has moved so far — is
  // non-mintable (fixed supply, confirmed via its own /assets/:id record) and folds unbound (SPEC.md §6.2),
  // so its lineage should never contain a cmint or a bound hop; a DAG that does throws rather than silently
  // mis-resolving it.
  async function classifyInput(prevTxidDisplay, prevVout) {
    const { hex, decode } = await fetchTx(prevTxidDisplay);
    if (decode && decode.type === 'cxfer') {
      const i = decode.vouts.indexOf(prevVout);
      if (i === -1) throw new Error(`burndep-live-tracer: ${prevTxidDisplay} has no cxfer output at vout ${prevVout}`);
      return { kind: 'cxfer', commitment: decode.commitments[i] };
    }
    if (!decode) {
      const envHex = extractTaprootEnvelope(hex);
      if (envHex) {
        const cetch = parseCetch(envHex);
        if (cetch) {
          if (prevVout !== 0) throw new Error(`burndep-live-tracer: ${prevTxidDisplay} is a CETCH but was spent at vout ${prevVout}, not 0`);
          return { kind: 'cetch', commitment: cetch.c0Compressed };
        }
        throw new Error(`burndep-live-tracer: ${prevTxidDisplay}:${prevVout} carries an envelope this module does not `
          + `recognize as a resolvable leaf (opcode 0x${envHex.slice(2, 4)}) — likely a CMINT or bound-asset hop, `
          + `neither implemented; see ops/DESIGN-burndep-live-tracer.md`);
      }
      return { kind: 'funding' }; // no envelope at all — a plain, non-confidential input paying for the reveal
    }
    throw new Error(`burndep-live-tracer: input ${prevTxidDisplay}:${prevVout} classified as '${decode.type}', `
      + 'which this module does not resolve a commitment for');
  }

  // The dapp/burn-deposit-tracer.js dependency itself. `op` is always an outpointKey hash the caller either
  // seeded (the note being bridged) or that THIS function itself produced from a prior tx's real vin data —
  // never an arbitrary hash from nowhere — so `seen` (populated by every call) always has a plaintext answer.
  const seen = new Map(); // outpointKeyHex -> { txidDisplay, vout }
  function seed(txidDisplay, vout) {
    const key = outpointKey(withHexPrefix(txidDisplay), vout);
    seen.set(key.toLowerCase(), { txidDisplay: withHexPrefix(txidDisplay), vout });
    return key;
  }

  async function getCxferByOutput(op) {
    const plain = seen.get(String(op).toLowerCase());
    if (!plain) throw new Error(`burndep-live-tracer: getCxferByOutput called with an outpoint this tracer never seeded or discovered: ${op}`);
    const { txidDisplay, vout } = plain;
    const { hex, json, decode } = await fetchTx(txidDisplay);
    if (!decode || decode.type !== 'cxfer') return null; // not produced by a cxfer — tracer treats as unprovable unless it's a leaf
    if (!decode.vouts.includes(vout)) return null;
    if (!json.status || !json.status.confirmed) throw new Error(`burndep-live-tracer: ${txidDisplay} is not yet confirmed`);
    const blockHash = json.status.block_hash;
    const vins = json.vin || [];
    // fetchBlockWitness downloads and parses the FULL raw block (every tx in it) — real bandwidth/CPU cost per
    // hop, needed only for the merkle-proof fields (blockTxids/blockWtxids/coinbase/index). The minimal
    // /reflection/burndep registration shape needs none of those, only blockHash — already free on `json`
    // above — so a caller building that shape skips this fetch entirely via `fullBlockWitness: false`. A DAG
    // this deep is sequential by nature (each hop's inputs are unknown until the hop before it resolves), so
    // trimming per-hop cost is the only lever that shortens the total trace time.
    const [blockWitness, classified] = await Promise.all([
      fullBlockWitness ? fetchBlockWitness(blockHash) : null,
      Promise.all(vins.map((v) => classifyInput(v.txid, v.vout))),
    ]);
    // Funding inputs (assembler's `inputSkip`) are, by construction, the LEADING ones — see classifyInput's
    // comment. A 'funding' classification after a real one is not a shape this reveal pattern produces, so
    // it's treated as an anomaly rather than silently included or silently dropped.
    let inputSkip = 0;
    while (inputSkip < classified.length && classified[inputSkip].kind === 'funding') inputSkip++;
    for (let i = inputSkip; i < classified.length; i++) {
      if (classified[i].kind === 'funding') {
        throw new Error(`burndep-live-tracer: ${txidDisplay} has a non-confidential input at index ${i}, `
          + `after a confidential one at a lower index — funding inputs are expected to be leading only`);
      }
    }
    const inputs = vins.slice(inputSkip).map((v, i) => ({
      prevTxid: withHexPrefix(v.txid), prevVout: v.vout, commitment: classified[inputSkip + i].commitment,
    }));
    // Seed every one of THIS tx's own REAL inputs into `seen` so the tracer's next hop (which will call
    // getCxferByOutput with outpointKey(inp.prevTxid, inp.prevVout), computed inside burn-deposit-tracer.js
    // itself) resolves to a plaintext txid/vout this module already knows, without needing to invert a hash.
    // Funding inputs are never seeded: nothing should ever ask this tracer to resolve one further.
    for (const inp of inputs) seed(inp.prevTxid, inp.prevVout);
    let index;
    if (blockWitness) {
      // This tx's position within its own block, by matching internal-order txid bytes (blockTxids is already
      // in that form, per bitcoin-block-parse.js) — needed for witnessPath's merkle-siblings index.
      const txidBytes = reverseBytes(hexToBytes(txidDisplay));
      index = blockWitness.blockTxids.findIndex((t) => t.length === txidBytes.length && t.every((b, i2) => b === txidBytes[i2]));
      if (index < 0) throw new Error(`burndep-live-tracer: ${txidDisplay} not found in its own reported block ${blockHash} — reorg mid-trace?`);
    }
    return {
      txid: withHexPrefix(txidDisplay),
      tx: withHexPrefix(hex),
      inputs,
      inputSkip,
      outputs: decode.vouts.map((v, i) => ({ vout: v, commitment: decode.commitments[i] })),
      rangeProof: decode.rangeProof,
      kernelSig: decode.kernelSig,
      // blockHash alongside the full merkle-proof data: a caller assembling a MINIMAL /reflection/burndep
      // registration bundle (which only needs {tx, blockHash|blockHeight} per hop — the server enriches the
      // rest at fold time, see reflection-attest.js's enrichBurnDeposit) doesn't need blockTxids/blockWtxids/
      // coinbase/index at all, but does need this.
      blockHash,
      blockTxids: blockWitness && blockWitness.blockTxids,
      blockWtxids: blockWitness && blockWitness.blockWtxids,
      coinbase: blockWitness && blockWitness.coinbase,
      index,
    };
  }

  return { getCxferByOutput, seed, outpointKeyOf: (txidDisplay, vout) => outpointKey(withHexPrefix(txidDisplay), vout) };
}

// Top-level entry point: given a note's own outpoint and the asset's supply leaf(ves), produce the full
// provenance DAG (dapp/burn-deposit-tracer.js's own `trace()` output) ready for
// dapp/burn-deposit-assembler.js's buildBurnDepositStatic. Ties makeLiveBurnDepositTracer (this file) to
// makeBurnDepositTracer (the existing, tested DAG walk) — neither needs the other to change.
//   note        : { txid, vout } — display-hex txid, the note being bridged
//   leaves      : [{ txid, vout }, ...] — the asset's C_0 (and any authorized cmint reveals); at least one
//                 required, or every lineage throws as unprovable
export async function traceBurnDepositProvenance({ env, apiText, apiRawBytes, network, outpointKey, sha256, trace, note, leaves, maxDepth = 256, fullBlockWitness = false } = {}) {
  if (typeof trace !== 'function') throw new Error('traceBurnDepositProvenance: trace required (dapp/burn-deposit-tracer.js makeBurnDepositTracer({outpointKey}).trace)');
  if (!note || note.txid == null || note.vout == null) throw new Error('traceBurnDepositProvenance: note {txid, vout} required');
  if (!Array.isArray(leaves) || !leaves.length) throw new Error('traceBurnDepositProvenance: at least one leaf (the asset\'s C_0) required');
  const live = makeLiveBurnDepositTracer({ env, apiText, apiRawBytes, network, outpointKey, sha256, fullBlockWitness });
  const noteOutpoint = live.seed(note.txid, note.vout);
  const leafOutpoints = leaves.map((l) => live.seed(l.txid, l.vout));
  // trace()'s own contract (dapp/burn-deposit-tracer.js, unit-tested against an in-memory mock) is a
  // SYNCHRONOUS getCxferByOutput — tests/tac-bridge-bundle.mjs and tests/tac-bridge-provenance-dag.mjs already
  // establish the pattern for a real, network-backed producer: resolve the whole DAG with the async fetcher
  // first, then hand trace() a synchronous lookup over the already-resolved graph. live.getCxferByOutput does
  // a real esplora round-trip per hop, so it cannot be passed to trace() directly.
  const leafSet = new Set(leafOutpoints);
  const graph = new Map();
  const queue = [noteOutpoint];
  const queued = new Set(queue);
  let steps = 0;
  while (queue.length) {
    if (++steps > maxDepth) throw new Error('burn-deposit trace: provenance exceeded maxDepth (' + maxDepth + ')');
    const op = queue.shift();
    if (leafSet.has(op) || graph.has(op)) continue;
    const cx = await live.getCxferByOutput(op);
    graph.set(op, cx || null);
    if (cx) {
      for (const inp of cx.inputs) {
        const inOp = outpointKey(inp.prevTxid, inp.prevVout);
        if (!leafSet.has(inOp) && !queued.has(inOp)) { queue.push(inOp); queued.add(inOp); }
      }
    }
  }
  const cxfers = await trace({ getCxferByOutput: (op) => graph.get(op) || null, noteOutpoint, leafOutpoints, maxDepth });
  return { cxfers, live }; // `live` exposed so a caller can inspect its tx/block caches (e.g. for a local re-verify) without re-fetching
}
