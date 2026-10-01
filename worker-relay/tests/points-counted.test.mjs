// The rows a day's pot is split by (src/lib/points-counted.js with the store and src/lib/points-bond-hold.js): a day
// before anything applies is exactly the store's sums, and after, activity counts at its weight times the week's
// multiplier, with a released bond left out for good.
//   node worker-relay/tests/points-counted.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/lib/points-store.js';
import { makeCounted } from '../src/lib/points-counted.js';
import { decideBondHolds } from '../src/lib/points-bond-hold.js';
import { parseCategoryWeights, parseEngagementSchedule } from '../src/lib/points-engagement.js';

const D = 20730, DAY = 86400;
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
let n = 0;
const dep = (depositor, day, activity, points, extra = {}) => ({ txHash: '0x' + (++n).toString(16).padStart(64, '0'), blockNumber: n, blockTime: day * DAY + 100 + n, depositor, amountWei: '1000000000000000000', priorDepositCount: 0, points, activity, ...extra });
const by = (rows) => Object.fromEntries(rows.map((r) => [r.address, r]));

const dir = mkdtempSync(join(tmpdir(), 'points-counted-'));
try {
  const store = openStore(join(dir, 'p.db'));
  // Before the first counted day: A wrapped and swapped, B bonded.
  store.recordDeposit(dep(A, D - 3, 'wrap', 100.1));
  store.recordDeposit(dep(A, D - 3, 'zswapeth', 50.2));
  store.recordDeposit(dep(B, D - 3, 'cbtcmint', 70.3));
  // The first counted day.
  store.recordDeposit(dep(A, D, 'wrap', 100));
  store.recordDeposit(dep(B, D, 'cbtcmint', 100));
  store.recordDeposit(dep(C, D, 'wrap', 40));

  const weightSchedule = parseCategoryWeights(`${D}:cbtcmint=3`);
  const engagementSchedule = parseEngagementSchedule(`${D}:0.25,0.25,2,25`);
  const counted = makeCounted({ store, weightSchedule, engagementSchedule });

  const before = counted.rows(D - 3), legacy = store.dayPointsByAddress((D - 3) * DAY, (D - 2) * DAY);
  assert.deepEqual(before.map((r) => [r.address, r.dayPoints]), legacy.map((r) => [r.address, r.dayPoints]), 'a day before anything applies is exactly the store\'s sums');
  assert.ok(before.every((r) => r.factor === 1 && r.rawPoints === r.dayPoints));
  console.log('ok - a day before any weight or multiplier applies re-splits to the same figures');

  const on = by(counted.rows(D));
  assert.equal(on[B].dayPoints, 100 * 3 * 1.25, 'B: the bond at its weight, and returning (it was active 3 days earlier)');
  assert.equal(on[B].rawPoints, 100);
  assert.equal(on[A].factor, 1.5, 'A: two kinds this week (private, swap) and two days');
  assert.equal(on[A].dayPoints, 150);
  assert.equal(on[C].factor, 1, 'C: one kind, one day');
  console.log('ok - from the first day, activity counts at its weight times the week\'s multiplier');

  // Bonds: two on D, one more on D + 1. The funder of the first has taken the escrow back.
  const first = dep(B, D, 'cbtcmint', 10), second = dep(C, D, 'cbtcmint', 10), next = dep(C, D + 1, 'cbtcmint', 10);
  for (const d of [first, second, next]) store.recordDeposit(d);
  store.saveBondRef({ txHash: first.txHash, outpoint: '0x' + '01'.repeat(32), funder: B });
  store.saveBondRef({ txHash: second.txHash, outpoint: '0x' + '02'.repeat(32), funder: C });
  store.saveBondRef({ txHash: next.txHash, outpoint: '0x' + '03'.repeat(32), funder: C });
  const bondCounted = makeCounted({ store, weightSchedule: [], engagementSchedule: [], bondHoldFromDay: D });
  const sums = () => by(bondCounted.rows(D));
  assert.equal(sums()[B].dayPoints, 110, 'before a bond is checked it counts');

  const seen = [];
  const r = await decideBondHolds({ store, day: D, readEscrow: async (o, f) => { seen.push([o.slice(0, 6), f]); return f === B ? 0n : 10n ** 18n; } });
  assert.deepEqual(r, { checked: 2, released: 1 });
  assert.deepEqual(seen.map((x) => x[1]), [B, C], 'each bond of the day is read, in order');
  assert.equal(sums()[B].dayPoints, 100, 'a released bond no longer counts');
  assert.equal(sums()[C].dayPoints, 50, 'a bond still posted does');
  assert.equal(by(bondCounted.rows(D + 1))[C].dayPoints, 10, 'a later day\'s bond is not checked with this one');
  assert.equal((await decideBondHolds({ store, day: D, readEscrow: async () => { throw new Error('must not be read again'); } })).checked, 0, 'each bond is read once');
  assert.equal(store.saveBondCheck(first.txHash, true, 1), false, 'and the first answer stands');
  assert.equal(sums()[B].dayPoints, 100);
  console.log('ok - a bond counts only if its escrow is still posted when its day settles, and the answer is final');

  // An unreadable escrow leaves the day undecided.
  const flaky = dep(A, D + 2, 'cbtcmint', 10);
  store.recordDeposit(flaky);
  store.saveBondRef({ txHash: flaky.txHash, outpoint: '0x' + '04'.repeat(32), funder: A });
  await assert.rejects(decideBondHolds({ store, day: D + 2, readEscrow: async () => { throw new Error('rpc down'); } }), /rpc down/);
  assert.equal(store.bondsToCheck((D + 2) * DAY, (D + 3) * DAY).length, 1, 'and the bond is still waiting to be checked');
  assert.equal(by(bondCounted.rows(D + 2))[A].dayPoints, 10, 'it counts until it is');
  // A row with no reference (before refs were kept) is never gated.
  const old = dep(A, D + 3, 'cbtcmint', 12);
  store.recordDeposit(old);
  assert.equal(store.bondsToCheck((D + 3) * DAY, (D + 4) * DAY).length, 0);
  assert.equal(by(bondCounted.rows(D + 3))[A].dayPoints, 12);
  console.log('ok - an unreadable escrow leaves the day undecided, and a bond with no reference is left as it was');

  // One-off markers, and an address's listed activity ordered by when it happened.
  assert.equal(store.getMeta('x'), null);
  store.setMeta('x', 1);
  assert.equal(store.getMeta('x'), '1');
  store.setMeta('x', 2);
  assert.equal(store.getMeta('x'), '2');
  const recent = dep(A, D + 20, 'wrap', 5, { blockNumber: 1 }), earlier = dep(A, D + 19, 'wrap', 5, { blockNumber: 999999 });
  store.recordDeposit(earlier); store.recordDeposit(recent);
  assert.equal(store.depositsFor(A, 2)[0].tx_hash, recent.txHash, 'the newest by time comes first, whatever its block number');
  console.log('ok - markers are kept by name, and activity is listed newest by time');

  // A day's rewards and its settled mark are one write.
  const state = { lastSettledDay: D, publishedRoot: null, publishedTotalWei: null, knobs: null };
  store.commitDay(new Map([[A, 5n * 10n ** 18n]]), state);
  assert.equal(store.rewardFor(A), (5n * 10n ** 18n).toString());
  assert.equal(store.loadSettleState().lastSettledDay, D);
  store.commitDay(null, { ...state, lastSettledDay: D + 1 });
  assert.equal(store.loadSettleState().lastSettledDay, D + 1, 'a day with nothing to pay still moves the mark');
  assert.equal(store.rewardFor(A), (5n * 10n ** 18n).toString());
  assert.throws(() => store.commitDay(new Map([[A, 1n]]), { lastSettledDay: 'x'.repeat(1), publishedRoot: {}, publishedTotalWei: null, knobs: null }));
  assert.equal(store.rewardFor(A), (5n * 10n ** 18n).toString(), 'a write that fails takes the day\'s rewards back with it');
  console.log('ok - a day\'s rewards and its settled mark commit together');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
