// Checks dapp/pay/index.html in a real browser.
//   live   read-only against mainnet: the page loads under its pinned CSP, a pasted key reads all three chains, the
//          history rebuilt from the key alone matches each chain's balance, forms refuse what they should, a payment
//          link fills Send, and a sample payment is proved and verified in the page's worker
//   relay  (opt-in, spends funds) KEY pays KEY2 privately on mainnet through the relay; KEY2's key alone finds it
//   fork   an anvil fork of Base: deposit from a wallet, send privately and withdraw part, all proved in the page and
//          sent by the wallet (no relay), then the history rebuilt from chain logs names all three
//   PLAYWRIGHT=<path to playwright-core> KEY=<64-hex Tacit key with history> [PAGE=<url>] node tools/pay-check.mjs [live,fork]   (SHOTS=<dir>)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const ONLY = new Set((process.argv[2] || 'live,fork').split(','));
const SHOTS = process.env.SHOTS || null;
const WEB = 21000 + Math.floor(Math.random() * 2000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) failed++; };

const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.zkey': 'application/octet-stream' };
const server = createServer((req, res) => {
  let f = normalize(join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  const body = readFileSync(f);
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'content-length': body.length });
  res.end(body);
}).listen(WEB);
const URL_ = process.env.PAGE || `http://127.0.0.1:${WEB}/pay/`;   // PAGE=https://tacit.finance/pay/ checks the deployed page

async function page(browser, { viewport = { width: 1280, height: 900 }, colorScheme = 'light', init = null, route = null } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme });
  if (init) await ctx.addInitScript(init);
  if (route) await route(ctx);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|blocked by CORS policy/.test(m.text())) errors.push(m.text()); });
  return { ctx, p, errors };
}
const openKey = async (p, key) => {
  await p.click('#g-in [data-in="paste"]');
  await p.fill('#g-hex', key);
  await p.click('#g-in [data-in="key"]');
  await p.waitForSelector('#tabs:not([hidden])');
};
const shot = async (p, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: join(SHOTS, name + '.png'), fullPage: true }); };

