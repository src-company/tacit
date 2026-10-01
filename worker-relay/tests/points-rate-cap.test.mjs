// TAC-per-point ceiling (src/lib/points-rate-cap.js): schedule parsing, which day an entry governs, and how
// the ceiling trims a day's pot.
//   node worker-relay/tests/points-rate-cap.test.mjs

import assert from 'node:assert/strict';
import { POINTS_SCALE, parseRateCapSchedule, rateCapForDay, applyRateCeiling } from '../src/lib/points-rate-cap.js';

const TAC = 10n ** 18n;
const budget = 100_000n * TAC / 90n; // a day of the 100,000 TAC / 90-day program
const scaledPoints = (p) => BigInt(Math.round(p * POINTS_SCALE));

{
  const warnings = [];
  const s = parseRateCapSchedule(' 20790:off , 20729:0.03, nonsense, 20800:-1, 20801:0, 20802:abc ', (m) => warnings.push(m));
  assert.deepEqual(s.map((e) => e.fromDay), [20729, 20790], 'valid entries survive, sorted by day');
  assert.equal(s[0].maxWeiPerPoint, 3n * TAC / 100n);
  assert.equal(s[1].maxWeiPerPoint, null, '"off" lifts the ceiling');
  assert.equal(warnings.length, 4, 'every malformed entry is reported');
  assert.deepEqual(parseRateCapSchedule('', () => assert.fail('nothing to report')), []);
  assert.deepEqual(parseRateCapSchedule(undefined), []);
  console.log('ok - the schedule parses, sorts, and skips malformed entries loudly');
}

{
  const s = parseRateCapSchedule('20729:0.03,20790:off,20800:0.02');
  assert.equal(rateCapForDay(s, 20728), null, 'no ceiling before the first entry');
  assert.equal(rateCapForDay(s, 20729), 3n * TAC / 100n, 'an entry governs from its own day');
  assert.equal(rateCapForDay(s, 20789), 3n * TAC / 100n);
  assert.equal(rateCapForDay(s, 20790), null, '"off" ends it');
  assert.equal(rateCapForDay(s, 20850), 2n * TAC / 100n, 'a later entry brings it back');
  assert.equal(rateCapForDay([], 20729), null);
  console.log('ok - each day is governed by the latest entry at or before it');
}

{
  const cap = 3n * TAC / 100n; // 0.03 TAC per point
  const quiet = scaledPoints(7645); // a day with little activity
  const busy = scaledPoints(75616);
  assert.equal(applyRateCeiling(budget, quiet, cap), 7645n * cap, 'a quiet day pays the ceiling rate, not the whole budget');
  assert.ok(applyRateCeiling(budget, quiet, cap) < budget / 4n);
  assert.equal(applyRateCeiling(budget, busy, cap), budget, 'a busy day is still paid out in full');
  assert.equal(applyRateCeiling(budget, quiet, null), budget, 'no ceiling leaves the budget alone');
  assert.equal(applyRateCeiling(budget, 0n, cap), 0n, 'no points, no pot');
  const edge = budget * BigInt(POINTS_SCALE) / cap + 1n; // the smallest day whose points just cover the budget
  assert.equal(applyRateCeiling(budget, edge, cap), budget);
  assert.ok(applyRateCeiling(budget, edge - 2n, cap) < budget);
  console.log('ok - the ceiling only trims a day whose pot would pay more than the cap per point');
}
