// The keeper's send path against an anvil fork of Ethereum: one signed transaction goes to every private endpoint (the
// same hash at each), the public node is not used while a private endpoint takes it, and it is used when none does.
// Usage: node tests/evm-pool-keeper-send.test.mjs        (anvil on PATH; FORK_URL to fork from another node)
import { spawn } from 'node:child_process';
import http from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { makeKeeperChain } from '../src/lib/evm-pool-keeper-chain.js';

let failures = 0, passed = 0;
const ok = (c, m, x = '') => { console.log(`${c ? 'ok' : 'not ok'} - ${m}${x ? '  ' + x : ''}`); c ? passed++ : failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 21545 + Math.floor(Math.random() * 2000), fork = `http://127.0.0.1:${port}`;
const anvil = spawn('anvil', ['--port', String(port), '--fork-url', process.env.FORK_URL || 'https://ethereum-rpc.publicnode.com', '--silent'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
const rpc = async (method, params = []) => (await (await fetch(fork, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
for (let i = 0; ; i++) { try { if ((await rpc('eth_chainId')).result) break; } catch {} if (i > 240) throw new Error('anvil did not start'); await sleep(500); }

// A private endpoint: records each raw transaction; `mode` 'take' forwards it to the fork, 'known' answers as a node that
// already has it, 'refuse' fails it.
const endpoint = (mode) => {
  const seen = [];
  const srv = http.createServer(async (q, r) => {
    let body = ''; for await (const c of q) body += c;
    const req = JSON.parse(body), one = async (x) => {
      if (x.method !== 'eth_sendRawTransaction') return (await rpc(x.method, x.params)).result !== undefined ? { jsonrpc: '2.0', id: x.id, result: (await rpc(x.method, x.params)).result } : { jsonrpc: '2.0', id: x.id, error: { code: -32000, message: 'fork error' } };
      seen.push(x.params[0]);
      if (mode === 'refuse') return { jsonrpc: '2.0', id: x.id, error: { code: -32000, message: 'endpoint unavailable' } };
      if (mode === 'known') return { jsonrpc: '2.0', id: x.id, error: { code: -32000, message: 'already known' } };
      const f = await rpc('eth_sendRawTransaction', x.params);
      return { jsonrpc: '2.0', id: x.id, ...(f.error ? { error: f.error } : { result: f.result }) };
    };
    const out = Array.isArray(req) ? await Promise.all(req.map(one)) : await one(req);
    r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(out));
  }).listen(0);
  return { url: `http://127.0.0.1:${srv.address().port}/`, seen, close: () => srv.close() };
};
// The public node: the fork itself, through a counter.
const pubSeen = [];
const pubSrv = http.createServer(async (q, r) => {
  let body = ''; for await (const c of q) body += c;
  const req = JSON.parse(body), one = async (x) => { if (x.method === 'eth_sendRawTransaction') pubSeen.push(x.params[0]); const f = await rpc(x.method, x.params); return { jsonrpc: '2.0', id: x.id, ...(f.error ? { error: f.error } : { result: f.result }) }; };
  const out = Array.isArray(req) ? await Promise.all(req.map(one)) : await one(req);
  r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(out));
}).listen(0);
const pubUrl = `http://127.0.0.1:${pubSrv.address().port}/`;

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', account = privateKeyToAccount(KEY);
await rpc('anvil_setBalance', [account.address, '0x' + (10n ** 18n).toString(16)]);
const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
const base = { pool: POOL, router: ROUTER, chainId: 1, minPriorityFee: 50_000_000n, pipeline: false, allowPublicSend: true };
// A transaction to send: the router's sweepReceive of an empty box reverts on chain, which a send without simulation
// does not care about; what is tested is where it goes.
const args = [1n, 25, [[0n, 0n], [[0n, 0n], [0n, 0n]], [0n, 0n], Array(11).fill(0n), '0x0000000000000000000000000000000000000000', 0n, '0x0000000000000000000000000000000000000000', 0n, '0x', '0x']];

{
  const a = endpoint('take'), b = endpoint('known');
  const chain = await makeKeeperChain({ cfg: { ...base, rpcUrls: [pubUrl], sendRpcUrls: [a.url, b.url] }, account });
  const hash = await chain.send('sweepReceive', args, { gas: 300_000n, simulate: false }).catch((e) => e);
  ok(typeof hash === 'string' && /^0x[0-9a-f]{64}$/.test(hash), 'a send returns the hash', String(hash?.message || hash).slice(0, 80));
  ok(a.seen.length === 1 && b.seen.length === 1 && a.seen[0] === b.seen[0], 'the same signed transaction reached both private endpoints', `${a.seen.length} + ${b.seen.length}`);
  ok(pubSeen.length === 0, 'and the public node got nothing');
  a.close(); b.close();
}
{
  const a = endpoint('refuse'), b = endpoint('take');
  const chain = await makeKeeperChain({ cfg: { ...base, rpcUrls: [pubUrl], sendRpcUrls: [a.url, b.url] }, account });
  const hash = await chain.send('sweepReceive', args, { gas: 300_000n, simulate: false }).catch((e) => e);
  ok(typeof hash === 'string' && b.seen.length === 1 && pubSeen.length === 0, 'one private endpoint refusing does not stop the other, nor send it publicly');
  a.close(); b.close();
}
{
  const a = endpoint('refuse'), b = endpoint('refuse');
  const chain = await makeKeeperChain({ cfg: { ...base, rpcUrls: [pubUrl], sendRpcUrls: [a.url, b.url] }, account });
  const before = pubSeen.length, hash = await chain.send('sweepReceive', args, { gas: 300_000n, simulate: false }).catch((e) => e);
  ok(typeof hash === 'string' && pubSeen.length === before + 1, 'with every private endpoint refusing, the public node takes it (public sends allowed)');
  const c = endpoint('refuse');
  const strict = await makeKeeperChain({ cfg: { ...base, allowPublicSend: false, rpcUrls: [pubUrl], sendRpcUrls: [c.url] }, account });
  const before2 = pubSeen.length, err = await strict.send('sweepReceive', args, { gas: 300_000n, simulate: false }).catch((e) => e);
  ok(err instanceof Error && pubSeen.length === before2, 'and with public sends off, it fails instead', String(err?.message || err).slice(0, 60));
  a.close(); b.close(); c.close();
}
pubSrv.close();
console.log(`\n${passed} passed${failures ? `, ${failures} failed` : ''}`);
process.exit(failures ? 1 : 0);
