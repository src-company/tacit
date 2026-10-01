// Prototype harness for holding.circom (not wired into any build): one honest proof, then the invalid inputs the circuit and the verifier must refuse.
// From dapp/circuits/evm-pool:
//   circom holding.circom --r1cs --wasm --sym -o build
//   snarkjs groth16 setup build/holding.r1cs ceremony/pot16.ptau build/h0.zkey
//   snarkjs zkey contribute build/h0.zkey build/holding_dev.zkey --name=dev -e="<entropy>"   # single-party: dev only
//   snarkjs zkey export verificationkey build/holding_dev.zkey build/vk.json
//   node holding.test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { buildPoseidon, newMemEmptyTrie } from 'circomlibjs';
import * as snarkjs from 'snarkjs';
import { makeBtcPoolZk, mulB8, L_BJJ, P_FR } from '../../btc-pool-zk.js';
import { makeEvmPoolZk } from '../../evm-pool-zk.js';

const WASM = 'build/holding_js/holding.wasm';
const ZKEY = 'build/holding_dev.zkey';
const SMT_LEVELS = 40;
const TAG_RET = 0x686f6c645f726574n;
const TAG_SIG = 0x686f6c645f736967n;
const ETH = 10n ** 18n;

process.on('unhandledRejection', (e) => { console.error('FAIL', e); process.exit(1); });
const P = await buildPoseidon();
const poseidon = (xs) => P.F.toObject(P(xs.map(BigInt)));
const base = makeBtcPoolZk({ poseidon });
const evm = makeEvmPoolZk({ poseidon });
const { H, npkOf, nullifier, sign } = base;
const { leafOf, tree } = evm;

const rnd = (m) => { let x = 0n; while (x === 0n) x = BigInt('0x' + crypto.randomBytes(32).toString('hex')) % m; return x; };
const str = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
const asset = rnd(P_FR);

function makeNote(v) {
  const sk = rnd(L_BJJ), nk = rnd(L_BJJ), rho = rnd(P_FR);
  const Ak = mulB8(sk);
  return { sk, nk, rho, v, Ak, npk: npkOf(Ak, mulB8(nk)) };
}
const leafFor = (n) => leafOf(asset, n.v, n.npk, n.rho);

// A pool of eight notes, ours at index 3; three of the others already spent.
const notes = Array.from({ length: 8 }, (_, i) => makeNote(i === 3 ? 3n * ETH / 2n : BigInt(i + 1) * ETH / 10n));
const MINE = 3;
const T = tree(notes.map(leafFor));
const trie = await newMemEmptyTrie();
for (const i of [0, 1, 5]) await trie.insert(nullifier(notes[i].nk, leafFor(notes[i]), i), 1n);
const F = (x) => trie.F.toObject(x);
const nfRootOf = (t) => F(t.root);

async function exclusionWitness(t, nf) {
  const r = await t.find(nf);
  const sib = r.siblings.map(F);
  while (sib.length < SMT_LEVELS) sib.push(0n);
  return {
    smtSiblings: sib,
    smtOldKey: r.found ? nf : r.isOld0 ? 0n : F(r.notFoundKey),
    smtOldValue: r.found ? F(r.foundValue) : r.isOld0 ? 0n : F(r.notFoundValue),
    smtIsOld0: r.isOld0 ? 1n : 0n,
  };
}

async function buildInput({ note = notes[MINE], index = MINE, tr = T, t = trie, epoch = 7n, bucketMin = ETH,
  claimHash = rnd(P_FR), signWith = note.sk, signClaim = claimHash, retOverride = null, nkOverride = null, vOverride = null } = {}) {
  const nk = nkOverride ?? note.nk;
  const leaf = leafFor(note);
  const nf = nullifier(note.nk, leaf, index);
  const retNf = retOverride ?? H([TAG_RET, note.nk, leaf, epoch]);
  const nfRoot = nfRootOf(t);
  const M = H([TAG_SIG, asset, epoch, tr.root, nfRoot, bucketMin, signClaim, retNf]);
  const sig = sign(signWith, M);
  return {
    root: tr.root, nfRoot, asset, epoch, bucketMin, claimHash, retNf,
    v: vOverride ?? note.v, rho: note.rho, nk, ak: note.Ak, index, path: tr.path(index),
    sigR8: sig.R8, sigS: sig.S, ...(await exclusionWitness(t, nf)),
  };
}

