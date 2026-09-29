// cbtcBonds against a fake chain: every lock a key made and every bond its accounts posted (through the escrow helper,
// the retired helper, or the engine directly), what each bond can do in each lock state, which contract takes it back,
// a lock still at the everyday address, and a bond's health once the margin call is armed.
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { makeBtcHistoryProvider } from '../dapp/confidential-recovery-btc.js';

const cat = (a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (k, ...m) => hmac(nobleSha256, k, cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256, network: 'mainnet', logStore: null };
const hex = (b) => Buffer.from(b).toString('hex');
const sel = (sig) => hex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8);
const topic = (sig) => '0x' + hex(keccak_256(new TextEncoder().encode(sig)));
const w = (v) => BigInt(v).toString(16).padStart(64, '0');
const lc = (s) => String(s).toLowerCase();
const PRIV = '0x' + '5a'.repeat(32);

function world(ux) {
  const cfg = ux.cfg, ENGINE = lc(cfg.collateralEngine), POOL = lc(cfg.pool), HELPER = lc(cfg.cbtcEscrowHelper), RETIRED = lc(cfg.cbtcEscrowHelpersRetired[0]);
  const TACIT = lc(ux.account(PRIV).address), WALLET = '0x' + '77'.repeat(20);
  const scripts = makeBtcHistoryProvider({ sha256, hrp: 'bc', fetchImpl: async () => { throw new Error('no network'); } }).walletScripts(ux.identity(PRIV).priv);
  const everyday = hex(scripts.funding), lockSpk = hex(scripts.lock);
  const tx = (c) => c.repeat(64 / c.length);
  const key = (txid, vout) => lc(ux.pool.outpointKey('0x' + Buffer.from(txid, 'hex').reverse().toString('hex'), vout));
  // The key's outputs: an early lock at the everyday address, a pending lock, a lock spent without redemption, one
  // redeemed, and a plain note output. L4 is a lock of someone else's the connected wallet bonded on the engine.
  const O = {
    everyday: { txid: tx('a1'), vout: 1, value: 700, spk: everyday },
    pending: { txid: tx('a2'), vout: 1, value: 5000, spk: lockSpk },
    forfeit: { txid: tx('a3'), vout: 1, value: 2000, spk: everyday },
    redeemed: { txid: tx('a4'), vout: 1, value: 900, spk: lockSpk },
    note: { txid: tx('a5'), vout: 0, value: 546, spk: everyday },
  };
  const op = Object.fromEntries(Object.entries(O).map(([k, o]) => [k, key(o.txid, o.vout)]));
  op.theirs = '0x' + 'c4'.repeat(32);
  const S = {
    [op.everyday]: { vBtc: 700, minted: 1, total: 3n * 10n ** 14n, helper: { [HELPER]: { [TACIT]: 3n * 10n ** 14n } } },
    [op.pending]: { vBtc: 0, total: 2n * 10n ** 15n, helper: { [HELPER]: { [TACIT]: 2n * 10n ** 15n } } },
    [op.forfeit]: { vBtc: 2000, minted: 1, spent: 1, total: 8n * 10n ** 14n, helper: { [RETIRED]: { [TACIT]: 8n * 10n ** 14n } } },
    [op.redeemed]: { vBtc: 900, minted: 1, redeemed: 1, total: 4n * 10n ** 14n, helper: { [HELPER]: { [WALLET]: 4n * 10n ** 14n } } },
    [op.theirs]: { vBtc: 1200, minted: 1, redeemed: 1, total: 5n * 10n ** 14n, engineOf: { [WALLET]: 5n * 10n ** 14n } },
  };
  const E = { maintenanceBps: 0n, grace: 7n * 86400n, unhealthy: {} };
  const posts = [
    [HELPER, 'HelperEscrowPosted(bytes32,address,uint256)', op.everyday, TACIT], [HELPER, 'HelperEscrowPosted(bytes32,address,uint256)', op.pending, TACIT],
    [RETIRED, 'HelperEscrowPosted(bytes32,address,uint256)', op.forfeit, TACIT], [HELPER, 'HelperEscrowPosted(bytes32,address,uint256)', op.redeemed, WALLET],
    [ENGINE, 'EscrowPosted(bytes32,address,uint256)', op.theirs, WALLET],
  ].map(([address, sig, o, who], i) => ({ address, topics: [topic(sig), o, '0x' + w(who)], data: '0x' + w(1), blockNumber: '0x' + (Number(cfg.deployBlock) + 10 + i).toString(16), logIndex: '0x0', transactionHash: '0x' + w(i + 1) }));
  const read = (to, data) => {
    const s = data.slice(2, 10), a = '0x' + data.slice(10, 74), b = '0x' + data.slice(98, 138), st = S[lc(a)] || {};
    if (to === ENGINE && s === sel('escrowMaintenanceBps()')) return w(E.maintenanceBps);
    if (to === ENGINE && s === sel('escrowGraceWindow()')) return w(E.grace);
    if (to === ENGINE && s === sel('escrowUnhealthySince(bytes32)')) return w(E.unhealthy[lc(a)]?.since || 0);
    if (to === ENGINE && s === sel('checkEscrowHealth(bytes32)')) { const u = E.unhealthy[lc(a)]; return w(u ? 0 : 1) + w(st.total || 0) + w(u ? u.want : 0); }
    if (to === POOL && s === sel('cbtcLockVBtc(bytes32)')) return w(st.vBtc || 0);
    if (to === POOL && s === sel('cbtcMinted(bytes32)')) return w(st.minted || 0);
    if (to === POOL && s === sel('cbtcLockSpent(bytes32)')) return w(st.spent || 0);
    if (to === POOL && s === sel('cbtcLockRedeemed(bytes32)')) return w(st.redeemed || 0);
    if (to === ENGINE && s === sel('escrowTotal(bytes32)')) return w(st.total || 0);
    if (to === ENGINE && s === sel('escrowSlashed(bytes32)')) return w(st.slashed || 0);
    if (to === ENGINE && s === sel('escrowOf(bytes32,address)')) return w(st.engineOf?.[b] || 0);
    if ((to === HELPER || to === RETIRED) && s === sel('helperEscrowOf(bytes32,address)')) return w(st.helper?.[to]?.[b] || 0);
    return null;
  };
  // Multicall3.aggregate3: decode each (target, allowFailure, callData), answer it, encode (success, returnData)[].
  const aggregate3 = (data) => {
    const d = data.slice(10), at = (i) => BigInt('0x' + d.slice(i * 64, i * 64 + 64));
    const n = Number(at(1)), results = [];
    for (let i = 0; i < n; i++) {
      const e = 2 + Number(at(2 + i)) / 32, to = '0x' + d.slice(e * 64 + 24, e * 64 + 64), b = e + Number(at(e + 2)) / 32, len = Number(at(b));
      const r = read(lc(to), '0x' + d.slice((b + 1) * 64, (b + 1) * 64 + len * 2));
      results.push(r == null ? [0, ''] : [1, r]);
    }
    const bodies = results.map(([ok, r]) => w(ok) + w(0x40) + w(r.length / 2) + r.padEnd(Math.ceil(r.length / 64) * 64, '0'));
    let off = n * 32;
    const heads = bodies.map((x) => { const o = w(off); off += x.length / 2; return o; });
    return '0x' + w(0x20) + w(n) + heads.join('') + bodies.join('');
  };
  const fetchImpl = async (_url, opts) => {
    const { method, params } = JSON.parse(opts.body);
    const reply = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
    if (method === 'eth_blockNumber') return reply('0x' + (Number(cfg.deployBlock) + 100).toString(16));
    if (method === 'eth_getLogs') {
      const q = params[0], as = [].concat(q.address).map(lc), t0 = q.topics[0].map(lc), t2 = q.topics[2].map(lc);
      return reply(posts.filter((l) => as.includes(lc(l.address)) && t0.includes(lc(l.topics[0])) && t2.includes(lc(l.topics[2]))));
    }
    if (method === 'eth_call' && lc(params[0].to) === '0xca11bde05977b3631167028862be2a173976ca11') return reply(aggregate3(params[0].data));
    return reply('0x');
  };
  return { fetchImpl, O, op, S, E, TACIT, WALLET, ENGINE, HELPER, RETIRED, history: { anchors: [], lockOutputs: Object.values(O) } };
}

