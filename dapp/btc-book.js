// The Bitcoin order book for one asset, as a plain data model: normalize the worker's
// listings and bids into asks/bids a trader can actually fill, and plan market orders
// against them. No DOM, no globals, no network — btc-market.js renders and executes,
// tests/btc-book.test.mjs pins the behaviour.
//
// Amounts are base units (bigint). A unit price is sats per whole token (Number) and is
// only ever used to sort, bound and display; every sats figure that reaches a signer is
// recomputed from the listing's own integer price_sats with the same integer math the
// executors in tacit.js use.

export const DUST = 546;
// Atomic offers older than this rarely have a maker online to confirm a claim.
export const STALE_INTENT_SEC = 12 * 3600;
// Never route into something that expires before a take could confirm.
export const EXPIRY_GUARD_SEC = 60;
// A seller's claim on a bid reserves it for 30 minutes and the worker refuses one whose
// bid ends sooner, so bids inside that window can't be sold into.
export const BID_CLAIM_WINDOW_SEC = 1800 + 120;
// Display-only network fee estimates (the executors price the real fee at broadcast).
export const FEE_EST_TAKE_SATS = 800;
export const FEE_EST_BATCH_EXTRA_SATS = 250;
export const FEE_EST_SELL_SATS = 1600;

const toBig = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };
const pow10 = (d) => 10n ** BigInt(d);

export function unitPrice(priceSats, amountBase, decimals) {
  const p = Number(priceSats);
  const a = toBig(amountBase);
  if (!Number.isFinite(p) || p <= 0 || a <= 0n) return null;
  return (p * Math.pow(10, decimals)) / Number(a);
}

// floor(amount × priceSats / fullAmount) — the scaling fulfilBidIntent and the
// variable-intent claim both use for a partial fill.
export function scaledSats(fillBase, priceSats, fullBase) {
  const full = toBig(fullBase);
  if (full <= 0n) return 0;
  return Number((toBig(fillBase) * toBig(priceSats)) / full);
}

// Base units buyable for `sats` at `unit` sats/token, rounded down.
export function amountForSats(sats, unit, decimals) {
  if (!(unit > 0) || !(sats > 0)) return 0n;
  const scaledUnit = BigInt(Math.max(1, Math.round(unit * 1e8)));
  return (BigInt(Math.floor(sats)) * pow10(decimals) * 100_000_000n) / scaledUnit;
}

// Sats for `amountBase` at `unit`, rounded down.
export function satsForAmount(amountBase, unit, decimals) {
  if (!(unit > 0)) return 0;
  const scaledUnit = BigInt(Math.max(1, Math.round(unit * 1e8)));
  return Number((toBig(amountBase) * scaledUnit) / (pow10(decimals) * 100_000_000n));
}

export function parseAmount(text, decimals) {
  const s = String(text ?? '').trim().replace(/[,_\s]/g, '');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [w, f = ''] = s.split('.');
  const frac = f.slice(0, decimals).padEnd(decimals, '0');
  const v = BigInt(w || '0') * pow10(decimals) + BigInt(frac || '0');
  return v;
}

export function fmtAmount(base, decimals, maxFrac = decimals) {
  const a = toBig(base);
  const neg = a < 0n;
  const abs = neg ? -a : a;
  const div = pow10(decimals);
  let whole = abs / div;
  let frac = abs % div;
  if (maxFrac < decimals) {
    const cut = pow10(decimals - maxFrac);
    frac = frac / cut;
    decimals = maxFrac;
  }
  const fracStr = decimals > 0 ? frac.toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return (neg ? '-' : '') + whole.toLocaleString('en-US') + (fracStr ? '.' + fracStr : '');
}

export function fmtUnit(u) {
  if (u == null || !Number.isFinite(u)) return '—';
  if (u >= 1000) return u.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (u >= 10) return u.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (u >= 1) return u.toLocaleString('en-US', { maximumFractionDigits: 3 });
  if (u > 0) return Number(u.toPrecision(3)).toString();
  return '0';
}

