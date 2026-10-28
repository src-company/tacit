// The order board for ProofMarket (contracts/src/ProofMarket.sol, dapp/proof-market.js): holders post an ORDER, provers take it.
//
// An order is { payer, intent, signature, permit, publicValues, memos, stdin, tank?, tankSignature? }. It holds no secret: the signatures
// let the market pull up to the signed most from the payer only if the pool accepts exactly this op, and `stdin` is the program input of
// a wrap (dapp/sp1-stdin.js), which carries only a commitment and the signature that opens it (worker/src/proof-pool.js). A prover
// proves `stdin`, then calls the market (tools/proof-market-solver.mjs). The board checks what it can cheaply, so a prover does not
// spend a proof on junk: the shape and sizes, the op id (keccak of the public values), the deadline, the signatures (recovered to the
// payer, or for a tank order the tank to the payer and the intent to its delegate), and that `stdin` is a wrap whose proof would be
// exactly `publicValues`. The market itself is the authority: a prover simulates before it sends.
//
// Storage (KV): pm:order:<opId> (the order, expiring with its deadline) and pm:index (a list of { id, at, until, price } newest last, capped).
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import { readWrapStdin, wrapExpect, proofFits } from './proof-pool.js';

export const MARKET_BOARD = { maxOrders: 200, maxStdin: 4096, maxPublicValues: 8192, maxMemos: 8, maxMemoBytes: 2048, maxProof: 2048, maxProof: 2048, minTtlSecs: 60, maxTtlSecs: 6 * 3600, perClientPerHour: 20 };

const H = /^0x[0-9a-fA-F]{64}$/, A = /^0x[0-9a-fA-F]{40}$/, S = /^0x[0-9a-fA-F]{130}$/, NUM = /^\d{1,78}$/, HEX = /^0x([0-9a-fA-F]{2})*$/;
const k = (...p) => keccak_256(concatBytes(...p));
const enc = (s) => new TextEncoder().encode(s);
const word = (x) => { const b = new Uint8Array(32); let n = typeof x === 'bigint' ? x : BigInt(x); for (let i = 31; i >= 0; i--) { b[i] = Number(n & 0xffn); n >>= 8n; } return b; };
const addrWord = (a) => { const b = new Uint8Array(32); b.set(hexToBytes(a.slice(2)), 12); return b; };
const hx = (b) => '0x' + bytesToHex(b);

