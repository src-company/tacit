// Checks dapp/evm-pool/tacit-evm-pool-wallet.js in a real browser against an anvil fork of Base (the live pool,
// router and ceremony verifier): two wallets built from the bundle with no relayer deposit, sweep their private
// ETH address, pay each other privately and withdraw to a fresh address, all proved in the bundle's Blob worker
// and sent through an EIP-1193 provider.
//   PLAYWRIGHT=<path to playwright-core> node tools/evm-pool-bundle-check.mjs [fork rpc]

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const FORK = process.argv[2] || 'https://base.drpc.org';
const PORT = 19545 + Math.floor(Math.random() * 500);
const ANVIL = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--silent', '--chain-id', '8453'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
for (let i = 0; ; i++) {
  try { const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' }); if (r.ok) break; } catch {}
  if (i > 60) throw new Error('anvil did not start'); await sleep(500);
}

const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm', '.zkey': 'application/octet-stream' };
const PAGE = `<!doctype html><script type="module">
import { makeEvmPoolWallet } from '/evm-pool/tacit-evm-pool-wallet.js';
const rpc = async (method, params = []) => { const r = await (await fetch('${ANVIL}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw Object.assign(new Error(r.error.message), { data: r.error.data }); return r.result; };
const provider = (account) => ({ request: ({ method, params }) => method === 'eth_requestAccounts' || method === 'eth_accounts' ? [account] : rpc(method, params) });
const until = async (f) => { for (let i = 0; i < 120; i++) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 500)); } throw new Error('timed out'); };
const receipt = (h) => until(async () => { const r = await rpc('eth_getTransactionReceipt', [h]); if (r && r.status !== '0x1') throw new Error('reverted ' + h); return r; });
const bytes = async (f) => new Uint8Array(await (await fetch('/evm-pool/' + f)).arrayBuffer());
window.run = async () => {
  const log = [];
  const [accA, accB] = await rpc('eth_accounts');
  const artifacts = { wasm: await bytes('transact.wasm'), zkey: await bytes('transact_final.zkey'), vk: await bytes('transact_vk.json') };
  const key = (b) => new Uint8Array(32).fill(b);
  const tip = Number(await rpc('eth_blockNumber'));
  const opts = { chainId: 8453, artifacts, confirmations: 0 };
  const alice = await makeEvmPoolWallet({ ...opts, provider: provider(accA), identityKey: key(0x61) });
  const bob = await makeEvmPoolWallet({ ...opts, provider: provider(accB), identityKey: key(0x62) });
  let t = performance.now();
  await receipt(await alice.deposit(10n ** 16n));
  log.push('deposit ' + Math.round(performance.now() - t) + ' ms, balance ' + (await alice.sync()).balance);
  await receipt(await rpc('eth_sendTransaction', [{ from: accB, to: alice.receive.address, value: '0x' + (12345n).toString(16) }]));
  log.push('waiting at the private address ' + (await alice.receive.waiting()));
  await receipt(await alice.receive.sweep());
  log.push('after sweep ' + (await alice.sync()).balance);
  t = performance.now();
  await receipt(await alice.send(bob.address, 6n * 10n ** 15n));
  log.push('send ' + Math.round(performance.now() - t) + ' ms; bob ' + (await until(async () => { const s = await bob.sync(); return s.balance > 0n && s; })).balance);
  const fresh = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(20)), (x) => x.toString(16).padStart(2, '0')).join('');
  const h = await bob.withdraw(fresh, 4n * 10n ** 15n);
  await receipt(h);
  log.push('fresh got ' + BigInt(await rpc('eth_getBalance', [fresh, 'latest'])) + ', bob keeps ' + (await bob.sync()).balance + ', sent by ' + (await rpc('eth_getTransactionByHash', [h])).from);
  let refused = '';
  try { await makeEvmPoolWallet({ ...opts, provider: provider(accA), identityKey: key(1), artifacts: { ...artifacts, wasm: artifacts.wasm.slice(1) } }); } catch (e) { refused = e.message; }
  log.push('tampered wasm: ' + refused);
  alice.terminate(); bob.terminate();
  return log;
};
window.ready = true;
</script>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
  const f = join(ROOT, 'dapp', url.pathname);
  if (!f.startsWith(join(ROOT, 'dapp')) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('page:', m.text()); });
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.ready, null, { timeout: 30_000 });
  const log = await page.evaluate(() => window.run());
  for (const l of log) console.log(l);
} finally {
  await browser.close();
  server.close();
  anvil.kill('SIGKILL');
}
process.exit(0);