export function fmtSats(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

// ── normalization ───────────────────────────────────────────────────────────

// ctx: { assetId, decimals, myPubHex, myH160, nowSec, varIntents, takenIds:Set }
export function normalizeAsks(listings, ctx) {
  const { assetId, decimals, myPubHex = null, myH160 = null, nowSec, varIntents = false } = ctx;
  const taken = ctx.takenIds || new Set();
  const asks = [];
  const excluded = { expired: 0, claimed: 0, stale: 0, otc: 0, disabled: 0, reserved: 0, taken: 0, invalid: 0 };
  for (const l of listings || []) {
    if (!l || (l.asset_id && l.asset_id !== assetId)) continue;
    if (l.kind !== 'preauth' && l.kind !== 'intent') { excluded.otc++; continue; }
    const expiry = Number(l.expiry || 0);
    if (l.expired || expiry <= nowSec + EXPIRY_GUARD_SEC) { excluded.expired++; continue; }
    if (l.kind === 'preauth') {
      const id = 'p:' + l.sale_id;
      if (l._takenPending || taken.has(id)) { excluded.taken++; continue; }
      const amount = toBig(l.asset_opening?.amount);
      const sats = Number(l.min_price_sats || 0);
      const unit = unitPrice(sats, amount, decimals);
      if (unit == null || !Number.isInteger(sats) || sats < DUST) { excluded.invalid++; continue; }
      asks.push({
        id, kind: 'preauth', unit, amount, sats, fullAmount: amount, minTake: null,
        whole: true, instant: true, mine: !!myPubHex && l.seller_pubkey === myPubHex,
        expiry, createdAt: Number(l.created_at || 0), maker: l.seller_pubkey || '', raw: l,
      });
    } else if (l.kind === 'intent') {
      const id = 'i:' + l.intent_id;
      if (l._takenPending || taken.has(id)) { excluded.taken++; continue; }
      const tgt = String(l.intended_buyer_h160 || '').toLowerCase();
      const rcp = String(l.recipient_pubkey || '').toLowerCase();
      const forMe = (tgt && tgt === myH160) || (rcp && rcp === myPubHex);
      if ((tgt || rcp) && !forMe) { excluded.reserved++; continue; }
      const mine = !!myPubHex && l.maker_pubkey === myPubHex;
      if (!mine && (l.claim || l.fulfilment_pending)) { excluded.claimed++; continue; }
      if (!mine && nowSec - Number(l.created_at || 0) > STALE_INTENT_SEC) { excluded.stale++; continue; }
      const fullAmount = toBig(l.amount);
      const sats = Number(l.price_sats || 0);
      const unit = unitPrice(sats, fullAmount, decimals);
      if (unit == null || !Number.isInteger(sats) || sats < DUST) { excluded.invalid++; continue; }
      const variable = l.min_take_amount != null && l.min_take_amount !== '' && l.min_take_amount !== '0';
      if (variable && !varIntents) { excluded.disabled++; continue; }
      const amount = variable ? toBig(l.remaining_amount ?? l.amount) : fullAmount;
      if (amount <= 0n) { excluded.invalid++; continue; }
      asks.push({
        id, kind: variable ? 'intent-var' : 'intent', unit, amount,
        sats: variable ? scaledSats(amount, sats, fullAmount) : sats,
        fullAmount, fullSats: sats, minTake: variable ? toBig(l.min_take_amount) : null,
        whole: !variable, instant: false, mine,
        expiry, createdAt: Number(l.created_at || 0), maker: l.maker_pubkey || '', raw: l,
      });
    }
  }
  asks.sort(compareAsks);
  return { asks, excluded };
}

// Cheapest first; on a tie, instant (walk-away) listings before ones a maker must
// confirm, then older first so earlier makers keep priority.
export function compareAsks(a, b) {
  if (a.unit !== b.unit) return a.unit - b.unit;
  if (a.instant !== b.instant) return a.instant ? -1 : 1;
  return a.createdAt - b.createdAt;
}

// ctx: { decimals, myPubHex, nowSec, autoBidIds:Set }
export function normalizeBids(bids, ctx) {
  const { decimals, myPubHex = null, nowSec } = ctx;
  const autoIds = ctx.autoBidIds || new Set();
  const out = [];
  const excluded = { expired: 0, closed: 0, claimed: 0, invalid: 0 };
  for (const b of bids || []) {
    if (!b || !b.bid_id) continue;
    const expiry = Number(b.expiry || 0);
    if (expiry <= nowSec + EXPIRY_GUARD_SEC) { excluded.expired++; continue; }
    const mine = !!myPubHex && b.buyer_pubkey === myPubHex;
    if (!mine && expiry <= nowSec + BID_CLAIM_WINDOW_SEC) { excluded.expired++; continue; }
    const fullAmount = toBig(b.amount);
    const priceSats = Number(b.price_sats || 0);
    const unit = unitPrice(priceSats, fullAmount, decimals);
    if (unit == null || !Number.isInteger(priceSats)) { excluded.invalid++; continue; }
    const variable = b.min_fill_amount != null && b.min_fill_amount !== '' && b.min_fill_amount !== '0';
    let amount = fullAmount;
    let minFill = fullAmount;
    if (variable) {
      amount = toBig(b.remaining_amount ?? b.amount);
      minFill = toBig(b.min_fill_amount);
      if (!mine && String(b.state || '').toUpperCase() === 'CLOSED') { excluded.closed++; continue; }
      if (!mine && amount < minFill) { excluded.closed++; continue; }
    } else if (!mine && b.claim && Number(b.claim.expires_at || 0) > nowSec) {
      excluded.claimed++; continue;
    }
    if (amount <= 0n) { excluded.closed++; continue; }
    out.push({
      id: 'b:' + b.bid_id, kind: variable ? 'bid-var' : 'bid', unit, amount, minFill, fullAmount, priceSats,
      sats: scaledSats(amount, priceSats, fullAmount),
      mine, auto: !!b.watchtower || autoIds.has(b.bid_id),
      expiry, createdAt: Number(b.created_at || 0), raw: b,
    });
  }
  out.sort(compareBids);
  return { bids: out, excluded };
}

export function compareBids(a, b) {
  if (a.unit !== b.unit) return b.unit - a.unit;
  if (a.auto !== b.auto) return a.auto ? -1 : 1;
  return a.createdAt - b.createdAt;
}

export function buildBook(input) {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const ctx = { ...input, nowSec };
  const { asks, excluded: askEx } = normalizeAsks(input.listings, ctx);
  const { bids, excluded: bidEx } = normalizeBids(input.bids, ctx);
  const bestAsk = asks.length ? asks[0].unit : null;
  const bestBid = bids.length ? bids[0].unit : null;
  const mid = bestAsk != null && bestBid != null ? (bestAsk + bestBid) / 2 : null;
  return {
    assetId: input.assetId, decimals: input.decimals, nowSec,
    asks, bids, bestAsk, bestBid, mid,
    spread: bestAsk != null && bestBid != null ? bestAsk - bestBid : null,
    overlap: bestAsk != null && bestBid != null && bestBid > bestAsk,
    excluded: { asks: askEx, bids: bidEx },
  };
}

// Group rows that would print identically (same displayed price, same flags) so the
// ladder shows one line per level with a count, not one per UTXO.
export function ladderLevels(rows, side) {
  const out = [];
  const byKey = new Map();
  for (const r of rows) {
    const flag = side === 'ask'
      ? (r.mine ? 'mine' : r.instant ? (r.whole ? 'lot' : 'part') : 'maker')
      : (r.mine ? 'mine' : r.auto ? 'auto' : 'manual');
    const key = fmtUnit(r.unit) + '|' + flag;
    let lvl = byKey.get(key);
    if (!lvl) {
      lvl = { key, unit: r.unit, flag, amount: 0n, sats: 0, count: 0, rows: [] };
      byKey.set(key, lvl);
      out.push(lvl);
    }
    lvl.amount += r.amount;
    lvl.sats += r.sats;
    lvl.count++;
    lvl.rows.push(r);
  }
  return out;
}

// ── planning ────────────────────────────────────────────────────────────────

// Market buy. Exactly one of spendSats / receiveBase.
//   spendSats   — never spend more than this; whole lots that don't fit are skipped.
//   receiveBase — cheapest route to at least this much; a whole lot may overshoot a
//                 little, but never by more than the amount still needed.
// maxUnit caps every fill's price. Own offers are never routed.
export function planBuy(book, { spendSats = null, receiveBase = null, maxUnit = Infinity, includeIntents = true, excludeIds = null } = {}) {
  const dec = book.decimals;
  const skip = excludeIds || new Set();
  const cands = book.asks.filter((a) => !a.mine && !skip.has(a.id) && a.unit <= maxUnit && (includeIntents || a.instant));
  const fills = [];
  const skipped = [];
  let sats = 0;
  let amount = 0n;
  if (spendSats != null) {
    const budget = Math.floor(spendSats);
    for (const a of cands) {
      const room = budget - sats;
      if (room < DUST) break;
      if (a.whole) {
        if (a.sats > room) { skipped.push({ ask: a, reason: 'too-big' }); continue; }
        fills.push({ ask: a, amount: a.amount, sats: a.sats, unit: a.unit });
        sats += a.sats; amount += a.amount;
      } else {
        let want = (BigInt(room) * a.fullAmount) / BigInt(a.fullSats);
        if (want > a.amount) want = a.amount;
        if (want < a.minTake) { skipped.push({ ask: a, reason: 'too-small' }); continue; }
        const s = scaledSats(want, a.fullSats, a.fullAmount);
        if (s < DUST || s > room) { skipped.push({ ask: a, reason: 'too-small' }); continue; }
        fills.push({ ask: a, amount: want, sats: s, unit: a.unit });
        sats += s; amount += want;
      }
    }
  } else if (receiveBase != null) {
    const target = BigInt(receiveBase);
    for (const a of cands) {
      const need = target - amount;
      if (need <= 0n) break;
      if (a.whole) {
        if (a.amount > need * 2n && a.amount - need > need) { skipped.push({ ask: a, reason: 'too-big' }); continue; }
        fills.push({ ask: a, amount: a.amount, sats: a.sats, unit: a.unit });
        sats += a.sats; amount += a.amount;
      } else {
        let want = need < a.amount ? need : a.amount;
        if (want < a.minTake) want = a.minTake <= a.amount ? a.minTake : 0n;
        if (want <= 0n) { skipped.push({ ask: a, reason: 'too-small' }); continue; }
        const s = scaledSats(want, a.fullSats, a.fullAmount);
        if (s < DUST) { skipped.push({ ask: a, reason: 'too-small' }); continue; }
        fills.push({ ask: a, amount: want, sats: s, unit: a.unit });
        sats += s; amount += want;
      }
    }
  } else {
    throw new Error('planBuy needs spendSats or receiveBase');
  }
  const aboveMax = book.asks.filter((a) => !a.mine && !skip.has(a.id) && a.unit > maxUnit).length;
  const preauthFills = fills.filter((f) => f.ask.kind === 'preauth').length;
  const intentFills = fills.length - preauthFills;
  const feesEst = (preauthFills > 1 ? FEE_EST_TAKE_SATS + FEE_EST_BATCH_EXTRA_SATS * (preauthFills - 1) : preauthFills * FEE_EST_TAKE_SATS)
    + intentFills * FEE_EST_TAKE_SATS;
  return {
    side: 'buy',
    mode: spendSats != null ? 'spend' : 'receive',
    fills, amount, sats,
    avgUnit: amount > 0n ? (sats * Math.pow(10, dec)) / Number(amount) : null,
    worstUnit: fills.reduce((m, f) => Math.max(m, f.unit), 0) || null,
    leftoverSats: spendSats != null ? Math.max(0, Math.floor(spendSats) - sats) : 0,
    shortBase: receiveBase != null && amount < BigInt(receiveBase) ? BigInt(receiveBase) - amount : 0n,
    overBase: receiveBase != null && amount > BigInt(receiveBase) ? amount - BigInt(receiveBase) : 0n,
    skipped, aboveMax, feesEst,
    needsMaker: intentFills > 0,
  };
}

// Market sell into bids. includeManual adds bids whose owner has to be online to
// settle (no watchtower); by default only bids that settle on their own are used.
export function planSell(book, { sellBase, minUnit = 0, includeManual = false, excludeIds = null } = {}) {
  const dec = book.decimals;
  const skip = excludeIds || new Set();
  const target = BigInt(sellBase);
  const cands = book.bids.filter((b) => !b.mine && !skip.has(b.id) && b.unit >= minUnit && (includeManual || b.auto));
  const fills = [];
  const skipped = [];
  let sats = 0;
  let amount = 0n;
  for (const b of cands) {
    const left = target - amount;
    if (left <= 0n) break;
    let fill;
    if (b.kind === 'bid') {
      if (b.amount > left) { skipped.push({ bid: b, reason: 'too-big' }); continue; }
      fill = b.amount;
    } else {
      fill = left < b.amount ? left : b.amount;
      if (fill < b.minFill) { skipped.push({ bid: b, reason: 'too-small' }); continue; }
    }
    const s = scaledSats(fill, b.priceSats, b.fullAmount);
    if (s < DUST) { skipped.push({ bid: b, reason: 'too-small' }); continue; }
    fills.push({ bid: b, amount: fill, sats: s, unit: b.unit });
    sats += s; amount += fill;
  }
  const manualAvailable = book.bids.filter((b) => !b.mine && !b.auto && !skip.has(b.id) && b.unit >= minUnit).length;
  return {
    side: 'sell',
    fills, amount, sats,
    avgUnit: amount > 0n ? (sats * Math.pow(10, dec)) / Number(amount) : null,
    worstUnit: fills.length ? fills.reduce((m, f) => Math.min(m, f.unit), Infinity) : null,
    leftoverBase: target > amount ? target - amount : 0n,
    skipped, manualAvailable: includeManual ? 0 : manualAvailable,
    feesEst: fills.length * FEE_EST_SELL_SATS,
    needsBidder: fills.some((f) => !f.bid.auto),
  };
}

// A re-plan made after the user confirmed may run without asking again only if it
// stays inside what they agreed to: no more sats and no worse price (buy), or no more
// tokens and no worse price (sell).
export function withinBounds(plan, bounds) {
  if (!plan || !plan.fills.length) return false;
  if (plan.side === 'buy') {
    if (plan.sats > bounds.maxSats) return false;
    return plan.fills.every((f) => f.unit <= bounds.maxUnit * (1 + 1e-9));
  }
  if (plan.amount > bounds.maxBase) return false;
  return plan.fills.every((f) => f.unit >= bounds.minUnit * (1 - 1e-9));
}

// Price a limit order would rest at relative to the book, for the ticket's hint.
export function limitCrossesBook(book, side, unit) {
  if (!(unit > 0)) return false;
  if (side === 'buy') return book.bestAsk != null && unit >= book.bestAsk;
  return book.bestBid != null && unit <= book.bestBid;
}

// Split a sell listing into k equal walk-away lots (2..7, as publishPreauthSaleChunks
// takes them) so buyers can take part of it; k = 1 when splitting would push a lot
// under 2×dust. An indivisible remainder of a few base units stays in the wallet.
export function listingShape(amountBase, unit, decimals) {
  const amt = BigInt(amountBase);
  const totalSats = satsForAmount(amt, unit, decimals);
  if (amt <= 0n || totalSats < DUST) return { k: 0, totalSats, listedBase: 0n };
  for (let k = 7; k >= 2; k--) {
    const perLotBase = amt / BigInt(k);
    const perLotSats = satsForAmount(perLotBase, unit, decimals);
    if (perLotBase <= 0n || perLotSats < DUST * 2) continue;
    return { k, perLotBase, perLotSats, listedBase: perLotBase * BigInt(k), totalSats: perLotSats * k };
  }
  return { k: 1, perLotBase: amt, perLotSats: totalSats, listedBase: amt, totalSats };
}
