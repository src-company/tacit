// dapp/kit/tacit-address-kit.js, the file integrators vendor, against the modules the Tacit apps run: its addresses
// are theirs (the pool lane is the bp1… the ETH pool wallet itself computes), its key is the one a wallet signature
// derives everywhere, and it refuses what they refuse.
//   node build/build-tacit-address-kit.mjs --check && node tests/tacit-address-kit.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { secp, sha256, keccak_256, hmac, bytesToHex, concatBytes } from '../dapp/vendor/tacit-deps.min.js';
import { makeTacitAddress } from '../dapp/tacit-address.js';
import { bip352TaggedHash } from '../dapp/bip352.js';
import { identityMessage } from '../dapp/identity-message.js';
import { prfBytesToScalar } from '../dapp/prf-wallet.js';
import { makeEvmPoolZk } from '../dapp/evm-pool-zk.js';
import { evmPoolKeys } from '../dapp/evm-pool-wallet.js';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from '../dapp/vendor/tacit-poseidon.min.js';
import * as kit from '../dapp/kit/tacit-address-kit.js';

if (!secp.etc.hmacSha256Sync) secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, concatBytes(...m));   // for signing in this test
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const { encodeTacitAddress } = makeTacitAddress({ secp });
const PO = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => PO[xs.length](xs) });
const te = new TextEncoder();

// The key 0x0707…07, pinned in tests/tacit-address-pool.mjs.
const V0 = 'tacit1qqps9xyupdmvk43ew87un0hnrmqxcdtq7vjf6mhfuhvrc4mz2ktwqhm0qdk5lnmv6yyy73yd0mccau2em5n66y5a0pyh3xfuhzwmf8g39kctxq5cns9hdj6k89clmjd77v0vqmp4vrejf8twa8jas0zhvf2edczlduk6e0c7';
const BP = 'bp1qf5rdn2trtk94rqya5637yeqyvp5qllkeztth8dfesrc5x9tvqluqlahm5yyv7km9tq9s9spmdqqukkw46zudgxu7aawem8fyey0kseqh6xr40k26x7ew8zqujenn45kk2kh47aqzxxj3pp8q2rukjss02vszf7eaa';
const UNIFIED = 'tacit1qzzs9xyupdmvk43ew87un0hnrmqxcdtq7vjf6mhfuhvrc4mz2ktwqhm0qdk5lnmv6yyy73yd0mccau2em5n66y5a0pyh3xfuhzwmf8g39kctxqngxmx5kxhvt2xqfmf4rufjqgcrgplldjykhww6nnq83gv2kcplcplm0hgggeadk2kqtqtqrk6qpedvat59c6sdeam6ankwjfjgldpjp05v82lv45dajuwype9n88tfdv4d0ta6qyvd9zzzwq58ed9pq75emyyf75';

// The address every Tacit app shows for a key: its Bitcoin keys, the Ethereum-side key and the ETH pool wallet's own keys.
function theirs(key) {
  const spendPub = secp.getPublicKey(key, true);
  const scan = BigInt('0x' + bytesToHex(bip352TaggedHash('BIP0352/ScanKey', key))) % secp.CURVE.n;
  const btcScanPub = secp.getPublicKey(scan.toString(16).padStart(64, '0'), true);
  return { spendPub, btcScanPub, bp: evmPoolKeys(zk, key).address };
}
// A wallet's EIP-191 signature of the identity message: r ‖ s ‖ v (27/28), low s as every compliant signer makes it.
function signIdentity(signerKey) {
  const msg = te.encode(identityMessage({ netName: 'mainnet' }));
  const digest = keccak_256(concatBytes(te.encode(`\x19Ethereum Signed Message:\n${msg.length}`), msg));
  const sig = secp.sign(digest, signerKey, { lowS: true });
  const address = '0x' + bytesToHex(keccak_256(secp.getPublicKey(signerKey, false).subarray(1)).subarray(12));
  return { sig: concatBytes(sig.toCompactRawBytes(), Uint8Array.of(27 + sig.recovery)), address };
}

