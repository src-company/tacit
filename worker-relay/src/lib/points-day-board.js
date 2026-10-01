// A UTC day's pot and how it splits. Settlement folds each finished day into the reward ledger with splitDayBudget; the
// day so far (/points, /leaderboard?day=today) and an address's history by day (/points/:address/days) are read through
// the same functions, so what is shown is what settlement pays.
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

// Splits `budgetWei` pro-rata across `rows` ([{address, dayPoints}], dayPoints a JS float — a WEIGHT, never a
// wei amount). Scaling both sides of the ratio by the same factor before doing BigInt division means the
// float's imprecision only ever affects the last few bits of the ratio, never the wei-scale result, and never
// compounds across days (each day's split is independent). Integer division leaves a few wei of dust
// unallocated per day — negligible at TAC's scale and not worth the complexity of redistributing.
export function splitDayBudget(rows, budgetWei, maxWeiPerPoint = null) {
  const scaled = rows.map((r) => BigInt(Math.round(r.dayPoints * POINTS_SCALE)));
  const totalScaled = scaled.reduce((s, v) => s + v, 0n);
  const deltas = new Map();
  if (totalScaled <= 0n) return deltas;
  const pot = applyRateCeiling(budgetWei, totalScaled, maxWeiPerPoint);
  rows.forEach((r, i) => {
    const share = (pot * scaled[i]) / totalScaled;
    if (share > 0n) deltas.set(r.address, share);
  });
  return deltas;
}

// What each UTC day paid one address, newest first, and the total of the settled days. `dayRowsFor(day)` is that day's
// [{ address, dayPoints }], `budgetFor(day)` its budget and `capFor(day)` its TAC-per-point ceiling. A day through
// `lastSettledDay` is final, so its split is kept; the days after it are read afresh and marked unsettled.
export function dayHistory({ dayRowsFor, budgetFor, capFor }) {
  const final = new Map();
  const split = (day, settled) => {
    if (settled && final.has(day)) return final.get(day);
    const rows = dayRowsFor(day), budget = budgetFor(day);
    const paid = budget > 0n ? splitDayBudget(rows, budget, capFor(day)) : new Map();
    const by = new Map(rows.map((r) => [r.address.toLowerCase(), { points: r.dayPoints, wei: paid.get(r.address) ?? 0n }]));
    if (settled) final.set(day, by);
    return by;
  };
  return (address, { fromDay, throughDay, lastSettledDay }) => {
    const a = address.toLowerCase(), days = [];
    let settledWei = 0n;
    for (let day = fromDay; day <= throughDay; day++) {
      const settled = day <= lastSettledDay, e = split(day, settled).get(a);
      if (!e || !(e.points > 0)) continue;
      if (settled) settledWei += e.wei;
      days.push({ day, points: e.points, tacWei: e.wei.toString(), settled });
    }
    return { days: days.reverse(), settledWei: settledWei.toString() };
  };
}
