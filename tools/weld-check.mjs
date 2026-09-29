// Checks dapp/weld/index.html in a real browser against an anvil fork of Ethereum: public RPC hosts are routed to
// the fork and window.ethereum is an EIP-1193 stub that sends as the chosen account (anvil's first key, or an
// impersonated one). The relay's submit and the EVM-pool keepers are stubbed, so nothing reaches a live service.
//   airdrop  a listed recipient claims its TAC; the tile updates
//   links    friendly links open the right sheet and tab (#swap, #points, #earn), the address bar follows the tab, and
//            every sheet has a copy-link button
//   apr      every farm row shows its APR now, and the public farm's card spells it out
//   pair     ETH + TAC staked in one transaction with an EIP-2612 permit
//   farm     a one-sided ETH zap waits for its typed loss acceptance, stakes, claims, then withdraws everything
//   buy      TAC bought with ETH through zRouter
//   tacfarm  TAC alone zapped in with a permit; half withdrawn as ETH; LP held staked again; the rest withdrawn as TAC
//   sell     TAC sold for ETH through zRouter in one transaction, the permit riding as its first leg
//   v1       the identity signature unlocks the key; a tipped wrap lands and its settle is submitted
//   devsend  the EVM pool's Send takes a bp1… pool address (a private send) or an 0x… address (a withdrawal to it)
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
//   csend    the Borrow sheet's Send: private cUSD/cBTC (notes stubbed into the balance) go privately to a tacit1 address
//            or out as tacUSD to an 0x… address, with fees shown first and an amount over the balance refused
//   btc      a pasted key's Bitcoin sheet: balances read, BTC routes (tacit1 and sp1 as silent payments, bc1 plain), TAC
//            routes refuse plain addresses, a tacit1's silent-payment keys are the ones this wallet scans, a payment link checks
//   activity relayed jobs (dispatched as tacit:job, as the relay client does) move Queued → Proving → Done or Failed, with
//            toasts and Etherscan links; a transaction the page sends is followed to its receipt; after a reload the list
//            is still there, a job left proving is followed to its settle, a failure from the last six hours is asked
//            about again and flips to done, an older one is not; a system notification goes out only while hidden
//   dash     the "your Tacit" dashboard: the first paint at phone width has no sideways scroll; a connected wallet's
//            dashboard shows placeholders first, then values, and what changed since the last visit's snapshot
//   tacdeposit  a real 20 TAC deposit whose settle never landed: the TAC sheet and the dashboard offer to finish it,
//            and Finish submits a wrap job rebuilt with the TAC asset and its own scale
//   PLAYWRIGHT=<path to playwright-core> node tools/weld-check.mjs [scenario,…] [fork rpc]   (SHOTS=<dir> saves screenshots)

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
const ONLY = new Set((process.argv[2] || 'airdrop,links,apr,pair,farm,buy,tacfarm,sell,v1,devsend,device,borrow,bonds,mainbond,locks,repay,csend,keys,saved,bitcoin,passkey,acct,devmove,btc,pts,activity,receipts,stats,dash,tacdeposit').split(','));
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
const fromJsonText = (t) => JSON.parse(t || 'null');
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

async function openPage({ account, key = null, host = '127.0.0.1', init = null, viewport = { width: 1280, height: 900 }, colorScheme = 'light' }) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme });
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
    // A live API that does not answer is the page's to report, as it would be for a user; the run goes on.
    try {
      const r = await fetch('https://api.tacit.finance' + u.pathname + u.search, { method: route.request().method(), headers: { 'content-type': 'application/json' }, body: route.request().method() === 'GET' ? undefined : route.request().postData(), signal: AbortSignal.timeout(60000) });
      return route.fulfill({ status: r.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await r.text() });
    } catch (e) {
      return route.fulfill({ status: 502, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: `the live API did not answer: ${e.message}` }) });
    }
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
  return { browser, ctx, page, errors, url: `http://${host}:${WEB}/weld/` };
}

let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };
const shot = (page, name) => SHOTS ? page.screenshot({ path: join(SHOTS, `weld-${name}.png`) }) : null;
async function step(name, fn) { if (!ONLY.has(name)) return; try { await fn(); } catch (e) { fails++; console.log('FAIL', name, '-', e.message.split('\n')[0]); } }
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || '', sel);
const until = (page, fn, arg, timeout = 60000) => page.waitForFunction(fn, arg, { timeout });

const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', FARM = '0x0000003bF4BA0B21f5e0d35119b337F4d4CF82E0';
const A0 = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', K0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const RECIPIENT = '0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a20';           // airdrop index 978
const tacOf = async (a) => BigInt(await rpc('eth_call', [{ to: TAC, data: '0x70a08231' + addrWord(a) }, 'latest']));
const stakedOf = async (a) => BigInt(await rpc('eth_call', [{ to: FARM, data: '0x98807d84' + addrWord(a) }, 'latest']));
const allowanceOf = async (token, owner, spender) => BigInt(await rpc('eth_call', [{ to: token, data: '0xdd62ed3e' + addrWord(owner) + addrWord(spender) }, 'latest']));
const ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4', RESERVE = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
// TAC for a scenario that runs on its own, sent from the reserve (the ops multisig) on the fork.
async function fundTac(to, amount) {
  await rpc('anvil_impersonateAccount', [RESERVE]); await rpc('anvil_setBalance', [RESERVE, '0x' + (10n ** 18n).toString(16)]);
  await rpc('eth_sendTransaction', [{ from: RESERVE, to: TAC, data: '0xa9059cbb' + addrWord(to) + word(amount) }]);
  await rpc('anvil_stopImpersonatingAccount', [RESERVE]);
}
// Wait for a button to enable, accepting the loss gate beside it if the pool's depth puts one up.
async function acceptLoss(page, goSel, ackSel) {
  await until(page, ([g, a]) => { const b = document.querySelector(g); return (b && !b.disabled) || !!document.querySelector(a); }, [goSel, ackSel], 240000);
  for (let i = 0; i < 6 && await page.isDisabled(goSel); i++) {
    if (await page.$(ackSel)) {
      if (await page.$eval(ackSel, (x) => x.type === 'checkbox')) await page.check(ackSel);
      else await page.fill(ackSel, await page.$eval(ackSel, (x) => x.closest('.ack').querySelector('b').textContent));
    }
    await sleep(1500);
  }
}
// Chain state, polled, is the check: a toast from an earlier step can still be on screen.
async function chainUntil(fn, ms = 240000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(1500); } return false; }
const toastSays = (page, re) => until(page, (r) => new RegExp(r).test(document.querySelector('#toast-container')?.textContent || '') || /class="err"/.test(document.querySelector('#pf-status')?.innerHTML || ''), re.source, 240000);

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

await step('links', async () => {
  await page.goto(url + '#swap');
  await page.waitForSelector('#sheet-tac[open] [data-tac-mode="buy"][aria-selected="true"]', { timeout: 60000 });
  ok(true, 'links: #swap opens TAC on Buy');
  await page.click('[data-tac-mode="sell"]');
  ok((await page.evaluate(() => location.hash)) === '#sell', 'links: the address bar follows the tab (#sell)');
  await shot(page, 'links-sell');
  await page.goto(url + '#points');
  await page.waitForSelector('#sheet-pts[open]', { timeout: 60000 });
  await page.goto(url + '#earn');
  await page.waitForSelector('#sheet-farm[open]', { timeout: 60000 });
  const shares = await page.$$eval('dialog.sheet:not(.layer) .sheet-head .x.share', (b) => b.length);
  const sheets = await page.$$eval('dialog.sheet:not(.layer)', (d) => d.length);
  ok(shares === sheets && sheets >= 6, `links: every sheet has a copy-link button (${shares}/${sheets})`);
});

