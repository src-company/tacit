import assert from 'node:assert/strict';
import { sha256 } from '../dapp/vendor/tacit-deps.min.js';
import { addressId } from '../dapp/address-id.js';

const a = 'tacit1qzzsxqmzlglgkpv467x5wsakndy5vdm7nqexample', b = 'tacit1qzzsxqs0rwdrhq8yjye05qlupsn63qadpzexample';
assert.match(addressId(a), /^[0-9a-f]{4}(·[0-9a-f]{4}){3}$/);
assert.equal(addressId(a), addressId(a.toUpperCase()), 'case does not change it');
assert.equal(addressId(a), addressId(`  ${a.slice(0, 20)}\n${a.slice(20)} `), 'nor does whitespace');
assert.notEqual(addressId(a), addressId(b));
// sha256("tacit-address-id-v1\0" ‖ address), first 8 bytes, worked out independently of the module.
assert.equal(addressId(a), '5087·c134·76a7·10e2');
assert.equal(addressId(b), '7a96·7161·f12f·490e');
const plain = Array.from(sha256(new TextEncoder().encode(a)).subarray(0, 8), (x) => x.toString(16).padStart(2, '0')).join('');
assert.notEqual(addressId(a).replaceAll('·', ''), plain, 'the ID is domain-separated from a bare hash of the address');
console.log('address id checks passed');
