// The settle relay's pass over the proof market's order board (worker/src/proof-market-queue.js): take an open order, claim it, prove its
// input and fulfil it, so the holder's op is settled and the relay is paid in TAC from the holder's permit. We are first in line: the
// claim is made at the order's current price, which excludes every other prover for the claim window; a prover that is quicker or cheaper
// than us gets there first only by claiming before we do, and a holder who wants it faster raises what they sign.
//
// The claim and the proof run at the same time, so the proof is ready by the time the claim is mined; the fulfil goes out only if the
// claim is still live. A claim that lapses before the proof comes back costs only the bond (none to start). Nothing here is paid for until
// the market's pool accepts the proof, so a failed order costs gas for the claim and the proving it took, no more.
//
// Dependencies are injected so the loop is tested without a chain: listOrders(), done(opId), claim(order) -> tx, prove(order) ->
// { publicValues, proof }, fulfil(order, proof) -> tx, clear(opId), claimOf(opId) -> { solver, until }.
// The price the market charges `at` (unix seconds) for an order's intent (mirrors ProofMarket.priceAt).
function priceAt(intent, at) {
  const floor = BigInt(intent.floorFee), max = BigInt(intent.maxFee), ramp = BigInt(intent.rampSecs), t = BigInt(at) - BigInt(intent.start);
  if (ramp === 0n || t >= ramp) return max;
  if (t <= 0n) return floor;
  return floor + ((max - floor) * t) / ramp;
}

// The deposit a wrap's public values consume (word 36 of the fixed 55-word layout, dapp/proof-market.js wrapPublicValues).
export const depositOf = (publicValues) => '0x' + String(publicValues).replace(/^0x/, '').slice(36 * 64, 37 * 64);

export function makeMarketSolver({ listOrders, done, claim, prove, fulfil, clear, claimOf, depositStatus, deliver = null, me, minPrice = 0n, retryMs = 120_000, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const tried = new Map();   // opId -> when it last failed here, so one bad order is not tried every pass
  const proofs = new Map();  // opId -> the proof being made (or made) for it: proving starts when an order is seen, the claim waits for its deposit
  let busy = false;          // one prover: one proof at a time
  return {
    // Whether an order is being proved or waits for its deposit: the relay then looks again in seconds, not on its long idle wait.
    hasOpen: () => proofs.size > 0,
    // One order at most is claimed per pass (one key). → true when an order was claimed and worked on.
    async pass() {
      const t = Math.floor(now() / 1000);
      let orders;
      try { orders = await listOrders(); } catch (e) { log(`market: could not read the board: ${e.message}`); return false; }
      // The least price worth taking: a number, or a function (the relay prices its gas and proving in TAC each pass). A claim lands about half a minute on.
      let minP;
      try { minP = typeof minPrice === 'function' ? await minPrice() : minPrice; } catch (e) { log(`market: could not price the work: ${e.message}`); return false; }
      const open = new Set(orders.map((o) => o.intent.opId));
      for (const id of proofs.keys()) if (!open.has(id)) proofs.delete(id);
      for (const o of orders) {
        const id = o.intent.opId;
        if (now() - (tried.get(id) || 0) < retryMs) continue;
        if (Number(o.intent.deadline) <= t + 30) continue;
        if (priceAt(o.intent, t + 30) < minP) continue;
        let soon = false;
        try {
          if (await done(id)) { await clear(id).catch(() => {}); continue; }
          const held = await claimOf(id);
          if (held && held.until > t && held.solver.toLowerCase() !== me.toLowerCase()) continue; // another prover has it
          // The proof is started as soon as the order is seen, so it is ready when the holder's deposit lands.
          let proving = proofs.get(id);
          if (!proving) {
            if (busy) continue;
            busy = true;
            log(`market: proving order ${id.slice(0, 10)}`);
            // a finished proof is handed back for the holder too (best effort): if the deposit never comes, the page keeps it as a voucher
            proving = prove(o).then(async (p) => { if (deliver) await deliver(o, p).catch(() => {}); return p; }).finally(() => { busy = false; });
            proving.catch(() => proofs.delete(id));   // a proof that failed is made again next time; one that came back is kept
            proofs.set(id, proving);
          }
          // An order whose holder never sent the deposit (an abandoned zap) is never claimed: a claim costs gas.
          if (Number(await depositStatus(depositOf(o.publicValues))) !== 1) continue;
          log(`market: order ${id.slice(0, 10)}: deposit pending, waiting for the proof, then claiming`);
          // Proof first, then the claim: the claim window (a minute) starts when the claim lands, so it is made when the proof is in hand and the fulfil
          // follows in the next block, rather than racing a proof that may take most of the window.
          const proof = await proving;
          const claimTx = await claim(o);
          const live = await claimOf(id);
          if (!live || live.solver.toLowerCase() !== me.toLowerCase() || live.until <= Math.floor(now() / 1000)) {
            // the proof is kept: the next try claims again at once rather than proving again
            log(`market: order ${id.slice(0, 10)}: the claim lapsed before it was fulfilled; trying again shortly`);
            tried.set(id, now() - retryMs + 10_000);
            return true;
          }
          let tx, last;
          for (;;) {
            try { tx = await fulfil(o, proof); break; } catch (e) { last = e; }
            if (Math.floor(now() / 1000) + 6 >= live.until) { soon = true; throw last; }
            await sleep(4000);
          }
          log(`market: order ${id.slice(0, 10)} settled: claim ${claimTx} fulfil ${tx}`);
          proofs.delete(id);
          await clear(id).catch(() => {});
          return true;
        } catch (e) {
          log(`market: order ${id.slice(0, 10)} failed: ${String(e.message || e).slice(0, 200)}`);
          tried.set(id, soon ? now() - retryMs + 10_000 : now());
          return true;
        }
      }
      return false;
    },
  };
}
