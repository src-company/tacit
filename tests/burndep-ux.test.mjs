#!/usr/bin/env node
// dapp/burndep-ux.js: the burn-deposit bridge state machine. Drives a full migrate -> burn -> mint cycle
// against a real wallet + real cryptography (the same fixture pattern tests/burn-deposit-reveal.test.mjs
// uses) with the network layer (worker endpoints, MARA, chain broadcast/UTXO selection, bridgeMint) stubbed
// by an in-memory "world" whose confirmation state advances under the test's own control.
//
// Run: node tests/burndep-ux.test.mjs
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeBurnDepositUx, BURNDEP_BETA_CAP_RAW } from '../dapp/burndep-ux.js';
import { makeBurnDepositKit, classifyConfidentialTx } from '../dapp/burn-deposit-bitcoin.js';
import { ripemd160 } from '../dapp/vendor/tacit-deps.min.js';
import { verifySchnorr } from '../dapp/bulletproofs.js';
import { recoverClaimDigest } from '../dapp/bridge-recover.js';

let n = 0, failures = 0;
const ok = (c, m) => { if (c) { console.log('  ok -', m); n++; } else { console.error('  FAIL -', m); failures++; } };

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const hmacFn = (h, k, ...m) => hmac(nobleSha256, k, Buffer.concat(m.map((x) => Buffer.from(x))));
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const kit = makeBurnDepositKit({ secp, keccak256: keccak_256, sha256 });

const stripHex = (h) => String(h).replace(/^0x/, '');
const revHex = (h) => stripHex(h).match(/../g).reverse().join('');
const withHex = (h) => '0x' + stripHex(h);
const hexToBytes = (h) => { const s = stripHex(h); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; };
const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
// The real hash160-based p2wpkh script, matching dapp/bitcoin-taproot-wallet.js exactly — needed only for the
// preflight() ownership check, which (unlike the rest of this world's stubbed chain state) runs the app's
// actual p2wpkhScript rather than a stand-in.
const realWpkhSpkHexOf = (pub) => bytesToHex(new Uint8Array([0x00, 0x14, ...ripemd160(sha256(pub))]));

// ---- load dapp/tacit.js under a DOM shim for the pure cxfer/BPP helpers only (see burn-deposit-reveal.js's
// own header comment on why only these, never anything wallet-stateful, come from tacit.js) ----
const realFetch = globalThis.fetch, realST = globalThis.setTimeout, realCT = globalThis.clearTimeout;
await import('../scratchpad/domshim2.mjs');
globalThis.setTimeout = realST; globalThis.clearTimeout = realCT;
const tacit = await import('../dapp/tacit.js');
const { encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf, encryptAmount, signSchnorr, modN } = tacit;
globalThis.fetch = realFetch;

const ASSET = withHex('a5'.repeat(32));
const WALLET_PRIV = new Uint8Array(32).fill(0x22);
const WALLET_PUB = secp.getPublicKey(WALLET_PRIV, true);
const NOTE_TXID = '5e'.repeat(31) + '02';
const NOTE_VOUT = 0;
const NOTE_AMOUNT = 900_000n, NOTE_BLINDING = 0x88888888n, NOTE_SATS = 1_000;
const FUND_TXID_1 = '61'.repeat(32);
const FUND_TXID_2 = '62'.repeat(32);
const BASE_RATE = 3;

