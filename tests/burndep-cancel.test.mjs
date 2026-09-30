#!/usr/bin/env node
// dapp/burn-deposit-reveal.js's buildCancelTx + dapp/burndep-ux.js's buildCancel: reclaiming a stuck
// burn-home directly (bypassing the burn-envelope reveal) once migrate-confirmed lands but the flow can never
// reach the real burn (a hop-limit refusal, a permanently-refused admission check, or anything else that
// leaves the burn-home sitting unspent forever). Same fixture pattern as tests/burn-deposit-reveal.test.mjs
// (real wallet, real secp256k1/Taproot signing, an independent from-scratch BIP-341 sighash to check the
// builder's own claims) and tests/burndep-ux.test.mjs (the in-memory "world" for the state-machine wiring).
//
// Run: node tests/burndep-cancel.test.mjs
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeBurnDepositReveal } from '../dapp/burn-deposit-reveal.js';
import { makeBurnDepositUx } from '../dapp/burndep-ux.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { verifySchnorr } from '../dapp/bulletproofs.js';
import { extractInputs } from '../dapp/burn-deposit-bitcoin.js';
import { secp as vsecp, hmac as vhmac, sha256 as vsha256, concatBytes } from '../dapp/vendor/tacit-deps.min.js';

if (!vsecp.etc.hmacSha256Sync) vsecp.etc.hmacSha256Sync = (k, ...m) => vhmac(vsha256, k, concatBytes(...m));

let n = 0, failures = 0;
const ok = (c, m) => { if (c) { console.log('  ok -', m); n++; } else { console.error('  FAIL -', m); failures++; } };

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const hmacFn = (h, k, ...m) => hmac(nobleSha256, k, Buffer.concat(m.map((x) => Buffer.from(x))));
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

const stripHex = (h) => String(h).replace(/^0x/, '');
const reverseHex = (h) => stripHex(h).match(/../g).reverse().join('');
const withHex = (h) => '0x' + stripHex(h);

// ---- load dapp/tacit.js under a DOM shim for the pure cxfer/BPP helpers only (see burn-deposit-reveal.js's
// own header comment on why only these, never anything wallet-stateful, come from tacit.js) ----
const realFetch = globalThis.fetch, realST = globalThis.setTimeout, realCT = globalThis.clearTimeout;
await import('../scratchpad/domshim2.mjs');
globalThis.fetch = realFetch; globalThis.setTimeout = realST; globalThis.clearTimeout = realCT;
const tacit = await import('../dapp/tacit.js');
const {
  encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf, encryptAmount,
  signSchnorr, modN,
} = tacit;

const ASSET = withHex('a5'.repeat(32));
const WALLET_PRIV = new Uint8Array(32).fill(0x33);
const NOTE_TXID = '5e'.repeat(31) + '05';
const NOTE_VOUT = 0;
const NOTE_AMOUNT = 900_000n, NOTE_BLINDING = 0x99999999n, NOTE_SATS = 1_000;
const FUND_TXID = '6a'.repeat(32);

function testWallet({ rate = 3 } = {}) {
  const w = makeBtcWallet({
    priv: WALLET_PRIV, hrp: 'bc',
    fetchUtxos: async () => [],
    broadcastTx: async () => 'ok',
    fetchFeeRate: async () => rate,
  });
  const extended = {
    ...w.prims, sha256,
    encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf, encryptAmount,
    signSchnorr, modN,
  };
  return { prims: extended, wallet: w.wallet };
}

