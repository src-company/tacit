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