let ok = 0;
const pass = (m) => { ok++; console.log(`ok - ${m}`); };
const rejects = async (m, input) => {
  let threw = false;
  try { await snarkjs.wtns.calculate(str(input), WASM, { type: 'mem' }); } catch { threw = true; }
  assert.ok(threw, `should have been rejected: ${m}`);
  pass(`circuit rejects: ${m}`);
};

// ── an honest holder proves, and the verifier accepts ──
const vkey = JSON.parse(fs.readFileSync('build/vk.json', 'utf8'));
const input = await buildInput();
let t0 = Date.now();
const { proof, publicSignals } = await snarkjs.groth16.fullProve(str(input), WASM, ZKEY);
const proveMs = Date.now() - t0;
assert.equal(await snarkjs.groth16.verify(vkey, publicSignals, proof), true);
pass(`honest holder: proof verifies (prove ${proveMs} ms in node)`);
assert.deepEqual(publicSignals.map(BigInt), [input.root, input.nfRoot, input.asset, input.epoch, input.bucketMin, input.claimHash, input.retNf]);
pass('public signals are exactly [root, nfRoot, asset, epoch, bucketMin, claimHash, retNf]');

// ── what the verifier must pin, and what a replay does ──
const bad = [...publicSignals]; bad[3] = '8';
assert.equal(await snarkjs.groth16.verify(vkey, bad, proof), false);
pass('replaying a proof under another epoch fails');
const bad2 = [...publicSignals]; bad2[5] = (rnd(P_FR)).toString();
assert.equal(await snarkjs.groth16.verify(vkey, bad2, proof), false);
pass('swapping the claim address on a finished proof fails');

// ── inputs the circuit itself must refuse ──
{ // our note spent: put its nullifier in the set
  const spent = await newMemEmptyTrie();
  for (const i of [0, 1, 5, MINE]) await spent.insert(nullifier(notes[i].nk, leafFor(notes[i]), i), 1n);
  await rejects('a spent note', await buildInput({ t: spent }));
}
await rejects('holding less than the bucket', await buildInput({ bucketMin: 2n * ETH }));
await rejects('a zero bucket', await buildInput({ bucketMin: 0n }));
await rejects('a value outside 120 bits', await buildInput({ vOverride: 1n << 121n, bucketMin: ETH }));
await rejects('a tag that is not this note/epoch', await buildInput({ retOverride: rnd(P_FR) }));
await rejects('a claim address changed after signing', await buildInput({ signClaim: rnd(P_FR) }));
await rejects('someone who lacks the spend key', await buildInput({ signWith: rnd(L_BJJ) }));
await rejects('a note not in the tree', await buildInput({ tr: tree(notes.slice(0, 2).map(leafFor)), index: 1 }));
await rejects('the wrong nullifier key', await buildInput({ nkOverride: rnd(L_BJJ) }));
{ // proving against a nullifier set the verifier does not hold is a pinned-root matter, not a circuit one
  const stale = await newMemEmptyTrie();
  const staleIn = await buildInput({ t: stale });
  await snarkjs.wtns.calculate(str(staleIn), WASM, { type: 'mem' });
  assert.notEqual(staleIn.nfRoot, input.nfRoot);
  pass('a proof against an older/other spent set is valid in-circuit, so the verifier MUST pin nfRoot (it differs here)');
}

// ── privacy properties of the tag ──
{
  const leaf = leafFor(notes[MINE]);
  const nf = nullifier(notes[MINE].nk, leaf, MINE);
  for (const e of [0n, 1n, BigInt(MINE), 7n, 1n << 32n]) assert.notEqual(H([TAG_RET, notes[MINE].nk, leaf, e]), nf);
  pass('the epoch tag never equals the spend nullifier, even when epoch == index');
  const e = 7n;
  const tags = new Set(notes.map((n) => H([TAG_RET, n.nk, leafFor(n), e])));
  assert.equal(tags.size, notes.length);
  pass('two notes in the same epoch get different tags');
  assert.equal(H([TAG_RET, notes[MINE].nk, leaf, e]), H([TAG_RET, notes[MINE].nk, leaf, e]));
  assert.notEqual(H([TAG_RET, notes[MINE].nk, leaf, 7n]), H([TAG_RET, notes[MINE].nk, leaf, 8n]));
  pass('the same note repeats its tag within an epoch (double claim detectable) and differs across epochs (unlinkable)');
}

console.log(`\n${ok} checks passed`);
process.exit(0);
