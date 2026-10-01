// The eth-state sidecar's resume check (src/lib/eth-state-resume.js).
//   node worker-relay/tests/eth-state-resume.test.mjs

import assert from 'node:assert/strict';
import { resumeMismatch, rebuildFromConfirmed } from '../src/lib/eth-state-resume.js';

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

// A committed file as eth_prove writes it, and the published candidate it stands for (eth_set.json's shape).
const h = (b, i) => '0x' + (b + i.toString(16)).padStart(64, '0');
const co = (k) => Array.from({ length: k }, (_, i) => ({ claim_id: h('c1', i), dest_chain: 8453, dest_commitment: h('d2', i), nullifier: h('e3', i), asset_id: h('a4', i) }));
const cn = (k) => Array.from({ length: k }, (_, i) => ({ nullifier: h('f5', i), spend_root: h('b6', i), btc_spend_root: h('97', i) }));
const file = (k, j, lastBlock, slot = 13000000) => ({ last_block: lastBlock, crossouts: co(k), consumeds: cn(j), bootstrap_slot: slot });
const pvWithSlot = (slot) => '0x' + '00'.repeat(32 * 5) + slot.toString(16).padStart(64, '0') + '11'.repeat(32 * 5);
const candidate = (k, j, lastBlock, slot) => ({
  contentHash: '0xf05d', lastBlock, ethPv: pvWithSlot(slot),
  crossouts: co(k).map((r) => ({ claimId: r.claim_id, destCommitment: r.dest_commitment, asset: r.asset_id })),
  consumeds: cn(j).map((r) => ({ nu: r.nullifier, consumedVal: r.spend_root, spendRoot: r.btc_spend_root })),
});

test('a folded candidate that added no entries rebuilds the committed file as eth_prove would have written it', () => {
  const was = file(9, 2, 26093404), folded = candidate(9, 2, 26093883, 13377001);
  const next = rebuildFromConfirmed({ committed: was, confirmed: folded });
  assert.deepEqual(next, { ...was, last_block: 26093883, bootstrap_slot: 13377001 });
  assert.equal(resumeMismatch({ committed: next, confirmed: folded }), null, 'and it then continues the chain');
  assert.deepEqual(next.crossouts[0], was.crossouts[0], 'every record kept whole, dest_chain and nullifier included');
});

test('nothing is rebuilt when the folded candidate holds other records, more of them, or an earlier block', () => {
  const was = file(9, 2, 26093404);
  assert.equal(rebuildFromConfirmed({ committed: was, confirmed: candidate(9, 3, 26093883, 1) }), null, 'a consume it never recorded');
  assert.equal(rebuildFromConfirmed({ committed: was, confirmed: candidate(10, 2, 26093883, 1) }), null, 'a cross-out it never recorded');
  const other = candidate(9, 2, 26093883, 1); other.crossouts[4] = { ...other.crossouts[4], destCommitment: h('99', 4) };
  assert.equal(rebuildFromConfirmed({ committed: was, confirmed: other }), null, 'a record that differs');
  assert.equal(rebuildFromConfirmed({ committed: was, confirmed: candidate(9, 2, 26093000, 1) }), null, 'a block behind the file');
  assert.equal(rebuildFromConfirmed({ committed: was, confirmed: { ...candidate(9, 2, 26093883, 1), ethPv: '0x00' } }), null, 'no finalized slot to read');
  assert.equal(rebuildFromConfirmed({ committed: null, confirmed: candidate(9, 2, 26093883, 1) }), null, 'no file to rebuild from');
});

console.log(`${n} passed`);
