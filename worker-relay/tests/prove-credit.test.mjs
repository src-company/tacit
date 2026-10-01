// The prover credit the relay reports and the monitor judges (src/lib/prove-credit.js).
//   node worker-relay/tests/prove-credit.test.mjs
import assert from 'node:assert/strict';
import { creditText, creditField, creditLevel } from '../src/lib/prove-credit.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok - ${name}`); };

test('PROVE wei reads as whole PROVE with two decimals; an unknown credit stays unknown', () => {
  assert.equal(creditText(78_243_193_567_845_357_685n), '78.24');
  assert.equal(creditText(100n * 10n ** 18n), '100.00');
  assert.equal(creditText(0n), '0.00');
  assert.equal(creditText(null), null);
});

test('the API keeps only a plain decimal credit', () => {
  for (const ok of ['0', '78.24', '100', '213.7612']) assert.equal(creditField(ok), ok);
  for (const bad of [78.24, '-1', '1e3', '78.', '.5', '1,000', '78.24 PROVE', '1'.repeat(13), '', null, undefined, {}]) assert.equal(creditField(bad), null, String(bad));
});

test('under the floor is a warning, under 60% of it critical, and anything else is quiet', () => {
  assert.equal(creditLevel('100', 100), null);
  assert.equal(creditLevel('250.5', 100), null);
  assert.equal(creditLevel('99.99', 100), 'warning');
  assert.equal(creditLevel('78.24', 100), 'warning');
  assert.equal(creditLevel('60', 100), 'warning');
  assert.equal(creditLevel('59.99', 100), 'critical');
  assert.equal(creditLevel('0', 100), 'critical');
});

test('a credit or floor that does not read gives no verdict, so a broken read never pages', () => {
  assert.equal(creditLevel('abc', 100), null);
  assert.equal(creditLevel(undefined, 100), null);
  assert.equal(creditLevel('50', 0), null);
  assert.equal(creditLevel('50', NaN), null);
});

console.log(`\n${n} passed`);
