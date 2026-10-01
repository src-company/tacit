// Settlement gate (src/lib/points-settle-gate.js): a day settles only once it is over, a grace margin has passed
// and every scanner has read past its end; a scanner that stays behind cannot hold rewards back forever.
//   node worker-relay/tests/points-settle-gate.test.mjs

import assert from 'node:assert/strict';
import { settleThroughDay } from '../src/lib/points-settle-gate.js';

const DAY = 86400;
const D = 20727;                          // a day being settled
const end = (d) => (d + 1) * DAY;         // its last second + 1
const base = { lastProgramDay: 99999, graceSecs: 1800, maxWaitSecs: 6 * 3600 };
const gate = (nowSec, coveredThroughSec) => settleThroughDay({ ...base, nowSec, coveredThroughSec });

{
  assert.ok(gate(end(D) - 1, end(D) + 10) < D, 'a day still in progress never settles');
  assert.ok(gate(end(D) + 600, end(D) + 600) < D, 'inside the grace margin it waits, even if every scanner is caught up');
  assert.equal(gate(end(D) + 1800, end(D) + 1800), D, 'past the margin and fully scanned it settles');
  console.log('ok - a day settles only once it is over and the grace margin has passed');
}

{
  assert.ok(gate(end(D) + 3600, end(D) - 5) < D, 'a scanner still short of the day end holds it back');
  assert.ok(gate(end(D) + 3600, null) < D, 'unknown coverage holds it back rather than guessing');
  assert.equal(gate(end(D) + 3600, end(D)), D, 'a scanner exactly at the end has read the whole day');
  console.log('ok - an unfinished or unknown scan holds the day back');
}

{
  assert.ok(gate(end(D) + 5 * 3600, end(D) - 5) < D, 'five hours in, still waiting');
  assert.equal(gate(end(D) + 6 * 3600, end(D) - 5), D, 'after the maximum wait a stuck scanner no longer blocks it');
  assert.equal(gate(end(D) + 6 * 3600, null), D, 'nor does a scanner whose coverage can never be read');
  console.log('ok - a stuck scanner cannot block rewards past the maximum wait');
}

{
  assert.equal(settleThroughDay({ ...base, lastProgramDay: D - 3, nowSec: end(D) + 7 * 3600, coveredThroughSec: end(D) + 7 * 3600 }), D - 3,
    'the program end still caps it');
  assert.equal(gate(end(D + 2) + 1800, end(D + 2) + 1800), D + 2, 'several finished days can settle together');
  console.log('ok - the program end caps it and several days can settle together');
}
