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
