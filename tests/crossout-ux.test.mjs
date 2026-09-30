#!/usr/bin/env node
// dapp/crossout-ux.js: the cross-out bridge (Ethereum -> Bitcoin) state machine. Drives a full
// settled -> covered -> mint-signed -> mint-submitted -> minted cycle against real cryptography (real
// secp256k1 signing via dapp/bitcoin-taproot-wallet.js, real envelope construction via
// dapp/crossout-mint-reveal.js) with the network layer (crossOut's relay dispatch, eth-state coverage,
// chain broadcast/UTXO selection) stubbed by an in-memory "world" the test controls.
//
// Run: node tests/crossout-ux.test.mjs
import assert from 'node:assert';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';

// dapp/bitcoin-taproot-wallet.js (imported transitively by crossout-ux.js) pulls in the vendor bundle
// (poseidon et al.), which expects a browser-like global scope at import time -- same shim
// burndep-ux.test.mjs uses ahead of its own tacit.js import.
const realFetch = globalThis.fetch, realST = globalThis.setTimeout, realCT = globalThis.clearTimeout;
await import('../scratchpad/domshim2.mjs');
globalThis.setTimeout = realST; globalThis.clearTimeout = realCT;

// dapp/bitcoin-taproot-wallet.js imports secp from the vendor bundle, not node_modules directly (all
// third-party JS is vendored -- see dapp/tacit.js's own header comment) -- importing that same instance
// here so the hmacSha256Sync setup below actually lands on the object its signing calls read from. Must be
// dynamic (after the shim above), same reason crossout-ux.js itself is imported dynamically below.
const { secp } = await import('../dapp/vendor/tacit-deps.min.js');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(nobleSha256, k, secp.etc.concatBytes(...m));

const { makeCrossoutUx, CROSSOUT_BETA_CAP_RAW } = await import('../dapp/crossout-ux.js');
globalThis.fetch = realFetch;

let n = 0, failures = 0;
const ok = (c, m) => { if (c) { console.log('  ok -', m); n++; } else { console.error('  FAIL -', m); failures++; } };

const stripHex = (h) => String(h).replace(/^0x/, '');
const withHex = (h) => '0x' + stripHex(h);
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const ASSET = withHex('a5'.repeat(32));
const WALLET_PRIV = new Uint8Array(32).fill(0x33);
const WALLET_PUB = secp.getPublicKey(WALLET_PRIV, true);
const NOTE = { nullifier: withHex('7e'.repeat(32)), value: 900_000n, blinding: 0x1234n, asset: ASSET, confirmed: true };
const FUND_TXID = '61'.repeat(32);
const CLAIM_ID = withHex('c1'.repeat(32));
const CX = withHex('c2'.repeat(32));
const CY = withHex('c3'.repeat(32));

// ---- an in-memory "world": chain state + worker endpoints, driven by this test ----
function makeWorld() {
  const chainTxs = new Map(); // txid(bare) -> {status:{confirmed}}
  const broadcasts = [];
  let ethCovered = false;
  let claimIdVerified = true;
  let claimIdNote = 'corroborated against CrossOutRecorded';

  const fetchImpl = async (url) => {
    const u = new URL(url, 'http://x');
    const p = u.pathname;
    if (p.endsWith('/reflection/eth-state/covers')) {
      return { ok: true, json: async () => ({ covered: ethCovered, block: Number(u.searchParams.get('block')) }) };
    }
    const chainMatch = p.match(/\/chain\/tx\/([0-9a-f]+)$/);
    if (chainMatch) {
      const tx = chainTxs.get(chainMatch[1]);
      if (!tx) return { ok: true, json: async () => ({ error: 'not-found' }) };
      return { ok: true, json: async () => tx };
    }
    throw new Error(`world: unhandled fetch ${p}`);
  };

  const chain = {
    getUtxos: async () => [{ txid: FUND_TXID, vout: 0, value: 50_000 }],
    pickSafeCommitSats: async (utxos) => utxos,
    broadcastWithRetry: async (hex) => { broadcasts.push(hex); return { txid: 'stub' }; },
    getFeeRate: async () => 3,
  };

  async function crossOut({ notes, amount, destOwner }) {
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(amount, notes[0].value);
    return {
      txHash: withHex('aa'.repeat(32)),
      crossOuts: [{ claimId: CLAIM_ID, cx: CX, cy: CY, owner: destOwner, destCommitment: withHex('dd'.repeat(32)) }],
      ethBlock: 12345,
      claimIdVerified, claimIdNote,
    };
  }

  return {
    fetchImpl, chain, crossOut,
    setEthCovered: (v) => { ethCovered = v; },
    setClaimIdVerified: (v, note) => { claimIdVerified = v; claimIdNote = note || claimIdNote; },
    mineRevealTxid: (txid) => chainTxs.set(stripHex(txid), { status: { confirmed: true } }),
    broadcasts,
  };
}