await step('apr', async () => {
  await page.goto(url + '#farm');
  await page.waitForSelector('#pf-connect, [data-pfm]', { timeout: 60000 });
  if (await page.$('#pf-connect')) await page.click('#pf-connect');
  await until(page, () => /APR now\s*(about [\d,]+%|over 100,000%)/.test(document.querySelector('#farm-precision')?.textContent || ''), null, 120000);
  const rows = await page.$$eval('.farm .rate', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  const card = await page.$eval('#farm-precision', (e) => e.textContent.replace(/\s+/g, ' '));
  console.log('   rows:', rows.join(' | '));
  console.log('   card:', (card.match(/APR now[^.]*\./) || [''])[0]);
  ok(rows.length >= 2 && rows.every((r) => /APR/.test(r)) && /APR now\s*(about [\d,]+%|over 100,000%)/.test(card), 'apr: every farm shows its APR now, the public card in full');
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
  await page.waitForSelector('[data-pfm="eth"]', { timeout: 60000 });
  await page.click('[data-pfm="eth"]');
  // The pool's depth at the fork block decides how big a zap crosses the loss gate: the size grows until it asks.
  let gated = false;
  for (const amt of ['0.05', '0.5', '2', '8']) {
    await page.fill('#pf-amt', amt);
    if ((gated = await page.waitForSelector('#pf-ackv', { timeout: 20000 }).then(() => true, () => false))) break;
  }
  if (!gated) {
    if (process.env.DEBUG) console.log('   farm state:', JSON.stringify(await page.evaluate(() => ({ amt: document.querySelector('#pf-amt')?.value, open: document.querySelector('.farm.open')?.dataset.farm, mode: document.querySelector('[data-pfm][aria-selected="true"]')?.dataset.pfm, rcpt: document.querySelector('#pf-rcpt')?.textContent.replace(/\s+/g, ' '), status: document.querySelector('#pf-status')?.textContent, go: document.querySelector('#pf-go')?.disabled }))));
    throw new Error('farm: no zap size up to 8 ETH asked for its loss to be accepted');
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

await step('tacfarm', async () => {
  if ((await tacOf(A0)) < 100n * 10n ** 18n) await fundTac(A0, 1000n * 10n ** 18n);
  await page.goto(url + '#farm');
  await page.waitForSelector('#pf-connect, [data-pfm]', { timeout: 60000 });
  if (await page.$('#pf-connect')) await page.click('#pf-connect');
  await page.waitForSelector('[data-pfm="tac"]', { timeout: 60000 });
  await page.click('[data-pfm="tac"]');
  await page.fill('#pf-tac', '20');
  await acceptLoss(page, '#pf-go', '#pf-ackv');
  const s0 = await stakedOf(A0), t0 = await tacOf(A0);
  await page.click('#pf-go');
  await chainUntil(async () => (await stakedOf(A0)) > s0);
  ok((await stakedOf(A0)) > s0 && t0 - (await tacOf(A0)) <= 20n * 10n ** 18n, `tacfarm: TAC alone staked with a permit ${await text(page, '#pf-status')}`);
  ok((await allowanceOf(TAC, A0, FARM)) === 0n, 'tacfarm: the permit leaves no allowance behind');
  await page.waitForSelector('[data-pfp="50"]');
  await page.click('[data-pfp="50"]'); await page.click('[data-pfr="eth"]');
  await acceptLoss(page, '#pf-exit', '#pf-outv');
  const st1 = await stakedOf(A0), tac1 = await tacOf(A0);
  await page.click('#pf-exit');
  await chainUntil(async () => (await stakedOf(A0)) < st1);
  const st2 = await stakedOf(A0);
  ok(st2 > 0n && st2 * 2n >= st1 - 1n && st2 * 2n <= st1 + 1n && (await tacOf(A0)) <= tac1, `tacfarm: half withdrawn as ETH, half still staked ${await text(page, '#pf-status')}`);
  await rpc('eth_sendTransaction', [{ from: A0, to: FARM, data: '0x2e1a7d4d' + word(st2 / 2n) }]);   // withdraw(shares): LP held, not staked
  await page.evaluate(() => { location.hash = ''; location.hash = '#farm'; });
  await page.waitForSelector('#pf-stake', { timeout: 60000 });
  await page.click('#pf-stake');
  await chainUntil(async () => (await stakedOf(A0)) === st2);
  ok((await stakedOf(A0)) === st2, `tacfarm: LP held is staked again with a permit ${await text(page, '#pf-status')}`);
  await page.waitForSelector('[data-pfp="100"]');
  await page.click('[data-pfp="100"]'); await page.click('[data-pfr="tac"]');
  await acceptLoss(page, '#pf-exit', '#pf-outv');
  const tac2 = await tacOf(A0);
  await page.click('#pf-exit');
  await chainUntil(async () => (await stakedOf(A0)) === 0n);
  ok((await stakedOf(A0)) === 0n && (await tacOf(A0)) > tac2, `tacfarm: exit all as TAC leaves nothing staked ${await text(page, '#pf-status')}`);
});

await step('sell', async () => {
  // A fresh EOA: the anvil keys carry sweeper code on mainnet, which forwards ETH on before a router can count it.
  const key = '0x' + Buffer.from(secp.utils.randomPrivateKey()).toString('hex');
  const who = '0x' + Buffer.from(keccak_256(secp.getPublicKey(key.slice(2), false).slice(1)).slice(12)).toString('hex');
  await rpc('anvil_impersonateAccount', [who]); await rpc('anvil_setBalance', [who, '0x' + (10n ** 17n).toString(16)]);
  await fundTac(who, 100n * 10n ** 18n);
  const r = await openPage({ account: who, key });
  try {
    await r.page.goto(r.url + '#sell');
    await r.page.waitForSelector('#sell-connect, #s-amt', { timeout: 60000 });
    if (await r.page.$('#sell-connect')) await r.page.click('#sell-connect');
    await r.page.waitForSelector('#s-amt');
    await r.page.fill('#s-amt', '25');
    await acceptLoss(r.page, '#s-go', '#s-ackv');
    const e0 = BigInt(await rpc('eth_getBalance', [who, 'latest'])), n0 = BigInt(await rpc('eth_getTransactionCount', [who, 'latest']));
    await r.page.click('#s-go');
    await until(r.page, () => /Sold|class="err"/.test(document.querySelector('#s-status')?.innerHTML || ''), null, 240000);
    ok((await tacOf(who)) === 75n * 10n ** 18n, `sell: 25 TAC sold ${await text(r.page, '#s-status')}`);
    ok(BigInt(await rpc('eth_getTransactionCount', [who, 'latest'])) === n0 + 1n && (await allowanceOf(TAC, who, ZROUTER)) === 0n, 'sell: one transaction, the permit riding inside it, no allowance left');
    ok(BigInt(await rpc('eth_getBalance', [who, 'latest'])) > e0, 'sell: ETH arrives, net of gas');
  } finally { await r.browser.close(); await rpc('anvil_stopImpersonatingAccount', [who]); }
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

await step('devsend', async () => {
  await page.goto(url + '#device');
  if (await page.$('#eth-dev [data-in="eth"]')) await page.click('#eth-dev [data-in="eth"]');
  await page.waitForSelector('[data-dev="send"]', { timeout: 60000 });
  await page.click('[data-dev="receive"]');
  await page.waitForSelector('#d-form [data-copy]', { timeout: 120000 });
  const bp1 = await page.$eval('#d-form [data-copy]', (b) => b.dataset.copy);
  await page.click('[data-dev="send"]');
  await page.waitForSelector('#d-to');
  await page.fill('#d-to', '0x000000000000000000000000000000000000beef');
  ok(/Send to this address/.test(await text(page, '#d-go')) && /leaves the pool/.test(await text(page, '#d-to-note')), 'devsend: an 0x… address is paid by a withdrawal to it');
  await page.fill('#d-to', bp1);
  ok(/^bp1/.test(bp1) && /Send privately/.test(await text(page, '#d-go')) && /inside the pool/.test(await text(page, '#d-to-note')), 'devsend: a bp1… pool address is paid privately');
});

await step('device', async () => {
  await page.goto(url + '#device');
  if (await page.$('#eth-dev [data-in="eth"]')) await page.click('#eth-dev [data-in="eth"]');
  await page.waitForSelector('[data-chain="1"]', { timeout: 60000 });
  await page.click('[data-chain="1"]');
  await page.waitForSelector('#d-amt', { timeout: 60000 });
  // DEV.mode (the sub-tab) persists across sheet reopens, a deliberate feature: a scenario run right after devsend
  // (which leaves it on Send) must not inherit that here.
  await page.click('[data-dev="deposit"]');
  await page.waitForFunction(() => /Deposit/.test(document.querySelector('#d-go')?.textContent || ''));
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
  const lag = await page.$eval('#borrow-body', (e) => (e.textContent.match(/It is at block [\d,]+, [\d,]+ behind Bitcoin( and catching up)?\./) || [''])[0]);
  ok(/at block [\d,]+, [\d,]+ behind Bitcoin/.test(lag), `borrow: before a lock, it says how far behind Bitcoin's proof is (${lag.slice(0, 90)})`);
  const pub = await page.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('tacit-eth-identity-anchor:'))));
  await page.evaluate((p) => localStorage.setItem(`tacit-lite-cbtc-v1:${p}`, JSON.stringify({ lockTxid: 'aa'.repeat(32), lockVout: 1, vBtc: '20000', anchor: { txid: 'bb'.repeat(32), vout: 0 }, at: Date.now() })), pub);
  await page.evaluate(() => { location.hash = ''; location.hash = '#borrow'; });
  await page.waitForSelector('#bw-bond', { timeout: 120000 });
  await page.click('#bw-bond');
  await until(page, () => /Bond posted/.test(document.querySelector('#toast-container')?.textContent || '') || /err/.test(document.querySelector('#bw-status')?.innerHTML || ''));
  await shot(page, 'borrow');
  ok(/Bond posted/.test(await text(page, '#toast-container')), `borrow: the bond posts through the helper ${await text(page, '#bw-status')}`);
  const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', wst = async (x) => BigInt(await rpc('eth_call', [{ to: WSTETH, data: '0x70a08231' + addrWord(x) }, 'latest']));
  await page.waitForSelector('[data-bond-take]', { timeout: 120000 });
  ok(/not minted yet, can come back/.test(await text(page, '#bw-bonds')), `borrow: the bond shows under Your bonds as one that can come back (${(await text(page, '#bw-bonds')).slice(0, 120)})`);
  const w0 = await wst(A0);
  await page.click('[data-bond-take]');
  await chainUntil(async () => (await wst(A0)) > w0, 120000);
  ok((await wst(A0)) > w0, `borrow: a bond on a lock not minted comes back to the account that posted it ${await text(page, '#bw-status')}`);
});

// A bond whose lock the pool records as minted on and then spent on Bitcoin (the pool's own flags for a fixture lock,
// set on the fork) is forfeit: the dashboard says so, the borrow sheet shows it with no way to take it back, and the
// dashboard's notice clears once the sheet has shown it.
await step('bonds', async () => {
  const HELPER = '0x000000008eCD09f922C9FbbDD9ACA5aE8F0beBfA', POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
  const OP = Buffer.from(keccak_256(Buffer.concat([Buffer.from('cd'.repeat(32), 'hex'), Buffer.from([1, 0, 0, 0])]))).toString('hex');
  const slot = (n) => '0x' + Buffer.from(keccak_256(Buffer.from(OP + word(n), 'hex'))).toString('hex');
  const flag = (n, v) => rpc('anvil_setStorageAt', [POOL, slot(n), '0x' + word(v)]);   // 123 lock sats, 125 spent, 127 minted
  const h = await rpc('eth_sendTransaction', [{ from: A0, to: HELPER, data: '0xc0e2d9a1' + OP, value: '0x' + (10n ** 15n).toString(16) }]);
  await chainUntil(async () => (await rpc('eth_getTransactionReceipt', [h]))?.status === '0x1', 60000);
  await flag(123, 20000); await flag(127, 1); await flag(125, 1);
  try {
    // The same key the borrow step opened, reopened from the wallet sheet if the reload closed it (the borrow sheet would
    // mark the forfeit seen before the dashboard could show it).
    await page.goto(url + '#wallet');
    await page.reload();                                             // a new page: nothing read before the flags were set
    await page.waitForSelector('#wallet-body [data-in], #wallet-dot.on', { state: 'attached', timeout: 60000 });
    if (!(await page.$('#wallet-dot.on'))) {
      await page.click((await page.$('#wallet-body [data-in="known"]')) ? '#wallet-body [data-in="known"]' : '#wallet-body [data-in="eth"]');
      await until(page, () => !!document.querySelector('#wallet-dot.on'), null, 60000);
    }
    await page.keyboard.press('Escape');
    const due = () => page.evaluate(() => document.querySelector('#dash-due')?.textContent || '');
    await until(page, () => /spent on Bitcoin before its cBTC was redeemed/.test(document.querySelector('#dash-due')?.textContent || ''), null, 120000)
      .catch(async () => { throw new Error(`no forfeit notice on the dashboard (${(await due()).slice(0, 160)})`); });
    ok(/insurance reserve/.test(await due()), 'bonds: the dashboard says a bond was forfeit, and where it goes');
    ok(/spent on Bitcoin before its cBTC was redeemed/.test(await text(page, '#toast-container')), 'bonds: the forfeit is announced once when it is first seen');
    await page.click('[data-dash-do="bonds"]');
    await until(page, () => /forfeit/.test(document.querySelector('#bw-bonds')?.textContent || ''), null, 120000);
    ok(/was spent on Bitcoin before its cBTC was redeemed/.test(await text(page, '#bw-bonds .callout.bad')), 'bonds: the borrow sheet shows the forfeit bond with a notice');
    await page.$eval('#bw-bonds', (e) => e.scrollIntoView({ block: 'start' }));
    await shot(page, 'bonds');
    ok(!(await page.$(`[data-bond-take^="0x${OP}"]`)), 'bonds: a forfeit bond offers no take-back');
    await page.keyboard.press('Escape');
    await until(page, () => !/spent on Bitcoin before its cBTC was redeemed/.test(document.querySelector('#dash-due')?.textContent || ''), null, 30000).catch(() => {});
    ok(!/spent on Bitcoin before its cBTC was redeemed/.test(await due()), 'bonds: once the sheet has shown it, the dashboard stops pointing at it');
  } finally {
    // The fixture lock goes back to never recorded, and the wallet takes its bond back.
    await flag(125, 0); await flag(127, 0); await flag(123, 0);
    await rpc('eth_sendTransaction', [{ from: A0, to: HELPER, data: '0xc5211d27' + OP }]);
  }
});

// tacit.finance's own Borrow tab: a pending cBTC lock asks for its bond, the bond posts through the escrow helper from
// the wallet's Tacit account, the row waits for the reflection, and once the pool records the lock it offers the mint.
const { makeEvmAccount } = await import(new URL('../dapp/evm-account.js', import.meta.url));
await step('mainbond', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const root = r.url.replace(/weld\/$/, ''), hex = 'bd'.padEnd(64, '5'), pass = 'correct horse battery staple';
  const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', ENGINE = '0x000000003f608BDdF0ca45934003ffb9DbDF70DB';
  const OP = Buffer.from(keccak_256(Buffer.concat([Buffer.from('aa'.repeat(32), 'hex'), Buffer.from([1, 0, 0, 0])]))).toString('hex');
  const call = async (to, data) => BigInt(await rpc('eth_call', [{ to, data }, 'latest']));
  const row = () => r.page.evaluate(() => [document.querySelector('.cbtc-step[data-i="0"]')?.textContent || '', document.querySelector('.cbtc-mint-pending-btn[data-i="0"]')?.textContent || '']);
  const rowIs = (re, timeout = 120000) => until(r.page, (s) => new RegExp(s).test(document.querySelector('.cbtc-step[data-i="0"]')?.textContent || ''), re.source, timeout);
  try {
    await r.page.goto(r.url);
    await r.page.waitForSelector('#toast-container', { state: 'attached' });
    const saving = r.page.evaluate(async (h) => { globalThis.__TACIT_NO_INIT__ = true; const T = await import('/tacit.js'); await T.wallet.setPriv(h); }, hex);
    await r.page.waitForSelector('#pass-dialog[open] #pass-input-1', { timeout: 120000 });
    await r.page.fill('#pass-input-1', pass); await r.page.fill('#pass-input-2', pass); await r.page.click('#pass-submit');
    await saving;
    const lock = { lockTxid: 'aa'.repeat(32), lockVout: 1, vBtc: '20000', blinding: '0x' + '11'.repeat(32) };
    await r.page.evaluate((l) => { localStorage.setItem('tacit-active-mode-v1', 'local'); localStorage.setItem('tacit-cbtc-pending-locks-v1', JSON.stringify([l])); }, lock);
    const acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
    await rpc('anvil_setBalance', [acct, '0x0']);                  // funded only once the tab has said how
    await r.page.goto(root);
    await r.page.waitForSelector('#toast-container', { state: 'attached' });
    await until(r.page, () => !!document.querySelector('[data-tab="cdp"]'));
    // Unlock the saved key through tacit.finance's own wallet. The page evaluates a second copy of tacit.js
    // (amm-farm-ui.js imports it by bare path) and the tabs are wired by whichever copy set up last, so both unlock.
    const unlocked = [];
    for (const which of ['entry', 'bare']) {
      const unlocking = r.page.evaluate(async (w) => {
        const src = w === 'entry' ? document.querySelector('script[type="module"][src*="tacit.js"]').src : new URL('/tacit.js', location.href).href;
        const T = await import(src);
        if (!T.wallet.priv) await T.wallet.load(null);
        return !!T.wallet.priv;
      }, which).catch((e) => e.message);
      if (await r.page.waitForSelector('#pass-modal #pass-input-1', { state: 'visible', timeout: 60000 }).then(() => true, () => false)) {
        await r.page.fill('#pass-input-1', pass); await r.page.click('#pass-submit');
      }
      unlocked.push(await unlocking);
    }
    ok(unlocked.every((u) => u === true), `mainbond: the saved key unlocks in tacit.finance (${unlocked.join(', ')})`);
    const toTab = async (name) => {
      await until(r.page, (n) => typeof document.querySelector(`.tab[data-tab="${n}"]`)?.onclick === 'function', name, 120000);
      await r.page.evaluate((n) => document.querySelector(`.tab[data-tab="${n}"]`).click(), name);
    };
    const toBorrow = () => toTab('cdp');
    await toBorrow();
    await rowIs(/Needs its bond|price feed|Could not/);
    let [s, b] = await row();
    const fundLine = await r.page.evaluate(() => document.querySelector('.cbtc-fund[data-i="0"]')?.textContent || '');
    const off = () => r.page.$eval('.cbtc-mint-pending-btn[data-i="0"]', (x) => x.disabled);
    ok(/holds 0 ETH\. Top it up from a connected wallet[^]*send it at least [\d.]+ ETH on Ethereum/.test(s) && fundLine.toLowerCase().includes(acct.toLowerCase()) && b === 'Top up from wallet' && !(await off()),
      `mainbond: an unfunded Tacit account is named, with a top-up from the connected wallet (${s} | ${fundLine.trim()} [${b}])`);
    // One click: the connected wallet (anvil's first account) sends the shortfall, then the bond posts from the Tacit account.
    await r.page.click('.cbtc-mint-pending-btn[data-i="0"]');
    await rowIs(/Bonded\.|Needs its bond/, 180000).catch(() => {});
    await chainUntil(async () => (await call(ENGINE, '0xe06e89c9' + OP)) > 0n, 120000).catch(() => {});
    const [total, need] = await Promise.all([call(ENGINE, '0xe06e89c9' + OP), call(ENGINE, '0x034448ed' + word(20000))]);
    ok(need > 0n && total >= need, `mainbond: the bond is posted for the lock from the Tacit account (${total} of ${need} wstETH wei) ${await text(r.page, '#cdp-cbtc-status')}`);
    await until(r.page, () => /not minted yet, can come back/.test(document.querySelector('#cdp-cbtc-bonds')?.textContent || ''), null, 120000).catch(() => {});
    const bondsTxt = (await text(r.page, '#cdp-cbtc-bonds')).replace(/\s+/g, ' ');
    ok(/not minted yet, can come back/.test(bondsTxt) && !!(await r.page.$('#cdp-cbtc-bonds .cbtc-bond-take')), `mainbond: the Borrow tab lists the bond, with a way to take it back (${bondsTxt.slice(0, 140)})`);
    await rowIs(/Bonded\./);
    [s, b] = await row();
    ok(/Minting opens once the reflection records this lock/.test(s) && b === 'Waiting', `mainbond: then it waits for the reflection (${s} [${b}])`);
    // The reflection records the lock (cbtcLockVBtc, declaration slot 123): the row then offers the mint.
    await rpc('anvil_setStorageAt', [POOL, '0x' + Buffer.from(keccak_256(Buffer.from(OP + word(123), 'hex'))).toString('hex'), '0x' + word(20000)]);
    await toTab('market');
    await toBorrow();
    await rowIs(/Recorded and bonded/);
    [s, b] = await row();
    ok(b === 'Mint', `mainbond: once the pool records the lock, the row offers the mint (${s} [${b}])`);
    if (r.errors.length) { fails++; console.log('FAIL mainbond page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } catch (e) {
    await shot(r.page, 'mainbond-fail');
    const at = await r.page.evaluate(() => ({ loaded: performance.getEntriesByType('resource').map((x) => x.name).filter((n) => /\/tacit\.js/.test(n)),
      pending: document.querySelector('#cdp-cbtc-pending')?.textContent.replace(/\s+/g, ' ').slice(0, 200) ?? 'absent',
      status: document.querySelector('#cdp-cbtc-status')?.textContent.slice(0, 160),
      cdpTail: (document.querySelector('#cdp-body')?.textContent || '').replace(/\s+/g, ' ').slice(-260) })).catch(() => null);
    throw new Error(`${e.message.split('\n')[0]} | page ${JSON.stringify(at)} | errors ${r.errors.slice(0, 2).join(' | ')}`);
  } finally { await r.browser.close(); }
});

// Weld follows every lock a key made, found from its Bitcoin history alone (so a lock made on tacit.finance or another
// device counts): the tile names the next step, the sheet opens on the oldest lock still to mint, lists the others, and
// can make another. Esplora is stubbed to show two locks paying the key's lock script.
const { makeBtcHistoryProvider } = await import(new URL('../dapp/confidential-recovery-btc.js', import.meta.url));
await step('locks', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'feed'.padEnd(64, '9');
  const spk = makeBtcHistoryProvider({ sha256, fetchImpl: async () => ({ ok: false }) }).walletScripts(hex).lock;
  const lockHex = Buffer.from(spk).toString('hex'), sh = Buffer.from(sha256(spk)).toString('hex');
  const lockTx = (id, commit, value, time) => ({ txid: id.repeat(32), vin: [{ txid: commit.repeat(32), vout: 0 }], status: { confirmed: true, block_time: time, block_height: 968900 },
    vout: [{ scriptpubkey: '0014' + '00'.repeat(20), value: 1000 }, { scriptpubkey: lockHex, value }] });
  const history = [lockTx('b2', 'c2', 30000, 1_790_600_000), lockTx('b1', 'c1', 20000, 1_790_500_000)];     // newest first, as esplora serves
  for (const base of ['https://mempool.space/api', 'https://blockstream.info/api', 'https://mempool.emzy.de/api']) {
    await r.ctx.route(`${base}/scripthash/${sh}/txs**`, (route) => json(route, route.request().url().includes('/chain/') ? [] : history));
    for (const c of ['c1', 'c2']) await r.ctx.route(`${base}/tx/${c.repeat(32)}`, (route) => json(route, { txid: c.repeat(32), vin: [{ txid: `a${c[1]}`.repeat(32), vout: 0 }] }));
  }
  const body = () => r.page.evaluate(() => (document.querySelector('#borrow-body')?.textContent || '').replace(/\s+/g, ' '));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await until(r.page, () => /BTC locked · post its bond/.test(document.querySelector('[data-foot="borrow"]')?.textContent || ''), null, 120000).catch(() => {});
    const foot = await text(r.page, '[data-foot="borrow"]');
    ok(/0\.0002\d* BTC locked · post its bond/.test(foot), `locks: the Borrow tile names the next step (${foot})`);
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#borrow'; });
    await r.page.waitForSelector('#borrow-body [data-pick]', { timeout: 120000 });
    const b = await body();
    ok(/0\.0002\d* BTC in your own output/.test(b) && /Your locks/.test(b) && /post its bond · shown above/.test(b), `locks: the sheet opens on the oldest lock still to mint and lists the others (${b.slice(0, 120)})`);
    ok(!!(await r.page.$('#borrow-body details.lockmore #bw-lock')), 'locks: another lock can be made from the sheet');
    ok(!!(await r.page.$('#bw-bond, #bw-topup')), 'locks: the lock it follows offers its bond');
    await until(r.page, () => /Paid from your (Tacit account|wallet)[^]*?\d ETH/.test(document.querySelector('#borrow-body')?.textContent || ''), null, 60000).catch(() => {});
    const bt = await body(), short = !!(await r.page.$('#bw-topup'));
    ok(/Paid from your (Tacit account|wallet)/.test(bt) && (short ? /Top up your Tacit account from a connected wallet/.test(bt) && !(await r.page.$('#bw-bond')) : !(await r.page.$eval('#bw-bond', (x) => x.disabled))),
      `locks: the bond names the account that pays and what it holds, and offers a top-up when short (${(bt.match(/Paid from.{0,60}?ETH/) || [''])[0]}${short ? ' · Top up from wallet' : ''})`);
    await r.page.click('#borrow-body [data-pick]');
    await until(r.page, () => /0\.0003\d* BTC in your own output/.test((document.querySelector('#borrow-body')?.textContent || '').replace(/\s+/g, ' ')), null, 60000).catch(() => {});
    ok(/0\.0003\d* BTC in your own output/.test(await body()), 'locks: Show opens the other lock');
    // An empty Tacit account: the connected wallet tops it up and the bond posts from the Tacit account, in one click.
    if (await r.page.waitForSelector('#bw-topup', { timeout: 60000 }).then(() => true, () => false)) {
      await r.page.click('#bw-topup');
      await until(r.page, () => /Bond posted/.test(document.querySelector('#bw-status')?.textContent || '') || /error|could not|reverted/i.test(document.querySelector('#bw-status')?.textContent || ''), null, 180000).catch(() => {});
      ok(/Bond posted/.test(await text(r.page, '#bw-status')), `locks: Top up from wallet funds the Tacit account and posts the bond (${(await text(r.page, '#bw-status')).trim().slice(0, 120)})`);
    } else ok(false, 'locks: an empty Tacit account offers Top up from wallet');
    if (r.errors.length) { fails++; console.log('FAIL locks page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// A loan taken against a lock is repaid from weld itself: the step shows what repaying burns and offers Repay and close,
// which says so plainly when the loan is not on chain yet (here: a record of a loan the fork has never seen).
await step('repay', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'be11'.padEnd(64, '7'), pub = Buffer.from(secp.getPublicKey(hex, true)).toString('hex');
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await r.page.evaluate((p) => localStorage.setItem(`tacit-lite-cbtc-v1:${p}`, JSON.stringify({ lockTxid: 'ab'.repeat(32), lockVout: 1, vBtc: '20000',
      anchor: { txid: 'cd'.repeat(32), vout: 0 }, at: Date.now(), minted: true, borrowed: '800000000', borrowedAt: Date.now() })), pub);
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#borrow'; });
    await r.page.waitForSelector('#bw-repay', { timeout: 240000 }).catch(async (e) => {
      throw new Error(`${e.message.split('\n')[0]} | sheet: ${(await r.page.evaluate(() => (document.querySelector('#borrow-body')?.textContent || '').replace(/\s+/g, ' ').slice(0, 260)))} | errors: ${r.errors.slice(0, 2).join(' | ')}`);
    });
    const note = await r.page.evaluate(() => (document.querySelector('#borrow-body')?.textContent || '').replace(/\s+/g, ' '));
    ok(/Repaying burns 8(\.00)? cUSD you hold privately and returns the cBTC/.test(note), `repay: the loan step says what repaying burns (${(note.match(/Repaying burns[^.]*\./) || [''])[0]})`);
    await r.page.click('#bw-repay');
    await until(r.page, () => /not visible on chain yet|not on chain yet/.test(document.querySelector('#bw-status')?.textContent || ''), null, 60000).catch(() => {});
    ok(/not visible on chain yet|not on chain yet/.test(await text(r.page, '#bw-status')), `repay: before the loan is on chain it says so (${await text(r.page, '#bw-status')})`);
    if (r.errors.length) { fails++; console.log('FAIL repay page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
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

await step('csend', async () => {
  const r = await openPage({ account: A0, key: K0 });
  const hex = 'c5e4d'.padEnd(64, '3');
  // The page's pool module, with private cUSD and cBTC notes added to what the key's balance finds.
  const CUSD = '0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d', CBTC = '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8';
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      const note = (asset, value, i) => ({ asset, value: String(value), leafIndex: 900000 + i, cx: '0x' + String(i).repeat(64).slice(0, 64), cy: '0x01', owner: '0x02' });
      const add = [note('${CUSD}', 2500000000n, 1), note('${CUSD}', 300000000n, 2), note('${CBTC}', 50000n, 3)];
      ux.balance = async (priv) => {
        const b = await balance(priv);
        b.notes = [...b.notes, ...add];
        for (const n of add) { const g = b.byAsset[n.asset] ||= { asset: n.asset, value: 0n, notes: [] }; g.value = BigInt(g.value) + BigInt(n.value); g.notes = [...g.notes, n]; }
        return b;
      };
      return ux;
    }` }));
  try {
    await r.page.goto(r.url + '#wallet');
    await r.page.click('#wallet-body [data-in="paste"]');
    await r.page.fill('#ws-hex', hex);
    await r.page.click('#wallet-body [data-in="key"]');
    await until(r.page, () => !!document.querySelector('#wallet-dot.on'));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#borrow'; });
    await r.page.waitForSelector('#bw-send:not([hidden]) #cs-to', { timeout: 240000 }).catch(async (e) => {
      throw new Error(`${e.message.split('\n')[0]} | sheet: ${(await r.page.evaluate(() => (document.querySelector('#borrow-body')?.textContent || '').replace(/\s+/g, ' ').slice(-300)))} | errors: ${r.errors.slice(0, 2).join(' | ')}`);
    });
    const chips = await r.page.$$eval('#bw-send [data-cs]', (b) => b.map((x) => x.textContent));
    ok(chips.join(',') === 'cBTC,cUSD', `csend: private cBTC and cUSD are both offered (${chips.join(', ')})`);
    await r.page.click('#bw-send [data-cs="cusd"]');
    await r.page.waitForSelector('#cs-max');
    ok(/Private 28(\.00)? cUSD/.test(await text(r.page, '#cs-max')), `csend: the cUSD balance is the notes' sum (${await text(r.page, '#cs-max')})`);
    await r.page.fill('#cs-to', tacit1('abc'.padEnd(64, '9')));
    await r.page.fill('#cs-amt', '15');                           // clears the claim's relay fee at today's gas, and fits with a split
    await until(r.page, () => /They get about/.test(document.querySelector('#cs-rcpt')?.textContent || '') && !document.querySelector('#cs-go').disabled, null, 60000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | preview: ${(await text(r.page, '#cs-rcpt')).replace(/\s+/g, ' ')} | status: ${await text(r.page, '#bw-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    ok(true, `csend: a tacit1 recipient is quoted privately (${(await text(r.page, '#cs-rcpt')).replace(/\s+/g, ' ').trim()})`);
    await r.page.fill('#cs-to', '0x000000000000000000000000000000000000dEaD');
    await until(r.page, () => /Arrives[^]*tacUSD/.test(document.querySelector('#cs-rcpt')?.textContent || '') && !document.querySelector('#cs-go').disabled, null, 60000);
    ok(/Relay fee/.test(await text(r.page, '#cs-rcpt')), `csend: an 0x recipient gets it as tacUSD, fee first (${(await text(r.page, '#cs-rcpt')).replace(/\s+/g, ' ').trim()})`);
    // Out to an account this key deposits from: it goes, and the page says it links the two.
    const own = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
    await r.page.fill('#cs-to', own);
    await until(r.page, () => /one of your own accounts/.test(document.querySelector('#cs-rcpt')?.textContent || ''), null, 60000).catch(() => {});
    ok(/one of your own accounts/.test(await text(r.page, '#cs-rcpt')) && !(await r.page.$eval('#cs-go', (b) => b.disabled)), 'csend: paying out to an own account says it links them, and still allows it');
    await r.page.fill('#cs-amt', '100');
    await until(r.page, () => /More than your private balance/.test(document.querySelector('#cs-rcpt')?.textContent || ''), null, 60000);
    ok(await r.page.$eval('#cs-go', (b) => b.disabled), 'csend: more than the private balance is refused');
    await r.page.click('#bw-send [data-cs="cbtc"]');
    await until(r.page, () => /Private 0\.0005 cBTC/.test(document.querySelector('#cs-max')?.textContent || ''), null, 30000);
    ok(true, `csend: switching to cBTC shows its balance (${await text(r.page, '#cs-max')})`);
    if (r.errors.length) { fails++; console.log('FAIL csend page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

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
  await r.page.click('[data-wala="tac"]');
  await r.page.waitForSelector('#ac-to');
  await r.page.fill('#ac-to', OUT);
  const tAcct = await tacOf(want), tOut0 = await tacOf(OUT);
  await r.page.click('#ac-max');
  await until(r.page, () => !!document.querySelector('#ac-mv')?.value);
  await r.page.click('#ac-go');
  await chainUntil(async () => (await tacOf(OUT)) - tOut0 === tAcct, 120000);
  ok(tAcct > 0n && (await tacOf(OUT)) - tOut0 === tAcct && (await tacOf(want)) === 0n, `acct: Send out moves all of the Tacit account's TAC too (${Number(tAcct / 10n ** 14n) / 1e4} TAC)`);
  await r.page.click('[data-wala="eth"]');

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
// Relayed jobs reach the page as tacit:job events; here they are dispatched the way the relay client dispatches them, and
// /confidential/status answers from `served`, so a reload can find settled a job that had failed. Notification records
// what would be shown instead of showing it.
const NOTIFY_STUB = () => {
  window.__notes = [];
  window.Notification = class { static permission = 'granted'; static requestPermission() { return Promise.resolve('granted'); }
    constructor(title, o = {}) { window.__notes.push({ title, body: o.body || '', tag: o.tag || '' }); } close() {} };
};
const hideTab = (p, on) => p.evaluate((h) => {
  for (const [k, v] of [['hidden', h], ['visibilityState', h ? 'hidden' : 'visible']]) Object.defineProperty(document, k, { configurable: true, get: () => v });
  document.dispatchEvent(new Event('visibilitychange'));
}, on);
const actRows = (p) => p.evaluate(() => [...document.querySelectorAll('#act-body .actr')].map((li) => ({ id: li.dataset.act, text: li.textContent.replace(/\s+/g, ' ').trim(),
  now: li.querySelector('.stp .now')?.textContent || '', bad: li.querySelector('.stp .bad')?.textContent || '', links: [...li.querySelectorAll('.actr-f a')].map((a) => a.href) })));
const openActivity = async (p) => { await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close())); await p.click('#act'); await p.waitForSelector('#sheet-act[open]'); };
const serveStatus = (ctx, served) => ctx.route(/\/confidential\/status\?id=/, (route) => {
  const id = new URL(route.request().url()).searchParams.get('id'), b = served[id];
  return b ? json(route, { jobId: id, mode: 'settle', txHash: null, error: null, createdAt: Date.now(), ...b })
    : route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"unknown job"}' });
});
const pasteKey = async (p, hex) => {
  await p.evaluate(() => { location.hash = ''; location.hash = '#wallet'; });
  await p.click('#wallet-body [data-in="paste"]');
  await p.fill('#ws-hex', hex);
  await p.click('#wallet-body [data-in="key"]');
  await until(p, () => !!document.querySelector('#wallet-dot.on'));
};
await step('activity', async () => {
  const served = {}, H = (b) => '0x' + b.repeat(32);
  const r = await openPage({ account: A0, key: K0, viewport: { width: 390, height: 900 }, init: { fn: NOTIFY_STUB } });
  await serveStatus(r.ctx, served);
  const fire = (d) => r.page.evaluate((x) => dispatchEvent(new CustomEvent('tacit:job', { detail: { txHash: null, error: null, at: Date.now(), ...x } })), d);
  const toastHas = (re) => until(r.page, (s) => new RegExp(s).test(document.querySelector('#toast-container')?.textContent || ''), re.source, 15000).then(() => true, () => false);
  const row = async (id) => (await actRows(r.page)).find((x) => x.id === id) || { text: '', links: [], now: '', bad: '' };
  let seed = null;
  try {
    await r.page.goto(r.url);
    await r.page.waitForSelector('.tile');
    ok(await r.page.$eval('#act', (b) => b.hidden), 'activity: no Activity button before anything has happened');
    await fire({ jobId: 'j-wrap', type: 'wrap', status: 'pending' });
    await until(r.page, () => !document.querySelector('#act').hidden && document.querySelector('#act-n').textContent === '1', null, 15000);
    ok(await toastHas(/Wrap: queued for the relay/), 'activity: a queued job shows in the header with a count, and is toasted');
    await openActivity(r.page);
    ok((await row('job:j-wrap')).now === 'Queued', `activity: its row is at Queued (${(await row('job:j-wrap')).text.slice(0, 50)})`);
    await fire({ jobId: 'j-wrap', type: 'wrap', status: 'proving' });
    await until(r.page, () => document.querySelector('[data-act="job:j-wrap"] .stp .now')?.textContent === 'Proving', null, 15000);
    ok(true, 'activity: then at Proving');
    await fire({ jobId: 'j-wrap', type: 'wrap', status: 'settled', txHash: H('a1') });
    await until(r.page, () => /Done in/.test(document.querySelector('[data-act="job:j-wrap"]')?.textContent || ''), null, 15000);
    const done = await row('job:j-wrap');
    ok(done.links.includes(`https://etherscan.io/tx/${H('a1')}`) && await r.page.$eval('#act-n', (n) => n.hidden), `activity: done, linked to its transaction, nothing left in flight (${done.text.slice(0, 60)})`);
    ok(await toastHas(/Wrap: done\./), 'activity: done is toasted');
    // A failure reads as the relay wrote it, with the transaction it names linked.
    await fire({ jobId: 'j-send', type: 'stealthlock', status: 'pending' });
    await fire({ jobId: 'j-send', type: 'stealthlock', status: 'failed', error: `this note was already spent in ${H('b2')}; if that was this same request, it went through` });
    await until(r.page, () => document.querySelector('[data-act="job:j-send"] .stp .bad')?.textContent === 'Failed', null, 15000);
    const failed = await row('job:j-send');
    ok(/This note was already spent in 0xb2b2/.test(failed.text) && failed.links.includes(`https://etherscan.io/tx/${H('b2')}`), `activity: a failure reads as the relay wrote it (${failed.text.slice(0, 80)})`);
    ok(await toastHas(/Send privately did not go through: This note was already spent/), 'activity: the failure is toasted with its reason');
    // A system notification only while the tab is out of sight.
    await r.page.click('#act-notify');
    await until(r.page, () => localStorage.getItem('tacit-lite-notify-v1') === 'true', null, 15000);
    const n0 = await r.page.evaluate(() => window.__notes.length);
    await fire({ jobId: 'j-seen', type: 'transfer', status: 'pending' });
    await fire({ jobId: 'j-seen', type: 'transfer', status: 'settled', txHash: H('c3') });
    await sleep(500);
    const n1 = await r.page.evaluate(() => window.__notes.length);
    await hideTab(r.page, true);
    await fire({ jobId: 'j-away', type: 'unwrap', status: 'pending' });
    await fire({ jobId: 'j-away', type: 'unwrap', status: 'settled', txHash: H('d4') });
    await sleep(500);
    const notes = await r.page.evaluate(() => window.__notes);
    await hideTab(r.page, false);
    ok(n1 === n0 && notes.length === n0 + 1 && notes.at(-1).title === 'Withdraw' && /Done/.test(notes.at(-1).body),
      `activity: a system notification goes out only while the tab is hidden (${n0} → ${n1} → ${notes.length}: ${notes.at(-1)?.title} · ${notes.at(-1)?.body})`);
    // A transaction the page sends is followed to its receipt: ETH from the connected wallet to a pasted key's Tacit account.
    await pasteKey(r.page, 'ac71'.padEnd(64, '6'));
    await toWallet(r.page);
    await r.page.waitForSelector('[data-pay="wallet"]');
    await r.page.click('[data-pay="wallet"]');
    await until(r.page, () => document.querySelector('[data-pay="wallet"]')?.classList.contains('main'));
    await r.page.waitForSelector('#ac-go');
    await r.page.fill('#ac-mv', '0.001');
    await r.page.click('#ac-go');
    await until(r.page, () => /Added\.|err/.test(document.querySelector('#ac-status')?.innerHTML || ''), null, 120000);
    await openActivity(r.page);
    await until(r.page, () => [...document.querySelectorAll('#act-body .actr')].some((li) => /Add 0\.001 ETH/.test(li.textContent) && /Confirmed in/.test(li.textContent)), null, 60000).catch(() => {});
    const add = (await actRows(r.page)).find((x) => /Add 0\.001 ETH/.test(x.text)) || { text: '', links: [] };
    ok(/Confirmed in/.test(add.text) && add.links.some((l) => /^https:\/\/etherscan\.io\/tx\/0x[0-9a-f]{64}$/.test(l)), `activity: a transaction sent from the page is followed to its receipt (${add.text.slice(0, 70)})`);
    // Before a reload: a job left proving, one failed within six hours (above), and one that failed longer ago.
    await fire({ jobId: 'j-mint', type: 'cbtcmint', status: 'pending' });
    await fire({ jobId: 'j-mint', type: 'cbtcmint', status: 'proving' });
    await sleep(600);                                                         // the list is written shortly after each change
    seed = await r.page.evaluate(() => localStorage.getItem('tacit-lite-activity-v1'));
    await r.page.evaluate(() => {
      const k = 'tacit-lite-activity-v1', s = JSON.parse(localStorage.getItem(k)), t = Date.now();
      s.items.push({ id: 'job:j-old', kind: 'job', type: 'unwrap', label: 'Withdraw', status: 'failed', err: 'settle reverted: stale root', at: t - 8 * 3600e3, up: t - 7 * 3600e3, end: t - 7 * 3600e3 });
      localStorage.setItem(k, JSON.stringify(s));
    });
    Object.assign(served, { 'j-send': { type: 'stealthlock', status: 'settled', txHash: H('e5') }, 'j-mint': { type: 'cbtcmint', status: 'settled', txHash: H('f6') }, 'j-old': { type: 'unwrap', status: 'settled', txHash: H('a7') } });
    await r.page.reload();
    await r.page.waitForSelector('.tile');
    ok(await toastHas(/Send privately went through after all/), 'activity: after a reload, a job that failed in the last six hours is asked about again, and found settled');
    await openActivity(r.page);
    await until(r.page, () => /Done in/.test(document.querySelector('[data-act="job:j-mint"]')?.textContent || ''), null, 30000).catch(() => {});
    const [send2, mint2, old2] = [await row('job:j-send'), await row('job:j-mint'), await row('job:j-old')];
    ok(send2.bad === '' && /Went through after all/.test(send2.text) && send2.links.includes(`https://etherscan.io/tx/${H('e5')}`), `activity: it now reads done, with the settle's transaction (${send2.text.slice(0, 70)})`);
    ok(/Done in/.test(mint2.text) && mint2.links.includes(`https://etherscan.io/tx/${H('f6')}`), `activity: a job still proving at the reload is followed until it settles (${mint2.text.slice(0, 60)})`);
    ok(old2.bad === 'Failed', `activity: a failure older than six hours is left as it was (${old2.text.slice(0, 40)})`);
    ok((await actRows(r.page)).some((x) => /Add 0\.001 ETH/.test(x.text) && /Confirmed/.test(x.text)), 'activity: the list, and each outcome, survives the reload');
    await shot(r.page, 'activity-phone');
    // A job still in line after a minute says why, from the relay's heartbeat: here, a settle wallet waiting on gas.
    await r.ctx.route(/\/prover-health\?/, (route) => json(route, { services: { settle: { healthy: true, age_seconds: 20,
      note: 'settle: settle wallet holds 0.0010 ETH, under the 0.0031 ETH a settle can cost at today’s gas — leaving jobs queued until it is topped up' } } }));
    served['j-wait'] = { type: 'transfer', status: 'pending' };
    await sleep(600);
    await r.page.evaluate(() => {
      const k = 'tacit-lite-activity-v1', s = JSON.parse(localStorage.getItem(k)), t = Date.now();
      s.items.unshift({ id: 'job:j-wait', kind: 'job', type: 'transfer', label: 'Private transfer', status: 'pending', at: t - 90e3, up: t - 90e3 });
      localStorage.setItem(k, JSON.stringify(s));
    });
    await r.page.reload();
    await r.page.waitForSelector('.tile');
    await openActivity(r.page);
    const waitOk = await until(r.page, () => /topping up its gas/.test(document.querySelector('[data-act="job:j-wait"]')?.textContent || ''), null, 20000).then(() => true, () => false);
    const wait = await row('job:j-wait');
    ok(waitOk && wait.now === 'Queued' && /keeps its place/.test(wait.text), `activity: a job in line past a minute says the relay is waiting on gas, and that it keeps its place (${wait.text.slice(0, 110)})`);
    served['j-wait'] = { type: 'transfer', status: 'settled', txHash: H('b8') };
    await until(r.page, () => /Done in/.test(document.querySelector('[data-act="job:j-wait"]')?.textContent || ''), null, 30000).catch(() => {});
    ok(/Done in/.test((await row('job:j-wait')).text), 'activity: and it reads done once the relay settles it');
    // At most twenty entries are kept, newest first.
    for (let i = 0; i < 22; i++) await fire({ jobId: `j-n${i}`, type: 'transfer', status: 'settled', txHash: H('ab') });
    await sleep(600);
    const kept = await r.page.evaluate(() => JSON.parse(localStorage.getItem('tacit-lite-activity-v1')).items.map((x) => x.id));
    ok(kept.length === 20 && kept[0] === 'job:j-n21', `activity: the list keeps the newest twenty (${kept.length}, newest ${kept[0]})`);
    if (r.errors.length) { fails++; console.log('FAIL activity page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
  // The same list in the other widths and schemes, with one job still proving.
  if (SHOTS && seed) {
    const live = JSON.parse(seed);
    live.items.unshift({ id: 'job:j-live', kind: 'job', type: 'sendunwrap', label: 'Withdraw 0.05 ETH', status: 'proving', prov: true, at: Date.now() - 42e3, up: Date.now() - 20e3 });
    for (const [tag, viewport, colorScheme] of [['phone-dark', { width: 390, height: 900 }, 'dark'], ['desk', { width: 1280, height: 900 }, 'light'], ['desk-dark', { width: 1280, height: 900 }, 'dark']]) {
      const v = await openPage({ account: A0, key: K0, viewport, colorScheme, init: { fn: (s) => localStorage.setItem('tacit-lite-activity-v1', s), arg: JSON.stringify(live) } });
      await serveStatus(v.ctx, { 'j-live': { status: 'proving' }, 'j-mint': { status: 'settled', txHash: H('f6') } });
      await v.page.goto(v.url);
      await v.page.waitForSelector('.tile');
      await shot(v.page, `activity-home-${tag}`);
      await openActivity(v.page);
      await sleep(800);
      await shot(v.page, `activity-${tag}`);
      await v.browser.close();
    }
  }
});

// Two relayed actions at once, each its own receipt. The page's pool module is the real one, with three cETH notes added
// to what the key's scan finds and its relayed calls stood in for: each names its job to the caller (as the relay
// client does), announces it, and waits for the test to let the relay finish it. A send needing a split goes back to
// the relay on its own, a withdrawal starts meanwhile on another note, and neither reaches for the other's notes.
await step('receipts', async () => {
  const served = {};
  const r = await openPage({ account: A0, key: K0, viewport: { width: 390, height: 900 } });
  await serveStatus(r.ctx, served);
  await r.page.route(/\/confidential-pool-ux\.js\?cb=/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    import * as real from '/confidential-pool-ux.js?stub=real';
    export * from '/confidential-pool-ux.js?stub=real';
    export function makeConfidentialPoolUx(o) {
      const ux = real.makeConfidentialPoolUx(o), balance = ux.balance;
      const ETH = String(ux.assetByTicker.cETH.assetId).toLowerCase();
      let seq = 0;
      const note = (value) => { const i = ++seq; return { asset: ETH, value: String(value), leaf: '0x' + (0xabc000 + i).toString(16).padStart(64, '0'), leafIndex: 800000 + i, cx: '0x' + String(i).padStart(64, '0'), cy: '0x01', owner: '0x02', root: '0x' + '1'.padStart(64, '0'), path: [] }; };
      const TAC = String(ux.assetByTicker.cTAC.assetId).toLowerCase(), tacNote = (value) => ({ ...note(value), asset: TAC });
      const S = window.__rx = { notes: [note(30000000n), note(20000000n), note(5000000n), tacNote(500000000n), tacNote(300000000n)], calls: [], gates: {}, spent: new Set() };
      ux.balance = async (priv) => {
        const b = await balance(priv), add = S.notes.filter((n) => !S.spent.has(n.leaf));
        b.notes = [...b.notes, ...add];
        for (const n of add) {
          const g = b.byAsset[n.asset] ||= { asset: n.asset, value: 0n, notes: [] };
          g.notes = [...(g.notes || []), n]; g.value = g.notes.reduce((a, x) => a + BigInt(x.value), 0n);
        }
        return b;
      };
      ux.quoteOpFee = async () => '100000';
      const fire = (d) => dispatchEvent(new CustomEvent('tacit:job', { detail: { txHash: null, error: null, at: Date.now(), ...d } }));
      const job = async (type, waitOpts, spend, make) => {
        const jobId = 'rx-' + type + '-' + (spend[0]?.leaf || '').slice(-6);
        S.calls.push({ jobId, type, spend: spend.map((n) => n.leaf) });
        waitOpts?.onJob?.(jobId, type);
        fire({ jobId, type, status: 'pending' });
        const out = await new Promise((res) => { S.gates[jobId] = res; });
        if (out === 'fail') { fire({ jobId, type, status: 'failed', error: 'the pool refused it in this check' }); throw new Error('settle failed: the pool refused it in this check'); }
        fire({ jobId, type, status: 'proving' });
        for (const n of spend) S.spent.add(n.leaf);
        for (const v of make) S.notes.push(note(v));
        const txHash = '0x' + String(S.calls.length).padStart(64, 'e');
        fire({ jobId, type, status: 'settled', txHash });
        return { jobId, status: 'settled', txHash };
      };
      ux.transfer = ({ notes, amount, fee, waitOpts }) => job('transfer', waitOpts, notes, [BigInt(amount), notes.reduce((a, n) => a + BigInt(n.value), 0n) - BigInt(amount) - BigInt(fee)].filter((v) => v > 0n));
      ux.stealthSend = async ({ notes, amount, waitOpts }) => {
        if (notes.length !== 1 || BigInt(notes[0].value) !== BigInt(amount)) throw new Error('stealthSend in this check takes one note of the exact amount');
        return { ...(await job('stealthlock', waitOpts, notes, [])), memoCheck: { ok: true } };
      };
      ux.sendUnwrap = async ({ note: n, amount, waitOpts }) => job('sendunwrap', waitOpts, [n], [BigInt(n.value) - BigInt(amount)].filter((v) => v > 0n));
      ux.unwrap = async ({ note: n, waitOpts }) => job('unwrap', waitOpts, [n], []);
      return ux;
    }` }));
  const rx = () => r.page.evaluate(() => ({ calls: window.__rx?.calls || [], notes: (window.__rx?.notes || []).map((n) => [n.leaf, n.value]) }));
  const open = (id, out = 'ok') => r.page.evaluate(([i, o]) => window.__rx.gates[i](o), [id, out]);
  const toastHas = (re, ms = 20000) => until(r.page, (s) => new RegExp(s).test(document.querySelector('#toast-container')?.textContent || ''), re.source, ms).then(() => true, () => false);
  const row = async (re) => (await actRows(r.page)).find((x) => re.test(x.text)) || { text: '', links: [], now: '', bad: '', id: '' };
  const sub = async (m) => { await r.page.click(`[data-v1="${m}"]`); await until(r.page, (x) => document.querySelector(`[data-v1="${x}"]`)?.getAttribute('aria-selected') === 'true', m); };
  const toV1 = async () => { await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close())); await r.page.evaluate(() => { location.hash = ''; location.hash = '#private'; }); await r.page.waitForSelector('#sheet-eth[open]'); };
  const REC = tacit1('d1'.padEnd(64, '7'));
  try {
    await r.page.goto(r.url);
    await r.page.waitForSelector('.tile');
    await pasteKey(r.page, 'e1'.padEnd(64, '5'));
    await toV1();
    await sub('send');
    await until(r.page, () => /Private 0\.55 tETH/.test(document.querySelector('#s-max')?.textContent || ''), null, 240000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | form: ${(await text(r.page, '#v1-form')).replace(/\s+/g, ' ').slice(0, 200)} | status: ${await text(r.page, '#v1-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    ok(true, 'receipts: three private notes, 0.55 tETH, to spend');

    // A: 0.1 privately. No note is exactly that, so the relay first splits the 0.2 note; the sheet is handed back then.
    await r.page.fill('#s-to', REC);
    await r.page.fill('#s-amt', '0.1');
    await until(r.page, () => /They get about/.test(document.querySelector('#s-rcpt')?.textContent || '') && !document.querySelector('#s-go').disabled, null, 60000);
    await r.page.click('#s-go');
    await until(r.page, () => /with the relay/.test(document.querySelector('#v1-status')?.textContent || ''), null, 60000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(r.page, '#v1-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    const a0 = await rx();
    ok(a0.calls.length === 1 && a0.calls[0].type === 'transfer' && a0.calls[0].spend[0] === a0.notes[1][0], `receipts: the send splits the 0.2 note first (${JSON.stringify(a0.calls)})`);
    ok(await r.page.$eval('#s-amt', (i) => i.value === '') && await r.page.$eval('#s-go', (b) => b.disabled), 'receipts: the sheet comes back with an empty form as soon as the relay has the split');
    ok(/Private 0\.35 tETH · 0\.2 tETH in use/.test(await text(r.page, '#s-max')), `receipts: the note it spends is shown as in use (${await text(r.page, '#s-max')})`);
    await openActivity(r.page);
    const opA = await row(/Send 0\.1 tETH privately/);
    ok(opA.id.startsWith('op:') && /Split a note/.test(opA.text) && opA.now === 'Split a note', `receipts: one receipt for the send, at its split step (${opA.text.slice(0, 120)})`);
    ok((await actRows(r.page)).length === 1, 'receipts: the split is a step of the send, not a receipt of its own');

    // B, meanwhile: withdraw 0.25. The 0.3 note covers it without a split; it is not the note the send is splitting.
    await toV1();
    await sub('out');
    await r.page.fill('#o-to', '0x000000000000000000000000000000000000dEaD');
    await r.page.fill('#o-amt', '0.25');
    await until(r.page, () => /Arrives/.test(document.querySelector('#o-rcpt')?.textContent || '') && !document.querySelector('#o-go').disabled, null, 60000);
    await r.page.click('#o-go');
    await until(r.page, () => /Withdraw 0\.25 ETH[^]*with the relay/.test(document.querySelector('#v1-status')?.textContent || ''), null, 60000);
    const b0 = await rx();
    ok(b0.calls.length === 2 && b0.calls[1].type === 'sendunwrap' && b0.calls[1].spend[0] === b0.notes[0][0], `receipts: the withdrawal starts at once, on the 0.3 note (${JSON.stringify(b0.calls[1])})`);
    // C: what is left free (0.05) cannot cover 0.1, and the form says so.
    await r.page.fill('#o-amt', '0.1');
    await until(r.page, () => /More than your private balance/.test(document.querySelector('#o-rcpt')?.textContent || ''), null, 30000);
    ok(await r.page.$eval('#o-go', (b) => b.disabled) && /Private 0\.05 tETH · 0\.5 tETH in use/.test(await text(r.page, '#o-max')), `receipts: notes two actions are spending are not offered to a third (${await text(r.page, '#o-max')})`);

    // The split settles: the send takes the new 0.1 note and queues its lock, with no one pressing anything.
    await open(a0.calls[0].jobId);
    await until(r.page, () => (window.__rx?.calls || []).length === 3, null, 90000).catch(() => {});
    const a1 = await rx(), made = a1.notes.find(([, v]) => v === '10000000');
    ok(a1.calls[2]?.type === 'stealthlock' && made && a1.calls[2].spend[0] === made[0], `receipts: after the split, the send locks the new 0.1 note on its own (${JSON.stringify(a1.calls[2] || null)})`);
    await openActivity(r.page);
    await until(r.page, () => /Queued/.test([...document.querySelectorAll('#act-body .actr')].find((li) => /Send 0\.1/.test(li.textContent))?.querySelector('.stp .now')?.textContent || ''), null, 30000).catch(() => {});
    const opA2 = await row(/Send 0\.1 tETH privately/);
    ok(opA2.now === 'Queued' && /Split a note/.test(opA2.text), `receipts: its receipt shows the split done and the send queued (${opA2.text.slice(0, 120)})`);

    // Outcomes: the send settles (toasted, one receipt, linked); the withdrawal fails (toasted with its reason).
    await open(a1.calls[2].jobId);
    ok(await toastHas(/Send 0\.1 tETH privately to [^:]+: done/), 'receipts: the send is toasted done');
    await open(b0.calls[1].jobId, 'fail');
    ok(await toastHas(/Withdraw 0\.25 ETH[^]*did not go through/), 'receipts: the failed withdrawal is toasted with its reason');
    await openActivity(r.page);
    await sleep(500);
    const [sA, sB] = [await row(/Send 0\.1 tETH privately/), await row(/Withdraw 0\.25 ETH/)];
    ok(/Done in/.test(sA.text) && sA.links.some((l) => /etherscan\.io\/tx\/0x0*3e/.test(l) || /etherscan\.io\/tx\//.test(l)), `receipts: the send's receipt reads done, with its transaction (${sA.text.slice(0, 90)})`);
    ok(sB.bad === 'Failed' && /refused it in this check/.test(sB.text), `receipts: the withdrawal's receipt reads failed, with the relay's reason (${sB.text.slice(0, 90)})`);
    // The failed withdrawal's note is free again once a scan shows it unspent.
    await toV1();
    await sub('out');
    await until(r.page, () => /Private 0\.(4|3)\d* tETH/.test(document.querySelector('#o-max')?.textContent || '') && !/in use/.test(document.querySelector('#o-max')?.textContent || ''), null, 60000).catch(() => {});
    ok(!/in use/.test(await text(r.page, '#o-max')), `receipts: nothing is held once both are over (${await text(r.page, '#o-max')})`);

    // D: a send of the 0.05 note exactly, and the page reloaded while the relay still has it: its receipt carries on.
    await sub('send');
    await r.page.fill('#s-to', REC);
    await r.page.fill('#s-amt', '0.05');
    await until(r.page, () => /They get about/.test(document.querySelector('#s-rcpt')?.textContent || '') && !document.querySelector('#s-go').disabled, null, 60000);
    await r.page.click('#s-go');
    await until(r.page, () => (window.__rx?.calls || []).length === 4, null, 60000);
    const d0 = await rx();
    ok(d0.calls[3].type === 'stealthlock', 'receipts: a note of the exact amount is locked with no split');
    await sleep(600);
    served[d0.calls[3].jobId] = { type: 'stealthlock', status: 'proving' };
    await r.page.reload();
    await r.page.waitForSelector('.tile');
    await openActivity(r.page);
    const dRow = await row(/Send 0\.05 tETH privately/);
    ok(dRow.id.startsWith('op:') && !/Done/.test(dRow.bad) && ['Queued', 'Proving'].includes(dRow.now), `receipts: after a reload the receipt is still there, in progress (${dRow.text.slice(0, 90)})`);
    served[d0.calls[3].jobId] = { type: 'stealthlock', status: 'settled', txHash: '0x' + 'd'.repeat(64) };
    await until(r.page, () => /Done in/.test([...document.querySelectorAll('#act-body .actr')].find((li) => /Send 0\.05/.test(li.textContent))?.textContent || ''), null, 60000).catch(() => {});
    ok(/Done in/.test((await row(/Send 0\.05 tETH privately/)).text), 'receipts: and it reads done once the relay settles it');
    await shot(r.page, 'receipts-phone');

    // E: private TAC made public, one relayed unwrap per note, each its own receipt. Both notes are taken when pressed,
    // so the offer goes away at once, and the second is queued after the first settles, with nothing pressed.
    await pasteKey(r.page, 'e1'.padEnd(64, '5'));                             // a pasted key does not outlive a reload
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await r.page.waitForSelector('#tac-pub', { timeout: 240000 });
    ok(/8(\.0+)? TAC is in private notes/.test(await text(r.page, '#tac-bal')), `receipts: 8 private TAC is offered to make public (${(await text(r.page, '#tac-bal')).replace(/\s+/g, ' ').slice(-120)})`);
    const before = (await rx()).calls.length;
    await r.page.click('#tac-pub');
    await until(r.page, () => /each goes on by itself/.test(document.querySelector('#tac-bal-status')?.textContent || ''), null, 60000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(r.page, '#tac-bal-status')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    const e0 = await rx(), first = e0.calls.at(-1);
    ok(e0.calls.length === before + 1 && first.type === 'unwrap' && !(await r.page.$('#tac-pub')), 'receipts: the first unwrap is queued, the sheet is handed back, and the notes are no longer offered');
    // The first fails; the second still goes to the relay on its own.
    await open(first.jobId, 'fail');
    ok(await toastHas(/Make 5 TAC public did not go through/), 'receipts: the failed unwrap is toasted');
    await until(r.page, (n) => (window.__rx?.calls || []).length === n, before + 2, 60000).catch(() => {});
    const e1 = await rx(), second = e1.calls.at(-1);
    ok(e1.calls.length === before + 2 && second.type === 'unwrap' && second.spend[0] !== first.spend[0], 'receipts: the second note goes to the relay on its own after the first failed');
    await open(second.jobId);
    // The failed note is offered again once a scan shows it unspent; sent again, it is the same job, a new attempt.
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await r.page.evaluate(() => { location.hash = ''; location.hash = '#tac'; });
    await until(r.page, () => /5(\.0+)? TAC is in private notes/.test(document.querySelector('#tac-bal')?.textContent || ''), null, 60000).catch(() => {});
    ok(/5(\.0+)? TAC is in private notes/.test(await text(r.page, '#tac-bal')), `receipts: the note whose unwrap failed is offered again (${(await text(r.page, '#tac-bal')).replace(/\s+/g, ' ').slice(-110)})`);
    await r.page.click('#tac-pub');
    await until(r.page, (n) => (window.__rx?.calls || []).length === n, before + 3, 60000).catch(() => {});
    const e2 = await rx(), again = e2.calls.at(-1);
    ok(again?.jobId === first.jobId, `receipts: sent again, it is the same job at the relay (${again?.jobId} = ${first.jobId})`);
    await open(again.jobId);
    ok(await toastHas(/Make 5 TAC public: done/), 'receipts: the new attempt is toasted done');
    await openActivity(r.page);
    await sleep(500);
    const outs = (await actRows(r.page)).filter((x) => /Make \d TAC public/.test(x.text));
    const five = outs.filter((x) => /Make 5 TAC public/.test(x.text));
    ok(outs.length === 3 && five.some((x) => x.bad === 'Failed') && five.some((x) => /Done in/.test(x.text)) && outs.some((x) => /Make 3 TAC public/.test(x.text) && /Done in/.test(x.text)),
      `receipts: each attempt keeps its own receipt: the failed one, the retry done, the other note done (${outs.map((x) => x.text.slice(0, 36)).join(' | ')})`);
    if (r.errors.length) { fails++; console.log('FAIL receipts page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// The stats page reads the chains, two explorers and the relay's status. Logs and the explorers' transaction lists answer
// here from fixtures (a known set of deposits, settles, attestations, bonds, loans, claims and device-pool moves); the
// contract reads come from the fork. Every figure the fixtures decide is checked, then how little each later visit asks:
// nothing within a quarter hour, only what is new on a fresh read, and nothing at all when the API has a shared reading.
await step('stats', async () => {
  const lc = (x) => String(x || '').toLowerCase();
  const w = (v) => (BigInt(v) < 0n ? (1n << 256n) + BigInt(v) : BigInt(v)).toString(16).padStart(64, '0');
  const h = (n) => '0x' + n.toString(16);
  const T = Math.floor(Date.now() / 1000) - 3 * 86400;
  const TOPIC = {
    wrap: '0xf5d1711d21af6f42622ab6237626933cefc42cc9f0663d81b7c4c7bc5ce99e44', leaves: '0x7783fb256f5b4e1d4d8b79583488756286326ae15d9997d4098ce5432ed2708b',
    spent: '0x576d91547505afce99e7ebe2baf1a0948b5915598105a55f40ba72fea86e875e', asset: '0x2dcb7e1d588ab99cccaa0e9a2f69798e1e9ca87a30856228f895c2f6b34a905b',
    posted: '0x0c008a699968f2a24063b7eb14d9239b2430c502fda280245345c78cbc47b7c1', cdpMinted: '0x232c7d098ca44092999087e6ee530a2171f95f9ecb1caa363f6dcf448fb7dd57',
    cdpClosed: '0xc0ede5b75ee32986e50a2a39fa32dbf5e8eff1c91a46cd127591edebd91b4db9', claimed: '0x4ec90e965519d92681267467f775ada5bd214aa92c0dc93d90a5e880ce9ed026',
    transact: '0xdf0ed29e998ac2f2ff0f0516cb9c1b95af189e00d55af3764b95bdd2a835e53a',
  };
  const POOLA = '0x000000000ed1eabd231be41d93b719056f7febfc', ENGINE = '0x000000003f608bddf0ca45934003ffb9dbdf70db', AIR = '0x4b4cb98d0c836c2783ac46f0078b904dab533ae8';
  const EVMP = '0x000000c2a20657ce25f2ba99737933d031afbee9', TIP = '0x000000d218b03db5837943b0b05dea2965ae956e', ROUTER = '0x000000005da3e3b73726af3c774deeb9472d4992';
  const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', TACID = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', USDC = '0x' + 'c5'.repeat(32), USDT = '0x' + 'c6'.repeat(32);
  const tx = (c) => '0x' + c.repeat(64 / c.length);
  let li = 0;
  const log = (address, topics, data, txh, t, block = 26000000 + li) => ({ address, topics, data: '0x' + data, blockNumber: h(block), timeStamp: h(t), blockTimestamp: h(t), transactionHash: txh, logIndex: h(li++) });
  const str = (s) => { const b = Buffer.from(s); return w(b.length) + b.toString('hex').padEnd(64, '0'); };
  // Real locks, read from the fork's pool and engine: one since unlocked on Bitcoin, one still locked (both minted on), and
  // one bonded in the fixtures only, which the pool never recorded.
  const OUTPOINTS = ['0x552c481efffbf72bf5b510bdf4ba49a0f2b41490e1b6cd5c8ac404ca6739eb74', '0xd43d367f46953e71789582054fb46e22ae428008b544eeadc11eebe10db6d7f1', '0x' + 'b1'.repeat(32)];
  const W1 = '0x' + '1a'.repeat(20), W2 = '0x' + '2b'.repeat(20), CL1 = '0x' + '3c'.repeat(20), CL2 = '0x' + '4d'.repeat(20);
  const poolLogs = [
    log(POOLA, [TOPIC.asset, USDC, '0x' + '00'.repeat(12) + 'a0'.repeat(20)], w(1) + w(0x80) + w(0xc0) + w(6) + str('USD Coin') + str('USDC'), tx('e0'), T),
    log(POOLA, [TOPIC.wrap, tx('d1'), CETH], w(10n ** 18n), tx('a1'), T),
    log(POOLA, [TOPIC.wrap, tx('d2'), CETH], w(5n * 10n ** 17n), tx('a2'), T + 86400),
    log(POOLA, [TOPIC.wrap, tx('d3'), TACID], w(100n * 10n ** 18n), tx('a3'), T + 86400),
    log(POOLA, [TOPIC.wrap, tx('d4'), USDC], w(2500000), tx('a4'), T + 86400),
    // Registered with no symbol: the page names it from its token (the real USDT contract on the fork).
    log(POOLA, [TOPIC.asset, USDT, '0x' + '00'.repeat(12) + 'dac17f958d2ee523a2206206994597c13d831ec7'], w(1) + w(0x80) + w(0xc0) + w(6) + str('Tether') + str(''), tx('e1'), T),
    log(POOLA, [TOPIC.wrap, tx('d5'), USDT], w(4630000), tx('a5'), T + 86400),
    log(POOLA, [TOPIC.leaves, w(150)], w(0x40) + w(0xa0) + w(2) + tx('f1').slice(2) + tx('f2').slice(2) + w(0), tx('b1'), T + 86400),
    log(POOLA, [TOPIC.spent], w(0x20) + w(1) + tx('91').slice(2), tx('b1'), T + 86400),
    log(POOLA, [TOPIC.leaves, w(152)], w(0x40) + w(0x80) + w(1) + tx('f3').slice(2) + w(0), tx('b2'), T + 2 * 86400),
    log(POOLA, [TOPIC.spent], w(0x20) + w(2) + tx('92').slice(2) + tx('93').slice(2), tx('b3'), T + 2 * 86400),
  ];
  const engineLogs = [
    ...OUTPOINTS.map((o, i) => log(ENGINE, [TOPIC.posted, o, '0x' + '00'.repeat(12) + '5e'.repeat(20)], w(10n ** 15n), tx('7' + i), T)),
    log(ENGINE, [TOPIC.cdpMinted, tx('81')], w(200000000) + w(0), tx('82'), T), log(ENGINE, [TOPIC.cdpMinted, tx('83')], w(150000000) + w(0), tx('84'), T + 86400),
    log(ENGINE, [TOPIC.cdpClosed, tx('85')], w(100000000), tx('86'), T + 2 * 86400),
  ];
  const addr32 = (a) => '0x' + '00'.repeat(12) + a.slice(2);
  const airLogs = [[CL1, 10], [CL1, 20], [CL2, 30]].map(([a, v], i) => log(AIR, [TOPIC.claimed, w(i), addr32(a)], w(BigInt(v) * 10n ** 18n), tx('c' + i), T));
  const transact = (v, i, t, fee = 0n, block) => log(EVMP, [TOPIC.transact, tx('e' + i), tx('e' + (i + 5))], [w(0), w(0), w(0), w(0), w(0), w(v), w(0), w(fee), w(0x140), w(0x160), w(0), w(0)].join(''), tx('9' + i), t, block);
  const devLogs = [transact(3n * 10n ** 17n, 1, T), transact(-(10n ** 17n), 2, T + 86400, 10n ** 16n)];
  const rhLogs = [transact(2n * 10n ** 17n, 3, T, 0n, 74000000)];
  const MAIN = [...poolLogs, ...engineLogs, ...airLogs, ...devLogs];
  const BASE_HEAD = 51961580, RH_HEAD = 74100000;
  const inRange = (ls, q) => ls.filter((l) => [].concat(q.address).map(lc).includes(lc(l.address))
    && Number(BigInt(l.blockNumber)) >= Number(BigInt(q.fromBlock)) && (q.toBlock === 'latest' || Number(BigInt(l.blockNumber)) <= Number(BigInt(q.toBlock))));
  const TXS = {
    [POOLA]: [
      { hash: tx('a2'), from: W2, to: POOLA, blockNumber: '26000001', timeStamp: String(T + 86400), isError: '0', methodId: '0x8be3ad21', value: '500000000000000000' },
      { hash: tx('c1'), from: '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7', to: POOLA, blockNumber: '26000002', timeStamp: String(T + 86400), isError: '0', methodId: '0x0b36171c', value: '0' },
      { hash: tx('c2'), from: '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7', to: POOLA, blockNumber: '26000003', timeStamp: String(T + 2 * 86400), isError: '0', methodId: '0x0b36171c', value: '0' },
      { hash: tx('c3'), from: '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7', to: POOLA, blockNumber: '26000004', timeStamp: String(T + 2 * 86400), isError: '1', methodId: '0x0b36171c', value: '0' },
    ],
  };
  // A deposit through the router, its delegatecall frame (which moves nothing), ETH in from a public swap (no deposit), and
  // one withdrawal out.
  const INTERNAL = [
    { transactionHash: tx('a1'), index: '0', from: ROUTER, to: POOLA, value: '1000000000000000000', callType: 'call', isError: '0', timeStamp: String(T), blockNumber: '26000000' },
    { transactionHash: tx('a1'), index: '1', from: POOLA, to: '0x141e653de94438258fdab245896c189f56522554', value: '1000000000000000000', callType: 'delegatecall', isError: '0', timeStamp: String(T), blockNumber: '26000000' },
    { transactionHash: tx('a6'), index: '0', from: '0x00000000e36c7ec997cc59dcda9e03673b448119', to: POOLA, value: '300000000000000000', callType: 'call', isError: '0', timeStamp: String(T + 86400), blockNumber: '26000002' },
    { transactionHash: tx('b2'), index: '1', from: POOLA, to: W1, value: '200000000000000000', callType: 'call', isError: '0', timeStamp: String(T + 2 * 86400), blockNumber: '26000005' },
  ];
  // The engine's outstanding debt, pinned for the scenario to match the fixtures' loans (2 + 1.5 borrowed, 1 repaid).
  const CUSD_SLOT = '0x' + word(19), cusdWas = await rpc('eth_getStorageAt', [ENGINE, CUSD_SLOT, 'latest']);
  await rpc('anvil_setStorageAt', [ENGINE, CUSD_SLOT, '0x' + word(250000000)]);
  const r = await openPage({ account: A0, key: K0, viewport: { width: 1280, height: 1100 } });
  const hits = [], logReads = [];
  // Who sent each deposit comes from the chain in one batch, and the logs from one request: the fixtures answer both
  // here, and every other read goes on to the fork.
  const SENDERS = { [tx('a1')]: W1, [tx('a2')]: W2 };
  for (const host of RPC_HOSTS) await r.ctx.route(`https://${host}/**`, (route) => {
    const b = JSON.parse(route.request().postData() || 'null');
    if (b && !Array.isArray(b) && b.method === 'eth_getLogs') { logReads.push(host); return json(route, { jsonrpc: '2.0', id: b.id, result: inRange(MAIN, b.params[0]) }); }
    if (!Array.isArray(b) || !b.length || !b.every((x) => x.method === 'eth_getTransactionByHash')) return route.fallback();
    return json(route, b.map((x) => ({ jsonrpc: '2.0', id: x.id, result: SENDERS[x.params[0]] ? { hash: x.params[0], from: SENDERS[x.params[0]] } : null })));
  });
  // Both explorers answer from the same fixtures, each list from the block asked for.
  await r.ctx.route(/^https:\/\/((eth|base)\.blockscout\.com\/api|api\.routescan\.io\/v2\/network\/mainnet\/evm\/(1|8453)\/etherscan\/api)\?/, (route) => {
    const u = new URL(route.request().url()), q = u.searchParams, a = lc(q.get('address')), base = /base\.|\/8453\//.test(u.hostname + u.pathname);
    hits.push(u.hostname + u.pathname + u.search);
    const from = Number(q.get('startblock') || q.get('fromBlock') || 0);
    let result = [];
    if (q.get('module') === 'logs') result = base ? [] : inRange(MAIN, { address: a, fromBlock: h(from), toBlock: 'latest' });
    else if (!base) result = (q.get('action') === 'txlist' ? TXS[a] || [] : a === POOLA ? INTERNAL : []).filter((t) => Number(t.blockNumber) >= from);
    return json(route, { status: result.length ? '1' : '0', message: result.length ? 'OK' : 'No records found', result });
  });
  // Base's nodes serve short ranges only, as they do live (the first read of its device pool goes to an explorer).
  await r.ctx.route(/^https:\/\/(mainnet\.base\.org|base-rpc\.publicnode\.com|rpc\.mainnet\.chain\.robinhood\.com)\/?/, (route) => {
    const b = JSON.parse(route.request().postData() || '{}'), url = route.request().url(), base = /base/.test(url);
    const reply = (result) => json(route, { jsonrpc: '2.0', id: b.id, result });
    if (b.method === 'eth_blockNumber') return reply(h(base ? BASE_HEAD : RH_HEAD));
    if (b.method === 'eth_getBalance') return reply(base ? h(5n * 10n ** 17n) : h(2n * 10n ** 17n));
    if (b.method !== 'eth_getLogs') return reply('0x0');
    const q = b.params[0], span = Number(BigInt(q.toBlock)) - Number(BigInt(q.fromBlock)) + 1;
    if (base && span > 2000) return json(route, { jsonrpc: '2.0', id: b.id, error: { code: -32000, message: /publicnode/.test(url) ? 'Archive requests require a personal token' : 'eth_getLogs is limited to a 2,000 range' } });
    return reply(base ? [] : inRange(rhLogs, q));
  });
  let snapshot = null;
  await r.ctx.route(/^https:\/\/api\.tacit\.finance\/stats/, (route) => (snapshot ? route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: snapshot }) : route.fulfill({ status: 404, body: '' })));
  await r.ctx.route(/^https:\/\/api\.tacit\.finance\/reflection\/status/, (route) => json(route, { attestedHeight: 969159, tipHeight: 969159, foldedCrossoutCount: 5, consumedCount: 2, liveNotes: 1234 }));
  await r.ctx.route(/^https:\/\/api\.tacit\.finance\/leaderboard/, (route) => json(route, [{ address: W1, points: 10 }, { address: W2, points: 20 }]));
  await r.ctx.route(/^https:\/\/(mempool\.space|blockstream\.info)\/api\/blocks\/tip\/height/, (route) => route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: '969200' }));
  // A card as "key | value | context".
  const card = async (k) => (await r.page.$$eval('.card', (cs) => cs.map((c) => ['.k', '.v', '.m'].map((x) => c.querySelector(x).textContent.replace(/\s+/g, ' ').trim()).join(' | ')))).find((t) => t.startsWith(k + ' |')) || '';
  try {
    await r.page.goto(r.url + 'stats/');
    await until(r.page, () => /^As of /.test(document.querySelector('#asof')?.textContent || '') && !/updating/.test(document.querySelector('#asof')?.textContent || ''), null, 120000)
      .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | asof: ${await text(r.page, '#asof')} | errors: ${r.errors.slice(0, 2).join(' | ')}`); });
    ok(!/some figures/.test(await text(r.page, '#asof')), `stats: every part read (${await text(r.page, '#asof')})`);
    const s = await card('Shielded');
    ok(/^Shielded \| 1\.5ETH \| 2 deposits/.test(s), `stats: ETH shielded in is the sum of the pool's ETH wraps (${s})`);
    ok(/^Wallets \| 2 \|/.test(await card('Wallets')), `stats: wallets are the senders of those wraps, however they reached the pool (${await card('Wallets')})`);
    ok(/^Withdrawn \| 0\.2ETH/.test(await card('Withdrawn')), `stats: withdrawn is what the pool paid out, whatever else came in (${await card('Withdrawn')})`);
    ok(await r.page.$eval('#f-eth', (f) => !f.hidden), 'stats: the ETH-over-time chart is drawn');
    const st = await card('Settles');
    ok(/^Settles \| 3 \| .*3 spent/.test(st), `stats: settles are the transactions that inserted or spent notes (${st})`);
    ok(/2 attestations/.test(await card('Proven to')), `stats: only successful attestations count (${await card('Proven to')})`);
    const cu = await card('cUSD borrowed');
    ok(/^cUSD borrowed \| 3\.5cUSD \| 2\.5 open on 1 loan · 1 repaid/.test(cu), `stats: cUSD borrowed, repaid and still out (${cu})`);
    const ad = await card('Airdrop claimed');
    ok(/^Airdrop claimed \| 60TAC \| 2 wallets/.test(ad), `stats: airdrop claims summed, claimers counted once (${ad})`);
    ok(/^TAC shielded \| 100TAC \| 1 deposit/.test(await card('TAC shielded')), `stats: TAC shielded (${await card('TAC shielded')})`);
    ok(/USDC 2\.5/.test(await card('Other shielded')) && /USDT 4\.63/.test(await card('Other shielded')), `stats: other assets are named from the pool's registry, or their token (${await card('Other shielded')})`);
    ok(await r.page.evaluate(() => [...document.querySelectorAll('.card .m a')].some((a) => /etherscan\.io\/token\/0xA1313eb9f3A445606D9583bcAc3ebeB56a858279#balances$/.test(a.href))), 'stats: TAC links to its ERC-20 holders on Etherscan');
    const pa = await card('Participants'), pp = await card('Points'), ta = await card('TAC allocated');
    ok(/^Participants \| 2 \|/.test(pa) && /^Points \| 30 \|/.test(pp) && /^TAC allocated \| [\d,]+TAC/.test(ta), `stats: points participants and totals from the leaderboard, TAC allocated from the distributor (${pa} | ${pp} | ${ta})`);
    const ac = await card('Cross-chain');
    ok(/\(5 folded\)/.test(ac) && /from Bitcoin/.test(ac), `stats: moves out to Bitcoin, with the reflection's folded count, and in from Bitcoin (${ac})`);
    const bl = await card('BTC locked'), bh = await card('Bonds');
    const cm = await card('cBTC minted');
    ok(/^BTC locked \| 0\.000007BTC \| 1 lock · 1 unlocked$/.test(bl) && /^cBTC minted \| 0\.000027cBTC \| 2 mints/.test(cm) && /on 2 locks$/.test(bh),
      `stats: BTC locked leaves out a lock since spent, cBTC minted counts every mint, bonds count the locks that hold one (${bl} | ${cm} | ${bh})`);
    const rows = await r.page.$$eval('#c-dev tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim())));
    const row = Object.fromEntries(rows.map((c) => [c[0].replace(/ ↗$/, ''), c]));
    ok(row.Ethereum?.[2] === '0.3 (1)' && row.Ethereum?.[3] === '0.11 (1)' && row.Ethereum?.[4] === '2' && row.Base?.[1] === '0.5' && row.Base?.[2] === '0 (0)'
      && row.Robinhood?.[1] === '0.2' && row.Robinhood?.[2] === '0.2 (1)', `stats: device pools per chain, deposits and withdrawals (with the relayer's fee) from their Transact events (${JSON.stringify(rows)})`);
    await shot(r.page, 'stats-desk');
    await r.page.setViewportSize({ width: 390, height: 900 });
    await r.page.emulateMedia({ colorScheme: 'dark' });
    await sleep(300);
    ok(await r.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'stats: nothing runs off the side of a phone screen');
    await shot(r.page, 'stats-phone-dark');
    await r.page.setViewportSize({ width: 1280, height: 1100 });
    await r.page.emulateMedia({ colorScheme: 'light' });
    const n = hits.length, nLogs = logReads.length;
    ok(n <= 3 && hits.every((q) => /txlist|base\.blockscout|\/8453\//.test(q)), `stats: a first reading asks the explorers only for the pool's two transaction lists and Base's first log read (${hits.join(' | ')})`);
    ok(new Set(hits.filter((q) => !/base|8453/.test(q)).map((q) => q.split('/')[0])).size === 2, 'stats: the two lists go to the two explorers in turn');
    ok(nLogs === 1, `stats: every Ethereum log in one request (${nLogs})`);
    const settled = () => until(r.page, () => /^As of /.test(document.querySelector('#asof')?.textContent || '') && !/updating/.test(document.querySelector('#asof')?.textContent || ''), null, 60000).catch(() => {});
    await r.page.reload();
    await settled();
    ok(hits.length === n && logReads.length === nLogs && /^Shielded \| 1\.5ETH/.test(await card('Shielded')), `stats: a second visit within the quarter hour shows the last reading and reads nothing (${hits.length - n} explorer, ${logReads.length - nLogs} log reads)`);
    await r.page.goto(r.url + 'stats/?fresh');
    await settled();
    const fresh = hits.slice(n);
    ok(fresh.length === 2 && fresh.every((q) => Number(new URLSearchParams(q.split('?')[1]).get('startblock')) > 0) && /^Shielded \| 1\.5ETH \| 2 deposits/.test(await card('Shielded')),
      `stats: a fresh reading reads on from what the last one kept, asking the explorers only for what is new (${fresh.join(' | ')})`);
    // The API's shared reading, when there is one, is all a visit needs.
    const kept = fromJsonText(await r.page.evaluate(() => localStorage.getItem('tacit-weld-stats-v3')));
    kept.at = Date.now(); kept.eth.inWei = { $n: String(9n * 10n ** 18n) }; delete kept.partial;
    snapshot = JSON.stringify(kept);
    await r.page.evaluate(() => localStorage.clear());
    const before = [hits.length, logReads.length];
    await r.page.goto(r.url + 'stats/');
    await settled();
    ok(/^Shielded \| 9ETH/.test(await card('Shielded')) && hits.length === before[0] && logReads.length === before[1],
      `stats: with the API's shared reading the page shows it and reads nothing itself (${await card('Shielded')} · ${hits.length - before[0]} explorer, ${logReads.length - before[1]} log reads)`);
    if (r.errors.length) { fails++; console.log('FAIL stats page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); await rpc('anvil_setStorageAt', [ENGINE, CUSD_SLOT, '0x' + word(cusdWas)]); }
});

// The dashboard paints what the page has read. A wallet holding 5 TAC, whose last visit here saw 2, reads +3.
await step('dash', async () => {
  const W = '0xd45b000000000000000000000000000000000d45', id = `tacit-lite-dash-v1:|${W}`, t0 = Date.now() - 2 * 86400e3;
  if ((await tacOf(W)) !== 5n * 10n ** 18n) await fundTac(W, 5n * 10n ** 18n - (await tacOf(W)));
  const seed = JSON.stringify({ at: t0, v: { tac: { v: String(2n * 10n ** 18n), at: t0 } } });
  const wide = (p) => p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  for (const [tag, viewport, colorScheme] of [['phone', { width: 390, height: 1000 }, 'light'], ['phone-dark', { width: 390, height: 1000 }, 'dark'], ['desk', { width: 1280, height: 1000 }, 'light'], ['desk-dark', { width: 1280, height: 1000 }, 'dark']]) {
    const r = await openPage({ account: W, viewport, colorScheme, init: { fn: ([k, v]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, arg: [id, seed] } });
    await r.ctx.route('https://api.tacit.finance/points/**', async (route) => { await sleep(3000); await route.continue(); });     // placeholders stay a moment
    try {
      await r.page.goto(r.url);
      await r.page.waitForSelector('.tile');
      if (tag === 'phone') { const w = await wide(r.page); ok(w.sw <= w.iw, `dash: the first paint at 390px has no sideways scroll (${w.sw} ≤ ${w.iw})`); }
      await shot(r.page, `first-paint-${tag}`);
      await go(r.page, '#buy');
      await r.page.click('#buy-connect');
      await until(r.page, () => !document.querySelector('#dash').hidden, null, 30000);
      await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
      const early = await r.page.evaluate(() => document.querySelectorAll('#dash .sk').length);
      if (tag === 'phone') await shot(r.page, 'dash-loading-phone');
      await until(r.page, () => /^5( TAC)?$/.test(document.querySelector('[data-dash-open="tac"] .di-v')?.textContent.trim() || ''), null, 60000);
      await until(r.page, () => !document.querySelector('#dash .sk'), null, 60000).catch(() => {});
      const tac = await r.page.$eval('[data-dash-open="tac"]', (b) => b.textContent.replace(/\s+/g, ' ').trim()), since = await text(r.page, '#dash-since');
      if (tag === 'phone') {
        ok(early > 0, `dash: a connected wallet's dashboard shows placeholders first (${early})`);
        ok(/\+3 · /.test(tac) && /since/.test(since), `dash: 5 TAC now, against 2 at the last visit, reads +3 (${tac} | ${since})`);
        ok(!!(await r.page.$('[data-dash-open="pts"]')) && !(await r.page.$('#dash .sk')), 'dash: then every placeholder gives way to a value');
        const w = await wide(r.page);
        ok(w.sw <= w.iw, `dash: still no sideways scroll at 390px with it showing (${w.sw})`);
      }
      await shot(r.page, `dash-${tag}`);
      if (r.errors.length) { fails++; console.log(`FAIL dash ${tag} page errors: ` + r.errors.slice(0, 3).join(' | ')); }
    } finally { await r.browser.close(); }
  }
  // An opened key: its private tETH, TAC and points, tETH a placeholder while its notes are read, each opening its sheet.
  const k = await openPage({ account: A0, key: K0, viewport: { width: 390, height: 1000 } });
  try {
    await k.page.goto(k.url);
    await pasteKey(k.page, 'da5b'.padEnd(64, '8'));
    await k.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await until(k.page, () => !document.querySelector('#dash').hidden, null, 30000);
    const cells = await k.page.$$eval('#dash .di', (b) => b.map((x) => x.dataset.dashOpen));
    ok(['private', 'tac', 'pts'].every((c) => cells.includes(c)) && !!(await k.page.$('#dash [data-dash-open="private"] .sk')), `dash: an opened key shows tETH, TAC and points, tETH as a placeholder while its notes are read (${cells.join(', ')})`);
    await shot(k.page, 'dash-key-phone');
    await k.page.click('#dash [data-dash-open="private"]');
    await k.page.waitForSelector('#sheet-eth[open]', { timeout: 15000 });
    ok(true, 'dash: an item opens its sheet');
    if (k.errors.length) { fails++; console.log('FAIL dash key page errors: ' + k.errors.slice(0, 3).join(' | ')); }
  } finally { await k.browser.close(); }
});

// A 20 TAC deposit made the way tacit.finance makes one (a router wrap with a TAC permit, from the key's Tacit account),
// whose settle never landed: weld finds it from the key, offers Finish on the TAC sheet and on the dashboard, and the
// settle it submits is the wrap rebuilt under TAC's own asset id and scale.
await step('tacdeposit', async () => {
  const hex = 'dec0de'.padEnd(64, '4'), acct = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(hex, 'hex'), 'mainnet').address;
  await rpc('anvil_setBalance', [acct, '0x' + (10n ** 17n).toString(16)]);
  await fundTac(acct, 20n * 10n ** 18n);
  const r = await openPage({ account: A0, key: K0 });
  try {
    await r.page.goto(r.url);
    await r.page.waitForSelector('.tile');
    const dep = await r.page.evaluate(async (h) => {
      const d = await import('/vendor/tacit-deps.min.js'), cd = await import('/confidential-deployments.js');
      cd.setActiveNetwork('mainnet');
      const { makeConfidentialPoolUx } = await import('/confidential-pool-ux.js');
      const ux = makeConfidentialPoolUx({ secp: d.secp, keccak256: d.keccak_256, sha256: d.sha256, network: 'mainnet' });
      const w = await ux.routerWrap({ walletPriv: d.hexToBytes(h), amountWei: (20n * 10n ** 18n).toString(), ticker: 'TAC', index: 0 });
      return { txHash: w.txHash, asset: w.wrapOp.asset, value: String(w.wrapOp.value) };
    }, hex);
    const landed = await chainUntil(async () => (await rpc('eth_getTransactionReceipt', [dep.txHash]))?.status === '0x1', 60000);
    ok(landed && dep.value === '2000000000', `tacdeposit: a 20 TAC deposit lands on the fork (${String(dep.txHash).slice(0, 12)}…, ${dep.value} units of ${dep.asset.slice(0, 10)}…)`);
    await pasteKey(r.page, hex);
    await go(r.page, '#tac');
    await r.page.waitForSelector('#tac-finish', { timeout: 1200000 });                  // once the key's notes are read
    const call = (await text(r.page, '#tac-bal .callout')).replace(/\s+/g, ' ').trim();
    ok(/^20 TAC is waiting to become private\./.test(call), `tacdeposit: the TAC sheet offers to finish it, counted once (${call})`);
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await until(r.page, () => /20 TAC is waiting/.test(document.querySelector('#dash-due')?.textContent || ''), null, 30000).catch(() => {});
    ok(/20 TAC is waiting to become private/.test(await text(r.page, '#dash-due')), 'tacdeposit: so does the dashboard');
    await shot(r.page, 'tacdeposit-dash');
    const n0 = submits.length;
    await r.page.click('#dash-due [data-dash-do="tac"]');                               // opens the TAC sheet and presses its Finish
    await until(r.page, () => /stubbed|err/i.test(document.querySelector('#tac-bal-status')?.innerHTML || ''), null, 120000).catch(() => {});
    ok(/Finishing a 20 TAC deposit did not go through: Stubbed in the fork check/.test(await text(r.page, '#tac-bal-status')), `tacdeposit: the sheet's line sums up the Finish once its settle has ended (${await text(r.page, '#tac-bal-status')})`);
    const subs = submits.slice(n0).filter((s) => s.type === 'wrap');
    ok(subs.length === 1 && String(subs[0].op?.asset).toLowerCase() === dep.asset.toLowerCase() && String(subs[0].op?.value) === dep.value,
      `tacdeposit: Finish submits one wrap, rebuilt under TAC's asset and scale (${subs.length} submitted, value ${subs[0]?.op?.value})`);
    await openActivity(r.page);
    ok(/Finish a 20 TAC deposit/.test(await text(r.page, '#act-body')), 'tacdeposit: the settle shows in Activity');
    if (r.errors.length) { fails++; console.log('FAIL tacdeposit page errors: ' + r.errors.slice(0, 3).join(' | ')); }
  } finally { await r.browser.close(); }
});

// A walk through every sheet and its main states for design review: one screenshot each, at phone and desktop widths
// and in the dark scheme too. Opt-in (`tour`), and it writes to SHOTS.
await step('tour', async () => {
  if (!SHOTS) throw new Error('the tour needs SHOTS=<dir>');
  const other = tacit1('b0b'.padEnd(64, '5'));
  const loaded = (p, sel, ms = 180000) => p.waitForFunction((s) => { const e = document.querySelector(s); return !!e && !/reading…|Reading|Finding|Checking/.test(e.textContent) && !e.querySelector('.sk'); }, sel, { timeout: ms }).catch(() => {});
  const shown = (p, sel, ms = 60000) => p.waitForSelector(sel, { timeout: ms }).catch(() => {});
  for (const [tag, viewport, colorScheme] of [['phone', { width: 390, height: 1400 }, 'light'], ['desk', { width: 1280, height: 1200 }, 'light'], ['phone-dark', { width: 390, height: 1400 }, 'dark']]) {
    const r = await openPage({ account: A0, key: K0, viewport, colorScheme });
    const p = r.page, snap = async (name) => { await p.waitForTimeout(1500); await p.screenshot({ path: join(SHOTS, `${tag}-${name}.png`), fullPage: true }); };
    await p.goto(r.url);
    await p.waitForSelector('.tile'); await snap('home');
    await go(p, '#wallet'); await p.waitForSelector('#wallet-body [data-in]'); await snap('wallet-signin');
    await p.click('#wallet-body [data-in="eth"]'); await until(p, () => !!document.querySelector('#wallet-dot.on'), null, 120000);
    await go(p, '#wallet'); await p.waitForSelector('#wallet-body .who'); await snap('wallet');
    await p.click('[data-wal="out"]'); await snap('wallet-send-out');
    await go(p, '#private'); await p.waitForSelector('#w-amt', { timeout: 120000 }); await p.fill('#w-amt', '0.05'); await loaded(p, '#eth-v1 .bal'); await shown(p, '#w-rcpt:not([hidden])'); await snap('eth-wrap');
    await p.click('[data-v1="send"]'); await p.fill('#s-to', other); await p.fill('#s-amt', '0.01'); await shown(p, '#s-rcpt:not([hidden])'); await snap('eth-send');
    await p.click('[data-v1="out"]'); await p.fill('#o-to', A0); await p.fill('#o-amt', '0.01'); await shown(p, '#o-rcpt:not([hidden])'); await snap('eth-withdraw');
    await p.click('[data-eth-mode="dev"]'); await shown(p, '[data-dev]'); await loaded(p, '#eth-dev .bal'); await snap('device-deposit');
    for (const m of ['send', 'out', 'receive']) { await p.click(`[data-dev="${m}"]`); await snap(`device-${m}`); }
    await go(p, '#btc'); await shown(p, '#bt-to', 120000); await loaded(p, '#btc-body .bal'); await p.fill('#bt-to', other).catch(() => {}); await p.fill('#bt-amt', '0.001').catch(() => {}); await shown(p, '#bt-rcpt:not([hidden])'); await snap('btc-send');
    await p.click('[data-btcm="receive"]'); await snap('btc-receive');
    await go(p, '#airdrop'); await shown(p, '#air-body .gate'); await snap('tac-airdrop');
    await p.click('[data-tac-mode="buy"]'); await p.fill('#b-amt', '0.01'); await shown(p, '#b-rcpt:not([hidden])'); await snap('tac-buy');
    await go(p, '#pts'); await shown(p, '#wei-name'); await shown(p, '#pts-body .pt', 120000); await p.fill('#wei-name', 'tacitlite'); await shown(p, '#wei-rcpt:not([hidden])'); await snap('points');
    await go(p, '#farm'); await shown(p, '#pf-amt', 120000); await p.fill('#pf-amt', '0.05'); await shown(p, '#pf-rcpt:not([hidden])'); await snap('farm-precision');
    const pid = await p.$('[data-farm^="pid"] > button');
    if (pid) { await pid.click(); await snap('farm-shielded'); }
    await go(p, '#borrow'); await shown(p, '#borrow-body .steps', 180000); await snap('borrow');
    await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    for (const a of ['tac', 'cbtc']) { await p.click(`.shelf [data-asset="${a}"]`); await shown(p, '#asset-card[open] .links'); await snap(`card-${a}`); await p.keyboard.press('Escape'); }
    if (r.errors.length) console.log(`   ${tag} page errors: ${r.errors.slice(0, 3).join(' | ')}`);
    await r.browser.close();
  }
  ok(true, `tour: screenshots in ${SHOTS}`);
});
if (ACCT) await ACCT.r.browser.close();

if (main.errors.length) { fails++; console.log('FAIL page errors:\n  ' + main.errors.slice(0, 8).join('\n  ')); }
console.log(fails ? `${fails} failed` : 'all passed');
await main.browser.close(); server.close(); anvil.kill('SIGKILL');
process.exit(fails ? 1 : 0);
