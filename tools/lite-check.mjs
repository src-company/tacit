// Checks dapp/lite/index.html in a real browser against an anvil fork of Ethereum: public RPC hosts are routed to
// the fork and window.ethereum is an EIP-1193 stub that sends as the chosen account (anvil's first key, or an
// impersonated one). The relay's submit and the EVM-pool keepers are stubbed, so nothing reaches a live service.
//   airdrop  a listed recipient claims its TAC; the tile updates
//   pair     ETH + TAC staked in one transaction with an EIP-2612 permit
//   farm     a one-sided ETH zap waits for its typed loss acceptance, stakes, claims, then withdraws everything
//   buy      TAC bought with ETH through zRouter
//   v1       the identity signature unlocks the key; a tipped wrap lands and its settle is submitted
//   device   a deposit into the EVM pool, proved in the page's worker
//   borrow   the Bitcoin deposit address renders; a bond for a lock record posts through the escrow helper
//   keys     an Ethereum signature opens a key; after locking, "continue" reopens the same tacit1 address; a pasted key opens
//   saved    a passphrase-locked key saved the way tacit.finance saves it opens through tacit.js's own prompt
//   bitcoin  a (stubbed, deterministic) UniSat wallet opens a key through tacit.js, then funds a lock in one call
//   passkey  a virtual authenticator with PRF creates a passkey wallet, and signing in again opens the same key
//   acct     a pasted key and no wallet: its Tacit account (as pool-ux derives it), funded from outside, buys TAC,
//            stakes ETH + TAC with a permit it signs, sends ETH out; a connected wallet then tops it up
//   devmove  (after acct) the Tacit account deposits into the EVM pool, sweeps a small arrival in, moves pool ETH into
//            V1 through a keeper-relayed withdrawToV1 whose note settle is then submitted, and asks to bridge to Base
//   pts      a listed address claims its points reward; a pasted key's Tacit account registers a .wei name through
//            zRouter's commit and reveal and publishes its tacit1 address on it
//   btc      a pasted key's Bitcoin sheet: balances read, BTC routes (tacit1 and sp1 as silent payments, bc1 plain), TAC
//            routes refuse plain addresses, a tacit1's silent-payment keys are the ones this wallet scans, a payment link checks
//   PLAYWRIGHT=<path to playwright-core> node tools/lite-check.mjs [scenario,…] [fork rpc]   (SHOTS=<dir> saves screenshots)

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const ONLY = new Set((process.argv[2] || 'airdrop,pair,farm,buy,v1,device,borrow,keys,saved,bitcoin,passkey,acct,devmove,btc,pts').split(','));
const FORK = process.argv[3] || 'https://mainnet.gateway.tenderly.co';
const SHOTS = process.env.SHOTS || null;
const PORT = 20000 + Math.floor(Math.random() * 2000), WEB = PORT + 1;
const ANVIL = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
const rpc = async (method, params = []) => {
  const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw Object.assign(new Error(r.error.message), { data: r.error.data });
  return r.result;
};
for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }

