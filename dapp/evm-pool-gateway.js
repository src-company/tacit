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
  // The router sweeps only boxes with feeBps ≤ 10000 and npk < p; any other address could never be swept.
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new Error('evm-pool-gateway: feeBps must be in [0, 10000]');
  if (BigInt(npk) <= 0n || BigInt(npk) >= P_FR) throw new Error('evm-pool-gateway: npk must be in (0, p)');
  return boxAddress(router, keccak_256(concatBytes(RECEIVE_TAG, be32(BigInt(npk)), be32(BigInt(feeBps)))));
}
// The router's box clone (implementation at the router's nonce 1) at `salt`.
function boxAddress(router, salt) {
  const r = addrWord(router).slice(12);
  const impl = keccak_256(concatBytes(Uint8Array.of(0xd6, 0x94), r, Uint8Array.of(0x01))).slice(12);
  const initHash = keccak_256(concatBytes(hexBytes('602d5f8160095f39f35f5f365f5f37365f73'), impl, hexBytes('5af43d5f5f3e6029573d5ffd5b3d5ff3')));
  return toChecksum(keccak_256(concatBytes(Uint8Array.of(0xff), r, salt, initHash)).slice(12));
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

// ──────────────────── ABI encoding (the few shapes the router takes) ────────────────────
//
// A type is a base name ('address', 'uint256', 'uint64', 'uint16', 'bool', 'bytes32', 'bytes'), { array: T } or
// { tuple: [T, …] }. Values: bigint-able numbers, 0x addresses / hex, Uint8Array or 0x hex for bytes.

const isDyn = (t) => t === 'bytes' || !!t.array || (!!t.tuple && t.tuple.some(isDyn));
const pad32 = (b) => concatBytes(b, new Uint8Array((32 - (b.length % 32)) % 32));
function encodeOne(t, v) {
  if (t === 'bytes') { const b = toBytes(v); return concatBytes(be32(BigInt(b.length)), pad32(b)); }
  if (t.array) return concatBytes(be32(BigInt(v.length)), encodeTuple(v.map(() => t.array), v));
  if (t.tuple) return encodeTuple(t.tuple, v);
  if (t === 'bool') return be32(v ? 1n : 0n);
  if (t === 'address') return addrWord(v);
  if (t === 'bytes32' && typeof v !== 'bigint') {
    const b = toBytes(v);
    if (b.length !== 32) throw new Error('evm-pool-gateway: bytes32 must be 32 bytes');
    return b;
  }
  const x = BigInt(v);
  if (x < 0n || x >= 1n << 256n) throw new Error('evm-pool-gateway: word out of range');
  return be32(x);
}
export function abiEncode(types, values) { return encodeTuple(types, values); }
function encodeTuple(types, values) {
  if (types.length !== values.length) throw new Error('evm-pool-gateway: abi arity');
  const parts = types.map((t, i) => encodeOne(t, values[i]));
  let off = BigInt(32 * types.length);
  const heads = [], tails = [];
  types.forEach((t, i) => {
    if (isDyn(t)) { heads.push(be32(off)); tails.push(parts[i]); off += BigInt(parts[i].length); } else heads.push(parts[i]);
  });
  return concatBytes(...heads, ...tails);
}
export const selector = (sig) => keccak_256(te.encode(sig)).slice(0, 4);
export const calldata = (sig, types, values) => hex32(concatBytes(selector(sig), encodeTuple(types, values)));

// ──────────────────── withdraw and call (router §7) ────────────────────
//
// A CallIntent fixes the calls an escrow runs with a withdrawal, the outputs it delivers to `to` (each at least its
// floor), the refund for whatever is left of the pool asset (or, after the deadline, everything), and a nonce. The
// withdrawal's recipient is callEscrowOf(intent), so the proof commits to all of it.
//
// The intent is public once relayed. For a refund back into the pool, use a receive box of its own
// (receiveKeys(zk, wallet, i) with i ≥ 1, i.e. callRefundBox): the canonical box 0 would tie the withdrawal to the
// wallet's public receive address.

const CALL = { tuple: ['address', 'uint256', 'address', 'uint256', 'bool', 'bytes'] };
const CALL_INTENT = { tuple: [{ array: CALL }, { array: 'address' }, { array: 'uint256' }, 'address', 'address', 'uint64', 'uint256'] };
const CALL_TAG = keccak_256(te.encode('tacit-evm-pool-call-escrow-v1'));
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a));

// One step: { target, value?, token?, amount?, push?, data? }.
export function call({ target, value = 0n, token = ZERO, amount = 0n, push = false, data = '0x' }) {
  if (!isAddr(target) || !isAddr(token)) throw new Error('evm-pool-gateway: call target and token must be addresses');
  return { target, value: BigInt(value), token, amount: BigInt(amount), push: !!push, data: hex32(toBytes(data)) };
}

export function callIntent({ calls, outputs = [], to = ZERO, refund, deadline, nonce = 0n }) {
  if (!Array.isArray(calls) || !calls.length) throw new Error('evm-pool-gateway: a call intent needs at least one call');
  if (!isAddr(refund) || BigInt(refund) === 0n) throw new Error('evm-pool-gateway: a call intent needs a non-zero refund address');
  if (outputs.length && (!isAddr(to) || BigInt(to) === 0n)) throw new Error('evm-pool-gateway: outputs need a non-zero `to`');
  for (const o of outputs) if (!isAddr(o.token)) throw new Error('evm-pool-gateway: output token must be an address');
  return {
    calls: calls.map(call), outTokens: outputs.map((o) => o.token), minOuts: outputs.map((o) => BigInt(o.min ?? 0n)),
    to, refund, deadline: BigInt(deadline), nonce: BigInt(nonce),
  };
}
const intentValues = (i) => [
  i.calls.map((c) => [c.target, c.value, c.token, c.amount, c.push, c.data]), i.outTokens, i.minOuts, i.to, i.refund, i.deadline, i.nonce,
];

