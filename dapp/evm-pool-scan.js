// Batched v·P for memo scanning: every memo's pk_eph is multiplied by the same view scalar v, so the points run in
// lockstep through one addition chain for v in affine coordinates, one field inversion per step shared by the batch
// (Montgomery's trick). v is split with the secp256k1 endomorphism, v = k1 + k2·λ (k1, k2 ~128 bits, λ·(x, y) =
// (β·x, y)), and each half is a width-5 NAF over the point's odd multiples, so the chain is ~130 doublings and ~45
// additions.
//
// Not constant-time: the schedule depends only on v, which is fixed per wallet, and all of it runs on this device.
// A lane that meets an exceptional case (x1 = x2 in an addition) is recomputed with noble's multiply.

import { secp } from './vendor/tacit-deps.min.js';

const { p: P, n: N } = secp.CURVE;
const P2 = 2n * P;
const M256 = (1n << 256n) - 1n;
const C = (1n << 32n) + 977n; // 2^256 mod p
const BETA = 0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501een;
const LAMBDA = 0x5363ad4cc05c30e0a5261c028812645a122e22ea20816678df02967c1b23bd72n;
const A1 = 0x3086d221a7d46bcde86c90e49284eb15n;
const B1 = -0xe4437ed6010e88286f547fa90abfe4c3n;
const A2 = 0x114ca50f7a8e2f3f657c1108d9d44cfd8n;
const B2 = A1;
const W = 5;
const CHUNK = 512;

// Partial reduction mod p: any |z| below ~2^600 to a value congruent mod p in (-2^160, 2^257).
const red = (z) => { z = (z >> 256n) * C + (z & M256); return (z >> 256n) * C + (z & M256); };
const canon = (z) => { z %= P; return z < 0n ? z + P : z; };
const sqrN = (x, k) => { while (k-- > 0) x = red(x * x); return x; };
function pow(x, e) {
  let r = 1n;
  for (let i = BigInt(e.toString(2).length - 1); i >= 0n; i--) { r = red(r * r); if ((e >> i) & 1n) r = red(r * x); }
  return r;
}
// x^((p+1)/4), the square root when there is one.
function sqrt(x) {
  const b2 = red(red(x * x) * x);
  const b3 = red(red(b2 * b2) * x);
  const b6 = red(sqrN(b3, 3) * b3);
  const b9 = red(sqrN(b6, 3) * b3);
  const b11 = red(sqrN(b9, 2) * b2);
  const b22 = red(sqrN(b11, 11) * b11);
  const b44 = red(sqrN(b22, 22) * b22);
  const b88 = red(sqrN(b44, 44) * b44);
  const b176 = red(sqrN(b88, 88) * b88);
  const b220 = red(sqrN(b176, 44) * b44);
  const b223 = red(sqrN(b220, 3) * b3);
  const t1 = red(sqrN(b223, 23) * b22);
  const t2 = red(sqrN(t1, 6) * b2);
  return sqrN(t2, 2);
}

const divNearest = (a, b) => (a + b / 2n) / b;
const modN = (a) => { a %= N; return a < 0n ? a + N : a; };
// v = k1 + k2·λ mod n, as signed halves.
function split(v) {
  const c1 = divNearest(B2 * v, N);
  const c2 = divNearest(-B1 * v, N);
  let k1 = modN(v - c1 * A1 - c2 * A2);
  let k2 = modN(-c1 * B1 - c2 * B2);
  if (k1 > N >> 1n) k1 -= N;
  if (k2 > N >> 1n) k2 -= N;
  if (modN(k1 + k2 * LAMBDA) !== modN(v)) throw new Error('evm-pool-scan: bad scalar split');
  return [k1, k2];
}
// Width-W NAF, least significant digit first.
function naf(k) {
  const out = [];
  const full = 1n << BigInt(W), half = full >> 1n;
  while (k > 0n) {
    let d = 0n;
    if (k & 1n) { d = k & (full - 1n); if (d >= half) d -= full; k -= d; }
    out.push(Number(d));
    k >>= 1n;
  }
  return out;
}

// The chain for v: digit lists for the two halves (padded to one length) and each half's sign.
const plans = new Map();
function plan(v) {
  let p = plans.get(v);
  if (p) return p;
  const [k1, k2] = split(v);
  const d1 = naf(k1 < 0n ? -k1 : k1), d2 = naf(k2 < 0n ? -k2 : k2);
  const len = Math.max(d1.length, d2.length);
  while (d1.length < len) d1.push(0);
  while (d2.length < len) d2.push(0);
  p = { d1, d2, neg1: k1 < 0n, neg2: k2 < 0n, len };
  if (plans.size > 8) plans.clear();
  plans.set(v, p);
  return p;
}

