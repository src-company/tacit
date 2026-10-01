// One-off, add-only credits to the reward ledger, named in POINTS_LEDGER_ADJUSTMENTS as a JSON array of
// { id, address, wei }. Each id is applied once and only ever adds: a root's per-account amount can never go down,
// so a credit is never undone and a changed entry under an id already applied is ignored (a correction is a new id).
//
// Anything malformed is skipped and reported, which credits nothing.

// A guard against a slipped digit, not a policy: no single entry may exceed 5,000 TAC.
export const MAX_ADJUSTMENT_WEI = 5_000n * 10n ** 18n;

export function parseAdjustments(raw, log = () => {}) {
  if (!raw) return [];
  let list;
  try { list = JSON.parse(raw); } catch (err) { log(`ignoring POINTS_LEDGER_ADJUSTMENTS: not JSON (${err.message})`); return []; }
  if (!Array.isArray(list)) { log('ignoring POINTS_LEDGER_ADJUSTMENTS: expected an array'); return []; }
  const seen = new Set();
  const out = [];
  list.forEach((e, i) => {
    try {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(e?.id ?? ''))) throw new Error('id must be 1-64 letters, digits, . _ -');
      if (seen.has(e.id)) throw new Error('duplicate id');
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(e.address ?? ''))) throw new Error('address must be 0x and 40 hex digits');
      if (!/^[1-9][0-9]{0,40}$/.test(String(e.wei ?? ''))) throw new Error('wei must be a positive whole number');
      const wei = BigInt(e.wei);
      if (wei > MAX_ADJUSTMENT_WEI) throw new Error('over the per-entry limit');
      seen.add(e.id);
      out.push({ id: e.id, address: e.address.toLowerCase(), wei });
    } catch (err) {
      log(`ignoring POINTS_LEDGER_ADJUSTMENTS entry ${i}: ${err.message}`);
    }
  });
  return out;
}
