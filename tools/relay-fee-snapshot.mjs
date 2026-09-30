// Snapshots the tacit-settle relay's fee-subsidy mix (which op types settle for free vs. paid, and how
// often) from Render's own log stream, and appends it to a durable local file. Nothing else — no fee
// policy change, no new Render service, no ongoing cost. Render's standard plan keeps ~7 days of logs, so
// this exists to keep the data past that window until there is enough of it to decide what to change.
//
// Usage: RENDER_API_KEY=... node tools/relay-fee-snapshot.mjs
// Run it whenever — each run appends one dated entry to ops/relay-fee-snapshots.jsonl (gitignored, local
// only) with per-op-type settled/subsidized counts since the previous run's cursor.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const KEY = process.env.RENDER_API_KEY;
if (!KEY) { console.error('set RENDER_API_KEY'); process.exit(1); }

const OWNER = 'tea-d6v0ghf5gffc73d1n4k0';
const SETTLE_SVC = 'srv-d9fl6btaeets73ca8heg';
const MONITOR_SVC = 'crn-d9eb08bbc2fs73fkm8h0';
const OUT_DIR = path.join(process.cwd(), 'ops');
const OUT_FILE = path.join(OUT_DIR, 'relay-fee-snapshots.jsonl');
const CURSOR_FILE = path.join(OUT_DIR, '.relay-fee-snapshot-cursor.json');

async function fetchLogs(resource, { startTime } = {}) {
  // Paging backward means each further page is a strictly OLDER window, so it needs both ends bounded:
  // nextStartTime as the new startTime AND nextEndTime as the new endTime. Passing startTime alone leaves
  // endTime defaulted to now, so "the next page" silently re-fetches the same latest `limit` lines forever
  // — which is indistinguishable from real pagination until the counts come out implausible.
  const out = [];
  let st = startTime, et;
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({ ownerId: OWNER, resource, limit: '1000', direction: 'backward' });
    if (st) params.set('startTime', st);
    if (et) params.set('endTime', et);
    let j;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(`https://api.render.com/v1/logs?${params}`, { headers: { Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(45000) });
        if (!r.ok) throw new Error(`${resource}: HTTP ${r.status}`);
        j = await r.json();
        break;
      } catch (e) {
        if (attempt >= 2) throw e;
        await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
      }
    }
    if (!j.logs?.length) break;
    out.push(...j.logs);
    if (!j.hasMore || !j.nextStartTime) break;
    st = j.nextStartTime;
    et = j.nextEndTime;
  }
  // Backward pages can abut with one line shared at the boundary; de-dupe by id before counting anything.
  const seen = new Set();
  return out.filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function classify(logs) {
  const byType = {}; // type -> { paid, unpaid }
  let lastType = null;
  const warnings = [], criticals = [];
  for (const l of logs) {
    const m = l.message;
    const u = /UNPAID: job type=(\w+)/.exec(m);
    if (u) { lastType = u[1]; continue; }
    const s = /settled: job=0x[0-9a-f]+ tx=0x[0-9a-f]+/.exec(m);
    if (s) {
      const t = lastType || 'priced';
      byType[t] ??= { paid: 0, unpaid: 0 };
      byType[t][lastType ? 'unpaid' : 'paid']++;
      lastType = null;
      continue;
    }
    if (/^WARNING:/.test(m) || /\] WARNING:/.test(m)) warnings.push(m);
    if (/^CRITICAL:/.test(m) || /\] CRITICAL:/.test(m)) criticals.push(m);
  }
  return { byType, warnings, criticals };
}

function extractLatest(logs, re) {
  for (let i = logs.length - 1; i >= 0; i--) { const m = re.exec(logs[i].message); if (m) return m[1]; }
  return null;
}

const cursor = existsSync(CURSOR_FILE) ? JSON.parse(readFileSync(CURSOR_FILE, 'utf8')) : {};

const settleLogs = await fetchLogs(SETTLE_SVC, { startTime: cursor.settleSince });
const monitorLogs = await fetchLogs(MONITOR_SVC, { startTime: cursor.monitorSince });

// Op-type classification comes from the settle service's own logs; WARNING/CRITICAL lines are the
// monitor's, a different service, so they must be read from monitorLogs — reading them from settleLogs
// silently reports zero of both regardless of what the monitor actually saw.
const { byType } = classify(settleLogs);
const { warnings, criticals } = classify(monitorLogs);
const proveCredit = extractLatest(settleLogs, /prover credit ([\d.]+) PROVE/);
const settleEth = extractLatest(monitorLogs, /\(settle\) holds ([\d.]+) ETH/) ?? extractLatest(monitorLogs, /\(settle\) = ([\d.]+)/);
const relayEth = extractLatest(monitorLogs, /\(relay\) holds ([\d.]+) ETH/);

const totalPaid = Object.values(byType).reduce((a, v) => a + v.paid, 0);
const totalUnpaid = Object.values(byType).reduce((a, v) => a + v.unpaid, 0);
const entry = {
  at: new Date().toISOString(),
  windowFrom: settleLogs[0]?.timestamp ?? null,
  windowTo: settleLogs[settleLogs.length - 1]?.timestamp ?? null,
  settledByType: byType,
  totals: { paid: totalPaid, unpaid: totalUnpaid, subsidyRate: totalPaid + totalUnpaid ? +(totalUnpaid / (totalPaid + totalUnpaid)).toFixed(3) : null },
  proveCreditPROVE: proveCredit ? Number(proveCredit) : null,
  settleWalletEth: settleEth ? Number(settleEth) : null,
  relayWalletEth: relayEth ? Number(relayEth) : null,
  warningCount: warnings.length,
  criticalCount: criticals.length,
  criticals: criticals.slice(0, 5),
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(entry) + '\n', { flag: 'a' });
writeFileSync(CURSOR_FILE, JSON.stringify({
  settleSince: settleLogs[settleLogs.length - 1]?.timestamp ?? cursor.settleSince,
  monitorSince: monitorLogs[monitorLogs.length - 1]?.timestamp ?? cursor.monitorSince,
}));

console.log(`appended to ${OUT_FILE}`);
console.log(JSON.stringify(entry, null, 2));
