// A cBTC bond is public, and posting it can be undone before any cBTC is minted, so a bond that is posted and taken
// back within the day would score for gas alone. Two rules read the escrow after the day is over:
//
//  - decideBondHolds: a bond counts for its own day's pot only if its funder still has the escrow posted when that day
//    settles. The answer for each bond is read once, kept, and never changes, so a settled day always splits the same way.
//  - accrueBondHolds: each further day a bond stays posted on a real Bitcoin lock (one the pool knows, not spent, not
//    redeemed) earns points per wstETH held, recorded once as that day's activity.
//
// readEscrow(outpoint, funder) -> bigint: the wstETH the funder has posted on that outpoint now.
// readLock(outpoint) -> { vBtc: bigint, spent: boolean, redeemed: boolean }: what the pool holds for that lock.
//
// An unreadable escrow throws, which leaves the day unsettled until it can be read, so no answer is guessed. Once the
// day is `failAfterSecs` past its end a bond that still cannot be read stops holding rewards back: it is counted as held,
// and earns nothing further.
import { keccak256, toBytes } from 'viem';

const pastGrace = (day, failAfterSecs, nowSec) => failAfterSecs != null && nowSec() - (day + 1) * 86400 > failAfterSecs;
const wallClock = () => Math.floor(Date.now() / 1000);

export async function decideBondHolds({ store, day, readEscrow, failAfterSecs = null, nowSec = wallClock, log = () => {} }) {
  const pending = store.bondsToCheck(day * 86400, (day + 1) * 86400);
  let released = 0;
  for (const b of pending) {
    let held;
    try {
      held = (await readEscrow(b.outpoint, b.funder)) > 0n;
    } catch (err) {
      if (!pastGrace(day, failAfterSecs, nowSec)) throw err;
      log(`bond ${b.txHash}: escrow unreadable past the grace, counted as held (${err?.message || err})`);
      held = true;
    }
    if (!held) released += 1;
    store.saveBondCheck(b.txHash, held, nowSec());
  }
  return { checked: pending.length, released };
}

// The id of the credit for one bond on one day: shaped like a transaction hash so whatever lists activity can hold it.
export const holdTxHash = (outpoint, funder, day) => keccak256(toBytes(`bond-hold:${outpoint}:${funder}:${day}`));

export async function accrueBondHolds({ store, day, readEscrow, readLock, perWstEthDay, failAfterSecs = null, nowSec = wallClock, log = () => {} }) {
  const pairs = store.bondPairsBefore(day * 86400);
  let credited = 0;
  for (const p of pairs) {
    try {
      const held = await readEscrow(p.outpoint, p.funder);
      if (held <= 0n) continue;
      const lock = await readLock(p.outpoint);
      if (!(lock.vBtc > 0n) || lock.spent || lock.redeemed) continue;
      const wrote = store.recordDeposit({
        txHash: holdTxHash(p.outpoint, p.funder, day), blockNumber: p.blockNumber, blockTime: day * 86400 + 86399,
        depositor: p.depositor, amountWei: '0', priorDepositCount: 0, points: (Number(held) / 1e18) * perWstEthDay, activity: 'cbtchold',
      });
      if (wrote) credited += 1;
    } catch (err) {
      if (!pastGrace(day, failAfterSecs, nowSec)) throw err;
      log(`bond ${p.outpoint}: unreadable past the grace, no credit for day ${day} (${err?.message || err})`);
    }
  }
  return { pairs: pairs.length, credited };
}
