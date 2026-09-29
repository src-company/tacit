// Before a cBTC mint is paid for, read the gate ConfidentialPool.settle applies to it: the pool has recorded the lock
// with the mint's sats, the lock is not already minted, spent or redeemed, no reflected effect is still queued, and
// the collateral engine holds the lock's bond. A mint that fails any of these can only revert, whatever its proof,
// so it is failed without proving, with a reason the user can act on. Anything unreadable lets the job through, so
// the check only ever skips work that cannot succeed.
import { pad } from 'viem';

const view = (name, inputs, output) => ({ type: 'function', name, stateMutability: 'view', inputs: inputs.map((type) => ({ type })), outputs: [{ type: output }] });
const POOL_ABI = [
  view('cbtcLockVBtc', ['bytes32'], 'uint64'), view('cbtcMinted', ['bytes32'], 'bool'), view('cbtcLockSpent', ['bytes32'], 'bool'),
  view('cbtcLockRedeemed', ['bytes32'], 'bool'), view('pendingOverflowChunks', [], 'uint256'), view('COLLATERAL_ENGINE', [], 'address'),
];
const ENGINE_ABI = [
  view('escrowSufficient', ['bytes32', 'uint256'], 'bool'), view('escrowSlashed', ['bytes32'], 'bool'),
  view('escrowTotal', ['bytes32'], 'uint256'), view('requiredEscrow', ['uint256'], 'uint256'),
];

const isHex32 = (v) => typeof v === 'string' && /^(0x)?[0-9a-fA-F]{1,64}$/.test(v);
const wst = (x) => (Number(BigInt(x)) / 1e18).toFixed(5);

// A reason string when the mint's settle can only revert, else null.
export async function cbtcMintBlocker({ type, op }, { client, pool }) {
  if (type !== 'cbtcmint' || !op || !isHex32(op.outpoint) || op.vBtc == null) return null;
  try {
    const outpoint = pad(op.outpoint.startsWith('0x') ? op.outpoint : `0x${op.outpoint}`, { size: 32 });
    const want = BigInt(op.vBtc);
    const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
    const [have, minted, spent, redeemed, queued, engine] = await Promise.all([
      read(pool, POOL_ABI, 'cbtcLockVBtc', [outpoint]), read(pool, POOL_ABI, 'cbtcMinted', [outpoint]),
      read(pool, POOL_ABI, 'cbtcLockSpent', [outpoint]), read(pool, POOL_ABI, 'cbtcLockRedeemed', [outpoint]),
      read(pool, POOL_ABI, 'pendingOverflowChunks'), read(pool, POOL_ABI, 'COLLATERAL_ENGINE'),
    ]);
    if (BigInt(have) === 0n) return 'the pool has not recorded this lock yet; the reflection has to fold its Bitcoin block first';
    if (BigInt(have) !== want) return `the pool records ${have} sats for this lock, the mint asks for ${want}`;
    if (minted) return 'this lock is already minted';
    if (spent) return 'this lock was spent on Bitcoin';
    if (redeemed) return 'this lock is redeemed';
    if (BigInt(queued) !== 0n) return 'a reflected effect is still queued on the pool; minting resumes once it is drained';
    if (await read(engine, ENGINE_ABI, 'escrowSufficient', [outpoint, want])) return null;
    if (await read(engine, ENGINE_ABI, 'escrowSlashed', [outpoint])) return "this lock's bond was slashed";
    const [posted, need] = await Promise.all([
      read(engine, ENGINE_ABI, 'escrowTotal', [outpoint]), read(engine, ENGINE_ABI, 'requiredEscrow', [want]).catch(() => null),
    ]);
    return `no bond for this lock: the collateral engine holds ${wst(posted)} wstETH${need == null ? '' : ` of the ${wst(need)} required`}`;
  } catch { return null; }
}
