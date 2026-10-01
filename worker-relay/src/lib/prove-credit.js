// The prover network credit, which proving spends: when it reaches zero every network proof fails (settles, reflection,
// eth-state). The relay's replenish run reads it and reports it with its heartbeat; the monitor reads it back (the API
// returns it to the relay's own token only) and says when it is low, early enough to top it up.

// PROVE wei -> whole PROVE as the text the heartbeat carries ("78.24"), or null when it is unknown.
export const creditText = (wei) => (wei == null ? null : (Number(wei) / 1e18).toFixed(2));

// A heartbeat's credit field, as the API keeps it: digits with up to four decimals, else not kept.
export const creditField = (v) => (typeof v === 'string' && /^\d{1,12}(\.\d{1,4})?$/.test(v) ? v : null);

// How low it is against the replenish floor: 'critical' under `critical` of the floor (default 60%), 'warning' under the floor.
export function creditLevel(whole, floorWhole, critical = 0.6) {
  const w = Number(whole), f = Number(floorWhole);
  if (!Number.isFinite(w) || !Number.isFinite(f) || f <= 0) return null;
  return w < f * critical ? 'critical' : w < f ? 'warning' : null;
}