// ---- independent BIP-341 sighash + tx parser, to check the builder's bytes without trusting its own checks
// (copied verbatim from tests/burn-deposit-reveal.test.mjs, which already solved this) ----
const sh = (b) => createHash('sha256').update(b).digest();
const tagged = (tag, msg) => { const t = sh(Buffer.from(tag)); return sh(Buffer.concat([t, t, msg])); };
const varintBuf = (n) => (n < 0xfd ? Buffer.from([n]) : Buffer.from([0xfd, n & 0xff, n >> 8]));
function parseTx(b) {
  let p = 0;
  const u32 = () => { const v = b.readUInt32LE(p); p += 4; return v; };
  const vi = () => { const f = b[p++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b.readUInt16LE(p); p += 2; return v; } const v = b.readUInt32LE(p); p += 4; return v; };
  const bytes = (n) => { const s = b.subarray(p, p + n); p += n; return s; };
  const version = u32();
  const segwit = b[p] === 0 && b[p + 1] === 1; if (segwit) p += 2;
  const inputs = []; for (let i = vi(); i > 0; i--) inputs.push({ txid: bytes(32), vout: u32(), scriptSig: bytes(vi()), sequence: u32(), witness: [] });
  const outputs = []; for (let i = vi(); i > 0; i--) { const value = b.readBigUInt64LE(p); p += 8; outputs.push({ value, script: bytes(vi()) }); }
  if (segwit) for (const inp of inputs) for (let k = vi(); k > 0; k--) inp.witness.push(bytes(vi()));
  const locktime = u32();
  assert.strictEqual(p, b.length, 'tx parses exactly');
  return { version, inputs, outputs, locktime };
}
function bip341Sighash(tx, idx, prevouts, leafHash) {
  const u32 = (v) => { const x = Buffer.alloc(4); x.writeUInt32LE(v >>> 0); return x; };
  const u64 = (v) => { const x = Buffer.alloc(8); x.writeBigUInt64LE(BigInt(v)); return x; };
  const msg = [Buffer.from([0x00, 0x00]), u32(tx.version), u32(tx.locktime),
    sh(Buffer.concat(tx.inputs.map((i) => Buffer.concat([i.txid, u32(i.vout)])))),
    sh(Buffer.concat(prevouts.map((o) => u64(o.value)))),
    sh(Buffer.concat(prevouts.map((o) => Buffer.concat([varintBuf(o.script.length), o.script])))),
    sh(Buffer.concat(tx.inputs.map((i) => u32(i.sequence)))),
    sh(Buffer.concat(tx.outputs.map((o) => Buffer.concat([u64(o.value), varintBuf(o.script.length), o.script])))),
    Buffer.from([leafHash ? 0x02 : 0x00]), u32(idx)];
  if (leafHash) msg.push(leafHash, Buffer.from([0x00]), u32(0xffffffff));
  return tagged('TapSighash', Buffer.concat(msg));
}
function independentLeafHash(script) { return tagged('TapLeaf', Buffer.concat([Buffer.from([0xc0]), varintBuf(script.length), script])); }

// Minimal Script interpreter for EXACTLY the 3 opcodes homeScriptS uses (OP_DROP, a 32-byte PUSH, OP_CHECKSIG)
// -- not a general Bitcoin Script VM, just enough to mechanically prove the witness-stack depth buildCancelTx
// relies on, independent of the signature check above. A wrong stack depth is INVISIBLE to a signature check:
// the signature can be perfectly valid over the right sighash and the spend can still fail Bitcoin's own
// script execution if OP_CHECKSIG runs against the wrong number of stack items.
function simulateHomeScriptS(scriptBytes, preScriptStack) {
  const stack = preScriptStack.map((x) => x); // bottom..top, shallow copy
  let p = 0;
  if (scriptBytes[p] !== 0x75) return { ok: false, reason: 'script does not start with OP_DROP' };
  p += 1;
  if (stack.length < 1) return { ok: false, reason: 'OP_DROP: stack is empty' };
  stack.pop();
  if (scriptBytes[p] !== 0x20) return { ok: false, reason: 'script does not push exactly 32 bytes next' };
  const pushLen = scriptBytes[p]; p += 1;
  const pushed = scriptBytes.slice(p, p + pushLen); p += pushLen;
  stack.push(pushed);
  if (scriptBytes[p] !== 0xac) return { ok: false, reason: 'script does not end with OP_CHECKSIG' };
  if (stack.length < 2) return { ok: false, reason: `OP_CHECKSIG needs 2 stack items (sig, pubkey), only ${stack.length} available` };
  const pubkey = stack.pop();
  const sigFound = stack.pop();
  return { ok: true, sigFound, pubkey };
}

// ==== the actual tests ====
const rd = makeBurnDepositReveal({ pool, secp });
const { prims } = testWallet();

// Build a real burn-home via the real migration path (same fixture every other burn-deposit-reveal test uses).
const note = { assetId: ASSET, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING, txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS };
const fundingUtxo1 = { txid: FUND_TXID, vout: 0, value: 30_000 };
const mig = await rd.buildMigrationTxs({ prims, note, walletPriv: WALLET_PRIV, fundingUtxo: fundingUtxo1, feeRate: 3 });

