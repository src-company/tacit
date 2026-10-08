// The last block at or before a timestamp, found by binary search over block timestamps (monotonic), as a scan needs it to
// judge an L2 activity at the mainnet block of its own time. Every timestamp read is kept, and a search starts from the
// nearest blocks already read on either side of its target: an L2 catch-up meets deposits seconds apart by the hundred, and
// each then costs a probe or two instead of a full search of the chain. Only real reads narrow the search, so the answer is
// the same exact block a fresh search finds (a replay reproduces it).
//   readTs(blockNumber: bigint) → timestamp (bigint)
export function makeBlockAtOrBefore(readTs, { keep = 20000 } = {}) {
  const seen = new Map();                                              // block → timestamp
  const ts = async (n) => {
    let t = seen.get(n);
    if (t === undefined) {
      t = BigInt(await readTs(n));
      if (seen.size >= keep) seen.clear();
      seen.set(n, t);
    }
    return t;
  };
  return async function blockAtOrBefore(targetTime, tip) {
    let lo = 0n, hi = BigInt(tip);
    if (hi <= lo) return hi;
    const target = BigInt(targetTime);
    if (await ts(hi) <= target) return hi;
    // The answer lies in [lo, hi]: at or after any block read at or before the target, before any block read after it.
    for (const [n, t] of seen) {
      if (n > BigInt(tip)) continue;
      if (t <= target) { if (n > lo) lo = n; } else if (n - 1n < hi) hi = n - 1n;
    }
    while (lo < hi) {
      const mid = lo + (hi - lo + 1n) / 2n;
      if (await ts(mid) <= target) lo = mid; else hi = mid - 1n;
    }
    return lo;
  };
}