const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.zkey': 'application/octet-stream' };
const server = createServer((req, res) => {
  let f = normalize(join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

const RPC_HOSTS = ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co', 'cloudflare-eth.com', 'rpc.flashbots.net'];
const submits = [], relays = [];

// router.withdrawToV1(tx, intent), encoded as evm-pool-wallet.js encodes it for a self-sent move.
const { calldata } = await import(new URL('../dapp/evm-pool-gateway.js', import.meta.url));
const EVM_ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', KEEPER = '0xa0ee7a142d267c1f36714e4a8f75612f20a79720';   // anvil account 9
const PAIR = { tuple: ['uint256', 'uint256'] }, B = (x) => BigInt(x);
const TX_TYPES = [PAIR, { tuple: [PAIR, PAIR] }, PAIR, { tuple: Array(11).fill('uint256') }, 'address', 'uint256', 'address', 'uint256', 'bytes', 'bytes'];
const TX_SIG = '(uint256[2],uint256[2][2],uint256[2],uint256[11],address,int256,address,uint256,bytes,bytes)';
const WRAP_SIG = '(bytes32,uint256,uint256,address,bytes32,address,uint64,uint256)';
const WRAP_TYPES = ['bytes32', 'uint256', 'uint256', 'address', 'bytes32', 'address', 'uint64', 'uint256'];
const withdrawToV1Data = (t, i) => calldata(`withdrawToV1(${TX_SIG},${WRAP_SIG})`, [{ tuple: TX_TYPES }, { tuple: WRAP_TYPES }], [
  [t.pA.map(B), t.pB.map((r) => r.map(B)), t.pC.map(B), t.publicInputs.map(B), t.recipient, BigInt.asUintN(256, B(t.extAmount)), t.relayer, B(t.fee), t.memo0, t.memo1],
  [i.assetId, B(i.amount), B(i.tip), i.tipTo, i.commit, i.refund, B(i.deadline), B(i.nonce)]]);
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

async function openPage({ account, key = null, host = '127.0.0.1', init = null }) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  for (const h of RPC_HOSTS) await ctx.route(`https://${h}/**`, async (route) => {
    const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() });
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await r.text() });
  });
  // On localhost the modules send relay calls to the page's own origin (confidential-deployments.js), so both that
  // path and the live host are covered: submits and job status are stubbed, reads pass through to the live API.
  const relay = async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/confidential/submit') { submits.push(JSON.parse(route.request().postData() || '{}')); return json(route, { jobId: 'stub-' + submits.length }); }
    if (u.pathname === '/confidential/status') return json(route, { status: 'failed', error: 'stubbed in the fork check' });
    const r = await fetch('https://api.tacit.finance' + u.pathname + u.search, { method: route.request().method(), headers: { 'content-type': 'application/json' }, body: route.request().method() === 'GET' ? undefined : route.request().postData() });
    return route.fulfill({ status: r.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await r.text() });
  };
  await ctx.route(/^https:\/\/api\.tacit\.finance\/confidential\/(submit|status)/, relay);
  await ctx.route(new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${WEB}/(confidential|farm|reflection)/`), relay);
  // Keepers: quotes are canned and the queue is absent (wallets prove against their own tree). A move into V1 is
  // relayed for real, router.withdrawToV1 sent as a keeper would; any other relay is recorded and refused.
  await ctx.route('https://tacit-evm-pool-keeper*.onrender.com/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (/\/quote$/.test(p)) return json(route, { relayer: '0x0000000000000000000000000000000000000001', fee: '329000000000000', sweepFee: '439000000000000', receiveMin: '175600000000000000' });
    if (/\/(head|reserve)$/.test(p)) return route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
    if (/\/relay$/.test(p)) {
      const b = JSON.parse(route.request().postData() || '{}');
      relays.push(b);
      if (!b.wrap) return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: 'stubbed in the fork check' }) });
      b.txHash = await rpc('eth_sendTransaction', [{ from: KEEPER, to: EVM_ROUTER, data: withdrawToV1Data(b.tx, b.wrap), gas: '0x2dc6c0' }]);
      return json(route, { txHash: b.txHash });
    }
    return json(route, { ok: true });
  });
  await ctx.exposeFunction('__wallet', async (method, params = []) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'wallet_switchEthereumChain' || method === 'wallet_watchAsset') return null;
    if (method === 'personal_sign' || method === 'eth_signTypedData_v4') {
      if (!key) throw Object.assign(new Error('this account cannot sign'), { code: 4001 });
      let digest;
      if (method === 'personal_sign') {
        const msg = Buffer.from(params[0].slice(2), 'hex');
        digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]));
      } else {                                                  // EIP-2612 Permit, the only typed data the page signs
        const d = JSON.parse(params[1]), m = d.message, hx = (b) => Buffer.from(b).toString('hex');
        const k = (s) => keccak_256(typeof s === 'string' ? Buffer.from(s) : s);
        const dom = k(Buffer.from(hx(k('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')) + hx(k(d.domain.name)) + hx(k(d.domain.version)) + word(d.domain.chainId) + addrWord(d.domain.verifyingContract), 'hex'));
        const st = k(Buffer.from(hx(k('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)')) + addrWord(m.owner) + addrWord(m.spender) + word(m.value) + word(m.nonce) + word(m.deadline), 'hex'));
        digest = k(Buffer.concat([Buffer.from([0x19, 0x01]), Buffer.from(dom), Buffer.from(st)]));
      }
      const sig = secp.sign(digest, key.slice(2));
      return '0x' + sig.toCompactHex() + (27 + sig.recovery).toString(16);
    }
    return rpc(method, params);
  });
  await ctx.addInitScript(() => { window.ethereum = { request: ({ method, params }) => window.__wallet(method, params), on() {}, removeListener() {} }; });
  if (init) await ctx.addInitScript(init.fn, init.arg);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${e.message} @ ${(e.stack || '').split('\n').slice(1, 3).map((s) => s.trim()).join(' < ')}`));
  return { browser, ctx, page, errors, url: `http://${host}:${WEB}/lite/` };
}

let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };
const shot = (page, name) => SHOTS ? page.screenshot({ path: join(SHOTS, `lite-${name}.png`) }) : null;
async function step(name, fn) { if (!ONLY.has(name)) return; try { await fn(); } catch (e) { fails++; console.log('FAIL', name, '-', e.message.split('\n')[0]); } }
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || '', sel);
const until = (page, fn, arg, timeout = 60000) => page.waitForFunction(fn, arg, { timeout });

const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', FARM = '0x0000003bF4BA0B21f5e0d35119b337F4d4CF82E0';
const A0 = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', K0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const RECIPIENT = '0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a20';           // airdrop index 978
const tacOf = async (a) => BigInt(await rpc('eth_call', [{ to: TAC, data: '0x70a08231' + addrWord(a) }, 'latest']));
const stakedOf = async (a) => BigInt(await rpc('eth_call', [{ to: FARM, data: '0x98807d84' + addrWord(a) }, 'latest']));

const main = await openPage({ account: A0, key: K0 });
const { page, url } = main;

await step('airdrop', async () => {
  await rpc('anvil_impersonateAccount', [RECIPIENT]);
  await rpc('anvil_setBalance', [RECIPIENT, '0x' + (10n ** 18n).toString(16)]);
  const r = await openPage({ account: RECIPIENT });
  await r.page.goto(r.url + '#airdrop');
  await r.page.click('#air-connect');
  await r.page.waitForSelector('#air-claim', { timeout: 60000 });
  await r.page.click('#air-claim');
  await until(r.page, () => /Claimed\./.test(document.querySelector('#air-body')?.textContent || ''));
  await shot(r.page, 'airdrop');
  ok((await tacOf(RECIPIENT)) >= 216176408192580000000000n, 'airdrop: the allocation arrives');
  ok(/claimed/i.test(await text(r.page, '[data-foot="tac"]')), 'airdrop: the tile says claimed');
  await r.browser.close();
  await rpc('eth_sendTransaction', [{ from: RECIPIENT, to: TAC, data: '0xa9059cbb' + addrWord(A0) + word(1000n * 10n ** 18n) }]);
});

