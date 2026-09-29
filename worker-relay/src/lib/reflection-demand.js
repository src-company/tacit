// Bitcoin state someone is waiting on right now.
//
// The header relay spends only when gas is cheap unless the reflection is needed, and the clearest sign it is needed
// is a user who has done their part and is waiting on it: a cBTC lock bonded through the escrow helper, in the last
// `lookbackBlocks`, that the pool has not recorded yet, is not minted, and still holds its bond. Minting it waits on
// the reflection folding the lock's block, which needs headers past it. A bond older than the window no longer counts,
// so a lock that never confirms cannot keep the relay spending.
import { parseAbiItem } from 'viem';

const STAKED = parseAbiItem('event HelperEscrowStaked(bytes32 indexed outpoint, address indexed depositor, uint256 ethIn, uint256 wstEthOut)');
const POSTED = parseAbiItem('event HelperEscrowPosted(bytes32 indexed outpoint, address indexed depositor, uint256 amount)');
const POOL_ABI = [
  { type: 'function', name: 'cbtcLockVBtc', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'cbtcMinted', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] },
];
const ENGINE_ABI = [{ type: 'function', name: 'escrowTotal', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }] }];

// → { waiting, bonded, oldestAgeBlocks }: bonded locks the reflection still has to record, out of those bonded in the
// window, and how many Ethereum blocks ago the longest-waiting of them was bonded (null when none waits).
export async function cbtcLockDemand({ client, pool, helper, engine, lookbackBlocks = 7200n, chunk = 5000n }) {
  const head = await client.getBlockNumber();
  const floor = head > lookbackBlocks ? head - lookbackBlocks : 0n;
  const outpoints = new Map();                    // outpoint → the block it was first bonded in
  for (let from = floor; from <= head; from += chunk) {
    const to = from + chunk - 1n > head ? head : from + chunk - 1n;
    const logs = await client.getLogs({ address: helper, events: [STAKED, POSTED], fromBlock: from, toBlock: to });
    for (const l of logs) {
      const o = l.args?.outpoint?.toLowerCase();
      if (o && !outpoints.has(o)) outpoints.set(o, BigInt(l.blockNumber ?? head));
    }
  }
  let waiting = 0, oldest = null;
  for (const [o, at] of outpoints) {
    const [vBtc, minted, bond] = await Promise.all([
      client.readContract({ address: pool, abi: POOL_ABI, functionName: 'cbtcLockVBtc', args: [o] }),
      client.readContract({ address: pool, abi: POOL_ABI, functionName: 'cbtcMinted', args: [o] }),
      client.readContract({ address: engine, abi: ENGINE_ABI, functionName: 'escrowTotal', args: [o] }),
    ]);
    if (BigInt(vBtc) === 0n && !minted && BigInt(bond) > 0n) { waiting++; if (oldest === null || at < oldest) oldest = at; }
  }
  return { waiting, bonded: outpoints.size, oldestAgeBlocks: oldest === null ? null : Number(head - oldest) };
}
