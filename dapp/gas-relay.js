// The page side of TacitGasRelay (contracts/src/TacitGasRelay.sol): a wallet with no ETH swaps a token (or enters a Tacit pool) by signing ONE order,
// and pays whoever sends it in TAC or in the token spent. The order authorises exactly one call (hash-bound), once, from this wallet; the relay
// contract pulls the input and the fee with the wallet's permits, makes the call and pays the output to `recipient`, or reverts it all (the wallet
// pays nothing then). This module builds and signs; the page posts the order to the board (POST /gas/order) and the settle relay sends it.
import { keccak_256 } from './vendor/tacit-deps.min.js';

export const GAS_RELAY = { 1: '0x000000197E8f0B64463B2010e568fF42090Af88d' };
export const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const ZERO = '0x0000000000000000000000000000000000000000';
// tokens that take an ERC-2612 permit (name and version of their domain); any other token goes through Permit2 once the wallet has approved it
export const PERMIT_TOKENS = {
  [TAC.toLowerCase()]: { name: 'Tacit Token', version: '1' },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { name: 'USD Coin', version: '2' },
};
// a safe upper estimate of what the relay's transaction costs: a snwap swap is about 350k gas, a pool entry about 450k
export const GAS_UNITS = 450000n;
const lc = (s) => String(s || '').toLowerCase();
const hex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const bytesOf = (h) => { const s = String(h).replace(/^0x/, ''); const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return o; };

export const ORDER_TYPES = {
  Order: [
    { name: 'payer', type: 'address' }, { name: 'tokenIn', type: 'address' }, { name: 'amountIn', type: 'uint256' }, { name: 'feeToken', type: 'address' },
    { name: 'fee', type: 'uint256' }, { name: 'tokenOut', type: 'address' }, { name: 'minOut', type: 'uint256' }, { name: 'recipient', type: 'address' },
    { name: 'target', type: 'address' }, { name: 'dataHash', type: 'bytes32' }, { name: 'deadline', type: 'uint64' }, { name: 'nonce', type: 'uint256' },
  ],
};
const DOMAIN = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];

/// The order a wallet signs for the call `data` to `target`. `tokenOut` is address(0) for ETH. Everything is a string (JSON-safe).
export function buildOrder({ payer, tokenIn, amountIn, feeToken, fee, tokenOut = ZERO, minOut, recipient, target, data, ttlSecs = 600, now = Math.floor(Date.now() / 1000),
  nonce = BigInt('0x' + hex(crypto.getRandomValues(new Uint8Array(8))).slice(2)) }) {
  if (lc(feeToken) !== lc(tokenIn) && lc(feeToken) !== lc(TAC)) throw new Error('the fee is paid in TAC or the token spent');
  if (lc(tokenIn) === lc(tokenOut)) throw new Error('nothing to swap');
  return {
    order: { payer, tokenIn, amountIn: String(amountIn), feeToken, fee: String(fee), tokenOut, minOut: String(minOut), recipient, target, dataHash: hex(keccak_256(bytesOf(data))),
      deadline: String(now + ttlSecs), nonce: String(nonce) },
    data,
  };
}
export const orderTypedData = (order, chainId = 1, relay = GAS_RELAY[chainId]) => ({
  types: { EIP712Domain: DOMAIN, ...ORDER_TYPES }, primaryType: 'Order', domain: { name: 'TacitGasRelay', version: '1', chainId, verifyingContract: relay }, message: order,
});

/// The ERC-2612 permit typed data for `token` (the relay spends up to `value` until `deadline`), or null when the token is not one that takes it here.
export function permitTypedData({ token, owner, value, nonce, deadline, chainId = 1, relay = GAS_RELAY[chainId] }) {
  const t = PERMIT_TOKENS[lc(token)];
  if (!t) return null;
  return {
    types: { EIP712Domain: DOMAIN, Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'Permit', domain: { name: t.name, version: t.version, chainId, verifyingContract: token },
    message: { owner, spender: relay, value: String(value), nonce: String(nonce), deadline: String(deadline) },
  };
}
/// The Permit2 batch (one signature for the input and a fee in another token) the relay uses for a token with no ERC-2612.
export function permit2TypedData({ details, owner, deadline, chainId = 1, relay = GAS_RELAY[chainId] }) {
  const batch = { details: details.map((d) => ({ token: d.token, amount: String(d.amount), expiration: String(d.expiration ?? deadline), nonce: String(d.nonce) })), spender: relay, sigDeadline: String(deadline) };
  return {
    batch,
    typed: {
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        PermitBatch: [{ name: 'details', type: 'PermitDetails[]' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
        PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] },
      primaryType: 'PermitBatch', domain: { name: 'Permit2', chainId, verifyingContract: PERMIT2 }, message: batch,
    },
  };
}
export const splitSig = (sig) => { const h = String(sig).replace(/^0x/, ''); let v = parseInt(h.slice(128, 130), 16); if (v < 27) v += 27; return { v, r: '0x' + h.slice(0, 64), s: '0x' + h.slice(64, 128) }; };
export const NO_PERMIT = { value: '0', deadline: '0', v: 0, r: '0x' + '00'.repeat(32), s: '0x' + '00'.repeat(32) };
export const NO_P2 = { use: false, batch: { details: [], spender: ZERO, sigDeadline: '0' }, sig: '0x' };

/// The fee, in `feeToken`, that pays for the relay's transaction with a margin: the ETH it costs, sold for the token at `ethToToken(wei)` (a quote
/// of that many wei into the token, a route the page already reads). Rounded up, and never below `floor`.
export async function feeFor({ gasPriceWei, ethToToken, units = GAS_UNITS, marginBps = 15000, floor = 0n }) {
  const wei = (BigInt(gasPriceWei) * units * BigInt(marginBps)) / 10000n;
  const out = await ethToToken(wei);
  if (out == null || out <= 0n) return null;
  return out > floor ? out : floor;
}
/// Whether a wallet should go through the relay: it holds an ERC-20 to spend and not enough ETH to send the swap itself.
export const needsRelay = ({ ethWei, gasPriceWei, units = 300000n }) => BigInt(ethWei) < (BigInt(gasPriceWei) * units * 12n) / 10n;

/// The board calls. `post(path, body)` and `get(path)` are the page's own API helpers.
export const submitOrder = (post, order) => post('/gas/order', { order });
