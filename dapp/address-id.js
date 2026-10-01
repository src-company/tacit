// A short ID of a whole address, the same text for the same address on every page. A tacit1… address is too long to read,
// and the few characters a page can show of it say little of the rest, so a payer and a payee compare this instead.
import { sha256 } from './vendor/tacit-deps.min.js';

export function addressId(address) {
  const h = sha256(new TextEncoder().encode(String(address).toLowerCase().replace(/\s/g, '')));
  const x = Array.from(h.subarray(0, 5), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 4)}·${x.slice(4, 8)}·${x.slice(8)}`;
}