// ---- an in-memory "world": chain state + worker/MARA endpoints, all driven by this test ----
function makeWorld() {
  const chainTxs = new Map(); // txid(display, bare) -> {confirmed, vout:[{scriptpubkey}]}
  const broadcasts = [];
  const registered = [];
  let migrateConfirmed = false, burnSubmitted = null, burnConfirmed = false, burnFolded = false, burnRegistered = false;
  let submitStatus = 'success';
  let registerConflict = false;
  // The reflection's attested state as /reflection/dump serves it: the live set (outpoint keys) and the burns it
  // recorded (destination leaves). A burn checked through /reflection/burndep/check is recorded once folded, unless
  // recordBurns is off.
  const liveKeys = new Set(), checkedDests = [];
  let recordBurns = true, noteHeight = 800;
  const recoverPosts = [], recoverState = new Map();

  const wpkhSpkOf = (pub) => bytesToHex(new Uint8Array([0x00, 0x14, ...ripemd160ish(pub)]));
  // A real HASH160 isn't needed for these tests — only byte-equality between "what the source pays" and
  // "what the wallet's own p2wpkhScript computes" matters, and both sides go through this same stand-in.
  function ripemd160ish(pub) { return sha256(pub).subarray(0, 20); }

  chainTxs.set(NOTE_TXID, { confirmed: true, vout: [{ scriptpubkey: wpkhSpkOf(WALLET_PUB).replace(/^0x/, '') }] });

  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    const json = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) });

    if (u.hostname === 'slipstream.mara.com') {
      if (u.pathname === '/api/transactions') { broadcasts.push({ mara: body.tx_hex }); return json({ status: submitStatus, message: submitStatus }); }
      if (u.pathname === '/api/rates') return json({ market_rate: 1, effective_rate: 1, submit_fee_rate: 1, multiplier: 1, discounted_multiplier: 1, multiplier_discount_percent: 0, slipstream_rate: 1 });
      throw new Error('world: unstubbed MARA path ' + u.pathname);
    }

    if (u.pathname === '/reflection/burndep/trace') {
      // One hop: whatever note is being traced was produced by a cxfer whose first input is the ORIGINAL
      // source note — good enough for both the initial trace (asset id's own etch path is irrelevant to
      // burndep-ux's own logic) and the migrate-confirmed -> traced hop.
      return json({ ok: true, hops: 1, bundle: { etch: { tx: '0x00', blockHash: 'aa'.repeat(32) }, cxfers: [{ tx: '0x00', txid: withHex('bb'.repeat(32)), inputs: [{ prevTxid: withHex(NOTE_TXID), prevVout: 0 }], outputs: [], rangeProof: '0x', kernelSig: '0x' }] } });
    }
    if (u.pathname === '/reflection/burndep/check') {
      const d = body && body.burnTxHex ? classifyConfidentialTx(withHex(body.burnTxHex)) : null;
      if (d && d.dest) checkedDests.push(String(d.dest).toLowerCase());
      return json({ ok: true, admitted: true, reason: 'admitted' });
    }
    if (u.pathname === '/reflection/dump') {
      const dests = burnFolded && recordBurns ? checkedDests : [];
      return json({ attestedHeight: 1000, snapshot: { height: 1000, liveTriples: [...liveKeys].map((k) => [k, '0x00', ASSET, '0x00', 0]),
        burnNodes: [['0x' + '00'.repeat(32), '0x' + '00'.repeat(32), '0x' + '00'.repeat(32), true], ...dests.map((d) => ['0x' + '11'.repeat(32), '0x' + '00'.repeat(32), d, true])],
        pendingDepositRecords: [] } });
    }
    if (u.pathname === '/bridge/recover') {
      if (opts && opts.method === 'POST') {
        recoverPosts.push(body);
        if (!recoverState.has(body.burnTxid)) recoverState.set(body.burnTxid, { status: 'queued', txid: null });
        return json({ ok: true, ...recoverState.get(body.burnTxid) });
      }
      const c = recoverState.get(stripHex(u.searchParams.get('burn') || ''));
      return json(c ? { ok: true, ...c } : { ok: true, status: 'none' });
    }
    if (u.pathname === '/reflection/burndep') {
      // A first-writer-wins conflict against a DIFFERENT bundle already stored for this exact burn txid — an
      // identical resubmission is never modeled here since the real door returns 200 {ok:true} for that case
      // and this world's default (registerConflict=false) already does the same.
      if (registerConflict) return json({ ok: false, error: 'a different bundle is already registered for this burn txid' }, 409);
      registered.push(body); burnRegistered = true; return json({ ok: true, stored: 'k' });
    }
    if (u.pathname === '/reflection/burndep/status') {
      const txid = u.searchParams.get('txid');
      if (txid === undefined) throw new Error('world: status needs txid');
      if (stripHex(txid) === stripHex(burnSubmitted || '')) {
        if (burnFolded) return json({ ok: true, status: 'folded', burnBlockHeight: 900 });
        if (burnConfirmed) return json({ ok: true, status: burnRegistered ? 'pending' : 'awaiting-scan', registered: burnRegistered });
        return json({ ok: true, status: 'unconfirmed' });
      }
      // any other txid queried is a migrate-reveal-shaped check
      return json({ ok: true, status: migrateConfirmed ? 'folded' : 'unconfirmed' });
    }
    if (u.pathname.startsWith('/chain/tx/')) {
      const txid = u.pathname.slice('/chain/tx/'.length);
      const rec = chainTxs.get(stripHex(txid));
      // Once the migrate confirms, its reveal (the burn-home) is on chain; its script is set by setBurnHomeOnChain.
      if (!rec && migrateConfirmed) return json({ status: { confirmed: true, block_height: noteHeight }, vout: [] });
      if (!rec) throw new Error('world: unknown chain tx ' + txid);
      return json({ status: { confirmed: rec.confirmed, block_height: noteHeight }, vout: rec.vout });
    }
    throw new Error('world: unstubbed path ' + u.pathname + ' ' + u.hostname);
  };

  const chain = {
    getUtxos: async (addr) => [{ txid: FUND_TXID_2, vout: 0, value: 5_000 }],
    pickSafeCommitSats: async (utxos) => utxos,
    broadcast: async (hex) => { broadcasts.push({ chain: hex }); return 'txid'; },
    broadcastWithRetry: async (hex) => { broadcasts.push({ chain: hex }); return 'txid'; },
    getFeeRate: async () => BASE_RATE,
  };

  const bridgeMintCalls = [];
  const bridgeMint = {
    // Mirrors confidential-bridge-mint.js's own recovery check (lines 211-212) — a stub that accepts anything
    // is exactly how the wrong { ownerPub, secret } shape here shipped unnoticed: nothing caught it short of a
    // real mint against the live module.
    bridgeMint: async (args) => {
      const r = args.recovery;
      if (!r || (!r.seedDerived && r.ownerPub == null)) throw new Error("bridge-mint: pass recovery { ownerPub, secret } or { seedDerived: true } so the minted note stays recoverable");
      bridgeMintCalls.push(args);
      // Mirrors confidential-relay.js's real shape: onJob once the job is accepted, onUpdate as its status
      // moves — the only way a caller finds out this call isn't hung during the tens of seconds a real mint
      // spends fetching a multi-MB snapshot and waiting on network proving.
      const w = args.waitOpts || {};
      if (w.onJob) w.onJob('job1', 'bridgemint');
      if (w.onUpdate) { w.onUpdate({ status: 'pending' }); w.onUpdate({ status: 'proving' }); w.onUpdate({ status: 'settled' }); }
      return { jobId: 'job1', txHash: '0x' + 'cd'.repeat(32) };
    },
  };

  return {
    fetchImpl, chain, bridgeMint, broadcasts, registered, bridgeMintCalls, recoverPosts,
    setRecoverStatus: (burn, status, txid = null) => recoverState.set(burn, { status, txid }),
    setMigrateConfirmed: (v) => { migrateConfirmed = v; },
    setBurnSubmitted: (txid) => { burnSubmitted = txid; },
    setBurnConfirmed: (v) => { burnConfirmed = v; },
    setBurnFolded: (v) => { burnFolded = v; },
    setBurnHomeOnChain: (txid, spkHex) => chainTxs.set(stripHex(txid), { confirmed: true, vout: [{ scriptpubkey: stripHex(spkHex) }] }),
    setSubmitStatus: (s) => { submitStatus = s; },
    setRegisterConflict: (v) => { registerConflict = v; },
    setLive: (txid, vout) => liveKeys.add(String(pool.outpointKey(withHex(stripHex(txid).match(/../g).reverse().join('')), vout)).toLowerCase()),
    setRecordBurns: (v) => { recordBurns = v; },
    setNoteHeight: (h) => { noteHeight = h; },
  };
}

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

