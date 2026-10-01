// A bond that stays posted on a real Bitcoin lock earns for each further day (src/lib/points-bond-hold.js), the checks on
// what a bond reference may be, and what is done with a bond that cannot be read.
//   node worker-relay/tests/points-bond-accrual.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/lib/points-store.js';
import { makeCounted } from '../src/lib/points-counted.js';
import { accrueBondHolds, decideBondHolds, holdTxHash } from '../src/lib/points-bond-hold.js';

const D = 20731, DAY = 86400, ETH = 10n ** 18n;
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40), HELPER = '0x' + '11'.repeat(20);
const out = (n) => '0x' + n.toString(16).padStart(2, '0').repeat(32);
let n = 0;
const bond = (store, depositor, day, outpoint, funder, points = 100) => {
  const tx = '0x' + (++n).toString(16).padStart(64, '0');
  store.recordDeposit({ txHash: tx, blockNumber: 1000 + n, blockTime: day * DAY + 100 + n, depositor, amountWei: String(ETH), priorDepositCount: 0, points, activity: 'cbtcmint' });
  store.saveBondRef({ txHash: tx, outpoint, funder });
  return tx;
};

const dir = mkdtempSync(join(tmpdir(), 'points-accrual-'));
try {
  const store = openStore(join(dir, 'p.db'));
  // References that are not a 32-byte outpoint and an address are not kept.
  assert.equal(store.saveBondRef({ txHash: '0xdead', outpoint: undefined, funder: A }), false);
  assert.equal(store.saveBondRef({ txHash: '0xdead', outpoint: '0x1234', funder: A }), false);
  assert.equal(store.saveBondRef({ txHash: '0xdead', outpoint: out(1), funder: 'undefined' }), false);
  assert.equal(store.bondPairsBefore(DAY * 99999).length, 0);
  console.log('ok - a reference that is not an outpoint and an address is not kept');

  // Posted before D: a real lock held (A, through a helper), a real lock released (B), a made-up outpoint (C), a spent lock (A again), and one posted on D itself.
  const t1 = bond(store, A, D - 3, out(1), HELPER);
  const t2 = bond(store, B, D - 2, out(2), B);
  const t3 = bond(store, C, D - 2, out(3), C);
  const t4 = bond(store, A, D - 1, out(4), HELPER);
  const t5 = bond(store, B, D, out(5), B);
  const escrow = { [out(1)]: 2n * ETH, [out(2)]: 0n, [out(3)]: 5n * ETH, [out(4)]: ETH, [out(5)]: ETH };
  const lock = { [out(1)]: { vBtc: 400000n }, [out(2)]: { vBtc: 100000n }, [out(3)]: { vBtc: 0n }, [out(4)]: { vBtc: 50000n, spent: true }, [out(5)]: { vBtc: 1n } };
  const reads = { escrow: 0, lock: 0 };
  const io = { readEscrow: async (o) => { reads.escrow++; return escrow[o]; }, readLock: async (o) => { reads.lock++; return { spent: false, redeemed: false, ...lock[o] }; } };

  const r = await accrueBondHolds({ store, day: D, perWstEthDay: 500, ...io });
  assert.deepEqual(r, { pairs: 4, credited: 1 }, 'four bonds were posted before the day; only the held one on a live lock earns');
  const rows = store.dayActivityPoints(D * DAY, (D + 1) * DAY);
  assert.deepEqual(rows.filter((x) => x.activity === 'cbtchold').map((x) => [x.address, x.points]), [[A, 1000]], '2 wstETH held at 500 a wstETH-day, to the depositor and not the helper');
  const holds = rows.filter((x) => x.activity === 'cbtchold');
  assert.equal(holds.some((x) => x.address === C), false, 'a made-up outpoint earns nothing');
  assert.equal(holds.some((x) => x.address === B), false, 'a released bond and a bond posted on the day itself earn no hold credit');
  console.log('ok - a bond held on a real, unspent lock earns per wstETH held; released, made-up, spent and same-day bonds do not');

  // Once, however often the day is run, and whatever the chain says the second time.
  escrow[out(1)] = 9n * ETH;
  assert.deepEqual(await accrueBondHolds({ store, day: D, perWstEthDay: 500, ...io }), { pairs: 4, credited: 0 });
  assert.equal(store.dayActivityPoints(D * DAY, (D + 1) * DAY).find((x) => x.activity === 'cbtchold').points, 1000, 'the first answer for the day stands');
  const next = await accrueBondHolds({ store, day: D + 1, perWstEthDay: 500, ...io });
  assert.equal(next.credited, 2, 'the next day, the bond posted on D is posted before it and its escrow is read: A\'s and B\'s both earn');
  console.log('ok - a day is credited once, and the next day reads the chain again');

  // A bond released at its own day is not the poster of its outpoint any more.
  const rel = bond(store, B, D + 5, out(6), B);
  store.saveBondCheck(rel, false, 1);
  assert.equal(store.bondPairsBefore((D + 10) * DAY).some((p) => p.outpoint === out(6)), false);
  console.log('ok - a bond found released on its own day is left out of the bonds that may still be posted');

  // The credit is a row of the day, so the week multiplier sees the holder as active and the leaderboard carries its points.
  const counted = makeCounted({ store, engagementSchedule: [{ fromDay: D, spec: { kindStep: 0.25, returnStep: 0.25, maxKinds: 2, minPoints: 25 } }] });
  const a = counted.rows(D).find((x) => x.address === A);
  assert.equal(a.rawPoints, 1000);
  assert.equal(a.factor, 1.25, 'a holder that was active earlier in the week and is credited today is returning');
  assert.match(holdTxHash(out(1), HELPER, A, D), /^0x[0-9a-f]{64}$/, 'the id is shaped like a transaction hash');
  assert.notEqual(holdTxHash(out(1), HELPER, A, D), holdTxHash(out(1), HELPER, A, D + 1));
  assert.notEqual(holdTxHash(out(1), HELPER, A, D), holdTxHash(out(1), HELPER, B, D));
  assert.equal(store.leaderboard(10).find((x) => x.address === A).points >= 1000, true);
  console.log('ok - a held bond counts as activity for the week and in the totals');

  // Through a helper: the engine holds every depositor's share under the helper's address, so each depositor's own share is what counts.
  const X = '0x' + 'd'.repeat(40), Y = '0x' + 'e'.repeat(40);
  const shared = out(8), helperShare = { [X]: 10n * ETH, [Y]: 0n };
  const hx = bond(store, X, D + 8, shared, HELPER), hy = bond(store, Y, D + 9, shared, HELPER);
  lock[shared] = { vBtc: 400000n }; escrow[shared] = 10n * ETH;      // the engine's pooled share under the helper is not nil whoever reclaimed
  const perDepositor = { readEscrow: async (o, f, who) => (o === shared ? helperShare[who] : escrow[o]), readLock: io.readLock };
  const helped = await accrueBondHolds({ store, day: D + 10, perWstEthDay: 500, ...perDepositor });
  const hrows = store.dayActivityPoints((D + 10) * DAY, (D + 11) * DAY).filter((x) => x.activity === 'cbtchold' && (x.address === X || x.address === Y));
  assert.deepEqual(hrows.map((x) => [x.address, x.points]), [[X, 5000]], 'the depositor who holds is credited, and not whoever posted last');
  const seenWho = [];
  const hdec = await decideBondHolds({ store, day: D + 9, readEscrow: async (o, f, who) => { seenWho.push(who); return helperShare[who]; } });
  assert.deepEqual(seenWho, [Y], 'the check reads the depositor\'s own share');
  assert.equal(hdec.released, 1, 'a depositor who reclaimed is released though another depositor still has a share on the outpoint');
  void hx; void hy; void helped;
  console.log('ok - through a helper each depositor\'s own share decides, so another depositor\'s share can neither keep a reclaimed bond counted nor take its credit');

  // A lock earns only on the escrow it needs.
  const big = bond(store, A, D + 11, out(9), A);
  const capped = await accrueBondHolds({ store, day: D + 12, perWstEthDay: 500, readEscrow: async (o) => (o === out(9) ? 1000n * ETH : 0n), readLock: async () => ({ vBtc: 1n, spent: false, redeemed: false, required: ETH / 10n }) });
  assert.equal(capped.credited, 1);
  assert.equal(store.dayActivityPoints((D + 12) * DAY, (D + 13) * DAY).find((x) => x.activity === 'cbtchold').points, 50, '1,000 wstETH on a lock that needs 0.1 earns on 0.1');
  void big;
  console.log('ok - escrow beyond what the lock needs earns nothing');

  // A bond that cannot be read: the day waits, until it is well past its end; then it stops holding rewards back.
  const flaky = bond(store, C, D + 6, out(7), C);
  const boom = async () => { throw new Error('rpc down'); };
  const day = D + 7;
  const early = () => (day + 1) * DAY + 100, late = () => (day + 1) * DAY + 7 * 3600;
  await assert.rejects(accrueBondHolds({ store, day, perWstEthDay: 500, readEscrow: boom, readLock: boom, failAfterSecs: 6 * 3600, nowSec: early }), /rpc down/);
  const skipped = await accrueBondHolds({ store, day, perWstEthDay: 500, readEscrow: boom, readLock: boom, failAfterSecs: 6 * 3600, nowSec: late });
  assert.equal(skipped.credited, 0, 'past the grace an unreadable bond earns nothing and the day goes on');
  const d6 = D + 6;
  const pend = store.bondsToCheck(d6 * DAY, (d6 + 1) * DAY).map((b) => b.txHash);
  assert.deepEqual(pend, [flaky]);
  await assert.rejects(decideBondHolds({ store, day: d6, readEscrow: boom, failAfterSecs: 6 * 3600, nowSec: () => (d6 + 1) * DAY + 100 }), /rpc down/);
  const dec = await decideBondHolds({ store, day: d6, readEscrow: boom, failAfterSecs: 6 * 3600, nowSec: () => (d6 + 1) * DAY + 7 * 3600 });
  assert.deepEqual(dec, { checked: 1, released: 0 }, 'past the grace an unreadable bond is counted as held');
  assert.equal(store.bondsToCheck(d6 * DAY, (d6 + 1) * DAY).length, 0, 'and the answer is kept');
  console.log('ok - an unreadable bond waits, then stops holding rewards back: counted as held, earning nothing further');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
