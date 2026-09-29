// The wallet's cBTC locks, recovered from its Bitcoin history alone (dapp/confidential-recovery-btc.js locks()).
//   node tests/btc-history-locks.test.mjs
import assert from 'node:assert/strict';
import { sha256 } from '@noble/hashes/sha256';
import { makeBtcHistoryProvider } from '../dapp/confidential-recovery-btc.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const hex = (b) => Buffer.from(b).toString('hex');
const priv = 'c0ffee'.padEnd(64, '1');

// Esplora stub: the lock script's history (newest first, as esplora serves it) and the commit transactions.
function esplora(pages) {
  return async (url) => {
    const path = new URL(url).pathname.replace(/^\/api/, '');
    const body = pages[path];
    return body === undefined ? { ok: false, status: 404 } : { ok: true, json: async () => body };
  };
}

await test('every lock above the dust band comes back oldest first, with its blinding anchor', async () => {
  const probe = makeBtcHistoryProvider({ sha256, fetchImpl: async () => ({ ok: false }) });
  const spk = probe.walletScripts(priv).lock, lock = hex(spk), h = hex(sha256(spk));
  const out = (value) => ({ scriptpubkey: lock, value });
  const other = { scriptpubkey: '0014' + '00'.repeat(20), value: 5000 };
  const txs = [
    { txid: 'b2'.repeat(32), vin: [{ txid: 'c2'.repeat(32), vout: 0 }], vout: [other, out(30000)], status: { block_time: 2000 } },
    { txid: 'd0'.repeat(32), vin: [{ txid: 'c9'.repeat(32), vout: 0 }], vout: [out(330)], status: { block_time: 1500 } },   // a Tacit note, not a lock
    { txid: 'b1'.repeat(32), vin: [{ txid: 'c1'.repeat(32), vout: 0 }], vout: [other, out(20000)], status: { block_time: 1000 } },
  ];
  const p = makeBtcHistoryProvider({
    sha256, bases: ['https://esplora.test/api'],
    fetchImpl: esplora({
      [`/scripthash/${h}/txs`]: txs,
      [`/tx/${'c1'.repeat(32)}`]: { vin: [{ txid: 'a1'.repeat(32), vout: 3 }] },
      [`/tx/${'c2'.repeat(32)}`]: { vin: [{ txid: 'a2'.repeat(32), vout: 1 }] },
    }),
  });
  const locks = await p.locks(priv);
  assert.deepEqual(locks.map((l) => [l.lockTxid.slice(0, 4), l.lockVout, l.vBtc, l.anchor.txid.slice(0, 4), l.anchor.vout]), [
    ['b1b1', 1, '20000', 'a1a1', 3],
    ['b2b2', 1, '30000', 'a2a2', 1],
  ]);
  assert.equal(locks[0].at, 1_000_000);
});

await test('a key with no locks has none', async () => {
  const probe = makeBtcHistoryProvider({ sha256, fetchImpl: async () => ({ ok: false }) });
  const h = hex(sha256(probe.walletScripts(priv).lock));
  const p = makeBtcHistoryProvider({ sha256, bases: ['https://esplora.test/api'], fetchImpl: esplora({ [`/scripthash/${h}/txs`]: [] }) });
  assert.deepEqual(await p.locks(priv), []);
});

console.log(`${n} passed`);
