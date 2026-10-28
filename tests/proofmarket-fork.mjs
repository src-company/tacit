#!/usr/bin/env node
// ProofMarket on a mainnet fork with the LIVE pool, the LIVE TAC token and the real SETTLE GUEST (SP1 execute mode; only the pool's SP1 verifier is
// replaced): a wrap's deposit is made, its proof built by the real guest, and a prover settles it THROUGH the market and is paid in live TAC by the
// holder's ERC-2612 permit in the same call. Also: a copied proof cannot take the fee during a claim, a proof for another op is refused, a pool
// refusal moves no TAC, and a second fulfil is refused.
//
//   node tests/proofmarket-fork.mjs        (FORK=<rpc url>; EXEC=<the exec-stdin binary>; run `forge build` in contracts/ first for the bytecode)
//   node tests/route-change-fork.mjs        (FORK=<rpc url>; EXEC=<the exec-stdin binary>, built from tests/exec-stdin when not given)
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const ELF = join(ROOT, 'contracts/sp1/confidential/elf/cxfer-guest');
const EXEC = process.env.EXEC || join(process.env.CARGO_TARGET_DIR || join(ROOT, 'tests/exec-stdin/target'), 'release/exec-stdin');
if (spawnSync('anvil', ['--version']).status !== 0) { console.log('skip - needs anvil'); process.exit(0); }
if (!existsSync(EXEC)) {
  console.log('building tests/exec-stdin (the settle guest in execute mode)...');
  const b = spawnSync('cargo', ['build', '--release', '--offline', '--manifest-path', join(ROOT, 'tests/exec-stdin/Cargo.toml')], { env: { ...process.env, GUEST_ELF: ELF }, stdio: 'inherit' });
  if (b.status !== 0 || !existsSync(EXEC)) { console.log('skip - the exec-stdin binary could not be built (EXEC=<binary>, or see tests/exec-stdin/Cargo.toml)'); process.exit(0); }
}
const elfSha = createHash('sha256').update(readFileSync(ELF)).digest('hex');
if (elfSha !== 'f7bc327d232ec8d1f693d5a44024c1ee732dc42196d079c5be5e3f3668b922c7') throw new Error(`the guest ELF is not the pinned one (${elfSha})`);

const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { encodeFunctionData, parseAbi, keccak256, encodeDeployData, concatHex, hexToBytes } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co';
const PORT = 25700 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${PORT}`, RPORT = PORT + 400, RELAY = `http://127.0.0.1:${RPORT}`;
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', ROUTER = '0x000000005dA3E3B73726af3c774Deeb9472D4992', AMM = '0x00000000E36C7EC997CC59DCda9E03673B448119';
const SP1_VERIFIER = '0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2';
const SETTLER = '0x00000000000000000000000000000000005e771e', FROM = '0x00000000000000000000000000000000000dE922';
const TETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (v) => '0x' + BigInt(v).toString(16);
const realFetch = globalThis.fetch;
const rpcA = async (method, params = []) => {
  const j = await (await realFetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { data: j.error.data });
  return j.result;
};

const procs = [], tmp = mkdtempSync(join(tmpdir(), 'routechange-'));
const stop = () => { for (const p of procs) p.kill('SIGKILL'); rmSync(tmp, { recursive: true, force: true }); };
process.on('exit', stop);
const head = BigInt((await (await realFetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) })).json()).result) - 2n;
procs.push(spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit'], { stdio: 'ignore' }));
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }
for (const a of [SETTLER, FROM]) { await rpcA('anvil_impersonateAccount', [a]); await rpcA('anvil_setBalance', [a, hex(100n * 10n ** 18n)]); }
{
  const pin = JSON.parse(readFileSync(join(ROOT, 'contracts/sp1/confidential/elf-vkey-pin.json'), 'utf8'));
  ok((await rpcA('eth_getCode', [POOL, 'latest'])).toLowerCase().includes(pin.program_vkey.slice(2).toLowerCase()) && pin.elf_sha256 === elfSha, `the guest run here is the one the live pool's immutable vkey names (${pin.program_vkey.slice(0, 14)}…)`);
}

