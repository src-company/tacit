// Whether the PointsDistributor holds enough TAC for the days still to publish. The service publishes a root only while
// what the distributor holds plus what has been claimed covers every TAC allocated, so the headroom over the ledger is
// what each coming day draws on. Pure and BigInt throughout, shared by GET /rewards and the balance monitor.

const DAY = 86400;

// heldWei: TAC the distributor holds. claimedWei: its totalClaimed(). ledgerWei: every TAC the ledger allocates.
// budgetFor(day): that UTC day's budget in wei (an upper bound; a quiet day pays less). nextDay: the first unsettled
// UTC day. graceSecs: how long after midnight a day settles (POINTS_SETTLE_GRACE_SECS).
export function fundingStatus({ heldWei, claimedWei, ledgerWei, budgetFor, nextDay, graceSecs }) {
  const fundedWei = heldWei + claimedWei;
  const headroomWei = fundedWei - ledgerWei;
  if (headroomWei < 0n) {
    return { fundedWei, ledgerWei, headroomWei, shortfallWei: -headroomWei, daysCovered: 0, topUpBeforeSec: null };
  }
  // Each coming day takes its full budget, so count the days the headroom covers whole.
  let left = headroomWei;
  let daysCovered = 0;
  while (daysCovered < 400) {
    const budget = budgetFor(nextDay + daysCovered);
    if (budget <= 0n || left < budget) break;
    left -= budget;
    daysCovered += 1;
  }
  // The first day the funding no longer covers settles after its own midnight plus the grace margin.
  const firstUncovered = nextDay + daysCovered;
  return { fundedWei, ledgerWei, headroomWei, shortfallWei: 0n, daysCovered, topUpBeforeSec: (firstUncovered + 1) * DAY + graceSecs };
}

// 'ok', 'warning' when fewer than `warnDays` whole days are covered, 'critical' when the ledger is already past the
// funding (the next publish is held back and claims for new days are blocked).
export function fundingVerdict(status, { warnDays = 3 } = {}) {
  if (status.shortfallWei > 0n) return 'critical';
  return status.daysCovered < warnDays ? 'warning' : 'ok';
}
