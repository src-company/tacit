// Points tab — a view of the points program (worker-relay/src/points-indexer.js) for the
// connected Ethereum-derived wallet: total points, today's trend against the daily TAC
// budget, recent point-earning activity, and the running TAC reward — live-claimable
// through PointsDistributor (cumulative-Merkle, same shape as the airdrop's distributor:
// claim(cumulativeAmount, proof)). Every claim is simulated via eth_call right before it's
// ever sent, so a stale or invalid proof fails closed there instead of burning gas on a
// guaranteed on-chain revert.
import { esc, getConfidentialDeployment, formatErr } from './confidential-deployments.js';

const POINTS_BASE = 'https://tacit-points.onrender.com';
const TAB_BODY_ID = 'points-body';
const SEL_CLAIM = '2f52ebb7'; // claim(uint256,bytes32[]) — confirmed against the deployed PointsDistributor's own dispatcher

const ACTIVITY_LABELS = {
  ethwrap: 'Wrapped ETH into the pool',
  zswapeth: 'Swapped ETH via zRouter',
  cbtcmint: 'Minted cBTC',
  cusdmint: 'Minted cUSD',
  pmbet: 'Placed a prediction-market bet',
  pmcreate: 'Created a prediction market',
};
function activityLabel(a) { return ACTIVITY_LABELS[a] || a || 'activity'; }

function fmtPoints(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return v.toLocaleString(undefined, { maximumFractionDigits: v < 10 ? 2 : 0 });
}
// wei -> a plain decimal string, trimmed to at most 6 fractional digits. String-based (never
// through Number) so amounts above 2^53-1 don't lose precision.
function fmtWei(weiStr, maxFrac = 6) {
  let v;
  try { v = BigInt(weiStr || '0'); } catch { return '0'; }
  const neg = v < 0n; if (neg) v = -v;
  const base = 10n ** 18n;
  const whole = v / base;
  let frac = (v % base).toString().padStart(18, '0').slice(0, maxFrac).replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}
