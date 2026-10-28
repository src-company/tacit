// A settle proof asked of the network directly, from a program input built here: several ops of different types in one
// proof (lib/prover.js proveMixed), where each per-op binary proves one op (or one transfer batch). The request is signed
// by the relay's prover account, and its input goes as the binaries' does: private first with PRIVATE_STDIN=1 (public once
// the network refuses private inputs, unless PRIVATE_FALLBACK_PUBLIC=0), else public. The network's RPC speaks HTTP/2 only.

import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha256.js';
import { makeSelfProver } from './spn/self-prover.js';
import { batchStdin, batchLimits } from './spn/sp1-stdin.js';
import { addressOf } from './spn/succinct-net.js';
import { http2Fetch } from './http2-fetch.js';
import { CREDIT_SHORT } from './prove-pause.js';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const crypto = { secp, keccak256: keccak_256 };
const hex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => { const s = String(h).replace(/^0x/, ''); const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16); return out; };

// How a request's input goes, from the env the binaries read: 'auto' (private, then public when the network refuses),
// 'private' (private only) or 'public'; and the provers a private input is for (PROVER_WHITELIST, else the client's default).
export function inputPolicy(env) {
  const input = env.PRIVATE_STDIN !== '1' ? 'public' : env.PRIVATE_FALLBACK_PUBLIC === '0' ? 'private' : 'auto';
  const list = String(env.PROVER_WHITELIST || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { input, whitelist: list.length ? list : undefined };
}

// A request the network did not run to the end: its input does not execute (the guest stopped on it), or the proof that
// came back is not of our program. The input was wrong, so asking again the same way would fail the same way.
export const notExecuted = (e) => !!e && ((e.code === 'not_proved' && (/unexecutable/i.test(String(e.reason || '')) || (e.network && e.network.executionStatus === 3)))
  || e.code === 'proof_mismatch');

// The input over `items` ([{ type, op, memos }]) with each op's memo hashes, and the request's limits: what a worker proves and
// what the network is asked for.
export function batchInput(items) {
  const withHashes = items.map(({ type, op, memos = [] }) => ({ type, op: { ...op, memoHashes: memos.map((m) => hex(keccak_256(unhex(m)))) } }));
  const { stdin, numOps } = batchStdin(withHashes);
  return { stdin, numOps, ...batchLimits(items.map((i) => i.type)) };
}

// `key`: the prover account's key. `prover` may stand in for the network client in a test.
export function makeStdinProver({ key, rpc, env = process.env, transport = null, prover = null } = {}) {
  if (!key) throw new Error('stdin-prover: the prover account key is missing');
  const address = addressOf(crypto, key);
  const { input, whitelist } = inputPolicy(env);
  const t = transport || http2Fetch();
  const p = prover || makeSelfProver({ priv: () => key, address, ...crypto, transport: t, proxyBase: null, ...(rpc ? { rpc } : {}), input, whitelist });

  // `items`: [{ type, op, memos }] in the order they settle. The guest commits to keccak256 of each memo, in order, after
  // the last op, so each op's memo hashes ride on its op and the input lists them in op order (sp1-stdin.js batchStdin).
  // `timeoutMs` bounds the whole prove: the request's deadline is set three minutes inside it, and the wait runs to the
  // deadline and two minutes past. → { publicValues, proof, requestId, private, numOps }
  async function proveBatch({ items, timeoutMs = 15 * 60_000, onUpdate = () => {} }) {
    const { stdin, numOps, cycleLimit, gasLimit } = batchInput(items);
    const timeoutSecs = Math.max(300, Math.floor(timeoutMs / 1000) - 180);
    try {
      const r = await p.proveStdin({ stdin, cycleLimit, gasLimit, timeoutSecs, onUpdate });
      return { publicValues: r.publicValues, proof: r.proof, requestId: r.requestId, private: r.private, numOps };
    } catch (e) {
      // Marked as lib/prover.js marks a binary's refusal, so the loop's pause reads both the same way.
      if (e && (e.code === 'prover_credit' || CREDIT_SHORT.test(String(e.message || e)))) e.creditShort = true;
      throw e;
    }
  }
  // One program input already built (a market order's wrap), with its own limits: the same request as proveBatch makes.
  async function proveRaw({ stdin, cycleLimit, gasLimit, timeoutMs = 120_000, onUpdate = () => {} }) {
    const timeoutSecs = Math.max(300, Math.floor(timeoutMs / 1000) - 180);
    try {
      const r = await p.proveStdin({ stdin, cycleLimit, gasLimit, timeoutSecs, onUpdate });
      return { publicValues: r.publicValues, proof: r.proof, requestId: r.requestId, private: r.private };
    } catch (e) {
      if (e && (e.code === 'prover_credit' || CREDIT_SHORT.test(String(e.message || e)))) e.creditShort = true;
      throw e;
    }
  }
  return { address, input, proveBatch, proveRaw, close: () => { if (t && typeof t.close === 'function') t.close(); } };
}
