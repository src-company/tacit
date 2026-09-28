#!/usr/bin/env node
// worker/src/index.js's buildProbeBurnTxHex — the synthetic, unsigned single-input tx
// handleBurnDepositCheck's note-probe mode feeds to admitBurnDeposit (via extractInputs) to ask "would this
// note's provenance admit" before any real burn tx exists. Tested against the real extractInputs (not a
// mock) so the display-vs-internal txid byte order is checked against the actual parser, not restated.
//   node tests/burndep-check-probe-tx.mjs
import { buildProbeBurnTxHex } from '../worker/src/index.js';
import { extractInputs } from '../dapp/burn-deposit-bitcoin.js';

let failures = 0;
const ok = (c, m) => { if (c) console.log(`ok   ${m}`); else { console.error(`FAIL ${m}`); failures++; } };

const revHex = (h) => h.replace(/^0x/, '').match(/../g).reverse().join('');

// A realistic-looking (but arbitrary) display-order txid + vout.
const DISPLAY_TXID = 'a1b2c3d4e5f60718293a4b5c6d7e8f9001121314151617181920212223242526';
const VOUT = 3;

const hex = buildProbeBurnTxHex('0x' + DISPLAY_TXID, VOUT);
ok(typeof hex === 'string' && hex.startsWith('0x'), 'returns 0x-prefixed hex');

const ins = extractInputs(hex);
ok(Array.isArray(ins) && ins.length === 1, 'extractInputs sees exactly one input');
ok(ins[0].prevVout === VOUT, `vout round-trips (got ${ins[0] && ins[0].prevVout})`);
// extractInputs reads the wire-format (internal-order) txid bytes as-is and hex-encodes them — so it must
// equal the REVERSE of the display txid, not the display txid itself.
const expectedInternal = '0x' + revHex(DISPLAY_TXID);
ok(ins[0].prevTxid.toLowerCase() === expectedInternal.toLowerCase(), `prevTxid is internal-order (got ${ins[0] && ins[0].prevTxid}, want ${expectedInternal})`);

// A bare (no 0x) display txid must behave identically (handleBurnDepositCheck normalizes before calling this).
const hex2 = buildProbeBurnTxHex(DISPLAY_TXID, VOUT);
ok(hex2 === hex, 'bare-hex and 0x-prefixed display txid inputs produce byte-identical output');

// Different vouts produce different (and correctly round-tripping) bytes — catches a vout hardcoded to 0.
const hexV7 = buildProbeBurnTxHex(DISPLAY_TXID, 7);
ok(hexV7 !== hex, 'a different vout changes the tx bytes');
ok(extractInputs(hexV7)[0].prevVout === 7, 'the different vout round-trips correctly too');

console.log(failures ? `\n${failures} FAILURES` : '\nall burndep-check probe-tx checks passed');
process.exit(failures ? 1 : 0);
