// Confidential DeFi tab — borrow against a shielded note. Renders over the LIVE pool's seed-only note scan
// (confidential-pool-ux.js) and drives the REAL CDP/cBTC builders (confidential-cdp.js) through the gasless
// relay (confidential-defi-actions.js). Kept out of tacit.js (a thin hook calls renderCdpTab), mirroring
// confidential-pool-tab.js.
//
// OPEN (mint cUSD), cBTC-mint and CLOSE assemble the exact guest witnesses and submit to the relay. CLOSE
// rebuilds the CDP position tree from the CdpPositionInserted event to prove membership. Top-up uses the
// same machinery and is not surfaced in the UI.

import { secp, sha256, keccak_256, hmac } from './vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from './confidential-pool-ux.js';
import { confidentialPoolReady, confidentialUnavailableHTML, esc, formatErr, notify, proveUpdater, protectOutpoint, listProtectedOutpoints, listReservedLocks, reservedLockSats, evmAccountHint } from './confidential-deployments.js';
import { makeConfidentialCdp } from './confidential-cdp.js';
import { makeConfidentialFarm } from './confidential-farm.js';
import { makeConfidentialDefiActions } from './confidential-defi-actions.js';
import { signSchnorr, G } from './bulletproofs.js';
import { makeCbtcLockMint } from './cbtc-lock-mint.js';
import { makeCdpPositionStore } from './confidential-secret-store.js';
import { scanHealth, scanHealthHtml, inboundBadgeHtml, inboundSummaryHtml } from './confidential-scan-health.js';
import { parseUnits, formatUnits } from './confidential-payout.js';

let _ux = null;
function getUx() {
  return _ux || (_ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256}));
}

const el = (id) => document.getElementById(id);
const ZERO32 = '0x' + '00'.repeat(32);

// A CDP position's owner is a ONE-TIME x-only pubkey (the guest validates it + verifies a close sig). The
// matching priv is persisted in the (already local-only) position descriptor so the close can re-sign.
const xOnly = (priv) => '0x' + [...G.multiply(BigInt(priv)).toRawBytes(true).slice(1)].map((x) => x.toString(16).padStart(2, '0')).join('');

// The position's own auth key (positionOwnerPriv) lives in a SEPARATE tree from the note pool — collateral
// legs are spent and the position itself is not a note leaf, so unlike every owned note in the pool it has NO
// memo channel to ride for recovery (see confidential-defi-actions.js's header comment). A random key here
// means a wiped localStorage permanently strands the ability to close the position and reclaim collateral,
// even though the underlying debt note itself stays recoverable (it IS memo-sealed — see `owned()` in
// confidential-defi-actions.js, which already carries debtNk + debtBlinding to the borrower's pubkey). Derive
// it instead so any wallet holding the identity key can re-derive every position it has ever opened against a
// given controller, purely from key + chain: HMAC(identityPriv, domain ‖ controller ‖ keyNonce_be32), reduced
// mod N. `keyNonce` here is just "the Nth position opened against this controller" — recovering after a wipe
// means walking keyNonce = 0, 1, 2, … and matching each derived positionOwner against on-chain
// CdpPositionInserted events, the same style of scan scanCbtc already does for cBTC locks.
function derivePositionOwnerPriv(walletPriv, controller, keyNonce) {
  const toBytes = (v) => v instanceof Uint8Array ? v : Uint8Array.from((String(v).replace(/^0x/, '').match(/../g) || []).map((h) => parseInt(h, 16)));
  const domain = new TextEncoder().encode('tacit-cdp-position-v1');
  const controllerBytes = toBytes(controller);
  const nonceBytes = new Uint8Array(4);
  new DataView(nonceBytes.buffer).setUint32(0, keyNonce >>> 0, false);
  const msg = new Uint8Array(domain.length + controllerBytes.length + nonceBytes.length);
  msg.set(domain); msg.set(controllerBytes, domain.length); msg.set(nonceBytes, domain.length + controllerBytes.length);
  const raw = hmac(sha256, toBytes(walletPriv), msg);
  let b = 0n; for (const x of raw) b = (b << 8n) | BigInt(x);
  b %= secp.CURVE.n;
  return '0x' + (b === 0n ? 1n : b).toString(16).padStart(64, '0');
}

function fmtUnits(v, decimals) {
  const s = BigInt(v).toString().padStart(decimals + 1, '0');
  const i = s.slice(0, -decimals) || '0';
  const f = s.slice(-decimals).replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}

// Persist the opening of each position so it can be closed later. This descriptor is a CACHE, not the record:
// ux.recoverCdpPositions rebuilds positions from key + chain, and the renderer merges anything it finds that
// has no local descriptor. What the descriptor buys is not having to walk the chain to close a position you
// opened in this browser.
//
// It holds no keys. The close key is the Nth position key against this controller (derivePositionOwnerPriv),
// so the descriptor keeps the nonce and the key is derived — and checked against the owner the position was
// opened under — at close time. The debt note's nullifier key and blinding derive from the anchor the settle
// makes public, so the anchor is kept in their place. confidential-secret-store.js owns both rules, and seals
// anything a descriptor written by an older build carries that does not re-derive.
const _posStore = makeCdpPositionStore({ sha256, hmac, secp, curveOrder: secp.CURVE.n });
const loadPositions = () => _posStore.list();
// The next position key index for a controller. It only ever grows: counting the saved positions would hand a
// new position the key of a still-open one as soon as an earlier one was closed and its descriptor dropped.
//
// CHAIN FIRST, storage only as a floor. Every input here used to be local: with storage cleared — a new
// device, a private window, a user who cleared site data — the counter read 0 and loadPositions() was empty,
// so a new position derived the SAME owner key as a still-open one. That is the same shape as the wrap-index
// bug that was fixed by making nextWrapIndex throw instead of falling back to 0, and the same remedy applies:
// `recoverCdpPositions` already walks the chain for this exact number and returns it as `nextKeyNonce`, so
// take that as the authority and never silently fall back to 0.
const KEY_NONCE_PREFIX = 'tacit-cdp-next-key-nonce:';
function localKeyNonceFloor(controller) {
  const c = String(controller).toLowerCase();
  let n = 0;
  try { n = Math.max(0, parseInt(localStorage.getItem(KEY_NONCE_PREFIX + c), 10) || 0); } catch {}
  for (const p of loadPositions()) {
    if (String(p.controller).toLowerCase() === c && Number.isInteger(p.keyNonce)) n = Math.max(n, p.keyNonce + 1);
  }
  return n;
}
async function nextKeyNonce(ux, walletPriv, controller) {
  const c = String(controller).toLowerCase();
  const local = localKeyNonceFloor(controller);
  let onchain = null;
  try {
    const r = await ux.recoverCdpPositions({ walletPriv });
    if (r && Number.isInteger(r.nextKeyNonce)) onchain = r.nextKeyNonce;
  } catch { /* handled below */ }
  if (onchain == null && local === 0) {
    throw new Error('cannot establish the next CDP position key index: the chain walk failed and this browser '
      + 'has no saved positions. Opening one now could reuse the key of a position that is still open — retry '
      + 'once the RPC is reachable rather than proceeding.');
  }
  const n = Math.max(local, onchain ?? 0);
  try { localStorage.setItem(KEY_NONCE_PREFIX + c, String(n + 1)); } catch {}
  return n;
}

