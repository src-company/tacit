// The call a relay makes to TacitGasRelay (contracts/src/TacitGasRelay.sol) from a posted order (dapp/gas-relay.js, worker/src/gas-relay-queue.js).
import { encodeFunctionData, parseAbi } from 'viem';

export const abi = parseAbi([
  'struct Order { address payer; address tokenIn; uint256 amountIn; address feeToken; uint256 fee; address tokenOut; uint256 minOut; address recipient; address target; bytes32 dataHash; uint64 deadline; uint256 nonce; }',
  'struct Permit { uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }',
  'struct PermitDetails { address token; uint160 amount; uint48 expiration; uint48 nonce; }',
  'struct PermitBatch { PermitDetails[] details; address spender; uint256 sigDeadline; }',
  'struct P2Auth { bool use; PermitBatch batch; bytes sig; }',
  'function execute(Order o, bytes signature, bytes data, Permit inPermit, Permit feePermit, P2Auth p2)',
  'function used(address payer, uint256 nonce) view returns (bool)',
]);
const big = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, /^\d+$/.test(String(v)) ? BigInt(v) : v]));
const permit = (p) => ({ value: BigInt(p.value), deadline: BigInt(p.deadline), v: Number(p.v), r: p.r, s: p.s });
const p2 = (x) => (x && x.use ? { use: true, batch: { details: x.batch.details.map((d) => ({ token: d.token, amount: BigInt(d.amount), expiration: Number(d.expiration), nonce: Number(d.nonce) })), spender: x.batch.spender, sigDeadline: BigInt(x.batch.sigDeadline) }, sig: x.sig }
  : { use: false, batch: { details: [], spender: '0x0000000000000000000000000000000000000000', sigDeadline: 0n }, sig: '0x' });
export const executeCall = (x) => ({ functionName: 'execute', args: [big(x.order), x.signature, x.data, permit(x.inPermit), permit(x.feePermit), p2(x.p2)] });
export const encodeExecute = (x) => encodeFunctionData({ abi, ...executeCall(x) });
