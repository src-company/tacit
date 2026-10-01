// A cBTC bond is public, and posting it can be undone before any cBTC is minted, so a bond that is posted and taken
// back within the day would score for gas alone. A bond counts for its day's pot only if its funder still has the
// escrow posted when that day settles. The answer for each bond is read once, kept, and never changes, so a settled
// day always splits the same way.
//
// readEscrow(outpoint, funder) -> bigint: the wstETH the funder has posted on that outpoint now.
// An unreadable escrow throws, which leaves the day unsettled until it can be read.
export async function decideBondHolds({ store, day, readEscrow, nowSec = () => Math.floor(Date.now() / 1000) }) {
  const pending = store.bondsToCheck(day * 86400, (day + 1) * 86400);
  let released = 0;
  for (const b of pending) {
    const held = (await readEscrow(b.outpoint, b.funder)) > 0n;
    if (!held) released += 1;
    store.saveBondCheck(b.txHash, held, nowSec());
  }
  return { checked: pending.length, released };
}
