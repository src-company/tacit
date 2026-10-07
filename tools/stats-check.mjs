#!/usr/bin/env node
// Checks the Cross-chain card on the stats page (dapp/weld/stats) in a real browser with every service stubbed: the pool and relay
// answer fixed counters, the reflection's status carries what it recorded, and the explorers list nothing. Nothing reaches a live
// service, and no fork is needed.
//   to Bitcoin       the pool's attested cross-out count, with the reflection's folded count beside it
//   spent on Ethereum the pool's count of Bitcoin notes spent on Ethereum directly
//   bridged in       the burns the reflection has recorded (a status that lacks the field leaves it out)
//   PLAYWRIGHT=<path to playwright-core> node tools/stats-check.mjs
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = join(dirname(fileURLToPath(import.meta.url)), '..', 'dapp');
const WEB = 8990 + Math.floor(Math.random() * 90);
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  let f = normalize(join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

let failed = 0;
const ok = (c, m, extra = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}${extra ? ` (${extra})` : ''}`); if (!c) failed++; };
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const COUNTS = { '0x1fd4827a': 970100, '0xa6f8c9d6': 9, '0x281d8cc9': 2, '0x0be4f422': 7921 };   // tipHeight, crossOuts, consumed, nextLeafIndex

async function card(status) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  const answer = (m, p) => {
    if (m === 'eth_blockNumber') return '0x18e8c59';
    if (m === 'eth_call') {
      const d = (p[0].data || '').slice(0, 10);
      if (d in COUNTS) return word(COUNTS[d]);
      if (d === '0x59a53331') return word(970090);                  // blockHeight(hash)
      return word(0);
    }
    if (m === 'eth_getLogs') return [];
    return '0x0';
  };
  for (const host of ['mainnet.gateway.tenderly.co', 'ethereum-rpc.publicnode.com', 'cloudflare-eth.com', 'eth.drpc.org', 'mainnet.base.org', 'base-rpc.publicnode.com', 'rpc.mainnet.chain.robinhood.com']) {
    await ctx.route(`https://${host}/**`, async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      const one = (b) => ({ jsonrpc: '2.0', id: b.id, result: answer(b.method, b.params || []) });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) });
    });
  }
  const send = (route, b, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(b) });
  await ctx.route('https://api.tacit.finance/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/reflection/status') return send(route, status);
    if (u.pathname === '/leaderboard') return send(route, []);
    return send(route, {}, 404);
  });
  for (const host of ['eth.blockscout.com', 'base.blockscout.com', 'api.routescan.io']) await ctx.route(`https://${host}/**`, (route) => send(route, { status: '1', message: 'OK', result: [], items: [] }));
  for (const host of ['mempool.space', 'blockstream.info']) await ctx.route(`https://${host}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: '970124' }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('     page error:', e.message));
  await page.goto(`http://127.0.0.1:${WEB}/weld/stats/`);
  await page.waitForFunction(() => [...document.querySelectorAll('.card')].some((c) => /^Cross-chain/.test(c.querySelector('.k')?.textContent.trim() || '') && c.querySelector('.v .sk') == null), null, { timeout: 30000 });
  const text = await page.$$eval('.card', (cs) => cs.map((c) => ['.k', '.v', '.m'].map((x) => c.querySelector(x).textContent.replace(/\s+/g, ' ').trim()).join(' | ')).find((t) => t.startsWith('Cross-chain |')));
  const gloss = await page.evaluate(() => [...document.querySelectorAll('dt')].find((d) => /^Cross-chain/.test(d.textContent))?.nextElementSibling?.textContent || '');
  await browser.close();
  return { text, gloss };
}

console.log('== a status that carries the reflection\'s recorded bridges');
let r = await card({ attestedHeight: 970090, tipHeight: 970100, foldedCrossoutCount: 7, consumedCount: 2, bridgeBurns: 27, liveNotes: 3860 });
ok(/9 to Bitcoin \(7 folded\)/.test(r.text) && /2 spent on Ethereum/.test(r.text) && /27 bridged in/.test(r.text), 'each kind of move is named', r.text);
ok(/^Cross-chain \| 38 ?moves/.test(r.text.replace(/\s+/g, ' ')), 'the total counts all three: 9 + 2 + 27', r.text.slice(0, 40));
ok(/bridges in/.test(r.gloss), 'the glossary says what a bridge in is', r.gloss.slice(0, 160));
console.log('== an API that predates the field');
r = await card({ attestedHeight: 970090, tipHeight: 970100, foldedCrossoutCount: 7, consumedCount: 2, liveNotes: 3860 });
ok(/9 to Bitcoin \(7 folded\)/.test(r.text) && /2 spent on Ethereum/.test(r.text) && !/bridged in/.test(r.text), 'the line reads as before, without a bridged-in figure', r.text);
ok(/^Cross-chain \| 11 ?moves/.test(r.text.replace(/\s+/g, ' ')), 'and the total is the two counters', r.text.slice(0, 40));
server.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
