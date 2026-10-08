// src/lib/block-at-time.js: the last block at or before a time, the same exact block a fresh binary search finds, with the
// timestamps already read narrowing each later search.
//   node worker-relay/tests/block-at-time.test.mjs
import assert from 'node:assert/strict';
import { makeBlockAtOrBefore } from '../src/lib/block-at-time.js';

// A chain of 12-second slots with some slots missed, as mainnet's.
const T0 = 1_700_000_000n, N = 200_000;
const times = [];
let t = T0;
for (let i = 0; i < N; i++) { times.push(t); t += (i % 97 === 0 ? 24n : 12n); }
const naive = (target) => { let lo = 0, hi = N - 1; if (times[hi] <= target) return BigInt(hi); while (lo < hi) { const mid = lo + Math.ceil((hi - lo) / 2); if (times[mid] <= target) lo = mid; else hi = mid - 1; } return BigInt(lo); };

let reads = 0;
const find = makeBlockAtOrBefore(async (n) => { reads++; return times[Number(n)]; });
const tip = BigInt(N - 1);
for (const target of [T0, T0 + 5n, T0 + 12n, T0 + 1_000_003n, times[150_000], times[150_000] - 1n, times[N - 1] + 100n]) {
  assert.equal(await find(target, tip), naive(target), `target ${target}`);
}
console.log('ok - the same block a fresh search finds, at the edges, exact matches and between blocks');

// Deposits seconds apart: after the first search, each costs a read or two.
const base = times[120_000] + 3n;
await find(base, tip);
const before = reads;
for (let k = 1; k <= 50; k++) assert.equal(await find(base + BigInt(k * 7), tip), naive(base + BigInt(k * 7)));
assert.ok(reads - before <= 100, `50 nearby searches read ${reads - before} timestamps`);
console.log(`ok - 50 nearby searches read ${reads - before} timestamps in all, where fresh searches would read ~${50 * 18}`);

// A lower tip than blocks already read: nothing past it is used.
assert.equal(await find(times[N - 1], 1000n), 1000n);
console.log('ok - a search under a lower tip ignores blocks read beyond it');
console.log('\nall block-at-time checks passed');
