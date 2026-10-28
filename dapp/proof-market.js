// The client side of ProofMarket (contracts/src/ProofMarket.sol): a holder pays a prover in TAC for an entry op to be proved and settled,
// with nothing sent from the holder's wallet but two signatures. An ORDER is what a prover needs to take the op: the signed intent (or
// the tank and the delegate-signed intent), the TAC permit, and the op's public values, proof and memos. It holds no secret: the
// payer's signatures only let the market pull up to the signed most, and only if the pool accepts exactly this op.
//
// A direct order covers one op: { payer, intent, signature, permit, publicValues, memos }. A tank order covers many under one signed
// package: { payer, tank, tankSignature, intent, signature (by the tank's delegate key), permit (for the tank cap), ... }.
import { keccak_256 } from './vendor/tacit-deps.min.js';
import { stdinFor } from './sp1-stdin.js';

export const MARKET = { 1: '0x0000000033Dd45B1686Ba37e5F6e4ABDdaC17609' };
export const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
export const TAC_PERMIT_NAME = 'Tacit Token';
const ZERO32 = '0x' + '00'.repeat(32);

const INTENT_TYPES = {
  Intent: [
    { name: 'payer', type: 'address' }, { name: 'opId', type: 'bytes32' }, { name: 'floorFee', type: 'uint256' },
    { name: 'maxFee', type: 'uint256' }, { name: 'start', type: 'uint64' }, { name: 'rampSecs', type: 'uint64' },
    { name: 'deadline', type: 'uint64' }, { name: 'tank', type: 'bytes32' },
  ],
};
const TANK_TYPES = {
  Tank: [
    { name: 'payer', type: 'address' }, { name: 'delegate', type: 'address' }, { name: 'cap', type: 'uint256' },
    { name: 'perOpMax', type: 'uint256' }, { name: 'expiry', type: 'uint64' }, { name: 'salt', type: 'uint256' },
  ],
};
const DOMAIN_TYPE = [
  { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
];
const hex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const bytesOf = (h) => { const s = String(h).replace(/^0x/, ''); const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return o; };

/// The op a proof is for: the market refuses a proof whose public values do not hash to this.
export function opIdOf(publicValues) { return hex(keccak_256(bytesOf(publicValues))); }

/// What the holder signs. Amounts are TAC base units (18 decimals). The price starts at `floor` and rises to `max` over `rampSecs`;
/// `max` is the most that can ever be pulled for this op. `tank` is the tank's hash for a tank order, else none.
export function buildIntent({ payer, publicValues, floor, max, rampSecs = 60, ttlSecs = 1800, now = Math.floor(Date.now() / 1000), tank = ZERO32 }) {
  if (BigInt(max) < BigInt(floor)) throw new Error('the most to pay is below the starting price');
  return {
    payer, opId: opIdOf(publicValues), floorFee: String(floor), maxFee: String(max),
    start: String(now), rampSecs: String(rampSecs), deadline: String(now + ttlSecs), tank,
  };
}

const typed = (chainId, market, primaryType, types, message) => ({
  types: { EIP712Domain: DOMAIN_TYPE, ...types }, primaryType, message,
  domain: { name: 'TacitProofMarket', version: '1', chainId: Number(chainId), verifyingContract: market },
});
export const intentTypedData = (intent, chainId = 1, market = MARKET[chainId]) => typed(chainId, market, 'Intent', INTENT_TYPES, intent);
export const tankTypedData = (tank, chainId = 1, market = MARKET[chainId]) => typed(chainId, market, 'Tank', TANK_TYPES, tank);

async function sign(provider, account, data) {
  const sig = await provider.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(data)] });
  if (String(sig).replace(/^0x/, '').length !== 130) throw new Error('signature malformed');
  return sig;
}
export const signIntent = (provider, account, intent, chainId = 1) => sign(provider, account, intentTypedData(intent, chainId));
export const signTank = (provider, account, tank, chainId = 1) => sign(provider, account, tankTypedData(tank, chainId));

/// A tank: one package the payer signs once, with a session key (`delegate`) that then signs each op without a prompt.
export function buildTank({ payer, delegate, cap, perOpMax, ttlSecs = 7 * 86400, now = Math.floor(Date.now() / 1000), salt = BigInt('0x' + hex(crypto.getRandomValues(new Uint8Array(8))).slice(2)) }) {
  return { payer, delegate, cap: String(cap), perOpMax: String(perOpMax), expiry: String(now + ttlSecs), salt: String(salt) };
}

/// The TAC permit the market spends from: for a direct order, the most the op can cost; for a tank, its whole cap.
export async function signTacPermit({ wallet, owner, spender, value, deadline, nonce }) {
  return wallet.signErc2612({ token: TAC, name: TAC_PERMIT_NAME, owner, spender, value, nonce, deadline });
}

