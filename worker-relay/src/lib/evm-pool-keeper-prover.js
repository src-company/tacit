// Groth16 proving for the keeper's deposit completions (dapp/circuits/evm-pool/transact.circom), and the
// Poseidon-backed witness model. Every fresh proof is verified against the verification key before it is
// submitted, and the key can be pinned by hash.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEvmPoolZk } from '../../../dapp/evm-pool-zk.js';
import { proveTransact, verifyTransact, vkHash as hashVk } from '../../../dapp/evm-pool-zk-prover.js';

export async function loadPoseidon() {
  const p = await import('poseidon-lite');
  const byArity = { 2: p.poseidon2, 3: p.poseidon3, 4: p.poseidon4, 5: p.poseidon5, 7: p.poseidon7 };
  return (xs) => {
    const f = byArity[xs.length];
    if (!f) throw new Error(`no Poseidon of arity ${xs.length}`);
    return f(xs);
  };
}

export async function loadZk() {
  return makeEvmPoolZk({ poseidon: await loadPoseidon() });
}

async function loadSnarkjs() {
  try { return await import('snarkjs'); }
  catch { return (await import('../../../dapp/vendor/tacit-mixer.min.js')).snarkjs; }
}

// snarkjs proof → the verifier's calldata shape (G2 coordinates swapped, as exportSolidityCallData does).
export function toSolidityProof(proof, publicSignals) {
  const b = (x) => BigInt(x);
  return {
    pA: [b(proof.pi_a[0]), b(proof.pi_a[1])],
    pB: [[b(proof.pi_b[0][1]), b(proof.pi_b[0][0])], [b(proof.pi_b[1][1]), b(proof.pi_b[1][0])]],
    pC: [b(proof.pi_c[0]), b(proof.pi_c[1])],
    publicInputs: publicSignals.map(b),
  };
}

const sha256hex = (b) => createHash('sha256').update(b).digest('hex');

// A local path, or an https URL pinned by SHA-256 and cached under `dir` (fetched once, checked on every load).
export async function loadArtifact(src, { sha256 = '', dir, name, fetchImpl = fetch }) {
  const want = String(sha256).replace(/^0x/, '').toLowerCase();
  if (!/^https:\/\//.test(src)) {
    const b = readFileSync(src);
    if (want && sha256hex(b) !== want) throw new Error(`${name} at ${src} does not match its pinned sha256`);
    return b;
  }
  if (!/^[0-9a-f]{64}$/.test(want)) throw new Error(`${name} is fetched from a URL, so its sha256 must be pinned`);
  const file = join(dir, `${name}-${want}`);
  if (existsSync(file)) {
    const b = readFileSync(file);
    if (sha256hex(b) === want) return b;
  }
  const r = await fetchImpl(src);
  if (!r.ok) throw new Error(`${name}: ${src} returned ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  if (sha256hex(b) !== want) throw new Error(`${name} from ${src} does not match its pinned sha256`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${file}.tmp`, b);
  renameSync(`${file}.tmp`, file);
  return b;
}

// → { prove(input) → { pA, pB, pC, publicInputs }, vkHash }. wasm / zkey / vk are paths or pinned https URLs.
export async function makeKeeperProver({ wasm, zkey, vk, vkHash = '', wasmSha256 = '', zkeySha256 = '', artifactDir = '', singleThread = false }) {
  const opts = (name, sha256) => ({ name, sha256, dir: artifactDir });
  const remoteVk = /^https:\/\//.test(vk);
  if (remoteVk && !vkHash) throw new Error('the verification key is fetched from a URL, so EVM_POOL_VK_HASH must pin it');
  let vkBytes;
  if (remoteVk) {
    const r = await fetch(vk);
    if (!r.ok) throw new Error(`vk: ${vk} returned ${r.status}`);
    vkBytes = Buffer.from(await r.arrayBuffer());
  } else vkBytes = readFileSync(vk);
  const vkJson = JSON.parse(vkBytes.toString('utf8'));
  const hash = hashVk(vkJson);
  if (vkHash && hash !== vkHash.replace(/^0x/, '').toLowerCase()) throw new Error(`verification key ${hash} is not the pinned ${vkHash}`);
  const snarkjs = await loadSnarkjs();
  const wasmBytes = await loadArtifact(wasm, opts('wasm', wasmSha256));
  const zkeyBytes = await loadArtifact(zkey, opts('zkey', zkeySha256));
  return {
    vkHash: hash,
    async prove(input) {
      const { proof, publicSignals } = await proveTransact(input, { wasm: wasmBytes, zkey: zkeyBytes, snarkjs, singleThread });
      if (!(await verifyTransact(vkJson, publicSignals, proof, { snarkjs }))) throw new Error('fresh proof does not verify');
      return toSolidityProof(proof, publicSignals);
    },
  };
}
