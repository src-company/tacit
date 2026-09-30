// Checks dapp/pay/index.html in a real browser.
//   live   read-only against mainnet: the page loads under its pinned CSP, a pasted key reads all three chains, the
//          history rebuilt from the key alone matches each chain's balance, forms refuse what they should, a payment
//          link fills Send, and a sample payment is proved and verified in the page's worker
//   relay  (opt-in, spends funds) KEY pays KEY2 privately on mainnet through the relay; KEY2's key alone finds it
//   fork   an anvil fork of Base: deposit from a wallet, send privately and withdraw part, all proved in the page and
//          sent by the wallet (no relay), then the history rebuilt from chain logs names all three
//   anyone the same fork with a real keeper relaying: pay an 0x address now, or hold it until it blends in (after a
//          deposit made for it when the balance is short); save a name for an address; pay by link, taken by a keyless
//          recipient to their address and into another key's private balance, or taken back; the links found again
//          from the key alone
//   PLAYWRIGHT=<path to playwright-core> KEY=<64-hex Tacit key with history> [PAGE=<url>] node tools/pay-check.mjs [live,fork]   (SHOTS=<dir>)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const ONLY = new Set((process.argv[2] || 'live,fork,anyone').split(','));
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
  const ctx = await browser.newContext({ viewport, colorScheme, permissions: ['clipboard-read', 'clipboard-write'] });
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
// The Receive tab's QR code, drawn to a canvas in the page, decoded here when jsQR is installed (JSQR=<its path>).
let jsQR = null;
try { jsQR = require(process.env.JSQR || 'jsqr'); } catch {}
async function readQr(p) {
  if (!jsQR) return null;
  const { w, px } = await p.evaluate(async () => {
    const svg = document.querySelector('#f-qr svg'), w = 600, img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: w, height: w }), g = c.getContext('2d');
    g.imageSmoothingEnabled = false; g.drawImage(img, 0, 0, w, w);
    return { w, px: [...g.getImageData(0, 0, w, w).data] };
  });
  return jsQR(Uint8ClampedArray.from(px), w, w)?.data ?? '';
}
const getPaidLink = async (p, amount, note) => {
  await p.click('#tabs [data-tab="receive"]');
  await p.waitForSelector('#f-link:not([disabled])', { timeout: 900e3 });
  await p.fill('#f-ramt', amount); await p.fill('#f-rfor', note); await sleep(300);
  await p.click('#f-link');
  return p.evaluate(() => navigator.clipboard.readText());
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
      // Send pays an 0x address (as a withdrawal to it, or a deposit first and the payment held) and refuses the pool's own.
      await p.fill('#f-amt', '0.00001'); await p.fill('#f-to', '0x' + '11'.repeat(20));
      await p.waitForFunction(() => /Arrives|Two steps/.test(document.querySelector('#f-rcpt').textContent), null, { timeout: 60e3 }).catch(() => {});
      ok(/Arrives|Two steps keep this private/.test(await p.textContent('#f-rcpt')), `send: an 0x address is paid: ${(await p.textContent('#f-rcpt')).replace(/\s+/g, ' ').trim().slice(0, 80)}`);
      await p.fill('#f-to', '0x000000c2A20657CE25f2Ba99737933D031AFBEE9'); await sleep(300);
      ok(/cannot receive a payment/.test(await p.textContent('#f-rcpt')), 'send: the pool’s own address is refused');
      await p.fill('#f-amt', '');
      // A tacit1 from before the pool lane is explained; a unified one pays its pool address; a name without a record says so.
      const OLD = 'tacit1qqps9xyupdmvk43ew87un0hnrmqxcdtq7vjf6mhfuhvrc4mz2ktwqhm0qdk5lnmv6yyy73yd0mccau2em5n66y5a0pyh3xfuhzwmf8g39kctxq5cns9hdj6k89clmjd77v0vqmp4vrejf8twa8jas0zhvf2edczlduk6e0c7';
      const UNI = 'tacit1qqrs9xyupdmvk43ew87un0hnrmqxcdtq7vjf6mhfuhvrc4mz2ktwqhm0qdk5lnmv6yyy73yd0mccau2em5n66y5a0pyh3xfuhzwmf8g39kctxq5cns9hdj6k89clmjd77v0vqmp4vrejf8twa8jas0zhvf2edczldupxsdkdfvdwck5vqnkn28cnyq3sxsrl7myfdwua48xq0zsc4dsrlsrlklwss3n6mv4vqkqkq8d5qrj6e6hgt34qmnmh4m8vayny376ryzlgcw47etgmm9cugrjtxwwkj6e267hm5qgc62yyyupg0j62zpafjgjz2hf';
      await p.click('#chains [data-chain="8453"]'); await p.waitForSelector('#f-to');
      await p.fill('#f-to', OLD); await sleep(600);
      ok(/before pool payments/.test(await p.textContent('#f-rcpt')), 'send: a tacit1 from before the pool lane is explained');
      await p.fill('#f-amt', '0.00001'); await p.fill('#f-to', UNI);
      await p.waitForFunction(() => /→ bp1q/.test(document.querySelector('#f-rcpt').textContent) || /More than/.test(document.querySelector('#f-rcpt').textContent), null, { timeout: 30e3 }).catch(() => {});
      ok(/To\s*tacit1qqrs9.*→ bp1qf5rd/.test((await p.textContent('#f-rcpt')).replace(/\s+/g, ' ')) || /More than/.test(await p.textContent('#f-rcpt')), `send: a unified tacit1 pays its pool address: ${(await p.textContent('#f-rcpt')).replace(/\s+/g, ' ').trim().slice(0, 90)}`);
      await p.fill('#f-to', 'nobody-tacit-pay-check.wei');
      await p.waitForFunction(() => /has not published|could not|refus|no record/i.test(document.querySelector('#f-rcpt').textContent), null, { timeout: 30e3 }).catch(() => {});
      ok(/has not published/i.test(await p.textContent('#f-rcpt')), `send: a name without a record says so: ${(await p.textContent('#f-rcpt')).trim().slice(0, 90)}`);
      await p.fill('#f-amt', '');
      const own = await p.evaluate(() => document.querySelector('#wallet-label').textContent);
      ok(/^bp1/.test(own), 'wallet chip shows the pool address');
      // Withdraw: a partial amount shows what stays private.
      await p.click('#tabs [data-tab="withdraw"]');
      await p.click('#chains [data-chain="8453"]');
      await p.waitForSelector('#f-wto');
      await p.fill('#f-wto', '0x' + '22'.repeat(20)); await p.fill('#f-wamt', '0.000001'); await sleep(500);
      await p.waitForFunction(() => document.querySelector('.pv-h') || /More than/.test(document.querySelector('#f-rcpt').textContent), null, { timeout: 180e3 }).catch(() => {});
      const rc = await p.textContent('#f-rcpt');
      if (/Arrives/.test(rc)) ok(/Blends in well|Could blend in better|Easy to link to you/.test(rc) && /hides among \d+ notes from \d+ deposits/.test(rc), `withdraw privacy check: ${(await p.textContent('.pv')).replace(/\s+/g, ' ').trim().slice(0, 160)}`);
      ok((/Arrives/.test(rc) && /Stays private/.test(rc)) || /More than/.test(rc), `withdraw receipt: ${rc.replace(/\s+/g, ' ').trim()}`);
      const link = await getPaidLink(p, '0.01', 'coffee & cake');
      ok(/#pay=bp1[a-z0-9]+&n=[0-9a-f]{64}&amount=0\.01&chain=base&for=coffee/.test(link), `payment link: ${link.slice(0, 60)}…${link.slice(-50)}`);
      const q = await readQr(p);
      ok(q === null || q === link, q === null ? 'QR present (install jsqr to decode it)' : 'the QR code decodes to the same link');
      ok(/^bp1/.test(await p.textContent('.addr code')), 'receive shows the pool address');
      await shot(p, 'key-desktop');
      const r = await page(browser, { viewport: { width: 390, height: 844 } });
      await r.p.goto(link.replace(/^https?:\/\/[^/]+/, new URL(URL_).origin));
      await r.p.waitForSelector('#req:not([hidden])');
      const card = (await r.p.textContent('#req')).replace(/\s+/g, ' ');
      ok(/0\.01 ETH/.test(card) && /on Base/.test(card) && /coffee & cake/.test(card) && await r.p.$('#req-wallet') && await r.p.$('#req-priv'), `request card: ${card.slice(0, 120)}`);
      await r.p.click('#req-priv');
      ok((await r.p.inputValue('#g-hex').catch(() => '')) === '' && await r.p.$('#g-in'), 'pay privately without a wallet asks to open one');
      await shot(r.p, 'request-phone');
      ok(!r.errors.length, `request page: no page errors ${r.errors.join(' | ')}`);
      await r.ctx.close();
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
    await p.waitForSelector('details.adv');
    await p.evaluate(() => { const d = document.querySelector('details.adv'); d.open = true; d.dispatchEvent(new Event('toggle')); });
    await p.click('#rc-chain');
    await p.evaluate(() => document.querySelector('#wallet-label').click()); await p.click('#w-conn'); await p.click('#sheet-wallet [data-close]');
    await p.click('#tabs [data-tab="deposit"]');
    await p.fill('#f-damt', '0.01');
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
    await p.waitForSelector('.pv-h', { timeout: 900e3 });
    ok(/Could blend in better/.test(await p.textContent('.pv')) && /wallet shows as the one sending/.test(await p.textContent('.pv')) && /since yours/.test(await p.textContent('.pv')), `privacy check before a wallet-sent withdrawal: ${(await p.textContent('.pv')).replace(/\s+/g, ' ').trim().slice(0, 140)}`);
    await p.click('#f-go');
    await p.waitForFunction(() => /Withdrew/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
    ok(/Withdrew/.test(await p.textContent('#status')), `partial withdrawal from the wallet: ${(await p.textContent('#status')).trim()}`);
    ok(BigInt(await rpc('eth_getBalance', ['0x' + '33'.repeat(20), 'latest'])) >= 2n * 10n ** 15n, 'the address received 0.002 ETH');
    await p.waitForFunction(() => /0\.004/.test(document.querySelector('#bal .v').textContent), null, { timeout: 120e3 }).catch(() => {});
    ok(/^0\.004$/.test((await p.textContent('#bal .v')).trim()), `0.004 stays private: ${await p.textContent('#bal .v')}`);
    // Deposit straight into someone else's private balance, from the wallet, proved here.
    await p.click('#tabs [data-tab="deposit"]'); await p.click('[data-dep="wallet"]');
    await p.fill('#f-damt', '0.001'); await p.fill('#f-dto', otherBp);
    await p.waitForFunction(() => /Into their private balance/.test(document.querySelector('#f-rcpt').textContent), null, { timeout: 60e3 });
    await p.click('#f-go');
    await p.waitForFunction(() => /into their private balance/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
    ok(/into their private balance/.test(await p.textContent('#status')), `deposit to someone else, from the wallet: ${(await p.textContent('#status')).trim()}`);
    ok(/^0\.004$/.test((await p.textContent('#bal .v')).trim()), 'the depositor’s own private balance is untouched');
    await p.evaluate(() => { const d = document.querySelector('details.adv'); d.open = true; d.dispatchEvent(new Event('toggle')); });
    await p.click('#rc-go');
    await p.waitForFunction(() => document.querySelectorAll('.rows li').length >= 3 && !/rebuilding/.test(document.querySelector('#recover-at').textContent), null, { timeout: 900e3 })
      .catch(async (e) => { console.log('    ' + (await p.textContent('#recover-body')).replace(/\s+/g, ' ')); throw e; });
    const rows = await p.$$eval('.rows li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    console.log('    ' + rows.join('\n    '));
    ok(rows.some((r) => /^Shielded in ?\+0\.01 ETH/.test(r)) && rows.some((r) => /^Sent privately ?−0\.004 ETH.*kept 0\.006/.test(r)) && rows.some((r) => /^Withdrew to 0x3333…3333 ?−0\.002 ETH.*kept 0\.004/.test(r)), 'rebuilt history names the deposit, the private payment and the withdrawal');
    // The balance is read again beside the history; the two agree once both are in.
    await p.waitForFunction(() => /matches/.test(document.querySelector('.chainsum li:nth-child(2)')?.textContent || ''), null, { timeout: 180e3 }).catch(() => {});
    ok(/matches/.test(await p.$eval('.chainsum li:nth-child(2)', (e) => e.textContent)), 'rebuilt balance matches');
    // The sender proves the private payment; anyone with the recipient's address can check it, and only against that address.
    await p.click('[data-proof]');
    const proofLink = await p.evaluate(() => navigator.clipboard.readText());
    const q = await ctx.newPage();
    await q.goto(proofLink.replace(/^https?:\/\/[^/]+/, new URL(URL_).origin));
    await q.waitForSelector('#pf-to');
    const check = async (addr) => { await q.fill('#pf-to', addr); await q.click('#pf-go'); await q.waitForFunction(() => /This transaction paid|was not to|err/.test(document.querySelector('#pf-status').innerHTML), null, { timeout: 120e3 }); return (await q.textContent('#pf-status')).trim(); };
    const right = await check(otherBp);
    ok(/paid 0\.004 ETH privately/.test(right), `a payment proof checks out for its recipient: ${right}`);
    const wrong = await check('bp1qf5rdn2trtk94rqya5637yeqyvp5qllkeztth8dfesrc5x9tvqluqlahm5yyv7km9tq9s9spmdqqukkw46zudgxu7aawem8fyey0kseqh6xr40k26x7ew8zqujenn45kk2kh47aqzxxj3pp8q2rukjss02vszf7eaa');
    ok(/was not to/.test(wrong), `and proves nothing about another address: ${wrong}`);
    await q.close();
    // The recipient's key alone finds the payment.
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await openKey(p, other);
    await p.waitForFunction(() => document.querySelectorAll('.rows li').length >= 1, null, { timeout: 900e3 });
    const theirs = await p.$$eval('.rows li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    ok(theirs.some((r) => /^Received privately ?\+0\.004 ETH/.test(r)), `the recipient’s key finds it: ${theirs[0]}`);
    // Get paid by someone with only an ordinary wallet: they pay the request link; the payee takes it in.
    const link = await getPaidLink(p, '0.003', 'fork test');
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await p.goto(link.replace(/^https?:\/\/[^/]+/, new URL(URL_).origin));
    await p.waitForSelector('#req-wallet');
    await p.click('#req-wallet');
    await p.waitForFunction(() => /Moving into their private balance|now in their/.test(document.querySelector('#req').textContent) || document.querySelector('#req .err'), null, { timeout: 180e3 });
    ok(/Paid 0\.003 ETH/.test(await p.textContent('#req')), `paid from a wallet, no Tacit key: ${(await p.textContent('#req')).replace(/\s+/g, ' ').trim()}`);
    await p.click('#chains [data-chain="1"]'); await p.click('#chains [data-chain="8453"]');
    ok(!(await p.$('#req-wallet')) && /Paid 0\.003 ETH/.test(await p.textContent('#req')), 'a paid request stays paid across redraws (no second pay button)');
    await p.click('#req-x');
    // A request with no one-time address (a link to a pool or Tacit address, or a name), paid with no Tacit key at all:
    // proved on the page with a throwaway key, straight into their private balance.
    await p.goto(new URL(URL_).origin + `/pay/#pay=${otherBp}&amount=0.0015&chain=base`);
    await p.waitForSelector('#req-wallet');
    await p.click('#req-wallet');
    await p.waitForFunction(() => /now in their private balance/.test(document.querySelector('#req').textContent) || document.querySelector('#req .err'), null, { timeout: 900e3 });
    ok(/Paid 0\.0015 ETH, now in their private balance/.test(await p.textContent('#req')), `a keyless payer deposits straight to them: ${(await p.textContent('#req')).replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    await p.click('#req-x');
    await openKey(p, other);
    await p.click('#tabs [data-tab="deposit"]'); await p.click('[data-dep="addr"]');
    await p.waitForSelector('[data-sweep]', { timeout: 300e3 });
    ok(/payment link’s address/.test(await p.textContent('#form')), 'the payment went to the link’s one-time address, not the standing one');
    await p.click('[data-sweep]');
    await p.waitForFunction(() => /Taken in/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
    ok(/Taken in/.test(await p.textContent('#status')), `the payee takes it in: ${(await p.textContent('#status')).trim()}`);
    const tw = Date.now();
    const probe = setInterval(async () => { try { console.log(`    [${Math.round((Date.now() - tw) / 1000)} s] ${(await p.textContent('#recover-at'))} · ${(await p.$$eval('.chainsum li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()).join(' | ')))}`); } catch {} }, 60e3);
    await p.waitForFunction(() => [...document.querySelectorAll('.rows li')].some((l) => /through a payment link/.test(l.textContent)), null, { timeout: 900e3 }).catch(() => {});
    clearInterval(probe);
    console.log(`    history showed it after ${Math.round((Date.now() - tw) / 1000)} s`);
    const got = await p.$$eval('.rows li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    console.log('    ' + got.join('\n    '));
    ok(got.some((r) => /^Came in through a payment link ?\+0\.003 ETH/.test(r)), 'the payee’s key finds the wallet payment');
    ok(got.some((r) => /^Shielded in ?\+0\.001 ETH/.test(r)) && got.some((r) => /^Shielded in ?\+0\.0015 ETH/.test(r)), 'the payee’s key finds both deposits made straight to them');
    // The next link names a fresh one-time address.
    const next = await getPaidLink(p, '', '');
    ok(new URL(next).hash.match(/n=([0-9a-f]+)/)[1] !== new URL(link).hash.match(/n=([0-9a-f]+)/)[1], 'after a link is paid, the next link uses a new address');
    await shot(p, 'fork-after');
    ok(!errors.length, `no page errors ${errors.join(' | ')}`);
    await ctx.close();
    anvil.kill('SIGKILL');
  }

  if (ONLY.has('anyone')) {
    console.log('anyone (Base fork, real keeper)');
    const PORT = WEB + 2, KPORT = WEB + 3, ANVIL = `http://127.0.0.1:${PORT}`;
    const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', process.env.BASE_RPC || 'https://mainnet.base.org', '--chain-id', '8453', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
    process.on('exit', () => anvil.kill('SIGKILL'));
    const rpc = async (method, params = []) => { const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw new Error(r.error.message); return r.result; };
    for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }
    const ACCT = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', RELAYER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
    for (const a of [ACCT, RELAYER]) { await rpc('anvil_setCode', [a, '0x']); await rpc('anvil_setBalance', [a, '0x' + (10n ** 18n).toString(16)]); }
    await rpc('anvil_autoImpersonateAccount', [true]);
    const kdb = join(process.env.TMPDIR || '/tmp', `pay-check-keeper-${KPORT}.db`);
    const keeper = spawn('node', ['src/evm-pool-keeper.js'], {
      cwd: new URL('../worker-relay/', import.meta.url).pathname, stdio: 'ignore',
      env: { ...process.env, EVM_POOL_ADDR: '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', EVM_POOL_ROUTER_ADDR: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', EVM_POOL_RPC_URL: ANVIL,
        EVM_POOL_CHAIN_ID: '8453', EVM_POOL_KEEPER_PRIV: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', EVM_POOL_KEEPER_DB: kdb, PORT: String(KPORT),
        EVM_POOL_KEEPER_POLL_SECS: '1', EVM_POOL_CONFIRMATIONS: '0', EVM_POOL_START_BLOCK: '51864014', EVM_POOL_KEEPER_SEND_RPC_URLS: ANVIL, EVM_POOL_KEEPER_RATE_PER_MIN: '200' },
    });
    process.on('exit', () => keeper.kill('SIGKILL'));
    for (let i = 0; ; i++) { try { if ((await fetch(`http://127.0.0.1:${KPORT}/health`)).ok) break; } catch {} if (i > 120) throw new Error('keeper did not start'); await sleep(500); }
    const route = async (ctx) => {
      await ctx.route(/mainnet\.base\.org|base\.drpc\.org/, async (r) => {
        const body = r.request().postData();
        let text;
        try { text = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text(); }
        catch (e) { text = JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body || '{}').id ?? 1, error: { code: -32000, message: `fork: ${e.message}` } }); }
        await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: text }).catch(() => {});
      });
      await ctx.route(/tacit-evm-pool-keeper(-robinhood)?\.onrender\.com/, (r) => r.fulfill({ status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"stubbed"}' }));
      await ctx.route(/tacit-evm-pool-keeper-base\.onrender\.com/, async (r) => {
        const u = new URL(r.request().url()), req = r.request();
        try {
          const res = await fetch(`http://127.0.0.1:${KPORT}${u.pathname}${u.search}`, { method: req.method(), headers: { 'content-type': 'application/json' }, body: req.method() === 'GET' ? undefined : req.postData() });
          await r.fulfill({ status: res.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await res.text() });
        } catch (e) { await r.fulfill({ status: 502, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: e.message }) }).catch(() => {}); }
      });
    };
    const init = `(() => {
      const ANVIL = 'https://mainnet.base.org', ACCT = ${JSON.stringify(ACCT)};
      let chain = '0x2105';
      const call = async (method, params) => { const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw Object.assign(new Error(r.error.message), r.error); return r.result; };
      window.ethereum = { isMetaMask: true, on() {}, removeListener() {}, request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCT];
        if (method === 'eth_chainId') return chain;
        if (method === 'wallet_switchEthereumChain') { chain = params[0].chainId; return null; }
        if (method === 'eth_sendTransaction') return call('eth_sendTransaction', [{ ...params[0], from: ACCT }]);
        return call(method, params || []);
      } };
      localStorage.setItem('tacit-pay-chain-v1', '8453');
    })();`;
    const hexKey = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const balOf = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));
    // Waits for a status the press made: the one left from the last action is cleared first.
    const waitStatus = (p, re) => p.waitForFunction((s) => new RegExp(s).test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), re.source, { timeout: 900e3 });
    const press = async (p, sel, re) => { await p.evaluate(() => { document.querySelector('#status').textContent = ''; }); await p.click(sel); await waitStatus(p, re); };
    const text = async (p, sel) => (await p.textContent(sel)).replace(/\s+/g, ' ').trim();
    const { ctx, p, errors } = await page(browser, { init, route });
    await p.goto(URL_);
    await p.waitForSelector('#g-in');
    const key = hexKey(), other = hexKey();
    await openKey(p, other);
    await p.click('#tabs [data-tab="receive"]');
    const otherBp = (await p.textContent('.addr code')).trim();
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await openKey(p, key);
    await p.evaluate(() => document.querySelector('#wallet-label').click()); await p.click('#w-conn'); await p.click('#sheet-wallet [data-close]');
    await p.click('#tabs [data-tab="deposit"]');
    await p.fill('#f-damt', '0.01');
    await press(p, '#f-go', /Deposited/);
    ok(/Deposited/.test(await p.textContent('#status')), `deposit: ${await text(p, '#status')}`);
    await p.waitForFunction(() => /0\.01/.test(document.querySelector('#bal .v').textContent), null, { timeout: 120e3 }).catch(() => {});

    // An 0x address in Send, with a name saved for it; just after a deposit the payment can wait until it blends in.
    const ALICE = '0x' + '44'.repeat(20), alice0 = await balOf(ALICE);
    await p.click('#tabs [data-tab="send"]');
    await p.fill('#f-to', ALICE); await p.fill('#f-amt', '0.002');
    await p.waitForSelector('#f-save:not([hidden])');
    await p.fill('#f-pname', 'Alice'); await p.click('#f-psave');
    await p.waitForSelector('.pchip');
    ok(/Alice/.test(await p.textContent('.people')), 'a name saved for an 0x address shows as a chip');
    await p.fill('#f-amt', '0.002');
    await p.waitForFunction(() => /Pay Alice now/.test(document.querySelector('#f-go').textContent), null, { timeout: 300e3 });
    await p.waitForSelector('#f-later:not([hidden])', { timeout: 300e3 });
    ok(/since yours/.test(await p.textContent('.pv')), `the privacy check asks to wait: ${(await text(p, '.pv')).slice(0, 120)}`);
    await p.click('#f-later');
    await p.waitForSelector('#due:not([hidden]) [data-due]');
    const dueText = await text(p, '#due');
    ok(/Pay Alice/.test(dueText) && /0\.002 ETH/.test(dueText) && /of 5 deposits by others since yours/.test(dueText), `held until it blends in: ${dueText.slice(0, 160)}`);
    await p.waitForSelector('#due [data-due]:not([disabled])', { timeout: 300e3 });
    await press(p, '#due [data-due]', /Paid Alice/);
    ok(/Paid Alice 0\.002 ETH/.test(await p.textContent('#status')), `paid from the card, relayed: ${await text(p, '#status')}`);
    ok(await balOf(ALICE) - alice0 === 2n * 10n ** 15n, 'Alice’s address received exactly 0.002 ETH');
    ok(await p.$eval('#due', (e) => e.hidden), 'the card is gone once paid');

    // Short of private ETH: one press deposits a round amount, and the payment waits for it.
    const BOB = '0x' + '55'.repeat(20);
    await p.fill('#f-to', BOB); await p.fill('#f-amt', '0.02');
    await p.waitForFunction(() => /Deposit .* ETH, pay later/.test(document.querySelector('#f-go').textContent), null, { timeout: 120e3 });
    ok(/Deposit 0\.025 ETH, pay later/.test(await p.textContent('#f-go')), `a short balance offers a round deposit: ${await text(p, '#f-go')}`);
    await press(p, '#f-go', /Deposited/);
    ok(/waits above/.test(await p.textContent('#status')) && /Pay 0x5555…5555/.test(await text(p, '#due')), `deposited, payment held: ${await text(p, '#status')}`);
    await p.click('#due [data-undue]');
    ok(await p.$eval('#due', (e) => e.hidden), 'a held payment can be cancelled');

    // Pay by link: a keyless recipient takes it to their address.
    const makeLink = async (amount, note) => {
      if (!(await p.$('#f-byaddr'))) await p.click('#f-bylink');
      await p.waitForFunction(() => !/Reading your past links/.test(document.querySelector('#f-rcpt').textContent), null, { timeout: 900e3 });
      await p.fill('#f-gamt', amount); await p.fill('#f-gfor', note);
      await p.waitForSelector('#f-go:not([disabled])', { timeout: 120e3 });
      await press(p, '#f-go', /link is ready/);
      ok(/link is ready/.test(await p.textContent('#status')), `link made for ${amount} ETH: ${await text(p, '#status')}`);
      return (await p.textContent('.glink code')).trim();
    };
    const link1 = await makeLink('0.003', 'fork gift');
    ok(/#gift=[0-9a-f]{64}&chain=base&for=fork\+gift$/.test(link1), 'the link carries its key, the chain and the note');
    const CAROL = '0x' + '66'.repeat(20), carol0 = await balOf(CAROL);
    {
      const r = await page(browser, { init: init.replace("localStorage.setItem('tacit-pay-chain-v1', '8453');", ''), route });
      await r.p.goto(link1.replace(/^https?:\/\/[^/]+/, new URL(URL_).origin));
      await r.p.waitForFunction(() => !!document.querySelector('#gift-take') && /came with the link/.test(document.querySelector('#gift').textContent), null, { timeout: 300e3 });
      ok(/fork gift/.test(await r.p.textContent('#gift')) && /Base/.test(await r.p.textContent('#gift')), `the link opens with its amount and note: ${(await text(r.p, '#gift')).slice(0, 100)}`);
      await r.p.fill('#gift-to', CAROL);
      await r.p.click('#gift-take');
      await r.p.waitForFunction(() => /Sent to 0x/.test(document.querySelector('#gift').textContent) || document.querySelector('#gift-status .err'), null, { timeout: 900e3 });
      ok(/Sent to 0x6666…6666/.test(await r.p.textContent('#gift')), `taken by a keyless recipient, relayed: ${await text(r.p, '#gift-status') || (await text(r.p, '#gift')).slice(0, 100)}`);
      { const got = await balOf(CAROL) - carol0; ok(got > 29n * 10n ** 14n && got <= 31n * 10n ** 14n, `they got what was sent, the relay’s fee having ridden in the link: ${Number(got) / 1e18} ETH`); }
      await r.p.goto(link1.replace(/^https?:\/\/[^/]+/, new URL(URL_).origin));
      await r.p.waitForFunction(() => /Empty/.test(document.querySelector('#gift').textContent), null, { timeout: 300e3 });
      ok(true, 'the link, opened again, says it is empty');
      ok(!r.errors.length, `recipient page: no page errors ${r.errors.join(' | ')}`);
      await r.ctx.close();
    }
    // Another link, taken into someone's own private balance; a third, taken back.
    const link2 = await makeLink('0.001', '');
    {
      const r = await page(browser, { init, route });
      await r.p.goto(link2.replace(/^https?:\/\/[^/]+/, new URL(URL_).origin));
      await r.p.waitForSelector('#gift-keep:not([disabled])', { timeout: 300e3 }).catch(async (e) => { console.log('    ' + await text(r.p, '#gift')); throw e; });
      await openKey(r.p, other);
      await r.p.click('#gift-keep');
      await r.p.waitForFunction(() => /In your private balance/.test(document.querySelector('#gift').textContent) || document.querySelector('#gift-status .err'), null, { timeout: 900e3 });
      ok(/In your private balance/.test(await r.p.textContent('#gift')), `kept private by a Tacit user: ${await text(r.p, '#gift-status') || (await text(r.p, '#gift')).slice(0, 80)}`);
      await r.ctx.close();
    }
    await makeLink('0.0015', 'back');
    await p.waitForSelector('[data-gback]', { timeout: 300e3 });
    const backs = await p.$$('[data-gback]');
    await p.evaluate(() => { document.querySelector('#status').textContent = ''; });
    await backs[0].click();
    await waitStatus(p, /Taken back/);
    ok(/Taken back into your private balance/.test(await p.textContent('#status')), `a link taken back: ${await text(p, '#status')}`);
    // The links, found again from the key alone: this browser's own record of them wiped, history rebuilt.
    await p.evaluate(() => { for (const k of Object.keys(localStorage)) if (/^tacit-pay-gifts-v1:/.test(k)) localStorage.removeItem(k); });
    await p.evaluate(() => { const d = document.querySelector('details.adv'); d.open = true; d.dispatchEvent(new Event('toggle')); });
    await p.click('#rc-go');
    await p.waitForFunction(() => document.querySelectorAll('.gl li').length >= 3 && !/rebuilding/.test(document.querySelector('#recover-at').textContent), null, { timeout: 900e3 }).catch(() => {});
    const links = await p.$$eval('.gl li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    console.log('    ' + links.join('\n    '));
    ok(links.length === 3 && links.filter((l) => /· taken$/.test(l)).length === 2 && links.some((l) => /taken back$/.test(l)), 'every link found again from the key, with what became of it');
    const rows = await p.$$eval('.rows li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    ok(rows.filter((r) => /^Sent by link/.test(r)).length === 3 && rows.some((r) => /^Took back a link/.test(r)), `activity names the links: ${rows.filter((r) => /link/.test(r)).join(' | ').slice(0, 200)}`);
    await shot(p, 'anyone-after');
    ok(!errors.length, `no page errors ${errors.join(' | ')}`);
    await ctx.close();
    keeper.kill('SIGKILL'); anvil.kill('SIGKILL');
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