function makeUx(world, storage) {
  return makeBurnDepositUx({
    network: 'signet', hrp: 'tb', workerBase: 'https://worker.example', fetchImpl: world.fetchImpl, storage,
    secp, sha256, keccak256: keccak_256, hmac: hmacFn, pool, bridgeMint: world.bridgeMint,
    chainBindingHex: () => '7c'.repeat(32), tacAssetId: ASSET, chain: world.chain,
    encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf, encryptAmount, signSchnorr, modN,
  });
}

// ==== eligibility ====
{
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  const holdings = [
    { txid: NOTE_TXID, vout: 0, assetId: ASSET, amount: NOTE_AMOUNT, confirmed: true },
    { txid: 'aa'.repeat(32), vout: 0, assetId: ASSET, amount: BURNDEP_BETA_CAP_RAW + 1n, confirmed: true },
    { txid: 'bb'.repeat(32), vout: 0, assetId: withHex('ff'.repeat(32)), amount: 1n, confirmed: true },
    { txid: 'cc'.repeat(32), vout: 0, assetId: ASSET, amount: 1n, confirmed: false },
    { txid: 'dd'.repeat(32), vout: 0, assetId: ASSET, amount: 1n, confirmed: true, stealth: true },
    { txid: 'd1'.repeat(32), vout: 0, assetId: ASSET, amount: 1n, confirmed: true, stealth: true, stealthTweakedSk: bytesToHex(new Uint8Array(32).fill(0x33)) },
    // dapp/tacit.js's real bridge-eth click handler passes a holding's assetId bare-hex (its button's own
    // data-aid) while tacAssetId itself is wired in 0x-prefixed (_burndepUxSingleton) — a real note must not
    // be called "not TAC" just because the two sides disagree on a leading 0x.
    { txid: 'ee'.repeat(32), vout: 0, assetId: stripHex(ASSET), amount: 1n, confirmed: true },
  ];
  const list = ux.eligibleNotes(holdings);
  ok(list[0].eligible === true, 'an ordinary confirmed TAC note under the cap is eligible');
  ok(list[1].eligible === false && /1,000 TAC/.test(list[1].reason), 'a note over the cap is ineligible with a clear reason');
  ok(list[2].eligible === false && list[2].reason === 'not TAC', 'a non-TAC note is ineligible');
  ok(list[3].eligible === false && list[3].reason === 'unconfirmed', 'an unconfirmed note is ineligible');
  ok(list[4].eligible === false && /stealth/.test(list[4].reason), 'a stealth-received note with no recovered spend key is ineligible (defensive fallback — scanHoldings should never actually produce this)');
  ok(list[5].eligible === true && list[5].stealthTweakedSk, 'a stealth-received note WITH its spend key is eligible — bridging a stealth note is supported, not blanket-excluded');
  ok(list[6].eligible === true, 'a bare-hex TAC assetId is still recognized as TAC against a 0x-prefixed tacAssetId');
  ok(n > 0, 'eligibleNotes checks ran');
}

