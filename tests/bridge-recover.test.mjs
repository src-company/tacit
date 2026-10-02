// dapp/bridge-recover.js: a claim to recover a bridge that did not complete is accepted only for that bridge's own
// holder, for the exact amount its burned note carried, and only when the reflection passed the burn without
// recording it.
import { test } from 'node:test';
import assert from 'node:assert';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 } from '../node_modules/@noble/hashes/sha2.js';
import { ripemd160 } from '../node_modules/@noble/hashes/legacy.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { signSchnorr, verifySchnorr } from '../dapp/bulletproofs.js';
import { makeBridgeRecover } from '../dapp/bridge-recover.js';

const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(sha256, key, _cat(m));
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const hex = (b) => Buffer.from(b).toString('hex');

const WALLET = new Uint8Array(32).fill(0x31), OTHER = new Uint8Array(32).fill(0x32);
const AMOUNT = 10000000000n, BLINDING = 0x1234567890abcdefn;          // 100 TAC
const BURN = 'b1'.repeat(32), HOME = 'c2'.repeat(32), FUND = 'd3'.repeat(32);
const DEST = '0x' + 'ee'.repeat(32);

function world({ height = 900, payer = WALLET } = {}) {
  const r = makeBridgeRecover({ secp, sha256, ripemd160, pool, classifyConfidentialTx: (h) => kinds[h.replace(/^0x/, '')] || null, signSchnorr, verifySchnorr, tacAssetId: TAC, fromHeight: 500 });
  const c = pool.commitXY(AMOUNT, '0x' + BLINDING.toString(16).padStart(64, '0'));
  const compressed = (BigInt(c.cy) % 2n === 0n ? '02' : '03') + c.cx.replace(/^0x/, '').padStart(64, '0');
  const kinds = {
    burnhex: { type: 'burn', assetId: TAC, dest: DEST, nullifier: '0x' + '11'.repeat(32), target: '0x' + '22'.repeat(32) },
    homehex: { type: 'cxfer', assetId: TAC, vouts: [0, 1], commitments: [compressed, '02' + '33'.repeat(32)] },
  };
  const payerSpk = r.ownerScript(hex(secp.getPublicKey(payer, true)));
  const txs = {
    [BURN]: { status: { confirmed: true, block_height: height }, vin: [{ txid: HOME, vout: 0, prevout: { scriptpubkey: '5120' + '44'.repeat(32) } }, { txid: FUND, vout: 1, prevout: { scriptpubkey: payerSpk, scriptpubkey_address: 'bc1qholder' } }] },
    [HOME]: { status: { confirmed: true, block_height: height - 50 }, vin: [{ txid: 'aa'.repeat(32), vout: 0, prevout: { scriptpubkey: payerSpk, scriptpubkey_address: 'bc1qholder' } }] },
  };
  const chain = { getTx: async (t) => txs[t] || null, getTxHex: async (t) => (t === BURN ? 'burnhex' : t === HOME ? 'homehex' : '') };
  const state = { height: 1000, dests: new Set(), pending: new Set() };
  return { r, chain, state };
}

test('the holder recovers the exact amount of a burn the reflection passed without recording', async () => {
  const { r, chain, state } = world();
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: WALLET });
  const v = await r.verifyClaim(claim, { ...chain, state });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.amount, AMOUNT);
  assert.equal(v.address, 'bc1qholder');
  assert.equal(v.pubkey, hex(secp.getPublicKey(WALLET, true)));
});

test('a different amount does not open the burned note', async () => {
  const { r, chain, state } = world();
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT + 1n, blinding: BLINDING, walletPriv: WALLET });
  assert.match((await r.verifyClaim(claim, { ...chain, state })).reason, /do not open/);
});

test('another key cannot claim it, even with the opening', async () => {
  const { r, chain, state } = world();
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: OTHER });
  assert.match((await r.verifyClaim(claim, { ...chain, state })).reason, /did not make/);
});

test('a claim whose signature does not match is refused', async () => {
  const { r, chain, state } = world();
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: WALLET });
  claim.sig = claim.sig.slice(0, -2) + (claim.sig.endsWith('00') ? '01' : '00');
  assert.match((await r.verifyClaim(claim, { ...chain, state })).reason, /signature/);
  const other = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: WALLET });
  other.amount = (AMOUNT * 2n).toString();
  assert.match((await r.verifyClaim(other, { ...chain, state })).reason, /signature/, 'the amount is part of what is signed');
});

test('a completed, pending, or not yet passed bridge is not recoverable', async () => {
  const { r, chain, state } = world();
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: WALLET });
  assert.match((await r.verifyClaim(claim, { ...chain, state: { ...state, dests: new Set([DEST]) } })).reason, /completed/);
  const key = String(pool.outpointKey('0x' + HOME.match(/../g).reverse().join(''), 0)).toLowerCase();
  assert.match((await r.verifyClaim(claim, { ...chain, state: { ...state, pending: new Set([key]) } })).reason, /pending/);
  const later = world({ height: 1001 });
  assert.match((await later.r.verifyClaim(claim, { ...later.chain, state: later.state })).reason, /not yet passed/);
});

test('amounts above the per-note cap are refused before anything is fetched', async () => {
  const { r, state } = world();
  const claim = r.buildClaim({ burnTxid: BURN, amount: 100000000001n, blinding: BLINDING, walletPriv: WALLET });
  let fetched = false;
  const v = await r.verifyClaim(claim, { getTx: async () => { fetched = true; return null; }, getTxHex: async () => '', state });
  assert.match(v.reason, /out of range/);
  assert.equal(fetched, false);
});

test('a burn from before the in-app bridge is not recoverable here', async () => {
  const { r, chain, state } = world({ height: 499 });
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: WALLET });
  assert.match((await r.verifyClaim(claim, { ...chain, state })).reason, /predates/);
});
