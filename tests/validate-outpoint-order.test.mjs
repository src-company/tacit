// Ancestry validation must not depend on the order inputs are listed or discovered in.
//
// A transaction can spend an output of an earlier transaction and, in the same input list, a
// descendant of another output of that same earlier transaction. Every parent has to be settled
// before the transaction that spends it, whichever input comes first. This builds those shapes
// with real proofs and runs them through both the dapp validator and the test mirror.
//
// Run: `node tests/validate-outpoint-order.test.mjs`
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import {
  modN, pointToBytes, bigintToBytes32, randomScalar, _bpGens, bpRangeAggProve,
} from './bulletproofs.mjs';
import {
  assetIdFor, encodeCEtchPayload, encodeCXferPayload, computeKernelMsg, signSchnorr,
} from './composition.mjs';
import { encodeEnvelopeScript, validateOutpoint as validateMirror } from './indexer.mjs';

const store = new Map();
const el = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : el()), apply: () => el(), set: () => true });
globalThis.window = globalThis;
globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => el(), addEventListener() {}, body: el(), head: el(), documentElement: el(), readyState: 'complete' };
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear(), key: i => [...store.keys()][i] ?? null, get length() { return store.size; } };
globalThis.location = { href: 'http://localhost/', origin: 'http://localhost', hash: '', search: '', pathname: '/', protocol: 'http:', host: 'localhost', hostname: 'localhost' };
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', onLine: true, language: 'en' }, configurable: true }); } catch {}
globalThis.addEventListener = () => {};
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;

const { validateOutpoint: validateDapp } = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
async function test(label, fn) {
  try {
    const ok = await fn();
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    ok ? pass++ : fail++;
  } catch (e) {
    console.log(`  THROW ${label} ${e.message}`);
    fail++;
  }
}

_bpGens();

let counter = 0;
const nextTxid = () => {
  const b = new Uint8Array(32);
  new DataView(b.buffer).setUint32(28, ++counter, false);
  return bytesToHex(b);
};

function newChain() {
  const txs = new Map();
  const fetch = async id => txs.get(id) || null;
  const envelopeTx = (envelope, inputs) => ({
    vin: [
      { txid: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), vout: 0, witness: [bytesToHex(new Uint8Array(64)), bytesToHex(envelope), bytesToHex(new Uint8Array(33))] },
      ...inputs.map(i => ({ txid: i.txid, vout: i.vout, witness: [bytesToHex(new Uint8Array(64)), bytesToHex(new Uint8Array(33))] })),
    ],
  });
  const etch = supply => {
    const blinding = randomScalar();
    const { proof, commitments } = bpRangeAggProve([supply], [blinding]);
    const payload = encodeCEtchPayload({
      ticker: 'TST', decimals: 0, commitment: pointToBytes(commitments[0]), rangeproof: proof,
      encryptedAmount: new Uint8Array(8), mintAuthority: null,
    });
    const txid = nextTxid();
    txs.set(txid, envelopeTx(encodeEnvelopeScript(crypto.getRandomValues(new Uint8Array(32)), payload), []));
    return { txid, vout: 0, amount: supply, blinding, assetIdHex: bytesToHex(assetIdFor(txid, 0)) };
  };
  const xfer = (assetIdHex, inputs, amounts) => {
    const outs = amounts.map(amount => ({ amount, blinding: randomScalar() }));
    const { proof, commitments } = bpRangeAggProve(outs.map(o => o.amount), outs.map(o => o.blinding));
    const commits = commitments.map(pointToBytes);
    const excess = modN(outs.reduce((s, o) => modN(s + o.blinding), 0n) - inputs.reduce((s, i) => modN(s + i.blinding), 0n));
    const msg = computeKernelMsg(hexToBytes(assetIdHex), inputs.map(i => ({ txid: i.txid, vout: i.vout })), commits);
    const payload = encodeCXferPayload({
      assetId: hexToBytes(assetIdHex), kernelSig: signSchnorr(msg, bigintToBytes32(excess)),
      outputs: commits.map(commitment => ({ commitment, encryptedAmount: new Uint8Array(8) })), rangeproof: proof,
    });
    const txid = nextTxid();
    txs.set(txid, envelopeTx(encodeEnvelopeScript(crypto.getRandomValues(new Uint8Array(32)), payload), inputs));
    return outs.map((o, vout) => ({ txid, vout, amount: o.amount, blinding: o.blinding }));
  };
  return { fetch, etch, xfer };
}

const validators = [['dapp', validateDapp], ['mirror', validateMirror]];

for (const [name, validate] of validators) {
  console.log(`\n${name}:`);

  await test('merge of a split output and a descendant of its sibling', async () => {
    const c = newChain();
    const e = c.etch(1000n);
    const [x0, x1] = c.xfer(e.assetIdHex, [e], [300n, 700n]);
    const [p0] = c.xfer(e.assetIdHex, [x1], [700n]);
    const [n0] = c.xfer(e.assetIdHex, [x0, p0], [1000n]);
    return (await validate(n0.txid, 0, new Map(), c.fetch)) === true;
  });

  await test('same merge with the inputs listed the other way round', async () => {
    const c = newChain();
    const e = c.etch(1000n);
    const [x0, x1] = c.xfer(e.assetIdHex, [e], [300n, 700n]);
    const [p0] = c.xfer(e.assetIdHex, [x1], [700n]);
    const [n0] = c.xfer(e.assetIdHex, [p0, x0], [1000n]);
    return (await validate(n0.txid, 0, new Map(), c.fetch)) === true;
  });

  await test('wide merge across two split generations', async () => {
    const c = newChain();
    const e = c.etch(1000n);
    const [x0, x1, x2, x3] = c.xfer(e.assetIdHex, [e], [250n, 250n, 250n, 250n]);
    const [p1] = c.xfer(e.assetIdHex, [x1], [250n]);
    const [p2] = c.xfer(e.assetIdHex, [x2], [250n]);
    const [q] = c.xfer(e.assetIdHex, [p1, x3], [500n]);
    const [n0] = c.xfer(e.assetIdHex, [x0, q, p2], [1000n]);
    return (await validate(n0.txid, 0, new Map(), c.fetch)) === true;
  });

  await test('every ancestor of a valid merge reads valid from the shared cache', async () => {
    const c = newChain();
    const e = c.etch(1000n);
    const [x0, x1] = c.xfer(e.assetIdHex, [e], [300n, 700n]);
    const [p0] = c.xfer(e.assetIdHex, [x1], [700n]);
    const [n0] = c.xfer(e.assetIdHex, [x0, p0], [1000n]);
    const set = new Map();
    await validate(n0.txid, 0, set, c.fetch);
    return [e, x0, x1, p0, n0].every(u => set.get(`${u.txid}:${u.vout}`) === true);
  });

  await test('a merge whose amounts do not balance is still rejected', async () => {
    const c = newChain();
    const e = c.etch(1000n);
    const [x0, x1] = c.xfer(e.assetIdHex, [e], [300n, 700n]);
    const [p0] = c.xfer(e.assetIdHex, [x1], [700n]);
    const [n0] = c.xfer(e.assetIdHex, [x0, p0], [1001n]);
    return (await validate(n0.txid, 0, new Map(), c.fetch)) === false;
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
