#!/usr/bin/env node
// worker/src/burndep-admission.js: the header-chain cache + chain-building logic behind
// POST /reflection/burndep/check and the scan's own getBurnDeposits (reflection-attest.js). Covers the two
// shapes buildOrExtendProvHeaders handles — building a fresh chain from a bundle's etch height, and
// extending an already-present chain forward to a batch anchor — plus the header cache's chunking and reuse.
//   node tests/burndep-admission.mjs
import { createHash } from 'node:crypto';
import { mineHeader, dsha256 } from './btc-mini.mjs';
import { makeBurndepAdmission } from '../worker/src/burndep-admission.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { sha256 };
let failures = 0;
const ok = (c, m) => { if (c) console.log(`ok   ${m}`); else { console.error(`FAIL ${m}`); failures++; } };

const bytesToHex = (b) => '0x' + Buffer.from(b).toString('hex');
const bareHex = (b) => Buffer.from(b).toString('hex'); // esplora's own convention: block hashes are never 0x-prefixed
const reverse = (b) => Buffer.from(b).reverse();
const blockHashOf = (header) => reverse(dsha256(header)); // display-order block hash, as esplora returns it

// ── A small, real, linked, easy-PoW chain: heights FLOOR..FLOOR+N-1 ──
// FLOOR is a multiple of every headerChunk size used below (4 and N itself), so chunk boundaries land
// exactly on the fixture's own edges instead of reaching into heights the stub api doesn't know about.
const FLOOR = 480;
const N = 12;
const headers = [];
{
  let prev = null;
  for (let i = 0; i < N; i++) {
    const merkleRoot = Buffer.alloc(32, i + 1); // arbitrary — this module never checks tx inclusion
    const h = mineHeader(merkleRoot, 0x1f00ffff, prev);
    headers.push(h);
    prev = blockHashOf(h);
  }
}
const hashAtHeight = (h) => bareHex(blockHashOf(headers[h - FLOOR]));
const heightOfHash = new Map(headers.map((h, i) => [bareHex(blockHashOf(h)), FLOOR + i]));

// Decode one of the fixture's raw 80-byte headers back into the /blocks/:height summary shape production
// code reconstructs a header FROM (the reverse of burndep-admission.js's own headerFromBlockSummary) — real
// esplora field names, so the stub below exercises the actual bulk-fetch parsing, not a shortcut around it.
function summaryOf(height) {
  const h = headers[height - FLOOR];
  const prevHex = bareHex(Buffer.from(h.subarray(4, 36)).reverse());
  const merkleHex = bareHex(Buffer.from(h.subarray(36, 68)).reverse());
  return {
    id: hashAtHeight(height), height,
    version: h.readUInt32LE(0), previousblockhash: prevHex, merkle_root: merkleHex,
    timestamp: h.readUInt32LE(68), bits: h.readUInt32LE(72), nonce: h.readUInt32LE(76),
  };
}

function makeKv() {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, _map: m };
}

// Fake esplora api(env, path, opts, network) over the chain above. Tracks /blocks bulk-call COUNT (not
// per-height) so the cache's actual effect, and the real request-count savings the bulk rewrite exists for,
// are both checked.
function makeApi() {
  let blocksCalls = 0;
  const fn = async (_env, path, _opts, _network) => {
    let m;
    if ((m = path.match(/^\/blocks\/(\d+)$/))) {
      blocksCalls++;
      const top = Number(m[1]);
      const out = [];
      for (let h = top; h > top - 10 && h >= FLOOR; h--) { if (h < FLOOR + N) out.push(summaryOf(h)); }
      if (!out.length) throw new Error(`stub: no blocks at or below height ${top}`);
      return JSON.stringify(out);
    }
    if ((m = path.match(/^\/block\/([0-9a-fA-F]+)$/))) {
      const height = heightOfHash.get(m[1].toLowerCase());
      if (height == null) throw new Error('stub: unknown hash (info)');
      return JSON.stringify({ height });
    }
    throw new Error(`stub: unhandled path ${path}`);
  };
  return { fn, count: () => blocksCalls };
}

function makeAdmission({ headerChunk = 4 } = {}) {
  const env = { REGISTRY_KV: makeKv() };
  const api = makeApi();
  const admission = makeBurndepAdmission({
    env, api: api.fn, apiRawBytes: async () => { throw new Error('not exercised by this test'); },
    network: 'signet',
    kit: { computeTxidInternal: () => { throw new Error('not exercised by this test'); }, admitBurnDeposit: () => { throw new Error('not exercised by this test'); } },
    deps, headerChunk,
  });
  return { env, api, admission };
}

