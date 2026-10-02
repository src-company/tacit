// Settles that were acked failed although a broadcast of theirs may still be included. A private endpoint keeps
// re-submitting an accepted bundle well past the window the rounds wait, so "we stopped waiting" and "it did not land"
// stay different facts after the ack too. The hashes were already named in the error so a user could check them by
// hand; these get checked for them. In memory only: a restart forgets, and the durable version of this belongs on the
// worker, which owns the job record. settle-relay.js supplies the chain and worker I/O; the registry is pure so it is
// unit-tested (worker-relay/tests/abandoned-settles.test.mjs).
//
// A relayed exit that settles late is finished as one that settled in time: its escrow is funded, so the exit is
// activated for the user rather than left for them to activate from a wallet that would link to it.

export const ABANDON_TTL_MS = 2 * 3600_000;
export const ABANDON_MAX = 256;

// getReceipt(hash) → the receipt or throws; ack({ jobId, txHash }) → { ok, status }; activate(job, settleTx) activates a
// settled exit that carried its recipe (it reports its own refusals).
export function makeAbandonedSettles({ getReceipt, ack, activate, log = () => {}, now = Date.now, ttlMs = ABANDON_TTL_MS, max = ABANDON_MAX }) {
  const abandoned = [];

  // Only a job with an exit recipe is kept whole, for its activation; the rest need only the id.
  function remember(job, hashes) {
    if (!Array.isArray(hashes) || !hashes.length) return;
    abandoned.push({ jobId: job.jobId, job: job.exit ? job : null, hashes: hashes.slice(), at: now() });
    while (abandoned.length > max) abandoned.shift();
  }

  async function sweep() {
    for (let i = abandoned.length - 1; i >= 0; i--) {
      const a = abandoned[i];
      if (now() - a.at > ttlMs) { abandoned.splice(i, 1); continue; }
      for (const h of a.hashes) {
        const r = await getReceipt(h).catch(() => null);
        if (!r) continue;
        abandoned.splice(i, 1);
        if (r.status !== 'success') { log(`job ${a.jobId}: abandoned settle ${h} reverted — failed stands`); break; }
        log(`job ${a.jobId}: abandoned settle LANDED as ${h} after it was acked failed — correcting the record`);
        const res = await ack({ jobId: a.jobId, txHash: h });
        if (!res?.ok) log(`CRITICAL: job ${a.jobId} settled as ${h} but the correction was refused (status ${res?.status}) — the worker still reports it failed`);
        if (a.job) await activate(a.job, h);
        break;
      }
    }
  }

  return { remember, sweep, size: () => abandoned.length };
}
