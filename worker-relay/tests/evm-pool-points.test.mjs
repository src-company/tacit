// EVM pool deposit points (src/lib/evm-pool-points.js) against a mocked chain and explorer: who is credited for a
// direct deposit, a router zap and a box completion (funders, never the completer), internal hops earning nothing,
// FIFO shares capped at the deposit, retry while the explorer is down, the V1 Wrap guard, and the enable gate.
//   node worker-relay/tests/evm-pool-points.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/lib/points-store.js';
import {
  openEvmPoolPointsState, scanEvmPoolChain, resolvePendingBoxes, allocateBoxFunding, isV1WrapViaEvmRouter,
  EVM_POOL_ACTIVITY,
} from '../src/lib/evm-pool-points.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };

const ETH = 10n ** 18n;
const POOL = '0x000000c2a20657ce25f2ba99737933d031afbee9';
const ROUTER = '0x0000006c96afa6f1cd4df8fe19bc0d8b6a6cd7b5';
const V1_POOL = '0x000000000ed1eabd231be41d93b719056f7febfc';
const V1_ROUTER = '0x000000005da3e3b73726af3c774deeb9472d4992';
const RELAY = '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7';
const ALICE = '0x00000000000000000000000000000000000a11ce';
const BOB = '0x0000000000000000000000000000000000000b0b';
const CAROL = '0x000000000000000000000000000000000000ca01';
const KEEPER = '0x000000000000000000000000000000000000beef';
const BOX = '0x000000000000000000000000000000000000b0c5';
const OTHER = '0x0000000000000000000000000000000000000c0c';
const API = 'https://explorer.test/api/v2';
const h = (i) => `0x${i.toString(16).padStart(64, '0')}`;

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'evm-pool-points-'));
  const store = openStore(join(dir, 'points.db'));
  const state = openEvmPoolPointsState(store.db);
  const chain = { code: '0x6000', head: 1000n, logs: [], txs: new Map(), calls: 0 };
  const client = {
    getCode: async () => chain.code,
    getBlockNumber: async () => chain.head,
    getBlock: async ({ blockNumber }) => ({ timestamp: 1_700_000_000n + blockNumber }),
    getTransaction: async ({ hash }) => {
      const tx = chain.txs.get(hash);
      if (!tx) throw new Error(`no tx ${hash}`);
      return tx;
    },
    getLogs: async ({ address, event, fromBlock, toBlock }) => {
      chain.calls++;
      return chain.logs.filter((l) => l.address === address.toLowerCase() && l.event === event.name
        && l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  };
  const explorer = { up: true, txs: new Map(), internals: new Map() };
  const explorerGet = async (url) => {
    if (!explorer.up) throw new Error('explorer 503');
    const m = url.match(/addresses\/(0x[0-9a-f]+)\/(transactions|internal-transactions)$/i);
    const box = m[1].toLowerCase();
    const items = (m[2] === 'transactions' ? explorer.txs : explorer.internals).get(box) || [];
    return { items, next_page_params: null };
  };
  const ctx = {
    store, state, chainId: 8453, client, apiBase: API, startBlock: '100',
    pool: POOL, router: ROUTER, v1Pool: V1_POOL, v1Router: V1_ROUTER, excluded: new Set([RELAY]),
    confirmations: 0, chunk: 500, maxChunks: 10, resolvePerCycle: 10, capTip: null, explorerGet,
    pointsFor: (wei, prior) => Number(wei) / 1e18 * 1000 * (1 + 4 / (1 + prior / 200)),
    evalBlock: async (_c, b) => BigInt(b), covered: () => true, multipliers: () => ({ tacB: 1, zShareB: 1 }),
    log: () => {},
  };
  const cleanup = () => { store.db.close(); rmSync(dir, { recursive: true, force: true }); };
  return { store, state, chain, explorer, ctx, cleanup };
}

function transact(chain, { hash, block, logIndex = 0, extAmount }) {
  chain.logs.push({ address: POOL, event: 'Transact', transactionHash: hash, blockNumber: block, logIndex, args: { extAmount } });
}
function boxCompleted(chain, { hash, block, logIndex = 1, box = BOX, completer = KEEPER }) {
  chain.logs.push({ address: ROUTER, event: 'DepositBoxCompleted', transactionHash: hash, blockNumber: block, logIndex, args: { box, completer } });
}
function topFunding(explorer, { hash, block, from, value, box = BOX }) {
  const list = explorer.txs.get(box) || [];
  list.push({ hash, block_number: Number(block), position: 0, from: { hash: from }, to: { hash: box }, value: value.toString(), status: 'ok', result: 'success' });
  explorer.txs.set(box, list);
}
function internal(explorer, { hash, block, index, from, to, value, box = BOX }) {
  const list = explorer.internals.get(box) || [];
  list.push({ transaction_hash: hash, block_number: Number(block), transaction_index: 0, index, from: { hash: from }, to: { hash: to }, value: value.toString(), success: true });
  explorer.internals.set(box, list);
}
const rows = (store, addr) => store.depositsFor(addr, 100).filter((r) => r.activity === EVM_POOL_ACTIVITY);
const creditedWei = (store, addr) => rows(store, addr).reduce((s, r) => s + BigInt(r.amount_wei), 0n);

await test('direct deposit is credited to tx.from', async () => {
  const w = world();
  transact(w.chain, { hash: h(1), block: 200n, extAmount: 2n * ETH });
  w.chain.txs.set(h(1), { from: ALICE, to: POOL, typeHex: '0x2' });
  await scanEvmPoolChain(w.ctx);
  const r = rows(w.store, ALICE);
  assert.equal(r.length, 1);
  assert.equal(r[0].amount_wei, String(2n * ETH));
  assert.equal(r[0].tx_hash, h(1));
  assert.equal(r[0].chain_id, 8453);
  assert.ok(r[0].points > 0);
  assert.equal(w.state.loadCursor(8453), 1000n);
  w.cleanup();
});

await test('the Privacy Pools boost multiplies a deposit and is recorded', async () => {
  const w = world();
  w.ctx.multipliers = (a) => ({ tacB: 1, zShareB: 1, ppB: a === ALICE ? 1.2 : 1 });
  transact(w.chain, { hash: h(8), block: 200n, extAmount: ETH });
  transact(w.chain, { hash: h(9), block: 201n, extAmount: ETH });
  w.chain.txs.set(h(8), { from: ALICE, to: POOL, typeHex: '0x2' });
  w.chain.txs.set(h(9), { from: BOB, to: POOL, typeHex: '0x2' });
  await scanEvmPoolChain(w.ctx);
  const [a] = rows(w.store, ALICE), [b] = rows(w.store, BOB);
  assert.equal(!!a.pp_boosted, true);
  assert.equal(!!b.pp_boosted, false);
  assert.ok(Math.abs(a.points / w.ctx.pointsFor(ETH, 0) - 1.2) < 1e-9);
  w.cleanup();
});

await test('router zap is credited to tx.from', async () => {
  const w = world();
  transact(w.chain, { hash: h(2), block: 300n, extAmount: ETH });
  w.chain.txs.set(h(2), { from: BOB, to: ROUTER, typeHex: '0x2' });
  await scanEvmPoolChain(w.ctx);
  assert.equal(creditedWei(w.store, BOB), ETH);
  w.cleanup();
});

await test('withdrawals and transfers earn nothing', async () => {
  const w = world();
  transact(w.chain, { hash: h(3), block: 300n, extAmount: -ETH });
  transact(w.chain, { hash: h(4), block: 301n, extAmount: 0n });
  w.chain.txs.set(h(3), { from: ALICE, to: POOL, typeHex: '0x2' });
  w.chain.txs.set(h(4), { from: ALICE, to: POOL, typeHex: '0x2' });
  await scanEvmPoolChain(w.ctx);
  assert.equal(w.store.countByActivity(EVM_POOL_ACTIVITY), 0);
  w.cleanup();
});

await test('a deposit sent from V1, a system deposit or an excluded sender earns nothing', async () => {
  const w = world();
  transact(w.chain, { hash: h(5), block: 300n, extAmount: ETH });
  transact(w.chain, { hash: h(6), block: 301n, extAmount: ETH });
  transact(w.chain, { hash: h(7), block: 302n, extAmount: ETH });
  w.chain.txs.set(h(5), { from: ALICE, to: V1_ROUTER, typeHex: '0x2' });
  w.chain.txs.set(h(6), { from: ALICE, to: POOL, typeHex: '0x68' });
  w.chain.txs.set(h(7), { from: RELAY, to: POOL, typeHex: '0x2' });
  await scanEvmPoolChain(w.ctx);
  assert.equal(w.store.countByActivity(EVM_POOL_ACTIVITY), 0);
  w.cleanup();
});

await test('box completion credits the funding EOA, never the completer', async () => {
  const w = world();
  topFunding(w.explorer, { hash: h(10), block: 150n, from: ALICE, value: ETH });
  transact(w.chain, { hash: h(11), block: 400n, logIndex: 3, extAmount: ETH });
  boxCompleted(w.chain, { hash: h(11), block: 400n, logIndex: 4 });
  internal(w.explorer, { hash: h(11), block: 400n, index: 2, from: BOX, to: ROUTER, value: ETH });
  w.chain.txs.set(h(10), { from: ALICE, to: BOX, typeHex: '0x2' });
  w.chain.txs.set(h(11), { from: KEEPER, to: ROUTER, typeHex: '0x2' });
  await scanEvmPoolChain(w.ctx);
  assert.equal(w.state.countPending(8453), 1);
  await resolvePendingBoxes(w.ctx);
  assert.equal(w.state.countPending(8453), 0);
  assert.equal(creditedWei(w.store, ALICE), ETH);
  assert.equal(rows(w.store, ALICE)[0].tx_hash, h(11));
  assert.equal(rows(w.store, KEEPER).length, 0);
  w.cleanup();
});

await test('a receive-box sweep credits every payer of the box, never the sweeper', async () => {
  const w = world();
  topFunding(w.explorer, { hash: h(12), block: 150n, from: ALICE, value: ETH });
  topFunding(w.explorer, { hash: h(13), block: 160n, from: BOB, value: 2n * ETH });
  transact(w.chain, { hash: h(14), block: 400n, logIndex: 3, extAmount: 3n * ETH });
  w.chain.logs.push({ address: ROUTER, event: 'Received', transactionHash: h(14), blockNumber: 400n, logIndex: 4, args: { box: BOX, n: 0n } });
  internal(w.explorer, { hash: h(14), block: 400n, index: 2, from: BOX, to: ROUTER, value: 3n * ETH });
  w.chain.txs.set(h(12), { from: ALICE, to: BOX, typeHex: '0x2' });
  w.chain.txs.set(h(13), { from: BOB, to: BOX, typeHex: '0x2' });
  w.chain.txs.set(h(14), { from: KEEPER, to: ROUTER, typeHex: '0x2' });
  await scanEvmPoolChain(w.ctx);
  assert.equal(w.state.countPending(8453), 1);
  await resolvePendingBoxes(w.ctx);
  assert.equal(creditedWei(w.store, ALICE), ETH);
  assert.equal(creditedWei(w.store, BOB), 2n * ETH);
  assert.equal(rows(w.store, KEEPER).length, 0);
  w.cleanup();
});

await test('box funded by a V1 settle earns nothing', async () => {
  const w = world();
  internal(w.explorer, { hash: h(20), block: 150n, index: 5, from: V1_POOL, to: BOX, value: ETH });
  w.chain.txs.set(h(20), { from: RELAY, to: V1_POOL, typeHex: '0x2' });
  transact(w.chain, { hash: h(21), block: 400n, logIndex: 3, extAmount: ETH });
  boxCompleted(w.chain, { hash: h(21), block: 400n, logIndex: 4 });
  internal(w.explorer, { hash: h(21), block: 400n, index: 2, from: BOX, to: ROUTER, value: ETH });
  w.chain.txs.set(h(21), { from: KEEPER, to: ROUTER, typeHex: '0x2' });
  await scanEvmPoolChain(w.ctx);
  await resolvePendingBoxes(w.ctx);
  assert.equal(w.state.countPending(8453), 0);
  assert.equal(w.store.countByActivity(EVM_POOL_ACTIVITY), 0);
  w.cleanup();
});

await test('mixed funding is credited per share and capped at the deposit', async () => {
  const w = world();
  topFunding(w.explorer, { hash: h(30), block: 150n, from: ALICE, value: 3n * ETH / 10n });
  internal(w.explorer, { hash: h(31), block: 151n, index: 4, from: V1_ROUTER, to: BOX, value: 5n * ETH / 10n });
  internal(w.explorer, { hash: h(32), block: 152n, index: 1, from: OTHER, to: BOX, value: 4n * ETH / 10n });
  topFunding(w.explorer, { hash: h(33), block: 153n, from: CAROL, value: ETH });
  w.chain.txs.set(h(30), { from: ALICE, to: BOX, typeHex: '0x2' });
  w.chain.txs.set(h(31), { from: RELAY, to: V1_ROUTER, typeHex: '0x2' });
  w.chain.txs.set(h(32), { from: BOB, to: OTHER, typeHex: '0x2' });
  w.chain.txs.set(h(33), { from: CAROL, to: BOX, typeHex: '0x2' });
  transact(w.chain, { hash: h(34), block: 400n, logIndex: 3, extAmount: ETH });
  boxCompleted(w.chain, { hash: h(34), block: 400n, logIndex: 4 });
  internal(w.explorer, { hash: h(34), block: 400n, index: 2, from: BOX, to: ROUTER, value: ETH });
  w.chain.txs.set(h(34), { from: KEEPER, to: ROUTER, typeHex: '0x2' });
  await scanEvmPoolChain(w.ctx);
  await resolvePendingBoxes(w.ctx);
  assert.equal(creditedWei(w.store, ALICE), 3n * ETH / 10n);
  assert.equal(creditedWei(w.store, BOB), 2n * ETH / 10n);
  assert.equal(creditedWei(w.store, CAROL), 0n);
  assert.equal(creditedWei(w.store, RELAY), 0n);
  assert.deepEqual([rows(w.store, ALICE)[0].tx_hash, rows(w.store, BOB)[0].tx_hash], [h(34), `${h(34)}:1`]);
  w.cleanup();
});

await test('explorer down keeps the box pending and credits nobody, then resolves', async () => {
  const w = world();
  topFunding(w.explorer, { hash: h(40), block: 150n, from: ALICE, value: ETH });
  w.chain.txs.set(h(40), { from: ALICE, to: BOX, typeHex: '0x2' });
  transact(w.chain, { hash: h(41), block: 400n, logIndex: 3, extAmount: ETH });
  boxCompleted(w.chain, { hash: h(41), block: 400n, logIndex: 4 });
  w.chain.txs.set(h(41), { from: KEEPER, to: ROUTER, typeHex: '0x2' });
  transact(w.chain, { hash: h(42), block: 401n, extAmount: ETH });
  w.chain.txs.set(h(42), { from: BOB, to: POOL, typeHex: '0x2' });
  w.explorer.up = false;
  await scanEvmPoolChain(w.ctx);
  await resolvePendingBoxes(w.ctx);
  assert.equal(creditedWei(w.store, BOB), ETH); // other deposits are not held back
  assert.equal(w.state.loadCursor(8453), 1000n);
  assert.equal(w.state.countPending(8453), 1);
  assert.equal(rows(w.store, KEEPER).length, 0);
  w.explorer.up = true; // reachable, but the completion is not indexed yet
  await resolvePendingBoxes(w.ctx);
  assert.equal(w.state.countPending(8453), 1);
  internal(w.explorer, { hash: h(41), block: 400n, index: 2, from: BOX, to: ROUTER, value: ETH });
  await resolvePendingBoxes(w.ctx);
  assert.equal(w.state.countPending(8453), 0);
  assert.equal(creditedWei(w.store, ALICE), ETH);
  w.cleanup();
});

await test('FIFO: a reused box credits each completion from its own funding, a reclaim consumes nothing credited', () => {
  const ev = (txHash, block, from, to, value, index = -1) => ({ txHash, block, txIndex: 0, index, from, to, value });
  const outs = allocateBoxFunding([
    ev(h(50), 1n, ALICE, BOX, ETH),
    ev(h(51), 2n, BOX, ROUTER, ETH, 1),
    ev(h(52), 3n, BOB, BOX, 2n * ETH),
    ev(h(53), 4n, BOX, ROUTER, ETH, 1),
    ev(h(54), 5n, BOX, CAROL, ETH, 1),
    ev(h(55), 6n, BOX, ROUTER, ETH, 1),
  ], BOX);
  assert.deepEqual(outs.map((o) => o.consumed.map((c) => [c.from, c.amount])), [
    [[ALICE, ETH]], [[BOB, ETH]], [[BOB, ETH]], [],
  ]);
  assert.equal(outs[3].shortfall, ETH);
});

await test('disabled without a start block, idle while the pool has no code', async () => {
  const w = world();
  transact(w.chain, { hash: h(60), block: 300n, extAmount: ETH });
  w.chain.txs.set(h(60), { from: ALICE, to: POOL, typeHex: '0x2' });
  await scanEvmPoolChain({ ...w.ctx, startBlock: '' });
  assert.equal(w.chain.calls, 0);
  assert.equal(w.state.loadCursor(8453), null);
  w.chain.code = '0x';
  await scanEvmPoolChain(w.ctx);
  assert.equal(w.chain.calls, 0);
  assert.equal(w.state.loadCursor(8453), null);
  w.chain.code = '0x6000';
  await scanEvmPoolChain(w.ctx);
  assert.equal(creditedWei(w.store, ALICE), ETH);
  w.cleanup();
});

await test('boost replay behind holds the chunk back', async () => {
  const w = world();
  transact(w.chain, { hash: h(70), block: 300n, extAmount: ETH });
  w.chain.txs.set(h(70), { from: ALICE, to: POOL, typeHex: '0x2' });
  await scanEvmPoolChain({ ...w.ctx, covered: () => false });
  assert.equal(w.state.loadCursor(8453), null);
  assert.equal(w.store.countByActivity(EVM_POOL_ACTIVITY), 0);
  w.cleanup();
});

await test('V1 Wrap sent via the EVM pool router is skipped, a normal wrap counts', () => {
  const none = new Set();
  assert.equal(isV1WrapViaEvmRouter({ from: KEEPER, to: ROUTER }, h(80), none, ROUTER), true);
  assert.equal(isV1WrapViaEvmRouter({ from: ALICE, to: ALICE }, h(81), new Set([h(81)]), ROUTER), true); // batched call
  assert.equal(isV1WrapViaEvmRouter({ from: ALICE, to: V1_POOL }, h(82), none, ROUTER), false);
  assert.equal(isV1WrapViaEvmRouter({ from: ALICE, to: '0x000000D218B03db5837943b0b05DeA2965AE956e' }, h(83), none, ROUTER), false);
});

console.log(`\n${n} passed`);
