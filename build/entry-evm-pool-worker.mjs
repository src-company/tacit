// Prove worker for the standalone EVM pool wallet bundle (entry-evm-pool-wallet.mjs): the same protocol as
// dapp/evm-pool-prove-worker.js, with snarkjs bundled in so it runs from a Blob with no imports.
//   { op: 'init', wasm, zkey, vk } → {}
//   { op: 'prove', input }         → { proof, publicSignals }   self-verified against vk

import * as snarkjs from 'snarkjs';
import { proveTransact, verifyTransact } from '../dapp/evm-pool-zk-prover.js';

let art = null;

self.onmessage = async ({ data: m }) => {
  const reply = (x) => self.postMessage({ id: m.id, ok: true, ...x });
  try {
    if (m.op === 'init') {
      art = { wasm: m.wasm, zkey: m.zkey, vk: m.vk };
      reply({});
    } else if (!art) {
      throw new Error('prover not initialised');
    } else if (m.op === 'prove') {
      let out;
      try { out = await proveTransact(m.input, { wasm: art.wasm, zkey: art.zkey, snarkjs }); }
      catch { out = await proveTransact(m.input, { wasm: art.wasm, zkey: art.zkey, snarkjs, singleThread: true }); }
      const { proof, publicSignals } = out;
      if (!(await verifyTransact(art.vk, publicSignals, proof, { snarkjs }))) throw new Error('fresh proof does not verify');
      reply({ proof, publicSignals });
    } else {
      throw new Error(`unknown op ${m.op}`);
    }
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, error: String(e?.message || e) });
  }
};