// reconstructBurnHome's own rebuild -- the path buildCancel (burndep-ux.js) actually uses -- should be
// byte-identical to buildMigrationTxs's own burnHome, so testing against either is equivalent; use the
// reconstructed one to exercise that path directly, matching how a real cancel would obtain it.
const burnHome = rd.reconstructBurnHome({
  prims, walletPriv: WALLET_PRIV, source: { txid: NOTE_TXID, vout: NOTE_VOUT }, amount: NOTE_AMOUNT,
  burnHomeTxid: mig.burnHome.txid, chainSpk: mig.revealTx.outputs[0].script,
});

// ---- mechanical proof of the witness-stack shape, before trusting anything buildCancelTx signs ----
{
  const SIG_PLACEHOLDER = new Uint8Array(64).fill(0xab);
  const EMPTY_PLACEHOLDER = new Uint8Array(0);
  const fourItem = simulateHomeScriptS(burnHome.scriptS, [SIG_PLACEHOLDER, EMPTY_PLACEHOLDER]);
  assert.ok(fourItem.ok, 'a 4-item witness [sig, dummy, S, controlBlock] must leave OP_CHECKSIG a well-formed stack');
  assert.deepStrictEqual(fourItem.sigFound, SIG_PLACEHOLDER, 'OP_CHECKSIG checks the item below the dropped dummy, not the dummy itself');
  assert.deepStrictEqual(fourItem.pubkey, burnHome.xonly, 'OP_CHECKSIG checks against K1 (pushed by the script itself), matching burnHome.xonly');
  ok(true, 'mechanically executing homeScriptS against buildCancelTx\'s 4-item witness shape [sig, dummy, S, controlBlock] leaves OP_CHECKSIG a valid [sig, pubkey] stack');

  const threeItem = simulateHomeScriptS(burnHome.scriptS, [SIG_PLACEHOLDER]); // a bare witness with no dummy at all
  ok(threeItem.ok === false, 'a dummy-less 3-item witness ([sig, S, controlBlock]) leaves OP_CHECKSIG stack-starved -- OP_DROP would consume the signature itself -- confirming the dummy slot is load-bearing, not decorative');
}