// ==== stealth-received note: it sits on chain at P2WPKH(stealthPub), not P2WPKH(WALLET_PUB) — preflight's
// ownership check and start()'s signing must both use the note's own tweaked key (carried as
// note.stealthTweakedSk, exactly as eligibleNotes documents), never walletPriv itself. The deep cryptographic
// proof that ONLY the note's own input signs under the alternate key (funding/envelope/change/burn-home all
// stay on walletPriv) lives in tests/burn-deposit-reveal.test.mjs; this checks the integration wiring above it.
{
  const world = makeWorld();
  const STEALTH_PRIV = new Uint8Array(32).fill(0x44); // stands in for a real tweaked_sk = walletPriv + b mod N
  const stealthPub = secp.getPublicKey(STEALTH_PRIV, true);
  const STEALTH_NOTE_TXID = '5e'.repeat(31) + '09';
  world.setBurnHomeOnChain(STEALTH_NOTE_TXID, realWpkhSpkHexOf(stealthPub)); // the note's REAL on-chain script
  const storage = makeMemStorage();
  const ux = makeUx(world, storage);
  const stealthNote = { txid: STEALTH_NOTE_TXID, vout: 0, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING, stealthTweakedSk: bytesToHex(STEALTH_PRIV) };

  const pfMissingKey = await ux.preflight({ note: { ...stealthNote, stealthTweakedSk: undefined }, walletPub: WALLET_PUB });
  const ownStepMissing = pfMissingKey.steps.find((s) => s.name === 'source-ownership');
  ok(!!ownStepMissing && ownStepMissing.ok === false, "sanity: without stealthTweakedSk, preflight checks ownership against walletPub and correctly rejects this note (proves the check below isn't vacuously true)");

  const pf = await ux.preflight({ note: stealthNote, walletPub: WALLET_PUB });
  const ownStep = pf.steps.find((s) => s.name === 'source-ownership');
  ok(!!ownStep && ownStep.ok === true, "preflight's ownership check passes against the note's OWN tweaked pubkey when stealthTweakedSk is present");

  const r = await ux.start({ note: stealthNote, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  ok(r.stage === 'migrate-signed', 'start() builds and signs a migrate for a stealth-received note without throwing');
  const stealthPubHex = bytesToHex(stealthPub).slice(2).toLowerCase();
  ok(r.migrate.revealHex.toLowerCase().includes(stealthPubHex), "the signed migrate reveal's witness carries the note's own stealth pubkey (full per-input signing proof lives in tests/burn-deposit-reveal.test.mjs)");
}

// ==== full happy path: migrate-signed -> ... -> minted ====
let rec;
{
  const world = makeWorld();
  const storage = makeMemStorage();
  const ux = makeUx(world, storage);

  rec = await ux.start({
    note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING },
    walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE,
  });
  ok(rec.stage === 'migrate-signed', 'start() produces a migrate-signed record');
  ok(broadcastsSoFar(world) === 0, 'start() signs but does not broadcast anything');
  const beforeAdvance = storage._raw.get(Array.from(storage._raw.keys())[0]);
  ok(typeof beforeAdvance === 'string' && beforeAdvance.length > 0, 'the record is journalled before any broadcast happens');

  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'migrate-sent', 'advance() broadcasts the migrate commit+reveal and moves to migrate-sent');
  ok(world.broadcasts.length === 2 && world.broadcasts.every((b) => b.chain), 'both the commit and reveal were broadcast via chain.broadcastWithRetry');

  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'migrate-sent', 'advance() stays at migrate-sent while unconfirmed');
  world.setMigrateConfirmed(true);
  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'migrate-confirmed', 'advance() moves to migrate-confirmed once the reveal confirms');

  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'traced' && Array.isArray(rec.bundle.cxfers), 'advance() traces the burn-home and moves to traced');

  world.setBurnHomeOnChain(rec.burnHome.txid, rec.burnHome.spk);
  await assert.rejects(() => ux.advance(rec.walletPub, rec.id), /needs the wallet key/, 'advancing past traced without walletPriv is refused');
  rec = await ux.advance(rec.walletPub, rec.id, { walletPriv: WALLET_PRIV });
  ok(rec.stage === 'burn-signed' && rec.envelope && rec.dest, 'advance() with the key signs the burn and moves to burn-signed');
  ok(!JSON.stringify(rec, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).toLowerCase().includes(Buffer.from(WALLET_PRIV).toString('hex')), 'the wallet private key never appears in the journalled record');
  ok(!storageContainsPrivkey(storage, WALLET_PRIV), 'the wallet private key never appears anywhere in storage');

  world.setBurnSubmitted(rec.burn.txid);
  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'burn-submitted', 'advance() submits to MARA and moves to burn-submitted');
  ok(world.broadcasts.some((b) => b.mara), 'the burn was submitted to slipstream');

  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'burn-submitted', 'advance() stays at burn-submitted while unconfirmed');
  world.setBurnConfirmed(true);
  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'burn-mined', 'advance() moves to burn-mined once the burn confirms');

  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'registered' && world.registered.length === 1, 'advance() registers the bundle and moves to registered');

  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'registered', 'advance() stays at registered until the reflection folds it');
  world.setBurnFolded(true);
  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'folded', 'advance() moves to folded once the reflection folds the burn');

  await assert.rejects(() => ux.advance(rec.walletPub, rec.id), /needs the wallet key/, 'minting without walletPriv is refused');
  const progressed = [];
  rec = await ux.advance(rec.walletPub, rec.id, { walletPriv: WALLET_PRIV, onProgress: (p) => progressed.push(p) });
  ok(rec.stage === 'minted', 'advance() with the key mints and reaches the terminal stage');
  ok(world.bridgeMintCalls.length === 1, 'bridgeMint.bridgeMint was called exactly once');
  ok(progressed.some((p) => p.phase === 'fetching-snapshot'), 'onProgress fires before the mint is built, not just at the end');
  ok(progressed.some((p) => p.phase === 'submitted' && p.jobId === 'job1'), "onProgress relays the relay's own onJob (jobId)");
  ok(['pending', 'proving', 'settled'].every((s) => progressed.some((p) => p.phase === 'status' && p.status === s)), "onProgress relays every real status the relay's onUpdate reports, not just the final one");

  const mintArgs = world.bridgeMintCalls[0];
  ok(mintArgs.recovery && mintArgs.recovery.seedDerived === true, "bridgeMint is called with recovery: { seedDerived: true } — dest.blinding came from deriveBridgeMintBlinding, not a memo-sealed secret");
  const expectedSpentTxid = withHex(revHex(rec.burnHome.txid));
  ok(mintArgs.spentTxid.toLowerCase() === expectedSpentTxid.toLowerCase() && mintArgs.spentVout === 0, 'bridgeMint is called with the burn-home outpoint in internal byte order');
  const expectedLeaf = pool.leaf(ASSET, rec.burnHome.cx, rec.burnHome.cy, pool.outpointKey(mintArgs.spentTxid, mintArgs.spentVout));
  const expectedNullifier = pool.nullifier(expectedLeaf);
  ok(rec.envelope.nullifier.toLowerCase() === expectedNullifier.toLowerCase(), "the burn's own envelope nullifier matches sourceLeaf's class-0 formula (confidential-bridge-mint.js) computed independently here");
  const kitLeaf = kit.burnDepositLeaf(ASSET, rec.burnHome.cx, rec.burnHome.cy, mintArgs.spentTxid, mintArgs.spentVout);
  ok(kitLeaf.toLowerCase() === expectedLeaf.toLowerCase(), 'kit.burnDepositLeaf and pool.leaf(...,pool.outpointKey(...)) agree on the same burned-note leaf formula');
  ok(mintArgs.dest.owner.toLowerCase() === rec.dest.owner.toLowerCase() && mintArgs.dest.value === rec.dest.value, 'bridgeMint is called with the exact destination the burn envelope committed to');

  await assert.rejects(() => ux.advance(rec.walletPub, 'no-such-id'), /no bridge record/, 'advancing an unknown record id is refused');

  // ==== recoverFromTxid into an already-folded status: the exact crash a real user hit ("Cannot read
  // properties of undefined (reading 'index')") when their local journal was rebuilt from the burn txid after
  // the bridge had already folded elsewhere. recoverFromTxid never computed `dest`, and the folded->minted
  // handler reads rec.dest.index unconditionally. dest is fully re-derivable from the wallet key alone, so a
  // freshly recovered record must carry the exact same one the original flow computed. ====
  {
    // Layered over the same world: its /reflection/burndep/status stub only ever answers {status}, since
    // nothing else in this file needs `note`/`assetId` — recoverFromTxid specifically needs both to identify
    // which asset and which burn-home a bare txid belongs to.
    const recoverFetch = async (url, opts) => {
      const u = new URL(url);
      if (u.pathname === '/reflection/burndep/status' && stripHex(u.searchParams.get('txid') || '') === stripHex(rec.burn.txid)) {
        const base = await (await world.fetchImpl(url, opts)).json();
        const withExtra = { ...base, note: { txid: withHex(rec.burnHome.txid), vout: 0 }, assetId: ASSET };
        return { ok: true, status: 200, json: async () => withExtra, text: async () => JSON.stringify(withExtra) };
      }
      return world.fetchImpl(url, opts);
    };
    const ux2 = makeUx({ ...world, fetchImpl: recoverFetch }, makeMemStorage()); // a fresh browser: no journal, recovering purely from the txid

    const recovered = await ux2.recoverFromTxid(rec.burn.txid, WALLET_PRIV, { amount: rec.source.amount });
    ok(recovered.stage === 'folded', 'recoverFromTxid on an already-folded burn lands directly on the folded stage');
    ok(!!recovered.dest, "the recovered record carries a dest — this is exactly the field a real user hit missing (Cannot read properties of undefined (reading 'index'))");
    ok(recovered.dest.owner.toLowerCase() === rec.dest.owner.toLowerCase() && recovered.dest.blinding === rec.dest.blinding && recovered.dest.value === rec.dest.value,
      'the recovered dest is byte-identical to what the original flow computed — fully re-derived from the wallet key, nothing guessed');

    const mintedFromRecovery = await ux2.advance(recovered.walletPub, recovered.id, { walletPriv: WALLET_PRIV });
    ok(mintedFromRecovery.stage === 'minted', 'a record recovered straight into folded mints successfully — this is the exact call that used to throw');
  }

  // ==== a record already saved to storage WITHOUT dest (recoverFromTxid's gap before this fix, sitting in a
  // real browser's localStorage right now — the fix above only stops NEW records from being written this way,
  // it does nothing for one already on disk) must still mint: the 'folded' handler self-heals rather than
  // trusting rec.dest to exist. ====
  {
    const storage = makeMemStorage();
    const ux3 = makeUx(world, storage);
    // Same journal format putRecord/loadAll use internally (JOURNAL_PREFIX:network:walletPubLowercase, BigInt
    // fields wrapped as {__big}) — written directly here since a real broken record was never produced by any
    // exported call, only by code that predates this fix.
    // rec is already 'minted' by this point in the file (the happy path ran to completion above) — force it
    // back to 'folded', the actual stage a stuck record like this sits at, and drop the minted-only fields.
    const { dest, stage, mintedAt, mintedJobId, mintedTxHash, ...rest } = { ...rec, walletPub: rec.walletPub.toLowerCase() };
    const brokenRec = { ...rest, stage: 'folded' };
    const wrapBig = (k, v) => (typeof v === 'bigint' && ['amount', 'blinding', 'value'].includes(k) ? { __big: v.toString() } : v);
    storage.setItem(`tacit-burndep-bridge-v1:signet:${brokenRec.walletPub}`, JSON.stringify([brokenRec], wrapBig));

    const stuck = ux3.list(rec.walletPub).find((r) => r.id === rec.id);
    ok(!!stuck && stuck.stage === 'folded' && !stuck.dest, 'sanity: the hand-written record is folded with no dest, matching a real pre-fix save');

    const healed = await ux3.advance(rec.walletPub, rec.id, { walletPriv: WALLET_PRIV });
    ok(healed.stage === 'minted', 'advance() on a pre-existing record with no dest at all still mints — the fix self-heals rather than requiring a fresh recoverFromTxid');
    ok(!!healed.dest && healed.dest.owner.toLowerCase() === dest.owner.toLowerCase() && healed.dest.blinding === dest.blinding, 'the self-healed dest matches the original — derived, not guessed');
  }
}

