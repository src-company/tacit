// The settle relay's pass over the proof market's order board (worker/src/proof-market-queue.js): take an open order, claim it, prove its
// input and fulfil it, so the holder's op is settled and the relay is paid in TAC from the holder's permit. We are first in line: the
// claim is made at the order's current price, which excludes every other prover for the claim window; a prover that is quicker or cheaper
// than us gets there first only by claiming before we do, and a holder who wants it faster raises what they sign.
//
// The claim and the proof run at the same time, so the proof is ready by the time the claim is mined; the fulfil goes out only if the
// claim is still live. A claim that lapses before the proof comes back costs only the bond (none to start). Nothing here is paid for until
// the market's pool accepts the proof, so a failed order costs gas for the claim and the proving it took, no more.
//
// A proof that is ready before the holder's deposit has landed waits for it, up to the end of the claim.
// Dependencies are injected so the loop is tested without a chain: listOrders(), done(opId), claim(order) -> tx, prove(order) ->
// { publicValues, proof }, fulfil(order, proof) -> tx, clear(opId), claimOf(opId) -> { solver, until }.
// The price the market charges `at` (unix seconds) for an order's intent (mirrors ProofMarket.priceAt).
function priceAt(intent, at) {
  const floor = BigInt(intent.floorFee), max = BigInt(intent.maxFee), ramp = BigInt(intent.rampSecs), t = BigInt(at) - BigInt(intent.start);
  if (ramp === 0n || t >= ramp) return max;
  if (t <= 0n) return floor;
  return floor + ((max - floor) * t) / ramp;
}

export function makeMarketSolver({ listOrders, done, claim, prove, fulfil, clear, claimOf, me, minPrice = 0n, retryMs = 120_000, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const tried = new Map(); // opId -> when it last failed here, so one bad order is not tried every pass
  return {
    // One order at most per pass (one prover, one key). → true when an order was worked on.
    async pass() {
      const t = Math.floor(now() / 1000);
      let orders;
      try { orders = await listOrders(); } catch (e) { log(`market: could not read the board: ${e.message}`); return false; }
      for (const o of orders) {
        const id = o.intent.opId;
        if (now() - (tried.get(id) || 0) < retryMs) continue;
        if (Number(o.intent.deadline) <= t + 30) continue;
        if (priceAt(o.intent, t) < minPrice) continue;
        try {
          if (await done(id)) { await clear(id).catch(() => {}); continue; }
          const held = await claimOf(id);
          if (held && held.until > t && held.solver.toLowerCase() !== me.toLowerCase()) continue; // another prover has it
          log(`market: taking order ${id.slice(0, 10)} at ${priceAt(o.intent, t)} TAC wei`);
          const [claimTx, proof] = await Promise.all([claim(o), prove(o)]);
          const live = await claimOf(id);
          if (!live || live.solver.toLowerCase() !== me.toLowerCase() || live.until <= Math.floor(now() / 1000)) {
            log(`market: order ${id.slice(0, 10)}: the claim lapsed before the proof came back; leaving it`);
            tried.set(id, now());
            return true;
          }
          // The holder's own transaction (the deposit this proof settles) may not have landed yet: the fulfil is tried again while the claim lasts.
          let tx, last;
          for (;;) {
            try { tx = await fulfil(o, proof); break; } catch (e) { last = e; }
            if (Math.floor(now() / 1000) + 6 >= live.until) throw last;
            await sleep(4000);
          }
          log(`market: order ${id.slice(0, 10)} settled: claim ${claimTx} fulfil ${tx}`);
          await clear(id).catch(() => {});
          return true;
        } catch (e) {
          log(`market: order ${id.slice(0, 10)} failed: ${String(e.message || e).slice(0, 200)}`);
          tried.set(id, now());
          return true;
        }
      }
      return false;
    },
  };
}
