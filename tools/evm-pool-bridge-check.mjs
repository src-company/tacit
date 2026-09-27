// Live check of moving private ETH from the Ethereum pool to Base and Robinhood Chain (wallet.bridgeOut): a fresh
// wallet deposits on Ethereum, moves part to its private ETH address on each L2 in one relayed withdraw-and-call
// through the canonical bridge, and finds it there as a note: swept by the Base keeper, and on Robinhood Chain
// (below that keeper's minimum) swept by the wallet itself from the funder, no fee. Notes stay in the pools.
//   FUNDER_KEY=<0x…> node tools/evm-pool-bridge-check.mjs <deposit wei> <to Base wei> <to Robinhood wei>
//   IDS=<tools/.live-check-bridge-….json> resumes that wallet: no new deposit (deposit wei 0), then the moves given.

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

const [depS, baseS, rhS] = process.argv.slice(2);
const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
const CH = {
  1: { rpc: 'https://ethereum-rpc.publicnode.com', keeper: 'https://tacit-evm-pool-keeper.onrender.com/evm-pool/keeper', deployBlock: 26069245 },
  8453: { rpc: 'https://mainnet.base.org', keeper: 'https://tacit-evm-pool-keeper-base.onrender.com/evm-pool/keeper', deployBlock: 51864014 },
  4663: { rpc: 'https://rpc.mainnet.chain.robinhood.com', keeper: 'https://tacit-evm-pool-keeper-robinhood.onrender.com/evm-pool/keeper', deployBlock: 73991661 },
};
const ART = new URL('../dapp/evm-pool/', import.meta.url).pathname;
const wasm = readFileSync(ART + 'transact.wasm'), zkey = readFileSync(ART + 'transact_final.zkey');
const prove = (input) => proveTransact(input, { wasm, zkey, snarkjs });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, what, ms = 1_800_000) => { const t0 = Date.now(); for (;;) { const v = await f().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await sleep(10_000); } };
const eth = (w) => (Number(w) / 1e18).toFixed(7);
const chainOf = (id) => defineChain({ id, name: `c${id}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [CH[id].rpc] } } });
const pub = (id) => createPublicClient({ chain: chainOf(id), transport: http(CH[id].rpc) });
const client = (id, k) => createWalletClient({ account: privateKeyToAccount(k), chain: chainOf(id), transport: http(CH[id].rpc) });
const signerOf = (w) => ({ address: w.account.address, send: ({ to, data, value }) => w.sendTransaction({ to, data, value }) });

const ids = process.env.IDS ? JSON.parse(readFileSync(process.env.IDS, 'utf8')) : { mover: '0x' + randomBytes(32).toString('hex'), eoa: '0x' + randomBytes(32).toString('hex') };
if (!process.env.IDS) writeFileSync(new URL(`./.live-check-bridge-${Date.now()}.json`, import.meta.url), JSON.stringify(ids, null, 1));
const zk = await loadZk();
const keys = evmPoolKeys(zk, Uint8Array.from(Buffer.from(ids.mover.slice(2), 'hex')));
const walletOn = (id, signer = null) => makeEvmPoolWallet({ zk, keys, prove, signer, chain: { chainId: id, pool: POOL, router: ROUTER, rpc: jsonRpc(CH[id].rpc), deployBlock: CH[id].deployBlock, confirmations: 0, logChunk: 2000 }, keeper: CH[id].keeper });

const funder = client(1, process.env.FUNDER_KEY);
const eoa = client(1, ids.eoa);
const dep = BigInt(depS);
const l1 = walletOn(1, signerOf(eoa));
if (dep > 0n) {
  const gasBudget = 3n * 10n ** 15n; // one deposit's gas at any sane price
  await pub(1).waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: eoa.account.address, value: dep + gasBudget }) });
  const h0 = await l1.deposit({ amount: dep });
  await pub(1).waitForTransactionReceipt({ hash: h0 });
  log(`deposited ${eth(dep)} ETH into the Ethereum pool ${h0}`);
  await until(async () => (await l1.sync()).balance === dep && true, 'deposit note');
} else log(`resumed: the Ethereum wallet holds ${eth((await l1.sync()).balance)} ETH`);
log(`private address ${keys.address.slice(0, 16)}…, private ETH address ${l1.receiveBox} (the same on every chain)`);

const moves = [[8453, BigInt(baseS), 'Base'], [4663, BigInt(rhS), 'Robinhood Chain']].filter(([, a]) => a > 0n);
for (const [id, amount, name] of moves) {
  const there = walletOn(id);
  await there.watchReceive().catch(() => {});
  const before = BigInt(await pub(id).getBalance({ address: there.receiveBox }));
  const h = await l1.bridgeOut({ toChainId: id, amount, l2Rpc: jsonRpc(CH[id].rpc), onStep: (m) => log('  ' + m) });
  const r = await pub(1).waitForTransactionReceipt({ hash: h });
  log(`moved ${eth(amount)} ETH toward ${name}: ${h} (status ${r.status}, gas ${r.gasUsed})`);
  const arrived = await until(async () => { const b = BigInt(await pub(id).getBalance({ address: there.receiveBox })); const s = (await there.sync()).balance; return (b > before || s > 0n) && { b, s }; }, `${name} arrival`);
  log(`  arrived on ${name}: ${eth(arrived.b)} at the private ETH address, ${eth(arrived.s)} already in notes`);
  const q = await fetch(`${CH[id].keeper}/quote`).then((x) => x.json());
  if (arrived.s === 0n && BigInt(arrived.b) < BigInt(q.receiveMin)) {
    there.connect(signerOf(client(id, process.env.FUNDER_KEY)));
    const hs = await there.sweep({ onStep: (m) => log('  ' + m) });
    await pub(id).waitForTransactionReceipt({ hash: hs });
    log(`  below ${name}'s keeper minimum (${eth(q.receiveMin)}): swept it ourselves, no fee ${hs}`);
  }
  const s = await until(async () => { const x = await there.sync(); return x.balance > 0n && x; }, `${name} note`);
  log(`  ${name} wallet holds ${eth(s.balance)} ETH as a private note`);
}
log(`Ethereum wallet keeps ${eth((await l1.sync()).balance)} ETH; notes left in the pools`);
process.exit(0);
