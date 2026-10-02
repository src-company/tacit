// A Bitcoin-pool exit to the wallet's own address (pay#tac "Take out", /tac Withdraw) through the real holdings scan
// (dapp/tacit.js) and seed recovery (dapp/sats/secret.js recoverExitOpenings), with the chain and the mainnet pool
// service mocked: a recorded exit with no opening is a ghost, never plain sats; seed recovery and a recorded opening
// both credit it; a carrier the replay has not reached is unverified; a refused one is not credited.
//   node tests/btc-pool-exit-holdings.test.mjs

import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const dom = new JSDOM('', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, location: dom.window.location, __TACIT_NO_INIT__: true });
if (!globalThis.navigator) globalThis.navigator = dom.window.navigator;
localStorage.setItem('tacit-network-v1', 'mainnet');

const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const routes = new Map();   // url substring -> () => body
const seen = [];
globalThis.fetch = async (input) => {
  const url = String(input?.url ?? input);
  seen.push(url);
  for (const [k, f] of routes) if (url.includes(k)) { const b = f(url); return new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
  throw new Error('offline: ' + url);
};

const T = await import('../dapp/tacit.js');
const S = await import('../dapp/sats/secret.js');
const { secp } = await import('../dapp/vendor/tacit-deps.min.js');
const hex = (b) => Buffer.from(b).toString('hex');

const priv = new Uint8Array(randomBytes(32));
T.wallet.priv = priv; T.wallet.pub = secp.getPublicKey(priv, true);
const addr = T.wallet.address();
const own = T.p2wpkhScript(T.wallet.pub);
const pw = S.poolWalletFor(priv, 'mainnet');
const pool = S.pool;

// One 1000-unit TAC note of the pool wallet, spent: 400 exits to `own` at vout 0, 600 is internal change.
const n0 = pool.createNote(pw.addressString, '0x' + TAC, 1000n, { network: 'mainnet' });
const feed = [{ leafIndex: 0, txid: 'ab'.repeat(32), height: 899000, leaf: n0.leaf, asset: '0x' + TAC, pkEph: n0.pkEph, ctNote: n0.ctNote }];
const mine = pool.scan(pw, feed);
assert.equal(mine.length, 1, 'pool wallet scans its note');
const self = { address: pw.internalAddress, network: 'mainnet' };
const built = pool.buildSpendBody({
  asset: '0x' + TAC, hAnchor: 899000, inputs: mine, network: 'mainnet',
  outputs: [{ ...self, value: 600n }, { ...self, value: 0n }, { ...self, value: 0n }],
  exit: { exitVout: 0, scriptPubKey: '0x' + hex(own), value: 400n },
});
const payload = pool.assembleSpendEnvelope(built.body, new Uint8Array(64).fill(7));
const script = T.encodeEnvelopeScript(T.wallet.xonly(), payload);
const X = 'cd'.repeat(32);
const confirmedAt = Math.floor(Date.now() / 1000) - 6 * 3600;   // old enough that a refusal reads as invalid
const tx = {
  txid: X, version: 2, locktime: 0,
  vin: [{ txid: 'ef'.repeat(32), vout: 0, witness: ['00'.repeat(64), hex(script), 'c0' + '11'.repeat(32)], prevout: { scriptpubkey_type: 'v1_p2tr', value: 2000 } }],
  vout: [{ scriptpubkey: hex(own), scriptpubkey_type: 'v0_p2wpkh', scriptpubkey_address: addr, value: 546 }],
  status: { confirmed: true, block_height: 900000, block_time: confirmedAt },
};
const utxo = { txid: X, vout: 0, value: 546, status: tx.status };
routes.set(`/address/${addr}/utxo`, () => [utxo]);
routes.set(`/tx/${X}/outspend`, () => ({ spent: false }));
routes.set(`/tx/${X}`, () => tx);
let exitRecord;
routes.set(`tacit-btc-pool-mainnet.onrender.com/btc-pool/exit/${X}/0`, () => exitRecord);

const scan = async () => { T.invalidateHoldingsCache(); T.clearBtcPoolExitCache(); T.clearValidatorCaches(); return (await T.scanHoldings(true)).get(TAC); };

// 1. Recorded exit, no opening in this browser: a ghost, not plain sats, not balance.
exitRecord = { exists: true, txid: X, vout: 0, height: 900010, asset: '0x' + TAC, Cx: built.exit.cx, Cy: built.exit.cy };
let h = await scan();
assert.ok(h, 'TAC holding exists');
assert.equal(h.balance, 0n);
assert.deepEqual(h.ghosts.map((g) => `${g.utxo.txid}:${g.utxo.vout}`), [`${X}:0`], 'exit sits in ghosts');
assert.ok(seen.some((u) => u.startsWith('https://tacit-btc-pool-mainnet.onrender.com/btc-pool/exit/')), 'default mainnet pool host consulted');
assert.equal(T.selectSatsUtxosSafe([utxo], new Map([[TAC, h]])).length, 0, 'never spendable as sats');
console.log('ok 1 - recorded exit without an opening is a ghost');

// 2. Recovery from the pool seed records the opening; the scan credits 400.
const notesWithSpent = mine.map((x) => ({ ...x, spent: true }));
const n = await S.recoverExitOpenings(T, { poolWallet: pw, asset: S.TAC_ASSET_MAINNET, utxos: h.ghosts.map((g) => g.utxo), notes: notesWithSpent });
assert.equal(n, 1, 'one opening recovered');
h = await scan();
assert.equal(h.balance, 400n, 'credited after recovery');
assert.equal(h.utxos.length, 1); assert.equal(h.utxos[0].amount, 400n); assert.equal(h.ghosts.length, 0);
console.log('ok 2 - seed recovery credits the exit (400)');

// 3. The opening exitToWallet records (its blinding as returned) credits the same way.
localStorage.clear(); localStorage.setItem('tacit-network-v1', 'mainnet');
T.recordOpening(X, 0, TAC, 400n, BigInt(built.exit.blinding));
h = await scan();
assert.equal(h.balance, 400n, 'credited from the recorded opening');
console.log('ok 3 - recorded opening credits the exit');

// 4. A second carrier, above the replay's height: undecided, so unverified, never inflated.
const Y = 'ce'.repeat(32), utxoY = { ...utxo, txid: Y };
routes.set(`/address/${addr}/utxo`, () => [utxoY]);
routes.set(`/tx/${Y}/outspend`, () => ({ spent: false }));
routes.set(`/tx/${Y}`, () => ({ ...tx, txid: Y }));
routes.set(`tacit-btc-pool-mainnet.onrender.com/btc-pool/exit/${Y}/0`, () => exitRecord);
exitRecord = { exists: false, height: 899999 };
h = await scan();
assert.equal(h.balance, 0n); assert.equal(h.inflated.length, 0); assert.equal(h.unverified.length, 1);
console.log('ok 4 - an exit the replay has not reached is unverified');

// 5. Replayed past it with no record: refused, so not credited (inflated after the fresh window).
exitRecord = { exists: false, height: 900010 };
h = await scan();
assert.equal(h.balance, 0n); assert.equal(h.utxos.length, 0); assert.equal(h.inflated.length, 1);
console.log('ok 5 - a refused exit is not credited');

console.log('done');
process.exit(0);
