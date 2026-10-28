// The client's typed data must hash exactly as the deployed ProofMarket does, or every signature would be refused. Checked against the
// live contract's own intentHash / tankHash / priceAt (read-only eth_call on mainnet), and a wallet-style signature must recover.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../worker-relay/package.json'));
const { hashTypedData, recoverTypedDataAddress, encodeFunctionData, parseAbi, privateKeyToAccount } = (() => { const v = require('viem'), a = require('viem/accounts'); return { ...v, ...a }; })();
const pm = await import('../dapp/proof-market.js');

const RPC = process.env.RPC || 'https://ethereum-rpc.publicnode.com';
const rpc = async (to, data) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) })).json()).result;
const abi = parseAbi([
  'struct Intent { address payer; bytes32 opId; uint256 floorFee; uint256 maxFee; uint64 start; uint64 rampSecs; uint64 deadline; bytes32 tank; }',
  'struct Tank { address payer; address delegate; uint256 cap; uint256 perOpMax; uint64 expiry; uint256 salt; }',
  'function intentHash(Intent i) view returns (bytes32)', 'function tankHash(Tank t) view returns (bytes32)',
  'function priceAt(Intent i, uint256 ts) pure returns (uint256)',
]);
let fails = 0; const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++; };
const M = pm.MARKET[1];
const acct = privateKeyToAccount('0x' + 'a1'.repeat(32)), delegate = privateKeyToAccount('0x' + 'd2'.repeat(32));
const provider = (a) => ({ request: async ({ method, params }) => { const p = JSON.parse(params[1]); const { EIP712Domain, ...types } = p.types; return a.signTypedData({ domain: p.domain, types, primaryType: p.primaryType, message: p.message }); } });
const asBig = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, /^\d+$/.test(String(v)) && !String(v).startsWith('0x') ? BigInt(v) : v]));

const pv = '0xc0ffee00112233', now = 1_900_000_000;
const intent = pm.buildIntent({ payer: acct.address, publicValues: pv, floor: 10n ** 18n, max: 5n * 10n ** 18n, rampSecs: 120, now });
const live = await rpc(M, encodeFunctionData({ abi, functionName: 'intentHash', args: [asBig(intent)] }));
const mine = hashTypedData({ ...pm.intentTypedData(intent), types: { Intent: pm.intentTypedData(intent).types.Intent }, message: asBig(intent) });
ok(!!live && live === mine, 'an intent hashes as the deployed market hashes it');

ok(pm.intentDigest(intent) === mine, 'the digest a held key signs is the typed-data hash');
const sig = await pm.signIntent(provider(acct), acct.address, intent);
const rec = await recoverTypedDataAddress({ domain: pm.intentTypedData(intent).domain, types: { Intent: pm.intentTypedData(intent).types.Intent }, primaryType: 'Intent', message: asBig(intent), signature: sig });
ok(rec === acct.address, 'the wallet signature recovers to the payer');

const tank = pm.buildTank({ payer: acct.address, delegate: delegate.address, cap: 30n * 10n ** 18n, perOpMax: 10n * 10n ** 18n, now });
const liveT = await rpc(M, encodeFunctionData({ abi, functionName: 'tankHash', args: [asBig(tank)] }));
ok(!!liveT && liveT === hashTypedData({ ...pm.tankTypedData(tank), types: { Tank: pm.tankTypedData(tank).types.Tank }, message: asBig(tank) }), 'a tank hashes as the deployed market hashes it');

const tIntent = pm.buildIntent({ payer: acct.address, publicValues: pv, floor: 0n, max: 4n * 10n ** 18n, now, tank: liveT });
const liveTI = await rpc(M, encodeFunctionData({ abi, functionName: 'intentHash', args: [asBig(tIntent)] }));
ok(liveTI === hashTypedData({ ...pm.intentTypedData(tIntent), types: { Intent: pm.intentTypedData(tIntent).types.Intent }, message: asBig(tIntent) }), 'a tank order\'s intent (naming its tank) hashes the same');

let same = true;
for (const dt of [-5, 0, 30, 60, 119, 120, 500]) {
  const l = BigInt(await rpc(M, encodeFunctionData({ abi, functionName: 'priceAt', args: [asBig(intent), BigInt(now + dt)] })));
  if (l !== pm.priceAt(intent, now + dt)) same = false;
}
ok(same, 'the client\'s price curve is the market\'s, before, during and after the ramp');
ok(pm.opIdOf(pv) === intent.opId && (() => { try { pm.buildOrder({ intent, signature: sig, permit: {}, publicValues: '0xdead' }); return false; } catch { return true; } })(), 'an order whose public values are not the intent\'s op is refused');
{
  const m = await import('../worker-relay/src/lib/market-calls.js');
  const rnd = (n) => '0x' + Array.from({ length: n }, (_, i) => ((i * 37 + 11) % 256).toString(16).padStart(2, '0')).join('');
  const direct = { intent, signature: sig, permit: { v: 28, r: rnd(32), s: rnd(32) }, publicValues: rnd(100), memos: [rnd(33), '0x', rnd(70)], stdin: '0x' };
  const tk = { ...direct, intent: tIntent, tank, tankSignature: sig };
  for (const [name, o] of [['a direct order', direct], ['a tank order', tk]]) {
    ok(pm.encodeClaim(o) === m.encodeClaim(o) && pm.encodeFulfill(o, rnd(260)) === m.encodeFulfill(o, rnd(260)), `${name}: the library-free claim and fulfil calls are viem's bytes`);
  }
}
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