// ==== resume after a simulated crash: a fresh instance, same storage, never re-signs ====
{
  const world = makeWorld();
  const storage = makeMemStorage();
  const ux1 = makeUx(world, storage);
  let r = await ux1.start({
    note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING },
    walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE,
  });
  const migrateHexBefore = r.migrate.revealHex;
  r = await ux1.advance(r.walletPub, r.id); // migrate-sent

  // "the tab closes" — a fresh burndep-ux instance over the SAME storage picks up the record as-is.
  const ux2 = makeUx(world, storage);
  const resumed = ux2.list(r.walletPub).find((x) => x.id === r.id);
  ok(!!resumed && resumed.stage === 'migrate-sent', 'a fresh instance over the same storage sees the in-flight record');
  ok(resumed.migrate.revealHex === migrateHexBefore, 'the journalled migrate reveal is byte-identical after resume — never rebuilt');

  const before = world.broadcasts.length;
  const again = await ux2.advance(resumed.walletPub, resumed.id); // still unconfirmed -> re-sends, no state change
  ok(again.stage === 'migrate-sent', 'resuming an unconfirmed migrate stays at migrate-sent');
  ok(world.broadcasts.length > before, 'resuming an unconfirmed migrate re-sends the identical (already-journalled) bytes rather than rebuilding');
}