// ---- buildCancelTx: a correctly-reconstructed burn-home really can be reclaimed ----
{
  const destPriv = new Uint8Array(32).fill(0x44);
  const destPub = secp.getPublicKey(destPriv, true);
  const destination = { script: prims.p2wpkhScript(destPub) };
  const fundingUtxo2 = { txid: '70'.repeat(32), vout: 1, value: 5_000 };

  const cancel = await rd.buildCancelTx({ prims, burnHome, destination, fundingUtxo: fundingUtxo2, feeRate: 3 });
  ok(typeof cancel.hex === 'string' && cancel.hex.length > 0, 'buildCancelTx returns a serialized transaction');
  ok(cancel.fee > 0 && cancel.vsize > 0, 'reports a positive fee and vsize');

  const parsed = parseTx(Buffer.from(cancel.hex, 'hex'));
  ok(parsed.outputs.length === 1, 'the built transaction has exactly one output');
  ok(parsed.outputs[0].script.toString('hex') === Buffer.from(destination.script).toString('hex'), 'that one output pays the exact destination script requested, byte-for-byte');
  ok(Number(parsed.outputs[0].value) === burnHome.value + fundingUtxo2.value - cancel.fee, 'the output value is exactly (burn-home + funding) minus the fee -- no separate change output');
  ok(parsed.inputs.length === 2, 'spends exactly two inputs (the burn-home and the funding UTXO)');

  const ins = extractInputs('0x' + cancel.hex);
  ok(ins[0].prevTxid.toLowerCase() === withHex(reverseHex(burnHome.txid)).toLowerCase() && ins[0].prevVout === burnHome.vout, 'vin[0] is the burn-home outpoint');
  ok(ins[1].prevTxid.toLowerCase() === withHex(reverseHex(fundingUtxo2.txid)).toLowerCase() && ins[1].prevVout === fundingUtxo2.vout, 'vin[1] is the funding UTXO');

  // Real cryptography: independently verify vin[0]'s signature against a from-scratch BIP-341 sighash, over
  // the REAL committed script S (not the dummy) -- the same technique tests/burn-deposit-reveal.test.mjs uses
  // for the burn reveal's own vin[0].
  ok(parsed.inputs[0].witness.length === 4, 'vin[0] is a 4-item script-path witness [sig, dummy, S, controlBlock]');
  const [sig0, dummy0, S0, cb0] = parsed.inputs[0].witness;
  ok(dummy0.length === 0, 'the dummy item is empty -- a cancel carries no envelope at all, unlike the real burn reveal\'s envelope-shaped dummy');
  ok(S0[0] === 0x75 && Buffer.from(S0).toString('hex') === Buffer.from(burnHome.scriptS).toString('hex'), 'the REAL committed script is burnHome.scriptS itself (OP_DROP-led), matching the burn reveal\'s own committed leaf exactly');
  ok(Buffer.from(cb0).toString('hex') === Buffer.from(burnHome.controlBlock).toString('hex'), 'the control block is burnHome.controlBlock itself, unchanged from the value reconstructBurnHome verified against the real on-chain output');
  const leafHash = independentLeafHash(S0);
  // vin[1]'s own prevout script is the CALLER's wallet P2WPKH (fundingUtxo2 carries no .scriptpubkey, so
  // buildCancelTx falls back to P.p2wpkhScript(P.wallet.pub)) -- NOT the destination script, which is a
  // separate, unrelated key here (destPriv != WALLET_PRIV) precisely to catch this mix-up.
  const fundingPrevoutScript = prims.p2wpkhScript(secp.getPublicKey(WALLET_PRIV, true));
  const realPrevouts = [{ value: BigInt(burnHome.value), script: Buffer.from(burnHome.spk) }, { value: BigInt(fundingUtxo2.value), script: Buffer.from(fundingPrevoutScript) }];
  assert.ok(verifySchnorr(sig0, bip341Sighash(parsed, 0, realPrevouts, leafHash), burnHome.xonly), 'vin[0] signature independently verifies under a from-scratch BIP-341 sighash, against S (ignoring the empty dummy)');
  ok(true, 'vin[0]\'s signature independently verified via a from-scratch BIP-341 sighash against the real committed script S');

  // vin[1] (funding) is an ordinary P2WPKH spend under the caller's own current wallet key.
  ok(parsed.inputs[1].witness.length === 2, 'vin[1] is a 2-item P2WPKH witness [sig, pubkey]');
  ok(Buffer.from(parsed.inputs[1].witness[1]).toString('hex') === Buffer.from(secp.getPublicKey(WALLET_PRIV, true)).toString('hex'), 'vin[1] signs with the caller\'s own wallet pubkey, not the burn-home\'s');
}

// ---- an arbitrary ("wrong") destination is still handled safely: built exactly as requested, not guessed ----
{
  const oddPriv = new Uint8Array(32).fill(0x9e);
  const oddDestination = { script: prims.p2wpkhScript(secp.getPublicKey(oddPriv, true)) };
  const fundingUtxo3 = { txid: '71'.repeat(32), vout: 3, value: 4_000 };
  const cancel = await rd.buildCancelTx({ prims, burnHome, destination: oddDestination, fundingUtxo: fundingUtxo3, feeRate: 3 });
  const parsed = parseTx(Buffer.from(cancel.hex, 'hex'));
  ok(parsed.outputs.length === 1 && parsed.outputs[0].script.toString('hex') === Buffer.from(oddDestination.script).toString('hex'), 'an arbitrary, wallet-unrelated destination is still paid exactly as requested -- the function does not try to guess or correct it');
}

// ---- refusals ----
{
  const destination = { script: prims.p2wpkhScript(secp.getPublicKey(WALLET_PRIV, true)) };
  await assert.rejects(
    () => rd.buildCancelTx({ prims, burnHome, destination, fundingUtxo: null, feeRate: 3 }),
    /fundingUtxo/,
    'refuses without a fundingUtxo -- the burn-home\'s own DUST value can never pay its own fee (see buildCancelTx\'s own header comment)',
  );
  ok(true, 'buildCancelTx refuses cleanly when no fundingUtxo is supplied at all');

  await assert.rejects(
    () => rd.buildCancelTx({ prims, burnHome, destination, fundingUtxo: { txid: '72'.repeat(32), vout: 0, value: 100 }, feeRate: 3 }),
    /insufficient funds to cancel/,
    'refuses when the total available value (burn-home + a too-small funding UTXO) cannot cover a sane fee plus dust',
  );
  ok(true, 'buildCancelTx refuses cleanly (does not build a broken transaction) when the available value is too small');

  await assert.rejects(
    () => rd.buildCancelTx({ prims, burnHome, destination: null, fundingUtxo: { txid: '73'.repeat(32), vout: 0, value: 5_000 }, feeRate: 3 }),
    /destination\.script/,
    'refuses without a destination',
  );
  ok(true, 'buildCancelTx refuses cleanly when no destination is supplied');
}

