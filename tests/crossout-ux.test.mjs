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
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialEvmLog } from '../dapp/confidential-evm-log.js';

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
const { makeBtcWallet } = await import('../dapp/bitcoin-taproot-wallet.js');
// The self-bridge destination is always this wallet's own Bitcoin key (crossout-ux.js's own freshPrims) --
// computed once here so the recovery tests can assert against it without re-deriving it inline each time.
const destXonlyOf = (priv) => bytesToHex(makeBtcWallet({ priv, hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => {}, fetchFeeRate: async () => 1 }).wallet.xonly());

const { makeCrossoutUx, CROSSOUT_BETA_CAP_RAW } = await import('../dapp/crossout-ux.js');
globalThis.fetch = realFetch;

const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256: nobleSha256 });
const evmLog = makeConfidentialEvmLog({ keccak256: keccak_256 });

let n = 0, failures = 0;
const ok = (c, m) => { if (c) { console.log('  ok -', m); n++; } else { console.error('  FAIL -', m); failures++; } };

const stripHex = (h) => String(h).replace(/^0x/, '');
const withHex = (h) => '0x' + stripHex(h);
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = (h) => { const s = stripHex(h); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; };
const topicCrossOutRecorded = '0x' + bytesToHex(keccak_256(new TextEncoder().encode('CrossOutRecorded(bytes32,uint16,bytes32,bytes32,bytes32)')));
// Builds a raw {topics, data} log exactly as ConfidentialPool would emit CrossOutRecorded, so
// evmLog.decodeLog (the real decoder, not a stand-in) is what recoverFromEthTx actually exercises.
function buildCrossOutRecordedLog({ claimId, destChain, destCommitment, nullifier, assetId }) {
  const word32 = (n) => { const b = new Uint8Array(32); b[31] = Number(n); return b; };
  const data = new Uint8Array(128);
  data.set(word32(destChain), 0);
  data.set(hexToBytes(destCommitment), 32);
  data.set(hexToBytes(nullifier), 64);
  data.set(hexToBytes(assetId), 96);
  return { topics: [topicCrossOutRecorded, claimId], data: '0x' + bytesToHex(data) };
}
// The exact HMAC-bound blinding crossOut() derives by default (confidential-pool-ux.js) -- reproduced here
// so the "happy path" recovery test's fixture is internally consistent with what recoverFromEthTx recomputes,
// and so a real start() and a real recoverFromEthTx over the same (walletPriv, nullifier) can be asserted equal.
function deriveCrossoutBlinding(walletPriv, nullifierHex) {
  const domain = new TextEncoder().encode('tacit-crossout-blinding-v1');
  const nullifierBytes = hexToBytes(nullifierHex);
  const msg = new Uint8Array(domain.length + nullifierBytes.length);
  msg.set(domain); msg.set(nullifierBytes, domain.length);
  const raw = hmac(nobleSha256, walletPriv, msg);
  let b = 0n; for (const x of raw) b = (b << 8n) | BigInt(x);
  b %= secp.CURVE.n;
  return b === 0n ? 1n : b;
}

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
  const ethReceipts = new Map(); // txHash(display) -> receipt
  const broadcasts = [];
  let ethCovered = false;
  let claimIdVerified = true;
  let claimIdNote = 'corroborated against CrossOutRecorded';

  async function rpc(method, params) {
    if (method === 'eth_getTransactionReceipt') return ethReceipts.get(stripHex(params[0]).toLowerCase()) || null;
    throw new Error(`world: unhandled rpc ${method}`);
  }

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
    fetchImpl, chain, crossOut, rpc,
    setEthCovered: (v) => { ethCovered = v; },
    setClaimIdVerified: (v, note) => { claimIdVerified = v; claimIdNote = note || claimIdNote; },
    mineRevealTxid: (txid) => chainTxs.set(stripHex(txid), { status: { confirmed: true } }),
    setEthReceipt: (txHash, receipt) => ethReceipts.set(stripHex(txHash).toLowerCase(), receipt),
    broadcasts,
  };
}

function makeUx(world) {
  return makeCrossoutUx({
    network: 'mainnet', hrp: 'bc', workerBase: 'http://worker', fetchImpl: world.fetchImpl,
    storage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), get length() { return m.size; }, key: (i) => Array.from(m.keys())[i] || null }; })(),
    secp, hmac, sha256: nobleSha256, crossOut: world.crossOut, pool, rpc: world.rpc, evmLog, tacAssetId: ASSET, chain: world.chain,
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

