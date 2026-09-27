// dapp/evm-pool-gateway.js: deposit-box intents, keeper completion proofs and withdrawals to a box, proven with
// the DEV zkey (see tests/evm-pool-zk.test.mjs for the build steps).
//   node tests/evm-pool-gateway.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as snarkjs from 'snarkjs';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from 'poseidon-lite';
import { makeEvmPoolZk, poolAsset } from '../dapp/evm-pool-zk.js';
import { proveTransact, verifyTransact } from '../dapp/evm-pool-zk-prover.js';
import {
  depositIntent, completionWitness, withdrawalWitness, receiveKeys, receiveRho, sweepWitness, receivedNote, evmPoolWallet, receiveBoxAddress,
  RECEIVE_FEE_BPS, RECEIVE_INDEX, call, callIntent, callEscrowAddress, callWithdrawalWitness, callRefundBox, callIntentJson,
  v1ZapShieldedNoteCall, encodeDepositHint, decodeDepositHint,
} from '../dapp/evm-pool-gateway.js';

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

  // Spec vectors (docs/EVM-POOL.md "Receive address"); the box addresses are also asserted against the router's
  // receiveBoxOf in contracts/test/DeployEvmPoolCreateX.t.sol.
  const vw = evmPoolWallet(zk, new Uint8Array(32).fill(0x11));
  assert.strictEqual(vw.a, 0x30d4f8c609bcd6f5c961113e9a379b14b5eacfe0cb693e3ee3a21f148144d9en);
  assert.strictEqual(vw.n, 0x4b517b015712270664ae5481e694562bb14b28685c492be2436898a8ec97306n);
  const k0 = receiveKeys(zk, vw, RECEIVE_INDEX);
  assert.strictEqual(k0.npk, 4783613888947850950044057964142544727340891053660060203316524895455918575012n);
  assert.strictEqual(receiveKeys(zk, vw, 1).npk, 2799937100355739972349309475928188484188423058204235589221587582372656968697n);
  assert.strictEqual(RECEIVE_FEE_BPS, 25);
  assert.strictEqual(receiveBoxAddress(k0.npk), '0x52fc37ee7741468a15CE879320a7a41CEBaeb232');
  assert.strictEqual(receiveBoxAddress(k0.npk, 0), '0x7ABc01dEAC9A65A0d2480a87DB6F22EbC1342639');
  ok('canonical receive address vectors: identity key → wallet → box 0 → address');

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

