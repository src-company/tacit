// A UTC day settles once (lib/points-settle-gate.js). When a scanner stays behind past the gate's maximum wait, the day settles
// without it, and the rows that scanner records for the day afterwards are marked late (points-store.js): the settlement never
// saw them, so they earned nothing. Once every scanner has read past the day's end, each address is credited what the day
// would have paid it with every row counted, less what the settlement paid it.
//
// Add-only: an address the late rows would have diluted keeps what it was paid, so no settled reward goes down. The credits
// are bounded by the day's own pot, since together they are at most what the late rows' share of it would have been. Each
// credit is a ledger adjustment (`late-<day>-<address>-<n>`), listed with the others on /rewards; a day credited once is
// credited again only for the difference, should more of its late rows arrive.
import { splitDayBudget } from './points-day-board.js';

// allRows / onTimeRows: a day's [{ address, dayPoints }] with and without the late rows. Returns Map<address, wei> of what
// each address is still owed for the day, before anything already credited for it.
export function owedForDay({ allRows, onTimeRows, budgetWei, maxWeiPerPoint = null }) {
  const would = splitDayBudget(allRows, budgetWei, maxWeiPerPoint);
  const paid = splitDayBudget(onTimeRows, budgetWei, maxWeiPerPoint);
  const owed = new Map();
  for (const [address, w] of would) {
    const p = paid.get(address) ?? 0n;
    if (w > p) owed.set(String(address).toLowerCase(), w - p);
  }
  return owed;
}

// Credits every settled day that has late rows and that the scanners have now read past. `rowsFor(day, { onTime })`,
// `budgetFor(day)`, `capFor(day)`, `coveredThroughSec` (the earliest point any scanner has read to, null when unknown).
// Returns [{ day, address, wei }] of what it credited.
export function creditLateDays({ store, lastSettledDay, firstDay, coveredThroughSec, rowsFor, budgetFor, capFor, log = () => {} }) {
  const credited = [];
  if (coveredThroughSec == null) return credited;
  for (const { day, n } of store.lateDays()) {
    if (day < firstDay || day > lastSettledDay) continue;
    if (coveredThroughSec < (day + 1) * 86400) continue;                 // its late rows may still be arriving
    const seen = store.getMeta(`late-rows:${day}`);
    if (seen != null && Number(seen) === Number(n)) continue;            // nothing new since it was last credited
    const budgetWei = budgetFor(day);
    if (budgetWei <= 0n) { store.setMeta(`late-rows:${day}`, n); continue; }
    const owed = owedForDay({ allRows: rowsFor(day, { onTime: false }), onTimeRows: rowsFor(day, { onTime: true }), budgetWei, maxWeiPerPoint: capFor(day) });
    let total = 0n;
    const due = [];
    for (const [address, w] of owed) {
      const prefix = `late-${day}-${address}-`;
      const rest = w - store.creditedWithPrefix(prefix);
      if (rest > 0n) { due.push({ address, wei: rest, id: `${prefix}${n}` }); total += rest; }
    }
    // A guard against a broken split, not a policy: a day's credits can never exceed its own pot.
    if (total > budgetWei) { log(`late credit: day ${day} would credit ${total} wei, more than its budget ${budgetWei}; nothing credited`); continue; }
    for (const d of due) {
      if (store.applyAdjustment({ id: d.id, address: d.address, wei: d.wei })) credited.push({ day, address: d.address, wei: d.wei });
    }
    store.setMeta(`late-rows:${day}`, n);
    if (due.length) log(`late credit: day ${day}: ${due.length} address(es) credited ${total} wei for ${n} row(s) recorded after it settled`);
  }
  return credited;
}