await step('pair', async () => {
  await page.goto(url + '#farm');
  await page.waitForSelector('#pf-connect, [data-pfm]', { timeout: 60000 });
  if (await page.$('#pf-connect')) await page.click('#pf-connect');
  await page.waitForSelector('[data-pfm="pair"]', { timeout: 60000 });
  await page.click('[data-pfm="pair"]');
  await page.fill('#pf-amt', '0.002');
  await until(page, () => !document.querySelector('#pf-go').disabled || /\S/.test(document.querySelector('#pf-status')?.textContent || ''));
  if (await page.isDisabled('#pf-go')) throw new Error(`the ETH + TAC deposit stayed disabled: ${await text(page, '#pf-status')} | ${await text(page, '#pf-rcpt')}`);
  const s0 = await stakedOf(A0), t0 = await tacOf(A0);
  await page.click('#pf-go');
  await until(page, () => /Staked/.test(document.querySelector('#toast-container')?.textContent || '') || /err/.test(document.querySelector('#pf-status')?.innerHTML || ''));
  ok((await stakedOf(A0)) > s0 && (await tacOf(A0)) < t0, `pair: ETH + TAC staked with a permit ${await text(page, '#pf-status')}`);
});

await step('farm', async () => {
  await page.goto(url + '#farm');
  await page.waitForSelector('#pf-connect, [data-pfm]', { timeout: 60000 });
  if (await page.$('#pf-connect')) await page.click('#pf-connect');
  await page.waitForSelector('[data-pfm="zap"]', { timeout: 60000 });
  await page.click('[data-pfm="zap"]');
  await page.fill('#pf-amt', '0.05');
  try { await page.waitForSelector('#pf-ackv', { timeout: 60000 }); } catch (e) {
    if (process.env.DEBUG) console.log('   farm state:', JSON.stringify(await page.evaluate(() => ({ amt: document.querySelector('#pf-amt')?.value, open: document.querySelector('.farm.open')?.dataset.farm, mode: document.querySelector('[data-pfm][aria-selected="true"]')?.dataset.pfm, rcpt: document.querySelector('#pf-rcpt')?.textContent.replace(/\s+/g, ' '), status: document.querySelector('#pf-status')?.textContent, go: document.querySelector('#pf-go')?.disabled }))));
    throw e;
  }
  ok(await page.isDisabled('#pf-go'), 'farm: a zap this size waits for its loss to be accepted');
  for (let i = 0; i < 5 && await page.isDisabled('#pf-go'); i++) {              // a requote can move the loss by a point
    // The pool's depth on the fork decides the gate: a tick box from 15% loss, a typed percent from 30%.
    if (await page.$eval('#pf-ackv', (x) => x.type === 'checkbox')) await page.check('#pf-ackv');
    else await page.fill('#pf-ackv', await page.$eval('.ack b', (b) => b.textContent));
    await sleep(1500);
    if (process.env.DEBUG) console.log('   ', JSON.stringify(await page.evaluate(() => ({ go: document.querySelector('#pf-go')?.disabled, ack: document.querySelector('#pf-ackv')?.value, b: document.querySelector('.ack b')?.textContent, mode: document.querySelector('[data-pfm][aria-selected="true"]')?.dataset.pfm, status: document.querySelector('#pf-status')?.textContent, rcpt: document.querySelector('#pf-rcpt')?.textContent }))));
  }
  ok(!(await page.isDisabled('#pf-go')), 'farm: typing the loss enables the zap');
  await shot(page, 'farm-zap');
  await page.click('#pf-go');
  await page.waitForSelector('#pf-exit', { timeout: 60000 });
  ok((await stakedOf(A0)) > 0n, 'farm: zapETH staked');
  await rpc('evm_increaseTime', [60]); await rpc('evm_mine', []);
  await page.evaluate(() => { location.hash = ''; location.hash = '#farm'; });
  await until(page, () => { const b = document.querySelector('#pf-claim'); return b && !b.disabled; });
  const before = await tacOf(A0);
  await page.click('#pf-claim');
  await until(page, () => /TAC claimed/.test(document.querySelector('#toast-container')?.textContent || ''));
  ok((await tacOf(A0)) > before, 'farm: claim pays TAC');
  await page.waitForSelector('#pf-exit');
  await page.click('#pf-exit');
  await until(page, () => /Withdrawn/.test(document.querySelector('#toast-container')?.textContent || '') || /err/.test(document.querySelector('#pf-status')?.innerHTML || ''));
  ok((await stakedOf(A0)) === 0n, `farm: withdraw all leaves nothing staked ${await text(page, '#pf-status')}`);
});

await step('buy', async () => {
  await page.goto(url + '#buy');
  if (await page.$('#buy-connect')) await page.click('#buy-connect');
  await page.waitForSelector('#b-amt');
  await page.fill('#b-amt', '0.0005');
  await until(page, () => !document.querySelector('#b-go').disabled, null, 240000);   // a cold fork makes the lens scan slow
  const t0 = await tacOf(A0);
  await page.click('#b-go');
  await until(page, () => /Bought|err/.test(document.querySelector('#b-status')?.innerHTML || ''));
  ok((await tacOf(A0)) > t0, `buy: TAC arrives ${await text(page, '#b-status')}`);
});