const browser = await chromium.launch();
try {
  if (ONLY.has('live')) {
    console.log('live');
    const KEY = process.env.KEY;
    for (const [name, vp, cs] of [['desktop', { width: 1280, height: 900 }, 'light'], ['phone', { width: 390, height: 844 }, 'light'], ['phone-dark', { width: 390, height: 844 }, 'dark']]) {
      const { ctx, p, errors } = await page(browser, { viewport: vp, colorScheme: cs });
      await p.goto(URL_);
      await p.waitForSelector('#g-in');
      ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: no sideways scroll`);
      await shot(p, `gate-${name}`);
      ok(!errors.length, `${name}: no page errors ${errors.join(' | ')}`);
      await ctx.close();
    }
    const { ctx, p, errors } = await page(browser);
    await p.goto(URL_ + '#pay=bp1qqqq&amount=0.01&chain=robinhood');
    await p.waitForSelector('#g-in');
    ok(await p.evaluate(() => document.querySelector('#chains [aria-selected="true"]').textContent.startsWith('Robinhood')), 'payment link picks the chain');
    if (KEY) {
      await openKey(p, KEY);
      ok(await p.evaluate(() => document.querySelector('#tabs [aria-selected="true"]').textContent === 'Send'), 'payment link opens Send');
      ok((await p.inputValue('#f-to')) === 'bp1qqqq' && (await p.inputValue('#f-amt')) === '0.01', 'payment link fills Send');
      await p.waitForFunction(() => document.querySelectorAll('#chains small .sk').length === 0, null, { timeout: 180e3 });
      const bals = await p.$$eval('#chains small', (x) => x.map((e) => e.textContent));
      ok(bals.length === 3 && bals.every((b) => /ETH|—/.test(b)), `three chain balances read: ${bals.join(' · ')}`);
      await p.waitForFunction(() => !/rebuilding/.test(document.querySelector('#recover-at').textContent), null, { timeout: 300e3 });
      const sums = await p.$$eval('.chainsum li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
      console.log('    ' + sums.join('\n    '));
      ok(sums.every((s) => /matches|0 ETH/.test(s)), 'history rebuilt from the key matches every chain’s balance');
      const rows = await p.$$eval('.rows li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
      console.log('    ' + rows.slice(0, 8).join('\n    '));
      ok(rows.length > 0, `history rows: ${rows.length}`);
      // Send refuses what is not a pool address.
      await p.fill('#f-to', '0x' + '11'.repeat(20)); await sleep(300);
      ok(/Use Withdraw/.test(await p.textContent('#f-rcpt')), 'send: an 0x address points to Withdraw');
      await p.fill('#f-to', 'tacit1qqqqqqqq'); await sleep(300);
      ok(/tacit1 address/.test(await p.textContent('#f-rcpt')), 'send: a tacit1 address is explained');
      const own = await p.evaluate(() => document.querySelector('#wallet-label').textContent);
      ok(/^bp1/.test(own), 'wallet chip shows the pool address');
      // Withdraw: a partial amount shows what stays private.
      await p.click('#tabs [data-tab="withdraw"]');
      await p.click('#chains [data-chain="8453"]');
      await p.waitForSelector('#f-wto');
      await p.fill('#f-wto', '0x' + '22'.repeat(20)); await p.fill('#f-wamt', '0.000001'); await sleep(500);
      const rc = await p.textContent('#f-rcpt');
      ok((/Arrives/.test(rc) && /Stays private/.test(rc)) || /More than/.test(rc), `withdraw receipt: ${rc.replace(/\s+/g, ' ').trim()}`);
      await p.click('#tabs [data-tab="receive"]');
      ok(/^bp1/.test(await p.textContent('.addr code')), 'receive shows the pool address');
      await shot(p, 'key-desktop');
    }
    // A sample payment, proved and verified in the worker (downloads the ceremony key from this server).
    const t0 = Date.now();
    await p.click('#device-try');
    await p.waitForSelector('.proof b', { timeout: 600e3 });
    ok(/s$/.test(await p.textContent('.proof b')), `sample proof: ${await p.textContent('.proof b')} (${Math.round((Date.now() - t0) / 1000)} s with key load)`);
    ok(!errors.length, `no page errors ${errors.join(' | ')}`);
    await shot(p, 'proved-desktop');
    await ctx.close();
  }

  if (ONLY.has('relay')) {
    // A real relayed private payment on mainnet: KEY pays KEY2 AMT ETH on CHAIN through the relay, then KEY2's key
    // alone finds it. Spends real (tiny) funds; never part of the default run.
    console.log('relay (mainnet, spends funds)');
    const { ctx, p, errors } = await page(browser, { init: `localStorage.setItem('tacit-pay-chain-v1', JSON.stringify(${JSON.stringify(process.env.CHAIN || 'robinhood')}))` });
    await p.goto(URL_);
    await p.waitForSelector('#g-in');
    await openKey(p, process.env.KEY2);
    await p.click('#tabs [data-tab="receive"]');
    const to = (await p.textContent('.addr code')).trim();
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await openKey(p, process.env.KEY);
    await p.click('#tabs [data-tab="send"]');
    await p.waitForFunction(() => !document.querySelector('#chains [aria-selected="true"] .sk'), null, { timeout: 180e3 });
    await p.fill('#f-to', to); await p.fill('#f-amt', process.env.AMT || '0.00001');
    await p.waitForFunction(() => !document.querySelector('#f-go').disabled, null, { timeout: 60e3 });
    console.log('    ' + (await p.textContent('#f-rcpt')).replace(/\s+/g, ' ').trim());
    const t0 = Date.now();
    await p.click('#f-go');
    await p.waitForFunction(() => /Sent/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 900e3 });
    ok(/Sent/.test(await p.textContent('#status')), `relayed private send (${Math.round((Date.now() - t0) / 1000)} s): ${(await p.textContent('#status')).trim()}`);
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await openKey(p, process.env.KEY2);
    await p.waitForFunction(() => [...document.querySelectorAll('.rows li')].some((l) => /Received privately/.test(l.textContent)) && !/rebuilding/.test(document.querySelector('#recover-at').textContent), null, { timeout: 300e3 }).catch(() => {});
    const rows = await p.$$eval('.rows li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    console.log('    ' + rows.join('\n    '));
    ok(rows.some((r) => /^Received privately/.test(r) && /just now|min ago/.test(r)), 'the recipient’s key alone finds the payment');
    await shot(p, 'relay-recipient');
    ok(!errors.length, `no page errors ${errors.join(' | ')}`);
    await ctx.close();
  }

  if (ONLY.has('fork')) {
    console.log('fork (Base)');
    const PORT = WEB + 1, ANVIL = `http://127.0.0.1:${PORT}`;
    const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', process.env.BASE_RPC || 'https://mainnet.base.org', '--chain-id', '8453', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
    process.on('exit', () => anvil.kill('SIGKILL'));
    const rpc = async (method, params = []) => { const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw new Error(r.error.message); return r.result; };
    for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }
    const ACCT = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
    // anvil's default keys carry delegation code on real chains; start from a plain EOA.
    await rpc('anvil_setCode', [ACCT, '0x']);
    await rpc('anvil_setBalance', [ACCT, '0x' + (10n ** 18n).toString(16)]);
    await rpc('anvil_autoImpersonateAccount', [true]);
    const route = async (ctx) => {
      await ctx.route(/mainnet\.base\.org|base\.drpc\.org/, async (r) => {
        const body = r.request().postData();
        let text;
        try { text = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text(); }
        catch (e) { text = JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body || '{}').id ?? 1, error: { code: -32000, message: `fork: ${e.message}` } }); }
        await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: text }).catch(() => {});
      });
      await ctx.route(/tacit-evm-pool-keeper/, (r) => r.fulfill({ status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"stubbed"}' }));
    };
    const init = `(() => {
      const ANVIL = 'https://mainnet.base.org', ACCT = ${JSON.stringify(ACCT)};   // routed to the fork; the page's CSP allows only its own hosts
      let chain = '0x2105';
      const call = async (method, params) => { const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw Object.assign(new Error(r.error.message), r.error); return r.result; };
      window.ethereum = { isMetaMask: true, on() {}, removeListener() {}, request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCT];
        if (method === 'eth_chainId') return chain;
        if (method === 'wallet_switchEthereumChain') { chain = params[0].chainId; return null; }
        if (method === 'eth_sendTransaction') { const h = await call('eth_sendTransaction', [{ ...params[0], from: ACCT }]); return h; }
        return call(method, params || []);
      } };
      localStorage.setItem('tacit-pay-chain-v1', '8453');
      localStorage.setItem('tacit-pay-route-v1', JSON.stringify({ send: 'wallet', withdraw: 'wallet' }));
    })();`;
    const { ctx, p, errors } = await page(browser, { init, route });
    await p.goto(URL_);
    const key = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const other = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await p.waitForSelector('#g-in');
    // The other key's pool address, read by opening it first.
    await openKey(p, other);
    await p.click('#tabs [data-tab="receive"]');
    const otherBp = await p.textContent('.addr code');
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await openKey(p, key);
    await p.click('#rc-chain');
    await p.evaluate(() => document.querySelector('#wallet-label').click()); await p.click('#w-conn'); await p.click('#sheet-wallet [data-close]');
    await p.click('#tabs [data-tab="deposit"]');
    await p.fill('#f-amt', '0.01');
    const t0 = Date.now();
    await p.click('#f-go');
    await p.waitForFunction(() => /Deposited/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
    ok(/Deposited/.test(await p.textContent('#status')), `deposit from the wallet, proved here (${Math.round((Date.now() - t0) / 1000)} s): ${(await p.textContent('#status')).trim()}`);
    await p.waitForFunction(() => /0\.01/.test(document.querySelector('#bal .v').textContent), null, { timeout: 120e3 }).catch(() => {});
    ok(/0\.01/.test(await p.textContent('#bal .v')), `private balance: ${await p.textContent('#bal .v')}`);
    await p.click('#tabs [data-tab="send"]');
    await p.fill('#f-to', otherBp); await p.fill('#f-amt', '0.004'); await sleep(800);
    await p.click('#f-go');
    await p.waitForFunction(() => /Sent/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
    ok(/Sent/.test(await p.textContent('#status')), `private send from the wallet: ${(await p.textContent('#status')).trim()}`);
    await p.click('#tabs [data-tab="withdraw"]');
    await p.fill('#f-wto', '0x' + '33'.repeat(20)); await p.fill('#f-wamt', '0.002'); await sleep(800);
    await p.click('#f-go');
    await p.waitForFunction(() => /Withdrew/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
    ok(/Withdrew/.test(await p.textContent('#status')), `partial withdrawal from the wallet: ${(await p.textContent('#status')).trim()}`);
    ok(BigInt(await rpc('eth_getBalance', ['0x' + '33'.repeat(20), 'latest'])) >= 2n * 10n ** 15n, 'the address received 0.002 ETH');
    await p.waitForFunction(() => /0\.004/.test(document.querySelector('#bal .v').textContent), null, { timeout: 120e3 }).catch(() => {});
    ok(/^0\.004$/.test((await p.textContent('#bal .v')).trim()), `0.004 stays private: ${await p.textContent('#bal .v')}`);
    await p.click('#rc-go');
    await p.waitForFunction(() => document.querySelectorAll('.rows li').length >= 3 && !/rebuilding/.test(document.querySelector('#recover-at').textContent), null, { timeout: 900e3 })
      .catch(async (e) => { console.log('    ' + (await p.textContent('#recover-body')).replace(/\s+/g, ' ')); throw e; });
    const rows = await p.$$eval('.rows li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    console.log('    ' + rows.join('\n    '));
    ok(rows.some((r) => /^Deposited ?\+0\.01 ETH/.test(r)) && rows.some((r) => /^Sent privately ?−0\.004 ETH.*kept 0\.006/.test(r)) && rows.some((r) => /^Withdrew to 0x3333…3333 ?−0\.002 ETH.*kept 0\.004/.test(r)), 'rebuilt history names the deposit, the private payment and the withdrawal');
    ok(/matches/.test(await p.$eval('.chainsum li:nth-child(2)', (e) => e.textContent)), 'rebuilt balance matches');
    // The recipient's key alone finds the payment.
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await openKey(p, other);
    await p.waitForFunction(() => document.querySelectorAll('.rows li').length >= 1, null, { timeout: 900e3 });
    const theirs = await p.$$eval('.rows li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    ok(theirs.some((r) => /^Received privately ?\+0\.004 ETH/.test(r)), `the recipient’s key finds it: ${theirs[0]}`);
    await shot(p, 'fork-after');
    ok(!errors.length, `no page errors ${errors.join(' | ')}`);
    await ctx.close();
    anvil.kill('SIGKILL');
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
