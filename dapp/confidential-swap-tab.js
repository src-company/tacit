// Confidential Swap tab — shielded swap tile on the Ethereum lane (World B: pool notes).
//
// Intent-first From→To: pick a note to spend and a destination asset, and the tile finds the best route
// against the confidential pool — automatically selecting the fee tier that returns the most output — then
// settles gasless through the relay. Every outcome is a shielded note; the tile never routes into the
// real-sats order book or the bridge (those are explicit, linked, cross-world moves).
//
// A swap is a 1-hop confidential route (confidential-route.js, OP_SWAP_ROUTE): the input note + final output
// stay notes, the trade clears against the pool's live on-chain reserves (read via ux.quoteRoute), gasless
// through the relay. planBestRoute() is the same-venue best-execution seam; when more venues are live it is
// where cross-venue-router.js (already built) plugs in without touching the UI.
//
// VERIFICATION: getAmountOut + reserve decode are deterministic and unit-checked; the op shape mirrors the
// guest's OP_SWAP_ROUTE. Pools appear as assets beyond cETH wrap into the pilot — until then the surface
// honestly reports "no route" rather than faking a market.

import { secp, sha256, keccak_256 } from './vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from './confidential-pool-ux.js';
import { confidentialPoolReady, confidentialUnavailableHTML, esc, formatSpecErr, notify, decOf, shownTicker, lockedWalletHTML, wireUnlockButton } from './confidential-deployments.js';
import { formatUnits } from './confidential-payout.js';
import { scanHealth, scanHealthHtml, inboundBadgeText, inboundSummaryHtml } from './confidential-scan-health.js';

let _ux = null;
function getUx() {
  return _ux || (_ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256}));
}
const el = (id) => document.getElementById(id);

// Fee tiers probed for best execution, most-liquid first. A single confidential-AMM venue today, so
// "best route" == best tier; the seam generalizes to cross-venue-router.bestExactIn when more venues exist.
const FEE_TIERS = [30, 5, 100, 1];

// Best single-hop route between two pool assets: probe each fee tier, keep the largest output. Returns
// { feeBps, amountOut } or null when no tier has a pool. Pure quote orchestration — no signing/settling.
async function planBestRoute(ux, fromAsset, toAsset, amountIn) {
  let best = null;
  for (const feeBps of FEE_TIERS) {
    try {
      const q = await ux.quoteRoute({ asset0: fromAsset, amountIn, path: [{ assetNext: toAsset, feeBps }] });
      if (q && q.amountOut > 0n && (!best || q.amountOut > best.amountOut)) best = { feeBps, amountOut: q.amountOut };
    } catch { /* tier without a pool → skip */ }
  }
  return best;
}

