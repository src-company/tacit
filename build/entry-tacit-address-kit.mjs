// A Tacit identity's public addresses from its key, and its key from the one message every Tacit app asks a wallet to
// sign: for apps that publish or check a tacit1… address, such as a name service writing the `finance.tacit` record.
// Built by build/build-tacit-address-kit.mjs into dapp/kit/tacit-address-kit.js, one ES module with no imports, from
// the same modules every Tacit app runs, so what it derives is what they derive.
//
//   identityMessage()                          → the text a wallet signs (EIP-191 personal_sign)
//   keyFromSignature(sig, { address })         → the 32-byte Tacit key. sig: the 65-byte signature (hex or bytes);
//                                                address: the account that signed, checked by recovery
//   addressesFromKey(key)                      → { address, poolAddress, flags }: the tacit1… address with its pool
//                                                lane (flags 0x85, 276 characters) and the bp1… pool address;
//                                                { pool: false } gives the address without it (flags 0x03)
//   decodeTacitAddress(address)                → { network, version, flags, lanes: { btc, evm?, pool? } }; throws
//                                                on anything that is not a valid tacit1… address
//
// The signature is the key: whoever holds either controls the identity's funds. Keep both in memory only, never send
// or store them, and zero them (sig.fill(0), key.fill(0)) once the address is computed. Every other input and output
// here is public.

import { secp, sha256, keccak_256, hmac, concatBytes, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { makeTacitAddress, TACIT_HRP_BY_NETWORK } from '../dapp/tacit-address.js';
import { bip352TaggedHash } from '../dapp/bip352.js';
import { makeBtcShieldedPool } from '../dapp/btc-shielded-pool.js';
import { identityMessage as messageFor } from '../dapp/identity-message.js';
import { prfBytesToScalar } from '../dapp/prf-wallet.js';

export const KIT_VERSION = 1;
const te = new TextEncoder();
const N = secp.CURVE.n;
const POOL_SEED_TAG = te.encode('tacit-btc-pool-seed-v1');
const { encodeTacitAddress, decodeTacitAddress: decode } = makeTacitAddress({ secp });
const pool = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 });

const bytesOf = (x, what) => {
  if (x instanceof Uint8Array) return Uint8Array.from(x);
  if (typeof x === 'string' && /^(0x)?([0-9a-f]{2})*$/i.test(x)) return hexToBytes(x.replace(/^0x/i, ''));
  throw new Error(`tacit-address-kit: ${what} must be bytes or hex`);
};
const toBig = (b) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);

export function identityMessage(network = 'mainnet') { return messageFor({ netName: network }); }

// The key a wallet's signature of the identity message derives, exactly as every Tacit app derives it: v written as
// 0/1 is read as 27/28, a non-canonical (high-s) signature is refused rather than altered, and the key is
// sha256(signature), mapped into [1, n-1] in the (practically unreachable) case it falls outside.
export function keyFromSignature(sig, { address = null, network = 'mainnet' } = {}) {
  const s = bytesOf(sig, 'signature');
  try {
    if (s.length !== 65) throw new Error('tacit-address-kit: a signature is 65 bytes');
    if (s[64] === 0 || s[64] === 1) s[64] += 27;
    if (s[64] !== 27 && s[64] !== 28) throw new Error('tacit-address-kit: the signature\'s v is not 27 or 28');
    if (toBig(s.subarray(32, 64)) > N / 2n) throw new Error('tacit-address-kit: a non-canonical (high-s) signature; nothing was derived');
    if (address != null) {
      const msg = te.encode(identityMessage(network));
      const digest = keccak_256(concatBytes(te.encode(`\x19Ethereum Signed Message:\n${msg.length}`), msg));
      const pub = secp.Signature.fromCompact(s.subarray(0, 64)).addRecoveryBit(s[64] - 27).recoverPublicKey(digest).toRawBytes(false);
      const signer = '0x' + Array.from(keccak_256(pub.subarray(1)).subarray(12), (b) => b.toString(16).padStart(2, '0')).join('');
      if (signer !== String(address).toLowerCase()) throw new Error('tacit-address-kit: the signature is not from that address');
    }
    return Uint8Array.from(prfBytesToScalar(sha256(s)));
  } finally { s.fill(0); }
}

export function addressesFromKey(key, { pool: withPool = true, network = 'mainnet' } = {}) {
  const k = bytesOf(key, 'key');
  let seed = null;
  try {
    if (k.length !== 32 || !toBig(k) || toBig(k) >= N) throw new Error('tacit-address-kit: not a Tacit key');
    if (!TACIT_HRP_BY_NETWORK[network]) throw new Error(`tacit-address-kit: unknown network ${network}`);
    const spendPub = secp.getPublicKey(k, true);
    const scan = toBig(bip352TaggedHash('BIP0352/ScanKey', k)) % N;
    const btcScanPub = secp.getPublicKey(hexToBytes(scan.toString(16).padStart(64, '0')), true);
    seed = hmac(sha256, k, POOL_SEED_TAG);
    const w = pool.walletFromSeed(seed, network);
    const address = encodeTacitAddress({ network, btcSpendPub: spendPub, btcScanPub, evmOwnerPub: spendPub, ...(withPool ? { poolKeys: hexToBytes(w.address.replace(/^0x/, '')) } : {}) });
    return { address, poolAddress: w.addressString, flags: decode(address).flags };
  } finally { k.fill(0); seed?.fill(0); }
}

export function decodeTacitAddress(address) { return decode(String(address).trim().toLowerCase()); }