// ---- recoverFromEthTx: rebuilds an identical record from just the settle tx hash + amount, no journal ----
{
  const world = makeWorld();
  const ux = makeUx(world);
  const destXonly = destXonlyOf(WALLET_PRIV);
  const rDest = deriveCrossoutBlinding(WALLET_PRIV, NOTE.nullifier);
  const { cx, cy } = pool.commitXY(NOTE.value, rDest);
  const destCommitment = pool.btcNoteLeaf(ASSET, cx, cy, withHex(destXonly));
  const settleTxHash = withHex('ee'.repeat(32));
  world.setEthReceipt(settleTxHash, {
    blockNumber: '0x' + (77777).toString(16),
    logs: [buildCrossOutRecordedLog({ claimId: CLAIM_ID, destChain: 1, destCommitment, nullifier: NOTE.nullifier, assetId: ASSET })],
  });

  const rec = await ux.recoverFromEthTx(settleTxHash, WALLET_PRIV, { amount: NOTE.value });
  ok(rec.stage === 'settled', 'recoverFromEthTx() rebuilds a settled record from chain data alone');
  ok(rec.settle.claimId.toLowerCase() === CLAIM_ID.toLowerCase(), 'the claimId comes straight from the event, not guessed');
  ok(rec.settle.cx.toLowerCase() === cx.toLowerCase() && rec.settle.cy.toLowerCase() === cy.toLowerCase(), 'cx/cy are correctly re-derived from (walletPriv, nullifier, amount)');
  ok(rec.settle.ethBlock === 77777, 'the settle block number is read from the receipt');
  ok(rec.destXonly.toLowerCase() === destXonly.toLowerCase(), 'the self-bridge destination key matches, needing no stored state at all');
  ok(ux.isReserved(NOTE.nullifier) === true, 'the recovered record shows up as reserved, same as a freshly-started one');

  // Advancing it forward from here uses the exact same path a normal record would.
  world.setEthCovered(true);
  const covered = await ux.advance(WALLET_PUB, NOTE.nullifier);
  ok(covered.stage === 'covered', 'a recovered record advances normally afterward');
}

// ---- recoverFromEthTx refuses rather than misfiling on any wrong input ----
{
  const world = makeWorld();
  const ux = makeUx(world);
  const destXonly = destXonlyOf(WALLET_PRIV);
  const rDest = deriveCrossoutBlinding(WALLET_PRIV, NOTE.nullifier);
  const { cx, cy } = pool.commitXY(NOTE.value, rDest);
  const destCommitment = pool.btcNoteLeaf(ASSET, cx, cy, withHex(destXonly));
  const settleTxHash = withHex('ef'.repeat(32));
  world.setEthReceipt(settleTxHash, {
    blockNumber: '0x1',
    logs: [buildCrossOutRecordedLog({ claimId: CLAIM_ID, destChain: 1, destCommitment, nullifier: NOTE.nullifier, assetId: ASSET })],
  });

  let threwWrongAmount = false;
  try { await ux.recoverFromEthTx(settleTxHash, WALLET_PRIV, { amount: NOTE.value + 1n }); }
  catch (e) { threwWrongAmount = /does not match/.test(e.message); }
  ok(threwWrongAmount, 'a wrong amount is caught by the destCommitment check, not silently written');

  let threwNoReceipt = false;
  try { await ux.recoverFromEthTx(withHex('ff'.repeat(32)), WALLET_PRIV, { amount: NOTE.value }); }
  catch (e) { threwNoReceipt = /no receipt/.test(e.message); }
  ok(threwNoReceipt, 'an unmined or wrong-network tx hash is refused up front');

  let threwNoEvent = false;
  const emptyTxHash = withHex('f0'.repeat(32));
  world.setEthReceipt(emptyTxHash, { blockNumber: '0x1', logs: [] });
  try { await ux.recoverFromEthTx(emptyTxHash, WALLET_PRIV, { amount: NOTE.value }); }
  catch (e) { threwNoEvent = /no CrossOutRecorded/.test(e.message); }
  ok(threwNoEvent, 'a tx with no CrossOutRecorded event is refused rather than guessed at');
}

console.log(`\n${n} crossout-ux checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
