// The standalone private-ETH wallet (dapp/evm-pool/tacit-evm-pool-wallet.js, built from build/entry-evm-pool-wallet.mjs) hands
// what a caller gives it on to the wallet core: an action's maxFee, and quote(gas). The core's own behaviour is tested in
// tests/evm-pool-wallet-rpc.test.mjs; this holds the built file to the wrapper's contract, so a bundle built before a change
// to either one fails here.
//   node tests/evm-pool-bundle-wrapper.test.mjs

import assert from 'node:assert/strict';

const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', RELAYER = '0x7c9f8aE4e48Cbb2727F95b6477a1cf92bCFc43D0';
const FEE = 5_000_000_000_000n, TOO_LOW = FEE - 1n;
const asked = [];

// A chain with nothing in it and a relayer that quotes FEE for anything.
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url.startsWith('https://rpc.test')) {
    const body = JSON.parse(init.body);
    const one = (x) => ({ jsonrpc: '2.0', id: x.id, result: { eth_chainId: '0x1', eth_blockNumber: '0x64', eth_getLogs: [], eth_getCode: '0x' }[x.method] ?? '0x0' });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { headers: { 'content-type': 'application/json' } });
  }
  asked.push(url.replace('https://k.test', ''));
  return new Response(JSON.stringify({ chainId: 1, pool: POOL, relayer: RELAYER, fee: FEE.toString() }), { headers: { 'content-type': 'application/json' } });
};

const { makeEvmPoolWallet } = await import(new URL('../dapp/evm-pool/tacit-evm-pool-wallet.js', import.meta.url));
const w = await makeEvmPoolWallet({ chainId: 1, identityKey: '05'.repeat(32), relay: 'https://k.test', rpc: 'https://rpc.test', confirmations: 0 });

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const moved = (e) => e.feeMoved === FEE && /fee went up/.test(e.message);

await check('quote() is the plain quote and quote(gas) is priced for a spend that burns that gas', async () => {
  await w.quote();
  await w.quote(700_000);
  assert.deepEqual(asked.filter((u) => u.startsWith('/quote')), ['/quote', '/quote?gas=700000']);
});

await check('a relayed send, withdrawal and move to V1 are refused above maxFee, with the fee that moved', async () => {
  await assert.rejects(() => w.send(w.address, 10n ** 12n, { via: 'relay', maxFee: TOO_LOW }), moved);
  await assert.rejects(() => w.withdraw('0x' + '22'.repeat(20), 10n ** 12n, { via: 'relay', maxFee: TOO_LOW }), moved);
  await assert.rejects(() => w.toV1(10n ** 12n, '0x' + '11'.repeat(32), { via: 'relay', maxFee: TOO_LOW }), moved);
});

await check('a bridge out is refused above maxFee, priced for its own gas', async () => {
  await assert.rejects(() => w.bridgeOut(8453, 10n ** 12n, { maxFee: TOO_LOW }), moved);
  assert.ok(asked.some((u) => /^\/quote\?gas=\d+$/.test(u) && u !== '/quote?gas=700000'), 'its quote is priced for the bridge call');
});

await check('without maxFee the same spends are not refused for their fee', async () => {
  // Nothing in the pool, so they stop at the balance, after the quote, and not at the fee.
  await assert.rejects(() => w.send(w.address, 10n ** 12n, { via: 'relay' }), (e) => e.feeMoved === undefined && /not enough in the pool/.test(e.message));
});

console.log(`\n${n} checks passed`);
