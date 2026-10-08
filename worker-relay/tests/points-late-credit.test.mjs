// A day settled without a scanner that was behind (src/lib/points-late-credit.js with the store): rows recorded after their
// day settled are marked late and left out of what the day paid; once the scanners have read past the day, each address is
// credited the difference between what the day would have paid it with every row and what it was paid. Add-only, bounded by
// the day's pot, applied once, and again only for the difference when more late rows arrive.
//   node worker-relay/tests/points-late-credit.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/lib/points-store.js';
import { makeCounted } from '../src/lib/points-counted.js';
import { splitDayBudget } from '../src/lib/points-day-board.js';
import { owedForDay, creditLateDays } from '../src/lib/points-late-credit.js';

const D = 20733, DAY = 86400, BUDGET = 1000n * 10n ** 18n;
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
let n = 0;
const dep = (depositor, day, points, extra = {}) => ({ txHash: '0x' + (++n).toString(16).padStart(64, '0'), blockNumber: n, blockTime: day * DAY + 100 + n, depositor, amountWei: '10000000000000000', priorDepositCount: 0, points, activity: 'evmpooldeposit', chainId: 8453, ...extra });
const ok = (m) => console.log('ok -', m);

// owedForDay alone: the late rows' share, nothing for whoever they would have diluted.
{
  const onTime = [{ address: A, dayPoints: 300 }, { address: B, dayPoints: 100 }];
  const all = [...onTime, { address: C, dayPoints: 400 }];
  const owed = owedForDay({ allRows: all, onTimeRows: onTime, budgetWei: BUDGET });
  assert.equal(owed.get(C.toLowerCase()), BUDGET / 2n, 'C would have had half the pot');
  assert.equal(owed.has(A.toLowerCase()) || owed.has(B.toLowerCase()), false, 'A and B, already paid more than their full-day share, are owed nothing and keep what they have');
  ok('a late address is owed the share it would have had, and nobody it would have diluted is owed or charged anything');
  const both = owedForDay({ allRows: [{ address: A, dayPoints: 300 }, { address: C, dayPoints: 300 }], onTimeRows: [{ address: A, dayPoints: 100 }, { address: C, dayPoints: 300 }], budgetWei: BUDGET });
  assert.equal(both.get(A.toLowerCase()), BUDGET / 2n - BUDGET / 4n, 'an address with rows on time and late is owed only the difference');
  ok('an address with rows both on time and late is owed only the difference');
}

const dir = mkdtempSync(join(tmpdir(), 'points-late-'));
try {
  const store = openStore(join(dir, 'p.db'));
  // Day D: A and B are recorded on time, and the day settles with them.
  store.recordDeposit(dep(A, D, 300));
  store.recordDeposit(dep(B, D, 100));
  const counted = (onTime) => makeCounted({ store, onTime });
  const paid = splitDayBudget(counted(false).rows(D), BUDGET);
  store.commitDay(paid, { lastSettledDay: D, publishedRoot: null, publishedTotalWei: null, knobs: null });
  // A scanner that was behind records C's rows for day D afterwards, and one row for the open day D+1.
  store.recordDeposit(dep(C, D, 250));
  store.recordDeposit(dep(C, D, 150));
  store.recordDeposit(dep(C, D + 1, 50));
  assert.deepEqual(store.lateDays(), [{ day: D, n: 2 }], 'only the rows for the settled day are late');
  assert.deepEqual(counted(true).rows(D).map((r) => r.address).sort(), [A, B].sort(), 'the on-time rows are what the day was settled with');
  assert.equal(counted(false).rows(D).length, 3);
  ok('rows recorded after their day settled are marked late; the open day\'s are not');

  const args = { store, lastSettledDay: D, firstDay: D - 10, rowsFor: (d, { onTime }) => counted(onTime).rows(d), budgetFor: () => BUDGET, capFor: () => null };
  // Not yet: the scanners have not read past the day.
  assert.deepEqual(creditLateDays({ ...args, coveredThroughSec: (D + 1) * DAY - 1 }), []);
  assert.deepEqual(creditLateDays({ ...args, coveredThroughSec: null }), []);
  ok('nothing is credited before every scanner has read past the day');

  const before = BigInt(store.allRewards().find((r) => r.address === C.toLowerCase())?.cumulativeWei ?? 0);
  const out = creditLateDays({ ...args, coveredThroughSec: (D + 1) * DAY + 60 });
  assert.equal(out.length, 1);
  assert.equal(out[0].address, C.toLowerCase());
  assert.equal(out[0].wei, BUDGET / 2n, 'C is credited what the day would have paid it: 400 of 800 points');
  const after = new Map(store.allRewards().map((r) => [r.address, BigInt(r.cumulativeWei)]));
  assert.equal(after.get(C.toLowerCase()) - before, BUDGET / 2n);
  assert.equal(after.get(A.toLowerCase()), paid.get(A), 'A keeps what it was paid');
  assert.equal(after.get(B.toLowerCase()), paid.get(B), 'B keeps what it was paid');
  ok('once the scanners have read past it, the late address is credited its full-day share, and the others keep what they were paid');

  assert.deepEqual(creditLateDays({ ...args, coveredThroughSec: (D + 1) * DAY + 120 }), [], 'run again: nothing new, nothing credited');
  store.recordDeposit(dep(C, D, 400));
  const more = creditLateDays({ ...args, coveredThroughSec: (D + 1) * DAY + 180 });
  const full = splitDayBudget(counted(false).rows(D), BUDGET).get(C.toLowerCase());
  assert.equal(more.length, 1);
  assert.equal(more[0].wei, full - BUDGET / 2n, 'a further late row credits only the difference');
  const total = BigInt(store.allRewards().find((r) => r.address === C.toLowerCase()).cumulativeWei);
  assert.equal(total, full, 'in all, C holds exactly what the day would have paid it');
  assert.ok(store.listAdjustments().every((a) => /^late-20733-0x[c]{40}-\d+$/.test(a.id)), 'each credit is a listed adjustment');
  ok('credited once, then again only for the difference when more late rows arrive; each credit is a listed adjustment');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('\nall points-late-credit checks passed');
