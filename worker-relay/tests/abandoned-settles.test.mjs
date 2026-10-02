// Settles acked failed whose broadcast lands later (src/lib/abandoned-settles.js): the record is corrected, and a relayed
// exit that carried its recipe is activated for the user, as one that settled in time would have been.
//   node worker-relay/tests/abandoned-settles.test.mjs

import assert from 'node:assert/strict';
import { makeAbandonedSettles } from '../src/lib/abandoned-settles.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };

const H = (c) => '0x' + c.repeat(64);
const EXIT = { exitedAsset: '0x' + '3c'.repeat(32), deadline: '9999999999' };
function rig({ receipts = {}, ackOk = true, max, ttlMs } = {}) {
  const t = { now: 1_000_000, acks: [], activations: [], logs: [] };
  const abandoned = makeAbandonedSettles({
    getReceipt: async (h) => { if (!(h in receipts) || receipts[h] === 'down') throw new Error('not found'); return receipts[h]; },
    ack: async (a) => { t.acks.push(a); return ackOk ? { ok: true, status: 200 } : { ok: false, status: 409 }; },
    activate: async (job, tx) => { t.activations.push([job.jobId, tx]); },
    log: (m) => t.logs.push(m), now: () => t.now, max, ttlMs,
  });
  return { ...t, t, abandoned };
}

await test('a relayed exit whose "failed" settle lands is corrected to settled and then activated from the settle that landed', async () => {
  const r = rig({ receipts: { [H('a')]: { status: 'success' } } });
  const job = { jobId: 'j1', type: 'unwrap', exit: EXIT, op: { fee: '1' } };
  r.abandoned.remember(job, [H('a')]);
  await r.abandoned.sweep();
  assert.deepEqual(r.t.acks, [{ jobId: 'j1', txHash: H('a') }]);
  assert.deepEqual(r.t.activations, [['j1', H('a')]]);
  assert.equal(r.abandoned.size(), 0);
  await r.abandoned.sweep();
  assert.equal(r.t.activations.length, 1, 'once');
});

await test('a settle without an exit recipe is corrected and nothing is activated', async () => {
  const r = rig({ receipts: { [H('a')]: { status: 'success' } } });
  r.abandoned.remember({ jobId: 'j2', type: 'transfer' }, [H('a')]);
  await r.abandoned.sweep();
  assert.equal(r.t.acks.length, 1);
  assert.deepEqual(r.t.activations, []);
});

await test('the correction being refused is reported loudly, and the funded exit is still activated', async () => {
  const r = rig({ receipts: { [H('a')]: { status: 'success' } }, ackOk: false });
  r.abandoned.remember({ jobId: 'j3', type: 'unwrap', exit: EXIT }, [H('a')]);
  await r.abandoned.sweep();
  assert.ok(r.t.logs.some((l) => /^CRITICAL: job j3 settled as .* correction was refused \(status 409\)/.test(l)));
  assert.deepEqual(r.t.activations, [['j3', H('a')]]);
});

await test('a reverted broadcast leaves the failure standing and activates nothing', async () => {
  const r = rig({ receipts: { [H('a')]: { status: 'reverted' } } });
  r.abandoned.remember({ jobId: 'j4', type: 'unwrap', exit: EXIT }, [H('a')]);
  await r.abandoned.sweep();
  assert.deepEqual(r.t.acks, []);
  assert.deepEqual(r.t.activations, []);
  assert.equal(r.abandoned.size(), 0);
});

await test('a broadcast with no receipt yet is kept and looked at again, and any one of several landing counts', async () => {
  const receipts = { [H('a')]: 'down' };
  const r = rig({ receipts });
  r.abandoned.remember({ jobId: 'j5', type: 'unwrap', exit: EXIT }, [H('a'), H('b')]);
  await r.abandoned.sweep();
  assert.equal(r.abandoned.size(), 1);
  assert.deepEqual(r.t.acks, []);
  receipts[H('b')] = { status: 'success' };
  await r.abandoned.sweep();
  assert.deepEqual(r.t.acks, [{ jobId: 'j5', txHash: H('b') }]);
  assert.deepEqual(r.t.activations, [['j5', H('b')]]);
});

await test('a settle that never lands is forgotten after the window, and a job with no hashes is not kept', async () => {
  const r = rig({ ttlMs: 1000 });
  r.abandoned.remember({ jobId: 'j6', type: 'unwrap', exit: EXIT }, [H('a')]);
  r.abandoned.remember({ jobId: 'j7', type: 'unwrap', exit: EXIT }, []);
  r.abandoned.remember({ jobId: 'j8', type: 'unwrap', exit: EXIT }, undefined);
  assert.equal(r.abandoned.size(), 1);
  r.t.now += 1001;
  await r.abandoned.sweep();
  assert.equal(r.abandoned.size(), 0);
  assert.deepEqual(r.t.acks, []);
});

await test('the oldest entries go first when more are kept than the cap', async () => {
  const r = rig({ max: 2, receipts: { [H('a')]: { status: 'success' }, [H('b')]: { status: 'success' }, [H('c')]: { status: 'success' } } });
  for (const [id, h] of [['j1', 'a'], ['j2', 'b'], ['j3', 'c']]) r.abandoned.remember({ jobId: id, type: 'transfer' }, [H(h)]);
  assert.equal(r.abandoned.size(), 2);
  await r.abandoned.sweep();
  assert.deepEqual(r.t.acks.map((a) => a.jobId).sort(), ['j2', 'j3']);
});

console.log(`\n${n} checks passed`);
