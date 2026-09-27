// dapp/evm-pool-scan.js sharedSecrets against noble's multiply, and openNotes against openNote.
//   node tests/evm-pool-scan.test.mjs
import assert from 'node:assert/strict';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from 'poseidon-lite';
import { secp } from '../dapp/vendor/tacit-deps.min.js';
import { sharedSecrets } from '../dapp/evm-pool-scan.js';
import { evmPoolKeys, sealNote, openNote, openNotes } from '../dapp/evm-pool-wallet.js';
import { makeEvmPoolZk, poolAsset } from '../dapp/evm-pool-zk.js';

const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });
const G = secp.ProjectivePoint.BASE;
const { n: N, p: FP } = secp.CURVE;
let n = 0;
const ok = (s) => { n++; console.log('  ok -', s); };
const toBig = (b) => { let x = 0n; for (const c of b) x = (x << 8n) | BigInt(c); return x; };
const scalar = () => { for (;;) { const s = toBig(crypto.getRandomValues(new Uint8Array(32))) % N; if (s) return s; } };
const noble = (v, pub) => { try { return secp.ProjectivePoint.fromHex(pub).multiply(v).toRawBytes(true); } catch { return null; } };
const same = (a, b) => (a === null ? b === null : b !== null && a.length === b.length && a.every((x, i) => x === b[i]));

// 2,000 random points: random multiples of G, via the batch generator's own adds so this is quick.
const pubs = [];
{
  let q = G.multiply(scalar());
  const step = G.multiply(scalar());
  for (let i = 0; i < 2000; i++) { pubs.push(q.toRawBytes(true)); q = q.add(step); }
}

{
  const got = sharedSecrets(7n, pubs);
  got.forEach((g, i) => assert.ok(same(g, noble(7n, pubs[i])), `point ${i}`));
  ok('2000 points, v = 7, match noble');
}

{
  const v = scalar();
  sharedSecrets(scalar(), pubs.slice(0, 256));
  pubs.slice(0, 20).forEach((p) => noble(v, p));
  const t0 = performance.now();
  const got = sharedSecrets(v, pubs);
  const tBatch = (performance.now() - t0) / pubs.length;
  const t1 = performance.now();
  const want = pubs.map((p) => noble(v, p));
  const tNoble = (performance.now() - t1) / pubs.length;
  got.forEach((g, i) => assert.ok(same(g, want[i]), `point ${i}`));
  ok(`2000 points, random v: batched ${(tBatch * 1e3).toFixed(0)} µs/point, noble ${(tNoble * 1e3).toFixed(0)} µs/point (${(tNoble / tBatch).toFixed(1)}x)`);
}

{
  const vs = [1n, 2n, 3n, 15n, 16n, 17n, 0xffffn, N - 1n, N - 2n, N >> 1n, (N >> 1n) + 1n, 1n << 128n, (1n << 128n) - 1n, scalar(), scalar(), scalar()];
  const few = pubs.slice(0, 40);
  for (const v of vs) {
    const got = sharedSecrets(v, few);
    got.forEach((g, i) => assert.ok(same(g, noble(v, few[i])), `v ${v} point ${i}`));
  }
  ok(`${vs.length} scalars incl. 1, n−1, n−2, small and 2^128 edges match noble on 40 points`);
}

{
  // P, −P, 2P, λ·P and G in one batch, and a scalar landing an intermediate sum on the base point's own multiples.
  const q = secp.ProjectivePoint.fromHex(pubs[0]);
  const lam = 0x5363ad4cc05c30e0a5261c028812645a122e22ea20816678df02967c1b23bd72n;
  const pts = [q, q.negate(), q.double(), q.multiply(lam), q.multiply(lam).negate(), G, G.negate()].map((x) => x.toRawBytes(true));
  for (const v of [1n, 2n, lam, N - lam, lam + 1n, scalar()]) sharedSecrets(v, pts).forEach((g, i) => assert.ok(same(g, noble(v, pts[i])), `v ${v} point ${i}`));
  ok('related points (±P, 2P, ±λP, ±G) and endomorphism scalars match noble');
}

{
  const b = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
  const x = (v) => v.toString(16).padStart(64, '0');
  let nonRes = 1n;
  while (noble(1n, b('02' + x(nonRes)))) nonRes++;
  const bad = [
    b('02' + x(0n)), b('03' + x(FP)), b('02' + x(FP + 1n)), b('02' + 'ff'.repeat(32)), b('02' + x(nonRes)), b('03' + x(nonRes)),
    b('04' + x(1n)), b('00' + x(1n)), new Uint8Array(32), new Uint8Array(33), G.toRawBytes(false), G.toRawBytes(true).subarray(0, 32),
  ];
  const mixed = [...bad, ...pubs.slice(0, 8)];
  const v = scalar();
  const got = sharedSecrets(v, mixed);
  got.forEach((g, i) => assert.ok(same(g, i < bad.length ? null : noble(v, mixed[i])), `item ${i}`));
  bad.filter((p) => p.length === 33).forEach((p) => assert.equal(noble(v, p), null));
  ok(`${bad.length} invalid keys give null (x = 0, x ≥ p, non-residue x, bad prefix, wrong length) beside valid ones`);
}

{
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(9));
  const other = evmPoolKeys(zk, new Uint8Array(32).fill(4));
  const asset = poolAsset({ chainId: 8453n, pool: '0x' + '11'.repeat(20), token: '0x' + '00'.repeat(20) });
  const self = { V: keys.V, A: keys.A, N: keys.N };
  const them = { V: other.V, A: other.A, N: other.N };
  const items = [];
  for (let i = 0; i < 60; i++) {
    const o = sealNote(zk, { to: i % 5 === 0 ? self : them, value: BigInt(i + 1), asset });
    items.push({ memo: o.memo, leaf: o.leaf, asset });
  }
  const mine = sealNote(zk, { to: self, value: 42n, asset });
  items.push({ memo: mine.memo, leaf: mine.leaf + 1n, asset }); // ours, wrong leaf
  items.push({ memo: mine.memo, leaf: mine.leaf, asset: asset + 1n }); // ours, wrong asset
  items.push({ memo: '0x' + Array.from(mine.memo, (x) => x.toString(16).padStart(2, '0')).join(''), leaf: mine.leaf.toString(), asset }); // hex memo
  items.push({ memo: mine.memo.subarray(0, 64), leaf: mine.leaf, asset }); // short
  items.push({ memo: new Uint8Array(65), leaf: mine.leaf, asset }); // not a point
  const tamper = mine.memo.slice(); tamper[40] ^= 1;
  items.push({ memo: tamper, leaf: mine.leaf, asset }); // bad tag
  const got = openNotes(zk, keys, items);
  const want = items.map((it) => openNote(zk, keys, it));
  assert.deepEqual(got, want);
  const found = got.filter(Boolean).length;
  assert.equal(found, 13);
  assert.equal(got[62].v, 42n);
  assert.deepEqual(openNotes(zk, keys, []), []);
  ok(`openNotes equals openNote on ${items.length} memos (${found} ours, the rest others', mangled or mis-leafed)`);
}

console.log(`${n} passed`);
