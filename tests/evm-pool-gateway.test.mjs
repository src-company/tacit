// dapp/evm-pool-gateway.js: deposit-box intents, keeper completion proofs and withdrawals to a box, proven with
// the DEV zkey (see tests/evm-pool-zk.test.mjs for the build steps).
//   node tests/evm-pool-gateway.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as snarkjs from 'snarkjs';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from 'poseidon-lite';
import { makeEvmPoolZk, poolAsset } from '../dapp/evm-pool-zk.js';
import { proveTransact, verifyTransact } from '../dapp/evm-pool-zk-prover.js';
import { depositIntent, completionWitness, withdrawalWitness, receiveKeys, receiveRho, sweepWitness, receivedNote } from '../dapp/evm-pool-gateway.js';

const DIR = new URL('../dapp/circuits/evm-pool/build/', import.meta.url).pathname;
const wasm = readFileSync(DIR + 'transact_js/transact.wasm');
const zkey = readFileSync(DIR + 'transact_dev_final.zkey');
const vk = JSON.parse(readFileSync(DIR + 'transact_dev_vk.json', 'utf8'));
const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const CHAIN_ID = 1n;
const POOL = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const KEEPER = '0x3333333333333333333333333333333333333333';
const BOX = '0x4444444444444444444444444444444444444444';
const REFUND = '0x5555555555555555555555555555555555555555';
const asset = poolAsset({ chainId: CHAIN_ID, pool: POOL, token: TOKEN });
const alice = zk.walletKeys(new Uint8Array(32).fill(7), 'mainnet');
const s = (i) => Uint8Array.from([2, i, ...new Uint8Array(31).fill(0x60 + i)]);
const out = (v, i) => { const o = zk.outputKeys(alice.A, alice.N, s(i)); return { v, npk: o.npk, rho: o.rho }; };

console.log('deposit intents');
{
  assert.throws(() => depositIntent(zk, { asset, amount: 10n, outputs: [out(11n, 0)], refund: REFUND, deadline: 1n }));
  ok('outputs above the deposit are refused');
  assert.throws(() => depositIntent(zk, { asset, amount: 10n, outputs: [out(1n, 0)], refund: '0x' + '0'.repeat(40), deadline: 1n }), /refund/);
  assert.throws(() => depositIntent(zk, { asset, amount: 1n << 120n, outputs: [], refund: REFUND, deadline: 1n }), /2\^120/);
  assert.throws(() => depositIntent(zk, { asset, amount: 10n, outputs: [out(1n, 0), out(1n, 1), out(1n, 2)], refund: REFUND, deadline: 1n }), /two outputs/);
  ok('zero refund, amount ≥ 2^120 and three outputs are refused');
}
const { intent, hint } = depositIntent(zk, { asset, amount: 1000n, outputs: [out(990n, 0)], memo0: '0xa11ce0', refund: REFUND, deadline: 2_000_000_000n, nonce: 1n });
assert.strictEqual(hint.fee, 10n);
assert.strictEqual(intent.outLeaf1, 0n);
ok('fee is the deposit minus the outputs; an empty slot is leaf 0');

console.log('keeper completion (real proof)');
let leaves = [11n, 22n];
{
  const w = completionWitness(zk, { intent, hint, asset, leaves, chainId: CHAIN_ID, pool: POOL, relayer: KEEPER });
  const { proof, publicSignals } = await proveTransact(w.input, { wasm, zkey, snarkjs });
  assert.ok(await verifyTransact(vk, publicSignals, proof, { snarkjs }));
  assert.strictEqual(BigInt(publicSignals[9]), intent.outLeaf0);
  assert.strictEqual(w.tx.fee, 10n);
  leaves = [...leaves, ...w.outLeaf];
  ok('a keeper proves exactly the intent\'s leaves and collects the fee');

  const forged = { ...hint, outputs: [out(990n, 5), null] };
  assert.throws(() => completionWitness(zk, { intent, hint: forged, asset, leaves, chainId: CHAIN_ID, pool: POOL, relayer: KEEPER }));
  ok('a hint for other notes does not match the intent');
}

