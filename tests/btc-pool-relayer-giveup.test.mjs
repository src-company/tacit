// A carrier that never reaches the chain must hand its payloads back and free its coins.
//
// `dropAfterMs` is measured from broadcastAt, so it never applied to a carrier that failed before
// broadcasting: those were retried every tick forever while holding their bind. On a wallet with few coins
// that is terminal — each stuck carrier holds one, and once none is free every quote is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayer } from '../worker-relay/src/lib/btc-pool-relayer.js';

const GIVE_UP_MS = 4 * 60_000;
const BIND = { txid: 'a'.repeat(64), vout: 0 };
const ROOT = '0x' + 'ab'.repeat(32);

// Enough of the world to construct a relayer; the test never lets it reach the chain.
function makeRelayer(clock) {
  return createRelayer({
    network: 'signet',
    btcKey: new Uint8Array(32).fill(0x11),
    poolSeed: new Uint8Array(32).fill(0x22),
    fees: {},
    pool: { tip: () => 100, rootAt: () => ROOT, isSpent: () => false, chainTip: () => 100 },
    verifier: { enabled: false, verify: async () => true },
    // No coins to fund a carrier, and nothing the relayer signs can reach the chain: exactly the state the
    // give-up exists for. Without it both carriers below retry every tick forever holding their bind.
    chain: {
      utxos: async () => [],
      feeRate: async () => 1,
      broadcast: async () => { throw new Error('no route to a node'); },
      txStatus: async () => null,
    },
    buildGiveUpMs: GIVE_UP_MS,
    now: () => clock.t,
  });
}

// A carrier wedged in `state`, holding BIND, with one payload still carried.
function wedge(r, clock, state) {
  // hAnchor well inside the window, so `stillValid` keeps the payload and the carrier is stuck on funding
  // and broadcast alone — not on an expiry that would have released it anyway.
  const p = { id: 'p1', state: 'carried', nullifiers: ['nf1'], hAnchor: 95, root: ROOT, updatedAt: clock.t, receivedAt: clock.t };
  const c = { id: 'c1', slots: 1, payloads: [p], bind: BIND, state, createdAt: clock.t, utxos: ['b'.repeat(64) + ':1'] };
  r._state.payloads.set(p.id, p);
  r._state.holds.set('nf1', p.id);
  r._state.carriers.push(c);
  r._state.reservedUtxos.add(`${BIND.txid}:${BIND.vout}`);
  r._state.reservedUtxos.add('b'.repeat(64) + ':1');
  return { p, c };
}

for (const state of ['building', 'signed']) {
  test(`a '${state}' carrier is given up on, and its coins come back`, async () => {
    const clock = { t: 1_000_000 };
    const r = makeRelayer(clock);
    const { p, c } = wedge(r, clock, state);

    clock.t += GIVE_UP_MS - 1000;          // still inside its patience
    await r.tick();
    assert.equal(p.state, 'carried', 'released too early');
    assert.equal(c.state, state, 'gave up too early');
    assert.ok(r._state.reservedUtxos.has(`${BIND.txid}:${BIND.vout}`), 'bind freed too early');

    clock.t += 2000;                        // now past it
    await r.tick();
    assert.equal(p.state, 'dropped', 'payload was not handed back');
    assert.match(p.reason || '', /never broadcast/, 'no reason given to the client');
    assert.equal(c.state, 'dropped', 'carrier not retired');
    assert.ok(!r._state.reservedUtxos.has(`${BIND.txid}:${BIND.vout}`), 'bind still reserved — the wedge');
    assert.ok(!r._state.reservedUtxos.has('b'.repeat(64) + ':1'), 'picked coin still reserved');
    assert.ok(!r._state.holds.has('nf1'), 'nullifier hold not cleared, so a retry would be refused');
  });
}

test('a broadcast carrier is left alone — it has its own give-up', async () => {
  const clock = { t: 1_000_000 };
  const r = makeRelayer(clock);
  const { p, c } = wedge(r, clock, 'broadcast');
  c.broadcastAt = clock.t;
  c.revealTxid = 'c'.repeat(64);
  clock.t += GIVE_UP_MS * 3;
  await r.tick();
  assert.equal(c.state, 'broadcast', 'broadcast carrier must not use the unbroadcast give-up');
  assert.equal(p.state, 'carried');
});

// A quote is the last moment a refusal is free: nothing has been proved yet, so the wallet just funds the
// spend itself. Once a payload is handed across, the same refusal costs a proof.
const ASSET = '0x' + 'cd'.repeat(32);

