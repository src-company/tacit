// Orchestrates a TAC burn-deposit bridge (Bitcoin -> Ethereum) end to end: move a note to its burn-home,
// burn it via MARA Slipstream, register + wait for the reflection to fold it, then mint the Ethereum-side
// note. Wires together three already-independent, already-tested pieces —
// dapp/burn-deposit-reveal.js (builds + signs the two Bitcoin transactions), dapp/burndep-broadcast.js (MARA
// submit/poll + worker registration), and the confidential pool's own bridgeMint (dapp/confidential-bridge-mint.js,
// via the injected `bridgeMint`) — into one resumable state machine, journalled so a reload picks up exactly
// where it left off.
//
// This module never imports dapp/tacit.js and takes every wallet-stateful primitive by injection, building a
// fresh makeBtcWallet-shaped `prims` per signing call rather than sharing one across calls — the same pattern
// dapp/cbtc-lock-mint.js uses, and the only way to keep burn-deposit-reveal.js's one-wallet-source rule from
// being violated by a caller that also happens to hold tacit.js's own, separately-stateful wallet singleton.
//
// State machine (one record per source note outpoint, journalled to storage before each broadcast so a
// resume never re-signs or double-spends):
//   migrate-signed -> migrate-sent -> migrate-confirmed -> traced -> burn-signed -> burn-submitted
//     -> burn-mined -> registered -> folded -> minted
// Only 'migrate-signed' (via start()), 'traced'->'burn-signed', and 'folded'->'minted' need the wallet key;
// every other transition is a poll or a pure rebuild from already-journalled public data, so a reload can
// carry a record forward on its own right up to the next point that needs the user present.
import { makeBurnDepositReveal } from './burn-deposit-reveal.js';
import { makeBurnDepositBroadcaster } from './burndep-broadcast.js';
import { makeBurnDepositKit, classifyConfidentialTx } from './burn-deposit-bitcoin.js';
import { makeBtcWallet } from './bitcoin-taproot-wallet.js';
import { makeBridgeMintRecovery } from './bridge-mint-recovery.js';

export const BURNDEP_BETA_CAP_RAW = 100_000_000_000n; // 1,000 TAC at 8 decimals
const MAX_HOPS = 63; // the migrate adds one hop; the registration door caps a bundle at 64 (worker/src/index.js)
const JOURNAL_PREFIX = 'tacit-burndep-bridge-v1';
const LEASE_TTL_MS = 30_000;
const DEST_INDEXES = 8; // matches confidential-recovery.js's walkBridgeMints default

const stripHex = (h) => String(h).replace(/^0x/, '');
const withHex = (h) => (String(h).startsWith('0x') ? String(h) : '0x' + String(h));
const lc = (h) => String(h).toLowerCase();
const revHex = (h) => stripHex(h).match(/../g).reverse().join('');
const recordId = (txid, vout) => `${stripHex(txid).toLowerCase()}:${Number(vout)}`;
const now = () => Date.now();
function hexToBytesLocal(h) { const s = String(h).replace(/^0x/, ''); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; }
function bytesToHexLocal(b) { return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }

// Real localStorage exposes .length/.key(i) alongside getItem/setItem/removeItem; a plain wrapper around it
// must forward those too, or isReserved's cross-wallet scan (allRecordsAnyWallet) silently sees nothing.
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

// bigint <-> JSON-safe string, at the specific property NAMES a record ever carries a BigInt under (checked
// by name, not path, so nesting doesn't matter — every such field in this module happens to use one of these
// three names).
const BIG_FIELDS = ['amount', 'blinding', 'value'];
function serializeRecord(rec) {
  return JSON.stringify(rec, (k, v) => (typeof v === 'bigint' ? (BIG_FIELDS.includes(k) ? { __big: v.toString() } : v.toString()) : v));
}
function deserializeRecord(text) {
  return JSON.parse(text, (k, v) => (v && typeof v === 'object' && typeof v.__big === 'string' ? BigInt(v.__big) : v));
}

