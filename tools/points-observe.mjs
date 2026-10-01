#!/usr/bin/env node
// Points program observer: how the daily pot, the pools, the farms and the airdrop sit against each other. Read-only:
// the points service's public API plus public RPC, no explorer calls.
//
//   node tools/points-observe.mjs [--quick]      (--quick skips the per-wallet history behind the daily table)
//
// Env: POINTS_API (default https://tacit-points.onrender.com), RPC (mainnet, comma-separated), RPC_8453, RPC_4663.
import { makeRpc, checkFarm, publicProgram, FARM_RPCS_MAINNET } from '../worker-relay/src/lib/farm-health.js';

const API = process.env.POINTS_API || 'https://tacit-points.onrender.com';
const quick = process.argv.includes('--quick');
const L1 = process.env.RPC ? process.env.RPC.split(',').map((s) => s.trim()).filter(Boolean) : FARM_RPCS_MAINNET;
const BASE = process.env.RPC_8453 || 'https://mainnet.base.org';
const ROBINHOOD = process.env.RPC_4663 || '';

const A = {
  tac: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', airdrop: '0x4b4cb98D0C836c2783Ac46f0078b904dab533AE8',
  ops: '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2', wtac: '0x2018139a8fdd3666855be3315c7683b4d6ab7aef',
  distributor: '0x000000C918e44A3a443937fA7594eA4f7C95D6b9', precisionFarm: '0x0000003bF4BA0B21f5e0d35119b337F4d4CF82E0',
  precisionPool: '0x0155358241411dB868BA714aE7c83A27087e3D6E', v1Pool: '0x000000000Ed1eabD231Be41d93b719056F7febFC',
  evmPool: '0x000000c2A20657CE25f2Ba99737933D031AFBEE9',
};
const SEL = { balanceOf: '0x70a08231', totalSupply: '0x18160ddd', rewardRate: '0x7b0a47ee', periodFinish: '0xebe2b12b', reserved: '0xfe60d12c', totalStaked: '0x817b1cd2' };
const word = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const rpc = makeRpc(L1);
const n = (hex) => BigInt(hex);
const bal = (token, holder) => rpc.call(token, SEL.balanceOf + word(holder), 'latest').then(n);
async function ethBalance(url, address) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }), signal: AbortSignal.timeout(10000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return BigInt(j.result);
}
const get = async (path) => { const r = await fetch(API + path, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(`${path} HTTP ${r.status}`); return r.json(); };
const tac = (w, d = 1) => (Number(w) / 1e18).toLocaleString('en-US', { maximumFractionDigits: d });
const eth = (w, d = 3) => (Number(w) / 1e18).toFixed(d);
const day = (d) => new Date(d * 86400e3).toISOString().slice(5, 10);
const section = (t) => console.log(`\n== ${t}`);
async function part(title, fn) { section(title); try { await fn(); } catch (e) { console.log(`  unavailable: ${e?.message || e}`); } }

const state = {};

await part('pipeline and funding', async () => {
  const [h, r] = await Promise.all([get('/health'), get('/rewards')]);
  Object.assign(state, { r });
  console.log(`  service ${h.ok ? 'ok' : 'NOT OK'} | program day ${r.currentDay - r.programStartDay + 1}/${r.programDays} | settled through ${day(r.lastSettledDay)} | published ${r.publishedTotalWei === r.totalLedgerWei ? '= ledger' : 'BEHIND the ledger'} (${tac(r.totalLedgerWei)} TAC)`);
  if (r.rateCapSchedule?.length) console.log(`  rate ceiling: ${r.rateCapSchedule.map((e) => `${e.maxWeiPerPoint ? tac(e.maxWeiPerPoint, 3) : 'off'} TAC/pt from ${day(e.fromDay)}`).join(', ')}`);
  if (r.adjustments?.length) console.log(`  ledger credits applied: ${r.adjustments.map((a) => `${tac(a.wei)} TAC`).join(', ')}`);
  const f = r.funding;
  if (!f) { console.log('  funding: not reported'); return; }
  console.log(`  distributor funding ${f.verdict.toUpperCase()}: holds ${tac(f.heldWei)} + claimed ${tac(f.claimedWei)} vs ledger ${tac(f.ledgerWei)} -> headroom ${tac(f.headroomWei)} TAC = ${f.daysCovered} whole day(s)`);
  console.log(f.topUpBeforeSec ? `  next top-up due before ${new Date(f.topUpBeforeSec * 1000).toISOString().slice(0, 16)} UTC (about 1,111 TAC per payable day; a week is ~7,778)` : '  SHORT: the next publish is held back until more TAC is sent');
});

if (!quick) await part('days, retention and mix (program days)', async () => {
  const lb = await get('/leaderboard?limit=500');
  const rows = [];
  for (const e of lb) { const p = await get(`/points/${e.address}`); for (const d of p.deposits) rows.push({ a: e.address, day: Math.floor(d.block_time / 86400), act: d.activity || 'wrap', pts: d.points, eth: Number(d.amount_wei) / 1e18 }); await new Promise((r) => setTimeout(r, 30)); }
  const r = state.r, start = r.programStartDay;
  const cap = r.rateCapSchedule?.filter((e) => e.fromDay <= r.currentDay).pop()?.maxWeiPerPoint;
  const prog = rows.filter((x) => x.day >= start);
  const first = new Map(); for (const x of [...prog].sort((a, b) => a.day - b.day)) if (!first.has(x.a)) first.set(x.a, x.day);
  console.log('  day    points  wallets new  top1%  top3%  TAC/pt  mix');
  for (const d of [...new Set(prog.map((x) => x.day))].sort()) {
    const by = new Map(); const mix = new Map();
    for (const x of prog.filter((y) => y.day === d)) { by.set(x.a, (by.get(x.a) || 0) + x.pts); mix.set(x.act, (mix.get(x.act) || 0) + x.pts); }
    const v = [...by.values()].sort((a, b) => b - a), tot = v.reduce((s, y) => s + y, 0);
    const pot = Math.min(100000 / 90, cap ? (Number(cap) / 1e18) * tot : Infinity);
    console.log(`  ${day(d)} ${tot.toFixed(0).padStart(8)} ${String(by.size).padStart(7)} ${String([...by.keys()].filter((a) => first.get(a) === d).length).padStart(3)} ${(100 * v[0] / tot).toFixed(0).padStart(5)} ${(100 * v.slice(0, 3).reduce((s, y) => s + y, 0) / tot).toFixed(0).padStart(6)}  ${(pot / tot).toFixed(4).padStart(6)}  ${[...mix].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, y]) => `${k}:${(100 * y / tot).toFixed(0)}%`).join(' ')}`);
  }
  const daysBy = new Map(); for (const x of prog) (daysBy.get(x.a) || daysBy.set(x.a, new Set()).get(x.a)).add(x.day);
  const once = [...daysBy.values()].filter((s) => s.size === 1).length;
  console.log(`  wallets ${daysBy.size}: one day only ${once} (${(100 * once / daysBy.size).toFixed(0)}%), came back ${daysBy.size - once}`);
});

await part('pools: ETH held, and what came in against what stayed', async () => {
  const live = { v1: await ethBalance(L1[0], A.v1Pool).catch(() => null), evm1: await ethBalance(L1[0], A.evmPool).catch(() => null), evmBase: await ethBalance(BASE, A.evmPool).catch(() => null), evmRobinhood: ROBINHOOD ? await ethBalance(ROBINHOOD, A.evmPool).catch(() => null) : null };
  state.live = live;
  const parts = Object.entries(live).filter(([, v]) => v != null);
  const total = parts.reduce((s, [, v]) => s + v, 0n);
  console.log(`  now: ${parts.map(([k, v]) => `${k} ${eth(v)}`).join(' | ')} | total ${eth(total)} ETH${ROBINHOOD ? '' : ' (Robinhood not read: set RPC_4663)'}`);
  try {
    const t = await get('/tvl?days=14');
    const closed = t.days.filter((d) => d.netChangeWei != null && d.complete);
    for (const d of closed.slice(-7)) console.log(`  ${day(d.day)}: pools started ${eth(BigInt(d.totalEthWei))} ETH, scored deposits ${eth(BigInt(d.grossDepositsWei), 2)}, net change ${Number(d.netChangeWei) >= 0 ? '+' : ''}${eth(BigInt(d.netChangeWei), 3)}`);
    if (!closed.length) console.log(`  daily readings so far: ${t.days.length} (a day closes when the next one is read)`);
  } catch (e) { console.log(`  /tvl not available yet (${e.message})`); }
});

await part('farms, airdrop and TAC', async () => {
  const [farm, supply, airdrop, ops, wtac, pFarm, pPoolTac, pPoolEth, dist] = await Promise.all([
    checkFarm({ rpc }), rpc.call(A.tac, SEL.totalSupply, 'latest').then(n), bal(A.tac, A.airdrop), bal(A.tac, A.ops), bal(A.tac, A.wtac),
    bal(A.tac, A.precisionFarm), bal(A.tac, A.precisionPool), ethBalance(L1[0], A.precisionPool), bal(A.tac, A.distributor),
  ]);
  const ep = publicProgram(farm.program).epoch ?? {};
  console.log(`  private farms ${farm.health.status}: ${ep.ratePerDayTac} TAC/day, ${(Number(ep.remainingSeconds) / 86400).toFixed(0)} days of emission, treasury ${Number(ep.treasuryTac).toLocaleString('en-US', { maximumFractionDigits: 0 })} vs ${Number(ep.requiredTac).toLocaleString('en-US', { maximumFractionDigits: 0 })} required`);
  const rate = await rpc.call(A.precisionFarm, SEL.rewardRate, 'latest').then(n), fin = await rpc.call(A.precisionFarm, SEL.periodFinish, 'latest').then(n);
  const res = await rpc.call(A.precisionFarm, SEL.reserved, 'latest').then(n), staked = await rpc.call(A.precisionFarm, SEL.totalStaked, 'latest').then(n), lp = await rpc.call(A.precisionPool, SEL.totalSupply, 'latest').then(n);
  console.log(`  public farm: ${tac(rate * 86400n)} TAC/day to ${new Date(Number(fin) * 1000).toISOString().slice(0, 10)}, holds ${tac(pFarm)} vs ${tac(res)} reserved (${pFarm >= res ? 'funded' : 'SHORT'}), ${(100 * Number(staked) / Number(lp)).toFixed(1)}% of the LP staked`);
  const price = Number(pPoolEth) / Number(pPoolTac); // ETH per TAC
  const parked = supply - ops - airdrop - wtac - pFarm - pPoolTac - dist;
  console.log(`  airdrop: ${tac(airdrop, 0)} of 1,000,000 TAC unclaimed (${(100 * (1 - Number(airdrop) / 1e24)).toFixed(0)}% claimed) | supply ${tac(supply, 0)}, treasury multisig ${(100 * Number(ops) / Number(supply)).toFixed(0)}%`);
  console.log(`  TAC in wallets and elsewhere outside treasury, airdrop, farms, pool and distributor: ${tac(parked, 0)} | public pool ${eth(pPoolEth)} ETH + ${tac(pPoolTac, 0)} TAC -> ${(price * 1e6).toFixed(1)} micro-ETH per TAC`);
  const pot = 100000 / 90;
  const emitTac = pot + Number(ep.ratePerDayTac) + Number(rate * 86400n) / 1e18;
  const emitEth = emitTac * price;
  const privateEth = Object.values(state.live ?? {}).reduce((s, v) => s + (v ? Number(v) / 1e18 : 0), 0);
  const poolEth2 = (Number(pPoolEth) / 1e18) * 2;
  console.log(`  emission per day: points up to ${pot.toFixed(0)} + private farms ${Number(ep.ratePerDayTac).toFixed(0)} + public farm ${(Number(rate * 86400n) / 1e18).toFixed(0)} = ${emitTac.toFixed(0)} TAC (${emitEth.toFixed(3)} ETH at the pool price)`);
  console.log(`    = ${(100 * emitEth / Math.max(privateEth + poolEth2, 1e-9)).toFixed(1)}% a day of the ETH held (private pools ${privateEth.toFixed(2)} + public pool both sides ${poolEth2.toFixed(2)}), ${(100 * emitTac / (Number(pPoolTac) / 1e18)).toFixed(1)}% a day of the pool's TAC, ${(100 * emitTac / Math.max(Number(parked) / 1e18, 1)).toFixed(1)}% a day of the TAC outside treasury and contracts`);
});