function relayerWithCoins(coins) {
  const clock = { t: 1_000_000 };
  return createRelayer({
    network: 'signet',
    btcKey: new Uint8Array(32).fill(0x11),
    poolSeed: new Uint8Array(32).fill(0x22),
    fees: { [ASSET.slice(2)]: 10n },
    pool: { tip: () => 100, rootAt: () => ROOT, isSpent: () => false, chainTip: () => 100 },
    verifier: { enabled: false, verify: async () => true },
    chain: {
      utxos: async () => coins.map((v, i) => ({ txid: String(i).repeat(64).slice(0, 64), vout: 0, value: v, status: { confirmed: true } })),
      feeRate: async () => 1,
      broadcast: async () => { throw new Error('offline'); },
      txStatus: async () => null,
    },
    now: () => clock.t,
  });
}

test('a relayer that cannot fund a carrier refuses the quote instead of taking the job', async () => {
  const r = relayerWithCoins([5000]);                      // one coin: it can bind, nothing left to fund
  await assert.rejects(() => r.quote({ asset: ASSET }), /cannot fund a carrier/);
});

test('the coins the live relayer holds still get a quote', async () => {
  const r = relayerWithCoins([13193, 1438]);               // binds the 1438, funds from the 13193
  const q = await r.quote({ asset: ASSET });
  assert.ok(q.quoteId, 'no quote issued');
  assert.equal(q.bind.vout, 0);
});

// ── cost-linked fees ────────────────────────────────────────────────────────
// The fee is a note in the carrier, so its value is hidden and may track cost without leaking anything.
// What moves is the cost: the fee rate runs to 50 sat/vB while a flat fee never changed.
import { parseFeeUnitsPerSat, parseFees } from '../worker-relay/src/lib/btc-pool-relayer.js';

function feeRelayer({ rate, unitsPerSat, min = 10n, vb = 2000 }) {
  return createRelayer({
    network: 'signet',
    btcKey: new Uint8Array(32).fill(0x11),
    poolSeed: new Uint8Array(32).fill(0x22),
    fees: { [ASSET.slice(2)]: min },
    ...(unitsPerSat ? { feeUnitsPerSat: { [ASSET.slice(2)]: unitsPerSat } } : {}),
    soloCarrierVb: vb,
    pool: { tip: () => 100, rootAt: () => ROOT, isSpent: () => false, chainTip: () => 100 },
    verifier: { enabled: false, verify: async () => true },
    chain: {
      utxos: async () => [40000, 40000].map((v, i) => ({ txid: String(i + 4).repeat(64).slice(0, 64), vout: 0, value: v, status: { confirmed: true } })),
      feeRate: async () => rate,
      broadcast: async () => { throw new Error('offline'); },
      txStatus: async () => null,
    },
  });
}

test('an asset with no price keeps its flat fee however gas moves', async () => {
  const cheap = await feeRelayer({ rate: 1 }).quote({ asset: ASSET });
  const dear = await feeRelayer({ rate: 50 }).quote({ asset: ASSET });
  assert.equal(cheap.fee, '10');
  assert.equal(dear.fee, '10', 'a flat fee must not start moving on its own');
});

test('a priced asset tracks the carrier cost, and never dips under its floor', async () => {
  // 1 unit per sat (a BTC-denominated asset): the fee IS the sats the carrier will cost, plus margin.
  const at1 = await feeRelayer({ rate: 1, unitsPerSat: 1n, vb: 2000 }).quote({ asset: ASSET });
  const at50 = await feeRelayer({ rate: 50, unitsPerSat: 1n, vb: 2000 }).quote({ asset: ASSET });
  assert.equal(at1.fee, String(Math.ceil(2000 * 1 * 1.35)));
  assert.equal(at50.fee, String(Math.ceil(2000 * 50 * 1.35)));
  assert.ok(BigInt(at50.fee) > BigInt(at1.fee) * 40n, 'a 50x cost must move the fee');
  // Below the floor the floor wins.
  const tiny = await feeRelayer({ rate: 1, unitsPerSat: 1n, vb: 1, min: 999999n }).quote({ asset: ASSET });
  assert.equal(tiny.fee, '999999');
});

test('the price field is optional, per asset', () => {
  const both = 'aa'.repeat(32) + ':15,' + 'bb'.repeat(32) + ':20:558659';
  assert.equal(parseFees(both).size, 2, 'both assets still have a fee');
  const rates = parseFeeUnitsPerSat(both);
  assert.equal(rates.size, 1, 'only the asset that gave a price has one');
  assert.equal(rates.get('bb'.repeat(32)), 558659n);
});

test('a priced asset still quotes when the fee rate cannot be read', async () => {
  const r = createRelayer({
    network: 'signet',
    btcKey: new Uint8Array(32).fill(0x11),
    poolSeed: new Uint8Array(32).fill(0x22),
    fees: { [ASSET.slice(2)]: 10n },
    feeUnitsPerSat: { [ASSET.slice(2)]: 1n },
    pool: { tip: () => 100, rootAt: () => ROOT, isSpent: () => false, chainTip: () => 100 },
    verifier: { enabled: false, verify: async () => true },
    chain: {
      utxos: async () => [40000, 40000].map((v, i) => ({ txid: String(i + 6).repeat(64).slice(0, 64), vout: 0, value: v, status: { confirmed: true } })),
      feeRate: async () => { throw new Error('every esplora refused'); },
      broadcast: async () => { throw new Error('offline'); },
      txStatus: async () => null,
    },
  });
  const q = await r.quote({ asset: ASSET });
  assert.equal(q.fee, '10', 'an unreadable rate must fall back to the floor, not refuse the quote');
});

