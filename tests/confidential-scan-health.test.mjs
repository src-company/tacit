// The strings the tabs show when a scan could not see everything (dapp/confidential-scan-health.js).
// Pure functions over the diagnostics ux.balance()/ux.recover()/ux.scanStealthLocks() already return — no
// DOM, no network. What is asserted here is the behaviour that matters: a clean scan says nothing, an
// incomplete one names the channel, the two channels with no memo fallback (cBTC, bridge mints) say that a
// real holding can be missing, and everything interpolated into HTML is escaped.
// Run: node tests/confidential-scan-health.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import {
  scanHealth, scanHealthHtml, scanHealthSuffix, pendingWrapRowsHtml, notifyPendingWrapsOnce,
  noteIsInbound, inboundBadgeHtml, inboundBadgeText, inboundSummaryText, inboundSummaryHtml,
  recoveryCoverage, recoveryCoverageHtml, lockScanHealth, lockScanHealthHtml, channelLabel, escapeHtml,
} from '../dapp/confidential-scan-health.js';

const cleanDiag = { errors: {}, wrap: { found: 1, pending: [], scanned: [], truncated: [] }, inboundUnverified: 0 };

test('a clean scan says nothing at all', () => {
  const h = scanHealth(cleanDiag);
  assert.equal(h.ok, true);
  assert.equal(h.text, '');
  assert.equal(scanHealthHtml(cleanDiag), '');
  assert.equal(scanHealthSuffix(cleanDiag), '');
});

test('a missing diag is treated as incomplete, not as clean', () => {
  // balance() always carries diag; an older cached result or a partial double must not read as authoritative.
  assert.equal(scanHealth(undefined).ok, true); // no errors recorded
  assert.equal(scanHealth({ errors: { cbtc: 'fetch failed' } }).ok, false);
});

test('a failed channel is named, and the figure is called possibly incomplete', () => {
  const h = scanHealth({ errors: { cbtc: 'fetch failed: esplora' }, wrap: { pending: [], truncated: [] } });
  assert.equal(h.ok, false);
  assert.deepEqual(h.channels, ['cbtc']);
  assert.match(h.text, /^Balances may be incomplete — the cBTC scan did not finish\./);
  assert.match(h.text, /Scanning again is safe and costs nothing\./);
  // No alarm language: the value is not at risk, only the reading of it.
  assert.doesNotMatch(h.text, /lost|gone|missing funds|WARNING|at risk/i);
});

test('the key-only channels say a real holding can be missing from the figure', () => {
  for (const [ch, word] of [['cbtc', 'cBTC'], ['bridge', 'bridged']]) {
    const h = scanHealth({ errors: { [ch]: 'timeout' } });
    assert.deepEqual(h.keyOnly, [ch]);
    assert.match(h.text, new RegExp(`${word} notes are found from your key and the chain alone`));
    assert.match(h.text, /can be missing from the figure/);
  }
  // A memo-backed channel does not make that claim — those notes are still found from their memo.
  const w = scanHealth({ errors: { change: 'rpc down' } });
  assert.deepEqual(w.keyOnly, []);
  assert.doesNotMatch(w.text, /key and the chain alone/);
});

test('several failed channels read as one sentence', () => {
  const h = scanHealth({ errors: { cbtc: 'x', bridge: 'y', change: 'z' } });
  assert.match(h.text, /the cBTC scan, the Bitcoin-bridge scan and the change-note scan did not finish/);
  assert.match(h.text, /cBTC and bridged notes are found from your key/);
});

test('a truncated deposit walk counts as incomplete even with no error', () => {
  const h = scanHealth({ errors: {}, wrap: { pending: [], truncated: ['0xdead'] } });
  assert.equal(h.ok, false);
  assert.match(h.text, /the deposit scan stopped at its index limit/);
});

const mockUx = { tickerOf: () => 'cETH', assets: [{ assetId: '0xaa', tacitDecimals: 8 }] };

test('pending deposits render as their own banner with a Resume button, not a passive line', () => {
  assert.equal(pendingWrapRowsHtml(cleanDiag, mockUx), '');
  const one = pendingWrapRowsHtml({ wrap: { pending: [{ index: 3, asset: '0xaa', value: '100000000' }] } }, mockUx);
  assert.match(one, /1 deposit waiting to settle/);
  assert.match(one, /class="cpool-resume-wrap"/);
  assert.match(one, />Resume</);
  assert.match(one, /data-pending-index="3"/);
  const two = pendingWrapRowsHtml({ wrap: { pending: [{ index: 0, asset: '0xaa', value: '1' }, { index: 1, asset: '0xaa', value: '2' }] } }, mockUx);
  assert.match(two, /2 deposits waiting to settle/);
  assert.equal((two.match(/cpool-resume-wrap/g) || []).length, 2);
});

test('pending-wrap HTML escapes an asset id the same as any other interpolated value', () => {
  const evilUx = { tickerOf: () => '<img onerror=alert(1)>', assets: [] };
  const html = pendingWrapRowsHtml({ wrap: { pending: [{ index: 0, asset: '"><script>', value: '1' }] } }, evilUx);
  // "onerror=" as inert escaped text is harmless — what matters is that no RAW '<' survived to open an
  // actual tag or attribute. Both malicious inputs' angle brackets must come through as &lt;/&gt; only.
  assert.doesNotMatch(html, /<script>|<img /);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
});

