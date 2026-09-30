// Before a proof is paid for, look on chain for inputs the settle would consume that are already gone: a note whose
// nullifier is recorded as spent, or a wrap deposit that was already consumed. Such a settle can only revert (the
// usual cause is a job served again after its first settle landed), so it is failed without proving.
//
// Every id is recomputed from the job's own witness fields with the guest's formulas (cxfer-core leaf, native_nu,
// deposit id). Anything unrecognised or unreadable lets the job through, so the check only ever skips work that
// cannot succeed.
import { keccak256, concat, pad, toHex, numberToHex } from 'viem';

const NATIVE_NULLIFIER_DOM = toHex('tacit-native-nullifier-v1');
const SPENT = toHex('spent');
const NULLIFIER_SPENT_SLOT = pad('0x46', { size: 32 }); // ConfidentialPool.nullifierSpent, declaration slot 70
const MAX_READS = 64;
const DEPOSIT_STATUS_ABI = [{ type: 'function', name: 'depositStatus', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint8' }] }];
const DEPOSIT_CONSUMED = 2;

const isHex32 = (v) => typeof v === 'string' && /^(0x)?[0-9a-fA-F]{1,64}$/.test(v);
const b32 = (v) => pad(String(v).startsWith('0x') ? String(v) : `0x${v}`, { size: 32 });

export const noteLeaf = (asset, cx, cy, owner) => keccak256(concat([b32(asset), b32(cx), b32(cy), b32(owner)]));
export const noteNullifier = ({ asset, cx, cy, owner, nk }) => {
  const leaf = noteLeaf(asset, cx, cy, owner);
  return BigInt(b32(owner)) === 0n ? keccak256(concat([leaf, SPENT])) : keccak256(concat([b32(nk), leaf, NATIVE_NULLIFIER_DOM]));
};
export const depositIdOf = ({ asset, value, cx, cy, owner }) =>
  keccak256(concat([b32(asset), numberToHex(BigInt(value), { size: 32 }), keccak256(concat([b32(cx), b32(cy), b32(owner)]))]));

// The public deposits a wrap-family op consumes, in the fields its prover harness reads (harnesses/exec-<type>.rs).
export function depositsOf(type, op) {
  const d = (asset, value, n) => (n && isHex32(asset) && value != null && n.cx && n.cy && n.owner ? [{ asset, value, cx: n.cx, cy: n.cy, owner: n.owner }] : []);
  switch (type) {
    case 'wrap': return d(op.asset, op.value, op);
    case 'wraptransfer': return d(op.asset, op.value, op.deposit);
    case 'wraplp': return [...d(op.assetA, op.a && op.a.value, op.a), ...d(op.assetB, op.b && op.b.value, op.b)];
    case 'wrapswap': return d(Number(op.direction) === 0 ? op.assetA : op.assetB, op.amountIn, op.deposit);
    default: return [];
  }
}

// Every spent note in the witness: an object carrying the note's secret key (`nk`, or `secret` in the transfer wire)
// next to its commitment and owner. Output notes never carry a secret. The asset is the note's own when the wire
// states it, the matching side of a pair for the `a`/`b` legs, else each asset the op names.
export function spentInputsOf(op) {
  const out = [];
  const walk = (node, key, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) { for (const x of node) walk(x, key, depth + 1); return; }
    const nk = node.nk ?? node.secret;
    if (typeof nk === 'string' && node.cx && node.cy && node.owner) {
      const assets = node.asset ? [node.asset] : key === 'a' ? [op.assetA] : key === 'b' ? [op.assetB] : [op.asset, op.assetA, op.assetB];
      for (const asset of new Set(assets.filter(isHex32))) out.push({ asset, cx: node.cx, cy: node.cy, owner: node.owner, nk });
    }
    for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') walk(v, k, depth + 1);
  };
  walk(op, '', 0);
  return out;
}

// The first input the job's settle would consume that is already gone, as { kind: 'deposit' | 'nullifier', id,
// reason }, else null.
export async function consumedInput({ type, op }, { client, pool }) {
  try {
    if (!op || typeof op !== 'object') return null;
    let reads = 0;
    for (const dep of depositsOf(type, op)) {
      if (++reads > MAX_READS) return null;
      const id = depositIdOf(dep);
      const status = await client.readContract({ address: pool, abi: DEPOSIT_STATUS_ABI, functionName: 'depositStatus', args: [id] });
      if (Number(status) === DEPOSIT_CONSUMED) return { kind: 'deposit', id, reason: `deposit ${id} was already consumed` };
    }
    for (const nu of new Set(spentInputsOf(op).map(noteNullifier))) {
      if (++reads > MAX_READS) return null;
      const word = await client.getStorageAt({ address: pool, slot: keccak256(concat([nu, NULLIFIER_SPENT_SLOT])) });
      if (word && word !== '0x' && BigInt(word) !== 0n) return { kind: 'nullifier', id: nu, reason: `input nullifier ${nu} is already spent` };
    }
  } catch { return null; }
  return null;
}

// How a job whose input is already gone is acked, given the transaction found carrying its own memos (`own`) or else
// the one that consumed the input (`by`). Its own settle landing is the job settled. So is its deposit consumed by any
// settle: a deposit's id commits to the note it becomes and only its owner can open it, so whoever sent that settle
// (the page itself, another settler), the job is done. A spent note is another matter: a different op may have spent it.
export function consumedAck(gone, { own = null, by = null } = {}) {
  if (own) return { txHash: own };
  if (gone.kind === 'deposit' && by) return { txHash: by, settledBy: by };
  const where = by ? ` in ${by}` : '';
  return { error: gone.kind === 'deposit' ? `this deposit was already settled into a private note${where}`
    : `this note was already spent${where}; if that was this same request, it went through` };
}

// A reason string when the job's settle can only revert, else null.
export async function consumedInputs(job, ctx) {
  const gone = await consumedInput(job, ctx);
  return gone ? gone.reason : null;
}

// The deposits a relayed wrap-family op consumes that the pool has not recorded at all. Unreadable reads count as
// present, so this only ever names a deposit the chain says is not there.
export async function unlandedDeposits({ type, op }, { client, pool }) {
  const out = [];
  try {
    if (!op || typeof op !== 'object') return out;
    for (const dep of depositsOf(type, op).slice(0, MAX_READS)) {
      const id = depositIdOf(dep);
      const status = await client.readContract({ address: pool, abi: DEPOSIT_STATUS_ABI, functionName: 'depositStatus', args: [id] });
      if (Number(status) === 0) out.push(id);
    }
  } catch { return []; }
  return out;
}

