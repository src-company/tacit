// The prover side of ProofMarket: turns an ORDER (dapp/proof-market.js buildOrder) plus the proof for its op into the market calls.
// `claim` fixes the price and excludes other provers for the claim window; `fulfill` settles through the pool and is paid in the
// same call. Both are simulated first, so nothing is sent that would revert. Submit privately (a builder RPC), not to the public
// mempool: the proof is in the calldata, and the pool's settle is permissionless, so a copier could settle it before the claim lands.
//
// As a library: takeOrder({ order, proof, market, rpc, send, claimBond }). `send(to, data, value)` signs and submits (a private
// RPC in production, a test sender on a fork). `rpc(method, params)` reads. Returns { claimTx, fulfillTx, price }.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { encodeFunctionData, parseAbi } = require('viem');

export const abi = parseAbi([
  'struct Intent { address payer; bytes32 opId; uint256 floorFee; uint256 maxFee; uint64 start; uint64 rampSecs; uint64 deadline; bytes32 tank; }',
  'struct Tank { address payer; address delegate; uint256 cap; uint256 perOpMax; uint64 expiry; uint256 salt; }',
  'function claim(Intent i, bytes signature) payable',
  'function claimFromTank(Tank t, bytes tankSig, Intent i, bytes intentSig) payable',
  'function fulfill(Intent i, bytes signature, bytes publicValues, bytes proofBytes, bytes[] memos, uint8 v, bytes32 r, bytes32 s)',
  'function fulfillFromTank(Tank t, bytes tankSig, Intent i, bytes intentSig, bytes publicValues, bytes proofBytes, bytes[] memos, uint8 v, bytes32 r, bytes32 s)',
  'function claimBond() view returns (uint256)',
  'function claims(bytes32 opId) view returns (address solver, uint64 until, uint256 price, uint256 bond, bytes32 intentHash)',
  'function done(bytes32 opId) view returns (bool)',
]);
const big = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, /^\d+$/.test(String(v)) ? BigInt(v) : v]));
const memosOf = (m = []) => m.map((x) => (String(x).startsWith('0x') ? x : `0x${x}`));
const permitArgs = (p) => [Number(p.v), p.r, p.s];

export function encodeClaim(order) {
  const i = big(order.intent);
  return order.tank
    ? encodeFunctionData({ abi, functionName: 'claimFromTank', args: [big(order.tank), order.tankSignature, i, order.signature] })
    : encodeFunctionData({ abi, functionName: 'claim', args: [i, order.signature] });
}
export function encodeFulfill(order, proof) {
  const i = big(order.intent), tail = [order.publicValues, proof, memosOf(order.memos), ...permitArgs(order.permit)];
  return order.tank
    ? encodeFunctionData({ abi, functionName: 'fulfillFromTank', args: [big(order.tank), order.tankSignature, i, order.signature, ...tail] })
    : encodeFunctionData({ abi, functionName: 'fulfill', args: [i, order.signature, ...tail] });
}

const hexToBig = (h) => BigInt(h);
export async function takeOrder({ order, proof, market, rpc, send, from }) {
  const call = (data, value = 0n) => rpc('eth_call', [{ from, to: market, data, value: '0x' + value.toString(16) }, 'latest']);
  const opId = order.intent.opId;
  const read = (fn, args) => call(encodeFunctionData({ abi, functionName: fn, args }));
  if (hexToBig(await read('done', [opId])) === 1n) throw new Error('the op is already settled');
  const bond = hexToBig(await read('claimBond', []));
  const cd = encodeClaim(order);
  await call(cd, bond);                                         // throws if the market would refuse the claim
  const claimTx = await send(market, cd, bond);
  const fd = encodeFulfill(order, proof);
  await call(fd);                                               // throws if the pool refuses the proof or the payer can no longer pay
  const fulfillTx = await send(market, fd, 0n);
  return { claimTx, fulfillTx };
}