function fmtDate(unixSec) {
  const n = Number(unixSec);
  if (!Number.isFinite(n) || n <= 0) return '';
  try { return new Date(n * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return ''; }
}
async function fetchJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ── PointsDistributor calldata — a plain cumulative-Merkle claim, the same shape as
// dapp/confidential-airdrop-claim.js's own distributor (claim/claimTo + a proof array), just a
// different deployed contract. Hand-encoded rather than pulled in as a dependency, matching how
// every other dapp module builds its own narrow slice of calldata rather than sharing an ABI layer. ──
const strip0x = (h) => String(h || '').replace(/^0x/, '');
const word = (v) => (typeof v === 'bigint' ? v : BigInt(v)).toString(16).padStart(64, '0');
const bytes32Word = (h) => strip0x(h).toLowerCase().padStart(64, '0');
function encClaim(cumulativeAmount, proof) {
  const n = proof.length;
  return '0x' + SEL_CLAIM + word(cumulativeAmount) + word(64) + word(n) + proof.map(bytes32Word).join('');
}

function _mainnetRpcs() {
  const d = getConfidentialDeployment('mainnet');
  return (d && Array.isArray(d.rpcs)) ? d.rpcs : [];
}
async function rpcCall(method, params) {
  const urls = _mainnetRpcs();
  let lastErr;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined });
      const j = await r.json();
      if (j && j.error) { lastErr = Object.assign(new Error(j.error.message || 'rpc error'), { data: j.error.data }); continue; }
      return j ? j.result : undefined;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all mainnet RPCs failed');
}
function ethCall(to, data, opts = {}) {
  const call = { to, data };
  if (opts.from) call.from = opts.from;
  return rpcCall('eth_call', [call, 'latest']);
}
// PointsDistributor.sol's own custom errors (selectors computed with `cast sig`, cross-checked
// against contracts/src/PointsDistributor.sol) — the ones a claim can plausibly hit.
const CLAIM_REVERTS = {
  '9e87fac8': 'Claiming is paused right now.',
  '67a2cc26': 'Invalid recipient.',
  '7ca55c77': 'Your claim proof no longer matches the published root — refresh the page and try again.',
  '797dba54': 'Nothing owed — this has likely already been claimed.',
};
function decodeRevertReason(err) {
  const raw = (err && (err.data || (err.data && err.data.data))) || '';
  const hex = strip0x(raw);
  const sel = hex.slice(0, 8);
  if (CLAIM_REVERTS[sel]) return CLAIM_REVERTS[sel];
  if (sel !== '08c379a0' || hex.length < 8 + 128) return null;
  try {
    const len = parseInt(hex.slice(8 + 64, 8 + 128), 16);
    const strHex = hex.slice(8 + 128, 8 + 128 + len * 2);
    const bytes = (strHex.match(/../g) || []).map((b) => parseInt(b, 16));
    return new TextDecoder().decode(new Uint8Array(bytes)) || null;
  } catch { return null; }
}
async function waitForReceipt(hash, { intervalMs = 3000, timeoutMs = 240000 } = {}) {
  const start = Date.now();
  for (;;) {
    let r = null;
    try { r = await rpcCall('eth_getTransactionReceipt', [hash]); } catch { /* transient — keep polling */ }
    if (r) return r;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for confirmation — check Etherscan for the transaction status.');
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

function boostTag(mult, label) {
  const m = Number(mult);
  if (!Number.isFinite(m) || m <= 1) return '';
  return `<span style="font-size:9px;padding:1px 6px;margin-left:4px;border:1px solid var(--orange);color:var(--orange);border-radius:8px;" title="${esc(label)}">${esc(m.toFixed(2))}×</span>`;
}

function renderBody(addr, points, claim) {
  const total = points && Number.isFinite(points.points) ? points.points : 0;
  const today = points && points.today;
  const deposits = (points && Array.isArray(points.deposits)) ? points.deposits.slice(0, 12) : [];

  const todayHtml = today
    ? `<div class="muted" style="margin-top:4px;">Today: <strong>${esc(fmtPoints(today.points))}</strong> pts, out of ${esc(fmtPoints(today.totalPoints))} pts earned network-wide against a ${esc(fmtWei(today.dayBudgetWei, 0))} TAC daily budget.</div>`
    : '';

  const rowsHtml = deposits.length
    ? deposits.map((d) => `
        <div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px dashed var(--hairline);font-size:12px;">
          <span>${esc(activityLabel(d.activity))}${boostTag(d.tac_boost, 'TAC holder boost')}${boostTag(d.z_share_boost, 'zSwap share boost')}</span>
          <span class="muted">${esc(fmtDate(d.block_time))}</span>
          <span><strong>+${esc(fmtPoints(d.points))}</strong> pts</span>
        </div>`).join('')
    : '<div class="muted" style="padding:8px 0;">No point-earning activity yet from this address.</div>';

  const cumulativeWei = claim && claim.cumulativeAmount ? claim.cumulativeAmount : '0';
  const unclaimedWei = claim && claim.unclaimedWei ? claim.unclaimedWei : '0';
  const claimLive = !!(claim && claim.distributor);
  const hasUnclaimed = claimLive && (() => { try { return BigInt(unclaimedWei) > 0n; } catch { return false; } })();
  const claimHtml = `
    <div class="section" style="margin-top:14px;">
      <div class="section-header">TAC reward</div>
      <div class="section-body" style="font-size:13px;">
        <div>Running total: <strong>${esc(fmtWei(cumulativeWei))} TAC</strong></div>
        ${claimLive
          ? `<div class="muted" style="margin-top:4px;">Unclaimed: ${esc(fmtWei(unclaimedWei))} TAC.</div>`
          : `<div class="muted" style="margin-top:4px;">This is a running entitlement, not yet claimable on-chain — the reward distributor hasn't been deployed. It'll show a claim button here once it is.</div>`}
        ${hasUnclaimed ? `
          <button type="button" data-points-claim class="primary" style="margin-top:10px;">Claim ${esc(fmtWei(unclaimedWei))} TAC</button>
          <div data-points-claim-status class="muted" style="margin-top:6px;"></div>` : ''}
      </div>
    </div>`;

  return `
    <div class="section">
      <div class="section-header">Points <span class="mono-box inline" style="font-size:10px;">${esc(addr.slice(0, 6))}…${esc(addr.slice(-4))}</span></div>
      <div class="section-body">
        <div style="font-size:28px;font-weight:bold;">${esc(fmtPoints(total))}</div>
        ${todayHtml}
        <div class="muted" style="margin-top:10px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;">Recent activity</div>
        <div style="margin-top:4px;">${rowsHtml}</div>
      </div>
    </div>
    ${claimHtml}`;
}

export async function renderPointsTab(wallet, helpers = {}) {
  const body = document.getElementById(TAB_BODY_ID);
  if (!body) return;
  const eth = helpers.eth || {};
  const addr = (() => { try { return typeof eth.address === 'function' ? eth.address() : null; } catch { return null; } })();

  if (!addr) {
    body.innerHTML = `
      <div class="muted" style="margin-bottom:10px;">
        Points track your Ethereum-derived wallet's activity in the confidential pool — wrapping ETH,
        swapping through zRouter, minting cBTC/cUSD, and prediction-market participation. Connect it
        to see your total.
      </div>
      <button type="button" data-points-connect class="primary">Connect Ethereum wallet</button>
      <div data-points-error class="muted" style="margin-top:8px;color:var(--orange);"></div>`;
    const btn = body.querySelector('[data-points-connect]');
    const errEl = body.querySelector('[data-points-error]');
    if (btn) btn.onclick = async () => {
      btn.disabled = true; btn.textContent = 'Connecting…';
      if (errEl) errEl.textContent = '';
      try {
        await eth.connect();
        await renderPointsTab(wallet, helpers);
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Connect Ethereum wallet';
        if (errEl) errEl.textContent = (e && e.message) || String(e);
      }
    };
    return;
  }

  body.innerHTML = '<div class="muted">Loading…</div>';
  const [points, claim] = await Promise.all([
    fetchJson(`${POINTS_BASE}/points/${addr}`),
    fetchJson(`${POINTS_BASE}/claim/${addr}`),
  ]);
  if (!points) {
    body.innerHTML = '<div class="muted">Could not load points right now — try again shortly.</div>';
    return;
  }
  body.innerHTML = renderBody(addr, points, claim);

  const claimBtn = body.querySelector('[data-points-claim]');
  const statusEl = body.querySelector('[data-points-claim-status]');
  const setStatus = (s) => { if (statusEl) statusEl.textContent = s; };
  const setStatusHtml = (h) => { if (statusEl) statusEl.innerHTML = h; };
  if (claimBtn) claimBtn.onclick = async () => {
    claimBtn.disabled = true;
    try {
      // Re-fetch right before sending rather than reusing the page-load `claim` object — the
      // proof must match whatever root is currently published, and simulating (below) against a
      // stale proof would just waste an RPC round-trip on a guaranteed revert.
      setStatus('Checking your claim…');
      const fresh = await fetchJson(`${POINTS_BASE}/claim/${addr}`);
      if (!fresh || !fresh.distributor) throw new Error('Claiming is not available right now.');
      const distributor = fresh.distributor;
      let cumulativeAmount;
      try { cumulativeAmount = BigInt(fresh.cumulativeAmount || '0'); } catch { cumulativeAmount = 0n; }
      const proof = Array.isArray(fresh.proof) ? fresh.proof : [];
      if (cumulativeAmount <= 0n || !proof.length) throw new Error('Nothing to claim right now.');
      const data = encClaim(cumulativeAmount, proof);
      setStatus('Simulating…');
      try { await ethCall(distributor, data, { from: addr }); }
      catch (simErr) {
        const reason = decodeRevertReason(simErr);
        throw new Error(reason || 'This claim would revert on-chain right now. Refresh the page and try again.');
      }
      setStatus('Awaiting wallet signature…');
      const txHash = await eth.sendTx({ from: addr, to: distributor, data });
      setStatusHtml(`Submitted — <a href="https://etherscan.io/tx/${txHash}" target="_blank" rel="noopener noreferrer">view on Etherscan</a>. Waiting for confirmation…`);
      const receipt = await waitForReceipt(txHash);
      if (receipt && receipt.status !== '0x1') throw new Error('Transaction reverted on-chain.');
      setStatusHtml(`Claimed — <a href="https://etherscan.io/tx/${txHash}" target="_blank" rel="noopener noreferrer">view on Etherscan</a>.`);
      await renderPointsTab(wallet, helpers);
    } catch (e) {
      claimBtn.disabled = false;
      setStatus(formatErr(e, 'Claim'));
    }
  };
}