// ==== hop-limit refusal (post-migrate: the burn-home is always one hop deeper than its source) ====
{
  const world = makeWorld();
  world.fetchImpl0 = world.fetchImpl;
  const overLimitFetch = async (url, opts) => {
    const u = new URL(url);
    if (u.pathname === '/reflection/burndep/trace') {
      return { ok: true, json: async () => ({ ok: true, hops: 65, bundle: { etch: {}, cxfers: new Array(65).fill({ inputs: [{ prevTxid: withHex(NOTE_TXID), prevVout: 0 }] }) } }) };
    }
    return world.fetchImpl0(url, opts);
  };
  const storage = makeMemStorage();
  const ux = makeUx({ ...world, fetchImpl: overLimitFetch }, storage);
  let r = await ux.start({
    note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING },
    walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE,
  });
  r = await ux.advance(r.walletPub, r.id);
  world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); // -> migrate-confirmed
  await assert.rejects(() => ux.advance(r.walletPub, r.id), /over the 64-hop limit/, 'refuses a hop-limit violation');
  ok(true, 'a burn-home tracing over the hop limit is refused rather than silently proceeding');
}

// ==== hop-limit boundary: a source note at exactly the 63-hop preflight limit produces a burn-home at exactly
// 64 hops (the migrate itself is one more hop), and neither check may reject the other's own limit ====
{
  const world = makeWorld();
  world.setBurnHomeOnChain(NOTE_TXID, realWpkhSpkHexOf(WALLET_PUB)); // preflight's ownership check needs the real hash160, not the world's cheap stand-in
  world.fetchImpl0 = world.fetchImpl;
  let burnHomeTxidForMock = null;
  const boundaryFetch = async (url, opts) => {
    const u = new URL(url);
    if (u.pathname === '/reflection/burndep/trace') {
      const body = JSON.parse(opts.body);
      const tracedTxid = stripHex(body.note.txid);
      const hops = burnHomeTxidForMock && tracedTxid === stripHex(burnHomeTxidForMock) ? 64 : 63;
      return { ok: true, json: async () => ({ ok: true, hops, bundle: { etch: {}, cxfers: new Array(hops).fill({ inputs: [{ prevTxid: withHex(NOTE_TXID), prevVout: 0 }] }) } }) };
    }
    return world.fetchImpl0(url, opts);
  };
  const storage = makeMemStorage();
  const ux = makeUx({ ...world, fetchImpl: boundaryFetch }, storage);

  const pf = await ux.preflight({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPub: WALLET_PUB });
  const traceStep = pf.steps.find((s) => s.name === 'trace');
  ok(!!traceStep && traceStep.ok, 'preflight accepts a source note at exactly the 63-hop limit');

  let r = await ux.start({
    note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING },
    walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE,
  });
  burnHomeTxidForMock = r.burnHome.txid;
  r = await ux.advance(r.walletPub, r.id); // migrate-sent
  world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); // migrate-confirmed
  r = await ux.advance(r.walletPub, r.id); // -> traced (must NOT be refused at exactly 64 hops)
  ok(r.stage === 'traced' && r.hops === 64, "a 64-hop burn-home — one more than its source's own 63 — is accepted, not refused as if it shared the source's limit");
}

// ==== cap refusal in start() ====
{
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  await assert.rejects(
    () => ux.start({
      note: { txid: NOTE_TXID, vout: 0, sats: NOTE_SATS, amount: BURNDEP_BETA_CAP_RAW + 1n, blinding: NOTE_BLINDING },
      walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 },
    }),
    /over the beta cap/,
    'refuses over-cap',
  );
  ok(true, 'start() refuses a note over the beta cap before signing anything');
}

// ==== MARA refusal is surfaced, not silently swallowed ====
{
  const world = makeWorld();
  world.setSubmitStatus('error');
  const storage = makeMemStorage();
  const ux = makeUx(world, storage);
  let r = await ux.start({
    note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING },
    walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE,
  });
  r = await ux.advance(r.walletPub, r.id);
  world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id);
  r = await ux.advance(r.walletPub, r.id);
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV }); // burn-signed
  await assert.rejects(() => ux.advance(r.walletPub, r.id), /slipstream submit refused/, 'a MARA status!==success response is surfaced as a real error, not treated as submitted');
  const stillAt = ux.list(r.walletPub).find((x) => x.id === r.id);
  ok(stillAt.stage === 'burn-signed', 'a refused MARA submission does not advance the stage');
}