await step('v1', async () => {
  await page.goto(url + '#private');
  await page.waitForSelector('#eth-v1 [data-in="eth"]', { timeout: 60000 });
  await page.click('#eth-v1 [data-in="eth"]');
  await page.waitForSelector('#w-amt', { timeout: 120000 });
  await page.fill('#w-amt', '0.01');
  await until(page, () => !document.querySelector('#w-go').disabled);
  const n0 = submits.length;
  await page.click('#w-go');
  await until(page, () => /stubbed|failed|err/i.test(document.querySelector('#v1-status')?.innerHTML || ''), null, 1200000);   // two log walks on a cold fork
  ok(submits.slice(n0).some((s) => s.type === 'wrap'), `v1: the tipped deposit landed and its settle was submitted ${(await text(page, '#v1-status')).slice(0, 80)}`);
});

await step('device', async () => {
  await page.goto(url + '#device');
  if (await page.$('#eth-dev [data-in="eth"]')) await page.click('#eth-dev [data-in="eth"]');
  await page.waitForSelector('[data-chain="1"]', { timeout: 60000 });
  await page.click('[data-chain="1"]');
  await page.waitForSelector('#d-amt', { timeout: 60000 });
  await page.fill('#d-amt', '0.01');
  await page.click('#d-go');
  await until(page, () => /Deposited|err/.test(document.querySelector('#d-status')?.innerHTML || ''), null, 600000);
  await shot(page, 'device');
  ok(/Deposited/.test(await text(page, '#d-status')), `device: proved here and deposited ${(await text(page, '#d-status')).slice(0, 60)}`);
});

await step('borrow', async () => {
  await page.goto(url + '#borrow');
  await page.waitForSelector('#bw-lock, #borrow-body [data-in="eth"]', { timeout: 60000 });
  if (await page.$('#borrow-body [data-in="eth"]')) { await page.click('#borrow-body [data-in="eth"]'); await page.waitForSelector('#bw-lock', { timeout: 120000 }); }
  ok(/^bc1q/.test(await page.$eval('#borrow-body [data-copy]', (b) => b.dataset.copy)), 'borrow: the Bitcoin deposit address renders');
  const pub = await page.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('tacit-eth-identity-anchor:'))));
  await page.evaluate((p) => localStorage.setItem(`tacit-lite-cbtc-v1:${p}`, JSON.stringify({ lockTxid: 'aa'.repeat(32), lockVout: 1, vBtc: '20000', anchor: { txid: 'bb'.repeat(32), vout: 0 }, at: Date.now() })), pub);
  await page.evaluate(() => { location.hash = ''; location.hash = '#borrow'; });
  await page.waitForSelector('#bw-bond', { timeout: 120000 });
  await page.click('#bw-bond');
  await until(page, () => /Bond posted/.test(document.querySelector('#toast-container')?.textContent || '') || /err/.test(document.querySelector('#bw-status')?.innerHTML || ''));
  await shot(page, 'borrow');
  ok(/Bond posted/.test(await text(page, '#toast-container')), `borrow: the bond posts through the helper ${await text(page, '#bw-status')}`);
});

// The tacit1 address of a key, derived the way tacit.finance does (BIP-352 scan key, one root).
const { makeTacitAddress } = await import(new URL('../dapp/tacit-address.js', import.meta.url));
const { bip352TaggedHash } = await import(new URL('../dapp/bip352.js', import.meta.url));
function tacit1(hex) {
  const priv = Buffer.from(hex, 'hex');
  const scan = BigInt('0x' + Buffer.from(bip352TaggedHash('BIP0352/ScanKey', priv)).toString('hex')) % secp.CURVE.n;
  const pub = secp.getPublicKey(priv, true);
  return makeTacitAddress({ secp }).encodeTacitAddress({ network: 'mainnet', btcSpendPub: pub, btcScanPub: secp.getPublicKey(scan.toString(16).padStart(64, '0'), true), evmOwnerPub: pub });
}
const walletText = (p) => p.evaluate(() => document.querySelector('#wallet-body')?.textContent.replace(/\s+/g, ' ') || '');
// Open the wallet sheet by changing the hash; a navigation to the same URL would reload and drop the key.
const toWallet = (p) => p.evaluate(() => { location.hash = ''; location.hash = '#wallet'; });
const shown = async (p) => { await toWallet(p); await p.waitForSelector('#wallet-body .who, #wallet-body [data-in]', { timeout: 60000 }); return walletText(p); };
const lock = async (p) => { await toWallet(p); await p.waitForSelector('#w-lock', { timeout: 60000 }); await p.click('#w-lock'); await p.waitForSelector('#wallet-body [data-in]'); };
const addrIn = (txt) => (txt.match(/tacit1[0-9a-z]{8}…[0-9a-z]{12}/) || [''])[0];

