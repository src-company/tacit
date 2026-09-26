// Earn tab — confidential LP + TAC farms on the Ethereum pools. The day-1 incentivized pools pair TAC
// against cETH, cBTC, and cUSD; an LP adds liquidity (OP_LP_ADD) into a shielded LP-share note and bonds it
// into a farm (OP_FARM_BOND) to earn TAC emissions. The one-click path (OP_LP_BOND, op 29) fuses add+bond
// into a single settle — the airdrop golden path: claim TAC → wrap → LP → farm.
//
// This surface reads live pool reserves (ux.poolReserves) and the user's shielded notes (ux.balance) to show
// real positions, and drives ux.lpBond for a one-click farm entry when the FarmController is configured. APR
// is derived from emissions ÷ TVL where the farm emission rate is published; otherwise it reports the
// position without a yield number.

import { secp, sha256, keccak_256 } from './vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from './confidential-pool-ux.js';
import { confidentialPoolReady, confidentialUnavailableHTML, esc, formatSpecErr } from './confidential-deployments.js';
import { scanHealth, scanHealthHtml } from './confidential-scan-health.js';

let _ux = null;
function getUx() {
  return _ux || (_ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256 }));
}
const el = (id) => document.getElementById(id);

function fmtUnits(v, decimals) {
  const s = BigInt(v).toString().padStart(decimals + 1, '0');
  const i = s.slice(0, -decimals) || '0';
  const f = s.slice(-decimals).replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}

// The day-1 incentivized pools: TAC paired against each core asset. Asset ids come from the deployment
// manifest (ux.cfg.assetIds). Returns [] when the manifest hasn't pinned the ids yet.
function dayOnePairs(ux) {
  const ids = (ux.cfg && ux.cfg.assetIds) || {};
  const tac = ids.cTac;
  if (!tac) return [];
  return [
    { label: 'cETH / TAC', a: ids.cEth, b: tac, ta: 'cETH', tb: 'TAC' },
    { label: 'cBTC / TAC', a: ids.cBtc, b: tac, ta: 'cBTC', tb: 'TAC' },
    { label: 'cUSD / TAC', a: ids.cUsd, b: tac, ta: 'cUSD', tb: 'TAC' },
  ].filter((p) => p.a && p.b);
}

// The launch farm's pools come straight from the deployment config: each carries its poolId and fee tier, and the
// pair's assets are read back from the pool itself, so a re-weighted or added pool needs no code change here.
function farmPairs(ux) {
  const farm = ux.cfg && ux.cfg.farm;
  return farm ? (farm.pools || []).map((p) => ({ label: String(p.pair).replace('/', ' / '), poolId: p.poolId, feeBps: p.feeBps })) : [];
}

// GET /farm/health (docs/BUILD-A-TACIT-DAPP.md §"Earn TAC": "a solvency verdict, read from the manager on
// chain") — read-only, never called from this tab before. Flagged as a banner rather than gating the bond
// buttons: a warn-level check (e.g. an idle pool, a pending governor handover) isn't reason enough to block
// a deposit, and a flaky fetch here should never block the feature it's just informing.
async function loadHealth(ux) {
  const box = el('earn-health');
  if (!box || !ux.cfg || !ux.cfg.relayBase) return;
  try {
    const res = await fetch(`${ux.cfg.relayBase}/farm/health`);
    if (!res.ok) return;
    const j = await res.json();
    const health = j && j.health;
    if (!health || health.status === 'ok') return;
    const bad = (health.checks || []).filter((c) => c.status !== 'ok');
    if (!bad.length) return;
    const critical = health.status === 'critical';
    box.innerHTML = `<div class="muted" style="font-size:11px;margin-bottom:10px;padding:6px 8px;border:1px dashed ${critical ? 'var(--red-warn, var(--red))' : 'var(--orange, #c97a1a)'};">
      ${critical ? '⚠ Farm program issue' : 'Farm program notice'}: ${bad.map((c) => esc(c.detail)).join(' · ')}</div>`;
  } catch { /* informational only — a failed fetch says nothing about the farm itself */ }
}