// ── fee rate: one base must not set the price ───────────────────────────────
import { makeEsploraRelayChain } from '../worker-relay/src/lib/btc-pool-relayer.js';

const rateChain = (answers) => makeEsploraRelayChain(answers.map((_, i) => `https://b${i}`), {
  fetchImpl: async (url) => {
    const i = Number(/^https:\/\/b(\d+)/.exec(url)[1]);
    const v = answers[i];
    if (v == null) throw new Error('down');
    return { ok: true, text: async () => JSON.stringify({ 3: v, 6: v }) };
  },
});

test('the fee rate is the median, so one outlier cannot set it', async () => {
  // The real spread seen on mainnet: three bases near 1.1, one at 2.29.
  assert.equal(await rateChain([1.067, 1.08, 1.133, 2.292]).feeRate(), (1.08 + 1.133) / 2);
  assert.equal(await rateChain([1.067, 1.08, 2.292]).feeRate(), 1.08, 'odd count takes the middle');
  // An outlier first in the list no longer decides it.
  assert.equal(await rateChain([9.9, 1.0, 1.1]).feeRate(), 1.1);
});

test('bases that are down do not vote, and all of them down is an error not a guess', async () => {
  assert.equal(await rateChain([null, 2, null]).feeRate(), 2);
  await assert.rejects(() => rateChain([null, null]).feeRate(), /no base answered/);
});

// ── change is split back into working coins ─────────────────────────────────
import { planChangeOutputs } from '../worker-relay/src/lib/btc-pool-relayer.js';

const DUST = 546;
const plan = (o) => planChangeOutputs({ rate: 2, dust: DUST, survive: 0, ...o });

test('change splits into coins the relayer can actually work with', () => {
  const parts = plan({ change: 80000 });
  assert.ok(parts.length > 1, 'a large change should not come back as one coin');
  assert.ok(parts.every((v) => v >= 12000), 'every piece must be worth binding');
});

test('the split never spends more than the change it was given', () => {
  // The extra outputs are paid for out of the change, so parts + their fee must equal it exactly.
  for (const change of [600, 1000, 5000, 12545, 24999, 25000, 60000, 130000, 999999]) {
    for (const rate of [1, 2, 13.7, 50]) {
      const parts = planChangeOutputs({ change, rate, dust: DUST, survive: 0 });
      const sum = parts.reduce((a, v) => a + v, 0);
      const extraFee = Math.ceil(31 * Math.max(0, parts.length - 1) * rate);
      assert.equal(sum + extraFee, parts.length ? change : 0,
        `change ${change} at ${rate} sat/vB: parts ${JSON.stringify(parts)} do not add up`);
      assert.ok(parts.every((v) => v >= DUST), `change ${change} at ${rate} produced dust`);
      assert.ok(sum <= change, 'never pays out more than the change');
    }
  }
});

test('it does not split when splitting would make coins too small, or when there are already enough', () => {
  assert.deepEqual(plan({ change: 20000 }), [20000], 'two 10k coins are under the target, so keep one');
  assert.deepEqual(plan({ change: 900 }), [900], 'small change stays whole');
  assert.deepEqual(plan({ change: 100 }), [], 'below dust there is no output at all');
  assert.deepEqual(plan({ change: 200000, survive: 9 }), [200000], 'already has plenty of coins');
});

test('it aims at the gap, not at a fixed number of pieces', () => {
  const none = plan({ change: 200000, survive: 0 }).length;
  const some = plan({ change: 200000, survive: 4 }).length;
  assert.ok(none > some, 'fewer coins on hand should mean more pieces');
  assert.ok(none <= 4, 'and never more than maxChangeSplit');
});

test('what info publishes is what a quote charges', async () => {
  // Clients size a spend from info.fees — amount + fee has to come out of the notes they hold — so a floor
  // published against a higher quote hands them an amount their own spend cannot cover.
  const r = feeRelayer({ rate: 3, unitsPerSat: 1n, min: 10n, vb: 2000 });
  const info = await r.info();
  const q = await r.quote({ asset: ASSET });
  assert.equal(info.fees[ASSET], q.fee, 'published fee must be the quoted fee');
  assert.equal(info.feeFloors[ASSET], '10', 'the configured floor is still visible');
  assert.notEqual(info.fees[ASSET], info.feeFloors[ASSET], 'and this case is one where they differ');
});
