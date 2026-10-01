// The UTC day so far: the pot as it would split now, and each address's share of it. /points reports one address's
// figures from this and /leaderboard?day=today lists every address's, so the two always agree.
import { POINTS_SCALE, applyRateCeiling } from './points-rate-cap.js';

// dayRows: [{ address, dayPoints }]. The pot is the day's budget, or less where the TAC-per-point ceiling binds.
export function dayPot(dayRows, budgetWei, maxWeiPerPoint = null) {
  const totalPoints = dayRows.reduce((s, r) => s + r.dayPoints, 0);
  return { totalPoints, pot: applyRateCeiling(budgetWei, BigInt(Math.round(totalPoints * POINTS_SCALE)), maxWeiPerPoint) };
}

export function dayBoard(dayRows, { budgetWei, maxWeiPerPoint = null, limit = 100 }) {
  const { totalPoints, pot } = dayPot(dayRows, budgetWei, maxWeiPerPoint);
  const ranked = dayRows.filter((r) => r.dayPoints > 0).sort((a, b) => b.dayPoints - a.dayPoints || (a.address < b.address ? -1 : 1));
  return {
    totalPoints,
    dayBudgetWei: pot.toString(),
    taking: ranked.length,
    rows: ranked.slice(0, limit).map((r) => ({ address: r.address.toLowerCase(), points: r.dayPoints })),
  };
}
