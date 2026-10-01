// The ETH held by the pools, one reading per pool per UTC day, set against the ETH the program scored as deposited that
// day. A reading is taken on the first cycles of a day (within its first six hours), so it describes the start of that day and the next day's reading
// closes it: `netChangeWei` is what the pools actually gained over the day. Gross deposits far above the net change mean
// the ETH came back out.
//
// A day with fewer pools read than the others (an unreachable chain that day) is `complete: false` and its total is not
// comparable, so no change is reported across it.
//
// snapshots: [{ day, chainId, pool, ethWei }]; grossByDay: Map(day -> BigInt wei scored as deposited into a pool).
export function tvlSeries(snapshots, grossByDay = new Map()) {
  const universe = new Set(snapshots.map((s) => `${s.chainId}:${s.pool}`));
  const byDay = new Map();
  for (const s of snapshots) {
    const d = byDay.get(s.day) ?? { day: s.day, totalEthWei: 0n, pools: [] };
    d.totalEthWei += BigInt(s.ethWei);
    d.pools.push({ chainId: s.chainId, pool: s.pool, ethWei: String(s.ethWei) });
    byDay.set(s.day, d);
  }
  const days = [...byDay.values()].sort((a, b) => a.day - b.day);
  const complete = (d) => d && d.pools.length === universe.size;
  return days.map((d) => {
    const next = byDay.get(d.day + 1);
    return {
      day: d.day,
      complete: complete(d),
      totalEthWei: d.totalEthWei.toString(),
      pools: d.pools.sort((a, b) => a.chainId - b.chainId || (a.pool < b.pool ? -1 : 1)),
      grossDepositsWei: (grossByDay.get(d.day) ?? 0n).toString(),
      netChangeWei: complete(d) && complete(next) ? (next.totalEthWei - d.totalEthWei).toString() : null,
    };
  });
}
