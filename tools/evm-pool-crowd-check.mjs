// Live check of many users at once on one chain's keeper: wallet A deposits and pays B, C and D privately; then A,
// B, C and D each send to E at the same moment through the keeper, which queues them in reserved slots. Reports
// how many proofs each spend took and how the transactions landed across blocks. Notes stay in the pool.
//   FUNDER_KEY=<0x…> node tools/evm-pool-crowd-check.mjs <chainId> <rpc> <keeper> <deploy block> <deposit wei> <seed wei> <send wei>

import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { createPublicClient, createWalletClient, http, defineChain } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const snarkjs = require('snarkjs');
const { loadZk } = await import('../worker-relay/src/lib/evm-pool-keeper-prover.js');
const { proveTransact } = await import('../dapp/evm-pool-zk-prover.js');
const { evmPoolKeys, makeEvmPoolWallet, jsonRpc } = await import('../dapp/evm-pool-wallet.js');

const [chainS, RPC, KEEPER, deployS, depS, seedS, sendS] = process.argv.slice(2);
const CHAIN = Number(chainS), dep = BigInt(depS), seed = BigInt(seedS), amt = BigInt(sendS);
const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
const ART = new URL('../dapp/evm-pool/', import.meta.url).pathname;
const wasm = readFileSync(ART + 'transact.wasm'), zkey = readFileSync(ART + 'transact_final.zkey');
const prove = (input) => proveTransact(input, { wasm, zkey, snarkjs });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${CHAIN}`, ...a);
const eth = (w) => (Number(w) / 1e18).toFixed(7);
const chain = defineChain({ id: CHAIN, name: `c${CHAIN}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const client = (k) => createWalletClient({ account: privateKeyToAccount(k), chain, transport: http(RPC) });
const signerOf = (w) => ({ address: w.account.address, send: ({ to, data, value }) => w.sendTransaction({ to, data, value }) });

// IDS=<tools/.live-check-crowd-….json> resumes those wallets: A's existing note is used, no deposit.
const ids = process.env.IDS ? JSON.parse(readFileSync(process.env.IDS, 'utf8')) : Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'eoa'].map((k) => [k, '0x' + randomBytes(32).toString('hex')]));
if (!process.env.IDS) writeFileSync(new URL(`./.live-check-crowd-${CHAIN}-${Date.now()}.json`, import.meta.url), JSON.stringify(ids, null, 1));
const zk = await loadZk();
const cfg = { chainId: CHAIN, pool: POOL, router: ROUTER, rpc: jsonRpc(RPC), deployBlock: Number(deployS), confirmations: 0, logChunk: 2000 };
const W = (k, signer = null) => makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, Uint8Array.from(Buffer.from(ids[k].slice(2), 'hex'))), chain: cfg, keeper: KEEPER, prove, signer });

const funder = client(process.env.FUNDER_KEY), eoa = client(ids.eoa);
const A = W('a', signerOf(eoa)), B = W('b'), C = W('c'), D = W('d'), E = W('e');
if (!process.env.IDS) {
  await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: eoa.account.address, value: dep + 2n * 10n ** 14n }) });
  await pub.waitForTransactionReceipt({ hash: await A.deposit({ amount: dep }) });
  log(`A deposited ${eth(dep)} ETH`);
} else log(`resumed: A holds ${eth((await A.sync()).balance)} ETH`);
const until = async (f) => { for (let i = 0; i < 60; i++) { if (await f()) return; await new Promise((r) => setTimeout(r, 3000)); } throw new Error('timed out'); };
for (const [name, w] of [['B', B], ['C', C], ['D', D]]) {
  if ((await w.sync()).balance >= seed) continue; // seeded by an earlier run
  const h = await A.send({ to: w.address, amount: seed });
  log(`A paid ${name} ${eth(seed)} privately ${h}`);
}
for (const w of [B, C, D]) await until(async () => (await w.sync()).balance >= seed);
await A.sync();
log(`all four hold notes; now they send to E at once`);
const users = [['A', A], ['B', B], ['C', C], ['D', D]];
const proofs = users.map(() => 0);
const t0 = Date.now();
const hashes = await Promise.all(users.map(([, w], i) => w.send({ to: E.address, amount: amt, onStep: (m) => { if (m === 'proving on this device') proofs[i]++; } })));
const took = ((Date.now() - t0) / 1000).toFixed(1);
const blocks = await Promise.all(hashes.map(async (h) => (await pub.waitForTransactionReceipt({ hash: h })).blockNumber));
for (let i = 0; i < users.length; i++) log(`  ${users[i][0]}: ${proofs[i]} proof(s), block ${blocks[i]}, ${hashes[i]}`);
const e = await (async () => { for (let i = 0; i < 60; i++) { const s = await E.sync(); if (s.notes >= 4) return s; await new Promise((r) => setTimeout(r, 5000)); } return E.sync(); })();
log(`four simultaneous sends in ${took} s over ${new Set(blocks.map(String)).size} block(s), ${proofs.reduce((a, b) => a + b, 0)} proofs; E holds ${eth(e.balance)} ETH in ${e.notes} notes`);
process.exit(0);
