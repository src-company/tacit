// Numbered watchtower bid wallets: a key and the chain find every bid wallet. Pins the derivation (distinct
// per index, apart from the older per-bid key), the public-key -> index lookup, the first-unused-wallet
// picker (including two bids placed together), and the scan: it sweeps wallets holding funds, leaves a
// wallet behind a live registration alone, stops after a run of unused wallets, and refuses to run when
// the registration list cannot be read. The network is a mock; the sweep is injected.
//
// Run: `node tests/watchtower-bid-wallets.test.mjs`

import { JSDOM } from 'jsdom';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { bech32 } from '@scure/base';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage; globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator; globalThis.__TACIT_NO_INIT__ = true;
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');
globalThis.__TACIT_WORKER_BASE__ = 'https://worker.test';

// Chain and worker state the mock serves.
const used = new Set();                  // addresses with history
const funded = new Map();                // address -> utxos
let registered = [];                     // watchtower registrations for the owner
let registrationStatus = 200;
let registrationBody = null;             // overrides the body when set

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('https://worker.test/watchtower/bids')) {
    return json(registrationBody ?? { bids: registered }, registrationStatus);
  }
  const m = u.match(/\/address\/([0-9a-z]+)(\/utxo)?(?:\?|$)/);
  if (m) {
    const addr = m[1];
    if (m[2]) return json(funded.get(addr) || []);
    return json({ chain_stats: { tx_count: used.has(addr) ? 1 : 0 }, mempool_stats: { tx_count: 0 } });
  }
  return json({ error: 'not mocked' }, 404);
};

const dapp = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
async function test(label, fn) {
  try { const ok = await fn(); if (ok) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}`); fail++; } }
  catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

const keyOf = (b) => hexToBytes(String(b).repeat(32));
const MAIN = keyOf('31');
const pubHex = (priv) => bytesToHex(secp.getPublicKey(priv, true));
const addrOf = (priv) => bech32.encode('tb', [0, ...bech32.toWords(ripemd160(sha256(secp.getPublicKey(priv, true))))]);
const walletPriv = (main, i) => dapp.deriveWatchtowerBidWalletKey(main, i);
const reset = () => { used.clear(); funded.clear(); registered = []; registrationStatus = 200; registrationBody = null; };
const setMain = (sk) => { dapp.wallet.priv = sk; dapp.wallet.pub = secp.getPublicKey(sk, true); };
const utxo = (n) => [{ txid: 'ab'.repeat(32), vout: n, value: 50000, status: { confirmed: true, block_height: 1 } }];

await test('wallet keys are deterministic, distinct per index, and apart from the per-bid key', () => {
  const a0 = walletPriv(MAIN, 0), a1 = walletPriv(MAIN, 1);
  const legacy = dapp.deriveWatchtowerBidKey(MAIN, 'ab'.repeat(32), 'cd'.repeat(16));
  return bytesToHex(a0) === bytesToHex(walletPriv(MAIN, 0)) && bytesToHex(a0) !== bytesToHex(a1)
    && bytesToHex(a0) !== bytesToHex(legacy) && bytesToHex(walletPriv(keyOf('32'), 0)) !== bytesToHex(a0);
});

await test('a wallet public key maps back to its index; an unrelated key does not', () => {
  const idx = [0, 3, 57].every((i) => dapp.watchtowerBidWalletIndexOf(MAIN, pubHex(walletPriv(MAIN, i))) === i);
  return idx && dapp.watchtowerBidWalletIndexOf(MAIN, pubHex(keyOf('77'))) === -1;
});

await test('the picker returns the first wallet with no history', async () => {
  reset(); setMain(keyOf('41'));
  const sk = dapp.wallet.priv;
  used.add(addrOf(walletPriv(sk, 0))); used.add(addrOf(walletPriv(sk, 1)));
  return (await dapp.nextWatchtowerBidWalletIndex(sk)) === 2;
});

await test('two bids placed together get different wallets', async () => {
  reset(); setMain(keyOf('42'));
  const sk = dapp.wallet.priv;
  const [a, b] = await Promise.all([dapp.nextWatchtowerBidWalletIndex(sk), dapp.nextWatchtowerBidWalletIndex(sk)]);
  return a !== b && Math.min(a, b) === 0;
});

await test('the scan sweeps funded wallets, skips a live bid, and stops after ten unused in a row', async () => {
  reset(); setMain(keyOf('43'));
  const sk = dapp.wallet.priv;
  const A = (i) => addrOf(walletPriv(sk, i));
  used.add(A(0)); funded.set(A(0), utxo(0));       // live registration: left alone
  used.add(A(1)); funded.set(A(1), utxo(1));       // stranded: swept
  used.add(A(2));                                  // swept before: used, empty
  used.add(A(11)); funded.set(A(11), utxo(11));    // after an 8-wallet gap: still found
  used.add(A(30)); funded.set(A(30), utxo(30));    // after a 18-wallet gap: out of reach
  registered = [{ bid_id: 'cd'.repeat(16), bid_pubkey: pubHex(walletPriv(sk, 0)) }];
  const swept = [];
  const r = await dapp.recoverWatchtowerBidWallets({ sweep: async (priv, assets) => { swept.push([bytesToHex(priv), assets]); return { swept: 49000, assets: [{ asset_id: 'ef'.repeat(32), amount: '5' }] }; } });
  const want = [1, 11].map((i) => bytesToHex(walletPriv(sk, i)));
  return JSON.stringify(swept.map((s) => s[0])) === JSON.stringify(want) && swept.every((s) => s[1] === null)
    && r.swept === 98000 && r.assets.length === 2 && r.wallets.map((w) => w.index).join() === '1,11' && r.failed.length === 0;
});

await test('a wallet that cannot be swept is reported and the scan carries on', async () => {
  reset(); setMain(keyOf('44'));
  const sk = dapp.wallet.priv;
  for (const i of [0, 1]) { used.add(addrOf(walletPriv(sk, i))); funded.set(addrOf(walletPriv(sk, i)), utxo(i)); }
  let n = 0;
  const r = await dapp.recoverWatchtowerBidWallets({ sweep: async () => { if (n++ === 0) throw new Error('broadcast rejected'); return { swept: 1000, assets: [] }; } });
  return r.failed.length === 1 && r.failed[0].index === 0 && /rejected/.test(r.failed[0].error) && r.wallets.length === 1 && r.swept === 1000;
});

await test('the scan refuses to run when the registration list cannot be read (nothing swept)', async () => {
  reset(); setMain(keyOf('45'));
  const sk = dapp.wallet.priv;
  used.add(addrOf(walletPriv(sk, 0))); funded.set(addrOf(walletPriv(sk, 0)), utxo(0));
  let swept = 0, msgs = [];
  for (const mode of ['http500', 'notAList']) {
    registrationStatus = mode === 'http500' ? 500 : 200;
    registrationBody = mode === 'http500' ? { error: 'down' } : { ok: true };
    try { await dapp.recoverWatchtowerBidWallets({ sweep: async () => { swept++; return { swept: 1, assets: [] }; } }); msgs.push('ran'); }
    catch (e) { msgs.push(/cannot be told apart/.test(e.message) ? 'refused' : e.message); }
  }
  return swept === 0 && msgs.join() === 'refused,refused';
});

console.log(`\n${pass + fail} tests, ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
