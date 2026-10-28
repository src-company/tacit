#!/usr/bin/env node
// Prove for the market: take open orders from the board, prove them on this computer, and be paid in TAC.
//
//   SOLVER_KEY=0x… RPC_URL=https://… node tools/proof-market-prover.mjs
//
// A holder who wants a proof fast signs a fee in TAC (up to a most) and a TAC permit; the order sits on the board (GET /market/orders). You claim an
// order (which excludes other provers for a minute), prove its program input with the prover on this machine (tacit-prover, the same one the Prove
// sheet uses: contracts/sp1/confidential/device-prover/, on 127.0.0.1:47815), and fulfil it. The market's contract settles the holder's op through the
// pool and pays you, in the same transaction, from the holder's permit; if the pool does not accept the proof nothing moves. Tacit's own relay takes
// orders too and is quick, so the orders worth your time are the ones it leaves, or ones priced for a faster machine than its board.
//
// Env: SOLVER_KEY (the account that sends and is paid; it needs a little ETH for gas, and for a bond if the market asks for one), RPC_URL (reads),
// SEND_RPC_URL (where signed transactions go; default Flashbots Protect, hash-only hints, which keeps your fulfil out of the public mempool so
// nobody can copy the proof and settle first), API_BASE (default https://api.tacit.finance), DEVICE_PROVER (default http://127.0.0.1:47815),
// MARKET_ADDR, MIN_TAC_WEI (the least price you will work for, default 0), POLL_SECS (default 10), ONCE=1 (one pass, then exit).
import { createRequire } from 'node:module';
import { makeMarketSolver } from '../worker-relay/src/lib/market-solver.js';
import { abi, claimCall, fulfillCall } from '../worker-relay/src/lib/market-calls.js';
const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { createPublicClient, createWalletClient, http, getAddress } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { mainnet } = require('viem/chains');

const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;
const API = env('API_BASE', 'https://api.tacit.finance').replace(/\/$/, '');
const DEVICE = env('DEVICE_PROVER', 'http://127.0.0.1:47815').replace(/\/$/, '');
const MARKET = getAddress(env('MARKET_ADDR', '0x0000000033Dd45B1686Ba37e5F6e4ABDdaC17609'));
const POLL = Number(env('POLL_SECS', '10'));
const log = (...a) => console.log(`[market-prover ${new Date().toISOString()}]`, ...a);
const k = env('SOLVER_KEY');
if (!k || !env('RPC_URL')) { console.error('set SOLVER_KEY and RPC_URL'); process.exit(1); }
const account = privateKeyToAccount(k.startsWith('0x') ? k : `0x${k}`);
const reader = createPublicClient({ chain: mainnet, transport: http(env('RPC_URL')) });
const sender = createWalletClient({ chain: mainnet, account, transport: http(env('SEND_RPC_URL', 'https://rpc.flashbots.net/fast?hint=hash')) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (url, init) => { const r = await fetch(url, init); const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error || `${url} answered ${r.status}`); return b; };

async function prove(order) {
  const { id } = await j(`${DEVICE}/prove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'wrap', stdin: order.stdin }) });
  for (;;) {
    await sleep(2000);
    const s = await j(`${DEVICE}/job?id=${encodeURIComponent(id)}`);
    if (s.status === 'done') return { publicValues: s.publicValues, proof: s.proof };
    if (s.status === 'failed') throw new Error(s.error || 'this computer could not make the proof');
  }
}
const send = async (call, value = 0n) => {
  const hash = await sender.writeContract({ address: MARKET, abi, ...call, value, chain: mainnet });
  const rc = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rc.status !== 'success') throw new Error(`reverted ${hash}`);
  return hash;
};
const solver = makeMarketSolver({
  me: account.address, minPrice: BigInt(env('MIN_TAC_WEI', '0')), log,
  listOrders: async () => (await j(`${API}/market/orders?limit=20`)).orders || [],
  depositStatus: async (id) => BigInt((await reader.call({ to: '0x000000000Ed1eabD231Be41d93b719056F7febFC', data: `0x7da9874f${id.slice(2)}` })).data || 0),
  done: (id) => reader.readContract({ address: MARKET, abi, functionName: 'done', args: [id] }),
  claimOf: async (id) => { const [solver_, until] = await reader.readContract({ address: MARKET, abi, functionName: 'claims', args: [id] }); return /^0x0+$/.test(solver_) ? null : { solver: solver_, until: Number(until) }; },
  claim: async (o) => { await reader.simulateContract({ address: MARKET, abi, ...claimCall(o), account }); return send(claimCall(o), await reader.readContract({ address: MARKET, abi, functionName: 'claimBond' })); },
  prove,
  fulfil: async (o, p) => { const c = fulfillCall(o, p.proof); await reader.simulateContract({ address: MARKET, abi, ...c, account }); return send(c); },
  clear: (id) => j(`${API}/market/done`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId: id }) }),
});
log(`proving for ${MARKET} as ${account.address}; device prover ${DEVICE}`);
for (;;) {
  const worked = await solver.pass().catch((e) => { log(`pass failed: ${e.message}`); return false; });
  if (env('ONCE', '') === '1') break;
  if (!worked) await sleep(POLL * 1000);
}