await step('keys', async () => {
  const r = await openPage({ account: A0, key: K0 });
  await r.page.goto(r.url + '#wallet');
  await r.page.click('#wallet-body [data-in="eth"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  const txt = await shown(r.page);
  const addr = addrIn(txt);
  ok(/opened with Ethereum/.test(txt) && addr, `keys: an Ethereum signature opens ${addr}`);
  await lock(r.page);
  ok(/Continue as tacit1/.test(await walletText(r.page)), 'keys: once locked, the sheet offers to continue with the same wallet');
  await r.page.click('#wallet-body [data-in="known"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  ok((await shown(r.page)).includes(addr), 'keys: continuing reopens the same tacit1 address');
  await lock(r.page);
  const hex = 'c0ffee'.padEnd(64, '1');
  await r.page.click('#wallet-body [data-in="paste"]');
  await r.page.fill('#ws-hex', hex);
  await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  const t1 = tacit1(hex);
  ok((await shown(r.page)).includes(`${t1.slice(0, 14)}…${t1.slice(-12)}`), `keys: a pasted key opens its own tacit1 address ${t1.slice(0, 14)}…`);
  if (r.errors.length) { fails++; console.log('FAIL keys page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

await step('saved', async () => {
  const r = await openPage({ account: A0, key: K0 });
  await r.page.goto(r.url);
  await r.page.waitForSelector('#toast-container', { state: 'attached' });
  const hex = 'abcdef'.padEnd(64, '2'), pass = 'correct horse battery staple';
  // Save a key the way tacit.finance does, through its own module and prompt.
  const saving = r.page.evaluate(async (h) => { globalThis.__TACIT_NO_INIT__ = true; const T = await import('/tacit.js'); await T.wallet.setPriv(h); return !!localStorage.getItem('tacit-wallet-v1:mainnet'); }, hex);
  await r.page.waitForSelector('#pass-dialog[open] #pass-input-1', { timeout: 120000 });
  await r.page.fill('#pass-input-1', pass); await r.page.fill('#pass-input-2', pass); await r.page.click('#pass-submit');
  ok(await saving, 'saved: a passphrase-locked key is saved in this browser');
  await r.page.evaluate(() => { localStorage.setItem('tacit-active-mode-v1', 'local'); localStorage.removeItem('tacit-lite-id-v1'); });
  await r.page.goto(r.url + '#wallet'); await r.page.reload();
  await r.page.waitForSelector('#wallet-body [data-in="known"]', { timeout: 60000 });
  ok(/saved in this browser/.test(await walletText(r.page)), 'saved: the sheet offers the saved key');
  await r.page.click('#wallet-body [data-in="known"]');
  await r.page.waitForSelector('#pass-dialog[open] #pass-input-1', { timeout: 120000 });
  await r.page.fill('#pass-input-1', pass); await r.page.click('#pass-submit');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'), null, 120000);
  const t1 = tacit1(hex);
  ok((await shown(r.page)).includes(`${t1.slice(0, 14)}…${t1.slice(-12)}`), 'saved: the passphrase opens the same key tacit.finance saved');
  ok(await r.page.evaluate(() => localStorage.getItem('tacit-active-mode-v1') === 'local'), 'saved: tacit.finance\'s own wallet choice is left as it was');
  if (r.errors.length) { fails++; console.log('FAIL saved page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

await step('bitcoin', async () => {
  // A UniSat stand-in with a real key: deterministic ECDSA, so enrolment's two signatures agree.
  const bk = '11'.repeat(32);
  const r = await openPage({ account: A0, key: K0, init: { arg: { bk }, fn: ({ bk }) => {
    const sent = [];
    window.__sent = sent;
    window.unisat = {
      requestAccounts: async () => ['bc1qtestaddress0000000000000000000000000000'], getAccounts: async () => ['bc1qtestaddress0000000000000000000000000000'],
      getPublicKey: async () => '02' + bk.slice(0, 64 - 2).padEnd(64, '0'), getNetwork: async () => 'livenet', on() {}, removeListener() {},
      signMessage: async (msg, type) => { const d = new TextEncoder().encode(bk + '|' + type + '|' + msg); const h = await crypto.subtle.digest('SHA-256', d); return btoa(String.fromCharCode(...new Uint8Array(h), ...new Uint8Array(h), 1)); },
      sendBitcoin: async (to, sats) => { sent.push([to, sats]); return 'ab'.repeat(32); },
    };
  } } });
  await r.page.goto(r.url + '#wallet');
  await r.page.click('#wallet-body [data-in="btc"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'), null, 120000);
  const txt = await shown(r.page);
  ok(/opened with Bitcoin bc1qte/.test(txt), `bitcoin: a Bitcoin wallet's signature opens a key (${addrIn(txt)})`);
  await lock(r.page);
  await r.page.click('#wallet-body [data-in="known"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'), null, 120000);
  ok((await shown(r.page)).includes(addrIn(txt) || '?'), 'bitcoin: signing in again opens the same key');
  await r.page.evaluate(() => { location.hash = '#borrow'; });
  await r.page.waitForSelector('#bw-amt', { timeout: 120000 });
  await r.page.fill('#bw-amt', '0.0002');
  await r.page.click('#bw-fund');
  await until(r.page, () => (window.__sent || []).length > 0 || /err/.test(document.querySelector('#bw-status')?.innerHTML || ''), null, 60000);
  const sent = await r.page.evaluate(() => window.__sent);
  const deposit = await r.page.$eval('#borrow-body [data-copy]', (b) => b.dataset.copy);
  ok(sent.length === 1 && sent[0][0] === deposit && sent[0][1] >= 21000, `bitcoin: one popup funds the deposit address with ${sent[0]?.[1]} sats, the lock and its fees`);
  if (r.errors.length) { fails++; console.log('FAIL bitcoin page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

await step('passkey', async () => {
  const r = await openPage({ account: A0, key: K0, host: 'localhost' });
  const cdp = await r.ctx.newCDPSession(r.page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  await r.page.goto(r.url + '#wallet');
  await r.page.click('#wallet-body [data-in="new"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'), null, 60000);
  const txt = await shown(r.page), addr = addrIn(txt);
  ok(/opened with passkey/.test(txt) && addr, `passkey: a new passkey wallet opens ${addr}`);
  ok(await r.page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('tacit-prf-v1') || '{}')).length === 1), 'passkey: tacit.finance\'s passkey list gains the wallet');
  await lock(r.page);
  await r.page.click('#wallet-body [data-in="passkey"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'), null, 60000);
  ok((await shown(r.page)).includes(addr), 'passkey: signing in with it opens the same key');
  if (r.errors.length) { fails++; console.log('FAIL passkey page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});

const { makeEvmAccount } = await import(new URL('../dapp/evm-account.js', import.meta.url));
const balOf = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));
const go = (p, h) => p.evaluate((x) => { location.hash = ''; location.hash = x; }, h);
let ACCT = null;
await step('acct', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'feed'.padEnd(64, '3');
  const want = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await r.page.goto(r.url + '#wallet');
  await r.page.click('#wallet-body [data-in="paste"]');
  await r.page.fill('#ws-hex', hex);
  await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  // tacit.finance's pool module, loaded on its own, derives the same account from the same key.
  const viaUx = await r.page.evaluate(async (h) => {
    const d = await import('/vendor/tacit-deps.min.js'), dep = await import('/confidential-deployments.js');
    dep.setActiveNetwork('mainnet');
    const { makeConfidentialPoolUx } = await import('/confidential-pool-ux.js');
    return makeConfidentialPoolUx({ secp: d.secp, keccak256: d.keccak_256, sha256: d.sha256, network: 'mainnet' }).account(d.hexToBytes(h)).address;
  }, hex);
  await toWallet(r.page);
  await r.page.waitForSelector('#ac-form [data-copy]', { timeout: 60000 });
  const shownAddr = await r.page.$eval('#ac-form [data-copy]', (b) => b.dataset.copy);
  ok(shownAddr === want && viaUx === want, `acct: the Tacit account is the key's own, as tacit.finance derives it (${want.slice(0, 10)}…, pool-ux ${viaUx.slice(0, 10)}…)`);
  ok(await r.page.$eval('[data-pay="tacit"]', (b) => b.classList.contains('main')), 'acct: with no wallet connected, the Tacit account pays');
  await rpc('anvil_setBalance', [want, '0x' + (10n ** 17n).toString(16)]);             // funded from outside, as an exchange would

  await go(r.page, '#buy');
  await r.page.waitForSelector('#b-amt', { timeout: 60000 });
  ok(/Tacit account/.test(await text(r.page, '#b-max')), 'acct: the pay line names the Tacit account');
  await r.page.fill('#b-amt', '0.001');
  await until(r.page, () => !document.querySelector('#b-go').disabled, null, 240000);
  await r.page.click('#b-go');
  await until(r.page, () => /Bought|err/.test(document.querySelector('#b-status')?.innerHTML || ''), null, 120000);
  ok((await tacOf(want)) > 0n, `acct: Buy signs from the Tacit account, no wallet asked ${await text(r.page, '#b-status')}`);

  await go(r.page, '#farm');
  await r.page.waitForSelector('[data-pfm="pair"]', { timeout: 60000 });
  await r.page.click('[data-pfm="pair"]');
  await r.page.fill('#pf-amt', '0.0002');
  await until(r.page, () => !document.querySelector('#pf-go').disabled || /\S/.test(document.querySelector('#pf-status')?.textContent || ''), null, 60000);
  if (await r.page.isDisabled('#pf-go')) throw new Error(`the ETH + TAC deposit stayed disabled: ${await text(r.page, '#pf-rcpt')}`);
  await r.page.click('#pf-go');
  await until(r.page, () => /Staked/.test(document.querySelector('#toast-container')?.textContent || '') || /err/.test(document.querySelector('#pf-status')?.innerHTML || ''), null, 120000);
  ok((await stakedOf(want)) > 0n, `acct: ETH + TAC staked with a permit the Tacit account signed ${await text(r.page, '#pf-status')}`);

  const OUT = '0x1111111111111111111111111111111111111111', o0 = await balOf(OUT);
  await toWallet(r.page);
  await r.page.waitForSelector('[data-wal="out"]');
  await r.page.click('[data-wal="out"]');
  await r.page.fill('#ac-to', OUT); await r.page.fill('#ac-mv', '0.01');
  await r.page.click('#ac-go');
  await until(r.page, () => /Sent\.|err/.test(document.querySelector('#ac-status')?.innerHTML || ''), null, 120000);
  ok((await balOf(OUT)) - o0 === 10n ** 16n, `acct: Send out pays from the Tacit account ${await text(r.page, '#ac-status')}`);

  await r.page.click('[data-pay="wallet"]');                                              // connects the stub wallet
  await until(r.page, () => document.querySelector('[data-pay="wallet"]')?.classList.contains('main'));
  await r.page.click('[data-pay="tacit"]');
  await until(r.page, () => document.querySelector('[data-pay="tacit"]')?.classList.contains('main'));
  ok(true, 'acct: with a wallet connected either account can be chosen to pay');
  await r.page.click('[data-wal="add"]');
  await r.page.waitForSelector('#ac-go');
  const a0 = await balOf(want);
  await r.page.fill('#ac-mv', '0.02');
  await r.page.click('#ac-go');
  await until(r.page, () => /Added\.|err/.test(document.querySelector('#ac-status')?.innerHTML || ''), null, 120000);
  ok((await balOf(want)) - a0 === 2n * 10n ** 16n, `acct: Add from wallet tops the Tacit account up ${await text(r.page, '#ac-status')}`);
  if (r.errors.length) { fails++; console.log('FAIL acct page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  ACCT = { r, want };
});

await step('devmove', async () => {
  if (!ACCT) throw new Error('needs the acct scenario first');
  const { r } = ACCT, st = () => text(r.page, '#d-status');
  await go(r.page, '#device');
  await r.page.waitForSelector('[data-chain="1"]', { timeout: 60000 });
  await r.page.click('[data-chain="1"]');
  await r.page.waitForSelector('#d-amt', { timeout: 60000 });
  await r.page.fill('#d-amt', '0.01');
  await r.page.click('#d-go');
  await until(r.page, () => /Deposited|err/.test(document.querySelector('#d-status')?.innerHTML || ''), null, 600000);
  ok(/Deposited/.test(await st()), `devmove: the Tacit account deposits, proved here ${(await st()).slice(0, 60)}`);

  await r.page.click('[data-dev="receive"]');
  await r.page.waitForSelector('#d-form [data-copy]', { timeout: 60000 });
  const box = (await r.page.$$eval('#d-form [data-copy]', (bs) => bs.map((b) => b.dataset.copy)))[1];
  await rpc('eth_sendTransaction', [{ from: A0, to: box, value: '0x' + (10n ** 15n).toString(16) }]);   // under the keeper's minimum
  await r.page.click('[data-dev="send"]'); await r.page.click('[data-dev="receive"]');
  await r.page.waitForSelector('#d-sweep', { timeout: 60000 });
  await r.page.click('#d-sweep');
  await until(r.page, () => /Swept in|err/.test(document.querySelector('#d-status')?.innerHTML || ''), null, 600000);
  ok(/Swept in/.test(await st()) && (await balOf(box)) === 0n, `devmove: a small arrival is swept in from this device ${(await st()).slice(0, 60)}`);

  await r.page.click('[data-dev="out"]');
  await r.page.click('[data-dest="v1"]');
  await r.page.fill('#d-amt', '0.002');
  const n0 = submits.length, k0 = relays.length;
  await r.page.click('#d-go');
  await until(r.page, () => /Moved|stubbed|failed|err/i.test(document.querySelector('#d-status')?.innerHTML || ''), null, 1200000);
  const rel = relays.slice(k0).find((b) => b.wrap);
  const landed = !!rel?.txHash && (await rpc('eth_getTransactionReceipt', [rel.txHash]))?.status === '0x1';
  ok(rel && BigInt(rel.wrap.amount) === 2n * 10n ** 15n && landed && submits.slice(n0).some((s) => s.type === 'wrap'),
    `devmove: pool ETH moves into V1 in one relayed withdrawToV1, then its note settle is submitted ${(await st()).slice(0, 60)}`);

  await r.page.click('[data-dest="8453"]');
  await r.page.fill('#d-amt', '0.001');
  const k1 = relays.length;
  await r.page.click('#d-go');
  await until(r.page, () => /On its way|stubbed|err/i.test(document.querySelector('#d-status')?.innerHTML || ''), null, 600000);
  ok(relays.slice(k1).some((b) => b.call), `devmove: a move to Base asks the relayer for its bridge call ${(await st()).slice(0, 60)}`);
  if (r.errors.length) { fails++; console.log('FAIL devmove page errors: ' + r.errors.slice(0, 3).join(' | ')); }
});
await step('btc', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'b17c'.padEnd(64, '5');
  await r.page.goto(r.url + '#wallet');
  await r.page.click('#wallet-body [data-in="paste"]');
  await r.page.fill('#ws-hex', hex);
  await r.page.click('#wallet-body [data-in="key"]');
  await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
  await go(r.page, '#btc');
  await until(r.page, () => /^\d/.test(document.querySelector('#btc-body .bal .v')?.textContent || '') || /err/.test(document.querySelector('#btc-body')?.innerHTML || ''), null, 180000);
  ok(/^0(\.0+)?$/.test((await text(r.page, '#btc-body .bal .v')).trim()), `btc: an empty key reads 0 BTC through tacit.js (${(await text(r.page, '#btc-body .bal .v')).trim()})`);
  const route = async (to, want) => {
    await r.page.fill('#bt-to', to); await r.page.fill('#bt-amt', '0.0001');
    await until(r.page, () => !document.querySelector('#bt-rcpt').hidden, null, 60000);
    await sleep(400);
    return (await text(r.page, '#bt-rcpt')).replace(/\s+/g, ' ');
  };
  const t1 = tacit1(hex);
  ok(/Silent payment/.test(await route(t1, 'sp')), 'btc: BTC to a tacit1 address goes as a silent payment');
  ok(/Plain payment/.test(await route('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'addr')), 'btc: BTC to a bc1 address is a plain payment');
  ok(/Ethereum address/.test(await route(A0, 'err')), 'btc: an Ethereum address is refused with a reason');
  ok(/More than you hold/.test(await text(r.page, '#bt-rcpt')) || await r.page.isDisabled('#bt-go'), 'btc: an unfunded key cannot send');
  // BTC to a tacit1 is a silent payment to its Bitcoin lane: the wallet's version-0 silent-payment keys, which tacit.js
  // still scans (SP_KEY_VERSIONS) beside the version-1 address it shows.
  await r.page.click('[data-btcm="receive"]');
  await until(r.page, () => [...document.querySelectorAll('#btc-form [data-copy]')].some((b) => /^sp1/.test(b.dataset.copy)), null, 60000);
  const shown = await r.page.$$eval('#btc-form [data-copy]', (bs) => bs.map((b) => b.dataset.copy).find((v) => /^sp1/.test(v)));
  const [fromT1, v0, scanned] = await r.page.evaluate(async ([a, h]) => {
    const T = await import([...document.scripts].map((x) => x.textContent).join('').match(/\/tacit\.js\?cb=[0-9a-f]+/)[0]);   // the instance the page loaded
    const d = await import('/vendor/tacit-deps.min.js'), { makeTacitAddress } = await import('/tacit-address.js');
    const { lanes } = makeTacitAddress({ secp: d.secp }).decodeTacitAddress(a);
    const enc = (k) => T.encodeSilentPaymentAddress({ scanPub: k.scanPub, spendPub: k.spendPub, network: 'mainnet' });
    return [enc(lanes.btc), enc(T.deriveWalletSilentPaymentKeys(d.hexToBytes(h), 0)), T.SP_KEY_VERSIONS];
  }, [t1, hex]);
  ok(fromT1 === v0 && scanned.includes(0) && /^sp1/.test(shown || ''), `btc: BTC to a tacit1 lands on silent-payment keys this wallet scans (${fromT1.slice(0, 12)}…, versions ${scanned})`);
  await r.page.fill('#bt-chk', '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b');
  await r.page.click('#bt-chk-go');
  await until(r.page, () => /not addressed|not found|not indexed/.test(document.querySelector('#btc-status')?.textContent || ''), null, 120000);
  ok(true, `btc: a payment link is checked against this key (${(await text(r.page, '#btc-status')).trim().slice(0, 50)})`);
  if (r.errors.length) { fails++; console.log('FAIL btc page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
});
const WNS = '0x0000000000696760E15f265e828DB644A0c242EB';
const namehash = (n) => n.split('.').reverse().reduce((node, l) => Buffer.from(keccak_256(Buffer.concat([node, Buffer.from(keccak_256(Buffer.from(l)))]))), Buffer.alloc(32)).toString('hex');
const abiStr = (x) => { const b = Buffer.from(x).toString('hex'); return word(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, '0'); };
const readStr = (h) => { const d = h.replace(/^0x/, ''); const len = parseInt(d.slice(64, 128), 16); return Buffer.from(d.slice(128, 128 + len * 2), 'hex').toString(); };
await step('pts', async () => {
  await rpc('anvil_impersonateAccount', [RECIPIENT]);
  await rpc('anvil_setBalance', [RECIPIENT, '0x' + (10n ** 18n).toString(16)]);
  const r = await openPage({ account: RECIPIENT });
  await r.page.goto(r.url + '#pts');
  await r.page.click('#pts-connect');
  await until(r.page, () => !!document.querySelector('#pts-body .pt'), null, 120000);
  if (await r.page.$('[data-claim]')) {
    const t0 = await tacOf(RECIPIENT);
    await r.page.click('[data-claim]');
    await until(r.page, () => /Claimed|err/.test(document.querySelector('#pts-status')?.innerHTML || ''), null, 120000);
    ok((await tacOf(RECIPIENT)) > t0, `pts: a points reward claims to its own address ${await text(r.page, '#pts-status')}`);
  } else ok(true, 'pts: nothing is waiting for this address on the fork');
  if (r.errors.length) { fails++; console.log('FAIL pts page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  await r.browser.close();
  const w = await openPage({ account: A0, key: K0 });
  const hex = 'a11ce'.padEnd(64, '7'), acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await rpc('anvil_setBalance', [acct, '0x' + (10n ** 17n).toString(16)]);
  await w.page.goto(w.url + '#wallet');
  await w.page.click('#wallet-body [data-in="paste"]');
  await w.page.fill('#ws-hex', hex);
  await w.page.click('#wallet-body [data-in="key"]');
  await until(w.page, () => !!document.querySelector('#wallet-dot.on'));
  await go(w.page, '#pts');
  await w.page.waitForSelector('#wei-name', { timeout: 60000 });
  const label = 'tacitlite' + Date.now().toString(36);
  await w.page.fill('#wei-name', label);
  await until(w.page, () => !document.querySelector('#wei-go').disabled, null, 60000);
  await w.page.click('#wei-go');
  await until(w.page, () => /pays you privately|err/.test(document.querySelector('#pts-status')?.innerHTML || ''), null, 300000);
  const node = namehash(label + '.wei');
  const owner = await rpc('eth_call', [{ to: WNS, data: '0x6352211e' + node }, 'latest']).catch(() => '0x');
  const rec = readStr(await rpc('eth_call', [{ to: WNS, data: '0x59d1d43c' + node + word(64) + abiStr('finance.tacit') }, 'latest']).catch(() => '0x'));
  ok(owner.slice(-40) === acct.slice(2) && rec === tacit1(hex), `pts: ${label}.wei registers to the Tacit account through zRouter and carries its tacit1 (${await text(w.page, '#pts-status')})`);
  if (w.errors.length) { fails++; console.log('FAIL pts page errors: ' + w.errors.slice(0, 3).join(' | ')); }
  await w.browser.close();
});
if (ACCT) await ACCT.r.browser.close();

if (main.errors.length) { fails++; console.log('FAIL page errors:\n  ' + main.errors.slice(0, 8).join('\n  ')); }
console.log(fails ? `${fails} failed` : 'all passed');
await main.browser.close(); server.close(); anvil.kill('SIGKILL');
process.exit(fails ? 1 : 0);