// dst[i] = 1/den[i] for every lane not flagged in `bad`; a lane whose den is 0 mod p is flagged.
function batchInvert(den, bad, dst) {
  const n = den.length, pre = new Array(n);
  for (;;) {
    let acc = 1n;
    for (let i = 0; i < n; i++) { if (!bad[i]) acc = red(acc * den[i]); pre[i] = acc; }
    acc = canon(acc);
    if (acc === 0n) {
      for (let i = 0; i < n; i++) if (!bad[i] && canon(den[i]) === 0n) bad[i] = 1;
      continue;
    }
    let inv = pow(acc, P - 2n);
    for (let i = n - 1; i >= 0; i--) {
      if (bad[i]) continue;
      dst[i] = i ? red(inv * pre[i - 1]) : inv;
      inv = red(inv * den[i]);
    }
    return;
  }
}

// (x, y) ← 2·(x, y) in every lane.
function double(x, y, bad, den, inv) {
  const n = x.length;
  for (let i = 0; i < n; i++) den[i] = y[i] + y[i];
  batchInvert(den, bad, inv);
  for (let i = 0; i < n; i++) {
    if (bad[i]) continue;
    const xi = x[i];
    const l = red(3n * red(xi * xi) * inv[i]);
    const x3 = red(l * l - xi - xi);
    y[i] = red(l * (xi - x3) - y[i]);
    x[i] = x3;
  }
}
// (x, y) ← (x, y) + (qx, ±qy) in every lane, into (ox, oy).
function add(x, y, qx, qy, neg, bad, den, inv, ox = x, oy = y) {
  const n = x.length;
  for (let i = 0; i < n; i++) den[i] = qx[i] - x[i];
  batchInvert(den, bad, inv);
  for (let i = 0; i < n; i++) {
    const xi = x[i], yi = y[i], qxi = qx[i];
    if (bad[i]) { ox[i] = xi; oy[i] = yi; continue; }
    const l = red((neg ? -qy[i] - yi : qy[i] - yi) * inv[i]);
    const x3 = red(l * l - xi - qxi);
    oy[i] = red(l * (xi - x3) - yi);
    ox[i] = x3;
  }
}

const toBig = (b, o, n) => { let x = 0n; for (let i = o; i < o + n; i++) x = (x << 8n) | BigInt(b[i]); return x; };
function compress(x, y) {
  const out = new Uint8Array(33);
  out[0] = 2 + Number(y & 1n);
  for (let i = 32; i >= 1; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}
// The affine point of a 33-byte compressed key, or null.
function decompress(b) {
  if (!(b instanceof Uint8Array) || b.length !== 33 || (b[0] !== 2 && b[0] !== 3)) return null;
  const x = toBig(b, 1, 32);
  if (x === 0n || x >= P) return null;
  const r = canon(red(red(x * x) * x) + 7n);
  let y = canon(sqrt(r));
  if (canon(red(y * y)) !== r) return null;
  if (Number(y & 1n) !== (b[0] & 1)) y = P - y;
  return [x, y];
}

function chunk(v, pubs) {
  const n = pubs.length;
  const out = new Array(n).fill(null);
  const bad = new Uint8Array(n), bx = new Array(n), by = new Array(n);
  for (let i = 0; i < n; i++) {
    const q = decompress(pubs[i]);
    if (q) [bx[i], by[i]] = q; else { bad[i] = 1; bx[i] = by[i] = 1n; }
  }
  const none = bad.slice();
  const den = new Array(n), inv = new Array(n);

  // Odd multiples P, 3P, …, (2^(W-1) − 1)P, and β·x of each for λ·jP.
  const T = 1 << (W - 2);
  const tx = [bx], ty = [by];
  const dx = bx.slice(), dy = by.slice();
  double(dx, dy, bad, den, inv);
  for (let j = 1; j < T; j++) {
    const nx = new Array(n), ny = new Array(n);
    add(tx[j - 1], ty[j - 1], dx, dy, false, bad, den, inv, nx, ny);
    tx.push(nx); ty.push(ny);
  }
  const ex = tx.map((col) => col.map((x) => red(x * BETA)));

  const { d1, d2, neg1, neg2, len } = plan(v);
  let x = null, y = null;
  const step = (d, cx, neg) => {
    if (!d) return;
    const j = (Math.abs(d) - 1) >> 1, s = (d < 0) !== neg;
    if (!x) { x = cx[j].slice(); y = s ? ty[j].map((t) => -t) : ty[j].slice(); return; }
    add(x, y, cx[j], ty[j], s, bad, den, inv);
  };
  for (let i = len - 1; i >= 0; i--) {
    if (x) double(x, y, bad, den, inv);
    step(d1[i], tx, neg1);
    step(d2[i], ex, neg2);
  }

  for (let i = 0; i < n; i++) {
    if (none[i]) continue;
    out[i] = bad[i] ? secp.ProjectivePoint.fromHex(pubs[i]).multiply(v).toRawBytes(true) : compress(canon(x[i]), canon(y[i]));
  }
  return out;
}

// compress(v·P) for each 33-byte compressed P, or null where P is not a point.
export function sharedSecrets(v, pubs) {
  v = BigInt(v);
  if (v <= 0n || v >= N) throw new Error('evm-pool-scan: scalar out of range');
  const out = [];
  for (let i = 0; i < pubs.length; i += CHUNK) out.push(...chunk(v, pubs.slice(i, i + CHUNK)));
  return out;
}
