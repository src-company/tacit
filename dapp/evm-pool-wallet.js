// Wallet for the EVM pool (contracts/src/TacitEvmPool.sol) on one chain: keys from the Tacit identity, notes found in
// the pool's Transact events and the router's Received events, and spends proved on this device and submitted by a
// relayer (worker-relay/src/evm-pool-keeper.js), so the user needs no gas and no funded address.
//
// Keys are the Bitcoin pool's: seed = HMAC-SHA256(identity key, "tacit-btc-pool-seed-v1"), wallet under the
// "mainnet" tag, so one Secret Sats address (bp1…) receives in both pools.
//
// Memo, one per output note, 65 bytes: pk_eph (33) ‖ ct (16) ‖ tag (16).
//   s    = compress(e·V) for the sender, compress(v·pk_eph) for the recipient (V = v·G, the address's view key)
//   npk, rho from outputKeys(A, N, s)                                      (dapp/btc-pool-zk.js, as the Bitcoin pool)
//   k    = keccak256("tacit-evm-pool-aead-v1" ‖ s)
//   ct   = be16(value) ⊕ keccak256(k ‖ 0x0000)[0..16)
//   tag  = keccak256("tacit-evm-pool-aead-tag-v1" ‖ k ‖ ct)[0..16)
// A memo is accepted only if its leaf recomputes: Poseidon(asset, value, npk, rho) = the output's leaf.

import { secp, keccak_256, sha256, hmac, concatBytes } from './vendor/tacit-deps.min.js';
import { makeBtcShieldedPool } from './btc-shielded-pool.js';
import { poolAsset, extDataHash } from './evm-pool-zk.js';
import { receiveKeys, receivedNote, receiveBoxAddress, RECEIVE_FEE_BPS, RECEIVE_INDEX } from './evm-pool-gateway.js';

export const MEMO_LEN = 65;
const te = new TextEncoder();
const TAG_AEAD = te.encode('tacit-evm-pool-aead-v1');
const TAG_MAC = te.encode('tacit-evm-pool-aead-tag-v1');
const SEED_TAG = te.encode('tacit-btc-pool-seed-v1');
const ZERO = '0x0000000000000000000000000000000000000000';
const VMAX = 1n << 120n;
const G = secp.ProjectivePoint.BASE;
const N_SECP = secp.CURVE.n;

const hex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => { const s = String(h).replace(/^0x/, ''); return Uint8Array.from(s.match(/../g) || [], (b) => parseInt(b, 16)); };
const toBig = (b) => { let x = 0n; for (const c of b) x = (x << 8n) | BigInt(c); return x; };
const be = (v, n) => { let x = BigInt(v); const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const word = (x) => be(BigInt(x), 32);
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const randomScalar = () => { for (;;) { const s = toBig(globalThis.crypto.getRandomValues(new Uint8Array(32))) % N_SECP; if (s) return s; } };

// ── keys ──

// { v, V, a, n, A, N, address (bp1…), zkWallet } from a 32-byte Tacit identity key.
export function evmPoolKeys(zk, identityPriv) {
  if (!(identityPriv instanceof Uint8Array) || identityPriv.length !== 32) throw new Error('evm-pool-wallet: identity key must be 32 bytes');
  const pool = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 });
  const seed = hmac(sha256, identityPriv, SEED_TAG);
  const w = pool.walletFromSeed(seed, 'mainnet');
  const zkWallet = zk.walletKeys(seed, 'mainnet');
  return { v: BigInt(w.v), V: G.multiply(BigInt(w.v)), zkWallet, A: zkWallet.A, N: zkWallet.N, address: w.addressString, pool };
}

// ── memos ──

function seal(s, value) {
  const k = keccak_256(concatBytes(TAG_AEAD, s));
  const ks = keccak_256(concatBytes(k, new Uint8Array(2))).subarray(0, 16);
  const ct = be(value, 16).map((b, i) => b ^ ks[i]);
  return concatBytes(ct, keccak_256(concatBytes(TAG_MAC, k, ct)).subarray(0, 16));
}
function open(s, sealed) {
  const k = keccak_256(concatBytes(TAG_AEAD, s));
  const ct = sealed.subarray(0, 16);
  if (!eq(sealed.subarray(16, 32), keccak_256(concatBytes(TAG_MAC, k, ct)).subarray(0, 16))) return null;
  const ks = keccak_256(concatBytes(k, new Uint8Array(2))).subarray(0, 16);
  return toBig(ct.map((b, i) => b ^ ks[i]));
}

