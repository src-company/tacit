#!/usr/bin/env node
// Dapp burn-deposit (BTC→ETH) Slipstream broadcast seam. Locks: submits the raw tx to MARA's queue,
// polls a real chain check (not just MARA's own queue status) for confirmation, then registers the
// provenance bundle with the worker — in that order, never registering before confirmation.
//
// Run: node tests/burndep-broadcast.mjs

import assert from 'node:assert';
import { makeBurnDepositBroadcaster } from '../dapp/burndep-broadcast.js';

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

// ── 1. submitToSlipstream posts tx_hex to the right endpoint, throws on a non-ok response ──
{
  let posted = null;
  const fetchImpl = async (url, opts) => {
    posted = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ status: 'success', message: 'ok' }), text: async () => JSON.stringify(({ status: 'success', message: 'ok' })) };
  };
  const b = makeBurnDepositBroadcaster({ fetchImpl });
  const r = await b.submitToSlipstream('deadbeef');
  assert.strictEqual(posted.url, 'https://slipstream.mara.com/api/transactions', 'posts to the slipstream submit endpoint');
  assert.deepStrictEqual(posted.body, { tx_hex: 'deadbeef' }, 'body is { tx_hex }');
  assert.deepStrictEqual(r, { status: 'success', message: 'ok' }, 'returns the slipstream response');
  await assert.rejects(() => b.submitToSlipstream(), /txHex required/, 'rejects a missing txHex');
  ok('submitToSlipstream posts tx_hex, returns the response, rejects a missing tx');
}

// ── 2. submitToSlipstream throws loudly on a rejected submission (transport-level and body-level) ──
{
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: 'bad tx' }), text: async () => JSON.stringify(({ error: 'bad tx' })) });
  const b = makeBurnDepositBroadcaster({ fetchImpl });
  await assert.rejects(() => b.submitToSlipstream('deadbeef'), /slipstream submit failed/, 'surfaces a transport-level rejection');

  const fetchImplRefused = async () => ({ ok: true, json: async () => ({ status: 'error', message: 'invalid transaction' }), text: async () => JSON.stringify(({ status: 'error', message: 'invalid transaction' })) });
  const b2 = makeBurnDepositBroadcaster({ fetchImpl: fetchImplRefused });
  await assert.rejects(() => b2.submitToSlipstream('deadbeef'), /slipstream submit refused: invalid transaction/, 'surfaces a 200-with-status-error refusal');
  ok('submitToSlipstream fails loudly on a non-ok response or a status !== success body');
}

// ── 3. waitForBurnDepositMined resolves once checkConfirmed says so, not before ──
{
  let calls = 0;
  const checkConfirmed = async () => (++calls >= 3);
  const fetchImpl = async () => ({ ok: true, json: async () => ({ message: 'queued', is_next_block: false, transaction: { position: { block: 2 } } }) });
  const b = makeBurnDepositBroadcaster({ fetchImpl });
  const updates = [];
  const slept = [];
  const r = await b.waitForBurnDepositMined({
    txid: 'abc123', checkConfirmed, intervalMs: 10,
    onUpdate: (u) => updates.push(u.status),
    sleep: async (ms) => { slept.push(ms); },
  });
  assert.strictEqual(calls, 3, 'polled checkConfirmed until it returned true');
  assert.strictEqual(r.confirmed, true, 'resolves confirmed');
  assert.deepStrictEqual(updates, ['queued', 'confirmed'], 'onUpdate fires on status change, ending in confirmed');
  assert.deepStrictEqual(slept, [10, 10], 'slept between polls via the injected sleep');
  ok('waitForBurnDepositMined polls checkConfirmed, not slipstream queue status, for the real exit condition');
}