// ==== a registration conflict against a DIFFERENT already-stored bundle propagates rather than being swallowed
// (the worker's own door already treats an identical resubmission as a no-op 200, so anything advance() sees
// thrown here is a genuine, unresolvable conflict) — and advance() records/clears lastError+errorCount so a
// background poller has somewhere to surface a bridge that can never proceed on its own ====
{
  const world = makeWorld();
  world.setRegisterConflict(true);
  const storage = makeMemStorage();
  const ux = makeUx(world, storage);
  let r = await ux.start({
    note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING },
    walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE,
  });
  r = await ux.advance(r.walletPub, r.id); // migrate-sent
  world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); // migrate-confirmed
  r = await ux.advance(r.walletPub, r.id); // traced
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV }); // burn-signed
  world.setBurnSubmitted(r.burn.txid);
  r = await ux.advance(r.walletPub, r.id); // burn-submitted
  world.setBurnConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); // burn-mined

  await assert.rejects(() => ux.advance(r.walletPub, r.id), /registration failed/, 'a registration conflict against a different stored bundle is thrown, not swallowed');
  let stuck = ux.list(r.walletPub).find((x) => x.id === r.id);
  ok(stuck.stage === 'burn-mined', 'the record stays at burn-mined rather than silently advancing past a failed registration');
  ok(!!stuck.lastError && /registration failed/.test(stuck.lastError.message) && stuck.errorCount === 1, 'advance() records the failure on the record itself (lastError/errorCount)');

  await assert.rejects(() => ux.advance(r.walletPub, r.id), /registration failed/, 'the same conflict is thrown again on a second attempt');
  stuck = ux.list(r.walletPub).find((x) => x.id === r.id);
  ok(stuck.errorCount === 2, 'a repeated failure increments errorCount rather than resetting it');

  world.setRegisterConflict(false);
  r = await ux.advance(r.walletPub, r.id); // registered, this time
  ok(r.stage === 'registered', 'once the conflict clears, advance() proceeds normally');
  ok(r.lastError === null && r.errorCount === 0, 'a subsequent success clears lastError/errorCount from the record');
}

// ==== cross-tab lease ====
{
  const world = makeWorld();
  const storage = makeMemStorage();
  const ux = makeUx(world, storage);
  let r = await ux.start({
    note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING },
    walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE,
  });
  // Simulate another tab holding the lease right now.
  storage.setItem(`tacit-burndep-bridge-v1:lease:signet:${r.id}`, JSON.stringify({ owner: 'other-tab', at: Date.now() }));
  await assert.rejects(() => ux.advance(r.walletPub, r.id), /being advanced in another tab/, 'advance() refuses while another tab holds a fresh lease');
  // A stale lease (past the TTL) is treated as free.
  storage.setItem(`tacit-burndep-bridge-v1:lease:signet:${r.id}`, JSON.stringify({ owner: 'other-tab', at: Date.now() - 60_000 }));
  const advanced = await ux.advance(r.walletPub, r.id);
  ok(advanced.stage === 'migrate-sent', 'a stale lease from a crashed tab does not permanently strand the record');
}

// ==== reservation across the whole browser, not just one wallet ====
{
  const world = makeWorld();
  const storage = makeMemStorage();
  const ux = makeUx(world, storage);
  await ux.start({
    note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING },
    walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE,
  });
  ok(ux.isReserved(NOTE_TXID, NOTE_VOUT) === true, 'the source note is reserved once a bridge exists for it');
  ok(ux.isReserved(FUND_TXID_1, 0) === true, "the migrate's own funding UTXO is reserved too, so Send can't spend it out from under the bridge");
  ok(ux.isReserved('ff'.repeat(32), 0) === false, 'an unrelated outpoint is not reserved');
}


// ==== TAC the reflection already tracks ====
// Preflight: a tracked source note is refused before anything is signed.
{
  const world = makeWorld();
  world.setLive(NOTE_TXID, NOTE_VOUT);
  world.setBurnHomeOnChain(NOTE_TXID, '0014' + Buffer.from(ripemd160(nobleSha256(WALLET_PUB))).toString('hex'));   // the wallet's real P2WPKH
  const ux = makeUx(world, makeMemStorage());
  const pf = await ux.preflight({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPub: WALLET_PUB });
  const st = pf.steps.find((x) => x.name === 'not-tracked');
  ok(pf.ok === false && st && st.ok === false && /takes a different bridge path/.test(st.detail), 'preflight refuses a note the reflection already tracks, with a plain reason');
  ok(world.broadcasts.length === 0, 'nothing is broadcast for a tracked note');
}
// A bridge whose burn-home is tracked pauses before its burn; its TAC goes back to the wallet.
{
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  let r = await ux.start({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id);
  world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'migrate-confirmed', 'sanity: the migrate confirmed');
  world.setLive(r.burnHome.txid, 0);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'stopped' && r.stoppedWhy === 'tracked', 'a tracked burn-home pauses the bridge before any burn is built');
  const again = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  ok(again.stage === 'stopped' && !world.broadcasts.some((b) => b.mara), 'a paused bridge never builds or sends a burn');
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  const before = world.broadcasts.length;
  r = await ux.reclaim({ rec: again, walletPriv: WALLET_PRIV });
  ok(r.stage === 'reclaim-sent' && world.broadcasts.length === before + 2, 'reclaim builds and sends the move back to the wallet (commit and reveal)');
  ok(classifyConfidentialTx(withHex(r.reclaim.revealHex))?.type === 'cxfer', 'the move back is an ordinary confidential transfer');
}
// A burn signed before the check is held back while its burn-home is tracked.
{
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  let r = await ux.start({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id); world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  ok(r.stage === 'burn-signed', 'sanity: the burn was signed while the burn-home was untracked');
  world.setLive(r.burnHome.txid, 0);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'stopped' && !world.broadcasts.some((b) => b.mara), 'a signed burn is not sent once its burn-home is tracked');
}
// A burn the reflection passed without recording is not offered for minting.
{
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  let r = await ux.start({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id); world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  world.setBurnSubmitted(r.burn.txid);
  r = await ux.advance(r.walletPub, r.id); world.setBurnConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'registered', 'sanity: registered');
  world.setRecordBurns(false); world.setBurnFolded(true);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'not-recorded', 'a burn the attested state does not record is marked not mintable instead of ready to mint');
  ok(world.bridgeMintCalls.length === 0, 'no mint is attempted for it');
}
// A record already at "ready to mint" (saved before the check) is corrected, by a click or by the background check.
{
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  let r = await ux.start({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id); world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  world.setBurnSubmitted(r.burn.txid);
  r = await ux.advance(r.walletPub, r.id); world.setBurnConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  world.setBurnFolded(true);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'folded', 'sanity: a recorded burn reaches ready to mint');
  world.setRecordBurns(false);
  const v = await ux.verify(r.walletPub, r.id);
  ok(v.stage === 'not-recorded', 'the background check corrects a ready-to-mint record whose burn is not recorded');
  ok(world.bridgeMintCalls.length === 0, 'and never mints it');
}