// ── getHeadersRangeCached: correctness + caching (chunk size 4, so N=12 spans 3 chunks) ──
{
  const { env, api, admission } = makeAdmission({ headerChunk: 4 });
  const got = await admission.getHeadersRangeCached(FLOOR, FLOOR + N - 1);
  ok(got.length === N, 'range: returns every header in the range');
  ok(got.every((h, i) => h === bytesToHex(headers[i])), 'range: headers returned in height order, byte-exact');
  const fetchesAfterFirst = api.count();
  ok(fetchesAfterFirst === 3, `range: fetched via 3 bulk /blocks calls (one per 4-height chunk), not one per height (got ${fetchesAfterFirst})`);

  const got2 = await admission.getHeadersRangeCached(FLOOR + 1, FLOOR + 3); // fully inside the first cached chunk
  ok(got2.length === 3 && got2[0] === bytesToHex(headers[1]), 'range: narrower re-query slices the cache correctly');
  ok(api.count() === fetchesAfterFirst, 'range: a fully-cached re-query makes zero new header fetches');

  const partial = await admission.getHeadersRangeCached(FLOOR + 2, FLOOR + 5); // crosses the chunk-1/chunk-2 boundary
  ok(partial.length === 4 && partial[0] === bytesToHex(headers[2]) && partial[3] === bytesToHex(headers[5]), 'range: a query spanning a chunk boundary is assembled correctly');
}

// ── warmHeaderChunks: fills only complete chunks, is budget-bounded and idempotent ──
// FLOOR=480 is chunk-aligned at headerChunk=4: chunk120=[480-483], chunk121=[484-487], chunk122=[488-491] —
// all 3 fully within the fake chain (heights 480-491), so tipHeight=491 makes every chunk completable.
{
  const { env, api, admission } = makeAdmission({ headerChunk: 4 });
  const TIP = FLOOR + N - 1; // 491 — exactly the top of the last chunk

  const r1 = await admission.warmHeaderChunks(FLOOR, TIP, { budgetChunks: 1 });
  ok(r1.filled === 1, 'warm: fills exactly one chunk under a budget of 1');
  ok(env.REGISTRY_KV._map.size === 1, 'warm: exactly one chunk row written to KV');
  ok(api.count() === 1, 'warm: one bulk /blocks call for that one (4-height) chunk, not 4 individual fetches');

  const r2 = await admission.warmHeaderChunks(FLOOR, TIP, { budgetChunks: 5 });
  ok(r2.filled === 2, 'warm: next call fills the 2 remaining chunks, stops there (budget was not the limiter)');
  ok(env.REGISTRY_KV._map.size === 3, 'warm: all 3 chunk rows now cached (12 heights / 4 per chunk)');
  ok(api.count() === 3, 'warm: 3 total bulk calls across all 3 chunks (one each), never re-fetching chunk 1');

  const r3 = await admission.warmHeaderChunks(FLOOR, TIP, { budgetChunks: 5 });
  ok(r3.filled === 0 && api.count() === 3, 'warm: idempotent — fully warmed range does no further work');
}

// ── warmHeaderChunks: a chunk the tip falls inside stays incomplete — not cached, not counted as filled ──
{
  const { env, admission } = makeAdmission({ headerChunk: 4 });
  const r = await admission.warmHeaderChunks(FLOOR, FLOOR + 5, { budgetChunks: 5 }); // tip=505 lands inside chunk126=[504-507]
  ok(r.filled === 1, 'warm (partial tip): only the one fully-completable chunk (125) counts as filled');
  ok(env.REGISTRY_KV._map.size === 1, 'warm (partial tip): the incomplete chunk is never written to KV');
}

// ── buildOrExtendProvHeaders: the actual entry point getBurnDeposits calls ──
// Case A: bundle has NO provHeaders but has an etch blockHash — builds a fresh chain to anchorHeight.
{
  const { admission } = makeAdmission({ headerChunk: N }); // one chunk covers the whole test range
  const etchHash = hashAtHeight(FLOOR);
  const bundle = { etch: { blockHash: etchHash, tx: '0x00' }, cxfers: [] };
  const anchorHeight = FLOOR + N - 1;
  const out = await admission.buildOrExtendProvHeaders(bundle, anchorHeight);
  ok(Array.isArray(out.provHeaders) && out.provHeaders.length === N, 'fresh: builds a chain from the etch height to the anchor');
  ok(out.provHeaders[0] === bytesToHex(headers[0]) && out.provHeaders[N - 1] === bytesToHex(headers[N - 1]), 'fresh: chain starts at the etch header and ends at the anchor header');
  ok(out !== bundle && bundle.provHeaders === undefined, 'fresh: the input bundle object is not mutated');
}