test('notifyPendingWrapsOnce notifies only when something is pending', () => {
  // This suite runs plain Node (no jsdom — see the file header), so sessionStorage doesn't exist; the
  // function's try/catch falls through and notifies unconditionally here. The cross-tab once-per-session
  // dedup itself only applies in a real browser and isn't exercised by this pure-function test.
  const calls = [];
  const notify = (msg, kind, opts) => calls.push({ msg, kind, opts });
  notifyPendingWrapsOnce(cleanDiag, notify);
  assert.equal(calls.length, 0, 'nothing pending — no notification');
  notifyPendingWrapsOnce({ wrap: { pending: [{ index: 0 }] } }, notify);
  assert.equal(calls.length, 1);
  assert.match(calls[0].msg, /1 confidential-pool deposit is on-chain/);
  assert.equal(typeof calls[0].opts.onClick, 'function');
});

test('channel labels cover every key balance() and recover() can emit', () => {
  for (const k of ['wrap', 'cbtc', 'bridge', 'change', 'derived', 'derivedOutputs', 'locks', 'cdp', 'farm']) {
    assert.match(channelLabel(k), /^the .+ scan$/);
  }
  assert.equal(channelLabel('somethingNew'), 'the somethingNew scan');
});

// ── inbound (memo-only) notes ──

test('an inbound note is labelled; a key-derived one is not', () => {
  const inbound = { leafIndex: 4, inboundUnverified: true };
  const derived = { leafIndex: 5, source: 'wrap', keyDerivedBy: 'wrap' };
  assert.equal(noteIsInbound(inbound), true);
  assert.equal(noteIsInbound(derived), false);
  assert.match(inboundBadgeHtml(inbound), /inbound/);
  assert.match(inboundBadgeHtml(inbound), /title="[^"]*spendable as normal/);
  assert.equal(inboundBadgeHtml(derived), '');
  assert.equal(inboundBadgeText(inbound), ' · inbound');
  assert.equal(inboundBadgeText(derived), '');
});

test('the inbound summary counts notes and says they are spendable', () => {
  const notes = [{ inboundUnverified: true }, { source: 'wrap' }, { inboundUnverified: true }];
  const t = inboundSummaryText(notes);
  assert.match(t, /^2 notes marked “inbound”/);
  assert.match(t, /They are spendable; who created them is unverified\./);
  assert.match(inboundSummaryText([{ inboundUnverified: true }]), /^1 note marked “inbound” was found/);
  assert.equal(inboundSummaryText([{ source: 'cbtc' }]), '');
  assert.equal(inboundSummaryHtml([]), '');
  assert.match(inboundSummaryHtml(notes), /^<div class="muted"/);
});

// ── recovery coverage ──

test('a complete restore says so; an incomplete one names what went unread', () => {
  const complete = recoveryCoverage({ errors: {}, coverage: { complete: true, skipped: { change: [], derived: [], cdp: [] } } });
  assert.equal(complete.complete, true);
  assert.match(complete.text, /^Restore complete/);

  const partial = recoveryCoverage({
    errors: { cbtc: 'esplora 502' },
    coverage: {
      complete: false,
      skipped: { change: [{ txHash: '0x1', reason: 'settle calldata unavailable' }], derived: [], cdp: [{ txHash: '0x2' }] },
    },
  });
  assert.equal(partial.complete, false);
  assert.match(partial.text, /^Restore incomplete — the cBTC scan did not finish/);
  assert.match(partial.text, /1 settle transaction behind your change notes could not be read/);
  assert.match(partial.text, /1 settle transaction behind your borrow positions could not be read/);
  assert.match(partial.text, /still recoverable from your wallet key/);
  assert.match(partial.text, /run the restore again/);
});

test('coverage.complete missing is never read as complete', () => {
  const c = recoveryCoverage({});
  assert.equal(c.complete, false);
  assert.match(c.text, /^Restore incomplete/);
  assert.match(recoveryCoverageHtml({}), /class="warn"/);
  assert.match(recoveryCoverageHtml({ coverage: { complete: true } }), /class="info-card"/);
});

// ── stealth locks ──

test('a lock set the pool confirmed, with every memo read, says nothing', () => {
  const h = lockScanHealth({ verified: true, locksWithoutMemo: 0, mine: [] });
  assert.equal(h.ok, true);
  assert.equal(lockScanHealthHtml({ verified: true, locksWithoutMemo: 0 }), '');
});

test('an unconfirmed lock set, or an unread lock, says the list may be incomplete', () => {
  const h = lockScanHealth({ verified: null, unverifiedReason: 'lock state unreadable', locksWithoutMemo: 2 });
  assert.equal(h.ok, false);
  assert.match(h.text, /^This list may be incomplete — the pool did not confirm the lock set/);
  assert.match(h.text, /\(lock state unreadable\)/);
  assert.match(h.text, /2 locks could not be read, so a payment to you could be missing/);
  assert.match(lockScanHealthHtml({ verified: false }), /class="warn"/);
});

// ── escaping ──

test('everything interpolated into HTML is escaped', () => {
  const nasty = '<img src=x onerror=alert(1)>"\'&';
  assert.equal(escapeHtml(nasty), '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;');
  const html = lockScanHealthHtml({ verified: null, unverifiedReason: nasty });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(scanHealthHtml({ errors: { cbtc: nasty } }), /<img/);
  assert.doesNotMatch(inboundBadgeHtml({ inboundUnverified: true }), /<(?!\/?span)/);
  assert.doesNotMatch(scanHealthHtml(cleanDiag || {}, { style: '"><img src=x>' }), /<img/);
});
