// Before a cUSD loan (cdpmint) or a collateral top-up (cdptopup) is paid for, read the gate the collateral engine applies at
// settle: only cBTC backs cUSD, the BTC/USD mark must be fresh (the engine fails closed on a stale feed) and not freshly
// swapped, the rate snapshot must be a real past-or-present mark, and the basket must clear the collateral floor at today's
// price. Failing any of these makes the settle revert whatever its proof, so the job is failed without proving, with a
// reason the borrower can act on. Anything unreadable lets the job through, so the check only ever skips work that cannot
// succeed. A repay (cdpclose) is unconditional in the engine and needs no check.
import { pad } from 'viem';

const view = (name, inputs, output) => ({ type: 'function', name, stateMutability: 'view', inputs: inputs.map((type) => ({ type })), outputs: [{ type: output }] });
const POOL_ABI = [view('COLLATERAL_ENGINE', [], 'address')];
const ENGINE_ABI = [
  view('CBTC_ASSET_ID', [], 'bytes32'), view('btcToUsd', ['uint256'], 'uint256'), view('cdpRatioBps', [], 'uint256'),
  view('rate', [], 'uint256'), view('lastFeedChangeAt', [], 'uint256'),
  { type: 'error', name: 'StaleFeed', inputs: [] }, { type: 'error', name: 'BadFeed', inputs: [] },
];
const RAY = 10n ** 27n;
const FEED_CHANGE_GRACE_SECS = 6n * 3600n; // CollateralEngine.FEED_CHANGE_LIQ_GRACE (internal)
const CUSD = (v) => (Number(v) / 1e8).toFixed(2);

const b32 = (v) => pad(String(v).startsWith('0x') ? String(v) : `0x${v}`, { size: 32 }).toLowerCase();
const ceilDiv = (a, b) => (a + b - 1n) / b;

// A reason string when the settle can only revert, else null.
export async function cdpBlocker({ type, op }, { client, pool, now = () => BigInt(Math.floor(Date.now() / 1000)) }) {
  if ((type !== 'cdpmint' && type !== 'cdptopup') || !op || op.debtValue == null || op.rateSnapshot == null) return null;
  const legs = type === 'cdpmint' ? op.legs : [...(op.oldLegs || []), ...(op.addedLegs || [])];
  if (!Array.isArray(legs) || !legs.length) return null;
  try {
    const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
    const engine = await read(pool, POOL_ABI, 'COLLATERAL_ENGINE');
    const [cbtc, ratio, rate, changedAt] = await Promise.all([
      read(engine, ENGINE_ABI, 'CBTC_ASSET_ID'), read(engine, ENGINE_ABI, 'cdpRatioBps'),
      read(engine, ENGINE_ABI, 'rate'), read(engine, ENGINE_ABI, 'lastFeedChangeAt'),
    ]);
    if (legs.some((l) => b32(l.asset) !== String(cbtc).toLowerCase())) return 'only cBTC can back cUSD';
    const snap = BigInt(op.rateSnapshot);
    if (snap < RAY || snap > BigInt(rate)) return 'its rate snapshot is not a current mark; build it again';
    const until = BigInt(changedAt) + FEED_CHANGE_GRACE_SECS;
    if (now() < until) return `the BTC price feed was just changed, and loans reopen at ${new Date(Number(until) * 1000).toISOString().slice(0, 16)} UTC`;
    const sats = legs.reduce((s, l) => s + BigInt(l.value), 0n);
    let usd;
    try { usd = BigInt(await read(engine, ENGINE_ABI, 'btcToUsd', [sats])); } catch (e) {
      if (/StaleFeed|BadFeed/.test(`${e?.shortMessage || ''} ${e?.message || ''}`)) return 'the BTC price feed is updating; try again in a few minutes';
      return null;
    }
    const debt = BigInt(op.debtValue);
    const owed = BigInt(rate) <= snap ? debt : ceilDiv(debt * BigInt(rate), snap);
    if (owed * BigInt(ratio) > usd * 10_000n) {
      return `the loan is under the ${Number(ratio) / 100}% floor at today's BTC price; this collateral backs at most ${CUSD(usd * 10_000n / BigInt(ratio))} cUSD`;
    }
  } catch { return null; }
  return null;
}
