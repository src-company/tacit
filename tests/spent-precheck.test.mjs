// The relay's pre-proof check (worker-relay/src/lib/spent-precheck.js) recomputes deposit ids and input nullifiers from a
// job's witness. Checked here against the dapp's pool library, against the ids the guest really committed in the proven
// fixtures, and for its behaviour on a mocked chain: skip only on positive evidence, let everything else through.
// Offline: node tests/spent-precheck.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { keccak256, concat, pad } from '../worker-relay/node_modules/viem/_esm/index.js';
import { depositsOf, spentInputsOf, noteNullifier, depositIdOf, consumedInputs, consumedInput, consumedAck, unlandedDeposits } from '../worker-relay/src/lib/spent-precheck.js';
import { secp, sha256, keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const pool = makeConfidentialPool({ secp, sha256, keccak256: keccak_256 });
const OPS = new URL('../contracts/sp1/confidential/fixtures/', import.meta.url);
const PVS = new URL('../contracts/test/fixtures/', import.meta.url);
const opOf = (t) => JSON.parse(readFileSync(new URL(`${t}_op.json`, OPS), 'utf8'));
const pvOf = (t) => JSON.parse(readFileSync(new URL(`${t}_groth16.json`, PVS), 'utf8')).publicValues.toLowerCase();

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const lc = (h) => String(h).toLowerCase();

for (const t of ['wrap', 'wraptransfer', 'wraplp', 'wrapswap', 'transfer', 'unwrap', 'sendunwrap', 'lp', 'swap']) {
  ok(`${t}: ids match the dapp's pool library`, () => {
    const op = opOf(t);
    for (const d of depositsOf(t, op)) assert.equal(lc(depositIdOf(d)), lc(pool.depositId(d.asset, d.value, d.cx, d.cy, d.owner)));
    for (const n of spentInputsOf(op)) assert.equal(lc(noteNullifier(n)), lc(pool.nativeNu(n.owner, n.nk, pool.leaf(n.asset, n.cx, n.cy, n.owner))));
  });
}

const EXPECT = { wrap: [1, 0], wraptransfer: [1, 0], wraplp: [2, 0], wrapswap: [1, 0], unwrap: [0, 1], sendunwrap: [0, 1], lp: [0, 2], swap: [0, 1] };
for (const [t, [nDep, nNu]] of Object.entries(EXPECT)) {
  ok(`${t}: every id the proof committed is among the candidates`, () => {
    const op = opOf(t), pv = pvOf(t);
    const hit = (h) => pv.includes(h.slice(2).toLowerCase());
    assert.equal(depositsOf(t, op).map(depositIdOf).filter(hit).length, nDep);
    assert.equal(new Set(spentInputsOf(op).map(noteNullifier).filter(hit)).size, nNu);
  });
}

// A chain where `spent` nullifiers are set and `consumed` deposits have status 2.
const slotOf = (nu) => lc(keccak256(concat([nu, pad('0x46', { size: 32 })])));
const chain = ({ spent = [], consumed = [], absent = [], broken = false } = {}) => ({
  async readContract({ args }) { if (broken) throw new Error('rpc down'); return consumed.map(lc).includes(lc(args[0])) ? 2 : absent.map(lc).includes(lc(args[0])) ? 0 : 1; },
  async getStorageAt({ slot }) { if (broken) throw new Error('rpc down'); return spent.map(slotOf).includes(lc(slot)) ? pad('0x1', { size: 32 }) : pad('0x0', { size: 32 }); },
});
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const unwrapJob = { type: 'unwrap', op: opOf('unwrap') };
const wrapJob = { type: 'wrap', op: opOf('wrap') };
const nuUnwrap = noteNullifier(spentInputsOf(unwrapJob.op)[0]);
const depWrap = depositIdOf(depositsOf('wrap', wrapJob.op)[0]);

const okAsync = async (name, fn) => { await fn(); pass++; console.log('  ok  ' + name); };
await okAsync('a spent input nullifier stops the job', async () =>
  assert.match(await consumedInputs(unwrapJob, { client: chain({ spent: [nuUnwrap] }), pool: POOL }), /already spent/));
await okAsync('a consumed deposit stops the job', async () =>
  assert.match(await consumedInputs(wrapJob, { client: chain({ consumed: [depWrap] }), pool: POOL }), /already consumed/));
await okAsync('unspent inputs and a pending deposit let the job through', async () => {
  assert.equal(await consumedInputs(unwrapJob, { client: chain(), pool: POOL }), null);
  assert.equal(await consumedInputs(wrapJob, { client: chain(), pool: POOL }), null);
});
await okAsync('an unreadable chain lets the job through', async () =>
  assert.equal(await consumedInputs(unwrapJob, { client: chain({ broken: true }), pool: POOL }), null));
await okAsync('an op without recognisable inputs lets the job through', async () => {
  assert.equal(await consumedInputs({ type: 'mystery', op: { foo: 1 } }, { client: chain({ spent: [nuUnwrap] }), pool: POOL }), null);
  assert.equal(await consumedInputs({ type: 'wrap', op: null }, { client: chain(), pool: POOL }), null);
});

await okAsync('the gone input is named with its kind, so the relay can find what consumed it', async () => {
  assert.deepEqual(await consumedInput(unwrapJob, { client: chain({ spent: [nuUnwrap] }), pool: POOL }),
    { kind: 'nullifier', id: nuUnwrap, reason: `input nullifier ${nuUnwrap} is already spent` });
  assert.equal((await consumedInput(wrapJob, { client: chain({ consumed: [depWrap] }), pool: POOL })).kind, 'deposit');
});
await okAsync('a deposit the pool never recorded is named; pending, consumed and unreadable ones are not', async () => {
  assert.deepEqual(await unlandedDeposits(wrapJob, { client: chain({ absent: [depWrap] }), pool: POOL }), [depWrap]);
  assert.deepEqual(await unlandedDeposits(wrapJob, { client: chain(), pool: POOL }), []);
  assert.deepEqual(await unlandedDeposits(wrapJob, { client: chain({ consumed: [depWrap] }), pool: POOL }), []);
  assert.deepEqual(await unlandedDeposits(wrapJob, { client: chain({ broken: true }), pool: POOL }), []);
  assert.deepEqual(await unlandedDeposits(unwrapJob, { client: chain({ absent: [depWrap] }), pool: POOL }), []);
});

ok('a gone input acks the job settled when its own settle, or any settle of its deposit, is found; a spent note otherwise fails it', () => {
  const dep = { kind: 'deposit', id: '0x01' }, nu = { kind: 'nullifier', id: '0x02' };
  assert.deepEqual(consumedAck(dep, { own: '0xaa' }), { txHash: '0xaa' });
  assert.deepEqual(consumedAck(nu, { own: '0xaa' }), { txHash: '0xaa' });
  assert.deepEqual(consumedAck(dep, { by: '0xbb' }), { txHash: '0xbb', settledBy: '0xbb' }, 'a deposit settled from the page itself is this job done');
  assert.match(consumedAck(nu, { by: '0xbb' }).error, /already spent in 0xbb; if that was this same request, it went through/);
  assert.match(consumedAck(dep, {}).error, /already settled into a private note$/);
  assert.match(consumedAck(nu, {}).error, /already spent;/);
});

console.log(`\n${pass} passed, 0 failed`);
