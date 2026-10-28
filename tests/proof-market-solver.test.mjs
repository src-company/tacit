// The settle relay's market pass (worker-relay/src/lib/market-solver.js) with the chain and the prover stubbed. Run: node --test tests/proof-market-solver.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMarketSolver } from '../worker-relay/src/lib/market-solver.js';

const ME = '0x' + '77'.repeat(20), OTHER = '0x' + '88'.repeat(20);
const mk = (id, extra = {}) => ({ publicValues: '0x', intent: { opId: id, floorFee: '1000', maxFee: '5000', start: '1000', rampSecs: '0', deadline: '9000', ...extra } });
function rig({ orders, doneSet = new Set(), holder = {}, proveMs = 0, claimLapses = false, deposit = 1 } = {}) {
  let t = 2_000_000; // ms
  const calls = [], cleared = [], claims = { ...holder };
  const s = makeMarketSolver({
    me: ME, now: () => t, retryMs: 120_000,
    listOrders: async () => orders,
    depositStatus: async () => deposit,
    done: async (id) => doneSet.has(id),
    claimOf: async (id) => claims[id] || null,
    claim: async (o) => { calls.push(['claim', o.intent.opId]); claims[o.intent.opId] = { solver: ME, until: claimLapses ? 1 : 3000 }; return '0xc1'; },
    prove: async (o) => { calls.push(['prove', o.intent.opId]); t += proveMs; return { publicValues: '0x01', proof: '0x02' }; },
    fulfil: async (o) => { calls.push(['fulfil', o.intent.opId]); return '0xf1'; },
    clear: async (id) => { cleared.push(id); },
  });
  return { s, calls, cleared, tick: (ms) => { t += ms; } };
}

test('claims and proves an open order together, then fulfils and clears it', async () => {
  const r = rig({ orders: [mk('0xa')] });
  assert.equal(await r.s.pass(), true);
  assert.deepEqual(r.calls.map((c) => c[0]).sort(), ['claim', 'fulfil', 'prove']);
  assert.equal(r.calls.at(-1)[0], 'fulfil', 'the fulfil goes last');
  assert.deepEqual(r.cleared, ['0xa']);
});

test('leaves an order another prover holds, one already settled (and clears it), and one too near its deadline or below the price floor', async () => {
  const r = rig({ orders: [mk('0xb'), mk('0xc'), mk('0xd', { deadline: '2010' }), mk('0xe')], doneSet: new Set(['0xc']), holder: { '0xb': { solver: OTHER, until: 3000 } } });
  assert.equal(await r.s.pass(), true, 'the last one is taken');
  assert.deepEqual(r.calls.filter((c) => c[0] === 'claim').map((c) => c[1]), ['0xe']);
  assert.deepEqual(r.cleared, ['0xc', '0xe']);
  const low = rig({ orders: [mk('0xf')] });
  const s2 = makeMarketSolver({ me: ME, depositStatus: async () => 1, now: () => 2_000_000, minPrice: 9000n, listOrders: async () => [mk('0xf')], done: async () => false, claimOf: async () => null, claim: async () => { throw new Error('no'); }, prove: async () => ({}), fulfil: async () => {}, clear: async () => {} });
  assert.equal(await s2.pass(), false, 'below the price the relay will work for');
  void low;
});

test('a claim that lapses before the proof is back is not fulfilled, and the order is left for a while', async () => {
  const r = rig({ orders: [mk('0xg')], claimLapses: true });
  assert.equal(await r.s.pass(), true);
  assert.ok(!r.calls.some((c) => c[0] === 'fulfil'));
  assert.equal(await r.s.pass(), false, 'not retried at once');
  r.tick(11_000);
  assert.equal(await r.s.pass(), true, 'tried again shortly, with the proof it already has');
  assert.equal(r.calls.filter((c) => c[0] === 'prove').length, 1, 'proved once');
});

