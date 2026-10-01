// The day's board (src/lib/points-day-board.js): the same pot /points reports, and the addresses ranked by today's points.
//   node worker-relay/tests/points-day-board.test.mjs

import assert from 'node:assert/strict';
import { dayPot, dayBoard } from '../src/lib/points-day-board.js';

const TAC = 10n ** 18n;
const budget = 1111n * TAC;
const rows = [
  { address: '0xB', dayPoints: 300 },
  { address: '0xA', dayPoints: 300 },
  { address: '0xC', dayPoints: 1200.5 },
  { address: '0xD', dayPoints: 0 },
];

{
  const { totalPoints, pot } = dayPot(rows, budget);
  assert.equal(totalPoints, 1800.5);
  assert.equal(pot, budget, 'with no ceiling the pot is the whole budget');
  assert.equal(dayPot([], budget).pot, budget, 'a day nobody has scored in still has its budget');
  assert.equal(dayPot([], budget).totalPoints, 0);
  console.log('ok - the pot is the budget when no ceiling applies');
}

{
  const cap = 3n * TAC / 100n; // 0.03 TAC per point
  const { pot } = dayPot(rows, budget, cap);
  assert.equal(pot, 1800n * cap + cap / 2n, 'a ceiling that binds trims the pot to points x rate');
  assert.equal(dayPot(rows, budget, 10n * TAC).pot, budget, 'a ceiling above the budget changes nothing');
  console.log('ok - the TAC-per-point ceiling trims the pot the way settlement does');
}

{
  const b = dayBoard(rows, { budgetWei: budget });
  assert.deepEqual(b.rows.map((r) => r.address), ['0xc', '0xa', '0xb'], 'ranked by points today, ties by address, scoreless addresses left out');
  assert.equal(b.taking, 3);
  assert.equal(b.totalPoints, 1800.5);
  assert.equal(b.dayBudgetWei, budget.toString());
  assert.deepEqual(dayBoard(rows, { budgetWei: budget, limit: 2 }).rows.map((r) => r.address), ['0xc', '0xa']);
  assert.equal(dayBoard(rows, { budgetWei: budget, limit: 2 }).taking, 3, 'the count is of everyone, not of the page');
  assert.deepEqual(dayBoard([], { budgetWei: budget }).rows, []);
  console.log('ok - the board ranks today\'s points and counts everyone taking part');
}

// The split settlement uses, and what each day paid one address.
import { splitDayBudget, dayHistory } from '../src/lib/points-day-board.js';

{
  const r = [{ address: '0xa', dayPoints: 100 }, { address: '0xb', dayPoints: 300 }];
  const paid = splitDayBudget(r, 1000n, null);
  assert.equal(paid.get('0xa'), 250n);
  assert.equal(paid.get('0xb'), 750n);
  assert.equal(splitDayBudget([], 1000n).size, 0, 'a day without points pays nothing');
  assert.equal(splitDayBudget([{ address: '0xa', dayPoints: 0 }], 1000n).size, 0);
  const capped = splitDayBudget(r, 1000n * TAC, 2n * TAC / 100n); // 0.02 TAC per point: 400 points earn 8 TAC
  assert.equal(capped.get('0xa'), 2n * TAC);
  assert.equal(capped.get('0xb'), 6n * TAC);
  console.log('ok - the day splits pro rata and a ceiling that binds trims the pot');
}

{
  const days = { 10: [{ address: '0xA', dayPoints: 100 }, { address: '0xB', dayPoints: 300 }], 11: [{ address: '0xb', dayPoints: 50 }], 12: [{ address: '0xA', dayPoints: 10 }, { address: '0xb', dayPoints: 10 }] };
  const reads = {}, ledger = { '0xa': 250n, '0xb': 1750n };
  const history = dayHistory({
    dayRowsFor: (d) => { reads[d] = (reads[d] || 0) + 1; return days[d] || []; },
    budgetFor: () => 1000n,
    capFor: (d) => (d === 12 ? 10n : null),   // a ceiling of 10 wei per point trims day 12 to 10 x 20 = 200
    ledgerFor: (a) => ledger[a],
  });
  const span = { fromDay: 9, throughDay: 12, lastSettledDay: 11 };
  const a = history('0xa', span);
  assert.deepEqual(a.days.map((d) => d.day), [12, 10], 'newest first, and days without points are left out');
  assert.deepEqual(a.days.map((d) => d.settled), [false, true], 'a day after the last settled one is marked so');
  assert.equal(a.days[1].tacWei, '250');
  assert.equal(a.days[0].tacWei, '100', 'today is read at the ceiling: 10 points at 10 wei a point');
  assert.equal(a.earnedWei, '250');
  assert.equal(a.reconciled, true);
  const b = history('0xB', span);
  assert.deepEqual(b.days.map((d) => d.tacWei), ['100', '1000', '750'], 'case does not matter and the same split serves every address');
  assert.equal(reads[10], 1, 'a settled day is read once, however many addresses ask');
  assert.equal(reads[12], 2, 'the day in progress is read each time');
  assert.deepEqual(history('0xc', span), { earnedWei: '0', reconciled: true, days: [] });
  console.log('ok - an address\'s days are what settlement pays, settled days are kept and today is not');

  ledger['0xb'] = 1700n;   // the ledger paid 50 less than the days re-split to: the settled days cannot be shown as paid
  const off = history('0xb', span);
  assert.equal(off.reconciled, false);
  assert.equal(off.earnedWei, '1700', 'what was earned is the ledger\'s');
  assert.deepEqual(off.days.map((d) => d.tacWei), ['100', null, null], 'settled days carry points only; today is still an estimate');
  assert.deepEqual(off.days.map((d) => d.points), [10, 50, 300]);
  console.log('ok - settled days that do not add up to the ledger carry points only');
}
