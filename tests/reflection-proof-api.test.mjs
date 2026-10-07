// worker /reflection/proof: the cron publishes the proof it has bought (box token), anyone can read it, malformed
// publishes are refused, and a newer publish replaces an older one.
import { test } from 'node:test';
import assert from 'node:assert';

const worker = await import('../worker/src/index.js');
const TOKEN = 'box-token-for-tests-0123456789';
const D = (n) => '0x' + n.toString(16).padStart(2, '0').repeat(32);

function makeKv() {
  const data = new Map();
  return {
    _data: data, _ttl: new Map(),
    async get(key) { const v = data.get(key); return v === undefined ? null : v; },
    async put(key, value, opts) { data.set(key, typeof value === 'string' ? value : JSON.stringify(value)); if (opts && opts.expirationTtl) this._ttl.set(key, opts.expirationTtl); },
    async delete(key) { data.delete(key); },
    async list({ prefix }) { return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true }; },
  };
}
const env = () => ({ REGISTRY_KV: makeKv(), CONFIDENTIAL_BOX_TOKEN: TOKEN, ALLOWED_ORIGINS: '*' });
const call = (e, path, { method = 'GET', body, token } = {}) => worker.default.fetch(new Request(`http://localhost${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
}), e);
const proof = (over = {}) => ({ network: 'mainnet', priorDigest: D(0xaa), newDigest: D(0xbb), attestedTo: 970140, publicValues: '0x' + 'ab'.repeat(1120), proof: '0x' + 'cd'.repeat(260), ...over });

test('publishing needs the box token', async () => {
  const e = env();
  assert.equal((await call(e, '/reflection/proof', { method: 'POST', body: proof() })).status, 404);
  assert.equal((await call(e, '/reflection/proof', { method: 'POST', body: proof(), token: 'wrong-token-of-the-same-size00' })).status, 404);
  assert.equal(e.REGISTRY_KV._data.size, 0);
});

test('a published proof is readable by anyone, and expires on its own', async () => {
  const e = env();
  assert.deepEqual(await (await call(e, '/reflection/proof?network=mainnet')).json(), { ok: true, proof: null });
  const r = await call(e, '/reflection/proof', { method: 'POST', body: proof(), token: TOKEN });
  assert.equal(r.status, 200);
  const got = await (await call(e, '/reflection/proof?network=mainnet')).json();
  assert.equal(got.ok, true);
  assert.equal(got.proof.attestedTo, 970140);
  assert.equal(got.proof.priorDigest, D(0xaa));
  assert.equal(got.proof.newDigest, D(0xbb));
  assert.equal(got.proof.publicValues.length, 2 + 2 * 1120);
  assert.ok(got.proof.at > 0);
  assert.equal(e.REGISTRY_KV._ttl.get('reflection:proof:mainnet'), 6 * 3600, 'kept for hours, not forever');
  assert.deepEqual((await (await call(e, '/reflection/proof?network=signet')).json()).proof, null, 'networks are kept apart');
});

test('a newer publish replaces the older proof', async () => {
  const e = env();
  await call(e, '/reflection/proof', { method: 'POST', body: proof(), token: TOKEN });
  await call(e, '/reflection/proof', { method: 'POST', body: proof({ priorDigest: D(0xbb), newDigest: D(0xcc), attestedTo: 970150 }), token: TOKEN });
  const got = (await (await call(e, '/reflection/proof?network=mainnet')).json()).proof;
  assert.equal(got.attestedTo, 970150);
  assert.equal(got.newDigest, D(0xcc));
});

test('malformed publishes are refused and nothing is kept', async () => {
  const e = env();
  for (const bad of [
    proof({ priorDigest: '0x1234' }), proof({ newDigest: 'nothex' }), proof({ attestedTo: 0 }), proof({ attestedTo: 'x' }),
    proof({ publicValues: '0x' }), proof({ publicValues: '0xzz'.repeat(40) }), proof({ proof: '0xab' }), proof({ proof: '0x' + 'ab'.repeat(9000) }),
    proof({ publicValues: '0x' + 'ab'.repeat(9000) }), proof({ publicValues: 'ab'.repeat(100) }),
  ]) {
    const r = await call(e, '/reflection/proof', { method: 'POST', body: bad, token: TOKEN });
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 90));
  }
  assert.equal(e.REGISTRY_KV._data.size, 0);
});

test('acking the batch drops its proof, and only its own', async () => {
  const e = env();
  const att = { ackJob: async () => ({ advanced: true }) };
  await call(e, '/reflection/proof', { method: 'POST', body: proof(), token: TOKEN });
  await worker.applyReflectionAck(e, 'mainnet', att, D(0x77), { attestedTo: 970130 }, 970130);
  assert.ok((await (await call(e, '/reflection/proof?network=mainnet')).json()).proof, 'another batch\'s ack leaves it');
  await worker.applyReflectionAck(e, 'mainnet', att, D(0xbb).toUpperCase().replace('0X', '0x'), { attestedTo: 970140 }, 970140);
  assert.equal((await (await call(e, '/reflection/proof?network=mainnet')).json()).proof, null, 'its own ack drops it');
});
