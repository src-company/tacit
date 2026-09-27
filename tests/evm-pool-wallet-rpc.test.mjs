// jsonRpc over several nodes, and the wallet's log scan against nodes with different eth_getLogs range limits.
import assert from 'node:assert/strict';
import { jsonRpc, makeEvmPoolWallet, evmPoolKeys, sealNote, openNote } from '../dapp/evm-pool-wallet.js';
import { poolAsset } from '../dapp/evm-pool-zk.js';
import { makeEvmPoolZk } from '../dapp/evm-pool-zk.js';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from 'poseidon-lite';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });

// Fake nodes: `limit` is the widest eth_getLogs range served; `err(range)` shapes the refusal like the real node.
const TIP = 10_000;
function nodes(spec, calls) {
  return async (url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    const node = spec[url];
    calls.push([url, method]);
    const reply = (x) => ({ json: async () => ({ jsonrpc: '2.0', id, ...x }) });
    if (node.down) throw new Error('fetch failed');
    if (method === 'eth_blockNumber') return reply({ result: '0x' + TIP.toString(16) });
    if (method === 'eth_call') return reply({ error: { code: 3, message: 'execution reverted', data: '0x12345678' } });
    if (method === 'eth_getLogs') {
      const range = Number(BigInt(params[0].toBlock) - BigInt(params[0].fromBlock)) + 1;
      if (range > node.limit) return reply({ error: node.err(node.limit) });
      return reply({ result: [] });
    }
    return reply({ result: '0x0' });
  };
}
const SPEC = {
  tenderly: { limit: 1000, err: (l) => ({ code: -32602, message: 'invalid params', data: `Block range too large for public access: maximum ${l} blocks` }) },
  drpc: { limit: 10_000, err: () => ({ code: 35, message: 'ranges over 10000 blocks are not supported on free plan' }) },
  base: { limit: 2000, err: (l) => ({ code: -32614, message: `eth_getLogs is limited to a ${l.toLocaleString('en-US')} range` }) },
};

await check('any failing node is skipped: a down node, then a range refusal, then one that serves', async () => {
  const calls = [];
  const rpc = jsonRpc(['down', 'tenderly', 'drpc'], nodes({ down: { down: true }, ...SPEC }, calls));
  assert.deepEqual(await rpc('eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x1387' }]), []); // 5000 blocks
  assert.deepEqual(calls.map((c) => c[0]), ['down', 'tenderly', 'drpc']);
});

await check('a revert is final at the first node', async () => {
  const calls = [];
  const rpc = jsonRpc(['drpc', 'base'], nodes(SPEC, calls));
  await assert.rejects(rpc('eth_call', [{}, 'latest']), (e) => e.rpc.data === '0x12345678');
  assert.equal(calls.length, 1);
});

await check('when every node refuses, the error carries them all', async () => {
  const rpc = jsonRpc(['tenderly', 'base'], nodes(SPEC, []));
  await assert.rejects(rpc('eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x1387' }]), (e) => e.all.length === 2);
});

await check('the scan takes the widest limit a node names (in message or data) and rotates to that node', async () => {
  for (const [urls, want] of [[['tenderly', 'base'], 2000], [['tenderly'], 1000], [['base', 'tenderly'], 2000]]) {
    const calls = [];
    const w = makeEvmPoolWallet({
      zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(7)), prove: null,
      chain: { chainId: 8453, pool: '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc: jsonRpc(urls, nodes(SPEC, calls)), deployBlock: 0, confirmations: 0, logChunk: 5000 },
    });
    await w.sync();
    const served = calls.filter(([u, m]) => m === 'eth_getLogs' && SPEC[u].limit >= want).length;
    // Two log streams (pool and router), each ceil(10001 / want) chunks served by that node, plus its refusals.
    assert.ok(served >= 2 * Math.ceil((TIP + 1) / want) && served < 2 * Math.ceil((TIP + 1) / want) + 12, `${urls}: ${served} calls for a ${want}-block step`);
  }
});

await check('state saved with every leaf and nullifier loads as a tree of unspent notes only', async () => {
  const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(9));
  const asset = poolAsset({ chainId: 8453n, pool: POOL, token: '0x0000000000000000000000000000000000000000' });
  const self = { V: keys.V, A: keys.A, N: keys.N };
  const hex = (b) => '0x' + Buffer.from(b).toString('hex');
  const mine = [5n, 7n].map((v) => { const o = sealNote(zk, { to: self, value: v, asset }); return { ...o, leaf: zk.leafOf(asset, o.v, o.npk, o.rho) }; });
  const leaves = [11n, mine[0].leaf, 13n, 17n, mine[1].leaf, 19n];
  const idx = [1, 4];
  const notes = mine.map((m, k) => { const o = openNote(zk, keys, { memo: m.memo, leaf: m.leaf, asset }); return { index: idx[k], leaf: m.leaf.toString(), v: o.v.toString(), rho: o.rho.toString(), s: hex(o.s), kind: 'memo' }; });
  const k1 = zk.ownedKeys(keys.zkWallet, Buffer.from(notes[1].s.slice(2), 'hex'));
  const spentNf = zk.nullifier(k1.nk, mine[1].leaf, 4).toString();
  const saved = new Map();
  const skey = `tacit-evm-pool-v1:8453:${POOL.toLowerCase()}:${keys.address}`;
  saved.set(skey, JSON.stringify({ block: 100, leaves: leaves.map(String), notes, spent: ['123', spentNf], nextRefund: 1 }));
  const store = { get: (k) => saved.get(k), set: (k, v) => saved.set(k, v) };
  const rpc = async (m) => (m === 'eth_blockNumber' ? '0x64' : []);
  const w = makeEvmPoolWallet({ zk, keys, prove: null, store, chain: { chainId: 8453, pool: POOL, router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc, deployBlock: 0, confirmations: 0 } });
  const sum = await w.sync();
  assert.equal(sum.balance, 5n, 'the spent note is dropped');
  assert.equal(sum.leaves, 6);
  const w2 = makeEvmPoolWallet({ zk, keys, prove: null, store: { get: () => JSON.stringify({ block: 100, leaves: leaves.map(String), notes, spent: [spentNf] }), set: (k, v) => saved.set('new', v) }, chain: { chainId: 8453, pool: POOL, router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc: async (m) => (m === 'eth_blockNumber' ? '0x6e' : []), deployBlock: 0, confirmations: 0 } });
  await w2.sync();
  const now = JSON.parse(saved.get('new'));
  assert.ok(now.tree && !now.leaves && !now.spent, 'saved again as a tree, with no leaves or nullifier list');
  assert.deepEqual(Object.keys(now.tree.tracked), ['1'], 'only the unspent note keeps a path');
  assert.equal(now.tree.root, zk.tree(leaves).root.toString());
});

console.log(`\n${n} checks passed`);
