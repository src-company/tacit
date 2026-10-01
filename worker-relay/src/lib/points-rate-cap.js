// A ceiling on the TAC one point can earn in a UTC day. The daily budget is fixed, so a day with little
// activity would otherwise pay far more per point than a busy one; the ceiling keeps that rate bounded. It
// applies to points, not to wallets, so spreading activity across addresses changes nothing.
//
// The schedule only ever applies from a given day forward, so days already settled are never re-priced.
import { parseUnits } from 'viem';

export const POINTS_SCALE = 1_000_000;

// "20729:0.03,20790:off" — from this UTC day index, at most this many TAC per point ("off" lifts the ceiling
// from that day). A malformed entry is skipped and reported, which leaves the day uncapped.
export function parseRateCapSchedule(raw, log = () => {}) {
  const out = [];
  for (const part of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    try {
      const m = part.match(/^(\d+):(.+)$/);
      if (!m) throw new Error('expected <day>:<TAC per point>');
      const rate = m[2].trim().toLowerCase();
      const maxWeiPerPoint = rate === 'off' ? null : parseUnits(rate, 18);
      if (maxWeiPerPoint !== null && maxWeiPerPoint <= 0n) throw new Error('the rate must be positive, or "off"');
      out.push({ fromDay: Number(m[1]), maxWeiPerPoint });
    } catch (err) {
      log(`ignoring POINTS_RATE_CAP_SCHEDULE entry "${part}": ${err.message}`);
    }
  }
  return out.sort((a, b) => a.fromDay - b.fromDay);
}

// The ceiling in force on `day` (wei per point), or null when none applies. Of two entries for the same day
// the later one listed wins.
export function rateCapForDay(schedule, day) {
  let cap = null;
  for (const entry of schedule) if (entry.fromDay <= day) cap = entry.maxWeiPerPoint;
  return cap;
}

// totalScaled is the day's points times POINTS_SCALE, as splitDayBudget sums them.
export function applyRateCeiling(budgetWei, totalScaled, maxWeiPerPoint) {
  if (!maxWeiPerPoint) return budgetWei;
  const ceiling = (maxWeiPerPoint * totalScaled) / BigInt(POINTS_SCALE);
  return ceiling < budgetWei ? ceiling : budgetWei;
}
