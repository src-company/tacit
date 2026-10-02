// A cBTC bond is public, and posting it can be undone before any cBTC is minted, so a bond that is posted and taken
// back within the day would score for gas alone. Two rules read the chain after the day is over:
//
//  - decideBondHolds: a bond counts for its own day's pot only if the depositor still has at least what it posted on that
//    outpoint when its day settles, so taking it back and posting a sliver again does not keep it, and (where readLock is
//    given) only if cBTC has been minted against the lock and the lock is neither redeemed nor spent: the engine will not
//    release escrow behind outstanding cBTC, so such a bond cannot be taken back and posted again. The answer for each bond
//    is read once, kept, and never changes, so a settled day always splits the same way.
//  - accrueBondHolds: each further day a bond stays posted on a real Bitcoin lock (one the pool knows, not spent, not
//    redeemed) earns points per wstETH held, recorded once as that day's activity. A lock earns on the escrow it needs and no
//    more, shared among the bonds posted on it in proportion to what each holds.
//
// readEscrow(outpoint, funder, depositor) -> bigint: the wstETH the depositor has posted on that outpoint now. A funder that
// is a helper holds many depositors' shares under its one address, so the depositor's own share is what is read.
// readLock(outpoint) -> { vBtc: bigint, spent: boolean, redeemed: boolean, minted?: boolean, required?: bigint }: what the pool
// holds for that lock, whether cBTC is minted against it, and the escrow it needs. A bond earns the daily credit only on what
// the lock needs, so a lock cannot earn on escrow beyond its size.
//
// An unreadable escrow throws, which leaves the day unsettled until it can be read, so no answer is guessed. Once the
// day is `failAfterSecs` past its end a bond that still cannot be read stops holding rewards back: it is counted as held,
// and earns nothing further.
import { keccak256, toBytes } from 'viem';

const pastGrace = (day, failAfterSecs, nowSec) => failAfterSecs != null && nowSec() - (day + 1) * 86400 > failAfterSecs;
const wallClock = () => Math.floor(Date.now() / 1000);

export async function decideBondHolds({ store, day, readEscrow, readLock = null, failAfterSecs = null, nowSec = wallClock, log = () => {} }) {
  const pending = store.bondsToCheck(day * 86400, (day + 1) * 86400);
  let released = 0;
  for (const b of pending) {
    let held;
    try {
      held = (await readEscrow(b.outpoint, b.funder, b.depositor)) >= BigInt(b.amountWei);
      if (held && readLock) {
        const lock = await readLock(b.outpoint);
        held = !!lock.minted && !lock.redeemed && !lock.spent;
      }
    } catch (err) {
      if (!pastGrace(day, failAfterSecs, nowSec)) throw err;
      log(`bond ${b.txHash}: unreadable past the grace, counted as held (${err?.message || err})`);
      held = true;
    }
    if (!held) released += 1;
    store.saveBondCheck(b.txHash, held, nowSec());
  }
  return { checked: pending.length, released };
}

// The id of the credit for one bond on one day: shaped like a transaction hash so whatever lists activity can hold it.
export const holdTxHash = (outpoint, funder, depositor, day) => keccak256(toBytes(`bond-hold:${outpoint}:${funder}:${depositor}:${day}`));

export async function accrueBondHolds({ store, day, readEscrow, readLock, perWstEthDay, failAfterSecs = null, nowSec = wallClock, log = () => {} }) {
  const byOutpoint = new Map();
  for (const p of store.bondPairsBefore(day * 86400)) byOutpoint.set(p.outpoint, [...(byOutpoint.get(p.outpoint) ?? []), p]);
  let credited = 0, pairs = 0;
  for (const [outpoint, bonds] of byOutpoint) {
    pairs += bonds.length;
    try {
      const lock = await readLock(outpoint);
      if (!(lock.vBtc > 0n) || lock.spent || lock.redeemed) continue;
      const posted = [];
      for (const p of bonds) posted.push(await readEscrow(p.outpoint, p.funder, p.depositor));
      const total = posted.reduce((s, v) => s + (v > 0n ? v : 0n), 0n);
      if (total <= 0n) continue;
      const cap = lock.required != null && total > lock.required ? lock.required : total;
      for (let i = 0; i < bonds.length; i++) {
        if (posted[i] <= 0n) continue;
        const held = (posted[i] * cap) / total;
        if (held <= 0n) continue;
        const p = bonds[i];
        const wrote = store.recordDeposit({
          txHash: holdTxHash(p.outpoint, p.funder, p.depositor, day), blockNumber: p.blockNumber, blockTime: day * 86400 + 86399,
          depositor: p.depositor, amountWei: '0', priorDepositCount: 0, points: (Number(held) / 1e18) * perWstEthDay, activity: 'cbtchold',
        });
        if (wrote) credited += 1;
      }
    } catch (err) {
      if (!pastGrace(day, failAfterSecs, nowSec)) throw err;
      log(`bond ${outpoint}: unreadable past the grace, no credit for day ${day} (${err?.message || err})`);
    }
  }
  return { pairs, credited };
}