await rpcA('anvil_setCode', [SP1_VERIFIER, '0x00']);                      // only the pool's SP1 verifier is replaced
const { stdinFor } = await import('../dapp/sp1-stdin.js');
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', DIST = '0x000000C918e44A3a443937fA7594eA4f7C95D6b9';
const SOLVER_A = '0x00000000000000000000000000000000000a0a0a', SOLVER_B = '0x00000000000000000000000000000000000b0b0b';
const BOND = 10n ** 16n, TREASURY = '0x000000000000000000000000000000000000dEaD';
const marketJson = JSON.parse(readFileSync(join(ROOT, 'contracts/out/ProofMarket.sol/ProofMarket.json'), 'utf8'));
const abi = parseAbi([
  'struct Intent { address payer; bytes32 opId; uint256 floorFee; uint256 maxFee; uint64 start; uint64 rampSecs; uint64 deadline; bytes32 tank; }',
  'function claim(Intent i, bytes signature) payable',
  'function claimFromTank(Tank t, bytes tankSig, Intent i, bytes intentSig) payable',
  'function fulfill(Intent i, bytes signature, bytes publicValues, bytes proofBytes, bytes[] memos, uint8 v, bytes32 r, bytes32 s)',
  'function intentHash(Intent i) view returns (bytes32)',
  'struct Tank { address payer; address delegate; uint256 cap; uint256 perOpMax; uint64 expiry; uint256 salt; }',
  'function tankHash(Tank t) view returns (bytes32)',
  'function fulfillFromTank(Tank t, bytes tankSig, Intent i, bytes intentSig, bytes publicValues, bytes proofBytes, bytes[] memos, uint8 v, bytes32 r, bytes32 s)',
  'function spent(bytes32 tankId) view returns (uint256)',
]);
async function send(from, to, data, value = '0x0') {
  let gas = 3_000_000n;
  try { gas = (BigInt(await rpcA('eth_estimateGas', [{ from, to, data, value }])) * 13n) / 10n; } catch (e) { throw Object.assign(new Error(`it would revert (${String(e.data || e.message).slice(0, 12)})`), { reverted: true, data: e.data }); }
  const h = await rpcA('eth_sendTransaction', [{ from, to, data, value, gas: hex(gas) }]);
  for (let i = 0; i < 1200; i++) { const rc = await rpcA('eth_getTransactionReceipt', [h]); if (rc) { if (rc.status !== '0x1') throw new Error(`reverted ${h}`); return { hash: h, rc }; } await sleep(100); }
  throw new Error('no receipt');
}
const refuses = async (fn) => { try { await fn(); return null; } catch (e) { return e.reverted ? e : Promise.reject(e); } };
const execGuest = (env) => new Promise((resolve) => {
  const c = spawn(EXEC, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
  c.on('close', (status) => resolve({ status, stdout, stderr }));
});
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (/^https:\/\/api\.tacit\.finance\//.test(u)) return new Response('{}', { status: 404 });
  if (/^https?:\/\/[^/]*(rpc|node|gateway|eth\.|llama|ankr|drpc|merkle|infura|alchemy|cloudflare|1rpc)/i.test(u) && init?.method === 'POST') return realFetch(RPC, { ...init, signal: AbortSignal.timeout(180_000) });
  return realFetch(url, init);
};
const { secp, sha256, keccak_256, hmac } = await import('../dapp/vendor/tacit-deps.min.js');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
const { setActiveNetwork } = await import('../dapp/confidential-deployments.js');
setActiveNetwork('mainnet');
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: (u, o) => globalThis.fetch(u, o), network: 'mainnet' });
const priv = crypto.getRandomValues(new Uint8Array(32));
ux.identity(priv);
const t0 = Date.now();
const WRAP_TIP = '0x000000D218B03db5837943b0b05DeA2965AE956e', TIPTO = '0x00000000000000000000000000000000000071F0';
const word = (h, i) => BigInt('0x' + String(h).replace(/^0x/, '').slice(i * 64, i * 64 + 64));
const depositStatus = async (id) => word(await rpcA('eth_call', [{ to: POOL, data: '0x7da9874f' + String(id).slice(2).padStart(64, '0') }, 'latest']), 0);
const tacOf = async (a) => word(await rpcA('eth_call', [{ to: TAC, data: '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0') }, 'latest']), 0);
for (const a of [SOLVER_A, SOLVER_B, DIST]) { await rpcA('anvil_impersonateAccount', [a]); await rpcA('anvil_setBalance', [a, hex(10n * 10n ** 18n)]); }

