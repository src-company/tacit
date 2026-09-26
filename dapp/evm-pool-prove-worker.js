// Module worker for the EVM pool prover (evm-pool-zk-prover.js): holds the circuit and key so proving never blocks
// the page.
//   { op: 'init', wasm, zkey, vk } → {}
//   { op: 'prove', input }         → { proof, publicSignals }   self-verified against vk
// Threaded proving is about four times faster but holds a wasm heap per thread; if it fails (low memory), the proof
// is retried on one thread.

import { proveTransact, verifyTransact } from './evm-pool-zk-prover.js';

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
      try { out = await proveTransact(m.input, { wasm: art.wasm, zkey: art.zkey }); }
      catch { out = await proveTransact(m.input, { wasm: art.wasm, zkey: art.zkey, singleThread: true }); }
      const { proof, publicSignals } = out;
      if (!(await verifyTransact(art.vk, publicSignals, proof))) throw new Error('fresh proof does not verify');
      reply({ proof, publicSignals });
    } else {
      throw new Error(`unknown op ${m.op}`);
    }
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, error: String(e?.message || e) });
  }
};
