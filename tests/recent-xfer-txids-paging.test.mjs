// Paging /assets/:id/recent-xfer-txids: a scan that follows next_cursor reaches every indexed transfer, whether or not
// the rolling list fills the first page. Run: node tests/recent-xfer-txids-paging.test.mjs
import worker from '../worker/src/index.js';
const AID = 'ab'.repeat(32), NET = 'mainnet';
const tx = (i) => i.toString(16).padStart(64, '0');
function kv(entries) {
  const m = new Map(entries);
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? parseInt(cursor, 10) : 0, page = keys.slice(start, start + limit), end = start + page.length;
      return { keys: page.map((name) => ({ name })), list_complete: end >= keys.length, cursor: end >= keys.length ? undefined : String(end) };
    },
  };
}
async function call(env, q) {
  const r = await worker.fetch(new Request(`https://api.tacit.finance/assets/${AID}/recent-xfer-txids?network=${NET}&${q}`, { headers: { Origin: 'https://tacit.finance' } }), env, { waitUntil() {} });
  if (r.status !== 200) throw new Error(`status ${r.status}: ${await r.text()}`);
  return r.json();
}
async function walk(env, limit) {
  const seen = new Set(); let cursor = null, pages = 0;
  for (;;) { const j = await call(env, `limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); pages++; j.txids.forEach((t) => seen.add(t)); if (!j.next_cursor) return { seen, pages, last: j }; cursor = j.next_cursor; if (pages > 50) throw new Error('runaway'); }
}
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
// 12 transfers in the lex index; the 5 newest are also in the rolling list
const all = Array.from({ length: 12 }, (_, i) => tx(i + 1));
const rolling = all.slice(7).reverse().map((t) => ({ txid: t }));
const base = all.map((t) => [`xferseen:${NET}:${AID}:${t}`, '1']);
const rk = `recent-cxfers:${NET}:${AID}`;
const env1 = { REGISTRY_KV: kv([...base, [rk, JSON.stringify(rolling)]]) };
const p1 = await call(env1, 'limit=3');
ok(p1.txids.length === 3 && p1.txids[0] === all[11], 'first page: the 3 newest, newest first');
ok(p1.done === false && p1.next_cursor === 'lex-start', 'a first page the rolling list fills pages on into the lex walk');
const w1 = await walk(env1, 3);
ok(all.every((t) => w1.seen.has(t)), `paging from there reaches all 12 transfers (${w1.pages} pages)`);
ok(w1.last.done === true, 'the walk ends done');
// rolling list shorter than a page: unchanged behaviour
const env2 = { REGISTRY_KV: kv([...base, [rk, JSON.stringify(rolling.slice(0, 2))]]) };
const q2 = await call(env2, 'limit=5');
ok(q2.txids.length === 5 && new Set(q2.txids).size === 5 && q2.txids[0] === all[11], 'a short rolling list is topped up from the lex walk without repeats');
const w2 = await walk(env2, 5);
ok(all.every((t) => w2.seen.has(t)) && w2.last.done === true, 'and pages through the rest as before');
// nothing at all
const e3 = await call({ REGISTRY_KV: kv([]) }, 'limit=10');
ok(e3.txids.length === 0 && e3.done === true && e3.next_cursor === null, 'an empty index is done at once');
// a large page the rolling list fills with an empty lex index
const env4 = { REGISTRY_KV: kv([[rk, JSON.stringify(rolling)]]) };
const w4 = await walk(env4, 5);
ok(w4.seen.size === 5 && w4.last.done === true, 'a rolling-only index ends after one extra empty page');
console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
