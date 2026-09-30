// No environment is read here, so services with their own configuration (the EVM pool keeper) can import it
// without loading config.js, which requires the relay's variables.

// The mode of a known private endpoint that keeps a settle between the relay and the builders: Flashbots Protect
// with only the hash hinted to searchers (it drops reverting transactions unless canRevert is set), and MEV
// Blocker's fullprivacy route (no searchers, no reverts). Any other URL is used as given.
export function privateSettleUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return raw; }
  if (u.hostname === 'rpc.flashbots.net') {
    u.searchParams.delete('hint');
    u.searchParams.delete('canRevert');
    u.searchParams.append('hint', 'hash');
  } else if (u.hostname === 'mevblocker.io' || u.hostname.endsWith('.mevblocker.io')) {
    u.hostname = 'rpc.mevblocker.io';
    u.pathname = '/fullprivacy';
    u.search = '';
  }
  return u.toString();
}
