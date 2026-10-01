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

function makeNote(v, nkSmall = false) {
  const sk = rnd(L_BJJ), nk = nkSmall ? rnd(1n << 200n) : rnd(L_BJJ), rho = rnd(P_FR);
  const Ak = mulB8(sk);
  return { sk, nk, rho, v, Ak, npk: npkOf(Ak, mulB8(nk)) };
}
const leafFor = (n) => leafOf(asset, n.v, n.npk, n.rho);

// A pool of eight notes, ours at index 3; three of the others already spent.
const notes = Array.from({ length: 8 }, (_, i) => makeNote(i === 3 ? 3n * ETH / 2n : BigInt(i + 1) * ETH / 10n, i === 4));   // note 4's nk is small enough that nk + l still fits 251 bits
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
  claimHash = rnd(P_FR), signWith = note.sk, signClaim = claimHash, retOverride = null, nkOverride = null, vOverride = null,
  nkAlt = null, indexAlt = null } = {}) {
  // nkAlt / indexAlt: a second spelling of the same key or position, with the tag and the spent-set witness computed from it,
  // so a refusal can only come from the circuit's own range checks.
  const nk = nkAlt ?? nkOverride ?? note.nk;
  const leaf = leafFor(note);
  const nf = nkAlt != null || indexAlt != null ? poseidon([nkAlt ?? note.nk, leaf, indexAlt ?? index]) : nullifier(note.nk, leaf, index);   // the helper itself refuses a non-canonical key
  const retNf = retOverride ?? H([TAG_RET, nkAlt ?? note.nk, leaf, epoch]);
  const nfRoot = nfRootOf(t);
  const M = H([TAG_SIG, asset, epoch, tr.root, nfRoot, bucketMin, signClaim, retNf]);
  const sig = sign(signWith, M);
  return {
    root: tr.root, nfRoot, asset, epoch, bucketMin, claimHash, retNf,
    v: vOverride ?? note.v, rho: note.rho, nk, ak: note.Ak, index: indexAlt ?? index, path: tr.path(index),
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
{ // nk and nk + l are the same point nk·Base8, so the note's leaf is unchanged, but each would give its own tag: two claims for one note
  const altNk = notes[MINE].nk + L_BJJ;
  assert.equal(mulB8(altNk)[0], mulB8(notes[MINE].nk)[0], 'nk + l is the same key point');
  assert.notEqual(H([TAG_RET, altNk, leafFor(notes[MINE]), 7n]), H([TAG_RET, notes[MINE].nk, leafFor(notes[MINE]), 7n]), 'and would be a second tag for the note');
  await rejects('a second spelling of the nullifier key (nk + l) that would mint a second tag for one note', await buildInput({ nkAlt: altNk }));
}
{ // a key small enough that nk + l fits in 251 bits reaches the less-than-l comparison, the only check left to refuse it
  const small = notes[4], altNk = small.nk + L_BJJ;
  assert.ok(altNk < (1n << 251n) && mulB8(altNk)[0] === mulB8(small.nk)[0]);
  await snarkjs.wtns.calculate(str(await buildInput({ note: small, index: 4, bucketMin: ETH / 10n })), WASM, { type: 'mem' });
  await rejects('nk + l for a key where only the less-than-l comparison can refuse it', await buildInput({ note: small, index: 4, bucketMin: ETH / 10n, nkAlt: altNk }));
}
await rejects('a second spelling of the position (index + 2^32)', await buildInput({ indexAlt: BigInt(MINE) + (1n << 32n) }));
{ // the circuit takes any bucket up to the value, including the value itself: the verifier must restrict buckets to fixed denominations
  const exact = await buildInput({ bucketMin: notes[MINE].v });
  await snarkjs.wtns.calculate(str(exact), WASM, { type: 'mem' });
  pass('the circuit accepts bucketMin == v, which would publish the note value: the verifier MUST allow only fixed denominations');
  const a = await buildInput({ bucketMin: ETH / 2n, epoch: 7n }), b = await buildInput({ bucketMin: ETH, epoch: 7n });
  assert.equal(a.retNf, b.retNf);
  pass('one note gets the same tag whatever bucket it claims, so a note can claim once per epoch, not once per bucket');
}
// ── the exclusion proof must not be forgeable ──
// circomlib's SMTVerifier trusts isOld0 and weights the terminal node by 1 - isOld0. With isOld0 free in the field, a spent note's own
// leaf hash can be dressed as the terminal node of a proof about a key that is not there: pick any oldKey other than the nullifier and
// solve for the isOld0 that makes the node equal the real one. The circuit constrains isOld0 to a bit.
const modP = (x) => ((x % P_FR) + P_FR) % P_FR;
const powP = (b, e) => { let r = 1n; b = modP(b); for (; e > 0n; e >>= 1n) { if (e & 1n) r = (r * b) % P_FR; b = (b * b) % P_FR; } return r; };
const spentSet = async (idx) => { const t = await newMemEmptyTrie(); for (const i of idx) await t.insert(nullifier(notes[i].nk, leafFor(notes[i]), i), 1n); return t; };
const forgedExclusion = async (t, i, { isOld0, oldKey, oldValue }) => {
  const input = await buildInput({ note: notes[i], index: i, t, bucketMin: ETH / 10n });
  return { ...input, smtOldKey: oldKey, smtOldValue: oldValue, smtIsOld0: isOld0 };
};
{
  const spent = await spentSet([0, 1, 3, 5]);
  const nf = nullifier(notes[3].nk, leafFor(notes[3]), 3);
  assert.equal((await spent.find(nf)).found, true);
  const oldKey = nf + 1n, leafHash = poseidon([nf, 1n, 1n]);
  const isOld0 = modP(1n - leafHash * powP(poseidon([oldKey, 0n, 1n]), P_FR - 2n));
  assert.ok(isOld0 > 1n);
  const input = await forgedExclusion(spent, 3, { isOld0, oldKey, oldValue: 0n });
  await rejects('a spent note whose exclusion is forged with an isOld0 that is not a bit', input);
  const attempts = [];
  for (const iz of [0n, 1n, 2n, P_FR - 1n, isOld0, rnd(P_FR)]) for (const ok of [nf + 1n, 0n, nf, rnd(P_FR)]) for (const ov of [0n, 1n, rnd(P_FR)]) attempts.push({ isOld0: iz, oldKey: ok, oldValue: ov });
  let refused = 0;
  for (const a of attempts) {
    let threw = false;
    try { await snarkjs.wtns.calculate(str(await forgedExclusion(spent, 3, a)), WASM, { type: 'mem' }); } catch { threw = true; }
    assert.ok(threw, `a spent note's exclusion was accepted with ${JSON.stringify(str(a))}`);
    refused++;
  }
  pass(`circuit rejects: ${refused} further forged exclusions of a spent note (isOld0, oldKey and oldValue varied)`);
}
for (const spentIdx of [[], [0], [0, 1, 5], [0, 1, 2, 5, 6, 7]]) {
  const set = await spentSet(spentIdx);
  await snarkjs.wtns.calculate(str(await buildInput({ t: set })), WASM, { type: 'mem' });
}
pass('an unspent note is excluded against an empty set and against sets of 1, 3 and 6 spent nullifiers');
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