// callEscrowOf(intent) of `router`, computed here: the router's box clone at keccak256(abi.encode(CALL_TAG, intent)).
export function callEscrowAddress(intent, router = EVM_POOL_ROUTER) {
  return boxAddress(router, keccak_256(abiEncode(['bytes32', CALL_INTENT], [CALL_TAG, intentValues(intent)])));
}

// The withdrawal a relayer submits with router.withdrawAndCall(tx, intent): `amount` to the intent's escrow.
export function callWithdrawalWitness(zk, { intent, router = EVM_POOL_ROUTER, ...rest }) {
  return withdrawalWitness(zk, { ...rest, recipient: callEscrowAddress(intent, router) });
}

// Receive box i (i ≥ 1) as the refund of a call intent: anything returned is swept back into a note for the wallet.
export function callRefundBox(zk, wallet, i, { feeBps = RECEIVE_FEE_BPS, router = EVM_POOL_ROUTER } = {}) {
  if (!Number.isInteger(i) || i < 1) throw new Error('evm-pool-gateway: a refund box needs its own index (≥ 1)');
  return receiveBoxAddress(receiveKeys(zk, wallet, i).npk, feeBps, router);
}

// Intent → JSON (decimal strings) for the keeper's /relay `call` field, and back.
export function callIntentJson(i) {
  return {
    calls: i.calls.map((c) => ({ ...c, value: c.value.toString(), amount: c.amount.toString() })),
    outTokens: i.outTokens, minOuts: i.minOuts.map(String), to: i.to, refund: i.refund, deadline: i.deadline.toString(), nonce: i.nonce.toString(),
  };
}

// Calls for the common actions.
//  - into a V1 note of another token: ETH → `tokenOut` through ConfidentialRouter.zapETHToShieldedNote, wrapping
//    `wrapAmount` for the V1 note commitment `commit`; surplus comes back to the escrow (list tokenOut as an output).
export function v1ZapShieldedNoteCall({ confidentialRouter, value, tokenOut, wrapAmount, commit, zrSwapData }) {
  return call({
    target: confidentialRouter, value,
    data: calldata('zapETHToShieldedNote(address,uint256,bytes32,bytes)', ['address', 'uint256', 'bytes32', 'bytes'], [tokenOut, wrapAmount, commit, zrSwapData]),
  });
}
//  - into a V1 canonical-asset note (cBTC, cUSD) by its shared asset id.
export function v1ZapCanonicalNoteCall({ confidentialRouter, value, assetId, wrapAmount, commit, zrSwapData }) {
  return call({
    target: confidentialRouter, value,
    data: calldata('zapETHToCanonicalNote(bytes32,uint256,bytes32,bytes)', ['bytes32', 'uint256', 'bytes32', 'bytes'], [assetId, wrapAmount, commit, zrSwapData]),
  });
}
//  - a V1 wrap of a token the escrow already holds (approve, then wrap(assetId, amount, commit)).
export function v1WrapCall({ v1, token, assetId, amount, commit }) {
  const value = token === ZERO ? BigInt(amount) : 0n;
  return call({
    target: v1, value, token, amount: token === ZERO ? 0n : amount,
    data: calldata('wrap(bytes32,uint256,bytes32)', ['bytes32', 'uint256', 'bytes32'], [assetId, amount, commit]),
  });
}

// ──────────────────── funding a box with a call (router §8) ────────────────────
//
// fundDeposit(intent, hint) pays a deposit box and publishes `hint` in DepositFunded, so any keeper can complete it
// from chain data alone. The hint is abi.encode(v0, npk0, rho0, v1, npk1, rho1, memo0, memo1), an empty output as
// three zeros. It shows the per-output split, which the completing keeper learns anyway; nothing in it spends.

const HINT = ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes', 'bytes'];
export function encodeDepositHint(hint) {
  const o = hint.outputs.map((x) => (x ? [x.v, x.npk, x.rho] : [0n, 0n, 0n])).flat();
  return hex32(abiEncode(HINT, [...o, hint.memo0 ?? new Uint8Array(), hint.memo1 ?? new Uint8Array()]));
}
// → { outputs, memo0, memo1 } (the fee is intent.amount − Σ v; parse the result through the keeper's intake checks).
export function decodeDepositHint(data) {
  const b = toBytes(data);
  const word = (at) => { if (at + 32 > b.length) throw new Error('evm-pool-gateway: short hint'); let x = 0n; for (const c of b.subarray(at, at + 32)) x = (x << 8n) | BigInt(c); return x; };
  const bytesAt = (head) => {
    const off = Number(word(head));
    const len = Number(word(off));
    if (off + 32 + len > b.length) throw new Error('evm-pool-gateway: short hint');
    return b.slice(off + 32, off + 32 + len);
  };
  const w = [0, 1, 2, 3, 4, 5].map((k) => word(32 * k));
  const out = (k) => (w[3 * k] === 0n && w[3 * k + 1] === 0n && w[3 * k + 2] === 0n ? null : { v: w[3 * k], npk: w[3 * k + 1], rho: w[3 * k + 2] });
  return { outputs: [out(0), out(1)], memo0: bytesAt(192), memo1: bytesAt(224) };
}