// A bridge that did not complete is recovered: the wallet signs a claim that opens the burned note, and the record
// follows the claim until the TAC is sent back.
{
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  let r = await ux.start({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  r = await ux.advance(r.walletPub, r.id); world.setMigrateConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  world.setBurnHomeOnChain(r.burnHome.txid, r.burnHome.spk);
  r = await ux.advance(r.walletPub, r.id, { walletPriv: WALLET_PRIV });
  world.setBurnSubmitted(r.burn.txid);
  r = await ux.advance(r.walletPub, r.id); world.setBurnConfirmed(true);
  r = await ux.advance(r.walletPub, r.id); r = await ux.advance(r.walletPub, r.id);
  world.setRecordBurns(false); world.setBurnFolded(true);
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'not-recorded', 'sanity: not recorded');
  let refused = false;
  try { await ux.recover({ rec: r, walletPriv: new Uint8Array(32).fill(0x23) }); } catch { refused = true; }
  ok(refused && world.recoverPosts.length === 0, 'another key cannot start a recovery for this wallet’s bridge');
  r = await ux.recover({ rec: r, walletPriv: WALLET_PRIV });
  ok(r.stage === 'recovering', 'recover starts the recovery');
  const claim = world.recoverPosts[0];
  ok(claim.burnTxid === stripHex(r.burn.txid).toLowerCase() && claim.amount === String(NOTE_AMOUNT), 'the claim names the burn and the amount it carried');
  const opened = pool.commitXY(BigInt(claim.amount), BigInt(claim.blinding));
  ok(BigInt(opened.cx) === BigInt(r.burnHome.cx) && BigInt(opened.cy) === BigInt(r.burnHome.cy), 'its opening opens the burned note');
  ok(claim.pubkey === Buffer.from(WALLET_PUB).toString('hex') && verifySchnorr(hexToBytes(claim.sig), recoverClaimDigest(sha256, claim), hexToBytes(claim.pubkey).slice(1)), 'it is signed by the wallet key');
  r = await ux.advance(r.walletPub, r.id);
  ok(r.stage === 'recovering' && r.recover.status === 'queued', 'it waits while the claim is queued');
  world.setRecoverStatus(claim.burnTxid, 'sent', 'ab'.repeat(32));
  r = await ux.verify(r.walletPub, r.id);
  ok(r.stage === 'recovered' && r.recover.txid === 'ab'.repeat(32), 'the background check moves it to recovered, with the transaction that sent it');
  let threw = false;
  try { await ux.recover({ rec: { ...r, stage: 'folded' }, walletPriv: WALLET_PRIV }); } catch { threw = true; }
  ok(threw, 'only a bridge that did not complete can be recovered');
}

// A note newer than the attested state is not judged yet: preflight asks to wait, and a bridge holds before its burn.
{
  const world = makeWorld();
  world.setBurnHomeOnChain(NOTE_TXID, '0014' + Buffer.from(ripemd160(nobleSha256(WALLET_PUB))).toString('hex'));
  world.setNoteHeight(1005);                                   // the reflection is at 1000
  const ux = makeUx(world, makeMemStorage());
  const pf = await ux.preflight({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPub: WALLET_PUB });
  const st = pf.steps.find((x) => x.name === 'not-tracked');
  ok(pf.ok === false && st && /has not reached the block/.test(st.detail), 'preflight waits when the reflection has not reached the note’s block');
  const world2 = makeWorld();
  const ux2 = makeUx(world2, makeMemStorage());
  let r = await ux2.start({ note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING }, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID_1, vout: 0, value: 30_000 }, feeRate: BASE_RATE });
  r = await ux2.advance(r.walletPub, r.id); world2.setMigrateConfirmed(true);
  r = await ux2.advance(r.walletPub, r.id);
  world2.setNoteHeight(1005);
  r = await ux2.advance(r.walletPub, r.id);
  ok(r.stage === 'migrate-confirmed', 'a bridge holds before tracing and burning until the reflection reaches the move’s block');
  world2.setNoteHeight(990);
  r = await ux2.advance(r.walletPub, r.id);
  ok(r.stage === 'traced', 'and continues once it has, the burn-home untracked');
}

function broadcastsSoFar(world) { return world.broadcasts.length; }
function storageContainsPrivkey(storage, priv) {
  const hex = Buffer.from(priv).toString('hex');
  for (const [, v] of storage._raw) if (String(v).toLowerCase().includes(hex)) return true;
  return false;
}

console.log(failures ? `\n${failures} FAILURES (${n} passed)` : `\nall ${n} burndep-ux checks passed`);
process.exit(failures ? 1 : 0);
