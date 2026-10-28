// The client side of ProofMarket (contracts/src/ProofMarket.sol): a holder pays a prover in TAC for an entry op to be proved and settled,
// with nothing sent from the holder's wallet but two signatures. An ORDER is what a prover needs to take the op: the signed intent (or
// the tank and the delegate-signed intent), the TAC permit, and the op's public values, proof and memos. It holds no secret: the
// payer's signatures only let the market pull up to the signed most, and only if the pool accepts exactly this op.
//
// A direct order covers one op: { payer, intent, signature, permit, publicValues, memos }. A tank order covers many under one signed
// package: { payer, tank, tankSignature, intent, signature (by the tank's delegate key), permit (for the tank cap), ... }.
import { keccak_256 } from './vendor/tacit-deps.min.js';

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
