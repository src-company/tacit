// Client side of contracts/src/TacitEvmPoolRouter.sol: deposit-box intents, the proof a keeper builds to complete
// one, receive boxes, and withdrawals whose recipient is a box or an exit-recipe escrow. Deposit-box, wrap-box and
// escrow addresses come from the contracts' own views (depositBoxOf / wrapBoxOf / escrowAddressFor); a receive box
// address is also computed here (receiveBoxAddress), matching receiveBoxOf on the canonical router.
//
// A deposit intent fixes the amount, both output leaves and both memo hashes. Its hint (each output's v, npk,
// rho) is what a keeper needs to prove the deposit. It tells the keeper how the deposit splits across the two
// outputs, which the leaves hide; it cannot link later spends, which need the owner's nk. The keeper's fee is
// amount − Σ v.

import { keccak_256, sha256, hmac, concatBytes } from './vendor/tacit-deps.min.js';
import { extDataHash, EVM_N_OUT, EVM_VALUE_BITS } from './evm-pool-zk.js';
import { P_FR, be32 } from './btc-pool-zk.js';

const VALUE_MAX = 1n << EVM_VALUE_BITS;

const ZERO = '0x0000000000000000000000000000000000000000';
const toBytes = (m) => {
  if (typeof m !== 'string') return m ?? new Uint8Array();
  const s = m.replace(/^0x/, '');
  if (s.length % 2) throw new Error('evm-pool-gateway: odd hex');
  return Uint8Array.from(s.match(/../g) || [], (b) => parseInt(b, 16));
};
const hex32 = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// outputs: up to two { v, npk, rho } (null for an empty slot). Returns the on-chain intent and the keeper hint.
export function depositIntent(zk, { asset, amount, outputs, memo0 = new Uint8Array(), memo1 = new Uint8Array(), refund, deadline, nonce = 0n }) {
  if (outputs.length > EVM_N_OUT) throw new Error('evm-pool-gateway: at most two outputs');
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(refund)) || BigInt(refund) === 0n) throw new Error('evm-pool-gateway: a non-zero refund address is required to recover an unfinished box');
  if (BigInt(amount) <= 0n || BigInt(amount) >= VALUE_MAX) throw new Error('evm-pool-gateway: amount must be in (0, 2^120)');
  const outs = [...outputs, ...Array(EVM_N_OUT - outputs.length).fill(null)];
  const total = outs.reduce((s, o) => s + (o ? BigInt(o.v) : 0n), 0n);
  if (total > BigInt(amount)) throw new Error('evm-pool-gateway: outputs exceed the deposit');
  const leaves = outs.map((o) => (o ? zk.leafOf(asset, o.v, o.npk, o.rho) : 0n));
  const m0 = toBytes(memo0);
  const m1 = toBytes(memo1);
  return {
    intent: {
      amount: BigInt(amount), outLeaf0: leaves[0], outLeaf1: leaves[1],
      memo0Hash: hex32(keccak_256(m0)), memo1Hash: hex32(keccak_256(m1)),
      refund, deadline: BigInt(deadline), nonce: BigInt(nonce),
    },
    hint: { outputs: outs, fee: BigInt(amount) - total, memo0: m0, memo1: m1 },
  };
}

// The completing keeper's proof input: a deposit of exactly intent.amount into `leaves` (the pool's current
// leaves) that pays `relayer` the fee. Rebuild against fresh leaves if the pool moves before submission.
export function completionWitness(zk, { intent, hint, asset, leaves, chainId, pool, relayer }) {
  const eh = extDataHash({ chainId, pool, recipient: ZERO, extAmount: intent.amount, relayer, fee: hint.fee, memo0: hint.memo0, memo1: hint.memo1 });
  const w = zk.buildWitness({ asset, leaves, inputs: [null, null], outputs: hint.outputs, extAmount: intent.amount, fee: hint.fee, extDataHash: eh });
  if (w.outLeaf[0] !== BigInt(intent.outLeaf0) || w.outLeaf[1] !== BigInt(intent.outLeaf1)) throw new Error('evm-pool-gateway: hint does not match the intent');
  return { ...w, tx: { recipient: ZERO, extAmount: intent.amount, relayer, fee: hint.fee, memo0: hint.memo0, memo1: hint.memo1 } };
}