// ── the market is deployed; a holder with a key of their own and live TAC, no allowance and no gas ──
const deploy = encodeDeployData({ abi: [...marketJson.abi], bytecode: marketJson.bytecode.object, args: [POOL, TAC, 60n, BOND, TREASURY] });
const market = (await send(SETTLER, null, deploy)).rc.contractAddress;
ok(!!market, `ProofMarket is deployed on the fork (${market})`);
const payer = privateKeyToAccount('0x' + 'b0'.repeat(31) + '0b');
{
  const have = await tacOf(DIST), give = have < 50n * 10n ** 18n ? have : 50n * 10n ** 18n;
  await send(DIST, TAC, '0xa9059cbb' + payer.address.slice(2).toLowerCase().padStart(64, '0') + give.toString(16).padStart(64, '0'));
  ok(give > 0n && (await tacOf(payer.address)) === give, `the holder has ${Number(give) / 1e18} live TAC and no allowance to the market`);
}

// ── a wrap: its deposit made, its proof built by the real guest ──
const ETH2 = 2n * 10n ** 16n;
const index = await ux.nextWrapIndex({ walletPriv: priv, ticker: 'cETH' });
const built = ux.buildWrap({ walletPriv: priv, amountWei: ETH2, ticker: 'cETH', index });
await send(FROM, WRAP_TIP, '0xfc24c435' + built.commit.slice(2).padStart(64, '0') + ETH2.toString(16).padStart(64, '0') + TIPTO.slice(2).toLowerCase().padStart(64, '0'), hex(ETH2));
ok((await depositStatus(built.depositId)) === 1n, 'the wrap deposit is in the pool, waiting for its proof');
const memoHashes = built.memos.map((m) => keccak256(m.startsWith('0x') ? m : `0x${m}`));
const f = join(tmp, 'wrap.stdin'), out = join(tmp, 'wrap.pv');
writeFileSync(f, stdinFor('wrap', { ...built.wrapOp, memoHashes }));
const g = await execGuest({ ...process.env, STDIN: f, OUT: out });
if (g.status !== 0 || !existsSync(out)) throw new Error(`the settle guest rejected the wrap: ${(g.stderr + g.stdout).slice(-300)}`);
const pv = `0x${readFileSync(out, 'utf8').trim()}`, proof = '0x' + '11'.repeat(32), memos = built.memos.map((m) => (m.startsWith('0x') ? m : `0x${m}`));
ok(pv.length > 100, `the real guest proved it (${(g.stdout.split('\n').find((l) => l.startsWith('EXECUTE_OK')) || '').slice(0, 60)})`);

