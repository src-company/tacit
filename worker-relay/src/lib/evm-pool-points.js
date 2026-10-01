// Points for public ETH deposited into the native-ETH EVM pool (contracts/src/TacitEvmPool.sol), one scan per
// chain. A deposit is a pool Transact with extAmount > 0, worth extAmount wei.
//
// Who earns it:
//   - a direct pool call or a router zap: the transaction's signer;
//   - a deposit-box completion or a receive-box sweep (router DepositBoxCompleted / Received in the same tx):
//     never the completer or sweeper. The box's
//     funders are found from its explorer history and each is credited for the share of its funding the
//     completion consumed (FIFO over the box's inflows and outflows). Funding that is itself a hop out of V1 or
//     this pool, a cross-chain system deposit, or from an excluded sender earns nothing.
// Box completions wait in a pending table until the explorer has indexed the completion, so an explorer outage
// holds back only those rows, never the chain's cursor or any other activity.

export const EVM_POOL_ACTIVITY = 'evmpooldeposit';

export const TRANSACT_EVENT = {
  type: 'event',
  name: 'Transact',
  inputs: [
    { name: 'nf0', type: 'bytes32', indexed: true },
    { name: 'nf1', type: 'bytes32', indexed: true },
    { name: 'outLeaf0', type: 'bytes32', indexed: false },
    { name: 'outLeaf1', type: 'bytes32', indexed: false },
    { name: 'firstIndex', type: 'uint256', indexed: false },
    { name: 'newRoot', type: 'bytes32', indexed: false },
    { name: 'recipient', type: 'address', indexed: false },
    { name: 'extAmount', type: 'int256', indexed: false },
    { name: 'relayer', type: 'address', indexed: false },
    { name: 'fee', type: 'uint256', indexed: false },
    { name: 'memo0', type: 'bytes', indexed: false },
    { name: 'memo1', type: 'bytes', indexed: false },
  ],
};

export const DEPOSIT_BOX_COMPLETED_EVENT = {
  type: 'event',
  name: 'DepositBoxCompleted',
  inputs: [
    { name: 'box', type: 'address', indexed: true },
    { name: 'completer', type: 'address', indexed: true },
  ],
};

export const RECEIVED_EVENT = {
  type: 'event',
  name: 'Received',
  inputs: [
    { name: 'box', type: 'address', indexed: true },
    { name: 'n', type: 'uint256', indexed: true },
    { name: 'index', type: 'uint256', indexed: false },
    { name: 'value', type: 'uint256', indexed: false },
    { name: 'rho', type: 'uint256', indexed: false },
    { name: 'fee', type: 'uint256', indexed: false },
  ],
};

export const WRAP_BOX_COMPLETED_EVENT = {
  type: 'event',
  name: 'WrapBoxCompleted',
  inputs: [
    { name: 'box', type: 'address', indexed: true },
    { name: 'completer', type: 'address', indexed: true },
  ],
};

// L2 system deposit transactions (OP-stack 0x7e, Arbitrum 0x64-0x6a). Their sender is a bridge alias or the
// L1 sender, so the value is a cross-chain arrival that cannot be attributed from this chain alone.
export const SYSTEM_TX_TYPES = new Set(['0x7e', '0x64', '0x65', '0x66', '0x68', '0x69', '0x6a']);

const lc = (a) => (a ? String(a).toLowerCase() : '');
const cmpBig = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A V1 Wrap sent through the EVM pool router (withdrawToV1 / completeWrap) moves value that was already
// private or already in a box, so it is never a new public entry. Matching on WrapBoxCompleted as well as
// tx.to also covers a router call made from inside a batched or delegated account.
export function isV1WrapViaEvmRouter(tx, txHash, wrapBoxTxs, router) {
  if (router && lc(tx?.to) === lc(router)) return true;
  return wrapBoxTxs.has(txHash);
}

// Who earns a funding (or a direct deposit), or null. `hops` are tx destinations or immediate senders whose
// value was already inside Tacit.
export function creditFor(tx, { hops, excluded, immediateFrom = null }) {
  const type = lc(tx.typeHex ?? tx.type);
  if (SYSTEM_TX_TYPES.has(type)) return null;
  if (tx.to && hops.has(lc(tx.to))) return null;
  if (immediateFrom && hops.has(lc(immediateFrom))) return null;
  const from = lc(tx.from);
  if (!from || excluded.has(from)) return null;
  return from;
}

