// Distributor funding (src/lib/points-funding.js): how many whole days the headroom covers, when the next top-up is due,
// and when it is already short.
//   node worker-relay/tests/points-funding.test.mjs

import assert from 'node:assert/strict';
import { fundingStatus, fundingVerdict } from '../src/lib/points-funding.js';

const TAC = 10n ** 18n;
const DAY = 86400;
const budgetFor = () => 1111n * TAC;          // a flat day budget, enough to test the arithmetic
const base = { budgetFor, nextDay: 20727, graceSecs: 1800 };

{
  const s = fundingStatus({ ...base, heldWei: 14_943n * TAC, claimedWei: 614n * TAC, ledgerWei: 9_428n * TAC });
  assert.equal(s.fundedWei, 15_557n * TAC);
  assert.equal(s.headroomWei, 6_129n * TAC);
  assert.equal(s.daysCovered, 5, '6,129 TAC covers five whole 1,111 TAC days');
  assert.equal(s.topUpBeforeSec, (20727 + 5 + 1) * DAY + 1800, 'the sixth day settles at its own midnight plus the grace margin');
  assert.equal(s.shortfallWei, 0n);
  assert.equal(fundingVerdict(s), 'ok');
  console.log('ok - the headroom is counted in whole days and dates the next top-up');
}

{
  const s = fundingStatus({ ...base, heldWei: 7_163n * TAC, claimedWei: 614n * TAC, ledgerWei: 7_777n * TAC });
  assert.equal(s.daysCovered, 0, 'a day short of a whole budget covers none');
  assert.equal(s.topUpBeforeSec, (20727 + 1) * DAY + 1800, 'so the very next settle needs funding');
  assert.equal(fundingVerdict(s), 'warning');
  console.log('ok - barely any headroom is a warning dated at the next settle');
}

{
  const s = fundingStatus({ ...base, heldWei: 7_000n * TAC, claimedWei: 614n * TAC, ledgerWei: 7_777n * TAC });
  assert.equal(s.shortfallWei, 163n * TAC, 'a ledger past the funding is a shortfall');
  assert.equal(s.topUpBeforeSec, null);
  assert.equal(fundingVerdict(s), 'critical');
  console.log('ok - a ledger already past the funding is critical');
}

{
  assert.equal(fundingVerdict(fundingStatus({ ...base, heldWei: 9_000n * TAC, claimedWei: 0n, ledgerWei: 5_000n * TAC })), 'ok', '3.6 days covered');
  assert.equal(fundingVerdict(fundingStatus({ ...base, heldWei: 7_000n * TAC, claimedWei: 0n, ledgerWei: 5_000n * TAC })), 'warning', '1.8 days covered');
  assert.equal(fundingVerdict(fundingStatus({ ...base, heldWei: 8_000n * TAC, claimedWei: 0n, ledgerWei: 5_000n * TAC }), { warnDays: 2 }), 'ok', 'a custom threshold applies');
  const zero = fundingStatus({ ...base, budgetFor: () => 0n, heldWei: 5n * TAC, claimedWei: 0n, ledgerWei: 0n });
  assert.equal(zero.daysCovered, 0, 'a program that has ended covers no further days');
  console.log('ok - the warning threshold is in whole days, and an ended program covers none');
}