// Persist a broadcast-but-not-yet-minted cBTC lock, keyed with the exact blinding the lock committed to —
// cbtcLockCommitment[outpoint] is fixed at lock time (ConfidentialPool.sol's OP_CBTC_MINT gate), so the mint
// must reuse it rather than pick a fresh one. Cleared once minted.
const CBTC_PENDING_KEY = 'tacit-cbtc-pending-locks-v1';
function loadPendingCbtcLocks() { try { return JSON.parse(localStorage.getItem(CBTC_PENDING_KEY) || '[]'); } catch { return []; } }
function savePendingCbtcLocks(list) { try { localStorage.setItem(CBTC_PENDING_KEY, JSON.stringify(list)); } catch {} }
function addPendingCbtcLock(rec) { const all = loadPendingCbtcLocks(); all.push(rec); savePendingCbtcLocks(all); }
function removePendingCbtcLock(lockTxid) { savePendingCbtcLocks(loadPendingCbtcLocks().filter((r) => r.lockTxid !== lockTxid)); }

// The reflection guest's outpoint key hashes the RAW (internal-order) txid, the opposite byte order from the
// display/explorer hex bitcoin-taproot-wallet.js's txid() returns — see cxfer-core::outpoint_key /
// confidential-pool.js's outpointKey (`keccak(txid ‖ vout_le)`, mirrored 1:1 here) and
// confidential-reflection-scan-indexer.js's computeTxidInternal comment for the same reversal.
function reverseHex(hex) {
  const h = String(hex).replace(/^0x/, '').match(/../g) || [];
  return h.reverse().join('');
}
function cbtcOutpoint(pool, lockTxidDisplay, lockVout) {
  return pool.outpointKey('0x' + reverseHex(lockTxidDisplay), lockVout);
}

function decOf(ux, assetId) {
  const m = ux.assets.find((x) => x.assetId.toLowerCase() === String(assetId).toLowerCase());
  return m ? (m.tacitDecimals ?? m.decimals) : 8; // note values are in-system units
}