console.log('withdraw and call');
{
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const vector = callIntent({
    calls: [
      call({ target: '0x000000000000FB114709235f1ccBFfb925F600e4', value: 10n ** 18n, data: '0xdeadbeef' }),
      call({ target: '0x000000000022D473030F116dDEE9F6B43aC78BA3', token: USDC, amount: 5000n, push: true }),
    ],
    outputs: [{ token: USDC, min: 4000n }, { token: '0x0000000000000000000000000000000000000000' }],
    to: '0x0000000000000000000000000000000000000B0B', refund: '0x0000000000000000000000000000000000005AFE', deadline: 2_000_000_000n, nonce: 7n,
  });
  // Also asserted against the router's callEscrowOf in contracts/test/DeployEvmPoolCreateX.t.sol.
  assert.strictEqual(callEscrowAddress(vector), '0xE1d80AEDC9571874805958A4189808489b731301');
  ok('callEscrowAddress matches the canonical router\'s callEscrowOf');

  assert.notStrictEqual(callEscrowAddress({ ...vector, to: KEEPER }), callEscrowAddress(vector));
  assert.notStrictEqual(callEscrowAddress({ ...vector, minOuts: [3999n, 0n] }), callEscrowAddress(vector));
  assert.notStrictEqual(callEscrowAddress(vector, POOL), callEscrowAddress(vector));
  ok('any change to the intent, or another router, is another escrow');

  assert.throws(() => callIntent({ calls: [], refund: REFUND, deadline: 1n }), /at least one call/);
  assert.throws(() => callIntent({ calls: [{ target: USDC }], refund: '0x' + '0'.repeat(40), deadline: 1n }), /refund/);
  assert.throws(() => callIntent({ calls: [{ target: USDC }], outputs: [{ token: USDC }], refund: REFUND, deadline: 1n }), /`to`/);
  ok('an intent needs a call, a refund, and a `to` when it has outputs');

  // Also asserted in contracts/test/TacitEvmPoolRouterCall.t.sol.
  const zap = v1ZapShieldedNoteCall({ confidentialRouter: '0x000000005dA3E3B73726af3c774Deeb9472D4992', value: 1n, tokenOut: USDC, wrapAmount: 5n, commit: '0x' + '11'.repeat(32), zrSwapData: '0xabcd' });
  assert.ok(zap.data.startsWith('0x65dcbb8e000000000000000000000000a0b86991'));
  assert.strictEqual(zap.value, 1n);
  ok('the V1 zap call encodes as abi.encodeCall(zapETHToShieldedNote, …)');

  const wallet = zk.walletKeys(new Uint8Array(32).fill(7), 'mainnet');
  const refundBox = callRefundBox(zk, wallet, 1);
  assert.strictEqual(refundBox, receiveBoxAddress(receiveKeys(zk, wallet, 1).npk));
  assert.throws(() => callRefundBox(zk, wallet, 0), /own index/);
  ok('a call refund goes to a receive box of its own, never the canonical box 0');

  const intent = callIntent({ calls: [zap], outputs: [{ token: USDC }], to: REFUND, refund: refundBox, deadline: 2_000_000_000n, nonce: 1n });
  const k = zk.ownedKeys(alice, s(0));
  const note = { v: 990n, rho: k.rho, nk: k.nk, sk: k.sk, index: 2 };
  const w = callWithdrawalWitness(zk, { intent, asset, leaves, inputs: [note, null], change: out(690n, 8), amount: 290n, relayer: KEEPER, fee: 10n, chainId: CHAIN_ID, pool: POOL });
  assert.strictEqual(w.tx.recipient, callEscrowAddress(intent));
  const { proof, publicSignals } = await proveTransact(w.input, { wasm, zkey, snarkjs });
  assert.ok(await verifyTransact(vk, publicSignals, proof, { snarkjs }));
  const other = withdrawalWitness(zk, { asset, leaves, inputs: [note, null], change: out(690n, 8), amount: 290n, recipient: callEscrowAddress({ ...intent, to: KEEPER }), relayer: KEEPER, fee: 10n, chainId: CHAIN_ID, pool: POOL });
  assert.notStrictEqual(other.input.extDataHash, w.input.extDataHash);
  ok('a withdrawal into the escrow proves (real proof) and its extDataHash commits to the intent');

  const json = callIntentJson(intent);
  assert.strictEqual(json.calls[0].value, '1');
  assert.strictEqual(JSON.parse(JSON.stringify(json)).deadline, '2000000000');
  ok('intent JSON for the keeper carries integers as decimal strings');
}

console.log('funding a deposit box with a call');
{
  const h = encodeDepositHint({ outputs: [{ v: 990n, npk: 5n, rho: 6n }, null], memo0: '0xa11ce0', memo1: '0x' });
  const back = decodeDepositHint(h);
  assert.deepStrictEqual(back.outputs, [{ v: 990n, npk: 5n, rho: 6n }, null]);
  assert.deepStrictEqual([...back.memo0], [0xa1, 0x1c, 0xe0]);
  assert.strictEqual(back.memo1.length, 0);
  ok('deposit hint round-trips through abi.encode(v0, npk0, rho0, v1, npk1, rho1, memo0, memo1)');

  const decoded = decodeDepositHint(encodeDepositHint(hint));
  const again = depositIntent(zk, { asset, amount: intent.amount, outputs: decoded.outputs, memo0: decoded.memo0, memo1: decoded.memo1, refund: REFUND, deadline: intent.deadline, nonce: intent.nonce });
  assert.strictEqual(again.intent.outLeaf0, intent.outLeaf0);
  assert.strictEqual(again.intent.memo0Hash, intent.memo0Hash);
  ok('a keeper rebuilds the intent\'s leaves and memo hashes from the on-chain hint alone');
  assert.throws(() => decodeDepositHint('0x' + '00'.repeat(100)), /short hint/);
  ok('a truncated hint is refused');
}

console.log(`${n} checks passed`);
process.exit(0);