// A withdrawal of `amount` to `recipient` (a wrap box for withdrawToV1, an exit-recipe escrow, or any address),
// paying `fee` to `relayer`. inputs / change follow evm-pool-zk.js buildWitness; change is an optional output.
export function withdrawalWitness(zk, { asset, leaves, inputs, change = null, amount, recipient, relayer = ZERO, fee = 0n, memo0 = new Uint8Array(), memo1 = new Uint8Array(), chainId, pool }) {
  if (BigInt(fee) > 0n && BigInt(relayer) === 0n) throw new Error('evm-pool-gateway: a fee needs a relayer address');
  if (BigInt(recipient) === 0n) throw new Error('evm-pool-gateway: a withdrawal needs a recipient');
  const extAmount = -BigInt(amount);
  const m0 = toBytes(memo0);
  const m1 = toBytes(memo1);
  const eh = extDataHash({ chainId, pool, recipient, extAmount, relayer, fee, memo0: m0, memo1: m1 });
  const w = zk.buildWitness({ asset, leaves, inputs, outputs: [change, null], extAmount, fee, extDataHash: eh });
  return { ...w, tx: { recipient, extAmount, relayer, fee: BigInt(fee), memo0: m0, memo1: m1 } };
}

// ──────────────────── receive boxes ────────────────────
//
// Receive box i is a standing address for one note key of the wallet: anyone pays it, any number of times, and
// anyone sweeps it into the pool, where the router computes each note itself (router §6). The key comes from the
// wallet's nullifier secret, so a box cannot be tied to the wallet's shielded address, and the seed alone
// recovers every box and every note swept into one: receiveKeys(i) → receiveBoxOf(npk, feeBps) → its Received
// events → receivedNote.

// Canonical receive address, identical in every app: the pool wallet from the Tacit identity key, box index 0,
// fee cap RECEIVE_FEE_BPS, on the canonical router (the same address on every chain).
export const EVM_POOL_ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
export const RECEIVE_FEE_BPS = 25;
export const RECEIVE_INDEX = 0;

const te = new TextEncoder();
const POOL_SEED_TAG = te.encode('tacit-btc-pool-seed-v1');
const RECEIVE_KEY_TAG = te.encode('tacit-evm-pool-receive-key-v1');
const RECEIVE_TAG = keccak_256(te.encode('tacit-evm-pool-receive-box-v1'));
const addrWord = (a) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(a))) throw new Error('evm-pool-gateway: bad address');
  return be32(BigInt(a));
};

// The pool wallet of a Tacit identity key (32 bytes): seed = HMAC-SHA256(key, "tacit-btc-pool-seed-v1"), the
// Bitcoin pool's seed, with the "mainnet" key tag on every EVM chain (notes are chain-bound by their asset).
export function evmPoolWallet(zk, identityPriv) {
  if (!(identityPriv instanceof Uint8Array) || identityPriv.length !== 32) throw new Error('evm-pool-gateway: identity key must be 32 bytes');
  return zk.walletKeys(hmac(sha256, identityPriv, POOL_SEED_TAG), 'mainnet');
}

// The note key of receive box i: { npk, sk, nk }. The 33-byte tweak seed starts with 0x00, which no shared
// secret (a compressed point) does.
export function receiveKeys(zk, wallet, i = 0) {
  if (!Number.isInteger(i) || i < 0) throw new Error('evm-pool-gateway: receive box index');
  const s = concatBytes(Uint8Array.of(0), keccak_256(concatBytes(RECEIVE_KEY_TAG, be32(wallet.n), be32(i))));
  const { npk, sk, nk } = zk.ownedKeys(wallet, s);
  return { npk, sk, nk };
}