function makeUx(world) {
  return makeCrossoutUx({
    network: 'mainnet', hrp: 'bc', workerBase: 'http://worker', fetchImpl: world.fetchImpl,
    storage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), get length() { return m.size; }, key: (i) => Array.from(m.keys())[i] || null }; })(),
    secp, crossOut: world.crossOut, tacAssetId: ASSET, chain: world.chain,
  });
}

// ---- eligibility ----
{
  const world = makeWorld();
  const ux = makeUx(world);
  const [eligible] = ux.eligibleNotes([NOTE]);
  ok(eligible.eligible === true, 'a confirmed, under-cap TAC note is eligible');

  const [wrongAsset] = ux.eligibleNotes([{ ...NOTE, asset: withHex('ff'.repeat(32)) }]);
  ok(wrongAsset.eligible === false && wrongAsset.reason === 'not TAC', 'a non-TAC note is ineligible');

  const [overCap] = ux.eligibleNotes([{ ...NOTE, value: CROSSOUT_BETA_CAP_RAW + 1n }]);
  ok(overCap.eligible === false && /1,000 TAC beta limit/.test(overCap.reason), 'a note over the 1,000 TAC cap is ineligible, with the cap named in the reason');

  const [atCap] = ux.eligibleNotes([{ ...NOTE, value: CROSSOUT_BETA_CAP_RAW }]);
  ok(atCap.eligible === true, 'a note exactly at the cap is eligible (cap is inclusive)');

  const [unconfirmed] = ux.eligibleNotes([{ ...NOTE, confirmed: false }]);
  ok(unconfirmed.eligible === false && unconfirmed.reason === 'unconfirmed', 'an unconfirmed note is ineligible');
}

// ---- start() rejects over-cap before ever calling crossOut ----
{
  const world = makeWorld();
  const ux = makeUx(world);
  let threw = false;
  try { await ux.start({ note: { ...NOTE, value: CROSSOUT_BETA_CAP_RAW + 1n }, walletPriv: WALLET_PRIV }); }
  catch (e) { threw = /beta cap/.test(e.message); }
  ok(threw, 'start() refuses a note over the beta cap without settling anything');
}

