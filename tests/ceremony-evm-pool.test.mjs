// EVM pool ceremony UI helpers and pin.
//
// (a) The participants export walks prev_cid from the head back to genesis,
//     so orphaned records (a losing upload, a stale retry) never reach the
//     exported list. Exercised on fixtures, including an orphan, a missing
//     head, a broken link and a cycle.
// (b) When EVM_POOL_CEREMONY.hash is filled in, it must equal the sha256 of
//     dapp/circuits/evm-pool/build/transact.r1cs (skipped while null).
//
// The helpers are sliced out of dapp/tacit.js source so the shipped code is
// what runs here.
//
// Run: `node tests/ceremony-evm-pool.test.mjs`

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TACIT_JS = path.join(ROOT, 'dapp', 'tacit.js');
const R1CS = path.join(ROOT, 'dapp', 'circuits', 'evm-pool', 'build', 'transact.r1cs');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const src = await readFile(TACIT_JS, 'utf8');

function sliceFunction(name) {
  const start = src.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in dapp/tacit.js`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 3);
}

const helpers = new Function(
  ['ceremonyMilestoneStatus', 'ceremonyCanonicalChain', 'ceremonyParticipantsExport']
    .map(sliceFunction).join('\n')
  + '\nreturn { ceremonyMilestoneStatus, ceremonyCanonicalChain, ceremonyParticipantsExport };',
)();

function parseConfig() {
  const m = src.match(/const EVM_POOL_CEREMONY = Object\.freeze\((\{[\s\S]*?\})\);/);
  if (!m) throw new Error('EVM_POOL_CEREMONY literal not found in dapp/tacit.js');
  return new Function(`return (${m[1]});`)();
}

console.log('EVM pool ceremony\n');

// ---- (a) canonical chain + participants export ----
const pk = (c) => '02' + c.repeat(64);
const genesis = { index: 0, cid: 'cid0', contributor_name: 'coordinator', contribution_hash: '', contributed_at: 1000, prev_cid: '' };
const c1 = { index: 1, cid: 'cid1', contributor_name: 'alice', contributor_pubkey: pk('a').toUpperCase(), contribution_hash: 'h1', contributed_at: 1100, prev_cid: 'cid0' };
const c2 = { index: 2, cid: 'cid2', contributor_name: 'anonymous', contributor_pubkey: pk('b'), contribution_hash: 'h2', contributed_at: 1200, prev_cid: 'cid1' };
const orphan = { index: 2, cid: 'cid2x', contributor_name: 'carol', contributor_pubkey: pk('c'), contribution_hash: 'h2x', contributed_at: 1201, prev_cid: 'cid1' };
const c3 = { index: 3, cid: 'cid3', contributor_name: 'dave', contributor_pubkey: pk('d'), contribution_hash: 'h3', contributed_at: 1300, prev_cid: 'cid2' };
const c4 = { index: 4, cid: 'cid4', contributor_name: 'erin', contribution_hash: 'h4', contributed_at: 1400, prev_cid: 'cid3' };
// Cursor mode returns each page newest-first; the walk must not depend on order.
const records = [c3, orphan, c1, c4, genesis, c2];

{
  const { ceremonyCanonicalChain, ceremonyParticipantsExport } = helpers;
  const walk = ceremonyCanonicalChain(records, 'cid4');
  ok('chain walks head → genesis', same(walk.chain.map(r => r.cid), ['cid0', 'cid1', 'cid2', 'cid3', 'cid4']));
  ok('chain complete, no warnings', walk.complete && walk.warnings.length === 0, walk.warnings.join('; '));
  ok('orphan identified', same(walk.orphans.map(r => r.cid), ['cid2x']));

  const exp = ceremonyParticipantsExport(walk.chain);
  ok('export drops genesis and orphan, keeps chain order', same(exp.map(r => r.index), [1, 2, 3, 4]));
  ok('export shape', same(exp[0], { index: 1, contributor_pubkey: pk('a'), contribution_hash: 'h1', contributed_at: 1100, cid: 'cid1' }),
    JSON.stringify(exp[0]));
  ok('export has exactly the documented keys',
    exp.every(r => same(Object.keys(r), ['index', 'contributor_pubkey', 'contribution_hash', 'contributed_at', 'cid'])));
  ok('missing pubkey exports as null', exp[3].contributor_pubkey === null);
  ok('orphan pubkey absent from export', !exp.some(r => r.contributor_pubkey === pk('c')));

  const beacon = { index: 5, cid: 'cid5', contributor_name: 'beacon', contribution_hash: 'bb', contributed_at: 1500, prev_cid: 'cid4', is_beacon: true };
  const withBeacon = ceremonyCanonicalChain([...records, beacon], 'cid5');
  ok('beacon record is on the chain but not a participant',
    withBeacon.complete && same(ceremonyParticipantsExport(withBeacon.chain).map(r => r.index), [1, 2, 3, 4]));

  const noHead = ceremonyCanonicalChain(records, null);
  ok('no head CID: highest index is the head', noHead.complete && noHead.chain.at(-1).cid === 'cid4');

  const lagging = ceremonyCanonicalChain(records, 'cid9');
  ok('head missing from list: warns, falls back to highest index',
    lagging.complete && lagging.chain.at(-1).cid === 'cid4' && lagging.warnings.length === 1);

  const broken = ceremonyCanonicalChain([c3, c4, genesis], 'cid4');
  ok('broken prev_cid link: incomplete', !broken.complete && broken.warnings.some(w => w.includes('cid2')));

  const cyc = ceremonyCanonicalChain([{ index: 1, cid: 'x', prev_cid: 'y' }, { index: 2, cid: 'y', prev_cid: 'x' }], 'y');
  ok('cycle detected, incomplete', !cyc.complete && cyc.warnings.some(w => w.startsWith('cycle')));

  // A record whose cid equals its prev_cid (the head re-uploaded unchanged) is
  // not a key transition; the next record's prev_cid resolves to the producer.
  const noop = { index: 4, cid: 'cid3', contributor_name: 'frank', contributor_pubkey: pk('f'), contribution_hash: 'hn', contributed_at: 1350, prev_cid: 'cid3' };
  const c5 = { index: 5, cid: 'cid5', contributor_name: 'gina', contributor_pubkey: pk('9'), contribution_hash: 'h5', contributed_at: 1450, prev_cid: 'cid3' };
  const loop = ceremonyCanonicalChain([c5, noop, c3, c2, c1, genesis, orphan], 'cid5');
  ok('self-referencing record skipped, chain still reaches genesis',
    loop.complete && same(loop.chain.map(r => r.index), [0, 1, 2, 3, 5]) && loop.orphans.includes(noop),
    JSON.stringify(loop.warnings));
  ok('self-referencing record not exported', !ceremonyParticipantsExport(loop.chain).some(r => r.contributor_pubkey === pk('f')));

  const empty = ceremonyCanonicalChain([], null);
  ok('empty list: empty, incomplete', empty.chain.length === 0 && !empty.complete);
}

// ---- milestones ----
{
  const cfg = parseConfig();
  const { ceremonyMilestoneStatus } = helpers;
  ok('config key', cfg.key === 'evm_pool_transact');
  ok('milestones ascending', cfg.milestones.length > 0 && cfg.milestones.every((m, i, a) => i === 0 || m.count > a[i - 1].count));
  const s0 = ceremonyMilestoneStatus(0, cfg.milestones);
  ok('0 contributions: next is floor, none reached', s0.next.count === cfg.milestones[0].count && s0.reached === null);
  const s = ceremonyMilestoneStatus(cfg.milestones[1].count, cfg.milestones);
  ok('at second milestone: reached + next',
    s.reached.count === cfg.milestones[1].count && s.next.count === cfg.milestones[2].count
    && same(s.pills.map(p => p.state), ['reached', 'reached', 'next']));
  const top = ceremonyMilestoneStatus(cfg.milestones.at(-1).count + 7, cfg.milestones);
  ok('past the last milestone: no next', top.next === null && top.pills.every(p => p.state === 'reached'));
}

// ---- AMM path keeps its ptau ----
ok('ceremonyContributeAmm defaults expectedPtau to the AMM pot18 pin',
  /async function ceremonyContributeAmm\(\{[\s\S]*?expectedPtau = TACIT_AMM_PTAU_SHA256,[\s\S]*?\}\)/.test(src)
  && /\{ expectedR1cs: String\(circuitHash\)\.toLowerCase\(\), expectedPtau \}/.test(src));

// ---- (b) circuit pin ----
{
  const cfg = parseConfig();
  const hex64 = (v) => /^[0-9a-f]{64}$/.test(String(v || ''));
  ok('hash and ptauSha256 are both placeholders or both pinned',
    (cfg.hash === null && cfg.ptauSha256 === null) || (hex64(cfg.hash) && hex64(cfg.ptauSha256)),
    `hash=${cfg.hash} ptauSha256=${cfg.ptauSha256}`);
  if (cfg.hash === null) {
    console.log('  SKIP  EVM_POOL_CEREMONY.hash is null (ceremony not initialized yet)');
  } else if (!existsSync(R1CS)) {
    console.log(`  SKIP  ${path.relative(ROOT, R1CS)} not built (run dapp/circuits/evm-pool/build.sh)`);
  } else {
    const got = bytesToHex(sha256(await readFile(R1CS)));
    ok('EVM_POOL_CEREMONY.hash == sha256(build/transact.r1cs)', got === cfg.hash, `r1cs ${got}, pinned ${cfg.hash}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
