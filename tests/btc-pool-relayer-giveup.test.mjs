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
