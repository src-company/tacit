// A short ID of a whole address, the same text for the same address on every page. A tacit1… address is too long to read,
// and the few characters a page can show of it say little of the rest, so a payer and a payee compare this instead.
// 64 bits: an address that matches someone else's ID cannot be found by searching.
import { sha256, concatBytes } from './vendor/tacit-deps.min.js';

const te = new TextEncoder();
const TAG = te.encode('tacit-address-id-v1\0');

export function addressId(address) {
  const h = sha256(concatBytes(TAG, te.encode(String(address).toLowerCase().replace(/\s/g, ''))));
  const x = Array.from(h.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 4)}·${x.slice(4, 8)}·${x.slice(8, 12)}·${x.slice(12)}`;
}