export async function renderSwapTab(wallet, helpers = {}) {
  const body = el('cswap-body');
  if (!body) return;
  if (!confidentialPoolReady()) { body.innerHTML = confidentialUnavailableHTML('Confidential swaps'); return; }
  const ux = getUx();
  const conceptHtml = `<div class="note-concept"><b>Swap, shielded.</b> Trade one note for another against the
      confidential AMM — your note balances stay private, but a swap settled on its own moves the pool's public
      reserves by exactly your trade, so its input and output amounts are visible on-chain. It clears on the
      <span class="eth-word">Ethereum</span> lane and settles gasless. Instant and note-to-note: you end up holding a <b>shielded note</b>, not real coins.
      To trade for <span class="btc-word">real sats</span> on Bitcoin, use the <a href="#tab=market">order book</a>.</div>`;
  if (!wallet || !wallet.priv) {
    // Same wallet as every other Ethereum-lane surface — keeps the concept blurb visible even locked, so
    // the tab explains itself instead of dead-ending on a one-line "unlock a wallet" message.
    body.innerHTML = conceptHtml + lockedWalletHTML('swap', 'cswap-unlock-btn');
    wireUnlockButton('cswap-unlock-btn', helpers);
    return;
  }
  const assetOptions = (ux.assets || []).map((a) => `<option value="${a.assetId}">${esc(shownTicker(a.ticker))}</option>`).join('');
  body.innerHTML = `
    <div class="tab-form">
    ${conceptHtml}
    <div id="cswap-notes" class="muted">Scanning your notes…</div>
    <div class="divider">
      <label class="field-label" for="cswap-from">From note</label>
      <select id="cswap-from"></select>
      <label class="field-label" for="cswap-toasset" style="margin-top:10px;">To asset</label>
      <select id="cswap-toasset">${assetOptions}</select>
      <div id="cswap-amount-info" class="muted" style="font-size:11px;margin-top:8px;"></div>
      <button id="cswap-quote" style="margin-top:6px;">Quote</button>
      <div id="cswap-quoteout" class="muted" style="font-size:12px;margin-top:8px;"></div>
      <button id="cswap-btn" class="primary" style="margin-top:8px;" disabled>Swap</button>
      <label class="check-row" style="margin-top:10px;">
        <input id="cswap-selfrelay" type="checkbox">
        <span>Self-relay (broadcast from your own EVM account if the relayer is unavailable — reveals that account on-chain)</span>
      </label>
      <div id="cswap-status" class="muted field-status"></div>
      <div class="muted" style="font-size:11px;margin-top:12px;padding-top:8px;border-top:1px dashed var(--ink-faint);">
        Want <span class="btc-word">real sats</span>? Trade on the <a href="#tab=market">order book</a>.
        Moving a note to <span class="btc-word">Bitcoin</span>? Use the bridge; tETH crosses 1:1.
      </div>
    </div>
    </div>`;

  let lastQuote = null;
  if (el('cswap-notes')) el('cswap-notes').textContent = 'Scanning the pool…';
  try {
    const { notes, diag } = await ux.balance(wallet.priv);
    const sel = el('cswap-from');
    // A select can hold no markup, so an inbound note carries its label in the option text itself.
    if (sel) sel.innerHTML = (notes || []).map((n) => `<option value="${n.leafIndex}">${esc(formatUnits(n.value, decOf(ux, n.asset)))} ${esc(ux.tickerOf(n.asset) || n.asset.slice(0, 8))} #${n.leafIndex}${esc(inboundBadgeText(n))}</option>`).join('');
    // What the scan could not reach is named beside the count, so a short list is not read as the whole wallet.
    el('cswap-notes').innerHTML = esc((notes && notes.length)
      ? `${notes.length} shielded note(s) available`
      : (scanHealth(diag).ok ? 'No shielded notes yet — wrap into the pool first.' : 'No notes found in the channels this scan could finish.'))
      + scanHealthHtml(diag, { style: 'margin:6px 0;' }) + inboundSummaryHtml(notes || []);
    const byLeaf = new Map((notes || []).map((n) => [String(n.leafIndex), n]));

    // route()'s change path is not implemented (buildRoute throws 'partial-spend change is not yet
    // implemented' rather than returning change), so the only amount that can ever settle is the note's
    // full value — there is no valid partial-swap path today. Showing it as fixed info rather than a typed
    // amount field removes both the raw-throw risk and a decimal-parsing surface at once; to swap less than
    // a note's full value, split it with a self-send first (Send tab), then swap the smaller note.
    const amountInfo = () => {
      const n = byLeaf.get((el('cswap-from') || {}).value);
      const infoEl = el('cswap-amount-info');
      if (!infoEl) return;
      infoEl.textContent = n
        ? `Swaps the whole note: ${formatUnits(n.value, decOf(ux, n.asset))} ${ux.tickerOf(n.asset) || ''} (partial swaps aren't supported — split the note via Send first if you want to swap less).`
        : '';
    };
    amountInfo();
    // Any change to what's selected invalidates a quote taken against the OLD selection — without this,
    // re-picking the note or destination after quoting left Swap enabled and executing the stale quote's
    // note/asset/amount instead of what the form now shows.
    const invalidateQuote = () => {
      lastQuote = null;
      const btn = el('cswap-btn');
      if (btn) btn.disabled = true;
      const out = el('cswap-quoteout');
      if (out) out.textContent = '';
    };
    if (el('cswap-from')) el('cswap-from').addEventListener('change', () => { amountInfo(); invalidateQuote(); });
    if (el('cswap-toasset')) el('cswap-toasset').addEventListener('change', invalidateQuote);

    const quoteBtn = el('cswap-quote');
    if (quoteBtn) quoteBtn.onclick = async () => {
      const out = el('cswap-quoteout');
      const n = byLeaf.get((el('cswap-from') || {}).value);
      const toAsset = ((el('cswap-toasset') || {}).value || '').trim();
      const amountIn = n ? BigInt(n.value) : 0n;
      el('cswap-btn').disabled = true;
      lastQuote = null;
      if (!n || !/^0x[0-9a-fA-F]{64}$/.test(toAsset) || amountIn <= 0n) { if (out) out.textContent = 'Pick a note and a destination asset.'; return; }
      if (n.asset.toLowerCase() === toAsset.toLowerCase()) { if (out) out.textContent = 'Pick a different destination asset.'; return; }
      if (out) out.textContent = 'Finding the best route…';
      try {
        const best = await planBestRoute(ux, n.asset, toAsset, amountIn);
        if (!best) { if (out) out.textContent = 'No pool for that pair yet.'; return; }
        // Re-check the form still matches what was quoted — a slow route probe racing a user's edit
        // shouldn't arm Swap against a selection that's since changed.
        const stillN = byLeaf.get((el('cswap-from') || {}).value);
        const stillTo = ((el('cswap-toasset') || {}).value || '').trim();
        if (!stillN || stillN.leafIndex !== n.leafIndex || stillTo.toLowerCase() !== toAsset.toLowerCase()) return;
        lastQuote = { note: n, toAsset, amountIn, feeBps: best.feeBps, amountOut: best.amountOut };
        const toTicker = ux.tickerOf(toAsset) || toAsset.slice(0, 8);
        const toDec = decOf(ux, toAsset);
        if (out) out.innerHTML = `Receive ≈ <strong>${esc(formatUnits(best.amountOut, toDec))}</strong> ${esc(toTicker)}`
          + ` <span class="muted">· route: pool @ ${best.feeBps}bps · settles as a shielded note · min-out applies 1% slippage</span>`;
        el('cswap-btn').disabled = false;
      } catch (e) { if (out) out.textContent = formatSpecErr(e, 'Quote'); }
    };

    const swapBtn = el('cswap-btn');
    if (swapBtn) swapBtn.onclick = async () => {
      const st = el('cswap-status');
      if (!lastQuote) { if (st) st.textContent = 'Get a quote first.'; return; }
      // Belt-and-suspenders: the change listeners above already clear lastQuote/disable Swap on any edit,
      // but re-confirm the live form still matches what's about to be built, in case of a wiring gap.
      const n = byLeaf.get((el('cswap-from') || {}).value);
      const toAsset = ((el('cswap-toasset') || {}).value || '').trim();
      if (!n || n.leafIndex !== lastQuote.note.leafIndex || toAsset.toLowerCase() !== lastQuote.toAsset.toLowerCase()) {
        if (st) st.textContent = 'The form changed since that quote — get a fresh quote first.';
        lastQuote = null; swapBtn.disabled = true;
        return;
      }
      const minOut = (lastQuote.amountOut * 99n) / 100n; // 1% slippage guard
      swapBtn.disabled = true;
      if (st) st.textContent = 'Building + settling your swap via the relayer…';
      try {
        const selfRelay = !!(el('cswap-selfrelay') && el('cswap-selfrelay').checked);
        const r = await ux.route({
          walletPriv: wallet.priv, inNote: lastQuote.note, amountIn: lastQuote.amountIn,
          path: [{ assetNext: lastQuote.toAsset, feeBps: lastQuote.feeBps }], minOut, selfRelay,
          waitOpts: { onUpdate: (s) => { if (st) st.textContent = `Swap ${s.status}…`; } },
        });
        if (st) st.innerHTML = 'Swap settled'
          + (r && r.txHash ? ` (<code class="addr">${esc(r.txHash)}</code>)` : '') + '.';
        notify('Swap settled', 'ok');
        setTimeout(() => renderSwapTab(wallet), 1500);
      } catch (e) { const m = formatSpecErr(e, 'Swap'); if (st) st.textContent = m; notify(m, 'error'); }
      finally { swapBtn.disabled = false; }
    };
  } catch (e) {
    el('cswap-notes').textContent = 'Could not scan the pool: ' + (e && e.message || e);
  }
}