// Open a CDP: lock the selected collateral notes → mint a cUSD debt note (gasless via the relay).
function wireOpen(wallet, ux, notes) {
  const btn = el('cdp-open-btn');
  if (!btn) return;
  const cfg = ux.cfg;
  const controller = cfg.collateralEngine;
  const statusEl = el('cdp-open-status');
  const ratioEl = el('cdp-ratio-readout');
  const cdp = makeConfidentialCdp({ keccak256: keccak_256, pool: ux.pool, signSchnorr });
  // cUSD has its own decimals (8) like any other asset here — a plain BigInt(debtStr) would read a typed
  // "100" as 100 base units (0.000001 cUSD) instead of 100 cUSD, so amounts go through the same decimal
  // parser every other amount field in the dapp uses.
  const debtDecimals = controller ? decOf(ux, cdp.debtAssetId(controller)) : 8;
  if (!controller) {
    btn.disabled = true;
    if (statusEl) statusEl.innerHTML = 'CDP minting goes live once a CollateralEngine is deployed for this pool. '
      + 'Your collateral notes are listed below and ready.';
  }

  // Live collateralization-ratio readout. The engine's own thresholds (mint floor, liquidation trigger) are
  // fetched once and cached; selected collateral is re-priced through the engine's own oracle (btcToUsd) on
  // every checkbox/amount change, so what's shown here is never a locally-guessed number. Undercollateralized
  // is the same check onCdpMint makes on-chain — showing it before submit turns an opaque revert into a
  // plain-language stop.
  const hexWord = (bi) => bi.toString(16).padStart(64, '0');
  let ratioParams = null;
  async function fetchRatioParams() {
    if (ratioParams || !controller) return ratioParams;
    try {
      const [mintWord, liqWord] = await Promise.all([
        ux.ethCall(controller, '0x4827ecb3'), // cdpRatioBps()
        ux.ethCall(controller, '0x1432d93f'), // liqRatioBps()
      ]);
      ratioParams = { mintBps: Number(BigInt(mintWord)), liqBps: Number(BigInt(liqWord)) };
    } catch { /* readout just stays quiet until it can price */ }
    return ratioParams;
  }
  async function selectedCollateralSats() {
    const checked = [...document.querySelectorAll('.cdp-collat-pick:checked')].map((c) => c.getAttribute('data-leaf'));
    const byLeaf = new Map(notes.map((n) => [String(n.leafIndex), n]));
    return checked.reduce((s, lf) => s + BigInt(byLeaf.get(lf)?.value || 0), 0n);
  }
  async function refreshRatio() {
    if (!ratioEl || !controller) return;
    const collatSats = await selectedCollateralSats();
    if (collatSats <= 0n) { ratioEl.textContent = ''; return; }
    const [params, collateralUsdWord] = await Promise.all([
      fetchRatioParams(),
      ux.ethCall(controller, '0xd5901347' + hexWord(collatSats)).catch(() => null), // btcToUsd(uint256)
    ]);
    if (!params || collateralUsdWord == null) { ratioEl.textContent = ''; return; }
    const collateralUsd = BigInt(collateralUsdWord);
    const debtStr = (el('cdp-debt-amount') && el('cdp-debt-amount').value || '').trim();
    let debtUnits = 0n;
    try { debtUnits = debtStr ? parseUnits(debtStr, debtDecimals) : 0n; } catch { /* shown as invalid by the submit path */ }
    const collateralTxt = `${formatUnits(collateralUsd, debtDecimals)} cUSD of collateral`;
    if (debtUnits <= 0n) {
      ratioEl.textContent = `${collateralTxt} selected · needs ≤ ${(10000 / params.mintBps * 100).toFixed(0)}% of that as debt to mint (liquidates at ${(params.liqBps / 100).toFixed(0)}%)`;
      ratioEl.style.color = '';
      return;
    }
    const ratioPct = Number(collateralUsd * 10000n / debtUnits) / 100;
    const safe = ratioPct * 100 >= params.mintBps;
    ratioEl.textContent = `${collateralTxt} → ${ratioPct.toFixed(0)}% ratio`
      + (safe ? ` (mint needs ≥ ${(params.mintBps / 100).toFixed(0)}%, liquidates at ${(params.liqBps / 100).toFixed(0)}%)`
              : ` — below the ${(params.mintBps / 100).toFixed(0)}% mint floor; borrow less or add collateral`);
    ratioEl.style.color = safe ? '' : 'var(--red, #b3261e)';
  }
  document.querySelectorAll('.cdp-collat-pick').forEach((cb) => cb.addEventListener('change', refreshRatio));
  el('cdp-debt-amount')?.addEventListener('input', refreshRatio);
  refreshRatio();

  btn.onclick = async () => {
    if (!wallet || !wallet.priv) { if (statusEl) statusEl.textContent = 'Unlock your wallet first.'; return; }
    if (!controller) return;
    const checked = [...document.querySelectorAll('.cdp-collat-pick:checked')].map((c) => c.getAttribute('data-leaf'));
    const byLeaf = new Map(notes.map((n) => [String(n.leafIndex), n]));
    const idNow = ux.identity(wallet.priv);
    const collateral = checked.map((lf) => {
      const n = byLeaf.get(lf);
      // Each collateral leg spends a note: the guest reconstructs its leaf under the note's OWN owner and
      // nullifies it under the note's secret nullifier key, so both ride the witness (the prover harness reads
      // `leg.owner` / `leg.nk` and refuses to prove without them).
      return { asset: n.asset, cx: n.cx, cy: n.cy, value: n.value, blinding: n.blinding, leafIndex: n.leafIndex, path: n.path, owner: n.owner || idNow.owner, nk: n.secret };
    });
    if (!collateral.length) { if (statusEl) statusEl.textContent = 'Select at least one collateral note.'; return; }
    const debtStr = (el('cdp-debt-amount') && el('cdp-debt-amount').value || '').trim();
    let debtValue;
    try { debtValue = parseUnits(debtStr, debtDecimals); } catch (e) { if (statusEl) statusEl.textContent = e.message; return; }
    if (debtValue <= 0n) { if (statusEl) statusEl.textContent = 'Enter a cUSD amount to borrow.'; return; }
    // Same check the engine makes on-chain (onCdpMint's Undercollateralized revert) — catch it here so a
    // guaranteed-to-fail open never leaves the wallet to a relay round trip first.
    const collatSatsNow = collateral.reduce((s, c) => s + BigInt(c.value), 0n);
    const params = await fetchRatioParams();
    if (params) {
      try {
        const collateralUsdWord = await ux.ethCall(controller, '0xd5901347' + hexWord(collatSatsNow));
        const collateralUsd = BigInt(collateralUsdWord);
        if (debtValue * BigInt(params.mintBps) > collateralUsd * 10000n) {
          if (statusEl) statusEl.textContent = `That would open below the ${(params.mintBps / 100).toFixed(0)}% mint floor `
            + `(this basket supports up to ${formatUnits(collateralUsd * 10000n / BigInt(params.mintBps), debtDecimals)} cUSD). `
            + `Borrow less or select more collateral.`;
          return;
        }
      } catch { /* fall through — worst case the chain re-checks and reverts with the same message */ }
    }
    const root = byLeaf.get(checked[0]).root;
    // Fresh per-position owner (the unlinkable leaf owner the guest publishes for keeper liquidation); the
    // guest's own position-tree nonce is fixed to 0 (unrelated to keyNonce below). Deterministically derived
    // (see derivePositionOwnerPriv) so this position stays recoverable from the identity key alone; keyNonce
    // is simply "the Nth position opened against this controller" so far, taken from the chain (see nextKeyNonce).
    const keyNonce = await nextKeyNonce(ux, wallet.priv, controller);
    const positionOwnerPriv = derivePositionOwnerPriv(wallet.priv, controller, keyNonce);
    const positionOwner = xOnly(positionOwnerPriv);
    // The debt note's blinding and nullifier key derive from the wallet key and the first collateral note's nullifier (the
    // settle spends it), so the note is re-derivable from the key alone as well as through its sealed memo. They are distinct
    // from positionOwner, which authorizes the POSITION, not the debt note (H(debtNk) is the note's leaf owner, per
    // cxfer-core's bearer-note convention). debtNk must still be kept: it is what later spends the note.
    const c0 = collateral[0];
    const anchor = ux.pool.nativeNu(c0.owner, c0.nk, ux.pool.leaf(c0.asset, c0.cx, c0.cy, c0.owner));
    const debtKeys = ux.deriveOutput(wallet.priv, anchor, 'cdpDebt', 0);
    const debtBlinding = debtKeys.blindingHex;
    const debtNk = debtKeys.nk;
    // The engine accepts a snapshot in [RAY, rate()] and charges interest from it, so the live rate is the only
    // value that is both accepted and free of back-interest (RAY while the stability fee is dormant).
    const rateWord = await ux.ethCall(controller, '0x2c4e722e'); // rate()
    if (!/^0x[0-9a-f]{64}$/i.test(String(rateWord || '')) || BigInt(rateWord) < 10n ** 27n) {
      if (statusEl) statusEl.textContent = 'Could not read the engine rate; retry in a moment.';
      return;
    }
    const rateSnapshot = String(rateWord).toLowerCase();
    const cdp = makeConfidentialCdp({ keccak256: keccak_256, pool: ux.pool, signSchnorr });
    const defi = makeConfidentialDefiActions({
      pool: ux.pool, cdp, farm: makeConfidentialFarm({ keccak256: keccak_256, pool: ux.pool }), relay: ux.relay,
      id: ux.identity(wallet.priv), chainBindingHex: ux.chainBindingHex, secp,
    });
    btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Building + settling your position via the relayer…';
    try {
      const r = await defi.openCdp({
        controller, debtValue, rateSnapshot, fee: 0n, collateral,
        spendRoot: root, debtBlinding, positionOwner, debtNk,
        waitOpts: { onUpdate: proveUpdater(statusEl, 'Opening CDP') },
      });
      // Locators only: `keyNonce` re-derives positionOwnerPriv, `debtAnchor` re-derives the debt note's
      // (nk, blinding). Neither secret is written. A descriptor that could not be saved costs nothing but a
      // chain walk — recoverCdpPositions rebuilds the position from the wallet key — so it is not fatal.
      await _posStore.add(wallet.priv, {
        controller, debtValue: debtValue.toString(), nonce: ZERO32, keyNonce, positionOwner, rateSnapshot, debtAnchor: anchor,
        basket: collateral.map((c) => ({ asset: c.asset, value: String(BigInt(c.value)) })),
        openedAt: r && r.txHash || null,
      });
      if (statusEl) statusEl.innerHTML = `Position opened — borrowed ${formatUnits(debtValue, debtDecimals)} cUSD`
        + (r && r.txHash ? ` (<code class="addr">${esc(r.txHash)}</code>)` : '') + '.';
      notify(`Position opened — borrowed ${formatUnits(debtValue, debtDecimals)} cUSD`, 'ok');
      setTimeout(() => renderCdpTab(wallet), 1500);
    } catch (e) {
      // The pre-submit check above catches the common case; this remains for a price move between that
      // check and settle, or the rare feed-just-changed grace window — decode the engine's own revert names
      // rather than show a bare selector/string.
      const m = formatErr(e, 'Open');
      const hint = /Undercollateralized/i.test(m)
        ? `${m} — the collateral's price moved, or another action against it settled first. Refresh and try again.`
        : /BadSnapshot/i.test(m)
        ? `${m} — the engine's rate moved between build and settle. Retry.`
        : /FeedChangeGrace/i.test(m)
        ? `${m} — the price feed just changed; the engine pauses new mints briefly after that. Retry shortly.`
        : m;
      if (statusEl) statusEl.textContent = hint; notify(hint, 'error');
      btn.disabled = false;
    }
  };
}