// ---- full happy path: settled -> covered -> mint-signed -> mint-submitted -> minted ----
{
  const world = makeWorld();
  const ux = makeUx(world);

  const rec0 = await ux.start({ note: NOTE, walletPriv: WALLET_PRIV });
  ok(rec0.stage === 'settled', 'start() produces a settled record (the ETH-side settle is atomic — no separate signed-but-unsent stage)');
  ok(rec0.settle.claimId === CLAIM_ID && rec0.settle.claimIdVerified === true, 'the record carries the corroborated claimId');
  ok(/^[0-9a-f]{64}$/.test(stripHex(rec0.destXonly)), 'a self-bridge destination x-only key was derived');

  let threwDup = false;
  try { await ux.start({ note: NOTE, walletPriv: WALLET_PRIV }); } catch { threwDup = true; }
  ok(threwDup, 'start() refuses a second bridge for the same note (already reserved)');

  const [reserved] = ux.eligibleNotes([NOTE]);
  ok(reserved.eligible === false && reserved.reason === 'already bridging', 'the note now shows as already bridging in eligibleNotes');

  // not yet covered — advance is a resumable no-op, not an error
  const stillSettled = await ux.advance(WALLET_PUB, NOTE.nullifier);
  ok(stillSettled.stage === 'settled', 'advance() before eth-state coverage stays at settled rather than erroring');

  world.setEthCovered(true);
  const covered = await ux.advance(WALLET_PUB, NOTE.nullifier);
  ok(covered.stage === 'covered', 'advance() moves to covered once /reflection/eth-state/covers reports true');

  let threwNoKey = false;
  try { await ux.advance(WALLET_PUB, NOTE.nullifier); } catch (e) { threwNoKey = /wallet key/.test(e.message); }
  ok(threwNoKey, 'covered -> mint-signed refuses without the wallet key');

  const signed = await ux.advance(WALLET_PUB, NOTE.nullifier, { walletPriv: WALLET_PRIV });
  ok(signed.stage === 'mint-signed', 'advance() with the key builds and signs the Bitcoin-side commit/reveal');
  ok(/^[0-9a-f]+$/.test(signed.mint.commitHex) && /^[0-9a-f]+$/.test(signed.mint.revealHex), 'commit and reveal hex were produced');
  ok(signed.mint.revealHex.includes('225120' + stripHex(signed.destXonly)), "the reveal's vout 0 really does pay P2TR(destXonly)");

  const submitted = await ux.advance(WALLET_PUB, NOTE.nullifier);
  ok(submitted.stage === 'mint-submitted', 'advance() broadcasts commit then reveal');
  ok(world.broadcasts.length === 2 && world.broadcasts[0] === signed.mint.commitHex && world.broadcasts[1] === signed.mint.revealHex, 'commit was broadcast before reveal, in order');

  const stillSubmitted = await ux.advance(WALLET_PUB, NOTE.nullifier);
  ok(stillSubmitted.stage === 'mint-submitted', 'advance() before the reveal confirms stays at mint-submitted');

  world.mineRevealTxid(submitted.mint.revealTxid);
  const minted = await ux.advance(WALLET_PUB, NOTE.nullifier);
  ok(minted.stage === 'minted', 'advance() reaches minted once the reveal confirms on chain');

  const final = await ux.advance(WALLET_PUB, NOTE.nullifier);
  ok(final.stage === 'minted', 'advance() on a minted record is a no-op, not an error');
}

// ---- an unverified claimId blocks progress with a clear, visible error rather than silently proceeding ----
{
  const world = makeWorld();
  world.setClaimIdVerified(false, 'no matching CrossOutRecorded event for every destCommitment');
  const ux = makeUx(world);
  await ux.start({ note: NOTE, walletPriv: WALLET_PRIV });
  world.setEthCovered(true);

  let threw = false;
  try { await ux.advance(WALLET_PUB, NOTE.nullifier); }
  catch (e) { threw = /claimId not corroborated/.test(e.message); }
  ok(threw, 'advance() refuses to move past settled when the claimId was never corroborated');

  const list = ux.list(WALLET_PUB);
  const rec = list.find((r) => r.id === NOTE.nullifier);
  ok(rec.stage === 'settled' && rec.lastError && /claimId not corroborated/.test(rec.lastError.message), 'the record is journalled with the error visible, not silently stuck');
}

// ---- resumeAll drives an in-flight record forward without the key, stopping where the key is required ----
{
  const world = makeWorld();
  const ux = makeUx(world);
  await ux.start({ note: NOTE, walletPriv: WALLET_PRIV });
  world.setEthCovered(true);

  const results = await ux.resumeAll(WALLET_PUB);
  const rec = ux.list(WALLET_PUB).find((r) => r.id === NOTE.nullifier);
  ok(rec.stage === 'covered', 'resumeAll() without a key advances as far as settled -> covered');
  ok(results.length === 1 && !results[0].error, 'resumeAll() reports the record it advanced without error');
}

// ---- abandon removes a record from the journal ----
{
  const world = makeWorld();
  const ux = makeUx(world);
  await ux.start({ note: NOTE, walletPriv: WALLET_PRIV });
  ux.abandon(WALLET_PUB, NOTE.nullifier);
  ok(ux.list(WALLET_PUB).length === 0, 'abandon() removes the record');
  ok(ux.isReserved(NOTE.nullifier) === false, 'an abandoned note is no longer reserved');
}

console.log(`\n${n} crossout-ux checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