export function openEvmPoolPointsState(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evm_pool_cursor (
      chain_id           INTEGER PRIMARY KEY,
      last_scanned_block INTEGER NOT NULL
    );
    -- Box completions whose funders are not resolved yet. ordinal = how many earlier completions of the same
    -- box the same tx holds; row_key = the deposits.tx_hash key base for this deposit's rows.
    CREATE TABLE IF NOT EXISTS evm_pool_pending (
      chain_id     INTEGER NOT NULL,
      tx_hash      TEXT NOT NULL,
      log_index    INTEGER NOT NULL,
      box          TEXT NOT NULL,
      completer    TEXT NOT NULL,
      ordinal      INTEGER NOT NULL,
      row_key      TEXT NOT NULL,
      amount_wei   TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      block_time   INTEGER NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chain_id, tx_hash, log_index)
    );
  `);
  const loadCursorStmt = db.prepare('SELECT last_scanned_block FROM evm_pool_cursor WHERE chain_id = ?');
  const saveCursorStmt = db.prepare(`
    INSERT INTO evm_pool_cursor (chain_id, last_scanned_block) VALUES (@chainId, @block)
    ON CONFLICT(chain_id) DO UPDATE SET last_scanned_block = excluded.last_scanned_block
  `);
  const addPendingStmt = db.prepare(`
    INSERT OR IGNORE INTO evm_pool_pending
      (chain_id, tx_hash, log_index, box, completer, ordinal, row_key, amount_wei, block_number, block_time)
    VALUES (@chainId, @txHash, @logIndex, @box, @completer, @ordinal, @rowKey, @amountWei, @blockNumber, @blockTime)
  `);
  const listPendingStmt = db.prepare(`
    SELECT * FROM evm_pool_pending WHERE chain_id = ? ORDER BY attempts, block_number, log_index LIMIT ?
  `);
  const countPendingStmt = db.prepare('SELECT COUNT(*) AS n FROM evm_pool_pending WHERE chain_id = ?');
  const bumpAttemptStmt = db.prepare('UPDATE evm_pool_pending SET attempts = attempts + 1 WHERE chain_id = ? AND tx_hash = ? AND log_index = ?');
  const deletePendingStmt = db.prepare('DELETE FROM evm_pool_pending WHERE chain_id = ? AND tx_hash = ? AND log_index = ?');
  return {
    loadCursor(chainId) {
      const row = loadCursorStmt.get(chainId);
      return row ? BigInt(row.last_scanned_block) : null;
    },
    saveCursor(chainId, block) { saveCursorStmt.run({ chainId, block: block.toString() }); },
    addPending(p) { addPendingStmt.run(p); },
    listPending(chainId, limit) { return listPendingStmt.all(chainId, limit); },
    countPending(chainId) { return countPendingStmt.get(chainId).n; },
    bumpAttempt(p) { bumpAttemptStmt.run(p.chain_id, p.tx_hash, p.log_index); },
    deletePending(p) { deletePendingStmt.run(p.chain_id, p.tx_hash, p.log_index); },
  };
}

export async function explorerGet(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; tacit-points)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`explorer ${res.status} ${url}`);
  return res.json();
}

async function paged(get, url, maxPages) {
  const items = [];
  let params = '';
  for (let page = 0; page < maxPages; page++) {
    const data = await get(`${url}${params}`);
    items.push(...(data.items || []));
    if (!data.next_page_params) return items;
    params = '?' + new URLSearchParams(
      Object.fromEntries(Object.entries(data.next_page_params).map(([k, v]) => [k, String(v)])),
    ).toString();
  }
  throw new Error(`explorer history longer than ${maxPages} pages: ${url}`);
}

// Every successful value movement into or out of `box`: top-level transfers to it (index -1) and internal
// ones in either direction. Internal index 0 is the top-level call itself and comes from the first list.
export async function fetchBoxHistory(get, apiBase, box, maxPages = 20) {
  const b = lc(box);
  const [txs, internals] = await Promise.all([
    paged(get, `${apiBase}/addresses/${box}/transactions`, maxPages),
    paged(get, `${apiBase}/addresses/${box}/internal-transactions`, maxPages),
  ]);
  const out = [];
  for (const t of txs) {
    if (lc(t.to?.hash) !== b || BigInt(t.value || 0) === 0n) continue;
    if (t.status !== 'ok' && t.result !== 'success') continue;
    out.push({
      txHash: t.hash, block: BigInt(t.block_number), txIndex: Number(t.position ?? 0), index: -1,
      from: lc(t.from?.hash), to: b, value: BigInt(t.value),
    });
  }
  for (const it of internals) {
    if (Number(it.index) === 0 || it.success === false || it.error) continue;
    const value = BigInt(it.value || 0);
    if (value === 0n) continue;
    const from = lc(it.from?.hash);
    const to = lc(it.to?.hash);
    if (from !== b && to !== b) continue;
    out.push({
      txHash: it.transaction_hash, block: BigInt(it.block_number), txIndex: Number(it.transaction_index ?? 0),
      index: Number(it.index), from, to, value,
    });
  }
  return out;
}

// Replays the box's balance FIFO. Each outflow records which inflows it consumed; an outflow larger than what
// the history shows coming in leaves a shortfall that nobody is credited for.
export function allocateBoxFunding(history, box) {
  const b = lc(box);
  const events = [...history].sort((x, y) => cmpBig(x.block, y.block) || x.txIndex - y.txIndex || x.index - y.index);
  const queue = [];
  const outflows = [];
  for (const ev of events) {
    if (ev.to === b && ev.from !== b) {
      queue.push({ txHash: ev.txHash, index: ev.index, from: ev.from, remaining: ev.value });
    } else if (ev.from === b && ev.to !== b) {
      let need = ev.value;
      const consumed = [];
      while (need > 0n && queue.length) {
        const head = queue[0];
        const take = head.remaining < need ? head.remaining : need;
        consumed.push({ txHash: head.txHash, index: head.index, from: head.from, amount: take });
        head.remaining -= take;
        need -= take;
        if (head.remaining === 0n) queue.shift();
      }
      outflows.push({ txHash: ev.txHash, index: ev.index, to: ev.to, value: ev.value, consumed, shortfall: need });
    }
  }
  return outflows;
}

function rowKey(base, n) {
  return n === 0 ? base : `${base}:${n}`;
}

// ctx: { store, state, chainId, client, apiBase, startBlock, pool, router, v1Pool, v1Router, excluded (Set),
//        confirmations, chunk, maxChunks, resolvePerCycle, capTip?(tip), explorerGet, pointsFor(amountWei, prior),
//        evalBlock(chainId, blockNumber, blockTime), covered(evalBlock), multipliers(address, evalBlock) →
//        { tacB, zShareB, ppB }, log }
function hopsFor(ctx) {
  return {
    direct: new Set([lc(ctx.v1Pool), lc(ctx.v1Router)].filter(Boolean)),
    funding: new Set([lc(ctx.v1Pool), lc(ctx.v1Router), lc(ctx.pool), lc(ctx.router)].filter(Boolean)),
  };
}

async function credit(ctx, { key, blockNumber, blockTime, depositor, amountWei }) {
  const evalBlock = await ctx.evalBlock(ctx.chainId, blockNumber, blockTime);
  const { tacB, zShareB, ppB = 1 } = ctx.multipliers(depositor, evalBlock);
  const prior = ctx.store.countByActivity(EVM_POOL_ACTIVITY);
  return ctx.store.recordDeposit({
    txHash: key, blockNumber: Number(blockNumber), blockTime: Number(blockTime),
    depositor, amountWei: amountWei.toString(), priorDepositCount: prior,
    points: ctx.pointsFor(amountWei, prior) * ppB * tacB * zShareB, activity: EVM_POOL_ACTIVITY,
    ppBoosted: ppB > 1 ? 1 : 0, tacBoost: tacB, zShareBoost: zShareB, chainId: ctx.chainId,
  });
}

export async function scanEvmPoolChain(ctx) {
  const { state, chainId, client } = ctx;
  if (ctx.startBlock == null || ctx.startBlock === '') return;
  const code = await client.getCode({ address: ctx.pool });
  if (!code || code === '0x') return;

  let tip = (await client.getBlockNumber()) - BigInt(ctx.confirmations);
  if (ctx.capTip) tip = ctx.capTip(tip);
  let cursor = state.loadCursor(chainId) ?? BigInt(ctx.startBlock) - 1n;
  const hops = hopsFor(ctx);
  const blockTimes = new Map();
  const blockTime = async (n) => {
    if (!blockTimes.has(n)) blockTimes.set(n, BigInt((await client.getBlock({ blockNumber: n })).timestamp));
    return blockTimes.get(n);
  };

  for (let chunks = 0; cursor < tip && chunks < ctx.maxChunks; chunks++) {
    const from = cursor + 1n;
    const to = from + BigInt(ctx.chunk) - 1n < tip ? from + BigInt(ctx.chunk) - 1n : tip;
    const [txLogs, completedLogs, receivedLogs] = await Promise.all([
      client.getLogs({ address: ctx.pool, event: TRANSACT_EVENT, fromBlock: from, toBlock: to }),
      client.getLogs({ address: ctx.router, event: DEPOSIT_BOX_COMPLETED_EVENT, fromBlock: from, toBlock: to }),
      client.getLogs({ address: ctx.router, event: RECEIVED_EVENT, fromBlock: from, toBlock: to }),
    ]);
    const boxLogs = [...completedLogs, ...receivedLogs];
    const deposits = txLogs
      .filter((l) => l.args.extAmount > 0n)
      .sort((a, b) => cmpBig(a.blockNumber, b.blockNumber) || a.logIndex - b.logIndex);

    if (deposits.length) {
      const last = deposits[deposits.length - 1];
      const gate = await ctx.evalBlock(chainId, last.blockNumber, await blockTime(last.blockNumber));
      if (!ctx.covered(gate)) return; // boost replay behind; retry this chunk next cycle
    }

    // Pair each completion or sweep with the nearest earlier unpaired deposit in its tx: the pool's Transact is
    // emitted inside completeDeposit / sweepReceive, before the router's own event.
    const byTx = new Map();
    for (const d of deposits) {
      if (!byTx.has(d.transactionHash)) byTx.set(d.transactionHash, { deposits: [], boxes: [] });
      byTx.get(d.transactionHash).deposits.push(d);
    }
    for (const b of boxLogs) byTx.get(b.transactionHash)?.boxes.push(b);
    const completionOf = new Map(); // deposit log -> { box, completer, ordinal }
    for (const { deposits: ds, boxes } of byTx.values()) {
      boxes.sort((a, b) => a.logIndex - b.logIndex);
      const seenPerBox = new Map();
      for (const b of boxes) {
        const d = [...ds].reverse().find((x) => x.logIndex < b.logIndex && !completionOf.has(x));
        if (!d) continue;
        const box = lc(b.args.box);
        const ordinal = seenPerBox.get(box) ?? 0;
        seenPerBox.set(box, ordinal + 1);
        completionOf.set(d, { box, completer: lc(b.args.completer ?? ''), ordinal });
      }
    }

    for (const d of deposits) {
      const group = byTx.get(d.transactionHash).deposits;
      const base = group.length === 1 ? d.transactionHash : `${d.transactionHash}:${d.logIndex}`;
      const time = await blockTime(d.blockNumber);
      const completion = completionOf.get(d);
      if (completion) {
        state.addPending({
          chainId, txHash: d.transactionHash, logIndex: d.logIndex, box: completion.box, completer: completion.completer,
          ordinal: completion.ordinal, rowKey: base, amountWei: d.args.extAmount.toString(),
          blockNumber: Number(d.blockNumber), blockTime: Number(time),
        });
        continue;
      }
      const tx = await client.getTransaction({ hash: d.transactionHash });
      const depositor = creditFor(tx, { hops: hops.direct, excluded: ctx.excluded });
      if (!depositor) continue;
      await credit(ctx, { key: base, blockNumber: d.blockNumber, blockTime: time, depositor, amountWei: d.args.extAmount });
    }

    cursor = to;
    state.saveCursor(chainId, to);
  }
}

// Resolves pending box completions. A row stays pending (and is retried next cycle) while the explorer is
// unreachable or has not indexed the completion's release from the box yet; rows that keep failing sort last so
// they cannot starve newer ones.
export async function resolvePendingBoxes(ctx) {
  const { state, chainId, client } = ctx;
  const hops = hopsFor(ctx);
  const txCache = new Map();
  const getTx = async (hash) => {
    if (!txCache.has(hash)) txCache.set(hash, await client.getTransaction({ hash }));
    return txCache.get(hash);
  };

  for (const p of state.listPending(chainId, ctx.resolvePerCycle)) {
    try {
      const evalBlock = await ctx.evalBlock(chainId, BigInt(p.block_number), BigInt(p.block_time));
      if (!ctx.covered(evalBlock)) continue;
      const history = await fetchBoxHistory(ctx.explorerGet, ctx.apiBase, p.box);
      const releases = allocateBoxFunding(history, p.box)
        .filter((o) => lc(o.txHash) === lc(p.tx_hash) && o.to === lc(ctx.router));
      const release = releases[p.ordinal];
      if (!release) { state.bumpAttempt(p); continue; }

      let budget = BigInt(p.amount_wei);
      const credited = new Map(); // address -> wei, in first-funding order
      for (const c of release.consumed) {
        if (budget === 0n) break;
        const take = c.amount < budget ? c.amount : budget;
        budget -= take;
        const funder = creditFor(await getTx(c.txHash), { hops: hops.funding, excluded: ctx.excluded, immediateFrom: c.from });
        if (funder) credited.set(funder, (credited.get(funder) ?? 0n) + take);
      }
      let n = 0;
      for (const [depositor, amountWei] of credited) {
        await credit(ctx, {
          key: rowKey(p.row_key, n++), blockNumber: BigInt(p.block_number), blockTime: BigInt(p.block_time), depositor, amountWei,
        });
      }
      state.deletePending(p);
    } catch (err) {
      state.bumpAttempt(p);
      ctx.log?.(`evm pool box ${p.box} (chain ${chainId}) not resolved yet:`, err?.message || err);
    }
  }
}
