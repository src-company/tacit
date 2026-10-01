// Which UTC days are safe to settle. A day is folded into the reward ledger once and never revisited, so a row
// scored after its day settled earns nothing. A day is therefore settled only when it is over, a grace margin
// has passed, and every scanner has read past its last second.
//
// `coveredThroughSec` is the earliest point in time any scanner has read up to (null when it cannot be known).
// A scanner that stays behind cannot hold rewards back forever: once `maxWaitSecs` have passed since the day
// ended it settles anyway.

const DAY = 86400;

// The last day index that may settle now, or -Infinity when none may.
export function settleThroughDay({ nowSec, lastProgramDay, coveredThroughSec, graceSecs, maxWaitSecs }) {
  const over = Math.floor((nowSec - graceSecs) / DAY) - 1;
  const forced = Math.floor((nowSec - maxWaitSecs) / DAY) - 1;
  const covered = coveredThroughSec == null ? -Infinity : Math.floor(coveredThroughSec / DAY) - 1;
  return Math.min(over, Math.max(covered, forced), lastProgramDay);
}
