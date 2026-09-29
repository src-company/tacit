// Who is waiting on the reflection (src/lib/reflection-demand.js): bonded cBTC locks not yet recorded.
//   node worker-relay/tests/reflection-demand.test.mjs
import assert from 'node:assert/strict';
import { cbtcLockDemand } from '../src/lib/reflection-demand.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', HELPER = '0x000000008eCD09f922C9FbbDD9ACA5aE8F0beBfA', ENGINE = '0x000000003f608BDdF0ca45934003ffb9DbDF70DB';
const op = (i) => '0x' + String(i).repeat(64).slice(0, 64);

// Bonds at the given blocks; `state` per outpoint: { vBtc, minted, bond }.
const chain = (bonds, state, head = 10_000n) => ({
  getBlockNumber: async () => head,
  getLogs: async ({ address, fromBlock, toBlock }) => {
    assert.equal(address, HELPER);
    return bonds.filter((b) => b.block >= fromBlock && b.block <= toBlock).map((b) => ({ args: { outpoint: b.outpoint } }));
  },
  readContract: async ({ address, functionName, args: [o] }) => {
    const s = state[o] || {};
    if (functionName === 'escrowTotal') { assert.equal(address, ENGINE); return s.bond ?? 0n; }
    assert.equal(address, POOL);
    return functionName === 'cbtcLockVBtc' ? (s.vBtc ?? 0n) : (s.minted ?? false);
  },
});
const run = (c, lookbackBlocks = 7200n) => cbtcLockDemand({ client: c, pool: POOL, helper: HELPER, engine: ENGINE, lookbackBlocks });

await test('a bonded lock the pool has not recorded is someone waiting', async () => {
  assert.deepEqual(await run(chain([{ block: 9_000n, outpoint: op(1) }], { [op(1)]: { bond: 5n } })), { waiting: 1, bonded: 1 });
});

await test('recorded, minted and reclaimed locks are not waiting', async () => {
  const bonds = [2, 3, 4].map((i) => ({ block: 9_500n, outpoint: op(i) }));
  const state = { [op(2)]: { vBtc: 2000n, bond: 5n }, [op(3)]: { minted: true, bond: 5n }, [op(4)]: { bond: 0n } };
  assert.deepEqual(await run(chain(bonds, state)), { waiting: 0, bonded: 3 });
});

await test('a bond older than the window no longer counts, so a lock that never confirms stops the spending', async () => {
  assert.deepEqual(await run(chain([{ block: 1_000n, outpoint: op(5) }], { [op(5)]: { bond: 5n } })), { waiting: 0, bonded: 0 });
});

await test('one lock bonded twice counts once', async () => {
  const bonds = [{ block: 9_100n, outpoint: op(6) }, { block: 9_900n, outpoint: op(6).toUpperCase().replace('0X', '0x') }];
  assert.deepEqual(await run(chain(bonds, { [op(6)]: { bond: 7n } })), { waiting: 1, bonded: 1 });
});

console.log(`${n} passed`);