/// The order a prover takes, as plain JSON (what is posted to a queue).
export function buildOrder({ intent, signature, permit, publicValues, memos = [], tank = null, tankSignature = null }) {
  if (opIdOf(publicValues) !== intent.opId) throw new Error('the public values are not for this op');
  return { payer: intent.payer, intent, signature, permit, publicValues, memos, ...(tank ? { tank, tankSignature } : {}) };
}

/// The price the market charges `secs` after the intent's start (mirrors ProofMarket.priceAt).
export function priceAt(intent, at = Math.floor(Date.now() / 1000)) {
  const floor = BigInt(intent.floorFee), max = BigInt(intent.maxFee), ramp = BigInt(intent.rampSecs), t = BigInt(at) - BigInt(intent.start);
  if (ramp === 0n || t >= ramp) return max;
  if (t <= 0n) return floor;
  return floor + ((max - floor) * t) / ramp;
}

// A wrap's public values (abi.encode of the pool's PublicValues): a fixed layout of 55 words in which only four depend on the wrap: the
// chain binding (word 2), the memo root (28), the leaf it inserts (34) and the deposit it consumes (36). Read from a live wrap's proof and
// checked against the real guest's output by tests/proofmarket-fork.mjs, so the client knows the op's public values, and so its id, before
// anything is proved.
const WRAP_PV = ["20", "1", null, "0", "3e0", "400", "440", "480", "4a0", "4c0", "4e0", "500", "0", "0", "520", "540", "0", "0", "560", "580", "5a0", "0", "0", "5c0", "5e0", "600", "620", "640", null, "660", "680", "6a0", "0", "1", null, "1", null, "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0"];
const VARY = { chainBinding: 2, memoRoot: 28, leaf: 34, depositId: 36 };
export function wrapPublicValues({ chainBinding, memoRoot, leaf, depositId }) {
  const given = { chainBinding, memoRoot, leaf, depositId };
  return '0x' + WRAP_PV.map((w, i) => {
    const k = Object.keys(VARY).find((n) => VARY[n] === i);
    if (k) { const v = String(given[k]).replace(/^0x/, '').toLowerCase(); if (v.length !== 64) throw new Error(`${k} must be 32 bytes`); return v; }
    return w.padStart(64, '0');
  }).join('');
}

/// What an order for a wrap (confidential-pool-ux.js buildWrap) carries: the program input a prover proves, and the public values that
/// proof will have. `built.memos` are the wrap's memo hex strings; the guest commits to the root of their hashes.
export function wrapOrderInputs(built) {
  const memoHashes = built.memos.map((m) => hex(keccak_256(bytesOf(m))));
  const stdin = hex(stdinFor('wrap', { ...built.wrapOp, memoHashes }));
  const zero = new Uint8Array(32);
  const memoRoot = hex(keccak_256(new Uint8Array([...zero, ...bytesOf(memoHashes[0])])));
  const publicValues = wrapPublicValues({ chainBinding: built.wrapOp.chainBinding, memoRoot, leaf: built.leaf, depositId: built.depositId });
  return { stdin, publicValues, memos: built.memos };
}

