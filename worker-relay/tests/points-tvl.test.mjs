// Pool ETH readings (src/lib/points-tvl.js and the store's pool_snapshots): a day's total, what the pools gained over it,
// and the ETH the program scored as deposited that day.
//   node worker-relay/tests/points-tvl.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tvlSeries } from '../src/lib/points-tvl.js';
import { openStore } from '../src/lib/points-store.js';

const ETH = 10n ** 18n;
const snap = (day, chainId, pool, eth) => ({ day, chainId, pool, ethWei: (BigInt(eth) * ETH / 100n).toString() });

{
  const s = tvlSeries([snap(10, 1, 'v1', 400), snap(10, 8453, 'evm', 140), snap(11, 1, 'v1', 395), snap(11, 8453, 'evm', 150)]);
  assert.deepEqual(s.map((d) => d.day), [10, 11]);
  assert.equal(s[0].totalEthWei, (540n * ETH / 100n).toString(), 'a day totals every pool read that day');
  assert.equal(s[0].pools.length, 2);
  assert.ok(s[0].complete && s[1].complete);
  console.log('ok - a day totals its pools');
}

{
  const s = tvlSeries([snap(10, 1, 'v1', 400), snap(10, 8453, 'evm', 140), snap(11, 1, 'v1', 395), snap(11, 8453, 'evm', 150)], new Map([[10, 12n * ETH]]));
  assert.equal(s[0].netChangeWei, (5n * ETH / 100n).toString(), '5.40 ETH at the start of day 10 and 5.45 at the start of day 11 is +0.05');
  assert.equal(s[0].grossDepositsWei, (12n * ETH).toString(), '12 ETH scored as deposited, 0.05 ETH kept');
  assert.equal(s[1].netChangeWei, null, 'the latest day is not closed yet');
  assert.equal(s[1].grossDepositsWei, '0');
  console.log('ok - net change is the next reading minus this one, set against the ETH scored as deposited');
}

{
  const gap = tvlSeries([snap(10, 1, 'v1', 400), snap(12, 1, 'v1', 400)]);
  assert.equal(gap[0].netChangeWei, null, 'a missing day is not guessed across');
  const partial = tvlSeries([snap(10, 1, 'v1', 400), snap(10, 8453, 'evm', 140), snap(11, 1, 'v1', 395), snap(12, 1, 'v1', 395), snap(12, 8453, 'evm', 150)]);
  assert.equal(partial[1].complete, false, 'a day that read fewer pools than the others is flagged');
  assert.equal(partial[0].netChangeWei, null, 'and no change is reported into it');
  assert.equal(partial[1].netChangeWei, null, 'or out of it');
  assert.deepEqual(tvlSeries([]), []);
  console.log('ok - a missing or partial day leaves the change unknown instead of guessing');
}

const dir = mkdtempSync(join(tmpdir(), 'points-tvl-'));
try {
  const store = openStore(join(dir, 'p.db'));
  assert.equal(store.savePoolSnapshot({ day: 20728, chainId: 1, pool: 'v1', ethWei: (4n * ETH).toString(), takenAt: 1 }), true);
  assert.equal(store.savePoolSnapshot({ day: 20728, chainId: 1, pool: 'v1', ethWei: (9n * ETH).toString(), takenAt: 2 }), false, 'the first reading of a day stands');
  store.savePoolSnapshot({ day: 20728, chainId: 8453, pool: 'evm', ethWei: (2n * ETH).toString(), takenAt: 1 });
  const rows = store.poolSnapshots(20728);
  assert.deepEqual(rows.map((r) => [r.day, r.chainId, r.pool, r.ethWei]), [[20728, 1, 'v1', (4n * ETH).toString()], [20728, 8453, 'evm', (2n * ETH).toString()]]);
  assert.equal(store.poolSnapshots(20729).length, 0, 'only days from the one asked for');

  const dep = (i, activity, wei, day) => ({ txHash: `0x${i.toString(16).padStart(64, '0')}`, blockNumber: i, blockTime: day * 86400 + 100, depositor: `0x${'a'.repeat(40)}`, amountWei: wei, priorDepositCount: 0, points: 1, activity });
  store.recordDeposit(dep(1, 'wrap', (3n * ETH).toString(), 20728));
  store.recordDeposit(dep(2, 'evmpooldeposit', (2n * ETH).toString(), 20728));
  store.recordDeposit(dep(3, 'zswapeth', (50n * ETH).toString(), 20728));            // a swap, not a deposit into a pool
  store.recordDeposit(dep(4, 'wrap', (1n * ETH).toString(), 20729));
  const gross = store.poolDepositWeiByDay(20728 * 86400, 20730 * 86400);
  assert.equal(gross.get(20728), 5n * ETH, 'wraps and EVM pool deposits count; swaps do not');
  assert.equal(gross.get(20729), 1n * ETH);
  console.log('ok - readings keep the first of each day, and deposits are summed per day as BigInts');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