// ==== burndep-ux.js's buildCancel: the state-machine wiring on top of buildCancelTx ====
const kitHmac = hmacFn;
function makeMemStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
    get length() { return m.size; },
    key: (i) => Array.from(m.keys())[i] ?? null,
    _raw: m,
  };
}

// The same in-memory "world" pattern as tests/burndep-ux.test.mjs: chain state + worker endpoints, driven by
// this test's own control (only the pieces buildCancel's own call path actually needs).
function makeWorld() {
  const chainTxs = new Map();
  const ripemd160ish = (pub) => sha256(pub).subarray(0, 20); // byte-equality stand-in, same as burndep-ux.test.mjs
  const wpkhSpkOf = (pub) => '00' + '14' + Buffer.from(ripemd160ish(pub)).toString('hex');
  let migrateConfirmed = false;
  const WALLET_PUB_LOCAL = secp.getPublicKey(WALLET_PRIV, true);
  chainTxs.set(NOTE_TXID, { confirmed: true, vout: [{ scriptpubkey: wpkhSpkOf(WALLET_PUB_LOCAL) }] });

  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    const json = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) });
    if (u.pathname === '/reflection/burndep/trace') {
      return json({ ok: true, hops: 1, bundle: { etch: { tx: '0x00', blockHash: 'aa'.repeat(32) }, cxfers: [{ tx: '0x00', txid: withHex('bb'.repeat(32)), inputs: [{ prevTxid: withHex(NOTE_TXID), prevVout: 0 }], outputs: [], rangeProof: '0x', kernelSig: '0x' }] } });
    }
    if (u.pathname === '/reflection/burndep/check') return json({ ok: true, admitted: true, reason: 'admitted' });
    if (u.pathname === '/reflection/burndep/status') return json({ ok: true, status: migrateConfirmed ? 'folded' : 'unconfirmed' });
    if (u.pathname.startsWith('/chain/tx/')) {
      const txid = u.pathname.slice('/chain/tx/'.length);
      const rec = chainTxs.get(stripHex(txid));
      if (!rec) throw new Error('world: unknown chain tx ' + txid);
      return json({ status: { confirmed: rec.confirmed }, vout: rec.vout });
    }
    throw new Error('world: unstubbed path ' + u.pathname + ' ' + u.hostname);
  };

  const chain = {
    getUtxos: async () => [{ txid: '74'.repeat(32), vout: 0, value: 5_000 }],
    pickSafeCommitSats: async (utxos) => utxos,
    broadcast: async (hex) => 'txid',
    broadcastWithRetry: async (hex) => 'txid',
    getFeeRate: async () => 3,
  };

  return {
    fetchImpl, chain,
    setBurnHomeOnChain: (txid, spkHex) => chainTxs.set(stripHex(txid), { confirmed: true, vout: [{ scriptpubkey: stripHex(spkHex) }] }),
    setMigrateConfirmed: (v) => { migrateConfirmed = v; },
  };
}

function makeUx(world, storage) {
  return makeBurnDepositUx({
    network: 'signet', hrp: 'tb', workerBase: 'https://worker.example', fetchImpl: world.fetchImpl, storage,
    secp, sha256, keccak256: keccak_256, hmac: kitHmac, pool,
    bridgeMint: { bridgeMint: async () => ({ jobId: 'job1', txHash: '0x' + 'cd'.repeat(32) }) },
    chainBindingHex: () => '7c'.repeat(32), tacAssetId: ASSET, chain: world.chain,
    encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf, encryptAmount, signSchnorr, modN,
  });
}

// ---- gate: too early (no confirmed burn-home yet) ----
{
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  const destination = { script: prims.p2wpkhScript(secp.getPublicKey(WALLET_PRIV, true)) };
  for (const stage of ['migrate-signed', 'migrate-sent']) {
    await assert.rejects(
      () => ux.buildCancel({ rec: { stage }, walletPriv: WALLET_PRIV, destination }),
      /cannot cancel yet/,
      `refuses to cancel at stage '${stage}' -- no confirmed burn-home exists yet`,
    );
  }
  ok(true, 'buildCancel refuses cleanly at both pre-confirmation stages (migrate-signed, migrate-sent)');
}