// Your open positions: bond via Earn's one-click path derives the receipt key from the wallet key (see the
// header comment), so ux.farmPositions finds every live position from chain + key alone — no local record
// required, unlike the CDP position store. Offers Harvest (claim reward, keep the position) and Unbond (exit;
// forfeits any un-harvested reward past dust — ux.farmUnbond itself refuses that with a specific message
// unless forfeitPending is passed, so the retry-with-consent flow below relies on that exact wording rather
// than re-deriving the dust threshold client-side).
async function renderPositions(wallet, ux) {
  const box = el('earn-positions');
  if (!box) return;
  let positions = [];
  try {
    positions = await ux.farmPositions({ walletPriv: wallet.priv });
  } catch (e) {
    box.innerHTML = `<div class="muted" style="font-size:11px;">Could not read your farm positions: ${esc(formatSpecErr(e))}</div>`;
    return;
  }
  if (!positions.length) { box.innerHTML = ''; return; }
  const nowSec = Math.floor(Date.now() / 1000);
  box.innerHTML = `<div style="font-weight:600;margin-bottom:6px;font-size:13px;">Your farm positions</div>`
    + positions.map((p, i) => {
      const pairLabel = esc(p.pair || ux.tickerOf(p.lpAsset) || 'LP position');
      const pendingTac = Number(p.pendingTac || 0);
      const pendingLabel = pendingTac > 0 ? `${esc(p.pendingTac)} TAC pending` : 'no reward pending yet';
      const lockedLabel = p.unlockAt && p.unlockAt > nowSec ? ` · locked until ${esc(new Date(p.unlockAt * 1000).toLocaleDateString())}` : '';
      return `<div class="list-row" style="flex-wrap:wrap;gap:8px;padding:6px 0;border-bottom:1px solid var(--hairline,#eee);">
          <span>${pairLabel} · ${esc(p.shares)} shares · ${pendingLabel}${lockedLabel}</span>
          <span style="flex:0 0 auto;display:inline-flex;gap:6px;">
            <button class="earn-harvest-btn" data-i="${i}" style="font-size:10px;padding:3px 10px;" ${pendingTac > 0 ? '' : 'disabled'}>Harvest</button>
            <button class="earn-unbond-btn" data-i="${i}" style="font-size:10px;padding:3px 10px;">Unbond</button>
          </span></div>
        <div class="earn-pos-status muted field-status" data-i="${i}" style="font-size:10px;"></div>`;
    }).join('');
  wirePositions(wallet, ux, positions);
}

function wirePositions(wallet, ux, positions) {
  const statusFor = (i) => document.querySelector(`.earn-pos-status[data-i="${i}"]`);
  document.querySelectorAll('.earn-harvest-btn').forEach((btn) => {
    btn.onclick = async () => {
      const i = Number(btn.dataset.i);
      const p = positions[i];
      const st = statusFor(i);
      btn.disabled = true;
      if (st) st.textContent = 'Harvesting…';
      try {
        const r = await ux.farmHarvest({ walletPriv: wallet.priv, position: p, waitOpts: { onUpdate: (s) => { if (st) st.textContent = `Harvesting ${s.status}…`; } } });
        if (st) st.textContent = 'Harvested ✓ — reward landed as a fresh note.';
        setTimeout(() => renderPositions(wallet, ux), 1500);
      } catch (e) {
        if (st) st.textContent = formatSpecErr(e, 'Harvest');
        btn.disabled = false;
      }
    };
  });
  document.querySelectorAll('.earn-unbond-btn').forEach((btn) => {
    btn.onclick = async () => {
      const i = Number(btn.dataset.i);
      const p = positions[i];
      const st = statusFor(i);
      btn.disabled = true;
      if (st) st.textContent = 'Unbonding…';
      try {
        await ux.farmUnbond({ walletPriv: wallet.priv, position: p, waitOpts: { onUpdate: (s) => { if (st) st.textContent = `Unbonding ${s.status}…`; } } });
        if (st) st.textContent = 'Unbonded — LP shares returned to your notes ✓';
        setTimeout(() => renderPositions(wallet, ux), 1500);
      } catch (e) {
        const msg = (e && e.message) || '';
        if (/would be forfeited/.test(msg)) {
          const proceed = window.confirm(`This position has ${p.pendingTac} TAC pending that hasn't been harvested. Unbonding now forfeits it to the farm's treasury.\n\nClick Cancel to harvest first instead, or OK to unbond anyway and forfeit it.`);
          if (!proceed) {
            if (st) st.textContent = 'Cancelled — harvest first to keep the pending reward.';
            btn.disabled = false;
            return;
          }
          try {
            await ux.farmUnbond({ walletPriv: wallet.priv, position: p, forfeitPending: true, waitOpts: { onUpdate: (s) => { if (st) st.textContent = `Unbonding ${s.status}…`; } } });
            if (st) st.textContent = 'Unbonded (pending reward forfeited) — LP shares returned to your notes ✓';
            setTimeout(() => renderPositions(wallet, ux), 1500);
          } catch (e2) {
            if (st) st.textContent = formatSpecErr(e2, 'Unbond');
            btn.disabled = false;
          }
          return;
        }
        if (st) st.textContent = formatSpecErr(e, 'Unbond');
        btn.disabled = false;
      }
    };
  });
}