// receiveBoxOf(npk, feeBps) of `router`: the PUSH0 minimal-proxy clone (solady LibClone) of the router's box
// implementation, which the router creates at nonce 1, at salt keccak256(abi.encode(RECEIVE_TAG, npk, feeBps)).
export function receiveBoxAddress(npk, feeBps = RECEIVE_FEE_BPS, router = EVM_POOL_ROUTER) {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 0xffff) throw new Error('evm-pool-gateway: feeBps');
  const r = addrWord(router).slice(12);
  const impl = keccak_256(concatBytes(Uint8Array.of(0xd6, 0x94), r, Uint8Array.of(0x01))).slice(12);
  const initHash = keccak_256(concatBytes(hexBytes('602d5f8160095f39f35f5f365f5f37365f73'), impl, hexBytes('5af43d5f5f3e6029573d5ffd5b3d5ff3')));
  const salt = keccak_256(concatBytes(RECEIVE_TAG, be32(BigInt(npk)), be32(BigInt(feeBps))));
  const a = keccak_256(concatBytes(Uint8Array.of(0xff), r, salt, initHash)).slice(12);
  return toChecksum(a);
}
const hexBytes = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
function toChecksum(a20) {
  const hex = Array.from(a20, (x) => x.toString(16).padStart(2, '0')).join('');
  const h = keccak_256(te.encode(hex));
  return '0x' + [...hex].map((c, i) => (((h[i >> 1] >> (i % 2 ? 0 : 4)) & 0xf) >= 8 ? c.toUpperCase() : c)).join('');
}

// rho of the n-th sweep of `box`: keccak256(abi.encode(RECEIVE_TAG, box, n)) mod p, as the router computes it.
export function receiveRho(box, n) {
  const h = keccak_256(concatBytes(RECEIVE_TAG, addrWord(box), be32(BigInt(n))));
  let x = 0n;
  for (const c of h) x = (x << 8n) | BigInt(c);
  return x % P_FR;
}

// The sweeper's proof input: deposit `amount` from `box` (sweep number n = receiveCount(box)) into one note for
// `npk`, paying `relayer` a fee within the box's feeBps. Rebuild with fresh leaves and n if another sweep lands first.
export function sweepWitness(zk, { asset, leaves, npk, feeBps, box, n, amount, fee = 0n, relayer = ZERO, chainId, pool }) {
  const a = BigInt(amount), f = BigInt(fee);
  if (a <= 0n || a >= VALUE_MAX) throw new Error('evm-pool-gateway: amount must be in (0, 2^120)');
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new Error('evm-pool-gateway: feeBps must be in [0, 10000]');
  if (f < 0n || f * 10_000n > a * BigInt(feeBps)) throw new Error('evm-pool-gateway: fee above the box\'s cap');
  if (f > 0n && BigInt(relayer) === 0n) throw new Error('evm-pool-gateway: a fee needs a relayer address');
  const note = { v: a - f, npk: BigInt(npk), rho: receiveRho(box, n) };
  const eh = extDataHash({ chainId, pool, recipient: ZERO, extAmount: a, relayer, fee: f });
  const w = zk.buildWitness({ asset, leaves, inputs: [null, null], outputs: [note, null], extAmount: a, fee: f, extDataHash: eh });
  return { ...w, tx: { recipient: ZERO, extAmount: a, relayer, fee: f, memo0: new Uint8Array(), memo1: new Uint8Array() } };
}

// A spendable input note (evm-pool-zk.js buildWitness) from one Received event of receive box i.
export function receivedNote(zk, wallet, i, { value, rho, index }) {
  const { sk, nk } = receiveKeys(zk, wallet, i);
  return { v: BigInt(value), rho: BigInt(rho), nk, sk, index: Number(index) };
}