// Mint a cBTC.zk bearer note against a reflection-recorded self-custody Bitcoin lock.
function renderPendingCbtcLocks() {
  const list = el('cdp-cbtc-pending');
  if (!list) return;
  const pending = loadPendingCbtcLocks();
  if (!pending.length) { list.innerHTML = ''; return; }
  list.innerHTML = pending.map((p, i) => `
    <div class="check-row" style="padding:5px 0;display:flex;justify-content:space-between;gap:8px;align-items:center;">
      <span style="font-size:11.5px;">Locked <code class="addr">${esc(p.lockTxid.slice(0, 12))}…:${p.lockVout}</code> — ${esc(p.vBtc)} sats</span>
      <button class="cbtc-mint-pending-btn" data-i="${i}" style="font-size:11.5px;">Mint</button>
    </div>`).join('');
}

// Sats sitting in live locks are still the user's Bitcoin, but they are not spendable change: coin selection
// skips them, so without this line the wallet simply looks smaller than the chain says it is.
function renderReservedCbtcLocks() {
  const box = el('cdp-cbtc-reserved');
  if (!box) return;
  const locks = listReservedLocks();
  const total = reservedLockSats();
  box.innerHTML = !locks.length ? '' : `${locks.length} live cBTC lock${locks.length === 1 ? '' : 's'}`
    + (total > 0n ? ` — ${esc(total.toString())} sats reserved as collateral` : ' — reserved as collateral')
    + `, held out of ordinary spending until redeemed.`;
}

