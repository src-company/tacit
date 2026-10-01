// The pool address a pay field stands for: a bp1… address as typed, or the pool lane of a tacit1… address. Pool keys are
// bound to their network, so another network's address is refused.
import { secp } from './vendor/tacit-deps.min.js';
import { makeTacitAddress, POOL_HRP_BY_NETWORK } from './tacit-address.js';

const { decodeTacitAddress } = makeTacitAddress({ secp });
const NET_NAME = { mainnet: 'mainnet', signet: 'a test network' };

export function poolRecipient(text, network = 'mainnet') {
  const hrp = POOL_HRP_BY_NETWORK[network];
  if (!hrp) throw new Error(`No pool address prefix for ${network}.`);
  const s = String(text ?? '').trim().replace(/\s/g, '');
  let out = s;
  if (/^tac(it|tt|rt)1/i.test(s)) {
    let d;
    try { d = decodeTacitAddress(s.toLowerCase()); } catch { throw new Error('Not a valid Tacit address.'); }
    if (d.network !== network) throw new Error(`That Tacit address is for ${NET_NAME[d.network] || d.network}.`);
    if (!d.lanes.pool) throw new Error('This Tacit address is from before pool payments, so it can’t receive in the pool yet. Ask for their pool address (bp1…), or pay it from tacit.finance/pay.');
    out = d.lanes.pool.poolAddress;
  }
  const m = /^(t?bp)1/i.exec(out);
  if (m && m[1].toLowerCase() !== hrp) throw new Error(`That pool address is for ${network === 'mainnet' ? 'a test network' : 'mainnet'}.`);
  return out;
}
