// TAC's Ethereum trading lane — a swap tile trading ETH against the public TAC ERC20
// (mainnet) alongside the Bitcoin-native order book, for the one asset (TAC) that also
// has real liquidity on Ethereum. Calldata/quoting logic lives entirely in
// evm-trade-venues.js (fork-verified, unit-tested); this module is the DOM half: render
// the tile, debounce quoting, drive the connect → approve → re-quote → simulate → send
// flow, and show a plain-language route summary + venue comparison.
//
// Mount contract: mountEvmTradeLane(host, opts) fills `host` once and is idempotent on
// repeat calls against the same node (guards on host.dataset.evmLaneMounted) — the caller
// can call it unconditionally on every re-render, same as tacit.js's _wireSwapTile does for
// the Bitcoin tile. `opts` is the wallet seam: { address(), connect(), sendTx({from,to,data,
// value}) }. No wallet is required to quote — only to execute.

import { getConfidentialDeployment, esc, formatErr, notify } from './confidential-deployments.js';
import {
  TAC_ERC20, VENUES, makeEvmTradeVenues, zswapDeepLink,
  encErc20Allowance, encErc20Approve, encErc20BalanceOf, decUint256,
} from './evm-trade-venues.js';
import { keccak_256 } from './vendor/tacit-deps.min.js';

const DEBOUNCE_MS = 300;
const BG_REQUOTE_MS = 20000;
const RECEIPT_POLL_MS = 3000;
const RECEIPT_TIMEOUT_MS = 240000;
const ETHERSCAN_TX = (h) => `https://etherscan.io/tx/${h}`;
const ETHERSCAN_TOKEN = `https://etherscan.io/token/${TAC_ERC20}`;
// zswap.wei.limo — zfi's own deploy, confirmed live today (v0.3): reads #token=/out=/amount=,
// no #chain= support yet (mainnet-only page anyway, so that's moot here). Used only as an
// informational "fill there instead" link for resting board orders this tile doesn't execute
// itself — never for the venues this tile already quotes and sends directly.
const ZSWAP_HOST = 'https://zswap.wei.limo';

// ── mainnet RPC — same fallback list confidential-pool-ux.js uses, called
// directly here since this module has no pool deployment and doesn't want to
// pull the whole pool UX in just to reach getConfidentialDeployment('mainnet').rpcs. ──
function _mainnetRpcs() {
  const d = getConfidentialDeployment('mainnet');
  return (d && Array.isArray(d.rpcs)) ? d.rpcs : [];
}
async function rpcCall(method, params, { retryPasses = 2 } = {}) {
  const urls = _mainnetRpcs();
  if (!urls.length) throw new Error('no mainnet RPC endpoints configured');
  let lastErr;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  for (let pass = 0; pass < retryPasses; pass++) {
    if (pass > 0) await new Promise((r) => setTimeout(r, 400 * pass));
    for (const url of urls) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(12000) });
        if (!r.ok) { lastErr = new Error(`rpc ${r.status}`); continue; }
        const j = await r.json();
        if (j && j.error) { lastErr = Object.assign(new Error(j.error.message || 'rpc error'), { data: j.error.data }); continue; }
        return j ? j.result : undefined;
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr || new Error('all mainnet RPCs failed');
}
// ethCall(to, data, block, opts) — the shape evm-trade-venues.js's quoteZQuoter needs
// (opts.gas, kept OUT of any Multicall3 batch — the module handles that split itself).
// Also supports opts.from/opts.value so this same helper serves the pre-send simulate step.
function ethCall(to, data, block = 'latest', callOpts = {}) {
  const call = { to: String(to).toLowerCase(), data };
  if (callOpts.from) call.from = callOpts.from;
  if (callOpts.value) call.value = callOpts.value;
  if (callOpts.gas) call.gas = callOpts.gas;
  const opts = callOpts.retryPasses != null ? { retryPasses: callOpts.retryPasses } : undefined;
  return rpcCall('eth_call', [call, block], opts);
}

