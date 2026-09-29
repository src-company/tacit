// Finding the transaction that already did a job's work (src/lib/landed-elsewhere.js), and the private endpoint
// modes settles are sent through (src/lib/config.js privateSettleUrl).
//   node worker-relay/tests/landed-elsewhere.test.mjs

import assert from 'node:assert/strict';
import { findCarrier, isRevert } from '../src/lib/landed-elsewhere.js';

process.env.RPC_URL ||= 'https://rpc.invalid';
const { privateSettleUrl } = await import('../src/lib/config.js');

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const PV = '0x' + 'ab'.repeat(40) + 'cd'.repeat(24);
const h = (i) => '0x' + String(i).padStart(64, '0');

// A chain of pool logs at the given blocks, each from its own transaction with the given input and status.
const chain = (txs, head = 1000n) => {
  const reads = { logs: 0, txs: 0 };
  return {
    reads,
    getBlockNumber: async () => head,
    getLogs: async ({ address, fromBlock, toBlock }) => {
      assert.equal(address, POOL);
      reads.logs++;
      return txs.filter((t) => t.block >= fromBlock && t.block <= toBlock).sort((a, b) => (a.block < b.block ? -1 : 1))
        .map((t) => ({ transactionHash: t.hash, blockNumber: t.block }));
    },
    getTransaction: async ({ hash }) => { reads.txs++; return { input: txs.find((t) => t.hash === hash).input }; },
    getTransactionReceipt: async ({ hash }) => ({ status: txs.find((t) => t.hash === hash).status }),
  };
};
const settleInput = (pv) => '0x12345678' + '00'.repeat(64) + pv.slice(2) + '00'.repeat(8);

await test('a successful transaction carrying the public values is found, through a wrapper contract', async () => {
  const c = chain([
    { hash: h(1), block: 990n, input: settleInput('0x' + 'ee'.repeat(64)), status: 'success' },
    { hash: h(2), block: 995n, input: '0x000009bb' + settleInput(PV).slice(2), status: 'success' },
  ]);
  assert.equal(await findCarrier({ client: c, pool: POOL, needles: [PV], fromBlock: 968n }), h(2));
});

await test('a reverted carrier is not the result, and neither is a transaction before the window', async () => {
  const c = chain([
    { hash: h(3), block: 900n, input: settleInput(PV), status: 'success' },
    { hash: h(4), block: 999n, input: settleInput(PV), status: 'reverted' },
  ]);
  assert.equal(await findCarrier({ client: c, pool: POOL, needles: [PV], fromBlock: 968n }), null);
});

await test('every needle must be carried, at a byte boundary', async () => {
  const m1 = '0x' + '11'.repeat(40), m2 = '0x' + '22'.repeat(40);
  const both = chain([{ hash: h(5), block: 999n, input: settleInput(m1) + m2.slice(2), status: 'success' }]);
  assert.equal(await findCarrier({ client: both, pool: POOL, needles: [m1, m2], fromBlock: 0n }), h(5));
  const one = chain([{ hash: h(6), block: 999n, input: settleInput(m1), status: 'success' }]);
  assert.equal(await findCarrier({ client: one, pool: POOL, needles: [m1, m2], fromBlock: 0n }), null);
  const shifted = chain([{ hash: h(7), block: 999n, input: '0x1' + PV.slice(2) + '0', status: 'success' }]);
  assert.equal(await findCarrier({ client: shifted, pool: POOL, needles: [PV], fromBlock: 0n }), null);
});

await test('short needles and empty lists find nothing without reading the chain', async () => {
  const c = chain([{ hash: h(8), block: 999n, input: settleInput(PV), status: 'success' }]);
  assert.equal(await findCarrier({ client: c, pool: POOL, needles: ['0xabcd', null], fromBlock: 0n }), null);
  assert.equal(c.reads.logs, 0);
});

await test('the search walks back in chunks and stops at the read budget', async () => {
  const txs = Array.from({ length: 30 }, (_, i) => ({ hash: h(100 + i), block: 1000n - BigInt(i) * 30n, input: '0x00', status: 'success' }));
  txs.push({ hash: h(999), block: 1n, input: settleInput(PV), status: 'success' });
  const c = chain(txs);
  assert.equal(await findCarrier({ client: c, pool: POOL, needles: [PV], fromBlock: 1n, chunk: 1000n }), h(999));
  assert.equal(c.reads.logs, 1);                                     // blocks 1..1000 in one read
  assert.equal(c.reads.txs, 31);                                     // newest first: the oldest is read last
  const tight = chain(txs);
  assert.equal(await findCarrier({ client: tight, pool: POOL, needles: [PV], fromBlock: 0n, chunk: 100n, maxTxs: 5 }), null);
  assert.equal(tight.reads.txs, 5);
});

await test('reverts are told apart from endpoint failures', async () => {
  const revert = Object.assign(new Error('The contract function "settle" reverted with the following signature: 0x070d817c'), {
    name: 'ContractFunctionExecutionError', shortMessage: 'The contract function "settle" reverted with the following signature:',
    cause: Object.assign(new Error('reverted'), { name: 'ContractFunctionRevertedError' }) });
  assert.equal(isRevert(revert), true);
  assert.equal(isRevert(Object.assign(new Error('x'), { cause: { name: 'RpcRequestError', shortMessage: 'execution reverted' } })), true);
  assert.equal(isRevert(new Error('insufficient funds for gas * price + value')), false);
  assert.equal(isRevert(Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' })), false);
  assert.equal(isRevert(new Error('nonce too low')), false);
});

await test('settle endpoints are used in their no-share, no-revert modes', async () => {
  assert.equal(privateSettleUrl('https://rpc.flashbots.net'), 'https://rpc.flashbots.net/?hint=hash');
  assert.equal(privateSettleUrl('https://rpc.flashbots.net/fast?hint=calldata&hint=logs&canRevert=true'), 'https://rpc.flashbots.net/fast?hint=hash');
  assert.equal(privateSettleUrl('https://rpc.mevblocker.io'), 'https://rpc.mevblocker.io/fullprivacy');
  assert.equal(privateSettleUrl('https://boost.rpc.mevblocker.io/noreverts'), 'https://rpc.mevblocker.io/fullprivacy');
  assert.equal(privateSettleUrl('https://builder.example/rpc'), 'https://builder.example/rpc');
});

console.log(`${n} passed`);
