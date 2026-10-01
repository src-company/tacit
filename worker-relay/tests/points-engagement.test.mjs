// What a day's points count for (src/lib/points-engagement.js): the schedules, the weight of each activity, and the
// multiplier for breadth across kinds and for coming back within the week.
//   node worker-relay/tests/points-engagement.test.mjs

import assert from 'node:assert/strict';
import { parseCategoryWeights, categoryWeightsForDay, parseEngagementSchedule, engagementForDay, engagementFactor, countedRows, kindOf } from '../src/lib/points-engagement.js';

{
  const skipped = [];
  const s = parseCategoryWeights('20760:off; 20730:cbtcmint=3,cusdmint=2 ;bad;20740:x=0;20741:cbtcmint=21', (m) => skipped.push(m));
  assert.deepEqual(s.map((e) => e.fromDay), [20730, 20760], 'sorted, and the malformed entries are left out');
  assert.equal(skipped.length, 3, 'each malformed entry is reported');
  assert.deepEqual(categoryWeightsForDay(s, 20729), {}, 'nothing before the first day');
  assert.deepEqual(categoryWeightsForDay(s, 20730), { cbtcmint: 3, cusdmint: 2 });
  assert.deepEqual(categoryWeightsForDay(s, 20759), { cbtcmint: 3, cusdmint: 2 });
  assert.deepEqual(categoryWeightsForDay(s, 20760), {}, 'off ends them');
  assert.deepEqual(categoryWeightsForDay(parseCategoryWeights('20730:cbtcmint=3;20740:cusdmint=2'), 20745), { cusdmint: 2 }, 'a later entry replaces an earlier one');
  assert.deepEqual(categoryWeightsForDay(parseCategoryWeights(''), 20730), {});
  console.log('ok - weights apply from a day forward, a later entry replaces, off ends them');
}

{
  const skipped = [];
  const s = parseEngagementSchedule('20760:off;20730:0.25,0.25,2,25;20731:3,0.25,2,25;20732:0.25,0.25,2.5,25;nope', (m) => skipped.push(m));
  assert.deepEqual(s.map((e) => e.fromDay), [20730, 20760]);
  assert.equal(skipped.length, 3);
  assert.equal(engagementForDay(s, 20729), null);
  assert.deepEqual(engagementForDay(s, 20730), { kindStep: 0.25, returnStep: 0.25, maxKinds: 2, minPoints: 25 });
  assert.equal(engagementForDay(s, 20760), null);
  console.log('ok - the engagement schedule applies from a day forward and "off" ends it');
}

{
  const spec = { kindStep: 0.25, returnStep: 0.25, maxKinds: 2, minPoints: 25 };
  assert.equal(engagementFactor(null, { kinds: 3, activeDays: 5 }), 1);
  assert.equal(engagementFactor(spec, { kinds: 1, activeDays: 1 }), 1, 'one kind on one day earns no more');
  assert.equal(engagementFactor(spec, { kinds: 2, activeDays: 1 }), 1.25);
  assert.equal(engagementFactor(spec, { kinds: 1, activeDays: 2 }), 1.25, 'coming back counts');
  assert.equal(engagementFactor(spec, { kinds: 3, activeDays: 2 }), 1.75);
  assert.equal(engagementFactor(spec, { kinds: 6, activeDays: 7 }), 1.75, 'capped at maxKinds other kinds');
  assert.equal(engagementFactor(spec, { kinds: 0, activeDays: 0 }), 1);
  console.log('ok - the multiplier is one step per other kind (to the cap) and one for coming back');
}

{
  assert.equal(kindOf('wrap'), 'private');
  assert.equal(kindOf('evmpooldeposit'), 'private', 'the two private pools are one kind');
  assert.equal(kindOf('cbtcmint'), kindOf('cusdmint'));
  assert.equal(kindOf('brandnew'), 'brandnew', 'an unlisted activity is its own kind');
  console.log('ok - activities group into the kinds the page groups them by');
}

{
  const A = '0xaaa', B = '0xbbb', C = '0xccc';
  const spec = { kindStep: 0.25, returnStep: 0.25, maxKinds: 2, minPoints: 25 };
  const dayRows = [
    { address: A, activity: 'wrap', points: 100 }, { address: A, activity: 'zswapeth', points: 100 },
    { address: B, activity: 'cbtcmint', points: 100 },
    { address: C, activity: 'wrap', points: 40 },
  ];
  const weekRows = [
    { address: A, day: 10, activity: 'wrap', points: 100 }, { address: A, day: 10, activity: 'zswapeth', points: 100 },
    { address: B, day: 9, activity: 'cbtcmint', points: 50 }, { address: B, day: 10, activity: 'cbtcmint', points: 100 }, { address: B, day: 8, activity: 'weiname', points: 5 },
    { address: C, day: 10, activity: 'wrap', points: 40 }, { address: C, day: 6, activity: 'zswapeth', points: 80 },
  ];
  const plain = countedRows({ dayRows, weekRows });
  assert.deepEqual(Object.fromEntries(plain.map((r) => [r.address, r.dayPoints])), { [A]: 200, [B]: 100, [C]: 40 }, 'with no weights and no spec the day counts as scored');
  assert.ok(plain.every((r) => r.factor === 1 && r.rawPoints === r.dayPoints));

  const weighted = countedRows({ dayRows, weekRows, weights: { cbtcmint: 3 } });
  assert.equal(weighted.find((r) => r.address === B).dayPoints, 300);
  assert.equal(weighted.find((r) => r.address === B).rawPoints, 100, 'the raw points stay what the activity scored');
  assert.equal(weighted.find((r) => r.address === A).dayPoints, 200, 'other activities are untouched');

  const e = Object.fromEntries(countedRows({ dayRows, weekRows, spec }).map((r) => [r.address, r]));
  assert.equal(e[A].kinds, 2); assert.equal(e[A].activeDays, 1); assert.equal(e[A].factor, 1.25, 'two kinds, one day');
  assert.equal(e[A].dayPoints, 250);
  assert.equal(e[B].kinds, 1, 'a kind under minPoints (5 of names) does not count'); assert.equal(e[B].activeDays, 3); assert.equal(e[B].factor, 1.25, 'returning on other days');
  assert.equal(e[C].kinds, 2); assert.equal(e[C].activeDays, 2); assert.equal(e[C].factor, 1.5, 'two kinds and returning');
  assert.equal(e[C].dayPoints, 60);

  const both = Object.fromEntries(countedRows({ dayRows, weekRows, spec, weights: { cbtcmint: 3 } }).map((r) => [r.address, r.dayPoints]));
  assert.equal(both[B], 375, 'the weight and the multiplier compose: 100 × 3 × 1.25');
  const order = countedRows({ dayRows: [...dayRows].reverse(), weekRows: [...weekRows].reverse(), spec, weights: { cbtcmint: 3 } });
  assert.deepEqual(Object.fromEntries(order.map((r) => [r.address, r.dayPoints])), both, 'the order the rows arrive in changes nothing');
  console.log('ok - a day counts activity at its weight, times the multiplier for kinds and for returning');
}
