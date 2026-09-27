// Standalone private-ETH wallet for the Tacit EVM pool (docs/EVM-POOL.md), as one ES module with no imports: the
// wallet (dapp/evm-pool-wallet.js), Poseidon, and a prove worker with snarkjs 0.7.6 started from a Blob. Built by
// build/build-evm-pool-wallet.mjs into dapp/evm-pool/tacit-evm-pool-wallet.js.
//
//   const w = await makeEvmPoolWallet({ provider, chainId, identityKey, artifacts: { wasm, zkey, vk }, relay? });
//   await w.sync()                  → { balance, notes, leaves, block }
//   w.balance()                     → wei (from the last sync)
//   w.address                       → the Secret Sats address (bp1…) others pay privately
//   w.receive.address               → the private ETH address (any plain transfer lands in the pool)
//   await w.receive.waiting()       → wei at the private ETH address, not yet swept
//   await w.receive.sweep()         → sweeps it from the user's wallet, no fee   → tx hash
//   await w.deposit(wei)            → deposits from the user's wallet            → tx hash
//   await w.send(bp1, wei)          → private payment                            → tx hash
//   await w.withdraw(0x…, wei)      → out of the pool to any address             → tx hash
//   await w.quote()                 → the relayer's { fee, receiveMin, … } (needs relay)
//   await w.bridgeOut(l2, wei, { l2Rpc }) → from the Ethereum pool to this wallet's private ETH address on Base
//                                     (8453) or Robinhood Chain (4663, needs l2Rpc) via the canonical bridge
//                                     (needs relay)                              → tx hash
//   await w.toV1(wei, commit, { via }) → from the Ethereum pool into a V1 tETH note (wei a multiple of 1e10;
//                                     commit = V1's own wrap commitment, confidential-pool-ux buildWrap(...).commit;
//                                     the V1 wallet then settles it as any wrap)   → tx hash
//   await w.rescan()                → rebuilds the synced state from chain logs alone (no keeper feed)
//   await w.setArtifacts({ wasm, zkey, vk }) → the proving files, if not given at open
//   w.terminate()                   → stops the prove worker
// Each action takes an optional last argument { via: 'self' | 'relay', onStep(msg) }. Without `relay` everything
// is proved here and submitted by `provider`; with it, send and withdraw go through that keeper unless via: 'self',
// and confirmed history is read from the keeper's /events feed, checked against the pool before it is kept.
//
// provider:    an EIP-1193 provider on `chainId` (the user's wallet); it signs and, unless `rpc` is given, reads.
//              Opening does not ask it to connect; the first action that sends does. Optional with `rpc` for a
//              view-only wallet.
// identityKey: the 32-byte Tacit identity key (Uint8Array or 0x hex). Keys, notes and the private ETH address all
//              derive from it; nothing that can spend leaves this module.
// artifacts:   the ceremony's transact.wasm and transact_final.zkey (bytes) and transact_vk.json (bytes, string or
//              object), or an async function returning them, called the first time an action proves; or nothing,
//              then w.setArtifacts(...) before proving. Address, balance and sync never need them. Each file is
//              checked against PIN before use.
// relay:       a keeper base, …/evm-pool/keeper.   rpc: URL or URLs to read from instead of the provider.
// store:       { get(k), set(k, v) } to keep the synced (view-level) state across loads.

import { poseidon2 } from 'poseidon-lite/poseidon2';
import { poseidon3 } from 'poseidon-lite/poseidon3';
import { poseidon4 } from 'poseidon-lite/poseidon4';
import { poseidon5 } from 'poseidon-lite/poseidon5';
import { poseidon7 } from 'poseidon-lite/poseidon7';
import { makeEvmPoolZk } from '../dapp/evm-pool-zk.js';
import { evmPoolKeys, makeEvmPoolWallet as makeCore, jsonRpc } from '../dapp/evm-pool-wallet.js';
import { vkHash } from '../dapp/evm-pool-zk-prover.js';
import WORKER_SRC from 'evm-pool-worker-source';

export const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
export const ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
export const CHAINS = { 1: { deployBlock: 26069245 }, 8453: { deployBlock: 51864014 }, 4663: { deployBlock: 73991661 } };
export const PIN = {
  wasm_sha256: '02dd5e84970e5bc629a7a3cd4d7eae5fc9ca05579fa22c9b39b5ea70c8d8a6c1',
  zkey_sha256: '40758061a0786fb0bdc5e5dec4c354bbf85fc106f7412716e25e781af4e79c4b',
  vk_hash: '43d11e6e1607e1ea7f3980c9bca91beed95e2e80d173d0873189e99d402e5757',
};

const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });

const hexOf = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const bytesOf = (x) => (x instanceof Uint8Array ? x : x instanceof ArrayBuffer ? new Uint8Array(x) : null);
const sha256 = async (b) => hexOf(await crypto.subtle.digest('SHA-256', b));

