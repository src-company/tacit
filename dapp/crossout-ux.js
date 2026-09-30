// Orchestrates a TAC cross-out bridge (Ethereum -> Bitcoin) end to end: settle a confidential note as a
// bridge_burn (records a claim on Ethereum), wait for the reflection worker's eth-state view to cover that
// block, then mint the Bitcoin-side note via a commit/reveal T_CROSSOUT_MINT envelope. Wires together two
// already-independent, already-proven pieces -- the confidential pool's own crossOut (dapp/confidential-pool-ux.js,
// settled + corroborated against mainnet 2026-07-16/17) and dapp/crossout-mint-reveal.js (the Bitcoin-side
// builder, extracted from the same proof's tools/build-crossout-mint.mjs) -- into one resumable state
// machine, journalled so a reload picks up exactly where it left off.
//
// This module never imports dapp/tacit.js and takes every wallet-stateful primitive by injection, building a
// fresh makeBtcWallet-shaped `prims` per signing call rather than sharing one across calls -- the same
// one-wallet-source rule dapp/burndep-ux.js follows, for the same reason.
//
// v1 is self-bridge only: the destination is this wallet's own Bitcoin taproot key (the same walletPriv
// scalar tacit.js already uses for both chains -- see makeBurnDepositUx's start() call site), not an
// arbitrary recipient. Bridging to someone else's Bitcoin key is a real, later extension, not a gap in this
// one; nothing here forecloses it.
//
// State machine (one record per source note nullifier):
//   settled -> covered -> mint-signed -> mint-submitted -> minted
// Only 'start' (the settle) and 'covered'->'mint-signed' (the Bitcoin-side signing) need the wallet key;
// every other transition is a poll or a pure rebuild from already-journalled public data.
//
// Unlike burn-deposit, a crossOut's Bitcoin-side claim has no persisted retry inside the protocol if the
// worker's eth-state view is behind -- fold_crossout checks membership once, at scan time (see
// dapp/crossout-broadcast.js's header comment). The 'covered' gate below is what stands in for that: it
// blocks the mint from broadcasting until GET /reflection/eth-state/covers confirms the settle's own block is
// in view, so the claim is never revealed before it can fold.
import { makeCrossoutMintReveal } from './crossout-mint-reveal.js';
import { makeBtcWallet } from './bitcoin-taproot-wallet.js';

export const CROSSOUT_BETA_CAP_RAW = 100_000_000_000n; // 1,000 TAC at 8 decimals -- matches burndep-ux's own beta cap
const JOURNAL_PREFIX = 'tacit-crossout-bridge-v1';
const LEASE_TTL_MS = 30_000;

const stripHex = (h) => String(h).replace(/^0x/, '');
const withHex = (h) => (String(h).startsWith('0x') ? String(h) : '0x' + String(h));
const lc = (h) => String(h).toLowerCase();
const now = () => Date.now();
function hexToBytesLocal(h) { const s = String(h).replace(/^0x/, ''); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; }
function bytesToHexLocal(b) { return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }

// Real localStorage exposes .length/.key(i) alongside getItem/setItem/removeItem; a plain wrapper around it
// must forward those too, or isReserved's cross-wallet scan silently sees nothing (see burndep-ux.js's
// identical comment on its own defaultStorage).
function defaultStorage() {
  const ls = (() => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } })();
  return {
    getItem: (k) => (ls ? ls.getItem(k) : null),
    setItem: (k, v) => { if (ls) ls.setItem(k, v); },
    removeItem: (k) => { if (ls) ls.removeItem(k); },
    get length() { return ls ? ls.length : 0; },
    key: (i) => (ls ? ls.key(i) : null),
  };
}

const BIG_FIELDS = ['amount', 'blinding', 'value'];
function serializeRecord(rec) {
  return JSON.stringify(rec, (k, v) => (typeof v === 'bigint' ? (BIG_FIELDS.includes(k) ? { __big: v.toString() } : v.toString()) : v));
}
function deserializeRecord(text) {
  return JSON.parse(text, (k, v) => (v && typeof v === 'object' && typeof v.__big === 'string' ? BigInt(v.__big) : v));
}

