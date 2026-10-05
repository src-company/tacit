// Live check of the EVM pool on a chain with no relay or keeper (MegaETH), with a tiny amount of real ETH, every
// transaction sent by a wallet of the test's own:
//   1. alice shields UNIT*2 from her own wallet (deposit, proved here);
//   2. alice pays bob UNIT privately (spend with change), bob finds it by scanning;
//   3. bob withdraws UNIT/2 to a fresh address from his own wallet;
//   4. the funder pays alice's private ETH address (a plain transfer) and alice sweeps it into a note herself: the
//      router's box is created, emptied and removed in one transaction;
//   5. what is left is withdrawn to the funder.
//   Gas used and its cost are printed for each step.
//
//   FUNDER_KEY=<0x…> node tools/evm-pool-mega-check.mjs <rpc> <deploy block> <unit wei>
//   e.g.  node tools/evm-pool-mega-check.mjs https://mainnet.megaeth.com/rpc 28397000 10000000000000
//
// KEEPER=<base url> sends bob's withdrawal through that relay (he needs no gas of his own) and checks its fee.
//
// Keys are written to $KEYS (default ~/.tacit-deployer/evm-pool-check-<chain>-<time>.json, mode 600) before anything is
// sent, so every note stays recoverable if a step fails. KEEP=1 leaves the notes in the pool at the end.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { createPublicClient, createWalletClient, http, defineChain, parseAbi, decodeEventLog } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const snarkjs = require('snarkjs');
const { loadZk } = await import('../worker-relay/src/lib/evm-pool-keeper-prover.js');
const { proveTransact, verifyTransact, vkHash } = await import('../dapp/evm-pool-zk-prover.js');
const { evmPoolKeys, makeEvmPoolWallet, jsonRpc, recipientOf } = await import('../dapp/evm-pool-wallet.js');

const [RPC, deployS, unitS] = process.argv.slice(2);
const UNIT = BigInt(unitS), DEPLOY = Number(deployS);
const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
const ART = new URL('../dapp/evm-pool/', import.meta.url).pathname;
const pin = JSON.parse(readFileSync(ART + 'pin.json', 'utf8'));
const vk = JSON.parse(readFileSync(ART + 'transact_vk.json', 'utf8'));
if (vkHash(vk) !== pin.vk_hash) throw new Error('vk does not match pin.json');
const wasm = readFileSync(ART + 'transact.wasm'), zkey = readFileSync(ART + 'transact_final.zkey');
const prove = async (input) => {
  const r = await proveTransact(input, { wasm, zkey, snarkjs });
  if (!(await verifyTransact(vk, r.publicSignals, r.proof, { snarkjs }))) throw new Error('proof does not verify');
  return r;
};

