// The rows a UTC day's pot is split by. Settlement, the day so far, the board and an address's history by day all
// read a day through here, so what is shown is what settlement pays.
//
// Before any weight, multiplier or bond check applies to a day, its rows are exactly the store's sums by address, so
// days already settled re-split to the same figures. From the first of those days on, a day counts each activity at
// its weight, times the address's multiplier for the week (lib/points-engagement.js), with a released bond left out.
import { categoryWeightsForDay, engagementForDay, countedRows, WEEK_DAYS } from './points-engagement.js';

// onTime: only the rows a settlement could have seen (not marked late), so a settled day's own split is reproduced.
export function makeCounted({ store, weightSchedule = [], engagementSchedule = [], bondHoldFromDay = 0, onTime = false }) {
  const opt = { onTime };
  return {
    rows(day) {
      const weights = categoryWeightsForDay(weightSchedule, day), spec = engagementForDay(engagementSchedule, day);
      const start = day * 86400, end = start + 86400;
      if (!Object.keys(weights).length && !spec && !(bondHoldFromDay && day >= bondHoldFromDay)) {
        return store.dayPointsByAddress(start, end, opt).map((r) => ({ ...r, rawPoints: r.dayPoints, factor: 1, kinds: 0, activeDays: 0 }));
      }
      const dayRows = store.dayActivityPoints(start, end, opt);
      const weekRows = spec ? store.weekActivityPoints((day - WEEK_DAYS + 1) * 86400, end, opt) : [];
      return countedRows({ dayRows, weekRows, weights, spec });
    },
  };
}