// deps: { network, hrp, workerBase, fetchImpl, storage, secp, sha256, keccak256, hmac, pool, bridgeMint,
//         chainBindingHex, tacAssetId, chain: {getUtxos, pickSafeCommitSats, broadcastWithRetry, getFeeRate},
//         encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf,
//         encryptAmount, signSchnorr, modN }
// The last group (encodeCXferBppPayload..modN) are the pure cxfer/BPP helpers burn-deposit-reveal.js's
// MIGRATE_NEED lists — safe to source from dapp/tacit.js directly (they take explicit arguments, no implicit
// wallet dependency), unlike anything that reads a wallet singleton's own .priv/.pub. chain.pickSafeCommitSats
// is expected to be tacit.js's own (it reads the dapp's live holdings scan internally) — this module only
// ever calls it as an opaque `(utxos) => sorted safe-to-spend utxos` function.
export function makeBurnDepositUx(deps) {
  const {
    network = 'mainnet', hrp = 'bc', workerBase, fetchImpl, storage: storageIn = null,
    secp, sha256, keccak256, hmac, pool, bridgeMint, chainBindingHex, tacAssetId,
    chain, encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf,
    encryptAmount, signSchnorr, modN,
  } = deps || {};
  for (const [k, v] of Object.entries({ workerBase, secp, sha256, keccak256, hmac, pool, bridgeMint, chainBindingHex, tacAssetId, chain })) {
    if (v == null) throw new Error(`burndep-ux: deps.${k} required`);
  }
  const storage = storageIn || defaultStorage();
  const cryptoDeps = { secp, keccak256, sha256 };
  const kit = makeBurnDepositKit(cryptoDeps);
  const reveal = makeBurnDepositReveal({ pool, secp });
  const broadcaster = makeBurnDepositBroadcaster({ workerBase, fetchImpl });
  const mintRecovery = makeBridgeMintRecovery({ hmac, sha256, curveOrder: secp.CURVE.n });
  const pureCxferPrims = { encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf, encryptAmount, signSchnorr, modN, sha256 };
  for (const [k, v] of Object.entries(pureCxferPrims)) {
    if (v == null) throw new Error(`burndep-ux: deps.${k} required (pure cxfer helper — see burn-deposit-reveal.js's MIGRATE_NEED)`);
  }

  // A fresh wallet-shaped prims object per signing call, never shared/reused across calls — the whole point
  // of building it here rather than taking one from the caller (see this module's own header comment).
  function freshPrims(walletPriv) {
    const w = makeBtcWallet({
      priv: walletPriv, hrp,
      fetchUtxos: async () => [], // never used: every fundingUtxo this module signs with is already resolved
      // buildMigrationTxs/buildBurnDepositRevealTxs never actually invoke broadcastTx (both build+sign only,
      // "nothing broadcast" per their own doc comments) — wired to broadcastWithRetry anyway so this prims
      // object satisfies makeBtcWallet's own shape rather than depending on that being true forever.
      broadcastTx: async (hex) => chain.broadcastWithRetry(hex),
      fetchFeeRate: async () => chain.getFeeRate('priority'),
    });
    return { ...w.prims, ...pureCxferPrims };
  }
  // p2wpkhScript is a pure function of an explicit pubkey (dapp/bitcoin-taproot-wallet.js) — this throwaway
  // instance's own key is never used for anything, it only exists to reach that one prim.
  const scratchPrims = freshPrims(new Uint8Array(32).fill(1));
  function p2wpkhScriptOf(pubkeyHexOrBytes) {
    const pub = typeof pubkeyHexOrBytes === 'string' ? hexToBytesLocal(stripHex(pubkeyHexOrBytes)) : pubkeyHexOrBytes;
    return scratchPrims.p2wpkhScript(pub);
  }

  // ---- journal: one record per source outpoint, keyed per (network, walletPub) so a resume never silently
  // adopts another key's in-flight bridge ----
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

  // A cross-tab lease, not a hard lock: a stale (LEASE_TTL_MS-old) lease is treated as free, so a crashed tab
  // never permanently strands a record. Good enough to stop two tabs racing the SAME advance() concurrently;
  // not a substitute for the journal-before-broadcast ordering, which is what actually prevents a double-spend.
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

  // ---- eligibility (pure — no network) ----
  // `holding` shape: { txid, vout, sats, assetId, amount (bigint|string), blinding (bigint|string),
  //                    confirmed (bool), stealth (bool, true for a note received via a stealth claim) }.
  function eligibleNotes(holdings) {
    return (holdings || []).map((h) => {
      const amount = BigInt(h.amount);
      let reason = null;
      if (lc(h.assetId) !== lc(tacAssetId)) reason = 'not TAC';
      else if (amount > BURNDEP_BETA_CAP_RAW) reason = 'over the 1,000 TAC beta limit — send part of it to yourself first to split off a smaller note';
      else if (h.confirmed === false) reason = 'unconfirmed';
      else if (h.stealth) reason = 'received privately (stealth) — send it to yourself first to get an ordinary note';
      else if (isReserved(h.txid, h.vout)) reason = 'already bridging';
      return { ...h, eligible: !reason, reason };
    });
  }

  function isReserved(txid, vout) {
    const op = recordId(txid, vout);
    for (const rec of allRecordsAnyWallet()) {
      if (rec.stage === 'minted') continue;
      if (rec.id === op) return true;
      if (rec.migrate && recordId(rec.migrate.fundingUtxo.txid, rec.migrate.fundingUtxo.vout) === op) return true;
      if (rec.burn && rec.burn.fundingUtxo && recordId(rec.burn.fundingUtxo.txid, rec.burn.fundingUtxo.vout) === op) return true;
    }
    return false;
  }
  // Reservations must hold across every wallet this browser has ever bridged from, not just the "current"
  // one — a second imported key sharing a UTXO with the first is the same physical coin either way. Storage
  // keys are prefixed predictably (journalKey), so this scans them directly via the enumeration defaultStorage
  // forwards from real localStorage.
  function allRecordsAnyWallet() {
    const out = [];
    const prefix = `${JOURNAL_PREFIX}:${network}:`;
    const len = storage.length;
    if (typeof len === 'number' && typeof storage.key === 'function') {
      for (let i = 0; i < len; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(prefix)) { try { out.push(...deserializeRecord(storage.getItem(k))); } catch {} }
      }
    }
    return out;
  }

  // ---- preflight: everything checkable before signing anything ----
  // note: one entry from eligibleNotes (already confirmed .eligible). walletPub: compressed pubkey bytes/hex,
  // for the ownership check only — never the private key.
  async function preflight({ note, walletPub }) {
    const out = { steps: [], ok: false };
    const step = (name, ok, detail) => { out.steps.push({ name, ok, detail }); return ok; };
    if (!step('cap', BigInt(note.amount) <= BURNDEP_BETA_CAP_RAW, `${note.amount} raw units`)) return out;

    let srcTx;
    try { srcTx = await fetchChainJson(`/tx/${stripHex(note.txid)}`); }
    catch (e) { step('source-lookup', false, String(e.message || e)); return out; }
    const vout = srcTx && srcTx.vout && srcTx.vout[note.vout];
    if (!step('source-confirmed', !!(srcTx.status && srcTx.status.confirmed), 'source output confirmed on Bitcoin')) return out;
    const ownWpkh = lc(bytesToHexLocal(p2wpkhScriptOf(walletPub)));
    if (!step('source-ownership', !!vout && lc(vout.scriptpubkey) === ownWpkh, "source output pays this wallet's own address")) return out;

    let traced;
    try { traced = await traceNote({ txid: note.txid, vout: note.vout, assetId: tacAssetId }); }
    catch (e) { step('trace', false, String(e.message || e)); return out; }
    if (!step('trace', traced.hops <= MAX_HOPS, `${traced.hops} hop(s) to the etch (max ${MAX_HOPS})`)) return out;
    out.bundle = traced.bundle;
    out.hops = traced.hops;

    let rates = null;
    try { rates = await broadcaster.slipstreamRates(); step('mara-rates', true, `${rates.effective_rate} sat/vB effective`); }
    catch (e) { step('mara-rates', false, String(e.message || e)); }
    out.slipstreamRates = rates;

    let migrateRate = null;
    try { migrateRate = await chain.getFeeRate('priority'); step('fee-estimate', true, `${migrateRate} sat/vB`); }
    catch (e) { step('fee-estimate', false, String(e.message || e)); return out; }
    out.migrateFeeRate = migrateRate;

    out.ok = out.steps.every((s) => s.ok);
    return out;
  }

  async function traceNote({ txid, vout, assetId }) {
    const res = await callWorker('POST', '/reflection/burndep/trace', { note: { txid: stripHex(txid), vout }, assetId, maxDepth: MAX_HOPS + 1 });
    if (!res.ok) throw new Error(res.error || 'trace failed');
    return { bundle: res.bundle, hops: res.hops };
  }

  // Picks one confirmed, safe-to-spend UTXO from `address` — chain.pickSafeCommitSats does the actual
  // filtering/sorting (see this module's own header comment on why that call is opaque here), this just
  // takes its top pick.
  async function pickFundingUtxo(address) {
    const utxos = await chain.getUtxos(address);
    const sorted = await chain.pickSafeCommitSats(utxos);
    const pick = Array.isArray(sorted) ? sorted[0] : sorted;
    if (!pick) throw new Error('burndep-ux: no safe funding UTXO available at this address');
    return { txid: pick.txid, vout: pick.vout, value: pick.value };
  }

  // ---- start: the very first signature, migrating the source note to its burn-home ----
  async function start({ note, walletPriv, fundingUtxo, feeRate = null }) {
    const walletPub = secp.getPublicKey(walletPriv, true);
    const id = recordId(note.txid, note.vout);
    if (getRecord(walletPub, id)) throw new Error('burndep-ux: a bridge already exists for this note');
    if (isReserved(note.txid, note.vout)) throw new Error('burndep-ux: this note is already reserved by another bridge in progress');
    if (BigInt(note.amount) > BURNDEP_BETA_CAP_RAW) throw new Error('burndep-ux: over the beta cap');

    const P = freshPrims(walletPriv);
    const mig = await reveal.buildMigrationTxs({
      prims: P, walletPriv,
      note: { assetId: tacAssetId, amount: BigInt(note.amount), blinding: BigInt(note.blinding), txid: note.txid, vout: note.vout, sats: note.sats },
      fundingUtxo, feeRate,
    });
    const rec = {
      id, network, walletPub: bytesToHexLocal(walletPub), stage: 'migrate-signed', createdAt: now(),
      source: { txid: note.txid, vout: note.vout, sats: note.sats, assetId: tacAssetId, amount: BigInt(note.amount), blinding: BigInt(note.blinding) },
      migrate: {
        commitHex: mig.commitHex, revealHex: mig.revealHex, commitTxid: mig.commitTxid, revealTxid: mig.revealTxid,
        fundingUtxo: { txid: fundingUtxo.txid, vout: fundingUtxo.vout, value: fundingUtxo.value },
        feeRate: mig.feeRate, commitFee: mig.commitFee, revealFee: mig.revealFee,
      },
      burnHome: {
        txid: mig.burnHome.txid, vout: mig.burnHome.vout, value: mig.burnHome.value,
        cx: mig.burnHome.cx, cy: mig.burnHome.cy, blinding: mig.burnHome.blinding,
        xonly: bytesToHexLocal(mig.burnHome.xonly), spk: bytesToHexLocal(mig.burnHome.spk),
        controlBlock: bytesToHexLocal(mig.burnHome.controlBlock), scriptS: bytesToHexLocal(mig.burnHome.scriptS),
      },
    };
    return putRecord(rec);
  }

  // ---- advance: drive a record forward one stage. walletPriv is required only at the two stages that sign. ----
  async function advance(walletPub, id, { walletPriv = null } = {}) {
    const rec = getRecord(walletPub, id);
    if (!rec) throw new Error(`burndep-ux: no bridge record for ${id}`);
    if (!tryAcquireLease(id)) throw new Error('burndep-ux: this bridge is being advanced in another tab right now');
    try {
      const fn = STAGE_ADVANCE[rec.stage];
      if (!fn) return rec; // terminal ('minted') or unknown — nothing to do
      return await fn(rec, { walletPriv });
    } finally { releaseLease(id); }
  }

  const STAGE_ADVANCE = {
    'migrate-signed': async (rec) => {
      await chain.broadcastWithRetry(rec.migrate.commitHex);
      await chain.broadcastWithRetry(rec.migrate.revealHex);
      return putRecord({ ...rec, stage: 'migrate-sent', sentAt: now() });
    },
    'migrate-sent': async (rec) => {
      const st = await checkTxidStatus(rec.migrate.revealTxid);
      if (st.status === 'not-found' || st.status === 'unconfirmed') {
        // A duplicate broadcast of an already-known tx is a safe, explicit no-op (never rebuild — BP+ proofs
        // are non-deterministic, so a rebuilt migrate would be a different, conflicting transaction).
        await chain.broadcastWithRetry(rec.migrate.commitHex).catch(() => {});
        await chain.broadcastWithRetry(rec.migrate.revealHex).catch(() => {});
        return rec;
      }
      return putRecord({ ...rec, stage: 'migrate-confirmed', migrateConfirmedAt: now() });
    },
    'migrate-confirmed': async (rec) => {
      const traced = await traceNote({ txid: rec.burnHome.txid, vout: 0, assetId: tacAssetId });
      if (traced.hops > MAX_HOPS) throw new Error(`burndep-ux: burn-home traces in ${traced.hops} hops, over the ${MAX_HOPS}-hop limit`);
      const bundle = { ...traced.bundle, burned: { cx: rec.burnHome.cx, cy: rec.burnHome.cy } };
      return putRecord({ ...rec, stage: 'traced', bundle, hops: traced.hops });
    },
    traced: async (rec, { walletPriv }) => {
      if (!walletPriv) throw new Error('burndep-ux: this stage needs the wallet key');
      const P = freshPrims(walletPriv);
      // Reconstruct the burn-home's own signing key from the wallet + source outpoint (never journalled) and
      // check it against what's actually on chain before building anything that spends it.
      const burnHomeOnChain = await fetchChainJson(`/tx/${stripHex(rec.burnHome.txid)}`);
      const chainSpk = burnHomeOnChain.vout[0].scriptpubkey;
      const burnHome = reveal.reconstructBurnHome({
        prims: P, walletPriv, source: { txid: rec.source.txid, vout: rec.source.vout },
        amount: rec.source.amount, burnHomeTxid: rec.burnHome.txid, chainSpk,
      });

      const rates = await broadcaster.slipstreamRates();
      const feeRate = Math.max(Number(rates.effective_rate), Number(rates.submit_fee_rate), 1) * 1.1;
      const { destIndex, owner } = pickDestOwner(walletPriv);
      const target = withHex(chainBindingHex());
      const nullifier = pool.nullifier(kit.burnDepositLeaf(withHex(tacAssetId), burnHome.cx, burnHome.cy, withHex(revHex(rec.burnHome.txid)), 0));
      const destBlinding = mintRecovery.deriveBridgeMintBlinding({ privkey: walletPriv, nullifier });
      const { cx: destCx, cy: destCy } = pool.commitXY(rec.source.amount, destBlinding);
      const destLeaf = pool.leaf(withHex(tacAssetId), destCx, destCy, owner);
      const envelope = { assetId: withHex(tacAssetId), nullifier, destLeaf, target };

      const fundingUtxo = rec.burn && rec.burn.fundingUtxo ? rec.burn.fundingUtxo : await pickFundingUtxo(P.wallet.address());
      const built = await reveal.buildBurnDepositRevealTxs({ prims: P, burnHome, envelope, fundingUtxo, feeRate });
      const check = await callWorker('POST', '/reflection/burndep/check', {
        bundle: rec.bundle, assetId: withHex(tacAssetId), burnTxHex: built.revealHex,
      });
      if (!check.ok || !check.admitted) throw new Error(`burndep-ux: the burn would not be admitted yet: ${(check && check.reason) || (check && check.error) || 'unknown'}`);

      return putRecord({
        ...rec, stage: 'burn-signed',
        burn: { hex: built.revealHex, txid: built.revealTxid, feeRate: built.feeRate, fee: built.fee, fundingUtxo },
        envelope, dest: { index: destIndex, owner, blinding: destBlinding, value: rec.source.amount },
      });
    },
    'burn-signed': async (rec) => {
      // submitToSlipstream itself throws on a non-success status (burndep-broadcast.js) — nothing further to
      // check here.
      await broadcaster.submitToSlipstream(rec.burn.hex);
      return putRecord({ ...rec, stage: 'burn-submitted', submittedAt: now() });
    },
    'burn-submitted': async (rec) => {
      const st = await checkTxidStatus(rec.burn.txid);
      if (st.status === 'not-found' || st.status === 'unconfirmed') return rec;
      return putRecord({ ...rec, stage: 'burn-mined', burnMinedAt: now() });
    },
    'burn-mined': async (rec) => {
      try {
        await broadcaster.registerBurnDeposit({ burnTxidDisplay: rec.burn.txid, bundle: rec.bundle, network });
      } catch (e) {
        // A 409 with an identical bundle is a prior registration of this exact burn succeeding — fine.
        // A 409 with a different bundle needs a human; anything else (network, 5xx) just retries next tick.
        if (!/already registered|409/i.test(String(e.message || ''))) throw e;
      }
      return putRecord({ ...rec, stage: 'registered', registeredAt: now() });
    },
    registered: async (rec) => {
      const st = await checkTxidStatus(rec.burn.txid);
      if (st.status !== 'folded') return rec;
      return putRecord({ ...rec, stage: 'folded', foldedAt: now() });
    },
    folded: async (rec, { walletPriv }) => {
      if (!walletPriv) throw new Error('burndep-ux: this stage needs the wallet key');
      const secret = pool.deriveNote(walletPriv, withHex(tacAssetId), rec.dest.index).secret;
      const minted = await bridgeMint.bridgeMint({
        network, sourceClass: 0,
        spentTxid: withHex(revHex(rec.burnHome.txid)), spentVout: 0,
        asset: withHex(tacAssetId), chainBinding: withHex(chainBindingHex()),
        burned: { value: rec.source.amount, blinding: rec.burnHome.blinding, owner: '0x' + '00'.repeat(32) },
        dest: { value: rec.dest.value, blinding: rec.dest.blinding, owner: rec.dest.owner },
        recovery: { ownerPub: null, secret },
      });
      return putRecord({ ...rec, stage: 'minted', mintedAt: now(), mintedJobId: minted.jobId || null, mintedTxHash: minted.txHash || null });
    },
  };

  // A stable, always-available choice: this beta ships one bridge per note, so index 0 never collides with
  // itself, and recovery (confidential-recovery.js's walkBridgeMints) tries indexes 0..7 regardless of which
  // one was actually used, so nothing is lost if a future version needs to rotate this.
  function pickDestOwner(walletPriv) {
    const dn = pool.deriveNote(walletPriv, withHex(tacAssetId), 0);
    return { destIndex: 0, owner: pool.nkToOwner(dn.secret) };
  }

  async function checkTxidStatus(txid) {
    return callWorker('GET', `/reflection/burndep/status?txid=${stripHex(txid)}`);
  }
  async function callWorker(method, path, body) {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!f) throw new Error('burndep-ux: no fetch implementation');
    const url = `${workerBase}${path}${path.includes('?') ? '&' : '?'}network=${network}`;
    const res = await f(url, method === 'GET' ? undefined : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  }
  function fetchChainJson(path) { return callWorker('GET', `/chain${path}`); }

  function list(walletPub) { return loadAll(walletPub); }
  function abandon(walletPub, id) { saveAll(walletPub, loadAll(walletPub).filter((r) => r.id !== id)); }

  // Recovers a bridge from just its burn txid and the wallet key — the case where the journal itself is
  // gone (a different browser/device, or cleared storage) but the migrate has already confirmed, so
  // everything downstream of it is derivable from chain data + the deterministic key derivations. Rebuilds
  // a record starting at whatever stage the burn's own status implies, then journals it under this wallet so
  // resumeAll/advance carry it forward normally. Does not recover a bridge stuck before the burn even exists
  // (mid-migrate, no burn tx yet) — that window is covered by the journal, not by chain data alone.
  async function recoverFromTxid(burnTxidDisplay, walletPriv, { amount } = {}) {
    if (amount == null) throw new Error('burndep-ux: recoverFromTxid needs { amount } — the confidential value the original note carried (not recoverable from chain data alone)');
    const walletPub = secp.getPublicKey(walletPriv, true);
    const status = await checkTxidStatus(burnTxidDisplay);
    if (status.status === 'not-found') throw new Error('burndep-ux: unknown burn txid');
    if (!status.note || !status.assetId) throw new Error('burndep-ux: this txid does not classify as a burn-deposit');
    if (lc(status.assetId) !== lc(tacAssetId)) throw new Error('burndep-ux: this burn is for a different asset');
    const burnHomeTxid = stripHex(status.note.txid);

    const traced = await traceNote({ txid: burnHomeTxid, vout: 0, assetId: tacAssetId });
    // cxfers[0] is the migrate itself (the hop directly producing the burn-home); its own first input is the
    // source note. inputs[].prevTxid is already display-hex (see burndep-live-tracer.js's own seed()/inputs
    // construction, sourced straight from esplora's vin[].txid) — no byte-order flip needed here.
    const firstInput = traced.bundle && traced.bundle.cxfers && traced.bundle.cxfers[0] && traced.bundle.cxfers[0].inputs && traced.bundle.cxfers[0].inputs[0];
    if (!firstInput) throw new Error('burndep-ux: could not recover the source note behind this burn-home');
    const source = { txid: stripHex(firstInput.prevTxid), vout: firstInput.prevVout };

    const burnHomeOnChain = await fetchChainJson(`/tx/${burnHomeTxid}`);
    const chainSpk = burnHomeOnChain.vout[0].scriptpubkey;
    const P = freshPrims(walletPriv);
    const burnHome = reveal.reconstructBurnHome({ prims: P, walletPriv, source, amount, burnHomeTxid, chainSpk });
    const bundle = { ...traced.bundle, burned: { cx: burnHome.cx, cy: burnHome.cy } };

    const stageByStatus = { unconfirmed: 'burn-submitted', 'awaiting-scan': status.registered ? 'registered' : 'burn-mined', pending: status.registered ? 'registered' : 'burn-mined', folded: 'folded' };
    const stage = stageByStatus[status.status];
    if (!stage) throw new Error(`burndep-ux: cannot recover from status '${status.status}'`);

    const rec = {
      id: recordId(source.txid, source.vout), network, walletPub: bytesToHexLocal(walletPub), stage, createdAt: now(), recoveredAt: now(),
      // blinding is not recoverable (and not needed): every stage recoverFromTxid can resume into is past the
      // point anything reads the source note's own opening — only its outpoint and amount matter from here.
      source: { txid: source.txid, vout: source.vout, sats: burnHome.value, assetId: tacAssetId, amount: BigInt(amount), blinding: 0n },
      burnHome: {
        txid: burnHomeTxid, vout: 0, value: burnHome.value, cx: burnHome.cx, cy: burnHome.cy, blinding: burnHome.blinding,
        xonly: bytesToHexLocal(burnHome.xonly), spk: bytesToHexLocal(burnHome.spk), controlBlock: bytesToHexLocal(burnHome.controlBlock), scriptS: bytesToHexLocal(burnHome.scriptS),
      },
      bundle, hops: traced.hops,
      burn: { txid: stripHex(burnTxidDisplay), hex: null, fundingUtxo: null },
    };
    return putRecord(rec);
  }

  async function resumeAll(walletPub, { walletPriv = null } = {}) {
    const out = [];
    for (const rec of loadAll(walletPub)) {
      if (rec.stage === 'minted') continue;
      try { out.push({ id: rec.id, record: await advance(walletPub, rec.id, { walletPriv }) }); }
      catch (e) { out.push({ id: rec.id, error: String(e.message || e) }); }
    }
    return out;
  }

  return {
    BURNDEP_BETA_CAP_RAW, eligibleNotes, isReserved, preflight, start, advance, resumeAll, recoverFromTxid, list, abandon,
  };
}
