// The pool client works out spend paths from the note feed and reads spent flags from the whole nullifier list, so no
// request it makes names the wallet's notes. Paths and roots match the replay's own tree (worker/src/btc-shielded-pool.js).
import assert from 'node:assert/strict';
import { makePoolClient } from '../dapp/btc-pool-client.js';
import { PoseidonTree } from '../worker/src/btc-shielded-pool.js';

const hex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

// A feed of 13 leaves over blocks 100..106 (two a block), and the replay's tree over it.
const leaves = Array.from({ length: 13 }, (_, i) => BigInt(i * 7919 + 13) * 1000003n);
const heightOf = (i) => 100 + Math.floor(i / 2);
const tree = new PoseidonTree();
const feed = leaves.map((v, i) => { tree.append(hex(new Uint8Array(Buffer.from(v.toString(16).padStart(64, '0'), 'hex')))); return { leafIndex: i, txid: 'aa'.repeat(32), height: heightOf(i), leaf: '0x' + v.toString(16).padStart(64, '0'), asset: '0x00', pk_eph: '0x00', ct_note: '0x00' }; });
const rootAt = (h) => { const n = feed.filter((x) => x.height <= h).length; return hex(tree.rootAndPathAt(0, n).root); };
const NF = ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)];

function server({ list = true } = {}) {
  const calls = [];
  const json = (v, status = 200) => ({ ok: status < 400, status, json: async () => v });
  const fetchImpl = async (url) => {
    const u = new URL(url), p = u.pathname;
    calls.push(p + u.search);
    if (p === '/btc-pool/status') return json({ height: 106 });
    if (p === '/btc-pool/notes') { const from = Number(u.searchParams.get('from')); return json({ notes: feed.slice(from), next: feed.length }); }
    if (p.startsWith('/btc-pool/root/')) { const h = Number(p.split('/').pop()); return json({ height: h, root: rootAt(h), retained: true }); }
    if (p === '/btc-pool/nullifiers') {
      if (!list) return json({ error: 'not found' }, 404);
      const lim = Number(u.searchParams.get('limit')), rows = NF.map((n, i) => ['0x' + n, 101 + i]);
      return json({ height: 106, nullifiers: rows.slice(0, lim), next: null });
    }
    if (p.startsWith('/btc-pool/nullifier/')) return json({ spent: NF.includes(p.split('/').pop()) });
    if (p.startsWith('/btc-pool/path/')) throw new Error('a path was asked of the replay');
    return json({ error: 'not found' }, 404);
  };
  return { calls, client: makePoolClient({ api: 'http://replay', fetchImpl }) };
}

await test('paths and roots for notes of any age match the replay tree at the anchor', async () => {
  const { client } = server();
  for (const [h, idx] of [[103, [0, 7]], [106, [12]], [106, [3, 11]], [101, [2]]]) {
    const notes = idx.map((i) => ({ leafIndex: i, leaf: feed[i].leaf, height: feed[i].height }));
    const r = await client.anchorAndPaths(notes, { anchor: h });
    const n = feed.filter((x) => x.height <= h).length;
    assert.equal(r.root, rootAt(h));
    r.notes.forEach((x, k) => assert.deepEqual(x.path, tree.rootAndPathAt(idx[k], n).path.map(hex), `path of leaf ${idx[k]} at ${h}`));
  }
});

await test('spent flags come from the whole list; no request names a note', async () => {
  const { client, calls } = server();
  const wallet = {}, pool = { scan: () => [{ leafIndex: 1, nf: '0x' + NF[1] }, { leafIndex: 4, nf: '0x' + '44'.repeat(32) }] };
  const mine = await client.walletNotes(pool, wallet);
  assert.deepEqual(mine.map((x) => x.spent), [true, false]);
  assert.ok(!calls.some((c) => c.startsWith('/btc-pool/nullifier/') || c.startsWith('/btc-pool/path/')), calls.join(' '));
  await client.walletNotes(pool, wallet);
  assert.ok(calls.filter((c) => c.startsWith('/btc-pool/nullifiers')).at(-1).includes('from=94'), 'the next read starts twelve blocks back');
});

await test('a replay without the list is asked note by note', async () => {
  const { client, calls } = server({ list: false });
  const pool = { scan: () => [{ leafIndex: 1, nf: '0x' + NF[0] }] };
  assert.deepEqual((await client.walletNotes(pool, {})).map((x) => x.spent), [true]);
  assert.ok(calls.some((c) => c.startsWith('/btc-pool/nullifier/')));
});

console.log(`\n${passed} passed`);