// ── 4. waitForBurnDepositMined keeps working even if MARA's status endpoint errors ──
{
  let calls = 0;
  const checkConfirmed = async () => (++calls >= 2);
  const fetchImpl = async () => { throw new Error('network blip'); };
  const b = makeBurnDepositBroadcaster({ fetchImpl });
  const r = await b.waitForBurnDepositMined({ txid: 'x', checkConfirmed, intervalMs: 1, sleep: async () => {} });
  assert.strictEqual(r.confirmed, true, 'still resolves via checkConfirmed despite slipstream status being unreachable');
  ok('waitForBurnDepositMined tolerates a failing slipstream status poll (best-effort only)');
}

// ── 5. waitForBurnDepositMined times out rather than hanging forever, and validates its inputs ──
{
  const b = makeBurnDepositBroadcaster({ fetchImpl: async () => ({ json: async () => ({}) }) });
  await assert.rejects(
    () => b.waitForBurnDepositMined({ txid: 'x', checkConfirmed: async () => false, timeoutMs: 5, intervalMs: 1, sleep: async () => {} }),
    /not confirmed after/,
    'rejects on timeout',
  );
  await assert.rejects(() => b.waitForBurnDepositMined({ checkConfirmed: async () => true }), /txid required/, 'rejects a missing txid');
  await assert.rejects(() => b.waitForBurnDepositMined({ txid: 'x' }), /inject checkConfirmed/, 'rejects a missing checkConfirmed');
  ok('waitForBurnDepositMined times out loudly and validates required inputs');
}

// ── 6. registerBurnDeposit posts to /reflection/burndep, requires workerBase ──
{
  let posted = null;
  const fetchImpl = async (url, opts) => { posted = { url, body: JSON.parse(opts.body) }; return { ok: true, json: async () => ({ ok: true, stored: 'k' }), text: async () => JSON.stringify(({ ok: true, stored: 'k' })) }; };
  const b = makeBurnDepositBroadcaster({ workerBase: 'https://api.example', fetchImpl });
  const r = await b.registerBurnDeposit({ burnTxidDisplay: 'abc', bundle: { some: 'data' } });
  assert.strictEqual(posted.url, 'https://api.example/reflection/burndep?network=mainnet', 'posts to the burndep endpoint with network');
  assert.deepStrictEqual(posted.body, { burnTxidDisplay: 'abc', bundle: { some: 'data' } }, 'body carries the txid + bundle');
  assert.deepStrictEqual(r, { ok: true, stored: 'k' }, 'returns the worker response');

  const noBase = makeBurnDepositBroadcaster({ fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }), text: async () => JSON.stringify(({ ok: true })) }) });
  await assert.rejects(() => noBase.registerBurnDeposit({ burnTxidDisplay: 'abc', bundle: {} }), /needs workerBase/, 'rejects without workerBase');
  ok('registerBurnDeposit posts to /reflection/burndep, requires workerBase');
}

// ── 7. completeBurnDepositToEthereum runs submit → wait → register, in that order ──
{
  const order = [];
  let confirmedAt = null;
  const fetchImpl = async (url, opts) => {
    if (url.includes('/api/transactions') && opts?.method === 'POST') { order.push('submit'); return { ok: true, json: async () => ({ status: 'success' }), text: async () => JSON.stringify(({ status: 'success' })) }; }
    if (url.includes('/reflection/burndep')) { order.push('register'); confirmedAt = order.includes('wait-confirmed'); return { ok: true, json: async () => ({ ok: true }), text: async () => JSON.stringify(({ ok: true })) }; }
    return { json: async () => ({}) };
  };
  const checkConfirmed = async () => { order.push('wait-confirmed'); return true; };
  const b = makeBurnDepositBroadcaster({ workerBase: 'https://api.example', fetchImpl });
  const r = await b.completeBurnDepositToEthereum({
    txHex: 'deadbeef', txid: 'abc', burnTxidDisplay: 'abc', bundle: { x: 1 },
    checkConfirmed, waitOpts: { intervalMs: 1, sleep: async () => {} },
  });
  assert.deepStrictEqual(order, ['submit', 'wait-confirmed', 'register'], 'submits, then waits for confirmation, then registers');
  assert.strictEqual(confirmedAt, true, 'registration only happens after confirmation was observed');
  assert.ok(r.submitResult && r.registered, 'returns both the submit and registration results');
  ok('completeBurnDepositToEthereum orders submit → confirm → register, never registering before confirmation');
}

