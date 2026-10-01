// Does eth_prove's committed resume file continue the eth digest chain the Bitcoin side has folded?
//
// The Bitcoin guest accepts an eth-state candidate only when its prior continues the eth digest the last Mode-B
// batch committed (reflect.rs: "eth-reflection prior must continue the committed chain"). eth_prove builds that
// prior from its committed file (eth_set_state.json), so the file must be exactly the candidate the Bitcoin side
// last folded, which the worker records as `confirmed`: the same cumulative cross-outs and consumes, through the
// same block. The pool's crossOutCount/bitcoinConsumedCount are no reference for this. They count everything
// Ethereum has recorded, including the entries no candidate has folded yet, which the next candidate exists to fold.
//
//   committed  the parsed eth_set_state.json, or null when there is none (eth_prove would start from zero)
//   confirmed  the worker's confirmed candidate { contentHash, crossouts, consumeds, lastBlock }, or null
//   -> null when a candidate built from `committed` continues the chain, or when there is no confirmed record to
//      check against (a cold start); otherwise a one-line reason

export function resumeMismatch({ committed, confirmed }) {
  if (!confirmed || !Array.isArray(confirmed.crossouts) || !Array.isArray(confirmed.consumeds) || confirmed.lastBlock == null) return null;
  const have = { crossouts: committed?.crossouts?.length ?? 0, consumeds: committed?.consumeds?.length ?? 0, lastBlock: Number(committed?.last_block ?? 0) };
  const want = { crossouts: confirmed.crossouts.length, consumeds: confirmed.consumeds.length, lastBlock: Number(confirmed.lastBlock) };
  if (have.crossouts === want.crossouts && have.consumeds === want.consumeds && have.lastBlock === want.lastBlock) return null;
  const fmt = (s) => `${s.crossouts} crossout(s)/${s.consumeds} consumed through block ${s.lastBlock}`;
  return `local committed eth_set_state.json ${committed ? `has ${fmt(have)}` : 'is missing'}, but the candidate the Bitcoin `
    + `side last folded (${confirmed.contentHash}) has ${fmt(want)}`;
}

// The committed file for a candidate the Bitcoin side folded after this sidecar stopped tracking it: it discarded
// its own candidate as stale (or restarted) and the fold landed anyway, so the commit never happened. The folded
// candidate carries the same records the committed file holds, through a later block, whenever it added no
// cross-out or consume: the file is then that candidate's state exactly, as eth_prove writes it: last_block =
// its block, bootstrap_slot = the finalized slot it reached (ethPv word 5, low 8 bytes). Anything else (records
// that differ, a block behind the file, no ethPv) is not rebuilt here.
//   -> the rebuilt committed object, or null
const lc = (h) => String(h ?? '').toLowerCase().replace(/^0x/, '');
export function rebuildFromConfirmed({ committed, confirmed }) {
  if (!committed || !confirmed || !Array.isArray(confirmed.crossouts) || !Array.isArray(confirmed.consumeds)) return null;
  const co = committed.crossouts || [], cn = committed.consumeds || [];
  if (confirmed.crossouts.length !== co.length || confirmed.consumeds.length !== cn.length) return null;
  const sameCo = confirmed.crossouts.every((c, i) => lc(c.claimId) === lc(co[i].claim_id) && lc(c.destCommitment) === lc(co[i].dest_commitment) && lc(c.asset) === lc(co[i].asset_id));
  const sameCn = confirmed.consumeds.every((c, i) => lc(c.nu) === lc(cn[i].nullifier) && lc(c.consumedVal) === lc(cn[i].spend_root) && lc(c.spendRoot) === lc(cn[i].btc_spend_root));
  if (!sameCo || !sameCn) return null;
  const block = Number(confirmed.lastBlock);
  if (!Number.isSafeInteger(block) || block < Number(committed.last_block ?? 0)) return null;
  const pv = lc(confirmed.ethPv);
  if (!/^[0-9a-f]*$/.test(pv) || pv.length < 6 * 64) return null;
  const slot = Number(BigInt('0x' + pv.slice(5 * 64 + 48, 6 * 64)));
  if (!Number.isSafeInteger(slot) || slot <= 0) return null;
  return { ...committed, last_block: block, bootstrap_slot: slot };
}