await test('the kit is one file with no imports', () => {
  const src = readFileSync(new URL('../dapp/kit/tacit-address-kit.js', import.meta.url), 'utf8').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  assert.ok(!/\bimport\s*\(|^\s*import\s|\bfrom\s*["']/m.test(src));
});

await test('the identity message is the one every Tacit app signs', () => {
  assert.equal(kit.identityMessage(), identityMessage({ netName: 'mainnet' }));
});

await test('the pinned key: unified address, pool address, and the address without the pool lane', () => {
  const key = new Uint8Array(32).fill(7);
  assert.deepEqual(kit.addressesFromKey(key), { address: UNIFIED, poolAddress: BP, flags: 0x85 });
  assert.equal(kit.addressesFromKey(key, { pool: false }).address, V0);
});

await test('addresses match the apps\' own for 40 random keys; the pool lane is what the ETH pool wallet computes', () => {
  for (let i = 0; i < 40; i++) {
    const key = secp.utils.randomPrivateKey(), t = theirs(key), k = kit.addressesFromKey(key);
    assert.equal(k.poolAddress, t.bp);
    const d = kit.decodeTacitAddress(k.address);
    assert.equal(d.lanes.pool.poolAddress, t.bp);
    assert.equal(k.address, encodeTacitAddress({ network: 'mainnet', btcSpendPub: t.spendPub, btcScanPub: t.btcScanPub, evmOwnerPub: t.spendPub, poolKeys: d.lanes.pool.keys }));
    assert.equal(k.address.length, 276);
    assert.equal(k.flags, 0x85);
    assert.equal(bytesToHex(d.lanes.evm.ownerPub), bytesToHex(t.spendPub));
    assert.equal(kit.addressesFromKey(key, { pool: false }).address, encodeTacitAddress({ network: 'mainnet', btcSpendPub: t.spendPub, btcScanPub: t.btcScanPub, evmOwnerPub: t.spendPub }));
  }
});

await test('a wallet\'s signature derives the key every Tacit app derives, v as 27/28 or 0/1', () => {
  for (let i = 0; i < 20; i++) {
    const { sig, address } = signIdentity(secp.utils.randomPrivateKey());
    const want = bytesToHex(prfBytesToScalar(sha256(sig)));
    assert.equal(bytesToHex(kit.keyFromSignature(sig, { address })), want);
    assert.equal(bytesToHex(kit.keyFromSignature('0x' + bytesToHex(sig))), want);
    const v01 = Uint8Array.from(sig); v01[64] -= 27;
    assert.equal(bytesToHex(kit.keyFromSignature(v01, { address: address.toUpperCase().replace('0X', '0x') })), want);
  }
});

await test('it refuses another account\'s signature, a high-s signature and malformed input', () => {
  const { sig, address } = signIdentity(secp.utils.randomPrivateKey());
  const other = signIdentity(secp.utils.randomPrivateKey()).address;
  assert.throws(() => kit.keyFromSignature(sig, { address: other }), /not from that address/);
  const hi = Uint8Array.from(sig), s = BigInt('0x' + bytesToHex(sig.subarray(32, 64)));
  hi.set(secp.etc.numberToBytesBE(secp.CURVE.n - s, 32), 32); hi[64] = hi[64] === 27 ? 28 : 27;
  assert.throws(() => kit.keyFromSignature(hi, { address }), /high-s/);
  assert.throws(() => kit.keyFromSignature(sig.subarray(0, 64)), /65 bytes/);
  assert.throws(() => kit.addressesFromKey(new Uint8Array(32)), /not a Tacit key/);
  assert.throws(() => kit.decodeTacitAddress(UNIFIED.slice(0, -1) + (UNIFIED.endsWith('f') ? 'q' : 'f')));
});

await test('the caller\'s key and signature are left as given (zeroing them is the caller\'s)', () => {
  const key = new Uint8Array(32).fill(7), { sig } = signIdentity(secp.utils.randomPrivateKey()), s0 = Uint8Array.from(sig);
  kit.addressesFromKey(key); kit.keyFromSignature(sig);
  assert.deepEqual(key, new Uint8Array(32).fill(7));
  assert.deepEqual(sig, s0);
});

console.log(`\n${n} passed`);
