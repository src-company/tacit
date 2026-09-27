// The pool's leaves, rebuilt from its Transact events: each event with a non-zero output appends (outLeaf0,
// outLeaf1) at firstIndex, an empty output included; an event whose outputs are both empty inserted nothing.
// Leaves from blocks at least `confirmations` deep are persisted, with those blocks' Transact and Received events
// (served to wallets by /events); the unconfirmed tail is re-read on every sync so a reorg above that depth never
// lands in the store. The tree over the persisted leaves is kept incrementally in memory, so a sync costs hashes
// only for new leaves.
//
// chain: { blockNumber(), transactLogs(from, to) → [{ firstIndex, outLeaf0, outLeaf1, blockNumber, logIndex, tx, nf0,
//          nf1, memo0, memo1 }], receivedLogs?(from, to) → [{ box, n, index, value, rho, fee, blockNumber, logIndex,
//          tx }], poolState(blockNumber) → { root, nextIndex } }

export class LeafSyncError extends Error {}

const str = (x) => (x === undefined || x === null ? null : typeof x === 'bigint' ? x.toString() : String(x));

// A stored event's JSON: what a wallet needs to find and spend its notes.
function transactEvent(e) {
  return {
    kind: 'transact', block: Number(e.blockNumber), tx: e.tx ?? null, firstIndex: Number(e.firstIndex),
    nf0: str(e.nf0), nf1: str(e.nf1), outLeaf0: str(BigInt(e.outLeaf0)), outLeaf1: str(BigInt(e.outLeaf1)),
    memo0: e.memo0 ?? '0x', memo1: e.memo1 ?? '0x',
  };
}
function receivedEvent(e) {
  return {
    kind: 'received', block: Number(e.blockNumber), tx: e.tx ?? null, box: String(e.box).toLowerCase(), n: str(e.n),
    index: Number(e.index), value: str(e.value), rho: str(e.rho), fee: str(e.fee),
  };
}

export function makeLeafSync({ store, chain, zk, startBlock = 0n, confirmations = 12n, logChunk = 2000n, log = () => {} }) {
  const synced = () => {
    const v = store.getMeta('synced_block');
    return v === null ? BigInt(startBlock) - 1n : BigInt(v);
  };
  let base = null; // incTree over the persisted leaves

  function ordered(logs, expectFrom) {
    const sorted = [...logs].filter((e) => BigInt(e.outLeaf0) !== 0n || BigInt(e.outLeaf1) !== 0n).sort((a, b) => (BigInt(a.firstIndex) < BigInt(b.firstIndex) ? -1 : 1));
    const out = [];
    let next = BigInt(expectFrom);
    for (const e of sorted) {
      if (BigInt(e.firstIndex) !== next) throw new LeafSyncError(`Transact at index ${e.firstIndex}, expected ${next}`);
      out.push({ leaf: BigInt(e.outLeaf0), block: BigInt(e.blockNumber) }, { leaf: BigInt(e.outLeaf1), block: BigInt(e.blockNumber) });
      next += 2n;
    }
    return out;
  }

  function reset() {
    store.resetLeaves();
    base = null;
  }

  // Returns { tree, root, nextIndex, head }: an incTree over every leaf the pool holds at `head`, and its root there.
  async function sync() {
    const head = BigInt(await chain.blockNumber());
    const safe = head - BigInt(confirmations);
    try {
      if (!base) { base = zk.incTree(); base.append(store.leaves()); }
      for (let from = synced() + 1n; from <= safe; ) {
        const to = from + BigInt(logChunk) - 1n > safe ? safe : from + BigInt(logChunk) - 1n;
        const [txs, recs] = await Promise.all([chain.transactLogs(from, to), chain.receivedLogs ? chain.receivedLogs(from, to) : []]);
        const items = ordered(txs, store.leafCount());
        const events = [
          ...txs.map((e) => ({ block: e.blockNumber, logIndex: e.logIndex ?? 0, ev: transactEvent(e) })),
          ...recs.map((e) => ({ block: e.blockNumber, logIndex: e.logIndex ?? 0, ev: receivedEvent(e) })),
        ];
        store.appendLeaves(items, to, events);
        base.append(items.map((x) => x.leaf));
        from = to + 1n;
      }
    } catch (e) {
      if (e instanceof LeafSyncError) { log(`leaf store inconsistent (${e.message}); resyncing from the start block`); reset(); }
      throw e;
    }
    const tailFrom = synced() + 1n;
    const tail = tailFrom <= head ? ordered(await chain.transactLogs(tailFrom, head), base.size) : [];
    const tree = base.clone();
    tree.append(tail.map((t) => t.leaf));
    const { root, nextIndex } = await chain.poolState(head);
    if (BigInt(tree.size) !== BigInt(nextIndex)) {
      // Fewer: the log provider lags the state provider; retry next tick. More: the store holds a dropped block.
      if (BigInt(tree.size) > BigInt(nextIndex)) reset();
      throw new LeafSyncError(`have ${tree.size} leaves, pool holds ${nextIndex} at block ${head}`);
    }
    return { tree, root: BigInt(root), nextIndex: BigInt(nextIndex), head };
  }

  // Stored events from `fromBlock` on, whole blocks only, at most about `limit`. → { events, through }: every event
  // in blocks fromBlock..through (through = the synced block when nothing is cut off).
  function eventsFrom(fromBlock, limit) {
    const top = store.syncedBlock();
    if (top === null || fromBlock > top) return { events: [], through: top ?? Number(startBlock) - 1 };
    const rows = store.eventsFrom(fromBlock, limit + 1);
    if (rows.length <= limit) return { events: rows.map((r) => r.ev), through: top };
    const last = rows[rows.length - 1].block;
    const whole = rows.filter((r) => r.block < last);
    if (whole.length) return { events: whole.map((r) => r.ev), through: last - 1 };
    const one = store.eventsFrom(last, 100_000).filter((r) => r.block === last); // one block holds more than `limit`
    return { events: one.map((r) => r.ev), through: last };
  }

  return { sync, eventsFrom, invalidate: reset };
}