const venues = makeEvmTradeVenues({ ethCall, keccak256: keccak_256 });

// ── amount helpers — string round-trip (never through Number) so amounts above
// 2^53-1 don't lose precision, same caution confidential-swap-tab.js takes on BigInt(string). ──
function parseUnitsStr(str, decimals) {
  const s = String(str == null ? '' : str).trim();
  if (s === '' || s === '.' || !/^[0-9]*\.?[0-9]*$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  if (!whole && !frac) return null;
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  try { return BigInt(whole || '0') * (10n ** BigInt(decimals)) + BigInt(fracPadded || '0'); }
  catch { return null; }
}
function formatUnitsStr(value, decimals, maxFrac = 6) {
  if (value == null) return '';
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, '0').slice(0, maxFrac);
  frac = frac.replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}
function short(addr) { return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : ''; }
function venueLabel(v) {
  if (v === VENUES.PRECISION) return 'Precision';
  if (v === VENUES.TACIT_AMM) return 'Tacit AMM';
  if (v === VENUES.ZQUOTER) return 'zQuoter';
  return v || 'unknown';
}
// Error(string) revert — the common case (slippage guards, deadline checks, standard
// ERC20 reverts). Custom errors without an ABI on hand still fall through to the
// generic "would revert" message rather than a raw hex blob.
function decodeRevertReason(err) {
  const raw = (err && (err.data || (err.data && err.data.data))) || '';
  const hex = String(raw || '').replace(/^0x/, '');
  if (hex.slice(0, 8) !== '08c379a0' || hex.length < 8 + 128) return null;
  try {
    const len = parseInt(hex.slice(8 + 64, 8 + 128), 16);
    const strHex = hex.slice(8 + 128, 8 + 128 + len * 2);
    const bytes = (strHex.match(/../g) || []).map((b) => parseInt(b, 16));
    return new TextDecoder().decode(new Uint8Array(bytes)) || null;
  } catch { return null; }
}
async function waitForReceipt(hash, { intervalMs = RECEIPT_POLL_MS, timeoutMs = RECEIPT_TIMEOUT_MS } = {}) {
  const start = Date.now();
  for (;;) {
    let r = null;
    try { r = await rpcCall('eth_getTransactionReceipt', [hash]); } catch { /* transient — keep polling */ }
    if (r) return r;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for confirmation — check Etherscan for the transaction status.');
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

function tileHtml() {
  const flipSvg = `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 1 L4 11 M1.5 8.5 L4 11 L6.5 8.5"></path>
    <path d="M10 13 L10 3 M7.5 5.5 L10 3 L12.5 5.5"></path>
  </svg>`;
  return `
    <div class="evm-lane-tile" data-evm-lane-root>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:bold;">
        <span class="chain-badge eth"><span class="dot"></span>Ethereum</span> <span>ETH / TAC</span>
      </div>
    </div>
    <div class="evm-lane-side" data-lane-side="pay">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px;">
        <span style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--ink-mid);">You pay</span>
        <span data-lane-bal="pay" class="muted" style="font-size:10px;"></span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <input data-lane-input="pay" type="text" inputmode="decimal" placeholder="0" class="evm-lane-input">
        <div class="evm-lane-pill" data-lane-pill="pay"><span data-lane-pill-label="pay">ETH</span></div>
      </div>
    </div>
    <div class="swap-flip-wrap">
      <button data-lane-flip class="swap-flip-btn" type="button" title="Flip direction (ETH ↔ TAC)" aria-label="Flip swap direction">${flipSvg}</button>
    </div>
    <div class="evm-lane-side" data-lane-side="receive">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px;">
        <span style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--ink-mid);">You receive (est.)</span>
        <span data-lane-bal="receive" class="muted" style="font-size:10px;"></span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <input data-lane-input="receive" type="text" inputmode="decimal" placeholder="0" class="evm-lane-input" readonly>
        <div class="evm-lane-pill" data-lane-pill="receive"><span data-lane-pill-label="receive">TAC</span></div>
      </div>
    </div>
    <div class="evm-lane-route muted" data-lane-route>Enter an amount to see the best route.</div>
    <details class="evm-lane-compare" data-lane-compare>
      <summary>Compare venues</summary>
      <div data-lane-compare-body></div>
    </details>
    <div style="display:flex;align-items:center;gap:8px;margin:10px 0;">
      <label style="font-size:10px;display:flex;align-items:center;gap:8px;">
        <span class="muted" style="text-transform:uppercase;letter-spacing:0.08em;">Slippage</span>
        <select data-lane-slippage>
          <option value="10">0.1%</option>
          <option value="50" selected>0.5%</option>
          <option value="100">1%</option>
          <option value="300">3%</option>
        </select>
      </label>
    </div>
    <button data-lane-action type="button" class="primary evm-lane-action" disabled style="display:block;width:100%;">Enter an amount</button>
    <div data-lane-status class="muted evm-lane-status"></div>
    <div class="evm-lane-fine muted">TAC (ERC20): <a href="${ETHERSCAN_TOKEN}" target="_blank" rel="noopener noreferrer">${esc(short(TAC_ERC20))}</a></div>
    </div>`;
}

export function mountEvmTradeLane(host, opts) {
  if (!host) return null;
  // Idempotent: the market page's auto-refresh preserves this node across
  // re-renders (data-evm-trade-lane in tacit.js's preserved-nodes list), and
  // tacit.js calls this on every render regardless — a real rebuild here would
  // wipe an in-progress typed amount + reset the debounce/poll timers.
  if (host.__evmLane) { host.__evmLane.setOpts(opts); return host.__evmLane; }

  host.innerHTML = tileHtml();
  host.dataset.evmLaneMounted = '1';
  const $ = (sel) => host.querySelector(sel);

  const state = {
    dir: 'ETH_TO_TAC',
    amountStr: '',
    slippageBps: 50,
    quote: null,
    quoting: false,
    busy: false,
    debTimer: null,
    bgTimer: null,
    ethBal: null,
    tacBal: null,
    opts,
  };

  function getAddress() {
    try { return state.opts && typeof state.opts.address === 'function' ? state.opts.address() : null; }
    catch { return null; }
  }

  function updateActionButton() {
    const btn = $('[data-lane-action]');
    if (!btn || state.busy) return;
    const amt = parseUnitsStr(state.amountStr, 18);
    if (!amt || amt <= 0n) { btn.disabled = true; btn.textContent = 'Enter an amount'; return; }
    // Connecting doesn't depend on the quote at all, so it must stay clickable even while a
    // quote is in flight (or found no route) — a slow/rate-limited RPC used to block the button
    // entirely, which looked exactly like a hung wallet connection.
    if (!getAddress()) { btn.disabled = false; btn.textContent = 'Connect wallet'; return; }
    if (state.quoting) { btn.disabled = true; btn.textContent = 'Quoting…'; return; }
    if (!state.quote || !state.quote.best) { btn.disabled = true; btn.textContent = 'No route available'; return; }
    btn.disabled = false; btn.textContent = 'Swap';
  }

  function renderCompareRows(q) {
    const outTicker = state.dir === 'ETH_TO_TAC' ? 'TAC' : 'ETH';
    const row = (label, out) => `<div class="evm-lane-compare-row"><span>${esc(label)}</span><span>${out}</span></div>`;
    const amt = (v) => v ? `${esc(formatUnitsStr(v.amountOut, 18, 6))} ${esc(outTicker)}` : 'no route';
    const restingOrders = q.boards && q.boards.restingOrders > 0 ? q.boards.restingOrders : 0;
    // Boards are quote-only here (no fill recipe ported — see evm-trade-venues.js), so a
    // resting order that might beat the executed venue gets a "fill there instead" link rather
    // than a number this tile can't act on itself.
    const boardsOut = restingOrders > 0
      ? (() => {
          const link = zswapDeepLink({ host: ZSWAP_HOST, dir: state.dir, amount: state.amountStr || undefined });
          const label = `${restingOrders} resting order${restingOrders === 1 ? '' : 's'}`;
          return link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(label)} — fill on zSwap ↗</a>` : esc(label);
        })()
      : 'no resting orders';
    const rows = [
      row('Precision', amt(q.precision)),
      row('Tacit AMM', amt(q.tacitAmm)),
      row('zQuoter', (q.zquoter && q.zquoter.status === 'ok') ? amt(q.zquoter) : 'no route'),
      row('Order boards', boardsOut),
    ];
    return rows.join('');
  }

  function renderQuote() {
    const routeEl = $('[data-lane-route]');
    const receiveInput = $('[data-lane-input="receive"]');
    const cmpBody = $('[data-lane-compare-body]');
    const q = state.quote;
    if (!q) {
      if (routeEl) routeEl.textContent = state.quoting ? 'Finding the best route…' : 'Enter an amount to see the best route.';
      if (receiveInput) receiveInput.value = '';
      if (cmpBody) cmpBody.innerHTML = '';
      return;
    }
    const outTicker = state.dir === 'ETH_TO_TAC' ? 'TAC' : 'ETH';
    const inTicker = state.dir === 'ETH_TO_TAC' ? 'ETH' : 'TAC';
    if (q.best) {
      if (receiveInput) receiveInput.value = formatUnitsStr(q.best.amountOut, 18, 8);
      // Display-only rate (a UI hint, not the trade's minOut — build() always derives
      // minOut from the exact bigint quote, so float rounding here never touches funds).
      const rate = Number(formatUnitsStr(q.best.amountOut, 18, 12)) / Number(formatUnitsStr(q.amountIn, 18, 12));
      const feePct = q.best.feeBps != null ? `${(Number(q.best.feeBps) / 100).toFixed(2)}%` : null;
      if (routeEl) routeEl.innerHTML = `via <strong>${esc(venueLabel(q.best.venue))}</strong>`
        + (feePct ? ` · ${esc(feePct)}` : '')
        + ` · 1 ${esc(inTicker)} ≈ ${esc(Number.isFinite(rate) ? rate.toFixed(6) : '?')} ${esc(outTicker)}`;
    } else {
      if (receiveInput) receiveInput.value = '';
      if (routeEl) routeEl.textContent = 'No route found for this amount right now.';
    }
    if (cmpBody) cmpBody.innerHTML = renderCompareRows(q);
  }

  async function refreshBalances() {
    const addr = getAddress();
    const payEl = $('[data-lane-bal="pay"]');
    const recvEl = $('[data-lane-bal="receive"]');
    if (!addr) {
      state.ethBal = null; state.tacBal = null;
      if (payEl) payEl.textContent = '';
      if (recvEl) recvEl.textContent = '';
      return;
    }
    try {
      const [ethHex, tacRaw] = await Promise.all([
        rpcCall('eth_getBalance', [addr, 'latest']),
        ethCall(TAC_ERC20, encErc20BalanceOf(addr)),
      ]);
      state.ethBal = ethHex ? BigInt(ethHex) : 0n;
      state.tacBal = decUint256(tacRaw);
    } catch { /* leave last-known balances on a transient RPC miss */ }
    const balFor = (ticker) => (ticker === 'ETH' ? state.ethBal : state.tacBal);
    const payTicker = state.dir === 'ETH_TO_TAC' ? 'ETH' : 'TAC';
    const recvTicker = state.dir === 'ETH_TO_TAC' ? 'TAC' : 'ETH';
    if (payEl) payEl.textContent = balFor(payTicker) != null ? `balance: ${formatUnitsStr(balFor(payTicker), 18, 6)} ${payTicker}` : '';
    if (recvEl) recvEl.textContent = balFor(recvTicker) != null ? `balance: ${formatUnitsStr(balFor(recvTicker), 18, 6)} ${recvTicker}` : '';
  }

  function applyDirection() {
    const payTicker = state.dir === 'ETH_TO_TAC' ? 'ETH' : 'TAC';
    const recvTicker = state.dir === 'ETH_TO_TAC' ? 'TAC' : 'ETH';
    const payLbl = $('[data-lane-pill-label="pay"]');
    const recvLbl = $('[data-lane-pill-label="receive"]');
    if (payLbl) payLbl.textContent = payTicker;
    if (recvLbl) recvLbl.textContent = recvTicker;
    const payPill = $('[data-lane-pill="pay"]');
    const recvPill = $('[data-lane-pill="receive"]');
    if (payPill) payPill.classList.toggle('eth', payTicker === 'ETH');
    if (recvPill) recvPill.classList.toggle('eth', recvTicker === 'ETH');
    refreshBalances();
  }

  async function doQuote(amt, dirAtCall) {
    state.quoting = true;
    renderQuote(); updateActionButton();
    const addr = getAddress();
    try {
      const result = await venues.quoteAll({ dir: dirAtCall, amountIn: amt, account: addr || undefined, includeZQuoter: true });
      // Stale-response guard: discard if the input or direction moved on since this call started.
      if (state.dir !== dirAtCall || parseUnitsStr(state.amountStr, 18) !== amt) return;
      state.quote = result;
    } catch { /* leave state.quote as-is on a transient failure */ }
    finally {
      state.quoting = false;
      renderQuote(); updateActionButton();
    }
  }

  function scheduleQuote(immediate) {
    if (state.debTimer) { clearTimeout(state.debTimer); state.debTimer = null; }
    const amt = parseUnitsStr(state.amountStr, 18);
    if (!amt || amt <= 0n) {
      state.quote = null; state.quoting = false;
      renderQuote(); updateActionButton();
      return;
    }
    const dirAtCall = state.dir;
    const run = () => { doQuote(amt, dirAtCall); };
    if (immediate) run();
    else state.debTimer = setTimeout(run, DEBOUNCE_MS);
  }

  async function ensureAllowance(built, addr, setStatus) {
    if (!built.approval) return;
    setStatus('Checking TAC allowance…');
    const allowRaw = await ethCall(built.approval.token, encErc20Allowance(addr, built.approval.spender));
    const allowance = decUint256(allowRaw);
    if (allowance >= built.approval.amount) return;
    setStatus('Approve TAC spend — confirm in your wallet…');
    const data = encErc20Approve(built.approval.spender, built.approval.amount);
    const hash = await state.opts.sendTx({ from: addr, to: built.approval.token, data });
    setStatus('Waiting for approval confirmation…');
    await waitForReceipt(hash);
  }

  async function doConnect() {
    const btn = $('[data-lane-action]');
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
    try {
      await state.opts.connect();
      await refreshBalances();
      scheduleQuote(true);
    } catch (e) {
      notify(formatErr(e, 'Connect'), 'error');
    } finally {
      updateActionButton();
    }
  }

  async function doExecute() {
    const statusEl = $('[data-lane-status]');
    const btn = $('[data-lane-action]');
    const setStatus = (s) => { if (statusEl) statusEl.textContent = s; };
    const setStatusHtml = (h) => { if (statusEl) statusEl.innerHTML = h; };
    const addr = getAddress();
    if (!addr) { return doConnect(); }
    const amt = parseUnitsStr(state.amountStr, 18);
    if (!amt || amt <= 0n) return;
    const dirAtCall = state.dir;
    state.busy = true;
    if (btn) btn.disabled = true;
    try {
      // Initial quote (reuse a fresh cached one if present) just to learn the venue
      // shape well enough to know whether an approval is needed at all.
      let quote = state.quote && state.quote.best;
      if (!quote) {
        setStatus('Quoting…');
        const q0 = await venues.quoteAll({ dir: dirAtCall, amountIn: amt, account: addr });
        quote = q0.best;
      }
      if (!quote) throw new Error('No route available for this amount.');
      let built = venues.build({ quote, dir: dirAtCall, account: addr, slippageBps: state.slippageBps });
      await ensureAllowance(built, addr, setStatus);

      // Precision's price can move block-to-block — always re-quote right before the
      // real build, including right after an approval just confirmed.
      setStatus('Re-quoting for the final price…');
      if (btn) btn.textContent = 'Swap';
      const fresh = await venues.quoteAll({ dir: dirAtCall, amountIn: amt, account: addr });
      const freshQuote = fresh.best;
      if (!freshQuote) throw new Error('No route available for this amount.');
      built = venues.build({ quote: freshQuote, dir: dirAtCall, account: addr, slippageBps: state.slippageBps });
      state.quote = fresh;
      renderQuote();
      // Defensive: only re-checks if the fresh route needs a different/larger approval
      // than what's already granted (e.g. the winning venue flipped between quotes).
      await ensureAllowance(built, addr, setStatus);

      setStatus('Simulating…');
      const valueHex = built.value && built.value > 0n ? '0x' + built.value.toString(16) : undefined;
      try {
        await ethCall(built.to, built.data, 'latest', { from: addr, value: valueHex });
      } catch (simErr) {
        const reason = decodeRevertReason(simErr);
        throw new Error(reason || 'Simulation failed — this transaction would revert. Try re-quoting or raising slippage.');
      }

      setStatus('Awaiting wallet signature…');
      const txHash = await state.opts.sendTx({ from: addr, to: built.to, data: built.data, value: valueHex });
      setStatusHtml(`Submitted — <a href="${ETHERSCAN_TX(txHash)}" target="_blank" rel="noopener noreferrer">view on Etherscan</a>. Waiting for confirmation…`);
      const receipt = await waitForReceipt(txHash);
      if (receipt && receipt.status !== '0x1') throw new Error('Transaction reverted on-chain.');
      setStatusHtml(`Swap confirmed — <a href="${ETHERSCAN_TX(txHash)}" target="_blank" rel="noopener noreferrer">view on Etherscan</a>.`);
      notify('Swap confirmed', 'ok');
      state.amountStr = '';
      const payInput = $('[data-lane-input="pay"]');
      if (payInput) payInput.value = '';
      state.quote = null;
      renderQuote();
      await refreshBalances();
    } catch (e) {
      const msg = formatErr(e, 'Swap');
      setStatus(msg);
      notify(msg, 'error');
    } finally {
      state.busy = false;
      updateActionButton();
    }
  }

  // ── wire ──
  const payInput = $('[data-lane-input="pay"]');
  if (payInput) payInput.oninput = () => {
    state.amountStr = payInput.value;
    updateActionButton();
    scheduleQuote(false);
  };
  const flipBtn = $('[data-lane-flip]');
  if (flipBtn) flipBtn.onclick = () => {
    state.dir = state.dir === 'ETH_TO_TAC' ? 'TAC_TO_ETH' : 'ETH_TO_TAC';
    applyDirection();
    state.quote = null;
    renderQuote();
    scheduleQuote(true);
  };
  const slipSel = $('[data-lane-slippage]');
  if (slipSel) slipSel.onchange = (e) => { state.slippageBps = parseInt(e.target.value, 10) || 50; };
  const actionBtn = $('[data-lane-action]');
  if (actionBtn) actionBtn.onclick = () => {
    if (!getAddress()) { doConnect(); return; }
    doExecute();
  };

  applyDirection();
  renderQuote();
  updateActionButton();
  state.bgTimer = setInterval(() => {
    if (state.busy) return;
    if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') return;
    const amt = parseUnitsStr(state.amountStr, 18);
    if (!amt || amt <= 0n) return;
    scheduleQuote(true);
  }, BG_REQUOTE_MS);

  const ctl = {
    setOpts(o) { state.opts = o; updateActionButton(); },
    destroy() {
      if (state.debTimer) clearTimeout(state.debTimer);
      if (state.bgTimer) clearInterval(state.bgTimer);
    },
  };
  host.__evmLane = ctl;
  return ctl;
}
