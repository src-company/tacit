#!/usr/bin/env node
// A variable-fill bid whose partial claims have lapsed is claimable again, and the bid
// list and the claim endpoint agree on it. Also: bids a watchtower settles are flagged.
// Drives the real worker fetch handler over the Node server's in-memory KV.
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { createMemDriver } from '../server/driver-mem.mjs';
import { createCacheStorage } from '../server/cache-mem.mjs';
import { buildEnv, createCtxFactory } from '../server/harness.mjs';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
// BIP-340 signing (deterministic, zero aux) — what the dapp's signSchnorr produces.
const N = secp.CURVE.n;
const big = (b) => BigInt('0x' + bytesToHex(b));
const b32 = (n) => hexToBytes(n.toString(16).padStart(64, '0'));
const tagged = (tag, ...parts) => { const t = sha256(new TextEncoder().encode(tag)); return sha256(secp.etc.concatBytes(t, t, ...parts)); };
function signSchnorr(msg, priv) {
  const P = secp.ProjectivePoint.BASE.multiply(big(priv)).toAffine();
  const d = P.y % 2n === 0n ? big(priv) : N - big(priv);
  const px = b32(P.x);
  const t = b32(d ^ big(tagged('BIP0340/aux', new Uint8Array(32))));
  const k0 = big(tagged('BIP0340/nonce', t, px, msg)) % N;
  const R = secp.ProjectivePoint.BASE.multiply(k0).toAffine();
  const k = R.y % 2n === 0n ? k0 : N - k0;
  const e = big(tagged('BIP0340/challenge', b32(R.x), px, msg)) % N;
  return secp.etc.concatBytes(b32(R.x), b32((k + e * d) % N));
}
const freshCache = () => { globalThis.caches = createCacheStorage({ maxBytes: 8 * 1024 * 1024 }); };
freshCache();
const worker = (await import('../worker/src/index.js')).default;
const { bidClaimMsg } = await import('../worker/src/index.js');
const env = buildEnv(createMemDriver());
const ctx = createCtxFactory().makeCtx();
const KV = env.REGISTRY_KV;

let pass = 0, fail = 0;
const ok = (label, cond, hint = '') => { if (cond) { pass++; console.log('  PASS ', label); } else { fail++; console.log('  FAIL ', label, hint); } };

const AID = 'ab'.repeat(32);
const BID = 'cd'.repeat(16);
const now = Math.floor(Date.now() / 1000);
const buyerPriv = hexToBytes('31'.repeat(32));
const buyerPub = bytesToHex(secp.getPublicKey(buyerPriv, true));
const sellerPriv = hexToBytes('42'.repeat(32));
const sellerPub = bytesToHex(secp.getPublicKey(sellerPriv, true));
const h160 = (hex) => bytesToHex(ripemd160(sha256(hexToBytes(hex))));

// A bid for 1,000 units at 50,000 sats; min fill 100. Its last claim (for all of it)
// lapsed, but the stored record still says CLOSED / remaining 0.
await KV.put(`bidintent:${AID}:${BID}`, JSON.stringify({
  asset_id: AID, bid_id: BID, buyer_pubkey: buyerPub, amount: '1000', price_sats: 50000,
  min_fill_amount: '100', remaining_amount: '0', settled_amount: '0', state: 'CLOSED',
  expiry: now + 86400, created_at: now - 3600, network: 'signet', linked_axintents: ['ee'.repeat(16)],
}));
await KV.put(`bidpclaim:${AID}:${BID}:${'ee'.repeat(16)}`, JSON.stringify({
  bid_id: BID, axintent_id: 'ee'.repeat(16), fill_amount: '1000', expires_at: now - 60,
}));

const get = async (path) => {
  const r = await worker.fetch(new Request(`http://api.local${path}${path.includes('?') ? '&' : '?'}network=signet`), env, ctx);
  return { status: r.status, j: await r.json().catch(() => null) };
};
const post = async (path, body) => {
  const r = await worker.fetch(new Request(`http://api.local${path}?network=signet`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, body: JSON.stringify(body),
  }), env, ctx);
  return { status: r.status, j: await r.json().catch(() => null) };
};

let l = await get(`/assets/${AID}/bid-intents`);
let b = l.j?.intents?.[0];
ok('list: lapsed claims leave the bid claimable (remaining 1000)', b?.remaining_amount === '1000', JSON.stringify(b));
ok('list: state follows the projection (OPEN, not CLOSED)', b?.state === 'OPEN', b?.state);
ok('list: no watchtower flag without a registration', !b?.watchtower);

await KV.put(`wtbid:signet:${h160(buyerPub)}:${BID}`, JSON.stringify({ status: 'active', expiry: now + 86400, bid_id: BID }));
// The list is served through a short read cache.
freshCache();
l = await get(`/assets/${AID}/bid-intents`);
ok('list: watchtower-registered bid is flagged', l.j?.intents?.[0]?.watchtower === true, JSON.stringify(l.j?.intents?.[0]));

async function claim(axId, fill, price) {
  await KV.put(`axintent:${AID}:${axId}`, JSON.stringify({
    asset_id: AID, intent_id: axId, maker_pubkey: sellerPub, amount: String(fill), price_sats: price,
    expiry: now + 86400, created_at: now,
  }));
  const sig = signSchnorr(bidClaimMsg(AID, BID, sellerPub, axId, String(fill)), sellerPriv);
  return post(`/assets/${AID}/bid-intents/${BID}/claim`, {
    seller_pubkey: sellerPub, axintent_id: axId, fill_amount: String(fill), sig: bytesToHex(sig),
  });
}

const c1 = await claim('a1'.repeat(16), 600, 30000);
ok('claim: a fill against the lapsed capacity is accepted', c1.status === 200, JSON.stringify(c1));
const c2 = await claim('a2'.repeat(16), 500, 25000);
ok('claim: a fill beyond what is still free is refused (409)', c2.status === 409, JSON.stringify(c2));
const c3 = await claim('a3'.repeat(16), 400, 20000);
ok('claim: the exact remainder is accepted', c3.status === 200, JSON.stringify(c3));
freshCache();
l = await get(`/assets/${AID}/bid-intents`);
b = l.j?.intents?.[0];
ok('list: fully reserved again reads CLOSED with remaining 0', b?.state === 'CLOSED' && b?.remaining_amount === '0', JSON.stringify({ s: b?.state, r: b?.remaining_amount }));

console.log(`\nworker bid-claim projection: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
