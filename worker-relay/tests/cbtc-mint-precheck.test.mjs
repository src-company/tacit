// The settle relay's cBTC mint gate check (src/lib/cbtc-mint-precheck.js).
//   node worker-relay/tests/cbtc-mint-precheck.test.mjs

import assert from 'node:assert/strict';
import { cbtcMintBlocker } from '../src/lib/cbtc-mint-precheck.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', ENGINE = '0x000000003f608BDdF0ca45934003ffb9DbDF70DB';
const E = 10n ** 18n;
const job = (over = {}) => ({ type: 'cbtcmint', op: { outpoint: '0x' + 'ab'.repeat(32), vBtc: '700', ...over } });

// A chain where the lock is recorded, unminted and bonded; `over` replaces single reads.
const chain = (over = {}) => {
  const base = {
    cbtcLockVBtc: 700n, cbtcMinted: false, cbtcLockSpent: false, cbtcLockRedeemed: false, pendingOverflowChunks: 0n,
    COLLATERAL_ENGINE: ENGINE, escrowSufficient: true, escrowSlashed: false, escrowTotal: 3n * E / 10n, requiredEscrow: 28n * E / 100n,
  };
  const vals = { ...base, ...over };
  return {
    readContract: async ({ address, functionName }) => {
      const onEngine = ['escrowSufficient', 'escrowSlashed', 'escrowTotal', 'requiredEscrow'].includes(functionName);
      assert.equal(address, onEngine ? ENGINE : POOL, `${functionName} read from the wrong contract`);
      const v = vals[functionName];
      if (v instanceof Error) throw v;
      return v;
    },
  };
};
const check = (j, c) => cbtcMintBlocker(j, { client: c, pool: POOL });

await test('a recorded, unminted, bonded lock is proved', async () => {
  assert.equal(await check(job(), chain()), null);
});

await test('a lock the reflection has not folded yet is not proved', async () => {
  assert.match(await check(job(), chain({ cbtcLockVBtc: 0n })), /not recorded this lock yet/);
});

await test('a lock without a bond is not proved, and the reason says how much is missing', async () => {
  const why = await check(job(), chain({ escrowSufficient: false, escrowTotal: 0n }));
  assert.match(why, /no bond for this lock: the collateral engine holds 0\.00000 wstETH of the 0\.28000 required/);
});

await test('the bond reason still reads when the required amount cannot be priced', async () => {
  const why = await check(job(), chain({ escrowSufficient: false, escrowTotal: 0n, requiredEscrow: new Error('stale feed') }));
  assert.equal(why, 'no bond for this lock: the collateral engine holds 0.00000 wstETH');
});

await test('minted, spent, redeemed, slashed, mismatched and queued locks are not proved', async () => {
  assert.match(await check(job(), chain({ cbtcMinted: true })), /already minted/);
  assert.match(await check(job(), chain({ cbtcLockSpent: true })), /spent on Bitcoin/);
  assert.match(await check(job(), chain({ cbtcLockRedeemed: true })), /redeemed/);
  assert.match(await check(job(), chain({ escrowSufficient: false, escrowSlashed: true })), /slashed/);
  assert.match(await check(job({ vBtc: '800' }), chain()), /records 700 sats for this lock, the mint asks for 800/);
  assert.match(await check(job(), chain({ pendingOverflowChunks: 1n })), /still queued/);
});

await test('other jobs, malformed ops and unreadable chains pass through', async () => {
  assert.equal(await check({ type: 'wrap', op: {} }, chain({ cbtcLockVBtc: 0n })), null);
  assert.equal(await check({ type: 'cbtcmint', op: { vBtc: '700' } }, chain({ cbtcLockVBtc: 0n })), null);
  assert.equal(await check(job(), chain({ cbtcLockVBtc: new Error('rpc down') })), null);
  assert.equal(await check(job(), chain({ escrowSufficient: new Error('stale feed') })), null);
});

console.log(`${n} passed`);
