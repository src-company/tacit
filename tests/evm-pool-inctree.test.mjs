// dapp/evm-pool-zk.js incTree against the full-rebuild tree(): root, tracked paths and the insertion path after
// random batches, across a save/restore, and a real witness built from each.
//   node tests/evm-pool-inctree.test.mjs
import assert from 'node:assert/strict';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from 'poseidon-lite';
import { makeEvmPoolZk } from '../dapp/evm-pool-zk.js';

const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });
let n = 0;
const ok = (s) => { n++; console.log('  ok -', s); };
let seed = 7;
const rnd = (m) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % m; };

for (const run of [0, 1, 2]) {
  let t = zk.incTree();
  const leaves = [];
  const tracked = new Set();
  for (let step = 0; step < 40; step++) {
    const k = 1 + rnd(run === 2 ? 3 : 9);
    const batch = Array.from({ length: k }, () => BigInt(1 + rnd(1e9)));
    const track = [];
    batch.forEach((_, j) => { if (rnd(4) === 0) track.push(leaves.length + j); });
    t.append(batch, track);
    leaves.push(...batch);
    track.forEach((i) => tracked.add(i));
    if (step % 7 === 3) t = zk.incTree(JSON.parse(JSON.stringify(t.toJSON())));
    const full = zk.tree(leaves);
    assert.equal(t.root, full.root, `root at step ${step}`);
    assert.equal(t.size, leaves.length);
    for (const i of tracked) assert.deepEqual(t.path(i), full.path(i), `path of ${i} at step ${step}`);
    if (leaves.length % 2 === 0) assert.deepEqual(t.siblings(1, leaves.length >> 1), full.siblings(1, leaves.length >> 1), 'insertion path');
  }
  ok(`run ${run}: root, ${tracked.size} tracked paths and the insertion path match the full tree through 40 random batches (${leaves.length} leaves)`);
}

{
  const t = zk.incTree();
  const many = Array.from({ length: 5000 }, (_, i) => BigInt(i + 1));
  const t0 = performance.now();
  t.append(many, [17, 4999]);
  const ms = performance.now() - t0;
  const full = zk.tree(many);
  assert.equal(t.root, full.root);
  assert.deepEqual(t.path(4999), full.path(4999));
  const json = JSON.stringify(t.toJSON());
  ok(`5000 leaves in one batch: ${ms.toFixed(0)} ms; stored state ${json.length} bytes (vs ${many.length * 77} for the leaves)`);
}

{
  // A witness from the incremental tree equals one from the leaves.
  const asset = 123n;
  const t = zk.incTree();
  const wallet = zk.walletKeys(new Uint8Array(32).fill(3), 'mainnet');
  const s = new Uint8Array(33); s[0] = 2; s[1] = 9;
  const own = zk.ownedKeys(wallet, s);
  const leaf = zk.leafOf(asset, 500n, own.npk, own.rho);
  const leaves = [11n, 22n, leaf, 0n, 33n, 44n];
  t.append(leaves, [2]);
  const args = { asset, inputs: [{ v: 500n, rho: own.rho, nk: own.nk, sk: own.sk, index: 2 }, null], outputs: [{ v: 500n, npk: 7n, rho: 8n }, null], extAmount: 0n, fee: 0n, extDataHash: 5n };
  const a = zk.buildWitness({ ...args, leaves });
  const b = zk.buildWitness({ ...args, tree: t });
  assert.deepEqual(a.publicSignals, b.publicSignals);
  assert.deepEqual(a.input.inPath, b.input.inPath);
  assert.deepEqual(a.input.insPath, b.input.insPath);
  assert.throws(() => zk.buildWitness({ ...args, inputs: [{ v: 499n, rho: own.rho, nk: own.nk, sk: own.sk, index: 2 }, null], outputs: [{ v: 499n, npk: 7n, rho: 8n }, null], tree: t }), /not the leaf/);
  ok('a witness from the incremental tree matches one from the leaves; a wrong note is refused');
}

console.log(`\n${n} checks passed`);
