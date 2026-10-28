// The prover side of ProofMarket: turns an ORDER (dapp/proof-market.js buildOrder) plus the proof for its op into the market calls.
// `claim` fixes the price and excludes other provers for the claim window; `fulfill` settles through the pool and is paid in the
// same call. Both are simulated first, so nothing is sent that would revert. Submit privately (a builder RPC), not to the public
// mempool: the proof is in the calldata, and the pool's settle is permissionless, so a copier could settle it before the claim lands.
//
// As a library: takeOrder({ order, proof, market, rpc, send, claimBond }). `send(to, data, value)` signs and submits (a private
// RPC in production, a test sender on a fork). `rpc(method, params)` reads. Returns { claimTx, fulfillTx, price }.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { encodeFunctionData } = require('viem');
import { abi, encodeClaim, encodeFulfill } from '../worker-relay/src/lib/market-calls.js';
export { abi, encodeClaim, encodeFulfill };

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