// ── the holder's intent and permit ──
const block = await rpcA('eth_getBlockByNumber', ['latest', false]), now = Number(BigInt(block.timestamp));
const intent = (opId, floor, max) => ({ payer: payer.address, opId, floorFee: floor, maxFee: max, start: BigInt(now), rampSecs: 0n, deadline: BigInt(now + 3600), tank: '0x' + '00'.repeat(32) });
const signIntent = async (i) => payer.sign({ hash: await rpcA('eth_call', [{ to: market, data: encodeFunctionData({ abi, functionName: 'intentHash', args: [i] }) }, 'latest']) });
const signPermit = async (i) => {
  const nonce = word(await rpcA('eth_call', [{ to: TAC, data: '0x7ecebe00' + payer.address.slice(2).toLowerCase().padStart(64, '0') }, 'latest']), 0);
  const ds = await rpcA('eth_call', [{ to: TAC, data: '0x3644e515' }, 'latest']);
  const sh = keccak256(`0x${keccak256('0x' + Buffer.from('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)').toString('hex')).slice(2)}${payer.address.slice(2).toLowerCase().padStart(64, '0')}${market.slice(2).toLowerCase().padStart(64, '0')}${i.maxFee.toString(16).padStart(64, '0')}${nonce.toString(16).padStart(64, '0')}${i.deadline.toString(16).padStart(64, '0')}`);
  const sig = await payer.sign({ hash: keccak256(concatHex(['0x1901', ds, sh])) });
  return { r: sig.slice(0, 66), s: `0x${sig.slice(66, 130)}`, v: parseInt(sig.slice(130, 132), 16) };
};
const FLOOR = 1n * 10n ** 18n, MAX = 4n * 10n ** 18n;
const I = intent(keccak256(pv), FLOOR, MAX), sigI = await signIntent(I), pm = await signPermit(I);
const fulfill = (from, i, sig, publicValues, p) => send(from, market, encodeFunctionData({ abi, functionName: 'fulfill', args: [i, sig, publicValues, proof, memos, p.v, p.r, p.s] }));
const bal0 = await tacOf(payer.address);

// ── a copied proof cannot take the fee while another prover holds the claim ──
await send(SOLVER_A, market, encodeFunctionData({ abi, functionName: 'claim', args: [I, sigI] }), hex(BOND));
ok(!!(await refuses(() => fulfill(SOLVER_B, I, sigI, pv, pm))) && (await depositStatus(built.depositId)) === 1n && (await tacOf(SOLVER_B)) === 0n, 'a second prover who copies the proof is refused while the claim stands: nothing settles, nothing is paid');

// ── a proof for another op, and a pool refusal, move no TAC ──
ok(!!(await refuses(() => fulfill(SOLVER_A, I, sigI, '0x' + 'ab'.repeat(40), pm))) && (await tacOf(payer.address)) === bal0, 'a proof for another op than the one signed is refused');
{
  const bogus = '0x' + 'cd'.repeat(64), J = intent(keccak256(bogus), FLOOR, MAX), sj = await signIntent(J), pj = await signPermit(J);
  ok(!!(await refuses(() => fulfill(SOLVER_A, J, sj, bogus, pj))) && (await tacOf(payer.address)) === bal0, 'a proof the pool refuses reverts the whole call and moves no TAC');
}

// ── the claimant settles through the market and is paid in live TAC ──
const r1 = await fulfill(SOLVER_A, I, sigI, pv, pm);
const price = MAX;           // ramp 0: the signed maximum
ok((await depositStatus(built.depositId)) === 2n && (await tacOf(payer.address)) === bal0 - price && (await tacOf(SOLVER_A)) === price, `one transaction settled the deposit and paid the prover ${Number(price) / 1e18} TAC from the holder (gas ${BigInt(r1.rc.gasUsed)})`);
const note = (await ux.balance(priv, { bridge: false })).notes.find((n) => BigInt(n.value) === ETH2 / 10n ** 10n);
ok(!!note, 'the holder\'s private tETH note is in their balance');
const pm2 = await signPermit(I);
ok(!!(await refuses(() => fulfill(SOLVER_B, I, sigI, pv, pm2))), 'a second fulfil of the same op is refused');

