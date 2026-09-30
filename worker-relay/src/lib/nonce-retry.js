// Retry a write that lost a nonce race with another service signing from the same key.
//
// The settle service signs with its own SETTLE_KEY; header-relay and reflection-folder share RELAY_KEY with
// each other, and replenish signs with whichever wallet the role it runs for uses — inside the settle
// service, that is the settle wallet. Settles go out through a private endpoint, which means a public RPC's
// `getTransactionCount(pending)` does not see one in flight — so two writers picking the same nonce is not
// an edge case, it is the expected behaviour wherever a key is shared.
//
// A lost race fails BEFORE broadcast (nonce too low / underpriced / already known), so retrying is safe and
// cheap; anything else is a real error and is rethrown untouched. What makes this worth doing rather than
// leaving to the next cycle: the reflection attest has already PAID Succinct for a Groth16 proof by the time
// it submits, and a bare write that throws on a nonce collision discards it and re-proves from scratch.
const NONCE_RACE = /nonce ?too ?low|lower than the current nonce|nonce has already been used|replacement transaction underpriced|already known/i;

export function isNonceRace(e) {
  return NONCE_RACE.test(String(e?.shortMessage || e?.message || e));
}

export async function withNonceRetry(label, fn, { tries = 3, log = console.log, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= tries || !isNonceRace(e)) throw e;
      log(`  ${label}: nonce race with another service on this key (attempt ${i}/${tries}) — retrying`);
      await wait(3000 * i);
    }
  }
}