const INTENT_TYPEHASH = k(enc('Intent(address payer,bytes32 opId,uint256 floorFee,uint256 maxFee,uint64 start,uint64 rampSecs,uint64 deadline,bytes32 tank)'));
const TANK_TYPEHASH = k(enc('Tank(address payer,address delegate,uint256 cap,uint256 perOpMax,uint64 expiry,uint256 salt)'));
const DOMAIN_TYPEHASH = k(enc('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));

export function domainSeparator(chainId, market) {
  return k(DOMAIN_TYPEHASH, k(enc('TacitProofMarket')), k(enc('1')), word(chainId), addrWord(market));
}
const typed = (ds, structHash) => k(new Uint8Array([0x19, 0x01]), ds, structHash);
export const intentDigest = (ds, i) => typed(ds, k(INTENT_TYPEHASH, addrWord(i.payer), hexToBytes(i.opId.slice(2)), word(BigInt(i.floorFee)), word(BigInt(i.maxFee)), word(BigInt(i.start)), word(BigInt(i.rampSecs)), word(BigInt(i.deadline)), hexToBytes(i.tank.slice(2))));
export const tankDigest = (ds, t) => typed(ds, k(TANK_TYPEHASH, addrWord(t.payer), addrWord(t.delegate), word(BigInt(t.cap)), word(BigInt(t.perOpMax)), word(BigInt(t.expiry)), word(BigInt(t.salt))));

export function recoverSigner(digest, sigHex) {
  const sig = sigHex.replace(/^0x/, '');
  let v = parseInt(sig.slice(128, 130), 16);
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error('bad recovery id');
  const pub = secp.Signature.fromCompact(sig.slice(0, 128)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false).slice(1);
  return '0x' + bytesToHex(k(pub).slice(12));
}
const lc = (x) => String(x).toLowerCase();

// The reason an order is refused, or null when the board will list it.
export function checkOrder(order, { market, chainId = 1, now = Math.floor(Date.now() / 1000), cfg = MARKET_BOARD } = {}) {
  try {
    if (!order || typeof order !== 'object') return 'not an order';
    const { intent: i, signature, permit: p, publicValues, memos = [], stdin, tank, tankSignature } = order;
    if (!i || !A.test(i.payer) || !H.test(i.opId) || !H.test(i.tank) || !NUM.test(i.floorFee) || !NUM.test(i.maxFee) || !NUM.test(i.start) || !NUM.test(i.rampSecs) || !NUM.test(i.deadline)) return 'the intent is malformed';
    if (!S.test(signature || '')) return 'the signature is malformed';
    if (!p || !/^\d+$/.test(String(p.v)) || !H.test(p.r) || !H.test(p.s)) return 'the permit is malformed';
    if (!HEX.test(publicValues || '') || publicValues.length > 2 + 2 * cfg.maxPublicValues) return 'the public values are malformed';
    if (!Array.isArray(memos) || memos.length > cfg.maxMemos || memos.some((m) => !HEX.test(String(m).startsWith('0x') ? m : `0x${m}`) || String(m).length > 2 * cfg.maxMemoBytes + 2)) return 'the memos are malformed';
    if (BigInt(i.maxFee) < BigInt(i.floorFee)) return 'the most is below the floor';
    const dl = Number(i.deadline);
    if (dl < now + cfg.minTtlSecs) return 'the deadline is too near';
    if (dl > now + cfg.maxTtlSecs) return 'the deadline is too far';
    if (hx(k(hexToBytes(publicValues.slice(2)))) !== lc(i.opId)) return 'the public values are not this op\'s';
    // the input must be a wrap that proves exactly these public values
    if (!HEX.test(stdin || '') || stdin.length > 2 + 2 * cfg.maxStdin) return 'the program input is missing or too large';
    let w;
    try { w = readWrapStdin(hexToBytes(stdin.slice(2))); } catch (e) { return `the program input is not a wrap: ${e.message}`; }
    if (!proofFits(publicValues, wrapExpect(w))) return 'the program input does not prove these public values';
    const ds = domainSeparator(chainId, market);
    if (tank) {
      if (!tank || !A.test(tank.payer) || !A.test(tank.delegate) || !NUM.test(tank.cap) || !NUM.test(tank.perOpMax) || !NUM.test(tank.expiry) || !NUM.test(tank.salt) || !S.test(tankSignature || '')) return 'the tank is malformed';
      if (lc(tank.payer) !== lc(i.payer)) return 'the tank is not this payer\'s';
      if (BigInt(i.maxFee) > BigInt(tank.perOpMax)) return 'the most is above the tank\'s limit per op';
      if (Number(tank.expiry) < now) return 'the tank has expired';
      if (i.tank !== hx(tankDigest(ds, tank))) return 'the intent names another tank';
      if (lc(recoverSigner(tankDigest(ds, tank), tankSignature)) !== lc(tank.payer)) return 'the tank is not signed by its payer';
      if (lc(recoverSigner(intentDigest(ds, i), signature)) !== lc(tank.delegate)) return 'the intent is not signed by the tank\'s key';
    } else {
      if (/[^0]/.test(i.tank.slice(2))) return 'the intent names a tank the order does not carry';
      if (lc(recoverSigner(intentDigest(ds, i), signature)) !== lc(i.payer)) return 'the intent is not signed by its payer';
    }
    return null;
  } catch (e) { return `the order could not be read: ${e.message}`; }
}

export function makeMarketBoard({ kv, market, chainId = 1, cfg = MARKET_BOARD, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const readIndex = async () => { const s = await kv.get('pm:index'); try { return JSON.parse(s || '[]') || []; } catch { return []; } };
  const writeIndex = (list) => kv.put('pm:index', JSON.stringify(list.slice(-cfg.maxOrders)));
  return {
    async post(order) {
      const why = checkOrder(order, { market, chainId, now: now(), cfg });
      if (why) return { ok: false, error: why };
      const id = lc(order.intent.opId), until = Number(order.intent.deadline);
      if (await kv.get(`pm:order:${id}`)) return { ok: true, id, existing: true };
      const idx = (await readIndex()).filter((e) => e.until > now());
      if (idx.length >= cfg.maxOrders) return { ok: false, error: 'the board is full, try again shortly' };
      await kv.put(`pm:order:${id}`, JSON.stringify(order), { expirationTtl: Math.max(60, until - now() + 60) });
      idx.push({ id, at: now(), until, max: order.intent.maxFee, tank: !!order.tank });
      await writeIndex(idx);
      return { ok: true, id };
    },
    // The open orders, oldest first, each whole (a prover needs the order to take it).
    async list(limit = 20) {
      const idx = (await readIndex()).filter((e) => e.until > now()).slice(0, limit), out = [];
      for (const e of idx) { const s = await kv.get(`pm:order:${e.id}`); if (s) { try { out.push(JSON.parse(s)); } catch { /* skip */ } } }
      return out;
    },
    // A finished proof for an order, kept for its holder: when the holder never sends the deposit (a changed mind, an abandoned zap), the proof is not
    // lost: their page picks it up and keeps it as a voucher for the same wrap next time. It must be for this order's public values; whether it
    // verifies is the pool's to say when it is used, and the page checks it is for its own note before keeping it.
    async postProof(id, { publicValues, proof }) {
      id = lc(id);
      const s = await kv.get(`pm:order:${id}`);
      if (!s) return { ok: false, error: 'no such order on the board' };
      let o; try { o = JSON.parse(s); } catch { return { ok: false, error: 'unreadable order' }; }
      if (lc(publicValues) !== lc(o.publicValues)) return { ok: false, error: 'the proof is not for this order\'s public values' };
      if (!HEX.test(proof || '') || proof.length < 10 || proof.length > 2 + 2 * cfg.maxProof) return { ok: false, error: 'the proof is malformed or too large' };
      await kv.put(`pm:proof:${id}`, JSON.stringify({ publicValues: o.publicValues, proof, memos: o.memos || [] }), { expirationTtl: 24 * 3600 });
      return { ok: true };
    },
    async getProof(id) {
      const s = await kv.get(`pm:proof:${lc(id)}`);
      try { return s ? JSON.parse(s) : null; } catch { return null; }
    },
    // A finished proof for an order, kept for its holder: when the holder never sends the deposit (a changed mind, an abandoned zap), the proof is not
    // lost: their page picks it up and keeps it as a voucher for the same wrap next time. It must be for this order's public values; whether it
    // verifies is the pool's to say when it is used, and the page checks it is for its own note before keeping it.
    async postProof(id, { publicValues, proof }) {
      id = lc(id);
      const s = await kv.get(`pm:order:${id}`);
      if (!s) return { ok: false, error: 'no such order on the board' };
      let o; try { o = JSON.parse(s); } catch { return { ok: false, error: 'unreadable order' }; }
      if (lc(publicValues) !== lc(o.publicValues)) return { ok: false, error: 'the proof is not for this order\'s public values' };
      if (!HEX.test(proof || '') || proof.length < 10 || proof.length > 2 + 2 * cfg.maxProof) return { ok: false, error: 'the proof is malformed or too large' };
      await kv.put(`pm:proof:${id}`, JSON.stringify({ publicValues: o.publicValues, proof, memos: o.memos || [] }), { expirationTtl: 24 * 3600 });
      return { ok: true };
    },
    async getProof(id) {
      const s = await kv.get(`pm:proof:${lc(id)}`);
      try { return s ? JSON.parse(s) : null; } catch { return null; }
    },
    // A settled or lapsed order leaves the board (the market's `done(opId)` is the truth; a prover that sees it done calls this).
    async remove(id) {
      id = lc(id);
      await kv.delete(`pm:order:${id}`);
      await writeIndex((await readIndex()).filter((e) => e.id !== id));
      return { ok: true };
    },
  };
}
