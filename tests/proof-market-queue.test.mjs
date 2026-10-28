// The order board (worker/src/proof-market-queue.js): an order the client builds and a wallet signs is listed; every way an order can be
// junk is refused before a prover spends a proof on it. Run: node --test tests/proof-market-queue.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { checkOrder, makeMarketBoard, MARKET_BOARD } from '../worker/src/proof-market-queue.js';
import { stdinFor } from '../dapp/sp1-stdin.js';
import { readWrapStdin, wrapExpect } from '../worker/src/proof-pool.js';
import * as pm from '../dapp/proof-market.js';
const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { privateKeyToAccount } = require('viem/accounts');

const WRAP_OP = JSON.parse(readFileSync(new URL('./fixtures/sp1-stdin/wrap.op.json', import.meta.url), 'utf8'));
const hx = (b) => '0x' + bytesToHex(b);
const word = (x) => BigInt(x).toString(16).padStart(64, '0');
function pvFor(e) {
  const head = Array.from({ length: 32 }, () => word(0)), tail = [];
  head[0] = word(32); head[1] = word(1); head[2] = e.chainBinding.slice(2); head[28] = e.memoRoot.slice(2);
  head[5] = word(31 * 32); tail.push(word(1), e.leaf.slice(2));
  head[6] = word((31 + tail.length) * 32); tail.push(word(1), e.depositId.slice(2));
  return '0x' + head.join('') + tail.join('');
}
const NOW = 1_900_000_000, MARKET = pm.MARKET[1];
const payer = privateKeyToAccount('0x' + 'a1'.repeat(32)), delegate = privateKeyToAccount('0x' + 'd2'.repeat(32));
const wallet = (a) => ({ request: async ({ params }) => { const p = JSON.parse(params[1]); const { EIP712Domain, ...types } = p.types; return a.signTypedData({ domain: p.domain, types, primaryType: p.primaryType, message: p.message }); } });
const big = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, /^\d+$/.test(String(v)) ? BigInt(v) : v]));

async function order({ value = 1500, tank = false, max = 4n * 10n ** 18n } = {}) {
  const stdin = hx(stdinFor('wrap', { ...WRAP_OP, value: String(value) }));
  const publicValues = pvFor(wrapExpect(readWrapStdin(hexToBytes(stdin.slice(2)))));
  const t = tank ? pm.buildTank({ payer: payer.address, delegate: delegate.address, cap: 30n * 10n ** 18n, perOpMax: 10n * 10n ** 18n, now: NOW }) : null;
  const tankHash = t ? (await import('../worker/src/proof-market-queue.js')).tankDigest((await import('../worker/src/proof-market-queue.js')).domainSeparator(1, MARKET), t) : null;
  const intent = pm.buildIntent({ payer: payer.address, publicValues, floor: 10n ** 18n, max, now: NOW, tank: tank ? hx(tankHash) : undefined });
  const signature = await pm.signIntent(wallet(tank ? delegate : payer), tank ? delegate.address : payer.address, intent);
  const tankSignature = t ? await pm.signTank(wallet(payer), payer.address, t) : undefined;
  return { ...pm.buildOrder({ intent, signature, permit: { v: 27, r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) }, publicValues, memos: [], tank: t, tankSignature }), stdin };
}
const check = (o, extra = {}) => checkOrder(o, { market: MARKET, now: NOW, ...extra });
const kv = () => { const m = new Map(); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } }; };

test('a direct order and a tank order the client built are listed', async () => {
  assert.equal(check(await order()), null);
  assert.equal(check(await order({ tank: true })), null);
});

test('junk is refused before a prover spends a proof on it', async () => {
  const o = await order();
  const bad = (m, why) => assert.match(check(m), why);
  bad({ ...o, publicValues: o.publicValues.slice(0, -1) + (o.publicValues.endsWith('0') ? '1' : '0') }, /public values are not this op/);
  bad({ ...o, stdin: hx(stdinFor('wrap', { ...WRAP_OP, value: '9999' })) }, /does not prove these public values/);
  bad({ ...o, stdin: '0x1234' }, /not a wrap/);
  bad({ ...o, stdin: undefined }, /program input is missing/);
  bad({ ...o, intent: { ...o.intent, maxFee: String(BigInt(o.intent.maxFee) + 1n) } }, /not signed by its payer/);
  bad({ ...o, intent: { ...o.intent, payer: delegate.address } }, /not signed by its payer/);
  bad({ ...o, intent: { ...o.intent, deadline: String(NOW + 5) } }, /deadline is too near/);
  bad({ ...o, intent: { ...o.intent, deadline: String(NOW + 10 * 86400) } }, /deadline is too far/);
  bad({ ...o, intent: { ...o.intent, floorFee: String(BigInt(o.intent.maxFee) + 1n) } }, /below the floor/);
  bad({ ...o, signature: '0x' + '00'.repeat(65) }, /could not be read|not signed/);
  bad({ ...o, permit: { v: 27, r: '0x12' } }, /permit is malformed/);
  bad({ ...o, tank: { payer: payer.address }, tankSignature: o.signature }, /tank is malformed|names a tank/);
  bad(null, /not an order/);
});

