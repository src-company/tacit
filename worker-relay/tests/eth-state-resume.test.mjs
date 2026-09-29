// The eth-state sidecar's resume check (src/lib/eth-state-resume.js).
//   node worker-relay/tests/eth-state-resume.test.mjs

import assert from 'node:assert/strict';
import { resumeMismatch } from '../src/lib/eth-state-resume.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok - ${name}`); };
const recs = (k) => Array.from({ length: k }, (_, i) => ({ i }));
const state = (co, cn, lastBlock) => ({ last_block: lastBlock, crossouts: recs(co), consumeds: recs(cn), bootstrap_slot: 1 });
const folded = (co, cn, lastBlock) => ({ contentHash: '0x3e51', crossouts: recs(co), consumeds: recs(cn), lastBlock });

test('the committed file of the folded candidate continues the chain, whatever Ethereum has recorded since', () => {
  // Nothing about the pool's own counters enters the check: a consume recorded after the last fold is what the
  // next candidate folds, not a sign the resume file fell behind.
  assert.equal(resumeMismatch({ committed: state(9, 1, 26070054), confirmed: folded(9, 1, 26070054) }), null);
});

test('a lost commit that added entries is caught', () => {
  const why = resumeMismatch({ committed: state(9, 1, 26070054), confirmed: folded(9, 2, 26075273) });
  assert.match(why, /9 crossout\(s\)\/1 consumed through block 26070054/);
  assert.match(why, /\(0x3e51\) has 9 crossout\(s\)\/2 consumed through block 26075273/);
});

test('a lost commit that added no entries is caught by its block', () => {
  assert.ok(resumeMismatch({ committed: state(9, 1, 26069894), confirmed: folded(9, 1, 26070054) }));
});

test('no committed file while a candidate has been folded is caught (a from-zero rescan cannot continue it)', () => {
  assert.match(resumeMismatch({ committed: null, confirmed: folded(9, 1, 26070054) }), /is missing/);
});

test('a cold start or a cleared confirmed record has nothing to check against', () => {
  assert.equal(resumeMismatch({ committed: null, confirmed: null }), null);
  assert.equal(resumeMismatch({ committed: state(9, 1, 26070054), confirmed: null }), null);
  assert.equal(resumeMismatch({ committed: state(9, 1, 26070054), confirmed: { contentHash: '0x1' } }), null);
});

test('block numbers compare by value', () => {
  assert.equal(resumeMismatch({ committed: state(1, 0, 5), confirmed: { ...folded(1, 0, 5), lastBlock: '5' } }), null);
});

console.log(`${n} passed`);
