// Finds the transaction that already did a job's work on chain.
//
// A settle pays its bound fee to whoever sends it, and the proof alone decides what the settle does, so a copy of
// our settle landed by another sender did exactly what ours would have: the user's op is done, only the fee went
// elsewhere. The same holds for a job served again after its first settle landed. In both cases the job should be
// reported settled with that transaction, not failed because our own transaction had nothing left to do.
//
// findCarrier looks through the pool's logs from `fromBlock` to the head, newest first, for a successful
// transaction whose calldata carries every needle (hex: a proof's public values, or a job's sealed memos). The
// calldata is what the pool executed, whether the pool was called directly or through a contract, so a match on
// the public values is a match on the whole op. Bounded by `maxTxs` distinct transactions read.
export async function findCarrier({ client, pool, needles, fromBlock, maxTxs = 60, chunk = 5000n }) {
  const want = (needles || []).map((n) => String(n || '').replace(/^0x/i, '').toLowerCase()).filter((n) => n.length >= 64);
  if (!want.length) return null;
  const head = await client.getBlockNumber();
  const floor = BigInt(fromBlock) < 0n ? 0n : BigInt(fromBlock);
  const seen = new Set();
  for (let hi = head; hi >= floor; hi -= chunk) {
    const lo = hi - chunk + 1n > floor ? hi - chunk + 1n : floor;
    const logs = await client.getLogs({ address: pool, fromBlock: lo, toBlock: hi });
    for (const l of [...logs].reverse()) {
      const h = l.transactionHash;
      if (!h || seen.has(h)) continue;
      if (seen.size >= maxTxs) return null;
      seen.add(h);
      const tx = await client.getTransaction({ hash: h });
      const input = String(tx.input || '').toLowerCase();
      if (!want.every((n) => carries(input, n))) continue;
      const r = await client.getTransactionReceipt({ hash: h });
      if (r.status === 'success') return h;
    }
    if (lo === floor) break;
  }
  return null;
}

// Byte-aligned containment: a needle found at an odd hex offset is not the same bytes.
function carries(input, needle) {
  for (let i = input.indexOf(needle); i !== -1; i = input.indexOf(needle, i + 1)) if (i % 2 === 0) return true;
  return false;
}

// Viem wraps a node's revert several layers deep; a settle that reverts in simulation is the chain's answer, not
// an endpoint problem, and trying the other endpoints or a higher tip cannot change it.
export function isRevert(e) {
  for (let x = e, d = 0; x && d < 8; x = x.cause, d++) {
    if (x.name === 'ContractFunctionRevertedError' || (x.name === 'CallExecutionError' && /revert/i.test(String(x.message)))) return true;
    if (/execution reverted|reverted with the following|reverted with reason/i.test(String(x.shortMessage || x.details || ''))) return true;
  }
  return false;
}