// ── the proof tank: one signed package (a session key, a cap, a per-op limit), the op signed silently by that key ──
{
  const delegate = privateKeyToAccount('0x' + 'd1'.repeat(32));
  const index2 = await ux.nextWrapIndex({ walletPriv: priv, ticker: 'cETH' });
  const b2 = ux.buildWrap({ walletPriv: priv, amountWei: ETH2, ticker: 'cETH', index: index2 });
  await send(FROM, WRAP_TIP, '0xfc24c435' + b2.commit.slice(2).padStart(64, '0') + ETH2.toString(16).padStart(64, '0') + TIPTO.slice(2).toLowerCase().padStart(64, '0'), hex(ETH2));
  const mh = b2.memos.map((m) => keccak256(m.startsWith('0x') ? m : `0x${m}`)), f2 = join(tmp, 'wrap2.stdin'), o2 = join(tmp, 'wrap2.pv');
  writeFileSync(f2, stdinFor('wrap', { ...b2.wrapOp, memoHashes: mh }));
  const g2 = await execGuest({ ...process.env, STDIN: f2, OUT: o2 });
  const pv2 = `0x${readFileSync(o2, 'utf8').trim()}`, memos2 = b2.memos.map((m) => (m.startsWith('0x') ? m : `0x${m}`));
  const tank = { payer: payer.address, delegate: delegate.address, cap: 30n * 10n ** 18n, perOpMax: 10n * 10n ** 18n, expiry: BigInt(now + 86400), salt: 7n };
  const tankSig = await payer.sign({ hash: await rpcA('eth_call', [{ to: market, data: encodeFunctionData({ abi, functionName: 'tankHash', args: [tank] }) }, 'latest']) });
  const T = { ...intent(keccak256(pv2), 0n, 6n * 10n ** 18n), tank: await rpcA('eth_call', [{ to: market, data: encodeFunctionData({ abi, functionName: 'tankHash', args: [tank] }) }, 'latest']) }, tankIntentSig = await delegate.sign({ hash: await rpcA('eth_call', [{ to: market, data: encodeFunctionData({ abi, functionName: 'intentHash', args: [T] }) }, 'latest']) });
  // the permit is for the tank's whole cap, signed once
  const nonce = word(await rpcA('eth_call', [{ to: TAC, data: '0x7ecebe00' + payer.address.slice(2).toLowerCase().padStart(64, '0') }, 'latest']), 0), ds = await rpcA('eth_call', [{ to: TAC, data: '0x3644e515' }, 'latest']);
  const sh = keccak256(`0x${keccak256('0x' + Buffer.from('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)').toString('hex')).slice(2)}${payer.address.slice(2).toLowerCase().padStart(64, '0')}${market.slice(2).toLowerCase().padStart(64, '0')}${tank.cap.toString(16).padStart(64, '0')}${nonce.toString(16).padStart(64, '0')}${tank.expiry.toString(16).padStart(64, '0')}`);
  const ps = await payer.sign({ hash: keccak256(concatHex(['0x1901', ds, sh])) });
  const before = await tacOf(payer.address);
  await send(SOLVER_B, market, encodeFunctionData({ abi, functionName: 'claimFromTank', args: [tank, tankSig, T, tankIntentSig] }), hex(BOND));
  await send(SOLVER_B, market, encodeFunctionData({ abi, functionName: 'fulfillFromTank', args: [tank, tankSig, T, tankIntentSig, pv2, proof, memos2, parseInt(ps.slice(130, 132), 16), ps.slice(0, 66), `0x${ps.slice(66, 130)}`] }));
  const spentNow = word(await rpcA('eth_call', [{ to: market, data: encodeFunctionData({ abi, functionName: 'spent', args: [keccak256(await rpcA('eth_call', [{ to: market, data: encodeFunctionData({ abi, functionName: 'tankHash', args: [tank] }) }, 'latest'])).length ? await rpcA('eth_call', [{ to: market, data: encodeFunctionData({ abi, functionName: 'tankHash', args: [tank] }) }, 'latest']) : '0x'] }) }, 'latest']), 0);
  ok(g2.status === 0 && (await depositStatus(b2.depositId)) === 2n && before - (await tacOf(payer.address)) === 6n * 10n ** 18n && spentNow === 6n * 10n ** 18n,
    'from a tank signed once, an op signed by the session key settles through the market, paid 6 TAC, the tank count at 6 of its 30 cap');
}

console.log(`\n${n} passed, ${fails} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
stop();
process.exit(fails ? 1 : 0);
