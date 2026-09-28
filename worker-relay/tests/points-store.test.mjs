// Points store (src/lib/points-store.js): the V1-wrap early-bonus divisor recovered at startup counts wraps only,
// never the rows of other activities, which keep their own divisors.
//   node worker-relay/tests/points-store.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/lib/points-store.js';

const dir = mkdtempSync(join(tmpdir(), 'points-store-'));
try {
  const store = openStore(join(dir, 'points.db'));
  const row = (i, activity) => ({
    txHash: `0x${i.toString(16).padStart(64, '0')}`, blockNumber: i, blockTime: i, depositor: `0x${'a'.repeat(40)}`,
    amountWei: '1000000000000000000', priorDepositCount: 0, points: 1, ...(activity ? { activity } : {}),
  });
  store.recordDeposit(row(1));
  store.recordDeposit(row(2));
  for (const [i, a] of [[3, 'zswapeth'], [4, 'weiname'], [5, 'cbtcmint'], [6, 'evmpooldeposit'], [7, 'cusdmint']]) store.recordDeposit(row(i, a));
  store.saveCursor({ lastScannedBlock: 7n, ethDepositCount: 2 });
  assert.equal(store.loadCursor().ethDepositCount, 2);
  assert.equal(store.countByActivity('wrap'), 2);
  console.log('ok - the wrap bonus divisor counts wraps only');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