const probe = createPublicClient({ transport: http(RPC) });
const CHAIN = await probe.getChainId();
const chain = defineChain({ id: CHAIN, name: `c${CHAIN}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${CHAIN}`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eth = (w) => (Number(w) / 1e18).toFixed(9);
const hexb = (h) => Uint8Array.from(Buffer.from(h.slice(2), 'hex'));
const until = async (f, what, ms = 180_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await sleep(1000); } };

// A wallet of this test's own: sends with a fee a little over the chain's price, checks the receipt, counts what it spends.
let spent = 0n;
const walletOf = (k, name) => {
  const account = privateKeyToAccount(k), w = createWalletClient({ account, chain, transport: http(RPC) });
  return {
    account, address: account.address,
    async send({ to, data, value, gas }) {
      const gasPrice = (await pub.getGasPrice()) * 2n;
      const h = await w.sendTransaction({ to, data, value, gasPrice, type: 'legacy', ...(gas ? { gas } : {}) });
      const r = await pub.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
      if (r.status !== 'success') throw new Error(`${name}: reverted ${h}`);
      const cost = r.gasUsed * r.effectiveGasPrice;
      spent += cost;
      log(`  ${name} tx ${h.slice(0, 12)}… gas ${r.gasUsed} cost ${eth(cost)} ETH`);
      return h;
    },
  };
};
const funder = walletOf(process.env.FUNDER_KEY, 'funder');
const K = () => '0x' + randomBytes(32).toString('hex');
const ids = { alice: K(), bob: K(), aliceEoa: K(), bobEoa: K(), fresh: K() };
const keyFile = process.env.KEYS || `${homedir()}/.tacit-deployer/evm-pool-check-${CHAIN}-${Date.now()}.json`;
mkdirSync(`${homedir()}/.tacit-deployer`, { recursive: true });
writeFileSync(keyFile, JSON.stringify(ids, null, 1), { mode: 0o600 });
log(`keys saved to ${keyFile}`);

const zk = await loadZk();
const cfg = { chainId: CHAIN, pool: POOL, router: ROUTER, rpc: jsonRpc(RPC), deployBlock: DEPLOY, confirmations: 0, logChunk: 50_000 };
const alice = { eoa: walletOf(ids.aliceEoa, 'alice'), keys: evmPoolKeys(zk, hexb(ids.alice)) };
const bob = { eoa: walletOf(ids.bobEoa, 'bob'), keys: evmPoolKeys(zk, hexb(ids.bob)) };
const KEEPER = process.env.KEEPER || null;
for (const p of [alice, bob]) p.w = makeEvmPoolWallet({ zk, keys: p.keys, chain: cfg, prove, signer: p.eoa, feed: false, keeper: p === bob ? KEEPER : null });
const fresh = privateKeyToAccount(ids.fresh).address;
const t0 = Date.now();

const poolBefore = await pub.getBalance({ address: POOL });
log(`pool holds ${eth(poolBefore)} ETH, funder ${eth(await pub.getBalance({ address: funder.address }))} ETH`);

// 1. alice shields 2 units. Her wallet gets the deposit plus gas for the whole run.
const gasMoney = BigInt(process.env.GAS_MONEY || 40_000_000_000_000n);
await funder.send({ to: alice.eoa.address, value: 2n * UNIT + gasMoney });
await alice.w.deposit({ amount: 2n * UNIT, onStep: (s) => log('  alice:', s) });
const a1 = await until(async () => { const x = await alice.w.sync(); return x.balance === 2n * UNIT && x; }, 'alice finds her note');
log(`1. alice shielded ${eth(2n * UNIT)} ETH: private balance ${eth(a1.balance)}; pool now holds ${eth(await pub.getBalance({ address: POOL }))} ETH`);

// 2. alice pays bob 1 unit privately, with change.
await alice.w.send({ to: bob.w.address, amount: UNIT, via: 'self', onStep: (s) => log('  alice:', s) });
const b1 = await until(async () => { const x = await bob.w.sync(); return x.balance === UNIT && x; }, 'bob finds the payment');
const a2 = await until(async () => { const x = await alice.w.sync(); return x.balance === UNIT && x; }, 'alice sees her change');
log(`2. alice paid bob privately: bob found ${eth(b1.balance)} ETH by scanning, alice kept ${eth(a2.balance)} ETH`);

// 3. bob withdraws half a unit to a fresh address: through the relay when KEEPER is set, else from his own wallet.
if (KEEPER) {
  const q = await bob.w.quote();
  log(`   relay quote: fee ${eth(q.fee)} ETH, receive minimum ${eth(q.receiveMin ?? 0)} ETH, relayer ${q.relayer}`);
  await bob.w.withdraw({ to: fresh, amount: UNIT / 2n, onStep: (s) => log('  bob:', s) });
} else {
  await funder.send({ to: bob.eoa.address, value: gasMoney });
  await bob.w.withdraw({ to: fresh, amount: UNIT / 2n, via: 'self', onStep: (s) => log('  bob:', s) });
}
const got = await until(async () => { const b = await pub.getBalance({ address: fresh }); return b > 0n && b; }, 'fresh address balance');
const fee = KEEPER ? BigInt((await bob.w.quote()).fee) : 0n;
const b2 = await until(async () => { const x = await bob.w.sync(); return x.balance > 0n && x.balance <= UNIT - UNIT / 2n && x; }, 'bob sees his change');
log(`3. bob withdrew ${eth(UNIT / 2n)} ETH to a fresh address${KEEPER ? ' through the relay' : ''}: it holds ${eth(got)} ${got === UNIT / 2n ? '(exact)' : '(MISMATCH)'}; bob keeps ${eth(b2.balance)} ETH private${KEEPER ? ` (relay fee ${eth(UNIT - UNIT / 2n - b2.balance)})` : ''}`);

// 4. a plain transfer to alice's private ETH address, swept into a note by alice herself.
const box = alice.w.receiveBox, payBox = UNIT / 2n;
const code0 = await pub.getCode({ address: box });
await funder.send({ to: box, value: payBox });
log(`   funder paid ${eth(payBox)} ETH to alice's private ETH address ${box} (code before: ${code0 ? 'yes' : 'none'})`);
await alice.w.sweep({ onStep: (s) => log('  alice:', s) });
const a3 = await until(async () => { const x = await alice.w.sync(); return x.balance === UNIT + payBox && x; }, 'alice finds the swept note');
const code1 = await pub.getCode({ address: box }), left = await pub.getBalance({ address: box });
log(`4. alice swept the address into a note herself: private balance ${eth(a3.balance)} ETH; the address now has ${code1 ? 'CODE' : 'no code'} and ${eth(left)} ETH ${!code1 && left === 0n ? '(closed cleanly)' : '(CHECK)'}`);

// 5. everything left goes back to the funder (KEEP=1 leaves it in the pool).
if (process.env.KEEP !== '1') {
  for (const [n, p] of [['alice', alice], ['bob', bob]]) {
    const b = (await p.w.sync()).balance;
    if (b > 0n) {
      const done = await p.w.withdraw({ to: funder.address, amount: b, ...(p === bob && KEEPER ? {} : { via: 'self' }) }).then(() => true, (e) => { log(`5. ${n} keeps ${eth(b)} ETH in the pool: ${e.message}`); return false; });
      if (done) log(`5. ${n} withdrew ${eth(b)} ETH back to the funder`);
    }
  }
  for (const p of [alice, bob]) {
    // 100k gas: a plain transfer needs 21k on most chains and 60k on MegaETH; what is unused is not charged.
    const bal = await pub.getBalance({ address: p.eoa.address }), gasPrice = (await pub.getGasPrice()) * 2n, cost = gasPrice * 100_000n * 3n;
    if (bal > cost) await p.eoa.send({ to: funder.address, value: bal - cost, gas: 100_000n });
  }
}
const txs = (await pub.getBalance({ address: POOL })) - poolBefore;
log(`done in ${Math.round((Date.now() - t0) / 1000)}s · gas spent by the test wallets ${eth(spent)} ETH · pool balance change ${eth(txs)} ETH · funder now ${eth(await pub.getBalance({ address: funder.address }))} ETH`);
process.exit(0);