// An output note of `value` for a recipient { V (secp point), A, N (BabyJub) }: { v, npk, rho, leaf, memo }.
export function sealNote(zk, { to, value, asset, e = randomScalar() }) {
  const v = BigInt(value);
  if (v < 0n || v >= VMAX) throw new Error('evm-pool-wallet: value must be below 2^120');
  const s = to.V.multiply(BigInt(e)).toRawBytes(true);
  const o = zk.outputKeys(to.A, to.N, s);
  return { v, npk: o.npk, rho: o.rho, leaf: zk.leafOf(asset, v, o.npk, o.rho), memo: concatBytes(G.multiply(BigInt(e)).toRawBytes(true), seal(s, v)) };
}

// The owned note behind (memo, leaf), or null: { v, rho, sk, nk, npk, s }.
export function openNote(zk, keys, { memo, leaf, asset }) {
  const m = memo instanceof Uint8Array ? memo : unhex(memo);
  if (m.length !== MEMO_LEN) return null;
  let s;
  try { s = secp.ProjectivePoint.fromHex(m.subarray(0, 33)).multiply(keys.v).toRawBytes(true); } catch { return null; }
  const v = open(s, m.subarray(33));
  if (v === null || v >= VMAX) return null;
  const o = zk.ownedKeys(keys.zkWallet, s);
  if (zk.leafOf(asset, v, o.npk, o.rho) !== BigInt(leaf)) return null;
  return { v, rho: o.rho, sk: o.sk, nk: o.nk, npk: o.npk, s };
}

// A recipient from a Secret Sats address string.
export function recipientOf(keys, address) {
  const d = keys.pool.decodeAddress(String(address).trim());
  return { V: d.V, A: d.A, N: d.N };
}

// ── chain ──

const TRANSACT_TOPIC = hex(keccak_256(te.encode('Transact(bytes32,bytes32,bytes32,bytes32,uint256,bytes32,address,int256,address,uint256,bytes,bytes)')));
const RECEIVED_TOPIC = hex(keccak_256(te.encode('Received(address,uint256,uint256,uint256,uint256,uint256)')));

export function jsonRpc(urls, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const list = Array.isArray(urls) ? urls : [urls];
  let id = 0;
  return async (method, params = []) => {
    let last;
    for (const url of list) {
      try {
        const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
        const j = await r.json();
        if (j.error) throw Object.assign(new Error(j.error.message || 'rpc error'), { rpc: j.error });
        return j.result;
      } catch (e) { last = e; if (e.rpc && !/range|limit|too many|exceed/i.test(e.message)) throw e; }
    }
    throw last;
  };
}

function decodeTransact(log) {
  const d = unhex(log.data);
  const w = (i) => d.subarray(32 * i, 32 * i + 32);
  const bytesAt = (off) => { const o = Number(toBig(d.subarray(off, off + 32))); const len = Number(toBig(d.subarray(o, o + 32))); return d.slice(o + 32, o + 32 + len); };
  return {
    nf: [BigInt(log.topics[1]), BigInt(log.topics[2])],
    outLeaf: [toBig(w(0)), toBig(w(1))],
    firstIndex: Number(toBig(w(2))),
    memo: [bytesAt(32 * 8), bytesAt(32 * 9)],
    block: Number(BigInt(log.blockNumber)),
    tx: log.transactionHash,
  };
}
function decodeReceived(log) {
  const d = unhex(log.data);
  const w = (i) => toBig(d.subarray(32 * i, 32 * i + 32));
  return { n: BigInt(log.topics[2]), index: Number(w(0)), value: w(1), rho: w(2), fee: w(3), block: Number(BigInt(log.blockNumber)), tx: log.transactionHash };
}

// ── wallet ──