function wireCbtc(wallet, ux) {
  const lockBtn = el('cdp-cbtc-lock-btn');
  const statusEl = el('cdp-cbtc-status');
  renderPendingCbtcLocks();
  renderReservedCbtcLocks();
  // The local reservation set is browser-scoped; the pool's cbtcLock* records are not. Refresh from chain so
  // a second device, a private window or a cleared cache still knows which outputs must never be spent.
  if (wallet && wallet.priv) {
    ux.syncCbtcLockReservations(wallet.priv).then(renderReservedCbtcLocks).catch(() => {});
  }

  function makeDefi() {
    const cdp = makeConfidentialCdp({ keccak256: keccak_256, pool: ux.pool, signSchnorr });
    return makeConfidentialDefiActions({
      pool: ux.pool, cdp, farm: makeConfidentialFarm({ keccak256: keccak_256, pool: ux.pool }), relay: ux.relay,
      id: ux.identity(wallet.priv), chainBindingHex: ux.chainBindingHex, secp,
    });
  }

  async function mintPending(rec, btn) {
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Minting your cBTC note via the relayer…';
    try {
      const outpoint = cbtcOutpoint(ux.pool, rec.lockTxid, rec.lockVout);
      const r = await makeDefi().mintCbtc({
        outpoint, vBtc: BigInt(rec.vBtc), blinding: rec.blinding,
        waitOpts: { onUpdate: proveUpdater(statusEl, 'Minting cBTC') },
      });
      removePendingCbtcLock(rec.lockTxid);
      renderPendingCbtcLocks();
      if (statusEl) statusEl.innerHTML = `cBTC note minted — ${rec.vBtc} sats`
        + (r && r.txHash ? ` (<code class="addr">${esc(r.txHash)}</code>)` : '') + '.';
      notify(`cBTC note minted — ${rec.vBtc} sats`, 'ok');
    } catch (e) {
      // The most common failure here is timing, not a bug: the lock needs ~6 Bitcoin confirmations AND a
      // reflection fold before OP_CBTC_MINT recognizes it (cbtcLockCommitment[outpoint] unset until then) —
      // surface that plainly rather than a raw revert string, and leave the pending record so retry needs
      // no re-entry.
      const m = formatErr(e, 'cBTC mint');
      const hint = /CbtcLockMismatch|revert/i.test(m)
        ? `${m} — likely still waiting on Bitcoin confirmations + the reflection fold; safe to retry in a few minutes.`
        : m;
      if (statusEl) statusEl.textContent = hint; notify(hint, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  if (lockBtn) {
    lockBtn.onclick = async () => {
      if (!wallet || !wallet.priv) { if (statusEl) statusEl.textContent = 'Unlock your wallet first.'; return; }
      const satsStr = (el('cdp-cbtc-sats') && el('cdp-cbtc-sats').value || '').trim();
      const amountSats = /^[0-9]+$/.test(satsStr) ? BigInt(satsStr) : 0n;
      if (amountSats <= 0n) { if (statusEl) statusEl.textContent = 'Enter the sats amount to lock.'; return; }
      lockBtn.disabled = true;
      if (statusEl) statusEl.textContent = 'Broadcasting your self-custody Bitcoin lock…';
      try {
        const hrp = Number(ux.cfg.chainId) === 1 ? 'bc' : 'tb';
        // Never let a lock fund itself out of an outpoint that is already reserved — above all, an earlier
        // cBTC lock. Spending one of those is read by the fold as a rug and slashes its escrow, and there is
        // no cure path. cbtc-lock-mint also excludes the dust band on its own; this adds what only the tab
        // knows.
        // Refreshed from chain first, not read straight from local storage: on a device that has never held
        // this wallet's locks the cached set is empty, and an empty exclude set is exactly how a new lock
        // funds itself out of an older one. Better to refuse the lock than to build it half-blind.
        try { await ux.syncCbtcLockReservations(wallet.priv); } catch (e) {
          throw new Error(`cannot confirm which of your Bitcoin outputs are live cBTC locks (${(e && e.message) || e}) — `
            + 'retry once Bitcoin history is reachable rather than funding a lock from an unchecked set.');
        }
        const lm = makeCbtcLockMint({
          priv: wallet.priv, pool: ux.pool, cbtcAsset: ux.pool.CBTC_ZK_ASSET_ID, hrp,
          excludeOutpoints: listProtectedOutpoints(),
        });
        const res = await lm.lock({ amountSats });
        // Reserve the lock output from ordinary coin selection as soon as it is broadcast. The lock is a plain
        // spendable UTXO, and spending it outside a redemption retires it against its escrow. Registered here
        // rather than at mint time because the broadcast-to-mint window is when other payments are most likely.
        try { protectOutpoint(res.lockTxid, res.lockVout, res.vBtc); renderReservedCbtcLocks(); } catch {}
        // blinding comes back as a BigInt (deriveCbtcNoteBlinding); JSON.stringify can't serialize that, so
        // store it as hex and convert back to BigInt at mint time.
        addPendingCbtcLock({ ...res, blinding: '0x' + BigInt(res.blinding).toString(16).padStart(64, '0') });
        renderPendingCbtcLocks();
        if (statusEl) statusEl.innerHTML = `Locked <code class="addr">${esc(res.lockTxid)}</code> — waiting on `
          + `confirmations + the reflection fold, then click Mint below.`;
        notify(`cBTC lock broadcast — ${res.vBtc} sats`, 'ok');
      } catch (e) {
        const m = formatErr(e, 'cBTC lock');
        if (statusEl) statusEl.textContent = m; notify(m, 'error');
      } finally {
        lockBtn.disabled = false;
      }
    };
  }

  const pendingList = el('cdp-cbtc-pending');
  if (pendingList) {
    pendingList.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.cbtc-mint-pending-btn');
      if (!btn) return;
      const rec = loadPendingCbtcLocks()[Number(btn.getAttribute('data-i'))];
      if (rec) mintPending(rec, btn);
    });
  }
}

export async function renderCdpTab(wallet) {
  const body = el('cdp-body');
  if (!body) return;
  if (!confidentialPoolReady()) { body.innerHTML = confidentialUnavailableHTML('Borrowing (CDP)'); return; }
  const ux = getUx();
  if (!wallet || !wallet.priv) {
    body.innerHTML = '<div class="muted">Unlock a wallet to open a collateralized position.</div>';
    return;
  }
  const acct = ux.account(wallet.priv);
  body.innerHTML = `
    <div class="tab-form">
    <div class="note-concept"><b>cUSD &amp; cBTC.</b>
      <b>cUSD</b> is the <span class="btc-word">bitcoin-backed dollar</span>: lock cBTC as collateral and mint a
      cUSD note. A position's amounts are public so it can be priced, but its owner is not linked to it.
      <b>cBTC</b> is minted 1:1 from an SP1-reflected Bitcoin lock; tacBTC is its ERC-20 form. A slashable
      wstETH escrow (1.5× the lock today) deters spending the lock; it does not back the peg. Both are ordinary
      shielded notes that transfer, trade and exit like anything else in the pool.</div>
    <div>Account: <code class="addr" style="font-size:11px;">${acct.address}</code></div>
    ${evmAccountHint()}
    <div id="cdp-status" class="muted">Scanning the pool for collateral…</div>

    <div class="divider">
      <div style="font-weight:600;margin-bottom:8px;">Mint cUSD <span class="muted" style="font-weight:400;font-size:11px;">· the bitcoin-backed dollar · borrow against your collateral</span></div>
      <div id="cdp-collat-list" class="muted" style="font-size:12px;margin-bottom:8px;">—</div>
      <div class="field-row">
        <input id="cdp-debt-amount" type="number" min="0" step="any" placeholder="cUSD to borrow, e.g. 100.5">
        <button id="cdp-open-btn" class="primary">Open</button>
      </div>
      <div id="cdp-ratio-readout" class="muted field-status"></div>
      <div id="cdp-open-status" class="muted field-status"></div>
    </div>

    <div class="divider">
      <div style="font-weight:600;margin-bottom:2px;">Get cBTC <span class="muted" style="font-weight:400;font-size:11px;">· lock BTC → 1:1 cBTC, redeemable, no custodian</span></div>
      <div class="muted" style="font-size:12px;margin-bottom:10px;">Your Bitcoin, your key. The lock stays self-custody; cBTC is a bearer note conservation-backed 1:1 by it. Three stages:</div>
      <ol class="cbtc-flow" style="list-style:none;padding:0;margin:0 0 10px;font-size:12.5px;">
        <li style="display:flex;gap:.55em;margin-bottom:7px;"><span class="cbtc-step-n">①</span><span><b>Lock</b> — construct + broadcast a self-custody Bitcoin lock (blinding is key-derived, so the note can never strand).</span></li>
        <li style="display:flex;gap:.55em;margin-bottom:7px;"><span class="cbtc-step-n">②</span><span><b>Track</b> — reflection records the lock once it's buried past finality (~6 confs). No action.</span></li>
        <li style="display:flex;gap:.55em;"><span class="cbtc-step-n">③</span><span><b>Mint</b> — prove <code>OP_CBTC_MINT</code> against the reflected lock → a bearer cBTC note lands in your wallet (gasless). Optionally externalize it to <b>tacBTC</b> (ERC-20) via the factory.</span></li>
      </ol>
      <div style="font-weight:600;margin:6px 0 6px;font-size:12.5px;">① Lock BTC</div>
      <div class="field-row">
        <input id="cdp-cbtc-sats" type="number" min="0" step="1" placeholder="Sats to lock → cBTC 1:1">
        <button id="cdp-cbtc-lock-btn" class="primary">Lock BTC</button>
      </div>
      <div id="cdp-cbtc-pending" style="margin-top:4px;"></div>
      <div id="cdp-cbtc-reserved" class="muted" style="font-size:11.5px;margin-top:4px;"></div>
      <div id="cdp-cbtc-status" class="muted field-status" style="margin-top:6px;"></div>
    </div>

    <div id="cdp-positions" class="divider"></div>
    </div>`;

  wireCbtc(wallet, ux);

  if (el('cdp-status')) el('cdp-status').textContent = 'Scanning the pool…';
  try {
    const { notes, diag } = await ux.balance(wallet.priv);
    const statusEl = el('cdp-status');
    const collat = el('cdp-collat-list');
    // Collateral is picked from this list, so a channel that did not answer is named before the list, not
    // left to read as "you have nothing to post".
    const health = scanHealth(diag);
    const banner = scanHealthHtml(diag, { style: 'margin:6px 0;' });
    // Only cBTC backs a position — CollateralEngine._basketUsd reverts NotCbtcCollateral on anything else —
    // so filter here rather than let the picker offer a note that would fail after a full build + relay round
    // trip with an opaque revert.
    const cbtcAssetId = ux.pool.CBTC_ZK_ASSET_ID;
    const allNotes = notes || [];
    const collatNotes = allNotes.filter((n) => n.asset && n.asset.toLowerCase() === cbtcAssetId.toLowerCase());
    if (!collatNotes.length) {
      if (statusEl) statusEl.textContent = allNotes.length
        ? 'You hold shielded notes, but none are cBTC — only cBTC can back a position. Lock BTC below to get some.'
        : (health.ok
          ? 'No shielded notes to use as collateral — wrap into the pool first.'
          : 'No collateral notes found in the channels this scan could finish.');
      if (collat) collat.innerHTML = banner + '<span class="muted">No cBTC collateral notes yet.</span>';
    } else {
      if (statusEl) statusEl.textContent = `${collatNotes.length} cBTC note${collatNotes.length === 1 ? '' : 's'} available as collateral`;
      if (collat) {
        collat.innerHTML = banner + collatNotes.map((n) => {
          const ticker = ux.tickerOf(n.asset) || 'note';
          const dec = decOf(ux, n.asset);
          return `<label class="check-row" style="padding:5px 0;">
            <input type="checkbox" class="cdp-collat-pick" data-leaf="${n.leafIndex}">
            <span>${fmtUnits(n.value, dec)} ${esc(ticker)} <span class="muted">#${n.leafIndex}</span>${inboundBadgeHtml(n)}</span></label>`;
        }).join('') + inboundSummaryHtml(collatNotes);
      }
    }
    wireOpen(wallet, ux, collatNotes);
  } catch (e) {
    const statusEl = el('cdp-status');
    if (statusEl) statusEl.textContent = 'Could not scan the pool: ' + formatErr(e);
  }

  // Positions, each closable: the CDP position tree is rebuilt from CdpPositionInserted to prove membership,
  // the debt is repaid from the user's cUSD notes, and the basket is released.
  //
  // The chain is the source of truth, this browser's descriptors are a cache. Listing only the local ones
  // meant a user who cleared site data, switched laptops or opened a private window saw NO positions at all,
  // while their collateral sat locked behind cUSD debt with no import path in the UI. `recoverCdpPositions`
  // rebuilds them from key + chain — it is already folded into ux.recover() and covered by tests — so a
  // recovered position that has no local descriptor is merged in and shown rather than silently dropped.
  // Descriptors an older build wrote carry the position's close key (and the debt note's nullifier key) in
  // the clear: rewrite them first — derived where the nonce reproduces them, sealed where it does not.
  if (wallet && wallet.priv) { try { await _posStore.migrate(wallet.priv); } catch { /* left as they were; retried next render */ } }
  const posBox = el('cdp-positions');
  const local = loadPositions().filter((p) => p.controller && ux.cfg.collateralEngine
    && p.controller.toLowerCase() === ux.cfg.collateralEngine.toLowerCase());
  const positions = local.slice();
  try {
    const rec = await ux.recoverCdpPositions({ walletPriv: wallet.priv });
    const seen = new Set(local.map((p) => String(p.positionOwner || '').toLowerCase()));
    for (const p of (rec && rec.positions) || []) {
      const key = String(p.positionOwner || '').toLowerCase();
      if (key && !seen.has(key)) { positions.push({ ...p, recovered: true }); seen.add(key); }
    }
  } catch (e) {
    // A failed walk must not be reported as "no positions": say the list may be incomplete instead.
    if (statusEl) statusEl.textContent = 'Showing locally-saved positions only — the chain walk failed: ' + formatErr(e);
  }
  if (posBox && positions.length) {
    posBox.style.display = '';
    const posCdp = makeConfidentialCdp({ keccak256: keccak_256, pool: ux.pool, signSchnorr });
    const posDebtDecimals = decOf(ux, posCdp.debtAssetId(ux.cfg.collateralEngine));
    posBox.innerHTML = `<div style="font-weight:600;margin-bottom:6px;">Your positions</div>`
      + positions.map((p, i) => `<div class="list-row">
          <span>${formatUnits(BigInt(p.debtValue), posDebtDecimals)} cUSD borrowed · ${p.basket.length} collateral leg${p.basket.length === 1 ? '' : 's'}${p.recovered ? ' · recovered from chain' : ''}</span>
          <span style="flex:0 0 auto;display:inline-flex;gap:6px;">
            <button class="cdp-topup-toggle" data-pos="${i}" style="padding:3px 10px;font-size:10px;">Add collateral</button>
            <button class="cdp-close-one" data-pos="${i}" style="padding:3px 10px;font-size:10px;">Close</button>
          </span></div>
        <div class="cdp-topup-form" data-pos="${i}" style="display:none;padding:6px 0 10px;">
          <div class="cdp-topup-collat-list muted" data-pos="${i}" style="font-size:11.5px;margin-bottom:6px;">loading your cBTC notes…</div>
          <button class="cdp-topup-confirm" data-pos="${i}" style="font-size:10px;padding:3px 10px;">Confirm add</button>
          <div class="cdp-topup-status muted field-status" data-pos="${i}" style="margin-top:4px;"></div>
        </div>`).join('')
      + `<div id="cdp-close-status" class="muted field-status" style="margin-top:6px;"></div>`;
    wireClose(wallet, ux, positions);
    wireTopup(wallet, ux, positions);
  } else if (posBox) {
    // Empty: collapse so the bare .divider top-border doesn't render a stray rule.
    posBox.innerHTML = '';
    posBox.style.display = 'none';
  }
}

// Close a CDP: rebuild the position tree (CdpPositionInserted), prove the position's membership, repay the
// debt from the user's cUSD notes, and release the collateral basket. Drives the REAL buildCdpCloseOp via
// confidential-defi-actions.closeCdp.
function wireClose(wallet, ux, positions) {
  const statusEl = el('cdp-close-status');
  const cdp = makeConfidentialCdp({ keccak256: keccak_256, pool: ux.pool, signSchnorr });
  const defi = makeConfidentialDefiActions({
    pool: ux.pool, cdp, farm: makeConfidentialFarm({ keccak256: keccak_256, pool: ux.pool }), relay: ux.relay,
    id: ux.identity(wallet.priv), chainBindingHex: ux.chainBindingHex, secp,
  });
  const id = ux.identity(wallet.priv);
  for (const btn of document.querySelectorAll('.cdp-close-one')) {
    btn.onclick = async () => {
      const p = positions[Number(btn.getAttribute('data-pos'))];
      if (!p) return;
      btn.disabled = true;
      if (statusEl) statusEl.textContent = 'Rebuilding the position tree + gathering repayment notes…';
      try {
        const controller = p.controller;
        const debtAsset = cdp.debtAssetId(controller);
        const debtDecimals = decOf(ux, debtAsset);
        const debtValue = BigInt(p.debtValue);
        // The position leaf the proof must prove membership for (same derivation buildCdpCloseOp uses).
        const sortedBasket = [...p.basket].sort((a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : 1));
        const basketRootHex = cdp.basketRoot(sortedBasket.map((l) => cdp.basketLeg(l.asset, l.value)));
        const pOwner = p.positionOwner || id.owner; // fresh per-position owner (legacy fallback)
        // The one-time key that signs the owner-authorized close, re-derived from this position's key nonce
        // (and only accepted when it reproduces the owner the position was opened under). A descriptor an
        // older build wrote, or one recoverCdpPositions handed back in memory, still answers from its own copy.
        const pOwnerPriv = await _posStore.ownerPrivFor(wallet.priv, p);
        if (!pOwnerPriv) { if (statusEl) statusEl.textContent = 'This position predates owner-authorized close (no saved key); it can only be liquidated.'; btn.disabled = false; return; }
        const pNonce = p.nonce || ZERO32;
        const positionLeaf = cdp.positionLeaf(controller, debtAsset, basketRootHex, debtValue, p.rateSnapshot, pOwner, pNonce);
        const posTree = await ux.cdpPositionTree();
        const positionIndex = posTree.indexOf(positionLeaf);
        if (positionIndex < 0) { if (statusEl) statusEl.textContent = 'Position not found on-chain yet (still settling?).'; btn.disabled = false; return; }
        const positionPath = posTree.pathFor(positionIndex).path;
        // Repay: every burned debt note is consumed whole and anything above the debt is not returned, so take the
        // smallest single note that covers it, or else the largest notes first (fewest notes, least overshoot).
        const { notes } = await ux.balance(wallet.priv);
        const own = (notes || []).filter((x) => x.asset.toLowerCase() === debtAsset.toLowerCase());
        const byValue = (x, y) => (BigInt(x.value) < BigInt(y.value) ? -1 : BigInt(x.value) > BigInt(y.value) ? 1 : 0);
        const single = own.filter((n) => BigInt(n.value) >= debtValue).sort(byValue)[0];
        const picked = [];
        let sum = 0n;
        for (const n of (single ? [single] : own.sort(byValue).reverse())) {
          picked.push(n);
          sum += BigInt(n.value);
          if (sum >= debtValue) break;
        }
        // The burned debt note is spent under its own secret nullifier key (the harness reads `nk`).
        const debtNotes = picked.map((n) => ({ cx: n.cx, cy: n.cy, value: n.value, blinding: n.blinding, leafIndex: n.leafIndex, path: n.path, owner: n.owner, nk: n.secret }));
        if (sum > debtValue && !window.confirm(`Repaying ${formatUnits(debtValue, debtDecimals)} cUSD uses notes worth ${formatUnits(sum, debtDecimals)}; the extra ${formatUnits(sum - debtValue, debtDecimals)} is not returned. Split a note to the exact amount first to avoid that. Continue anyway?`)) { btn.disabled = false; return; }
        if (sum < debtValue) { if (statusEl) statusEl.textContent = `Need ${formatUnits(debtValue, debtDecimals)} cUSD to repay; you hold ${formatUnits(sum, debtDecimals)}.`; btn.disabled = false; return; }
        const root = (notes.find((x) => x.asset.toLowerCase() === debtAsset.toLowerCase()) || {}).root;
        // One blinding and nk per released leg, derived from the wallet key and the closed position's nullifier — the leaf owner
        // is H(nk), which is what the guest publishes. The opening (including this nk) also rides the sealed memo, so the notes
        // stay recoverable from the wallet key alone even if this browser's localStorage is wiped.
        const posNullifier = cdp.positionNullifier(positionLeaf);
        const releaseKeys = sortedBasket.map((_leg, i) => ux.deriveOutput(wallet.priv, posNullifier, 'cdpRelease', i));
        const releaseBlindings = releaseKeys.map((k) => k.blindingHex);
        const releaseNks = releaseKeys.map((k) => k.nk);
        if (statusEl) statusEl.textContent = 'Building + settling the close via the relayer…';
        await defi.closeCdp({
          controller, debtValue, rateSnapshot: p.rateSnapshot, positionOwner: pOwner, positionOwnerPriv: pOwnerPriv,
          basket: sortedBasket, positionIndex, positionPath, spendRoot: root, cdpPositionRoot: posTree.root,
          fee: 0n, releaseBlindings, releaseNks, debtNotes,
          waitOpts: { onUpdate: proveUpdater(statusEl, 'Closing') },
        });
        // Drop the local descriptor on success.
        // Every position's tree nonce is 0, so the per-position owner is what identifies this one.
        _posStore.remove((x) => x.controller === p.controller && (x.positionOwner || '') === (p.positionOwner || '') && x.debtValue === p.debtValue);
        if (statusEl) statusEl.textContent = 'Position closed — collateral released to your notes.';
        notify('Position closed — collateral released', 'ok');
        setTimeout(() => renderCdpTab(wallet), 1500);
      } catch (e) {
        const m = formatErr(e, 'Close');
        if (statusEl) statusEl.textContent = m; notify(m, 'error');
        btn.disabled = false;
      }
    };
  }
}

// Add collateral to an open position (topupCdp). Same membership-proof shape as close (rebuild the position
// tree, prove the CURRENT leaf), but the position is REPLACED rather than spent: onCdpTopup requires the new
// basket to be worth strictly more than the old one and re-checks the health ratio against it, then the guest
// folds any added leg of an asset the basket already holds into that same leg rather than appending a second
// one (cxfer-core::cdp_topup — v1 only ever has one leg since only cBTC is accepted collateral). Both the old
// and new position leaves use nonce = 0: the wallet-key recovery walk (confidential-recovery.js:walkCdpPositions)
// hardcodes nonce = 0 for every leaf it tries to match, mint or topup alike, because the basket/debt/rate
// differences already make each leaf in a position's lineage unique — a topup that used a different nonce
// would compute a leaf recovery could never find after a wiped browser. Confirmed against the real fixture
// (contracts/sp1/confidential/fixtures/cdp_topup_op.json): oldNonce and newNonce are both zero there too.
function wireTopup(wallet, ux, positions) {
  const cdp = makeConfidentialCdp({ keccak256: keccak_256, pool: ux.pool, signSchnorr });
  const defi = makeConfidentialDefiActions({
    pool: ux.pool, cdp, farm: makeConfidentialFarm({ keccak256: keccak_256, pool: ux.pool }), relay: ux.relay,
    id: ux.identity(wallet.priv), chainBindingHex: ux.chainBindingHex, secp,
  });
  const cbtcAssetId = ux.pool.CBTC_ZK_ASSET_ID;
  // Per-row cache of the fresh cBTC notes fetched when that row's form first opens, so Confirm doesn't have
  // to re-scan (and so the checked leaves stay stable while the user is picking).
  const rowNotes = new Map();
  for (const btn of document.querySelectorAll('.cdp-topup-toggle')) {
    btn.onclick = async () => {
      const i = btn.getAttribute('data-pos');
      const form = document.querySelector(`.cdp-topup-form[data-pos="${i}"]`);
      if (!form) return;
      const opening = form.style.display === 'none';
      form.style.display = opening ? '' : 'none';
      if (!opening || rowNotes.has(i)) return;
      const listEl = document.querySelector(`.cdp-topup-collat-list[data-pos="${i}"]`);
      try {
        const { notes } = await ux.balance(wallet.priv);
        const cbtcNotes = (notes || []).filter((n) => n.asset && n.asset.toLowerCase() === cbtcAssetId.toLowerCase());
        rowNotes.set(i, cbtcNotes);
        if (!listEl) return;
        // Radio, not checkbox: OP_CDP_TOPUP reads one added leg per distinct asset (strictly asset-sorted,
        // no duplicates — contracts/sp1/confidential/src/main.rs's added-legs loop), and v1 has exactly one
        // collateral asset (cBTC), so at most one note can ever be added per top-up. Checking two would always
        // fail deep in proof-building with no clear message, after "Confirm" was already clicked.
        listEl.innerHTML = cbtcNotes.length ? cbtcNotes.map((n) => `<label class="check-row" style="padding:3px 0;">
            <input type="radio" name="cdp-topup-pick-${i}" class="cdp-topup-pick" data-pos="${i}" data-leaf="${n.leafIndex}">
            <span>${fmtUnits(n.value, decOf(ux, n.asset))} cBTC <span class="muted">#${n.leafIndex}</span></span></label>`).join('')
          : `<span class="muted">No spare cBTC notes — lock more BTC above first.</span>`;
      } catch (e) {
        if (listEl) listEl.textContent = 'Could not load collateral: ' + formatErr(e);
      }
    };
  }
  for (const btn of document.querySelectorAll('.cdp-topup-confirm')) {
    btn.onclick = async () => {
      const i = btn.getAttribute('data-pos');
      const p = positions[Number(i)];
      const statusEl = document.querySelector(`.cdp-topup-status[data-pos="${i}"]`);
      if (!p) return;
      const checked = [...document.querySelectorAll(`.cdp-topup-pick[data-pos="${i}"]:checked`)].map((c) => c.getAttribute('data-leaf'));
      if (!checked.length) { if (statusEl) statusEl.textContent = 'Select at least one cBTC note to add.'; return; }
      const notes = rowNotes.get(i) || [];
      const byLeaf = new Map(notes.map((n) => [String(n.leafIndex), n]));
      const idNow = ux.identity(wallet.priv);
      const addedCollateral = checked.map((lf) => {
        const n = byLeaf.get(lf);
        return { asset: n.asset, cx: n.cx, cy: n.cy, value: n.value, blinding: n.blinding, leafIndex: n.leafIndex, path: n.path, owner: n.owner || idNow.owner, nk: n.secret };
      });
      const root = byLeaf.get(checked[0]).root;
      btn.disabled = true;
      if (statusEl) statusEl.textContent = 'Rebuilding the position tree…';
      try {
        const controller = p.controller;
        const debtAsset = cdp.debtAssetId(controller);
        const debtValue = BigInt(p.debtValue);
        const sortedBasket = [...p.basket].sort((a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : 1));
        const basketRootHex = cdp.basketRoot(sortedBasket.map((l) => cdp.basketLeg(l.asset, l.value)));
        const pOwner = p.positionOwner || idNow.owner;
        const pOwnerPriv = await _posStore.ownerPrivFor(wallet.priv, p);
        if (!pOwnerPriv) { if (statusEl) statusEl.textContent = 'This position predates owner-authorized actions (no saved key) — cannot top up.'; btn.disabled = false; return; }
        const positionLeaf = cdp.positionLeaf(controller, debtAsset, basketRootHex, debtValue, p.rateSnapshot, pOwner, ZERO32);
        const posTree = await ux.cdpPositionTree();
        const positionIndex = posTree.indexOf(positionLeaf);
        if (positionIndex < 0) { if (statusEl) statusEl.textContent = 'Position not found on-chain yet (still settling?).'; btn.disabled = false; return; }
        const positionPath = posTree.pathFor(positionIndex).path;
        if (statusEl) statusEl.textContent = 'Building + settling the top-up via the relayer…';
        await defi.topupCdp({
          controller, debtValue, rateSnapshot: p.rateSnapshot, oldBasket: sortedBasket, addedCollateral,
          positionIndex, positionPath, spendRoot: root, cdpPositionRoot: posTree.root,
          positionOwner: pOwner, positionOwnerPriv: pOwnerPriv, oldNonce: ZERO32, newNonce: ZERO32,
          waitOpts: { onUpdate: proveUpdater(statusEl, 'Adding collateral') },
        });
        // Same-asset legs fold into one (mirrors buildCdpTopupOp's merge) — v1 collateral is cBTC-only so this
        // is always a single leg in practice, but the merge is written general.
        const merged = new Map(sortedBasket.map((l) => [l.asset.toLowerCase(), BigInt(l.value)]));
        for (const c of addedCollateral) {
          const k = c.asset.toLowerCase();
          merged.set(k, (merged.get(k) || 0n) + BigInt(c.value));
        }
        const newBasket = [...merged.entries()].map(([asset, value]) => ({ asset, value: value.toString() }));
        _posStore.remove((x) => x.controller === p.controller && (x.positionOwner || '') === (p.positionOwner || '') && x.debtValue === p.debtValue);
        await _posStore.add(wallet.priv, {
          controller, debtValue: p.debtValue, nonce: ZERO32, keyNonce: p.keyNonce, positionOwner: pOwner,
          rateSnapshot: p.rateSnapshot, debtAnchor: p.debtAnchor, basket: newBasket, openedAt: p.openedAt,
        });
        if (statusEl) statusEl.textContent = 'Collateral added ✓';
        notify('Collateral added to position', 'ok');
        setTimeout(() => renderCdpTab(wallet), 1500);
      } catch (e) {
        const m = formatErr(e, 'Add collateral');
        if (statusEl) statusEl.textContent = m; notify(m, 'error');
        btn.disabled = false;
      }
    };
  }
}
