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
// block-level merkle data), not the minimal {tx, blockHash} shape /reflection/burndep's registration door
// actually requires (the server fills in the rest automatically at fold time via enrichBurnDeposit/
// blockWitness — see reflection-attest.js). Building the full shape client-side costs more esplora calls but
// lets the caller run the SAME local verification the scratchpad scripts that built every real burn already
// do (re-deriving the guest's own checks before ever submitting) — the safer of the two valid shapes to
// return, matching how every burn that has actually succeeded was actually built.

import { classifyConfidentialTx } from '../../dapp/burn-deposit-bitcoin.js';
import { splitBlockTxs } from './bitcoin-block-parse.js';

const stripHexPrefix = (h) => String(h).replace(/^0x/, '');
const withHexPrefix = (h) => (String(h).startsWith('0x') ? String(h) : '0x' + h);
const hexToBytes = (h) => { const s = stripHexPrefix(h); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; };
const reverseBytes = (b) => Uint8Array.from(b).reverse();

// outpointKey(txidDisplayHex-or-0x, vout) — the same function `dapp/confidential-pool.js`'s makeConfidentialPool
// exports (keccak(txid ‖ vout_le), mirroring cxfer-core::outpoint_key). Injected so this module never has an
// opinion about which secp/keccak/sha256 implementation the caller is already using.
export function makeLiveBurnDepositTracer({ env, apiText, apiRawBytes, network, outpointKey, sha256 }) {
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

  // Resolve ONE input's commitment: fetch its producing tx, classify it, read back the commitment at the
  // spent vout. A cxfer's own inputs are not always all confidential — a P2WPKH-homed note's reveal needs a
  // separate, leading non-confidential funding input to pay for the reveal tx (the assembler's own `inputSkip`
  // field exists for exactly this — see buildBurnDepositStatic's comment). That input classifies as `null`
  // (no envelope, correctly, since it isn't a confidential input) and has no commitment to resolve. Telling it
  // apart from a genuine leaf input (etch/cmint, which does need a commitment, via a different parser than
  // cxfer's) needs inspecting the input's actual script type, which this function does not do. It throws on
  // both cases rather than guess — safe (never resolves the wrong commitment), but a DAG containing either
  // case cannot be traced automatically until this is extended. See ops/DESIGN-burndep-live-tracer.md.
  // Scope: plain cxfer (opcode 0x24/0x25/…) only, not cxfer_bound (0x39, deployment-bound assets) or the
  // AMM/farm/bid fold types classifyConfidentialTx also recognizes. TAC — the only asset burn-deposit has
  // moved so far — folds unbound (SPEC.md §6.2), so its own lineage should never contain a bound hop; a DAG
  // that does throws here rather than silently mis-resolving it.
  async function resolveInputCommitment(prevTxidDisplay, prevVout) {
    const { decode } = await fetchTx(prevTxidDisplay);
    if (!decode || decode.type !== 'cxfer') {
      throw new Error(`burndep-live-tracer: input ${prevTxidDisplay}:${prevVout} is not a plain cxfer output `
        + `(got ${decode ? decode.type : 'unclassified'}) — either a non-confidential funding input (inputSkip) `
        + `or a genuine leaf (etch/cmint); neither is implemented yet, see ops/DESIGN-burndep-live-tracer.md`);
    }
    const i = decode.vouts.indexOf(prevVout);
    if (i === -1) throw new Error(`burndep-live-tracer: ${prevTxidDisplay} has no cxfer output at vout ${prevVout}`);
    return decode.commitments[i];
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
    const [{ coinbase, blockTxids, blockWtxids }, inputs] = await Promise.all([
      fetchBlockWitness(blockHash),
      Promise.all((json.vin || []).map(async (v) => ({
        prevTxid: withHexPrefix(v.txid),
        prevVout: v.vout,
        commitment: await resolveInputCommitment(v.txid, v.vout),
      }))),
    ]);
    // Seed every one of THIS tx's own inputs into `seen` so the tracer's next hop (which will call
    // getCxferByOutput with outpointKey(inp.prevTxid, inp.prevVout), computed inside burn-deposit-tracer.js
    // itself) resolves to a plaintext txid/vout this module already knows, without needing to invert a hash.
    for (const inp of inputs) seed(inp.prevTxid, inp.prevVout);
    // This tx's position within its own block, by matching internal-order txid bytes (blockTxids is already
    // in that form, per bitcoin-block-parse.js) — needed for witnessPath's merkle-siblings index.
    const txidBytes = reverseBytes(hexToBytes(txidDisplay));
    const index = blockTxids.findIndex((t) => t.length === txidBytes.length && t.every((b, i2) => b === txidBytes[i2]));
    if (index < 0) throw new Error(`burndep-live-tracer: ${txidDisplay} not found in its own reported block ${blockHash} — reorg mid-trace?`);
    return {
      txid: withHexPrefix(txidDisplay),
      tx: withHexPrefix(hex),
      inputs,
      outputs: decode.vouts.map((v, i) => ({ vout: v, commitment: decode.commitments[i] })),
      rangeProof: decode.rangeProof,
      kernelSig: decode.kernelSig,
      blockTxids,
      blockWtxids,
      coinbase,
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
export async function traceBurnDepositProvenance({ env, apiText, apiRawBytes, network, outpointKey, sha256, trace, note, leaves, maxDepth } = {}) {
  if (typeof trace !== 'function') throw new Error('traceBurnDepositProvenance: trace required (dapp/burn-deposit-tracer.js makeBurnDepositTracer({outpointKey}).trace)');
  if (!note || note.txid == null || note.vout == null) throw new Error('traceBurnDepositProvenance: note {txid, vout} required');
  if (!Array.isArray(leaves) || !leaves.length) throw new Error('traceBurnDepositProvenance: at least one leaf (the asset\'s C_0) required');
  const live = makeLiveBurnDepositTracer({ env, apiText, apiRawBytes, network, outpointKey, sha256 });
  const noteOutpoint = live.seed(note.txid, note.vout);
  const leafOutpoints = leaves.map((l) => live.seed(l.txid, l.vout));
  const cxfers = await trace({ getCxferByOutput: live.getCxferByOutput, noteOutpoint, leafOutpoints, maxDepth });
  return { cxfers, live }; // `live` exposed so a caller can inspect its tx/block caches (e.g. for a local re-verify) without re-fetching
}
