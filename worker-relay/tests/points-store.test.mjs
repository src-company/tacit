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

  const RELAY = '0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7';
  const guarded = openStore(join(dir, 'guarded.db'), { excluded: [RELAY] });
  assert.equal(guarded.recordDeposit({ ...row(8, 'cusdmint'), depositor: RELAY.toLowerCase() }), false);
  assert.equal(guarded.recordDeposit({ ...row(9, 'cusdmint'), depositor: `0x${'b'.repeat(40)}` }), true);
  assert.equal(guarded.countByActivity('cusdmint'), 1);
  assert.equal(guarded.totalFor(RELAY.toLowerCase())?.points ?? 0, 0);
  console.log('ok - an excluded sender earns nothing for any activity');

  // One address's cumulative amount passes SQLite's 64-bit INTEGER (about 9.2 ETH in wei) well before any single
  // deposit does; the total must stay exact, and a total already damaged is repaired from the deposits on open.
  const WHALE = `0x${'c'.repeat(40)}`;
  const big = openStore(join(dir, 'big.db'));
  const wei = (eth) => (BigInt(eth) * 10n ** 18n).toString();
  for (const [i, eth] of [[1, 5], [2, 5], [3, 5], [4, 1]]) {
    assert.equal(big.recordDeposit({ ...row(i), depositor: WHALE, amountWei: wei(eth) }), true);
  }
  assert.equal(big.totalFor(WHALE).amount_wei, wei(16), 'the running total is exact past 2^63 wei');
  assert.equal(big.totalFor(WHALE).deposit_count, 4);
  console.log('ok - an address total stays exact past 2^63 wei');

  big.db.prepare('UPDATE totals SET amount_wei = ? WHERE address = ?').run('9223372036854775807', WHALE);
  big.db.close();
  const reopened = openStore(join(dir, 'big.db'));
  assert.equal(reopened.totalFor(WHALE).amount_wei, wei(16), 'a damaged total is recomputed from the deposits');
  assert.equal(reopened.totalFor(WHALE).deposit_count, 4);
  console.log('ok - a total damaged by the old 64-bit sum is repaired on open');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