console.log('withdraw to a box (real proof)');
{
  const k = zk.ownedKeys(alice, s(0));
  const note = { v: 990n, rho: k.rho, nk: k.nk, sk: k.sk, index: 2 };
  const w = withdrawalWitness(zk, { asset, leaves, inputs: [note, null], change: out(300n, 1), amount: 680n, recipient: BOX, relayer: KEEPER, fee: 10n, chainId: CHAIN_ID, pool: POOL });
  const { proof, publicSignals } = await proveTransact(w.input, { wasm, zkey, snarkjs });
  assert.ok(await verifyTransact(vk, publicSignals, proof, { snarkjs }));
  assert.strictEqual(w.tx.extAmount, -680n);
  ok('withdraw 680 to a box with 300 change and a 10 fee');
}

console.log('receive boxes (real proof)');
{
  assert.strictEqual(receiveRho(BOX, 3), 219055354919591748091452618626282574578616910022296641843963426678570215164n);
  ok('receiveRho matches keccak256(abi.encode(tag, box, n)) mod p');

  const r0 = receiveKeys(zk, alice, 0);
  const r1 = receiveKeys(zk, alice, 1);
  assert.notStrictEqual(r0.npk, r1.npk);
  const restored = zk.walletKeys(new Uint8Array(32).fill(7), 'mainnet');
  assert.strictEqual(receiveKeys(zk, restored, 0).npk, r0.npk);
  const bob = zk.walletKeys(new Uint8Array(32).fill(9), 'mainnet');
  assert.notStrictEqual(receiveKeys(zk, bob, 0).npk, r0.npk);
  ok('receive keys are per box, per wallet, and come back from the seed alone');

  assert.throws(() => sweepWitness(zk, { asset, leaves, npk: r0.npk, feeBps: 50, box: BOX, n: 0, amount: 1000n, fee: 6n, relayer: KEEPER, chainId: CHAIN_ID, pool: POOL }), /cap/);
  assert.throws(() => sweepWitness(zk, { asset, leaves, npk: r0.npk, feeBps: 50, box: BOX, n: 0, amount: 1000n, fee: 5n, chainId: CHAIN_ID, pool: POOL }), /relayer/);
  ok('a fee above the cap, or without a relayer, is refused');

  const w = sweepWitness(zk, { asset, leaves, npk: r0.npk, feeBps: 50, box: BOX, n: 0, amount: 1000n, fee: 5n, relayer: KEEPER, chainId: CHAIN_ID, pool: POOL });
  const { proof, publicSignals } = await proveTransact(w.input, { wasm, zkey, snarkjs });
  assert.ok(await verifyTransact(vk, publicSignals, proof, { snarkjs }));
  assert.strictEqual(BigInt(publicSignals[9]), zk.leafOf(asset, 995n, r0.npk, receiveRho(BOX, 0)));
  const index = leaves.length;
  leaves = [...leaves, ...w.outLeaf];
  ok('a sweeper proves the note the router computes: Poseidon(asset, 995, npk, rho(box, 0))');

  // Recovery from the seed and the Received event alone, then a spend of the note.
  const note = receivedNote(zk, restored, 0, { value: 995n, rho: receiveRho(BOX, 0), index });
  const spend = withdrawalWitness(zk, { asset, leaves, inputs: [note, null], change: out(495n, 7), amount: 500n, recipient: REFUND, chainId: CHAIN_ID, pool: POOL });
  const p2 = await proveTransact(spend.input, { wasm, zkey, snarkjs });
  assert.ok(await verifyTransact(vk, p2.publicSignals, p2.proof, { snarkjs }));
  ok('the swept note, recovered from the seed and its event, spends (500 out, 495 change)');
}

console.log(`${n} checks passed`);
process.exit(0);