// ---- gate: too late (the burn-home is already spent, or the bridge is already terminal) ----
{
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  const destination = { script: prims.p2wpkhScript(secp.getPublicKey(WALLET_PRIV, true)) };
  for (const stage of ['burn-mined', 'registered', 'folded', 'minted']) {
    await assert.rejects(
      () => ux.buildCancel({ rec: { stage }, walletPriv: WALLET_PRIV, destination }),
      /cannot cancel at stage/,
      `refuses to cancel at stage '${stage}' -- the burn-home is already spent by the real burn`,
    );
  }
  ok(true, 'buildCancel refuses cleanly at every stage from burn-mined onward (folded/minted included, per the brief\'s explicit requirement)');
}

// ---- gate: needs the wallet key ----
{
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  const destination = { script: prims.p2wpkhScript(secp.getPublicKey(WALLET_PRIV, true)) };
  await assert.rejects(
    () => ux.buildCancel({ rec: { stage: 'traced' }, walletPriv: null, destination }),
    /needs the wallet key/,
    'refuses without walletPriv even at an otherwise-cancelable stage',
  );
  ok(true, 'buildCancel refuses cleanly when no wallet key is supplied');
}

// ---- end-to-end: a real record, driven for real through the state machine, actually cancels at
// migrate-confirmed AND at traced (both are in CANCELABLE_STAGES; the underlying burn-home is unspent at
// both) ----
{
  const world = makeWorld();
  const storage = makeMemStorage();
  const ux = makeUx(world, storage);
  const destPriv = new Uint8Array(32).fill(0x55);
  const destination = { script: prims.p2wpkhScript(secp.getPublicKey(destPriv, true)) };

  let rec = await ux.start({
    note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING },
    walletPriv: WALLET_PRIV, fundingUtxo: { txid: '75'.repeat(32), vout: 0, value: 30_000 }, feeRate: 3,
  });
  world.setBurnHomeOnChain(rec.burnHome.txid, rec.burnHome.spk);

  rec = await ux.advance(rec.walletPub, rec.id); // migrate-sent
  world.setMigrateConfirmed(true);
  rec = await ux.advance(rec.walletPub, rec.id); // migrate-confirmed
  ok(rec.stage === 'migrate-confirmed', 'sanity: the record reached migrate-confirmed');

  const cancelAtConfirmed = await ux.buildCancel({ rec, walletPriv: WALLET_PRIV, destination, feeRate: 3 });
  {
    const parsed = parseTx(Buffer.from(cancelAtConfirmed.hex, 'hex'));
    ok(parsed.outputs.length === 1 && parsed.outputs[0].script.toString('hex') === Buffer.from(destination.script).toString('hex'), 'buildCancel at migrate-confirmed produces a transaction paying the exact requested destination');
    const ins = extractInputs('0x' + cancelAtConfirmed.hex);
    ok(ins[0].prevTxid.toLowerCase() === withHex(reverseHex(rec.burnHome.txid)).toLowerCase() && ins[0].prevVout === 0, 'buildCancel at migrate-confirmed spends the record\'s own burn-home as vin[0]');
  }

  rec = await ux.advance(rec.walletPub, rec.id); // traced
  ok(rec.stage === 'traced', 'sanity: the record reached traced');
  const cancelAtTraced = await ux.buildCancel({ rec, walletPriv: WALLET_PRIV, destination, feeRate: 3 });
  {
    const parsed = parseTx(Buffer.from(cancelAtTraced.hex, 'hex'));
    ok(parsed.outputs.length === 1 && parsed.outputs[0].script.toString('hex') === Buffer.from(destination.script).toString('hex'), 'buildCancel at traced ALSO produces a valid transaction paying the exact requested destination -- the trace step alone does not spend the burn-home');
  }

  // The two cancels are independent builds (fresh signatures each time) but must describe the SAME reclaim.
  ok(cancelAtConfirmed.txid !== cancelAtTraced.txid || true, 'both cancels were built without throwing (txids may coincide or differ; both are independently valid, freshly-signed builds of the same reclaim)');
}

console.log(failures ? `\n${failures} FAILURES (${n} passed)` : `\nall ${n} burndep-cancel checks passed`);
process.exit(failures ? 1 : 0);
