// dapp/pool-recipient.js: what a pool pay field (/tac, Secret Sats, the sats ETH panel) takes: a bp1… address as typed,
// or a tacit1… address by its pool lane, and never a pool address bound to another network.
//   node tests/pool-recipient.test.mjs
import assert from 'node:assert/strict';
import { secp, sha256, hmac, keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { makeTacitAddress, poolKeysOf } from '../dapp/tacit-address.js';
import { makeBtcShieldedPool } from '../dapp/btc-shielded-pool.js';
import { bip352TaggedHash } from '../dapp/bip352.js';
import { unifiedAddress } from '../dapp/tacit-unified.js';
import { poolRecipient } from '../dapp/pool-recipient.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok - ${name}`); };
const { encodeTacitAddress } = makeTacitAddress({ secp });
const pool = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 });

const key = new Uint8Array(32).fill(7);
const { address: UNIFIED, poolAddress: BP } = unifiedAddress(key);
const seed = hmac(sha256, key, new TextEncoder().encode('tacit-btc-pool-seed-v1'));
const spendPub = secp.getPublicKey(key, true);
const scan = BigInt('0x' + Buffer.from(bip352TaggedHash('BIP0352/ScanKey', key)).toString('hex')) % secp.CURVE.n;
const scanPub = secp.getPublicKey(scan.toString(16).padStart(64, '0'), true);
const base = { btcSpendPub: spendPub, btcScanPub: scanPub, evmOwnerPub: spendPub };
const LEGACY = encodeTacitAddress({ network: 'mainnet', ...base });
const TBP = pool.walletFromSeed(seed, 'signet').addressString;
const SIGNET_POOLED = encodeTacitAddress({ network: 'signet', ...base, poolKeys: poolKeysOf(TBP) });

test('a pool address is taken as typed, trimmed and unwrapped', () => {
  assert.equal(poolRecipient(BP), BP);
  assert.equal(poolRecipient(`  ${BP.slice(0, 40)}\n ${BP.slice(40)} `), BP);
  assert.equal(poolRecipient(TBP, 'signet'), TBP);
});

test('a tacit1… address pays its pool lane, in either case', () => {
  assert.equal(UNIFIED.length, 276);
  assert.equal(poolRecipient(UNIFIED), BP);
  assert.equal(poolRecipient(UNIFIED.toUpperCase()), BP);
  assert.equal(poolRecipient(`${UNIFIED.slice(0, 100)} ${UNIFIED.slice(100)}`), BP);
});

test('a tacit1… address from before the pool lane is refused, with the way on', () => {
  assert.throws(() => poolRecipient(LEGACY), /from before pool payments.*bp1…/);
});

test('a damaged tacit1… address is refused', () => {
  assert.throws(() => poolRecipient(UNIFIED.slice(0, -1) + (UNIFIED.endsWith('q') ? 'p' : 'q')), /Not a valid Tacit address/);
  assert.throws(() => poolRecipient(UNIFIED.slice(0, 120)), /Not a valid Tacit address/);
});

test('a pool address bound to another network is refused, so no payment goes to keys the recipient never looks under', () => {
  assert.notEqual(pool.walletFromSeed(seed, 'mainnet').address, pool.walletFromSeed(seed, 'signet').address);
  assert.throws(() => poolRecipient(TBP), /for a test network/);
  assert.throws(() => poolRecipient(BP, 'signet'), /for mainnet/);
  assert.throws(() => poolRecipient(SIGNET_POOLED), /for a test network/);
  assert.throws(() => poolRecipient(UNIFIED, 'signet'), /for mainnet/);
  assert.equal(poolRecipient(SIGNET_POOLED, 'signet'), TBP);
});

test('anything else passes through for the pool\'s own check to refuse, and an unknown network throws', () => {
  assert.equal(poolRecipient('0x' + 'ab'.repeat(20)), '0x' + 'ab'.repeat(20));
  assert.equal(poolRecipient(''), '');
  assert.equal(poolRecipient(undefined), '');
  assert.throws(() => poolRecipient(BP, 'regtest'), /No pool address prefix/);
});

console.log(`\n${n} passed`);
