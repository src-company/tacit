// The settle relay's cUSD loan and top-up gate check (src/lib/cdp-precheck.js).
//   node worker-relay/tests/cdp-precheck.test.mjs

import assert from 'node:assert/strict';
import { cdpBlocker } from '../src/lib/cdp-precheck.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', ENGINE = '0x000000003f608BDdF0ca45934003ffb9DbDF70DB';
const CBTC = '0x' + 'cb'.repeat(32), RAY = 10n ** 27n, NOW = 1_790_700_000n;
// 20,000 sats at $84,000 = $16.80 of collateral; the 150% floor backs at most $11.20.
const usdOf = (sats) => sats * 84_000n;                        // cUSD base units (8 dp) for sats at $84,000/BTC
const mint = (over = {}) => ({ type: 'cdpmint', op: { debtValue: String(8n * 10n ** 8n), rateSnapshot: String(RAY), legs: [{ asset: CBTC, value: '20000' }], ...over } });

const chain = (over = {}) => {
  const vals = { COLLATERAL_ENGINE: ENGINE, CBTC_ASSET_ID: CBTC, cdpRatioBps: 15000n, rate: RAY, lastFeedChangeAt: NOW - 86_400n, ...over };
  return {
    readContract: async ({ address, functionName, args }) => {
      assert.equal(address, functionName === 'COLLATERAL_ENGINE' ? POOL : ENGINE, `${functionName} read from the wrong contract`);
      if (functionName === 'btcToUsd') {
        if (vals.btcToUsd instanceof Error) throw vals.btcToUsd;
        return usdOf(args[0]);
      }
      const v = vals[functionName];
      if (v instanceof Error) throw v;
      return v;
    },
  };
};
const check = (j, c) => cdpBlocker(j, { client: c, pool: POOL, now: () => NOW });

await test('a loan inside the floor at a fresh price is proved', async () => {
  assert.equal(await check(mint(), chain()), null);
});

await test('a loan over the floor is not proved, and the reason names the most it can borrow', async () => {
  assert.equal(await check(mint({ debtValue: String(12n * 10n ** 8n) }), chain()),
    "the loan is under the 150% floor at today's BTC price; this collateral backs at most 11.20 cUSD");
});

await test('a stale price feed is not proved', async () => {
  const stale = new Error('The contract function "btcToUsd" reverted. Error: StaleFeed()');
  assert.match(await check(mint(), chain({ btcToUsd: stale })), /price feed is updating/);
});

await test('a freshly changed feed is not proved, and the reason says when loans reopen', async () => {
  assert.match(await check(mint(), chain({ lastFeedChangeAt: NOW - 3600n })), /loans reopen at 2026-/);
});

await test('non-cBTC collateral and an out-of-range rate snapshot are not proved', async () => {
  assert.equal(await check(mint({ legs: [{ asset: '0x' + 'ee'.repeat(32), value: '20000' }] }), chain()), 'only cBTC can back cUSD');
  assert.match(await check(mint({ rateSnapshot: String(RAY + 1n) }), chain()), /rate snapshot/);
});

await test('a top-up is priced on its combined basket', async () => {
  const topup = { type: 'cdptopup', op: { debtValue: String(12n * 10n ** 8n), rateSnapshot: String(RAY), oldLegs: [{ asset: CBTC, value: '20000' }], addedLegs: [{ asset: CBTC, value: '10000' }] } };
  assert.equal(await check(topup, chain()), null);                     // 30,000 sats back up to $16.80
  assert.match(await check({ ...topup, op: { ...topup.op, addedLegs: [{ asset: CBTC, value: '100' }] } }, chain()), /under the 150% floor/);
});

await test('repays, other jobs and unreadable chains pass through', async () => {
  assert.equal(await check({ type: 'cdpclose', op: {} }, chain({ btcToUsd: new Error('StaleFeed()') })), null);
  assert.equal(await check(mint(), chain({ rate: new Error('rpc down') })), null);
  assert.equal(await check(mint(), chain({ btcToUsd: new Error('fetch failed') })), null);
});

console.log(`${n} passed`);
