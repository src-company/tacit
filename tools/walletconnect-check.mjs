// Checks WalletConnect on the front page (dapp/index.html) end to end, over WalletConnect's real relay: a wallet in
// Node, holding a test key, pairs with the link the page shows, approves the session and answers personal_sign; the
// page must open the Tacit wallet that signature derives. After a reload, "Continue as" must open the same wallet
// through the kept session, with no new pairing. Nothing is sent on any chain.
//   node tools/walletconnect-check.mjs        (build/'s dependencies installed: cd build && npm install)

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';

const req = createRequire(new URL('../build/package.json', import.meta.url));
const WebSocket = req('ws');
globalThis.WebSocket ??= WebSocket;
const { SignClient } = await import(req.resolve('@walletconnect/sign-client'));
const secp = await import(req.resolve('@noble/secp256k1'));
const { keccak_256 } = await import(req.resolve('@noble/hashes/sha3'));
const { hmac } = await import(req.resolve('@noble/hashes/hmac'));
const { sha256 } = await import(req.resolve('@noble/hashes/sha256'));
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');

const DAPP = new URL('../dapp/', import.meta.url).pathname;
const PROJECT = /WC_PROJECT_ID = '([0-9a-f]{32})'/.exec(readFileSync(join(DAPP, 'index.html'), 'utf8'))?.[1];
if (!PROJECT) throw new Error('no WC_PROJECT_ID in dapp/index.html');
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer((r, res) => {
  let f = normalize(join(DAPP, decodeURIComponent(new URL(r.url, 'http://x').pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const URL_ = `http://127.0.0.1:${server.address().port}/#wallet`;

let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };
const KEY = Buffer.from('7'.repeat(63) + '1', 'hex');
const ADDR = '0x' + Buffer.from(keccak_256(secp.getPublicKey(KEY, false).slice(1)).slice(12)).toString('hex');
function personalSign(msgHex) {
  const m = Buffer.from(msgHex.replace(/^0x/, ''), 'hex');
  const s = secp.sign(keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${m.length}`), m])), KEY);
  return '0x' + s.toCompactHex() + (27 + s.recovery).toString(16);
}

const wallet = await SignClient.init({ projectId: PROJECT, metadata: { name: 'walletconnect-check', description: 'test wallet', url: 'https://example.com', icons: [] } });
const asked = [];
wallet.on('session_proposal', async ({ id, params }) => {
  const want = [...(params.requiredNamespaces?.eip155?.chains || []), ...(params.optionalNamespaces?.eip155?.chains || [])];
  const methods = [...new Set([...(params.requiredNamespaces?.eip155?.methods || []), ...(params.optionalNamespaces?.eip155?.methods || [])])];
  const chains = want.filter((c) => c === 'eip155:1' || c === 'eip155:8453');
  asked.push(`proposal:${params.proposer.metadata.name}`);
  await wallet.approve({ id, namespaces: { eip155: { chains, accounts: chains.map((c) => `${c}:${ADDR}`), methods, events: ['accountsChanged', 'chainChanged'] } } });
});
wallet.on('session_request', async ({ topic, id, params }) => {
  const { method, params: p } = params.request;
  asked.push(method);
  await wallet.respond({ topic, response: method === 'personal_sign' ? { id, jsonrpc: '2.0', result: personalSign(p[0]) } : { id, jsonrpc: '2.0', error: { code: 4200, message: 'not in this check' } } });
});

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) errors.push(m.text().slice(0, 160)); });
const label = () => page.evaluate(() => document.querySelector('#wallet-label')?.textContent || '');
const opened = () => page.waitForFunction(() => /^tacit1/.test(document.querySelector('#wallet-label')?.textContent || ''), null, { timeout: 120000 }).catch(() => {});
try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.click('#sheet-wallet [data-in="eth"]');
  await page.waitForSelector('#sheet-wc[open] .wc-qr svg', { timeout: 30000 });
  await page.evaluate(() => { navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
  await page.click('#wc-copy');
  const uri = await page.evaluate(() => window.__copied);
  ok(/^wc:[0-9a-f]{64}@2\?/.test(uri || ''), 'pairing: the page shows a QR and copies its wc: link');
  await wallet.core.pairing.pair({ uri });
  await opened();
  const first = await label();
  ok(/^tacit1/.test(first) && !(await page.$('#sheet-wc[open]')), `sign-in: the wallet opens (${first}), the pairing sheet goes`);
  ok(asked.join(' ') === 'proposal:tacit personal_sign personal_sign', `the wallet app was asked: ${asked.join(' → ')}`);

  asked.length = 0;
  await page.goto('about:blank');
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.click('#sheet-wallet [data-in="known"]');
  await opened();
  ok((await label()) === first && !(await page.$('#sheet-wc[open]')) && asked.join(' ') === 'personal_sign', `again after a reload: the kept session opens ${await label()}, no pairing (asked: ${asked.join(' → ')})`);
  ok(!errors.length, `no page errors ${errors.join(' | ')}`);
} catch (e) { fails++; console.log('FAIL', e.message.split('\n')[0]); }
await browser.close();
server.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