// ── 8. a submitted burn is journalled, and a session that lost the register step can finish it ──
{
  let list = [];
  const journal = { load: () => list, save: (l) => { list = l; } };
  const seen = [];
  const fetchImpl = async (url, opts) => {
    if (url.includes('/api/transactions') && opts?.method === 'POST') { seen.push('submit'); return { ok: true, json: async () => ({ status: 'success' }), text: async () => JSON.stringify(({ status: 'success' })) }; }
    if (url.includes('/reflection/burndep')) { seen.push('register'); return { ok: true, json: async () => ({ ok: true }), text: async () => JSON.stringify(({ ok: true })) }; }
    return { json: async () => ({}) };
  };
  // A page that closes between submit and register: the submit lands, the wait never finishes.
  const b1 = makeBurnDepositBroadcaster({ workerBase: 'https://api.example', fetchImpl, journal });
  await assert.rejects(
    () => b1.completeBurnDepositToEthereum({
      txHex: 'deadbeef', txid: 'abc', burnTxidDisplay: 'abcdisplay', bundle: { x: 1 },
      checkConfirmed: async () => false, waitOpts: { timeoutMs: 1, intervalMs: 1, sleep: async () => {} },
    }),
    /not confirmed after/,
    'the wait gives up',
  );
  assert.deepStrictEqual(seen, ['submit'], 'the burn was submitted but never registered');
  const pending = b1.pendingBurnDeposits();
  assert.strictEqual(pending.length, 1, 'the submitted burn is journalled');
  assert.strictEqual(pending[0].txid, 'abc', 'the reveal txid is what a resume needs, and it is there');
  assert.strictEqual(pending[0].stage, 'submitted', 'the record says how far it got');

  // A fresh session reads the same journal and completes it.
  const b2 = makeBurnDepositBroadcaster({ workerBase: 'https://api.example', fetchImpl, journal });
  const r = await b2.resumeBurnDeposit({ txid: 'abc', checkConfirmed: async () => true, waitOpts: { intervalMs: 1, sleep: async () => {} } });
  assert.deepStrictEqual(seen, ['submit', 'register'], 'the resume registers without resubmitting');
  assert.strictEqual(r.resumed.burnTxidDisplay, 'abcdisplay', 'the resume used the journalled display txid');
  assert.strictEqual(b2.pendingBurnDeposits().length, 0, 'a registered burn leaves the journal');
  await assert.rejects(() => b2.resumeBurnDeposit({ txid: 'nope', checkConfirmed: async () => true }), /no pending burn deposit/, 'rejects an unknown txid');
  ok('a submitted burn is journalled with its reveal txid and resumes to registration in a later session');
}

// ── 9. a completed burn leaves nothing behind, and resume-all reports per burn ──
{
  let list = [];
  const journal = { load: () => list, save: (l) => { list = l; } };
  const fetchImpl = async (url, opts) => {
    if (url.includes('/api/transactions') && opts?.method === 'POST') return { ok: true, json: async () => ({ status: 'success' }), text: async () => JSON.stringify(({ status: 'success' })) };
    if (url.includes('/reflection/burndep')) return { ok: true, json: async () => ({ ok: true }), text: async () => JSON.stringify(({ ok: true })) };
    return { json: async () => ({}) };
  };
  const b = makeBurnDepositBroadcaster({ workerBase: 'https://api.example', fetchImpl, journal });
  await b.completeBurnDepositToEthereum({
    txHex: 'deadbeef', txid: 'abc', burnTxidDisplay: 'abc', bundle: { x: 1 },
    checkConfirmed: async () => true, waitOpts: { intervalMs: 1, sleep: async () => {} },
  });
  assert.strictEqual(b.pendingBurnDeposits().length, 0, 'the happy path clears its own record');

  list = [{ txid: 'a1', burnTxidDisplay: 'a1', bundle: {}, network: 'mainnet', stage: 'submitted' },
          { txid: 'a2', burnTxidDisplay: 'a2', bundle: {}, network: 'mainnet', stage: 'submitted' }];
  const res = await b.resumePendingBurnDeposits({
    checkConfirmed: async (t) => t === 'a1',
    waitOpts: { timeoutMs: 1, intervalMs: 1, sleep: async () => {} },
  });
  assert.strictEqual(res.length, 2, 'reports on every journalled burn');
  assert.ok(res[0].registered, 'the confirmed one registered');
  assert.match(res[1].error, /not confirmed after/, 'the unconfirmed one reports why, rather than aborting the sweep');
  assert.deepStrictEqual(list.map((r) => r.txid), ['a2'], 'the one that could not finish stays pending for next time');
  ok('a completed burn clears its record; a sweep reports per burn and keeps the unfinished ones');
}

