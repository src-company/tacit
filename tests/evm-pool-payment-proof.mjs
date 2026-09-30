// Payment proofs: a spend's one-time keys are derived from the sender's view key and the spend's nullifier, so
// the sender can prove to anyone who knows the recipient's address what an output paid them.
//   node tests/evm-pool-payment-proof.mjs
import assert from 'node:assert/strict';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from '../dapp/vendor/tacit-poseidon.min.js';
import { makeEvmPoolZk, poolAsset } from '../dapp/evm-pool-zk.js';
import { evmPoolKeys, sealNote, recipientOf, paymentKey, verifyPayment, openNote } from '../dapp/evm-pool-wallet.js';

const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });
const alice = evmPoolKeys(zk, new Uint8Array(32).fill(1)), bob = evmPoolKeys(zk, new Uint8Array(32).fill(2)), carol = evmPoolKeys(zk, new Uint8Array(32).fill(3));
const asset = poolAsset({ chainId: 8453n, pool: '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', token: '0x0000000000000000000000000000000000000000' });
const nf = 0x1234567890abcdefn;

const e = paymentKey(alice, { chainId: 8453, nf, k: 0 });
assert.equal(e, paymentKey(alice, { chainId: 8453, nf, k: 0 }), 'derived again from the key alone');
assert.notEqual(e, paymentKey(alice, { chainId: 8453, nf, k: 1 }), 'each output has its own');
assert.notEqual(e, paymentKey(alice, { chainId: 1, nf, k: 0 }), 'and each chain');
assert.notEqual(e, paymentKey(bob, { chainId: 8453, nf, k: 0 }), 'and each sender');

const value = 4_000_000_000_000_000n;
const note = sealNote(zk, { to: recipientOf(alice, bob.address), value, asset, e });
assert.equal(openNote(zk, bob, { memo: note.memo, leaf: note.leaf, asset })?.v, value, 'bob finds it as usual');
assert.equal(verifyPayment(zk, carol, { to: bob.address, e, memo: note.memo, leaf: note.leaf, asset }), value, 'anyone with bob’s address can check it');
assert.equal(verifyPayment(zk, carol, { to: carol.address, e, memo: note.memo, leaf: note.leaf, asset }), null, 'it proves nothing about another address');
assert.equal(verifyPayment(zk, carol, { to: bob.address, e: e + 1n, memo: note.memo, leaf: note.leaf, asset }), null, 'a wrong key proves nothing');
console.log('payment proof checks passed');
