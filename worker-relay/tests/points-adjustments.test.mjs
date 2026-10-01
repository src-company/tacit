// Ledger adjustments (src/lib/points-adjustments.js and the store's applyAdjustment): strict parsing, each id applied
// once, add-only, and exact past SQLite's 64-bit integers.
//   node worker-relay/tests/points-adjustments.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAdjustments, MAX_ADJUSTMENT_WEI } from '../src/lib/points-adjustments.js';
import { openStore } from '../src/lib/points-store.js';

const A = `0x${'ab'.repeat(20)}`;
const B = `0x${'CD'.repeat(20)}`;
const TAC = 10n ** 18n;

{
  const warnings = [];
  const list = parseAdjustments(JSON.stringify([
    { id: 'ok-1', address: A, wei: '1106740438842876006856' },
    { id: 'ok-2', address: B, wei: '5' },
    { id: 'ok-1', address: A, wei: '7' },                        // duplicate id
    { id: 'bad id', address: A, wei: '7' },
    { id: 'short', address: '0x1234', wei: '7' },
    { id: 'zero', address: A, wei: '0' },
    { id: 'neg', address: A, wei: '-5' },
    { id: 'float', address: A, wei: '1.5' },
    { id: 'huge', address: A, wei: (MAX_ADJUSTMENT_WEI + 1n).toString() },
    { id: 'edge', address: A, wei: MAX_ADJUSTMENT_WEI.toString() },
    null,
  ]), (m) => warnings.push(m));
  assert.deepEqual(list.map((e) => e.id), ['ok-1', 'ok-2', 'edge'], 'only well-formed entries survive');
  assert.equal(list[0].wei, 1106740438842876006856n);
  assert.equal(list[1].address, `0x${'cd'.repeat(20)}`, 'addresses are lowercased');
  assert.equal(warnings.length, 8, 'every rejected entry is reported');
  for (const bad of [undefined, '', 'not json', '{"id":"x"}', '"x"']) assert.deepEqual(parseAdjustments(bad), []);
  console.log('ok - only well-formed entries parse, and the rest are reported and credit nothing');
}

const dir = mkdtempSync(join(tmpdir(), 'points-adj-'));
try {
  const store = openStore(join(dir, 'p.db'));
  const adj = { id: 'late-1', address: A, wei: 1106740438842876006856n };
  assert.equal(store.rewardFor(A), '0');
  assert.equal(store.applyAdjustment(adj), true);
  assert.equal(store.rewardFor(A), '1106740438842876006856', 'the credit is exact, far past 2^63 wei');
  assert.equal(store.applyAdjustment(adj), false, 'the same id never applies twice');
  assert.equal(store.applyAdjustment({ ...adj, wei: 5n * TAC }), false, 'a changed amount under an applied id is ignored');
  assert.equal(store.rewardFor(A), '1106740438842876006856');
  console.log('ok - a credit applies once, exactly, and replays or edits under the same id do nothing');

  store.applyDayRewards(new Map([[A, 3n * TAC]]));
  assert.equal(store.applyAdjustment({ id: 'late-2', address: A, wei: 2n * TAC }), true);
  assert.equal(store.rewardFor(A), (1106740438842876006856n + 5n * TAC).toString(), 'it adds to what is already there');
  assert.equal(store.applyAdjustment({ id: 'zero', address: A, wei: 0n }), false);
  assert.equal(store.applyAdjustment({ id: 'neg', address: A, wei: -1n }), false);
  assert.equal(store.rewardFor(A), (1106740438842876006856n + 5n * TAC).toString(), 'it never lowers a balance');
  console.log('ok - credits add to existing rewards and never lower them');

  const listed = store.listAdjustments();
  assert.deepEqual(listed.map((r) => r.id).sort(), ['late-1', 'late-2'], 'applied credits are listed for audit');
  assert.ok(listed.every((r) => Number.isInteger(r.appliedAt) && r.address === A));
  store.db.close();
  const reopened = openStore(join(dir, 'p.db'));
  assert.equal(reopened.applyAdjustment(adj), false, 'applied ids survive a restart');
  assert.equal(reopened.rewardFor(A), (1106740438842876006856n + 5n * TAC).toString());
  console.log('ok - applied credits are listed and survive a restart');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