// Case A2: the anchor falls inside a chunk whose own natural top extends past the fixture's known chain —
// a production-shaped chunk that isn't "complete" yet, where every height actually needed up to the anchor
// is nonetheless fully fetchable. The range must still be served in full rather than treated as unavailable.
{
  const { admission } = makeAdmission({ headerChunk: N * 4 }); // chunk's own top (527) is far past height 491
  const bundle = { etch: { blockHash: hashAtHeight(FLOOR), tx: '0x00' }, cxfers: [] };
  const anchorHeight = FLOOR + N - 1;
  const out = await admission.buildOrExtendProvHeaders(bundle, anchorHeight);
  ok(Array.isArray(out.provHeaders) && out.provHeaders.length === N, `fresh (incomplete last chunk): still builds the full reachable chain (got ${out.provHeaders && out.provHeaders.length})`);
  ok(out.provHeaders && out.provHeaders[N - 1] === bytesToHex(headers[N - 1]), 'fresh (incomplete last chunk): reaches exactly the anchor header');
}

// Case B: bundle has NO provHeaders and the range exceeds what's cached/fetchable — bundle is left unchanged (stays pending), not thrown.
{
  const { admission } = makeAdmission({ headerChunk: 4 });
  const etchHash = hashAtHeight(FLOOR);
  const bundle = { etch: { blockHash: etchHash, tx: '0x00' }, cxfers: [] };
  const out = await admission.buildOrExtendProvHeaders(bundle, FLOOR + 50); // beyond the fake chain's known heights
  ok(out === bundle, 'fresh (unfetchable): bundle returned unchanged rather than throwing — stays pending');
}

// Case C: bundle already has a short provHeaders chain that needs extending to reach the anchor.
{
  const { admission } = makeAdmission({ headerChunk: N });
  const bundle = { etch: { blockHash: hashAtHeight(FLOOR), tx: '0x00' }, cxfers: [], provHeaders: [bytesToHex(headers[0]), bytesToHex(headers[1])] };
  const anchorHeight = FLOOR + N - 1;
  let threw = null;
  let out;
  try { out = await admission.buildOrExtendProvHeaders(bundle, anchorHeight); } catch (e) { threw = e; }
  ok(!threw, `extend: does not throw${threw ? ` — got ${threw.message}` : ''}`);
  ok(out && out.provHeaders.length === N, 'extend: the short chain is extended all the way to the anchor');
  ok(out && out.provHeaders.slice(0, 2).every((h, i) => h === bytesToHex(headers[i])), 'extend: the original (holder-submitted) prefix is preserved verbatim');
}

// Case D: an already-sufficient chain (reaches at or past the anchor already) is returned unchanged.
{
  const { admission } = makeAdmission({ headerChunk: N });
  const full = headers.map((h) => bytesToHex(h));
  const bundle = { etch: { blockHash: hashAtHeight(FLOOR), tx: '0x00' }, cxfers: [], provHeaders: full };
  const out = await admission.buildOrExtendProvHeaders(bundle, FLOOR + N - 1);
  ok(out === bundle, 'extend (already sufficient): bundle returned as-is, no extra fetch attempted');
}

// Case E: a chain whose last header does not correspond to any known block resolves to "leave unchanged", not a throw.
{
  const { admission } = makeAdmission({ headerChunk: N });
  const bogus = mineHeader(Buffer.alloc(32, 0xee), 0x1f00ffff, null); // a real, valid, but chain-disconnected header
  const bundle = { etch: { blockHash: hashAtHeight(FLOOR), tx: '0x00' }, cxfers: [], provHeaders: [bytesToHex(bogus)] };
  const out = await admission.buildOrExtendProvHeaders(bundle, FLOOR + N - 1);
  ok(out === bundle, 'extend (unknown tip): bundle returned unchanged rather than throwing');
}

console.log(failures ? `\n${failures} FAILURES` : '\nall burndep-admission checks passed');
process.exit(failures ? 1 : 0);