test('a failure in claim, prove or fulfil is logged and the order waits out the retry gap; the board being down is not an error', async () => {
  const logs = [];
  const s = makeMarketSolver({ me: ME, depositStatus: async () => 1, now: () => 2_000_000, log: (m) => logs.push(m), listOrders: async () => [mk('0xh')], done: async () => false, claimOf: async () => null,
    claim: async () => '0x1', prove: async () => { throw new Error('the prover is out of credit'); }, fulfil: async () => {}, clear: async () => {} });
  assert.equal(await s.pass(), true);
  assert.match(logs.join('\n'), /out of credit/);
  assert.equal(await s.pass(), false);
  const down = makeMarketSolver({ me: ME, depositStatus: async () => 1, listOrders: async () => { throw new Error('502'); }, done: async () => false, claimOf: async () => null, claim: async () => {}, prove: async () => {}, fulfil: async () => {}, clear: async () => {} });
  assert.equal(await down.pass(), false);
});

test('a fulfil that fails because the deposit has not landed is tried again while the claim lasts, then given up', async () => {
  let t = 2_000_000, tries = 0;
  const mkS = (okAt) => makeMarketSolver({ me: ME, depositStatus: async () => 1, now: () => t, sleep: async (ms) => { t += ms; }, listOrders: async () => [mk('0xi')], done: async () => false,
    claimOf: async () => ({ solver: ME, until: 2040 }), claim: async () => '0x1', prove: async () => ({ proof: '0x' }), clear: async () => {},
    fulfil: async () => { tries++; if (tries < okAt) throw new Error('deposit missing'); return '0xf'; } });
  assert.equal(await mkS(3).pass(), true);
  assert.equal(tries, 3, 'landed on the third try');
  tries = 0; t = 2_000_000;
  assert.equal(await mkS(99).pass(), true);
  assert.ok(tries >= 3 && tries < 12, 'stopped before the claim ended');
});

test('an order whose deposit never lands is proved but never claimed (a claim costs gas); one proof at a time; it is claimed once the deposit is pending', async () => {
  let deposit = 0;
  const r = rig({ orders: [mk('0xj'), mk('0xk')], deposit: 0 });
  const s = makeMarketSolver({ me: ME, now: () => 2_000_000, listOrders: async () => [mk('0xj'), mk('0xk')], done: async () => false, claimOf: async () => null,
    depositStatus: async () => deposit, claim: async (o) => { r.calls.push(['claim', o.intent.opId]); return '0xc'; }, prove: async (o) => { r.calls.push(['prove', o.intent.opId]); await new Promise((x) => setTimeout(x, 5)); return { proof: '0x' }; },
    fulfil: async () => '0xf', clear: async () => {} });
  r.calls.length = 0;
  assert.equal(await s.pass(), false);
  assert.equal(s.hasOpen(), true, 'an order waiting on its deposit keeps the relay looking every few seconds');
  assert.deepEqual(r.calls, [['prove', '0xj']], 'proving starts at once, for one order only');
  assert.equal(await s.pass(), false, 'no deposit, no claim');
  assert.ok(!r.calls.some((c) => c[0] === 'claim'));
  deposit = 1;
  // the claim now checks the live holder; make claimOf report us after the claim
  assert.equal(await s.pass().catch(() => 'threw'), true);
  assert.ok(r.calls.some((c) => c[0] === 'claim' && c[1] === '0xj'), 'claimed once the deposit was pending');
});

test('the least price can be a function (the relay prices gas and proving each pass): an order under it is left, one over it is taken, and a pricing failure takes nothing', async () => {
  const mk2 = (floor) => makeMarketSolver({ me: ME, now: () => 2_000_000, depositStatus: async () => 1, minPrice: async () => floor, listOrders: async () => [mk('0xm', { floorFee: '1000', maxFee: '5000', rampSecs: '60', start: '1990' })],
    done: async () => false, claimOf: async () => null, claim: async () => '0xc', prove: async () => ({ proof: '0x' }), fulfil: async () => '0xf', clear: async () => {} });
  assert.equal(await mk2(9000n).pass(), false, 'above anything the order can pay');
  assert.equal(await mk2(1500n).pass(), true, 'under what the price will be by the time the claim lands');
  const broken = makeMarketSolver({ me: ME, now: () => 2_000_000, depositStatus: async () => 1, minPrice: async () => { throw new Error('no TAC quote'); }, listOrders: async () => [mk('0xn')],
    done: async () => false, claimOf: async () => null, claim: async () => { throw new Error('must not claim'); }, prove: async () => ({}), fulfil: async () => {}, clear: async () => {} });
  assert.equal(await broken.pass(), false);
});
