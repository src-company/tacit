import assert from 'node:assert/strict';
import { addressId } from '../dapp/address-id.js';

const a = 'tacit1qzzsxqmzlglgkpv467x5wsakndy5vdm7nqexample', b = 'tacit1qzzsxqs0rwdrhq8yjye05qlupsn63qadpzexample';
assert.match(addressId(a), /^[0-9a-f]{4}·[0-9a-f]{4}·[0-9a-f]{2}$/);
assert.equal(addressId(a), addressId(a.toUpperCase()), 'case does not change it');
assert.equal(addressId(a), addressId(`  ${a.slice(0, 20)}\n${a.slice(20)} `), 'nor does whitespace');
assert.notEqual(addressId(a), addressId(b));
console.log('address id checks passed');