test('cbtcBonds: every lock of the key and every bond its accounts posted, each with what it can do and where it comes back from', async () => {
  const probe = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => { throw new Error('unused'); } });
  const x = world(probe);
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: x.fetchImpl });
  const r = await ux.cbtcBonds(PRIV, { accounts: [x.WALLET], btcHistory: x.history });
  const by = Object.fromEntries(r.locks.map((l) => [l.op, l]));
  assert.equal(r.maintenanceBps, 0n);
  assert.equal(r.locks.length, 5, 'four locks of the key and one the wallet bonded; the note output is not a lock');
  assert.ok(!by[x.op.note]);
  assert.deepEqual(r.locks.map((l) => l.state), ['forfeit', 'free', 'free', 'pending', 'backing'], 'what needs saying first comes first');

  const f = by[x.op.forfeit];
  assert.equal(f.state, 'forfeit');
  assert.equal(f.bonds[0].src, 'retired', 'found through the retired helper');
  assert.equal(f.bonds[0].take, null, 'a forfeit bond cannot be taken back');
  assert.equal(f.everyday, false, 'a spent lock no longer holds anything at the address');

  const e = by[x.op.everyday];
  assert.equal(e.state, 'backing');
  assert.equal(e.everyday, true, 'a lock still held at the everyday address says so');
  assert.equal(e.bonds[0].take, null, 'a backing bond stays until the lock is redeemed');

  const p = by[x.op.pending];
  assert.equal(p.state, 'pending');
  assert.equal(p.txid, x.O.pending.txid);
  assert.deepEqual(p.bonds[0].take, { to: x.HELPER, data: '0x' + sel('reclaimEscrow(bytes32)') + x.op.pending.slice(2) }, 'a helper bond comes back through that helper');
  assert.equal(p.bonds[0].account, x.TACIT);

  const red = by[x.op.redeemed];
  assert.equal(red.state, 'free');
  assert.equal(red.bonds[0].account, x.WALLET, 'posted from the connected wallet, so it goes back there');

  const t = by[x.op.theirs];
  assert.equal(t.state, 'free');
  assert.equal(t.txid, null, 'a lock this key did not make has no txid here');
  assert.deepEqual(t.bonds[0].take, { to: x.ENGINE, data: '0x' + sel('claimEscrow(bytes32)') + x.op.theirs.slice(2) }, 'an engine bond comes back from the engine');
});

test('cbtcBonds: once the margin call is armed, each backing bond carries its health and when a flag runs out', async () => {
  const probe = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => { throw new Error('unused'); } });
  const x = world(probe);
  x.E.maintenanceBps = 12000n;
  x.E.unhealthy[x.op.everyday] = { since: 1_800_000_000n, want: 4n * 10n ** 14n };
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: x.fetchImpl });
  const r = await ux.cbtcBonds(PRIV, { accounts: [x.WALLET], btcHistory: x.history });
  const l = r.locks.find((z) => z.op === x.op.everyday);
  assert.equal(r.maintenanceBps, 12000n);
  assert.deepEqual(l.health, { healthy: false, have: 3n * 10n ** 14n, want: 4n * 10n ** 14n, flaggedAt: 1_800_000_000n, due: 1_800_000_000n + 7n * 86400n });
  assert.equal(r.locks.find((z) => z.state === 'pending').health, null, 'only backing bonds are checked');
});