async function checkedArtifacts({ wasm, zkey, vk }) {
  const w = bytesOf(wasm), z = bytesOf(zkey);
  if (!w || !z) throw new Error('artifacts.wasm and artifacts.zkey must be bytes');
  if ((await sha256(w)) !== PIN.wasm_sha256) throw new Error('transact.wasm does not match the ceremony pin');
  if ((await sha256(z)) !== PIN.zkey_sha256) throw new Error('transact_final.zkey does not match the ceremony pin');
  const v = typeof vk === 'string' ? JSON.parse(vk) : bytesOf(vk) ? JSON.parse(new TextDecoder().decode(bytesOf(vk))) : vk;
  if (vkHash(v) !== PIN.vk_hash) throw new Error('the verification key does not match the ceremony pin');
  return { wasm: w, zkey: z, vk: v };
}

function startProver(art) {
  const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  let id = 0;
  const waiting = new Map();
  worker.onmessage = ({ data }) => { const w = waiting.get(data.id); if (!w) return; waiting.delete(data.id); data.ok ? w.resolve(data) : w.reject(new Error(data.error)); };
  worker.onerror = (e) => { for (const w of waiting.values()) w.reject(new Error(e.message || 'prove worker failed')); waiting.clear(); };
  const call = (msg) => new Promise((resolve, reject) => { const i = ++id; waiting.set(i, { resolve, reject }); worker.postMessage({ ...msg, id: i }); });
  const ready = call({ op: 'init', wasm: art.wasm, zkey: art.zkey, vk: art.vk });
  return {
    prove: async (input) => { await ready; const r = await call({ op: 'prove', input }); return { proof: r.proof, publicSignals: r.publicSignals }; },
    terminate: () => worker.terminate(),
  };
}

export async function makeEvmPoolWallet({ provider = null, chainId, identityKey, artifacts = null, relay = null, rpc = null, store = null, confirmations = 3, deployBlock = null }) {
  if (provider && !provider.request) throw new Error('provider must be an EIP-1193 provider');
  if (!provider && !rpc) throw new Error('give a provider, or rpc for a view-only wallet');
  const id = Number(chainId);
  const read = rpc ? jsonRpc(rpc) : (method, params = []) => provider.request({ method, params });
  if (Number(BigInt(await read('eth_chainId'))) !== id) throw new Error(`the RPC is not on chain ${id}`);
  const key = typeof identityKey === 'string' ? Uint8Array.from(identityKey.replace(/^0x/, '').match(/../g).map((h) => parseInt(h, 16))) : identityKey;
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error('identityKey must be 32 bytes');

  // The prover starts the first time an action proves, from the files given now, later, or by the loader.
  let art = artifacts && typeof artifacts !== 'function' ? await checkedArtifacts(artifacts) : null;
  const loader = typeof artifacts === 'function' ? artifacts : null;
  let prover = null;
  const getProver = async () => {
    if (prover) return prover;
    if (!art) {
      if (!loader) throw new Error('the proving files are not set: pass artifacts or call setArtifacts');
      art = await checkedArtifacts(await loader());
    }
    return (prover = startProver(art));
  };

  let from = null;
  const signer = provider && {
    get address() { return from; },
    async ready() {
      if (from) return;
      if (Number(BigInt(await provider.request({ method: 'eth_chainId' }))) !== id) throw new Error(`the wallet is not on chain ${id}`);
      from = (await provider.request({ method: 'eth_requestAccounts' }))[0];
    },
    async send({ to, data, value }) {
      await this.ready();
      return provider.request({ method: 'eth_sendTransaction', params: [{ from, to, data, value: '0x' + BigInt(value).toString(16) }] });
    },
  };

  const keys = evmPoolKeys(zk, key);
  const w = makeCore({
    zk, keys, keeper: relay, store, signer, prove: async (input) => (await getProver()).prove(input),
    chain: { chainId: id, pool: POOL, router: ROUTER, rpc: read, deployBlock: deployBlock ?? CHAINS[id]?.deployBlock ?? 0, confirmations },
  });
  let last = null;
  const opts = (o = {}) => ({ via: o.via ?? null, onStep: o.onStep ?? (() => {}) });
  return {
    address: w.address,
    sync: async () => (last = await w.sync()),
    balance: () => (last ? last.balance : 0n),
    notes: () => w.notes(),
    receive: {
      address: w.receiveBox,
      waiting: () => w.waiting(),
      sweep: (o) => w.sweep(opts(o)),
    },
    deposit: (wei, o) => w.deposit({ amount: wei, ...opts(o) }),
    send: (to, wei, o) => w.send({ to, amount: wei, ...opts(o) }),
    withdraw: (to, wei, o) => w.withdraw({ to, amount: wei, ...opts(o) }),
    quote: () => w.quote(),
    bridgeOut: (toChainId, wei, o = {}) => w.bridgeOut({ toChainId, amount: wei, l2Rpc: o.l2Rpc ? jsonRpc(o.l2Rpc) : null, onStep: o.onStep ?? (() => {}) }),
    toV1: (wei, commit, o = {}) => w.toV1({ amount: wei, commit, ...opts(o) }),
    rescan: async () => (last = await w.rescan()),
    setArtifacts: async (a) => { art = await checkedArtifacts(a); prover?.terminate(); prover = null; },
    terminate: () => { prover?.terminate(); prover = null; },
  };
}