// The EIP-712 digest of an intent, for a key held here (the Tacit wallet signs without a wallet popup). Same bytes as the market's own
// intentHash (tests/proof-market-client.test.mjs).
const k256 = (...p) => keccak_256(Uint8Array.from(p.flatMap((x) => Array.from(x))));
const enc = (s) => new TextEncoder().encode(s);
const word = (n) => { const b = new Uint8Array(32); let x = BigInt(n); for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const addrWord = (a) => { const b = new Uint8Array(32); b.set(bytesOf(a), 12); return b; };
export function intentDigest(intent, chainId = 1, market = MARKET[chainId]) {
  const domain = k256(k256(enc('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), k256(enc('TacitProofMarket')), k256(enc('1')), word(chainId), addrWord(market));
  const typehash = k256(enc('Intent(address payer,bytes32 opId,uint256 floorFee,uint256 maxFee,uint64 start,uint64 rampSecs,uint64 deadline,bytes32 tank)'));
  const struct = k256(typehash, addrWord(intent.payer), bytesOf(intent.opId), word(intent.floorFee), word(intent.maxFee), word(intent.start), word(intent.rampSecs), word(intent.deadline), bytesOf(intent.tank));
  return hex(k256(new Uint8Array([0x19, 0x01]), domain, struct));
}

// The market's calls encoded with no library (the community runner installs only the root dependencies): claim / claimFromTank / fulfill /
// fulfillFromTank for an order. Checked byte for byte against viem in tests/proof-market-client.test.mjs.
const u256 = (x) => { const b = word(BigInt(x)); return b; };
const intentWords = (i) => [addrWord(i.payer), bytesOf(i.opId), u256(i.floorFee), u256(i.maxFee), u256(i.start), u256(i.rampSecs), u256(i.deadline), bytesOf(i.tank)];
const tankWords = (t) => [addrWord(t.payer), addrWord(t.delegate), u256(t.cap), u256(t.perOpMax), u256(t.expiry), u256(t.salt)];
const padTo32 = (b) => { const n = Math.ceil(b.length / 32) * 32, o = new Uint8Array(n); o.set(b); return o; };
const cat = (arr) => { const o = new Uint8Array(arr.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };
// params: { s: [words] } a static tuple inline, { v: word } one static word, { b: bytes } dynamic bytes, { ba: [bytes] } dynamic bytes[]
function abiCall(signature, params) {
  const sel = keccak_256(enc(signature)).slice(0, 4);
  const headLen = params.reduce((n, p) => n + (p.s ? p.s.length * 32 : 32), 0), head = [], tail = [];
  let off = headLen;
  for (const p of params) {
    if (p.s) head.push(...p.s);
    else if (p.v) head.push(p.v);
    else {
      const body = p.b ? cat([word(p.b.length), padTo32(p.b)]) : cat([word(p.ba.length), ...(() => {
        const heads = [], tails = []; let o = p.ba.length * 32;
        for (const x of p.ba) { heads.push(word(o)); const t = cat([word(x.length), padTo32(x)]); tails.push(t); o += t.length; }
        return [...heads, ...tails];
      })()]);
      head.push(word(off)); tail.push(body); off += body.length;
    }
  }
  return hex(cat([sel, ...head, ...tail]));
}
const INTENT_T = '(address,bytes32,uint256,uint256,uint64,uint64,uint64,bytes32)', TANK_T = '(address,address,uint256,uint256,uint64,uint256)';
const memoBytes = (m) => bytesOf(String(m).startsWith('0x') ? m : `0x${m}`);
export function encodeClaim(order) {
  const i = { s: intentWords(order.intent) }, sig = { b: bytesOf(order.signature) };
  return order.tank
    ? abiCall(`claimFromTank(${TANK_T},bytes,${INTENT_T},bytes)`, [{ s: tankWords(order.tank) }, { b: bytesOf(order.tankSignature) }, i, sig])
    : abiCall(`claim(${INTENT_T},bytes)`, [i, sig]);
}
export function encodeFulfill(order, proof) {
  const tail = [{ b: bytesOf(order.publicValues) }, { b: bytesOf(proof) }, { ba: (order.memos || []).map(memoBytes) }, { v: word(order.permit.v) }, { v: bytesOf(order.permit.r) }, { v: bytesOf(order.permit.s) }];
  const i = { s: intentWords(order.intent) }, sig = { b: bytesOf(order.signature) };
  return order.tank
    ? abiCall(`fulfillFromTank(${TANK_T},bytes,${INTENT_T},bytes,bytes,bytes,bytes[],uint8,bytes32,bytes32)`, [{ s: tankWords(order.tank) }, { b: bytesOf(order.tankSignature) }, i, sig, ...tail])
    : abiCall(`fulfill(${INTENT_T},bytes,bytes,bytes,bytes[],uint8,bytes32,bytes32)`, [i, sig, ...tail]);
}

/// The EIP-712 digest of a tank (its hash is the market's `spent` key and what a tank order's intent names).
export function tankDigest(tank, chainId = 1, market = MARKET[chainId]) {
  const domain = k256(k256(enc('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), k256(enc('TacitProofMarket')), k256(enc('1')), word(chainId), addrWord(market));
  const typehash = k256(enc('Tank(address payer,address delegate,uint256 cap,uint256 perOpMax,uint64 expiry,uint256 salt)'));
  const struct = k256(typehash, addrWord(tank.payer), addrWord(tank.delegate), word(tank.cap), word(tank.perOpMax), word(tank.expiry), word(tank.salt));
  return hex(k256(new Uint8Array([0x19, 0x01]), domain, struct));
}

/// Whether a proof the board handed back is for a wrap the holder meant: `built` is the wrap rebuilt from the key (its deposit and leaf are fixed by the
/// key and the index), `pending` carries the memos it was posted with (a rebuild draws new ones), and `back` is { publicValues, proof } from the board.
/// The public values must be exactly what that wrap's proof has, and the op id the order named.
export function handBackFits(built, pending, back) {
  try {
    if (!back || !/^0x([0-9a-fA-F]{2})+$/.test(String(back.proof || '')) || !/^0x([0-9a-fA-F]{2})+$/.test(String(back.publicValues || ''))) return false;
    const want = wrapOrderInputs({ ...built, memos: pending.memos }).publicValues;
    return String(back.publicValues).toLowerCase() === want.toLowerCase() && opIdOf(back.publicValues) === String(pending.opId).toLowerCase();
  } catch { return false; }
}
