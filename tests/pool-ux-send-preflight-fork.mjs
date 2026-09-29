// Sends from a wallet's Tacit account never put a failing transaction on chain, and a reverted one never passes for
// a landed one (dapp/confidential-pool-ux.js _sendEvmTx, _waitReceipt, routerWrap), checked on an anvil fork of
// mainnet with the real deployment:
//   - a token wrap from an account that does not hold the tokens is refused in plain words, and nothing is sent
//   - the same wrap, once the tokens are there, is sent and lands
//   - a call that would revert is refused before signing
//   - waitReceipt rejects a reverted transaction (the 10 TAC wrap that reverted on mainnet at block 26082704)
// Run: anvil --fork-url <mainnet rpc> --port 8547 & node tests/pool-ux-send-preflight-fork.mjs [anvil url]
import assert from 'node:assert/strict';
import { secp, sha256, keccak_256, hmac } from '../dapp/vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { setActiveNetwork } from '../dapp/confidential-deployments.js';

const ANVIL = process.argv[2] || 'http://127.0.0.1:8547';
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const AIRDROP = '0x4b4cb98D0C836c2783Ac46f0078b904dab533AE8';       // holds TAC; impersonated to fund the test account
const REVERTED = '0x6dab19a9fdc7daeb7827ba477a7c3baf90f154fba63b263fd41057435cebbc16';

const call = async (method, params) => {
  const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
// Every RPC the pool UX makes goes to the fork, whichever public endpoint it names.
const fetchImpl = (url, opts) => (/^https?:\/\/[^/]*(rpc|node|gateway|eth|llama|ankr|drpc|merkle|infura|alchemy|cloudflare)/i.test(String(url)) ? fetch(ANVIL, opts) : fetch(url, opts));

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
setActiveNetwork('mainnet');
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl, network: 'mainnet' });
const priv = '0x' + Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const acct = ux.account(priv);
const tacOf = async (a) => BigInt(await call('eth_call', [{ to: TAC, data: '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0') }, 'latest']));
const sentBy = async (a) => BigInt(await call('eth_getTransactionCount', [a, 'latest']));

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
await call('anvil_setBalance', [acct.address, '0x' + (10n ** 17n).toString(16)]);   // gas money only
const ticker = ux.assets.find((a) => a.underlying && a.underlying.toLowerCase() === TAC.toLowerCase())?.ticker;
assert.ok(ticker, 'the deployment lists TAC as a wrappable asset');

await test('a token wrap from an account without the tokens is refused in plain words, and nothing is sent', async () => {
  const before = await sentBy(acct.address);
  await assert.rejects(ux.routerWrap({ walletPriv: priv, amountWei: (10n * 10n ** 18n).toString(), ticker, index: 0 }),
    (e) => /holds 0 TAC; wrapping 10 TAC needs that much there first/.test(e.message) && e.message.includes(acct.address));
  assert.equal(await sentBy(acct.address), before);
});

await test('with the tokens in the account, the same wrap is sent and lands', async () => {
  await call('anvil_impersonateAccount', [AIRDROP]);
  await call('anvil_setBalance', [AIRDROP, '0x' + (10n ** 18n).toString(16)]);
  const data = '0xa9059cbb' + acct.address.slice(2).toLowerCase().padStart(64, '0') + (10n * 10n ** 18n).toString(16).padStart(64, '0');
  await call('eth_sendTransaction', [{ from: AIRDROP, to: TAC, data }]);
  assert.equal(await tacOf(acct.address), 10n * 10n ** 18n);
  const r = await ux.routerWrap({ walletPriv: priv, amountWei: (10n * 10n ** 18n).toString(), ticker, index: 0 });
  const rcpt = await ux.waitReceipt(r.txHash);
  assert.equal(rcpt.status, '0x1');
  assert.equal(await tacOf(acct.address), 0n);
});

await test('a call that would revert is refused before signing', async () => {
  const before = await sentBy(acct.address);
  await assert.rejects(ux.sendPreparedTx({ walletPriv: priv, to: TAC, value: 0n, calldata: '0xa9059cbb' + '00'.repeat(12) + 'dead'.repeat(10) + (1n).toString(16).padStart(64, '0'), gasLimit: 100000n }),
    (e) => e.wouldRevert === true && /would fail on chain, so it was not sent/.test(e.message));
  assert.equal(await sentBy(acct.address), before);
});

await test('waitReceipt rejects a transaction that reverted', async () => {
  await assert.rejects(ux.waitReceipt(REVERTED), (e) => e.reverted === true && /reverted on chain, so it changed nothing/.test(e.message));
});

console.log(`${n} passed`);