// chain: { chainId, pool, router, rpc (a jsonRpc), deployBlock, logChunk?, confirmations? }
// keeper: base URL of a keeper (…/evm-pool/keeper) or null; prove(input) → { proof, publicSignals } (snarkjs shape);
// store: { get(k), set(k, v) } for the synced state, or null to keep it in memory. What is stored is view-level only
// (leaves, and each owned note's position, value, rho and shared secret); spend keys are derived in memory.
export function makeEvmPoolWallet({ zk, keys, chain, keeper = null, prove, store = null, fetchImpl = globalThis.fetch?.bind(globalThis) }) {
  const asset = poolAsset({ chainId: BigInt(chain.chainId), pool: chain.pool, token: ZERO });
  const box = receiveBoxAddress(receiveKeys(zk, keys.zkWallet, RECEIVE_INDEX).npk, RECEIVE_FEE_BPS, chain.router);
  const boxTopic = '0x' + box.slice(2).toLowerCase().padStart(64, '0');
  const confirmations = chain.confirmations ?? 12;
  const skey = `tacit-evm-pool-v1:${chain.chainId}:${chain.pool.toLowerCase()}:${keys.address}`;

  const blank = () => ({ block: Number(chain.deployBlock ?? 0) - 1, leaves: [], notes: [], spent: [] });
  let saved = blank();
  try { const j = store?.get(skey); if (j) saved = JSON.parse(j); } catch {}
  let view = null; // saved state plus the unconfirmed tail, from the last sync

  // Spend and nullifier keys of a stored note, from the wallet keys: never stored.
  const recvKeys = () => receiveKeys(zk, keys.zkWallet, RECEIVE_INDEX);
  function withKeys(n) {
    if (n.nk) return n;
    const k = n.kind === 'receive' ? recvKeys() : zk.ownedKeys(keys.zkWallet, unhex(n.s));
    return { ...n, sk: k.sk.toString(), nk: k.nk.toString(), nf: zk.nullifier(k.nk, BigInt(n.leaf), n.index).toString() };
  }
  saved = { ...saved, notes: saved.notes.map(withKeys) };
  const persist = () => {
    const bare = { ...saved, notes: saved.notes.map(({ sk, nk, nf, ...rest }) => rest) };
    try { store?.set(skey, JSON.stringify(bare)); } catch {}
  };
  const noteKey = (n) => `${n.index}`;

  function absorb(state, transacts, receipts) {
    const spent = new Set(state.spent);
    const notes = new Map(state.notes.map((n) => [noteKey(n), n]));
    const leaves = state.leaves.slice();
    for (const t of transacts) {
      for (const nf of t.nf) if (nf !== 0n) spent.add(nf.toString());
      if (t.outLeaf[0] === 0n && t.outLeaf[1] === 0n) continue;
      if (t.firstIndex !== leaves.length) throw new Error(`evm-pool-wallet: leaf ${t.firstIndex} out of order (have ${leaves.length})`);
      leaves.push(t.outLeaf[0].toString(), t.outLeaf[1].toString());
      for (let k = 0; k < 2; k++) {
        if (t.outLeaf[k] === 0n || !t.memo[k].length) continue;
        const o = openNote(zk, keys, { memo: t.memo[k], leaf: t.outLeaf[k], asset });
        if (o && o.v > 0n) {
          const index = t.firstIndex + k;
          notes.set(`${index}`, withKeys({ index, leaf: t.outLeaf[k].toString(), v: o.v.toString(), rho: o.rho.toString(), s: hex(o.s), block: t.block, tx: t.tx, kind: 'memo' }));
        }
      }
    }
    for (const r of receipts) {
      const n = receivedNote(zk, keys.zkWallet, RECEIVE_INDEX, r);
      const leaf = BigInt(leaves[r.index] ?? -1);
      if (leaf < 0n || n.v === 0n) continue;
      notes.set(`${r.index}`, withKeys({ index: r.index, leaf: leaf.toString(), v: n.v.toString(), rho: n.rho.toString(), block: r.block, tx: r.tx, kind: 'receive' }));
    }
    return { ...state, leaves, notes: [...notes.values()].sort((a, b) => a.index - b.index), spent: [...spent] };
  }

  async function logs(address, topics, from, to) {
    const out = [];
    let step = Number(chain.logChunk ?? 5000);
    for (let a = from; a <= to;) {
      const b = Math.min(to, a + step - 1);
      try {
        out.push(...await chain.rpc('eth_getLogs', [{ address, topics, fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }]));
        a = b + 1;
      } catch (e) {
        if (step > 100 && /range|limit|too many|exceed|10000/i.test(String(e.message))) { step = Math.floor(step / 4); continue; }
        throw e;
      }
    }
    return out;
  }

  // Reads new events: those `confirmations` deep are kept, the rest are re-read next time.
  async function sync() {
    const tip = Number(BigInt(await chain.rpc('eth_blockNumber')));
    const safe = tip - confirmations;
    const from = saved.block + 1;
    if (from > tip) return summary();
    const [tlogs, rlogs] = await Promise.all([
      logs(chain.pool, [TRANSACT_TOPIC], from, tip),
      logs(chain.router, [RECEIVED_TOPIC, boxTopic], from, tip),
    ]);
    const ts = tlogs.map(decodeTransact).sort((a, b) => a.block - b.block || a.firstIndex - b.firstIndex);
    const rs = rlogs.map(decodeReceived);
    if (safe >= from) {
      saved = { ...absorb(saved, ts.filter((t) => t.block <= safe), rs.filter((r) => r.block <= safe)), block: safe };
      persist();
    }
    view = absorb(saved, ts.filter((t) => t.block > safe), rs.filter((r) => r.block > safe));
    return summary();
  }

  const state = () => view || saved;
  const unspent = () => { const s = new Set(state().spent); return state().notes.filter((n) => !s.has(n.nf) && !pending.has(n.nf)); };
  const pending = new Set();
  function summary() {
    const u = unspent();
    return { balance: u.reduce((a, n) => a + BigInt(n.v), 0n), notes: u.length, leaves: state().leaves.length, block: saved.block };
  }

  // ── spending ──

  async function keeperGet(path) {
    if (!keeper) throw new Error('no relayer is configured for this chain');
    const r = await fetchImpl(`${keeper}${path}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `relayer returned ${r.status}`);
    return j;
  }
  async function keeperPost(path, body) {
    if (!keeper) throw new Error('no relayer is configured for this chain');
    const r = await fetchImpl(`${keeper}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, body: j };
  }

  // Up to two unspent notes covering `need`, smallest sufficient first; null if no two do.
  function select(need) {
    const u = unspent().sort((a, b) => (BigInt(a.v) < BigInt(b.v) ? -1 : 1));
    const one = u.find((n) => BigInt(n.v) >= need);
    if (one) return [one];
    for (let i = u.length - 1; i > 0; i--) for (let j = i - 1; j >= 0; j--) if (BigInt(u[i].v) + BigInt(u[j].v) >= need) return [u[i], u[j]];
    return null;
  }
  const asInput = (n) => ({ v: BigInt(n.v), rho: BigInt(n.rho), nk: BigInt(n.nk), sk: BigInt(n.sk), index: n.index });
  const toTx = (proof, publicSignals, rest) => ({
    pA: [proof.pi_a[0], proof.pi_a[1]].map(String),
    pB: [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]].map((r) => r.map(String)),
    pC: [proof.pi_c[0], proof.pi_c[1]].map(String),
    publicInputs: publicSignals.map(String),
    ...rest,
  });

  // One relayed transaction: spends `ins`, creates `outs` ([{ to, value } | null] × 2), pays out `amount` to
  // `recipient` (0 for a transfer). Re-proves when another transaction lands first. → tx hash.
  async function relay({ ins, outs, amount, recipient, fee, relayer, onStep = () => {} }) {
    const sealed = outs.map((o) => (o ? sealNote(zk, { to: o.to, value: o.value, asset }) : null));
    const memo0 = sealed[0]?.memo ?? new Uint8Array(), memo1 = sealed[1]?.memo ?? new Uint8Array();
    const extAmount = -BigInt(amount);
    const inputs = [...ins.map(asInput), ...Array(2 - ins.length).fill({ dummy: true })];
    for (let round = 0; round < 4; round++) {
      if (round) { onStep('someone else got in first, proving again'); await sync(); }
      const eh = extDataHash({ chainId: BigInt(chain.chainId), pool: chain.pool, recipient, extAmount, relayer, fee, memo0, memo1 });
      const w = zk.buildWitness({ asset, leaves: state().leaves.map(BigInt), inputs, outputs: sealed.map((o) => (o ? { v: o.v, npk: o.npk, rho: o.rho } : null)), extAmount, fee, extDataHash: eh });
      onStep('proving on this device');
      const { proof, publicSignals } = await prove(w.input);
      onStep('sending through the relayer');
      const tx = toTx(proof, publicSignals, { recipient, extAmount: extAmount.toString(), relayer, fee: fee.toString(), memo0: hex(memo0), memo1: hex(memo1) });
      const r = await keeperPost('/relay', { tx });
      if (r.status === 200 && r.body.txHash) {
        for (const n of ins) pending.add(n.nf);
        return r.body.txHash;
      }
      if (r.status === 409 && r.body.stale) continue;
      throw new Error(r.body.error || `relayer returned ${r.status}`);
    }
    throw new Error('the pool kept moving; try again');
  }

  // Merges the two largest notes into one, repeatedly, until two notes cover `need` (each merge pays a fee).
  async function prepare(need, q, onStep) {
    for (let guard = 0; guard < 8; guard++) {
      const pick = select(need);
      if (pick) return pick;
      const u = unspent().sort((a, b) => (BigInt(b.v) < BigInt(a.v) ? -1 : 1));
      if (u.length < 2) break;
      const total = BigInt(u[0].v) + BigInt(u[1].v);
      if (total <= BigInt(q.fee)) break;
      onStep('combining notes first');
      await relay({ ins: [u[0], u[1]], outs: [{ to: keys, value: total - BigInt(q.fee) }, null], amount: 0n, recipient: ZERO, fee: BigInt(q.fee), relayer: q.relayer, onStep });
      await waitFor(() => unspent().some((n) => BigInt(n.v) === total - BigInt(q.fee)));
    }
    throw new Error('not enough in the pool for this amount and its fee');
  }
  async function waitFor(ok, ms = 180_000) {
    const t0 = Date.now();
    for (;;) {
      await sync();
      if (ok()) return;
      if (Date.now() - t0 > ms) throw new Error('timed out waiting for the previous transaction');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  const self = { V: keys.V, A: keys.A, N: keys.N };

  return {
    address: keys.address,
    receiveBox: box,
    asset,
    sync,
    summary,
    notes: () => unspent(),
    quote: () => keeperGet('/quote'),
    // Asks the relayer to watch this wallet's receive box (and look now).
    watchReceive: () => keeperPost('/receive', { chainId: chain.chainId, npk: receiveKeys(zk, keys.zkWallet, RECEIVE_INDEX).npk.toString(), feeBps: RECEIVE_FEE_BPS }),

    // Pays `amount` wei out of the pool to `to` (0x…). → tx hash.
    async withdraw({ to, amount, onStep = () => {} }) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(to)) || BigInt(to) === 0n) throw new Error('enter a 0x address');
      const a = BigInt(amount);
      if (a <= 0n) throw new Error('enter an amount');
      await sync();
      const q = await keeperGet('/quote');
      const fee = BigInt(q.fee);
      const ins = await prepare(a + fee, q, onStep);
      const change = ins.reduce((s, n) => s + BigInt(n.v), 0n) - a - fee;
      return relay({ ins, outs: [change > 0n ? { to: self, value: change } : null, null], amount: a, recipient: to, fee, relayer: q.relayer, onStep });
    },

    // Sends `amount` wei privately to a Secret Sats address. → tx hash.
    async send({ to, amount, onStep = () => {} }) {
      const recipient = recipientOf(keys, to);
      const a = BigInt(amount);
      if (a <= 0n) throw new Error('enter an amount');
      await sync();
      const q = await keeperGet('/quote');
      const fee = BigInt(q.fee);
      const ins = await prepare(a + fee, q, onStep);
      const change = ins.reduce((s, n) => s + BigInt(n.v), 0n) - a - fee;
      return relay({ ins, outs: [{ to: recipient, value: a }, { to: self, value: change }], amount: 0n, recipient: ZERO, fee, relayer: q.relayer, onStep });
    },
  };
}
