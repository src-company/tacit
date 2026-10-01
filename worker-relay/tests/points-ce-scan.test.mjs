// The collateral-engine scan's handling of bond references and of an unreadable helper transaction, driven through the
// real function text of src/points-indexer.js with a stubbed explorer. (The module starts the indexer on import, so its
// source is read and the function built with stand-ins for what it reaches.)
//   node worker-relay/tests/points-ce-scan.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/lib/points-store.js';

const src = readFileSync(new URL('../src/points-indexer.js', import.meta.url), 'utf8');
const start = src.indexOf('async function scanCollateralEngineCycle(store) {');
assert.ok(start > 0, 'the scan function is where this test looks for it');
const end = src.indexOf('\n}\n', start) + 2;
const fnText = src.slice(start, end);

const ENGINE = '0x' + 'e0'.repeat(20), HELPER = '0x' + '11'.repeat(20);
const U0 = '0x' + '30'.repeat(20), U1 = '0x' + '31'.repeat(20), U2 = '0x' + '32'.repeat(20), U3 = '0x' + '33'.repeat(20);
const out = (n) => '0x' + n.toString(16).padStart(2, '0').repeat(32);
const tx = (n) => '0x' + n.toString(16).padStart(64, '0');
const nowSec = Math.floor(Date.now() / 1000);
const item = (n, block, from, outpoint, ageSecs = 60) => ({
  block_number: block, transaction_hash: tx(n), block_timestamp: new Date((nowSec - ageSecs) * 1000).toISOString(),
  decoded: { method_call: 'EscrowPosted(bytes32 indexed outpoint, address indexed from, uint256 amount)', parameters: [{ name: 'outpoint', value: outpoint }, { name: 'from', value: from }, { name: 'amount', value: String(10n ** 18n) }] },
});

function build({ items, txLogs = () => ({ ok: true, json: async () => ({ items: [] }) }), cover = (n) => n }) {
  const calls = { txLogs: 0, logs: [] };
  const blockscoutFetch = async (url) => {
    if (url.includes('/transactions/')) { calls.txLogs += 1; return txLogs(url); }
    return { ok: true, json: async () => ({ items, next_page_params: null }) };
  };
  const stubs = {
    CFG: { collateralEngineDeployBlock: 1, pointsSettleMaxWaitSecs: 21600 }, ADDR: { cbtcEscrowHelpers: [HELPER], collateralEngine: ENGINE },
    blockscoutFetch, PP_BLOCKSCOUT_BASE: 'https://explorer.test', HELPER_ESCROW_POSTED_TOPIC: '0xtopic', log: (...a) => calls.logs.push(a.join(' ')),
    tacMultiplier: () => 1, zShareMultiplier: () => 1, capToBoostCoverage: cover,
    pointsForCbtcEscrow: (amt, count) => (Number(amt) / 1e18) * 1000 * (1 + 4 / (1 + count / 200)), pointsForCusdMint: () => 1,
    publicClient: { getTransaction: async () => ({ from: U3 }) },
  };
  const names = Object.keys(stubs);
  const scan = new Function(...names, `return (${fnText});`)(...names.map((k) => stubs[k]));
  return { scan, calls };
}

const dir = mkdtempSync(join(tmpdir(), 'points-ce-scan-'));
try {
  // A database from before references were kept: one bond (T1, through the helper) recorded, the scan cursor at block 150.
  const store = openStore(join(dir, 'a.db'));
  store.recordDeposit({ txHash: tx(1), blockNumber: 100, blockTime: nowSec - 5 * 86400, depositor: U1, amountWei: String(10n ** 18n), priorDepositCount: 0, points: 10, activity: 'cbtcmint' });
  store.saveCeCursor(150n);
  const items = [item(2, 160, U2, out(2)), item(1, 100, HELPER, out(1), 5 * 86400), item(0, 90, U0, out(0), 6 * 86400)];
  const { scan, calls } = build({ items });

  await scan(store);
  assert.equal(calls.txLogs, 0, 'a bond already recorded is not looked up again');
  assert.equal(store.depositorOfTx(tx(2)), U2, 'a bond newer than the cursor is recorded as always');
  assert.equal(store.depositorOfTx(tx(0)), null, 'one the scan had already covered and never recorded is not recorded now');
  const pairs = store.bondPairsBefore(nowSec + 86400).map((p) => `${p.outpoint}:${p.funder}:${p.depositor}`).sort();
  assert.deepEqual(pairs, [`${out(1)}:${HELPER}:${U1}`, `${out(2)}:${U2}:${U2}`].sort(), 'the recorded bond gets its reference (through its helper), the new one has its own, the unrecorded one has none');
  assert.equal(store.loadCeCursor(), 160n);
  assert.notEqual(store.getMeta('bond_refs_backfilled'), null);
  console.log('ok - the backfill adds references to what is recorded, records what is newer than the cursor, and records nothing old');

  const before = store.countByActivity('cbtcmint');
  await scan(store);
  assert.equal(store.countByActivity('cbtcmint'), before, 'the next cycle starts from the cursor and adds nothing');
  assert.equal(calls.txLogs, 0);
  console.log('ok - the walk is done once');

  // A helper transaction the explorer cannot give: retried while it is recent, given up on once it is old.
  const bad = () => ({ ok: false, status: 500, json: async () => ({}) });
  const recent = build({ items: [item(3, 170, HELPER, out(3), 60)], txLogs: bad });
  await assert.rejects(recent.scan(store), /blockscout tx logs 500/);
  assert.equal(store.depositorOfTx(tx(3)), null, 'a recent one is not recorded under the helper');
  assert.equal(store.loadCeCursor(), 160n, 'and the cursor stays, so the page is read again');
  const old = build({ items: [item(4, 171, HELPER, out(4), 7 * 3600)], txLogs: bad });
  await old.scan(store);
  assert.equal(store.depositorOfTx(tx(4)), HELPER, 'one that cannot be read long after it happened no longer holds the scan back');
  assert.match(old.calls.logs.join('\n'), /logs unreadable 500/);
  assert.equal(store.loadCeCursor(), 171n);
  console.log('ok - an unreadable helper transaction is retried while recent and given up on once old');

  // The scan waits for the holder-boost replay: nothing is recorded or marked until it has caught up.
  const fresh = openStore(join(dir, 'b.db'));
  const waits = build({ items: [item(5, 200, U2, out(5))], cover: (n) => n - 1n });
  await waits.scan(fresh);
  assert.equal(fresh.depositorOfTx(tx(5)), null);
  assert.equal(fresh.getMeta('bond_refs_backfilled'), null, 'the backfill is not marked done while the scan is waiting');
  assert.equal(fresh.loadCeCursor(), null);
  const ready = build({ items: [item(5, 200, U2, out(5))] });
  await ready.scan(fresh);
  assert.equal(fresh.depositorOfTx(tx(5)), U2, 'a database with no cursor records everything as it did');
  assert.ok(fresh.getMeta('bond_refs_backfilled'));
  console.log('ok - the scan waits for the boost replay without marking the backfill done, and a fresh database records everything');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
