// jsonRpc over several nodes, and the wallet's log scan against nodes with different eth_getLogs range limits.
import assert from 'node:assert/strict';
import { jsonRpc, makeEvmPoolWallet, evmPoolKeys } from '../dapp/evm-pool-wallet.js';
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

console.log(`\n${n} checks passed`);
