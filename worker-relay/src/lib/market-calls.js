// The calls a prover makes to ProofMarket (contracts/src/ProofMarket.sol) from an ORDER (dapp/proof-market.js buildOrder) and the proof of
// its op: `claim` fixes the price and excludes other provers for the claim window, `fulfill` settles through the pool and is paid in the
// same call. Shared by the settle relay's market loop and tools/proof-market-solver.mjs.
import { encodeFunctionData, parseAbi } from 'viem';

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

// The call a claim / a fulfil makes, as a function name and arguments (for viem), or encoded.
export function claimCall(order) {
  const i = big(order.intent);
  return order.tank
    ? { functionName: 'claimFromTank', args: [big(order.tank), order.tankSignature, i, order.signature] }
    : { functionName: 'claim', args: [i, order.signature] };
}
export function fulfillCall(order, proof) {
  const i = big(order.intent), tail = [order.publicValues, proof, memosOf(order.memos), ...permitArgs(order.permit)];
  return order.tank
    ? { functionName: 'fulfillFromTank', args: [big(order.tank), order.tankSignature, i, order.signature, ...tail] }
    : { functionName: 'fulfill', args: [i, order.signature, ...tail] };
}
export const encodeClaim = (order) => encodeFunctionData({ abi, ...claimCall(order) });
export const encodeFulfill = (order, proof) => encodeFunctionData({ abi, ...fulfillCall(order, proof) });

/// The price the market charges `at` (unix seconds) for an order's intent (mirrors ProofMarket.priceAt).
export function priceAt(intent, at) {
  const floor = BigInt(intent.floorFee), max = BigInt(intent.maxFee), ramp = BigInt(intent.rampSecs), t = BigInt(at) - BigInt(intent.start);
  if (ramp === 0n || t >= ramp) return max;
  if (t <= 0n) return floor;
  return floor + ((max - floor) * t) / ramp;
}