// deps: { network, hrp, workerBase, fetchImpl, storage, secp, crossOut, tacAssetId,
//         chain: {getUtxos, pickSafeCommitSats, broadcastWithRetry, getFeeRate}, postHint }
// `crossOut` is the confidential pool ux's own crossOut function (dapp/confidential-pool-ux.js) -- injected
// rather than re-instantiated here, matching how burndep-ux.js takes `bridgeMint` from the same pool ux
// singleton instead of building its own. `postHint` is optional (tacit.js's local fast-track poke at the
// worker's /hint route) -- a fold happens on the worker's own scan cadence regardless.
export function makeCrossoutUx(deps) {
  const {
    network = 'mainnet', hrp = 'bc', workerBase, fetchImpl, storage: storageIn = null,
    secp, crossOut, tacAssetId, chain, postHint = null,
  } = deps || {};
  for (const [k, v] of Object.entries({ workerBase, secp, crossOut, tacAssetId, chain })) {
    if (v == null) throw new Error(`crossout-ux: deps.${k} required`);
  }
  const storage = storageIn || defaultStorage();
  const mintReveal = makeCrossoutMintReveal({ secp });

  function freshPrims(walletPriv) {
    const w = makeBtcWallet({
      priv: walletPriv, hrp,
      fetchUtxos: async () => [], // never used: the funding UTXO this module signs with is already resolved
      broadcastTx: async (hex) => chain.broadcastWithRetry(hex),
      fetchFeeRate: async () => chain.getFeeRate('priority'),
    });
    return w.prims;
  }

  // ---- journal: one record per source note nullifier, keyed per (network, walletPub) ----
  function journalKey(walletPub) { return `${JOURNAL_PREFIX}:${network}:${lc(typeof walletPub === 'string' ? walletPub : bytesToHexLocal(walletPub))}`; }
  function loadAll(walletPub) {
    try { const raw = storage.getItem(journalKey(walletPub)); const arr = raw ? deserializeRecord(raw) : []; return Array.isArray(arr) ? arr : []; }
    catch { return []; }
  }
  function saveAll(walletPub, list) { storage.setItem(journalKey(walletPub), serializeRecord(list)); }
  function putRecord(rec) {
    const list = loadAll(rec.walletPub).filter((r) => r.id !== rec.id);
    const saved = { ...rec, updatedAt: now() };
    list.push(saved);
    saveAll(rec.walletPub, list);
    return saved;
  }
  function getRecord(walletPub, id) { return loadAll(walletPub).find((r) => r.id === id) || null; }

  // A cross-tab lease, not a hard lock -- see burndep-ux.js's identical comment on why a stale lease is
  // treated as free and why this is not what actually prevents a double-spend (the journal-before-broadcast
  // ordering is).
  function leaseKey(id) { return `${JOURNAL_PREFIX}:lease:${network}:${id}`; }
  const sessionId = `${now()}-${Math.random().toString(36).slice(2)}`;
  function tryAcquireLease(id) {
    const key = leaseKey(id);
    try {
      const raw = storage.getItem(key);
      if (raw) { const held = JSON.parse(raw); if (held.owner !== sessionId && now() - held.at < LEASE_TTL_MS) return false; }
    } catch { /* a corrupt lease is treated as free */ }
    storage.setItem(key, JSON.stringify({ owner: sessionId, at: now() }));
    return true;
  }
  function releaseLease(id) { try { storage.removeItem(leaseKey(id)); } catch {} }

  // ---- eligibility (pure -- no network) ----
  // `note` shape: { nullifier, value (bigint|string), blinding (bigint|string), asset, confirmed (bool) } --
  // confidential-pool-ux.js's own note shape (balance()'s per-asset .notes array), unchanged: these notes
  // flow straight into crossOut() itself, which reads notes[0].asset the same way.
  function eligibleNotes(notes) {
    return (notes || []).map((n) => {
      const value = BigInt(n.value);
      let reason = null;
      if (lc(stripHex(n.asset)) !== lc(stripHex(tacAssetId))) reason = 'not TAC';
      else if (value > CROSSOUT_BETA_CAP_RAW) reason = 'over the 1,000 TAC beta limit — send part of it to yourself first to split off a smaller note';
      else if (n.confirmed === false) reason = 'unconfirmed';
      else if (isReserved(n.nullifier)) reason = 'already bridging';
      return { ...n, eligible: !reason, reason };
    });
  }

  // Scans every journal this storage holds under this module's prefix (not just one wallet's) -- the same
  // technique burndep-ux.js uses for its own reservation scan, since eligibleNotes is called before any one
  // wallet's pub is settled on as "the" pub, and a Bitcoin funding UTXO can be the same physical coin across
  // two different wallet imports even though a note's nullifier never is.
  function _anyRecordMatching(pred) {
    try {
      const len = storage.length; const key = storage.key;
      if (typeof len !== 'number' || typeof key !== 'function') return false;
      const prefix = `${JOURNAL_PREFIX}:${network}:`;
      for (let i = 0; i < len; i++) {
        const k = key.call(storage, i);
        if (!k || !k.startsWith(prefix)) continue;
        const list = deserializeRecord(storage.getItem(k));
        if (Array.isArray(list) && list.some((r) => r.stage !== 'minted' && pred(r))) return true;
      }
    } catch { /* a corrupt entry is treated as unreserved */ }
    return false;
  }
  function isReserved(nullifier) {
    return _anyRecordMatching((r) => r.id === nullifier);
  }
  // Whether `txid:vout` is some in-flight record's own Bitcoin-side funding UTXO (the 'covered'->'mint-signed'
  // stage's pickFundingUtxo pick) -- checked from tacit.js's own getUtxos filter, mirroring _burndepReserved,
  // so ordinary coin selection elsewhere can never spend out from under an in-flight mint.
  function isFundingReserved(txid, vout) {
    const id = `${stripHex(txid).toLowerCase()}:${Number(vout)}`;
    return _anyRecordMatching((r) => r.mint && r.mint.fundingUtxo && `${stripHex(r.mint.fundingUtxo.txid).toLowerCase()}:${Number(r.mint.fundingUtxo.vout)}` === id);
  }

  // ---- start: settles the note on Ethereum (bridge_burn) and derives the self-bridge destination ----
  async function start({ note, walletPriv }) {
    const walletPub = secp.getPublicKey(walletPriv, true);
    const id = note.nullifier;
    if (getRecord(walletPub, id)) throw new Error('crossout-ux: a bridge already exists for this note');
    if (isReserved(id)) throw new Error('crossout-ux: this note is already reserved by another bridge in progress');
    if (BigInt(note.value) > CROSSOUT_BETA_CAP_RAW) throw new Error('crossout-ux: over the beta cap');

    const destXonly = bytesToHexLocal(freshPrims(walletPriv).wallet.xonly());
    const r = await crossOut({
      walletPriv, notes: [note], amount: BigInt(note.value), fee: 0n,
      destOwner: destXonly, destChain: 1,
    });
    const co = r.crossOuts && r.crossOuts[0];
    if (!co) throw new Error('crossout-ux: settle produced no crossOut claim');

    const rec = {
      id, network, walletPub: bytesToHexLocal(walletPub), stage: 'settled', createdAt: now(),
      source: { nullifier: id, value: BigInt(note.value), assetId: tacAssetId },
      destXonly,
      settle: {
        txHash: r.txHash || null, claimId: co.claimId, cx: co.cx, cy: co.cy, destCommitment: co.destCommitment,
        ethBlock: r.ethBlock, claimIdVerified: !!r.claimIdVerified, claimIdNote: r.claimIdNote,
      },
    };
    return putRecord(rec);
  }

  // ---- advance: drive a record forward one stage. walletPriv is required only at 'covered'->'mint-signed'. ----
  async function advance(walletPub, id, { walletPriv = null } = {}) {
    const rec = getRecord(walletPub, id);
    if (!rec) throw new Error(`crossout-ux: no bridge record for ${id}`);
    if (!tryAcquireLease(id)) throw new Error('crossout-ux: this bridge is being advanced in another tab right now');
    try {
      const fn = STAGE_ADVANCE[rec.stage];
      if (!fn) return rec; // terminal ('minted') or unknown -- nothing to do
      const result = await fn(rec, { walletPriv });
      return rec.lastError ? putRecord({ ...result, lastError: null, errorCount: 0 }) : result;
    } catch (e) {
      putRecord({ ...rec, lastError: { message: String((e && e.message) || e), at: now() }, errorCount: (rec.errorCount || 0) + 1 });
      throw e;
    } finally { releaseLease(id); }
  }

  // Picks one confirmed, safe-to-spend UTXO from `address` -- same pattern burndep-ux.js's pickFundingUtxo
  // uses (chain.pickSafeCommitSats does the actual filtering/sorting, this just takes its top pick).
  async function pickFundingUtxo(address) {
    const utxos = await chain.getUtxos(address);
    const sorted = await chain.pickSafeCommitSats(utxos);
    const pick = Array.isArray(sorted) ? sorted[0] : sorted;
    if (!pick) throw new Error('crossout-ux: no safe funding UTXO available at this address');
    return { txid: pick.txid, vout: pick.vout, value: pick.value };
  }

  const STAGE_ADVANCE = {
    settled: async (rec) => {
      // completeCrossOutOnBitcoin (crossout-broadcast.js) refuses to broadcast an unverified claimId for
      // exactly this reason: a reveal built from a wrong claimId can never fold, with no on-chain error
      // anywhere to say so. crossOut() itself corroborates before returning, so this should normally already
      // be true -- surfacing it as a stuck, visible error (via advance()'s own lastError) rather than
      // silently retrying is the honest response to the rare case where it isn't.
      if (!rec.settle.claimIdVerified) {
        throw new Error(`crossout-ux: claimId not corroborated against the CrossOutRecorded event (${rec.settle.claimIdNote || 'unknown reason'}) — this bridge cannot proceed safely; contact support with this record's id`);
      }
      const covers = await callWorker('GET', `/reflection/eth-state/covers?block=${rec.settle.ethBlock}`);
      if (!covers || covers.covered !== true) return rec; // not yet -- resumable, matches burndep-ux's poll style
      return putRecord({ ...rec, stage: 'covered', coveredAt: now() });
    },
    covered: async (rec, { walletPriv }) => {
      if (!walletPriv) throw new Error('crossout-ux: this stage needs the wallet key');
      const P = freshPrims(walletPriv);
      const feeRate = await chain.getFeeRate('priority');
      const fundingUtxo = rec.mint && rec.mint.fundingUtxo ? rec.mint.fundingUtxo : await pickFundingUtxo(P.wallet.address());
      const built = mintReveal.buildCrossoutMintTxs({
        prims: P, assetId: withHex(tacAssetId), claimId: rec.settle.claimId, cx: rec.settle.cx, cy: rec.settle.cy,
        destXonly: rec.destXonly, fundingUtxo, feeRate,
      });
      return putRecord({
        ...rec, stage: 'mint-signed',
        mint: { commitHex: built.commitHex, commitTxid: built.commitTxid, revealHex: built.revealHex, revealTxid: built.revealTxid, feeRate: built.feeRate, fundingUtxo },
      });
    },
    'mint-signed': async (rec) => {
      await chain.broadcastWithRetry(rec.mint.commitHex);
      await chain.broadcastWithRetry(rec.mint.revealHex);
      if (postHint) { try { postHint(rec.mint.revealTxid, 0); } catch {} }
      return putRecord({ ...rec, stage: 'mint-submitted', submittedAt: now() });
    },
    'mint-submitted': async (rec) => {
      let tx;
      try { tx = await fetchChainJson(`/tx/${stripHex(rec.mint.revealTxid)}`); }
      catch { return rec; } // not found yet -- resumable
      if (!tx || !tx.status || !tx.status.confirmed) {
        // A duplicate broadcast of an already-known tx is a safe, explicit no-op.
        await chain.broadcastWithRetry(rec.mint.commitHex).catch(() => {});
        await chain.broadcastWithRetry(rec.mint.revealHex).catch(() => {});
        return rec;
      }
      return putRecord({ ...rec, stage: 'minted', mintedAt: now() });
    },
  };

  async function callWorker(method, path, body) {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!f) throw new Error('crossout-ux: no fetch implementation');
    const url = `${workerBase}${path}${path.includes('?') ? '&' : '?'}network=${network}`;
    const res = await f(url, method === 'GET' ? undefined : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  }
  function fetchChainJson(path) { return callWorker('GET', `/chain${path}`); }

  function list(walletPub) { return loadAll(walletPub); }
  function abandon(walletPub, id) { saveAll(walletPub, loadAll(walletPub).filter((r) => r.id !== id)); }

  async function resumeAll(walletPub, { walletPriv = null } = {}) {
    const out = [];
    for (const rec of loadAll(walletPub)) {
      if (rec.stage === 'minted') continue;
      try { out.push({ id: rec.id, record: await advance(walletPub, rec.id, { walletPriv }) }); }
      catch (e) { out.push({ id: rec.id, error: String(e.message || e) }); }
    }
    return out;
  }

  return { CROSSOUT_BETA_CAP_RAW, network, eligibleNotes, isReserved, isFundingReserved, start, advance, resumeAll, list, abandon };
}