export async function renderEarnTab(wallet) {
  const body = el('earn-body');
  if (!body) return;
  if (!confidentialPoolReady()) { body.innerHTML = confidentialUnavailableHTML('Earn (LP + farms)'); return; }
  const ux = getUx();
  if (!wallet || !wallet.priv) {
    body.innerHTML = '<div class="muted">Unlock a wallet to provide liquidity and farm TAC rewards.</div>';
    return;
  }
  body.innerHTML = `
    <div class="note-concept" style="margin-bottom:12px;"><b>Earn TAC, shielded.</b> Provide liquidity to a
      confidential pool and farm <span class="eth-word">TAC</span> rewards. Your LP shares sit in a shielded note; the
      liquidity you add shows in the pool's public reserves. Bond and harvest amounts are also public in the
      farm's own events — what stays private is that your notes aren't linked to your identity, not the amounts.
      Start from TAC you claimed, a note bridged from Bitcoin, or raw ETH; one click adds liquidity and bonds
      the shares into the farm in a single settle.</div>
    <div id="earn-health"></div>
    <div id="earn-positions"></div>
    <div id="earn-pools" class="muted" style="font-size:12px;">Reading pools…</div>
    <div id="earn-status" class="muted" style="font-size:11px;margin-top:10px;"></div>`;

  loadHealth(ux);
  renderPositions(wallet, ux);

  const launch = farmPairs(ux);
  const pairs = launch.length ? launch : dayOnePairs(ux);
  const wrap = el('earn-pools');
  if (!pairs.length) {
    if (wrap) wrap.innerHTML = `<div class="muted" style="font-size:12px;line-height:1.6;">
      The TAC farms (cETH/TAC · cBTC/TAC · cUSD/TAC) appear here once their pools are seeded.
      Meanwhile you can wrap into the <a href="#tab=confidential-pool">confidential pool</a>, claim your
      <a href="#tab=claim">airdrop</a>, or bring value over from <span class="btc-word">Bitcoin</span>.</div>`;
    return;
  }
  const farms = (ux.cfg && ux.cfg.farmControllers) || {};
  const controllerFor = (a, b, feeBps) => farms[String(ux.routePoolId(a, b, feeBps)).toLowerCase()] || null;

  let prog = null;
  if (launch.length) { try { prog = await ux.farmProgram().program(); } catch {} }
  const emissionLine = (p) => {
    // periodFinish lapsed ⇒ rate reads 0 for every pool, indistinguishable from "healthy pool, no emission
    // share" unless this is called out — a user could bond expecting a live APR that's actually already zero.
    if (prog && !prog.epoch.active) {
      return prog.epoch.periodFinish > 0
        ? `Rewards ended ${new Date(prog.epoch.periodFinish * 1000).toLocaleDateString()} — no new TAC streams until the program is topped up.`
        : 'No emission epoch has started for this farm yet.';
    }
    const q = prog && p.poolId && prog.pools.find((x) => x.poolId && x.poolId.toLowerCase() === p.poolId.toLowerCase());
    if (!q) return 'APR — derived once the farm emission rate is published for this pool.';
    return q.idle ? 'No one is farming this pool yet — its whole share of the emission is unclaimed.'
      : `${q.tacPerDayForPool} TAC per day, shared by everyone farming this pool.`;
  };

  let notes = [];
  // Whether a pair can be bonded is decided by the notes this scan found, so a channel that did not answer
  // has to travel with that verdict — "you need a cBTC note" is the wrong thing to say when the cBTC scan
  // is the part that failed.
  let noteHealth = scanHealth(null);
  let scanFailed = false;
  try {
    const bal = await ux.balance(wallet.priv);
    notes = bal.notes || [];
    noteHealth = scanHealth(bal.diag);
    if (!noteHealth.ok && el('earn-status')) el('earn-status').innerHTML = scanHealthHtml(bal.diag, { style: 'margin:0 0 8px;' });
  } catch { scanFailed = true; if (el('earn-status')) el('earn-status').textContent = 'Your notes could not be read, so what you can bond here may be understated. Reopen Earn to scan again.'; }
  // The largest note of each asset: the bond spends both notes whole, so the smaller side sets the size.
  const noteFor = (assetId) => notes.filter((n) => n.asset && assetId && n.asset.toLowerCase() === assetId.toLowerCase())
    .sort((x, y) => (BigInt(y.value) > BigInt(x.value) ? 1 : -1))[0];

  const rows = await Promise.all(pairs.map(async (p, i) => {
    // The day-1 pools are no-skim (fee 0); fall back to the 30-bps tier if a fee pool was added. The reserves
    // read returns the live fee tier so the bond targets the same poolId.
    let reserves = null, feeBps = 0;
    if (p.poolId) {
      try {
        reserves = await ux.poolReserves(p.poolId);
        if (reserves) { feeBps = reserves.feeBps ?? p.feeBps; p.a = reserves.assetA; p.b = reserves.assetB; p.ta = ux.tickerOf(p.a) || 'asset A'; p.tb = ux.tickerOf(p.b) || 'asset B'; }
      } catch {}
    } else {
      for (const tier of [0, 30]) {
        try { const r = await ux.poolReserves(ux.routePoolId(p.a, p.b, tier)); if (r) { reserves = r; feeBps = r.feeBps ?? tier; break; } } catch {}
      }
    }
    const controller = reserves ? controllerFor(p.a, p.b, feeBps) : null;
    const init = !!(reserves && reserves.totalShares > 0n);
    const aNote = noteFor(p.a), bNote = noteFor(p.b);
    const canBond = !!(controller && init && aNote && bNote);
    const why = !reserves ? 'pool not deployed on this network yet'
      : !controller ? 'farm not deployed for this pool yet'
      : !init ? 'pool not initialized'
      : (!aNote || !bNote) ? `need a ${p.ta} note and a ${p.tb} note (wrap into the pool first)`
        + (scanFailed ? ' — your notes could not be read on this pass' : noteHealth.ok ? '' : ` — ${noteHealth.text}`)
      : 'add liquidity & bond into the farm in one transaction';
    p._feeBps = feeBps; p._controller = controller; p._reserves = reserves;
    const tvl = init ? `${reserves.reserveA} / ${reserves.reserveB}` : '—';
    return `
      <div style="border:1px solid var(--hairline,#eee);border-radius:6px;padding:12px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong>${p.label}</strong>
          <span class="muted" style="font-size:11px;">${init ? 'reserves ' + tvl : 'not yet initialized'}</span>
        </div>
        <div class="muted" style="font-size:11px;margin:6px 0;">${emissionLine(p)}</div>
        <button class="earn-bond-btn" data-i="${i}" ${canBond ? '' : 'disabled'} title="${why}"
          style="padding:6px 12px;font-size:13px;cursor:${canBond ? 'pointer' : 'not-allowed'};">Add liquidity &amp; farm</button>
        ${canBond ? '' : `<span class="muted" style="font-size:10px;margin-left:8px;">${why}</span>`}
      </div>`;
  }));
  if (wrap) wrap.outerHTML = `<div id="earn-pools">${rows.join('')}</div>`;

  // Wire the one-click bond buttons.
  document.querySelectorAll('.earn-bond-btn').forEach((btn) => {
    if (btn.disabled) return;
    btn.onclick = async () => {
      const p = pairs[Number(btn.dataset.i)];
      const aNote = noteFor(p.a), bNote = noteFor(p.b);
      const st = el('earn-status');
      if (!aNote || !bNote || !p._controller || !p._reserves) { if (st) st.textContent = 'Notes/farm changed — reopen Earn and retry.'; return; }
      btn.disabled = true;
      try {
        // OP_LP_BOND spends both notes whole and the pool keeps anything off-ratio, so size the larger side down to
        // the pool ratio first (a split transfer) and show both amounts before anything is spent.
        const rA = BigInt(p._reserves.reserveA), rB = BigInt(p._reserves.reserveB);
        const a = BigInt(aNote.value), b = BigInt(bNote.value);
        const aLimited = a * rB <= b * rA;
        const wantA = aLimited ? a : (b * rA + rB - 1n) / rB;
        const wantB = aLimited ? (a * rB + rA - 1n) / rA : b;
        const dec = (t) => Number((ux.assetByTicker[t] || {}).tacitDecimals ?? 8);
        const ok = window.confirm(`Add ${fmtUnits(wantA, dec(p.ta))} ${p.ta} + ${fmtUnits(wantB, dec(p.tb))} ${p.tb} to ${p.label} and bond the shares into the farm?`
          + ((aLimited ? wantB !== b : wantA !== a) ? `\n\nYour ${aLimited ? p.tb : p.ta} note is split first so only the in-ratio amount is added; the rest stays in your wallet.` : ''));
        if (!ok) { btn.disabled = false; return; }
        let sizedA = aNote, sizedB = bNote;
        if (st) st.textContent = 'Sizing your notes to the pool ratio…';
        if (wantA !== a) sizedA = (await ux.ensureExactNote({ walletPriv: wallet.priv, asset: p.a, amount: wantA, notes })).note;
        if (wantB !== b) sizedB = (await ux.ensureExactNote({ walletPriv: wallet.priv, asset: p.b, amount: wantB, notes })).note;
        if (st) st.textContent = `Adding liquidity + bonding ${p.label} into the farm…`;
        const r = await ux.lpBond({
          walletPriv: wallet.priv, controller: p._controller, aNote: sizedA, bNote: sizedB, feeBps: p._feeBps ?? 0,
          // Fee-free bond: the box proves (prove-only) and the user broadcasts settle() from their own EVM
          // account, so there's no relay fee to carve from the bonded liquidity (the relayed path's fee-gate
          // would reject a zero-fee job). The account is already on-chain from the wrap deposits.
          selfRelay: true,
          waitOpts: { onUpdate: (s) => { if (st) st.textContent = `Farm entry ${s.status}…`; } },
        });
        // Remember the position locally so harvest/unbond can find it without a scan. Nothing secret is stored:
        // the receipt key re-derives from the wallet key + (controller, lpAsset, anchorLeaf) via ux.lpBondPosition.
        try {
          const k = 'tacit-lp-bond-positions';
          const list = JSON.parse(localStorage.getItem(k) || '[]');
          list.push({ controller: p._controller, lpAsset: r.lpAsset, anchorLeaf: r.anchorLeaf, receiptLeaf: r.receiptLeaf, receiptOwner: r.receiptOwner, bondNonce: r.bondNonce, shares: String(r.dShares) });
          localStorage.setItem(k, JSON.stringify(list));
        } catch { /* storage unavailable: the position is still recoverable from chain + key */ }
        if (st) st.innerHTML = `Bonded into ${p.label}`
          + (r && r.txHash ? ` (<code style="font-size:10px;word-break:break-all;">${esc(r.txHash)}</code>)` : '')
          + ` — ${r.dShares} LP shares earning TAC.`;
        setTimeout(() => renderEarnTab(wallet), 1500);
      } catch (e) {
        if (st) st.textContent = formatSpecErr(e, 'Farm entry');
        btn.disabled = false;
      }
    };
  });
}