// ── 10. slipstreamStatus, slipstreamRates, testSlipstreamAccept hit the right endpoints with the right shapes ──
{
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts && opts.method, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (url.includes('/api/transactions/status')) return { ok: true, json: async () => ({ message: 'queued', is_next_block: false, transaction: { position: { block: 1 } } }) };
    if (url.includes('/api/rates')) return { ok: true, json: async () => ({ market_rate: 1, effective_rate: 1.9, submit_fee_rate: 1.9 }) };
    if (url.includes('/api/mempool/tests')) return { ok: true, json: async () => ([{ txid: 'abc', allowed: true }]) };
    throw new Error('unexpected url ' + url);
  };
  const b = makeBurnDepositBroadcaster({ fetchImpl });

  const status = await b.slipstreamStatus('abc123');
  assert.strictEqual(calls[0].url, 'https://slipstream.mara.com/api/transactions/status?tx_id=abc123', 'status hits the right endpoint with tx_id');
  assert.strictEqual(status.transaction.position.block, 1, 'returns the parsed TransactionInfo');
  await assert.rejects(() => b.slipstreamStatus(), /txid required/, 'rejects a missing txid');

  const rates = await b.slipstreamRates();
  assert.strictEqual(calls[1].url, 'https://slipstream.mara.com/api/rates', 'rates hits the right endpoint');
  assert.strictEqual(rates.effective_rate, 1.9, 'returns the parsed rate info');

  const accept = await b.testSlipstreamAccept('deadbeef');
  assert.strictEqual(calls[2].url, 'https://slipstream.mara.com/api/mempool/tests', 'mempool test hits the right endpoint');
  assert.deepStrictEqual(calls[2].body, { tx_hexes: ['deadbeef'] }, 'wraps the single hex in tx_hexes');
  assert.deepStrictEqual(accept, { txid: 'abc', allowed: true }, 'unwraps the single result from the response array');
  await assert.rejects(() => b.testSlipstreamAccept(), /txHex required/, 'rejects a missing txHex');

  ok('slipstreamStatus/slipstreamRates/testSlipstreamAccept call the right endpoints with the right shapes');
}

// ── 11. waitForBurnDepositMined reports "next-block" once MARA flags is_next_block, distinct from "queued" ──
{
  let calls = 0;
  const checkConfirmed = async () => (++calls >= 2);
  const fetchImpl = async () => ({ ok: true, json: async () => ({ is_next_block: true, transaction: { position: { block: 0 } } }) });
  const b = makeBurnDepositBroadcaster({ fetchImpl });
  const updates = [];
  await b.waitForBurnDepositMined({
    txid: 'abc123', checkConfirmed, intervalMs: 1,
    onUpdate: (u) => updates.push(u.status),
    sleep: async () => {},
  });
  assert.deepStrictEqual(updates, ['next-block', 'confirmed'], 'is_next_block reports a distinct status from plain queued');
  ok('waitForBurnDepositMined surfaces is_next_block as its own progress state');
}

console.log(`\n${n}/11 burndep-broadcast checks passed`);