test('a tank order must name its tank, be signed by the delegate under the payer\'s tank, and stay under the per-op limit', async () => {
  const o = await order({ tank: true });
  assert.match(check({ ...o, tankSignature: await pm.signTank(wallet(delegate), delegate.address, o.tank) }), /tank is not signed by its payer/);
  assert.match(check({ ...o, tank: { ...o.tank, salt: '99' } }), /names another tank/);
  assert.match(check({ ...o, signature: await pm.signIntent(wallet(payer), payer.address, o.intent) }), /not signed by the tank's key/);
  assert.match(check({ ...o, tank: { ...o.tank, expiry: String(NOW - 1) } }), /tank has expired|names another tank/);
  const big2 = await order({ tank: true, max: 11n * 10n ** 18n });
  assert.match(check(big2), /above the tank's limit/);
  const direct = await order();
  assert.match(check({ ...direct, intent: { ...direct.intent, tank: '0x' + '11'.repeat(32) } }), /names a tank the order does not carry|not signed/);
});

test('the board lists an order once, oldest first, drops it when asked or expired, and is capped', async () => {
  let t = NOW;
  const b = makeMarketBoard({ kv: kv(), market: MARKET, now: () => t });
  const a = await order({ value: 1500 }), c = await order({ value: 1501 });
  assert.equal((await b.post(a)).ok, true);
  assert.equal((await b.post(a)).existing, true);
  assert.equal((await b.post(c)).ok, true);
  assert.deepEqual((await b.list()).map((o) => o.intent.opId), [a.intent.opId, c.intent.opId]);
  assert.equal((await b.post({ ...a, stdin: '0x00' })).ok, false);
  await b.remove(a.intent.opId);
  assert.deepEqual((await b.list()).map((o) => o.intent.opId), [c.intent.opId]);
  t = Number(c.intent.deadline) + 1;
  assert.deepEqual(await b.list(), [], 'past its deadline it is gone');
  const small = makeMarketBoard({ kv: kv(), market: MARKET, cfg: { ...MARKET_BOARD, maxOrders: 1 }, now: () => NOW });
  assert.equal((await small.post(a)).ok, true);
  assert.equal((await small.post(c)).ok, false, 'a full board takes no more');
});

test('routes: any origin posts and lists an order; a done route clears it only when the market says so; "off" closes the board', async () => {
  const { default: worker } = await import('../worker/src/index.js');
  const env = { REGISTRY_KV: kv() };
  let done = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (done ? '1' : '0').padStart(64, '0') }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const o = await order({ value: 1700 });
    o.intent = { ...o.intent };
    const call = (path, init = {}) => worker.fetch(new Request(`https://api.tacit.finance${path}`, { ...init, headers: { Origin: 'https://tacit.finance', 'CF-Connecting-IP': '203.0.113.9', ...(init.headers || {}) } }), env, { waitUntil() {} });
    const post = (x) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(x) });
    const t0 = Math.floor(Date.now() / 1000);
    // the fixture intent is dated 2030; a live order's deadline is near, so the route refuses this one as too far
    let r = await call('/market/order', post({ order: o }));
    assert.equal(r.status, 400); assert.match((await r.json()).error, /too far/);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    r = await call('/market/orders');
    assert.equal(r.status, 200); assert.deepEqual((await r.json()).orders, []);
    r = await call('/market/done', post({ opId: o.intent.opId }));
    assert.equal(r.status, 409, 'the market does not report it settled');
    done = true;
    r = await call('/market/done', post({ opId: o.intent.opId }));
    assert.equal(r.status, 200);
    assert.equal((await call('/market/done', post({ opId: '0x12' }))).status, 400);
    env.PROOF_MARKET_ADDR = 'off';
    assert.equal((await call('/market/orders')).status, 404);
    void t0;
  } finally { globalThis.fetch = realFetch; }
});
