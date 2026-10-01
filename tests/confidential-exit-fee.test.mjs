// A TAC note's relayed exit is priced as cTAC (the pool row), not the public TAC row that shares its asset id, and a
// fee the relay refuses at submit is quoted once more at twice the floor before the user hears about it.
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';

const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256, network: 'mainnet' };
const walletPriv = '0x' + '44'.repeat(32);
const TAC_FLOOR = 200000000n; // 2 TAC, the cTAC static floor in in-system units

// A relay that refuses any fee below `need` (as the live gate does) and records each submitted fee. Gas reads 0, so
// the client quotes the static floor.
function stubRelay(need) {
  const fees = [];
  const fetchImpl = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (String(url).endsWith('/confidential/submit')) {
      const fee = BigInt(body.op.fee);
      fees.push(fee);
      if (fee < need) return { ok: false, status: 400, statusText: 'Bad Request', text: async () => JSON.stringify({ error: 'submitJob: relay fee below the current floor — re-quote higher or self-settle' }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ jobId: 'j' + fees.length, status: 'pending' }) };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x0' }), text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0' }) };
  };
  return { fees, fetchImpl };
}

function tacNote(ux) {
  const w = ux.buildWrap({ walletPriv, amountWei: (250n * 10n ** 18n).toString(), ticker: 'cTAC', index: 0 });
  const events = [{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }];
  return ux.indexer.recover(events, walletPriv)[0];
}

test('a TAC note prices as the pool row: cTAC, with its relay floor', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const id = ux.assetByTicker.cTAC.assetId;
  assert.equal(ux.assetByTicker.TAC.assetId.toLowerCase(), id.toLowerCase(), 'the two rows share one asset id');
  assert.equal(ux.tickerOf(id), 'TAC', 'display keeps the first row');
  assert.equal(ux.poolTickerOf(id), 'cTAC', 'fees take the row the relay prices');
  assert.equal(ux.poolTickerOf(ux.assetByTicker.cETH.assetId), 'cETH');
});

test('a TAC exit is quoted the cTAC floor, not zero, and the relay takes it', async () => {
  const relay = stubRelay(TAC_FLOOR);
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: relay.fetchImpl });
  const note = tacNote(ux);
  const r = await ux.unwrap({ note, walletPriv, wait: false });
  assert.equal(relay.fees.length, 1, 'accepted first time');
  assert.ok(relay.fees[0] >= TAC_FLOOR, `fee ${relay.fees[0]} covers the 2 TAC floor`);
  assert.equal(r.jobId, 'j1');
});

test('a refused fee is quoted once more at twice the floor; refused again, the user gets plain words', async () => {
  const twice = stubRelay(TAC_FLOOR * 2n);
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: twice.fetchImpl });
  const note = tacNote(ux);
  const r = await ux.unwrap({ note, walletPriv, wait: false });
  assert.deepEqual(twice.fees, [TAC_FLOOR, TAC_FLOOR * 2n], 'second try at twice the floor');
  assert.equal(r.jobId, 'j2');

  const never = stubRelay(10n ** 12n);
  const ux2 = makeConfidentialPoolUx({ ...deps, fetchImpl: never.fetchImpl });
  await assert.rejects(ux2.unwrap({ note: tacNote(ux2), walletPriv, wait: false }), (e) => e.code === 'FEE_MOVED' && /network fee rose/.test(e.message));
  assert.equal(never.fees.length, 2, 'no more than one retry');

  // A floor the caller set is never raised behind its back.
  const pinned = stubRelay(TAC_FLOOR * 2n);
  const ux3 = makeConfidentialPoolUx({ ...deps, fetchImpl: pinned.fetchImpl });
  await assert.rejects(ux3.unwrap({ note: tacNote(ux3), walletPriv, wait: false, feeOpts: { minFee: TAC_FLOOR } }), /fee below the current floor/);
  assert.equal(pinned.fees.length, 1);
});

test('send-out (part of a note) retries the same way', async () => {
  const relay = stubRelay(TAC_FLOOR * 2n);
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: relay.fetchImpl });
  const note = tacNote(ux);
  const r = await ux.sendUnwrap({ note, walletPriv, recipient: '0x' + '12'.repeat(20), amount: BigInt(note.value) / 2n, wait: false });
  assert.equal(relay.fees.length, 2);
  assert.equal(relay.fees[1], TAC_FLOOR * 2n);
  assert.ok(r.jobId);
});
