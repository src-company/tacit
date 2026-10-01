// The program's terms as the service states them (src/lib/points-program.js): dates, pot, ceiling, rates, early bonus
// and holder tiers, with what is switched off left out.
//   node worker-relay/tests/points-program.test.mjs

import assert from 'node:assert/strict';
import { programTerms } from '../src/lib/points-program.js';
import { parseBoostTiers } from '../src/lib/tac-holder-boost.js';
import { parseRateCapSchedule } from '../src/lib/points-rate-cap.js';
import { parseCategoryWeights, parseEngagementSchedule } from '../src/lib/points-engagement.js';

const TAC = 10n ** 18n;
const cfg = {
  pointsProgramStartSec: 20719 * 86400 + 5, pointsProgramDays: 90, pointsProgramTotalWei: 100_000n * TAC, pointsSettleGraceSecs: 1800,
  pointsBasePerEth: 1000, tethWrapBoostMultiplier: 1.25, pointsBasePerZswapEth: 1000, pointsBasePerCbtc: 1000, pointsBasePerCusd: 1, cusdMintBonusMultiplier: 2,
  pointsBasePerPmBet: 1000, pointsPerPmCreate: 50, pointsBasePerEvmPoolEth: 1000, evmPoolPointsStartBlocks: { 1: '24000000', 8453: '', 4663: '' },
  weinameEnabled: true, pointsBasePerWeiname: 1000, btcPoolPointsStartHeight: '', pointsBasePerBtcPoolTac: 1,
  pointsBonusScale: 4, pointsBonusHalfLife: 200, tacBoostWindowBlocks: 7200, pointsBondHoldFromDay: 0, pointsCbtcHoldRate: 0, pointsCbtcHoldFromDay: 0,
};
const budget = (i) => (cfg.pointsProgramTotalWei * BigInt(i + 1)) / 90n - (cfg.pointsProgramTotalWei * BigInt(i)) / 90n;
const schedule = parseRateCapSchedule('20729:0.03');
const tiers = parseBoostTiers('100:1.25,1000:1.5,10000:2');

{
  const t = programTerms({ cfg, dayBudgetWei: budget, rateCapSchedule: schedule, tiers });
  assert.equal(t.startDay, 20719);
  assert.equal(t.lastDay, 20719 + 89, 'ninety days, the last one inclusive');
  assert.equal(t.days, 90);
  assert.equal(t.totalWei, (100_000n * TAC).toString());
  assert.equal(t.dayBudgetWei, budget(0).toString());
  assert.deepEqual(t.rateCap, [{ fromDay: 20729, maxWeiPerPoint: (3n * 10n ** 16n).toString() }]);
  assert.deepEqual(t.earlyBonus, { max: 5, halfLife: 200 });
  assert.deepEqual(t.holder, { tiers: [{ tac: 100, multiplier: 1.25 }, { tac: 1000, multiplier: 1.5 }, { tac: 10000, multiplier: 2 }], windowHours: 24 });
  assert.equal(t.rates.wrap, 1250, 'a wrap into the Tacit pool carries its boost');
  assert.equal(t.rates.cusdmint, 2);
  assert.equal(t.rates.evmpooldeposit, 1000);
  assert.equal(t.rates.weiname, 1000);
  assert.equal(t.settleGraceSecs, 1800);
  JSON.stringify(t);
  console.log('ok - the terms state the dates, the pot, the ceiling, the rates, the early bonus and the holder tiers');
}

{
  const t = programTerms({ cfg: { ...cfg, evmPoolPointsStartBlocks: { 1: '', 8453: '', 4663: '' }, weinameEnabled: false, btcPoolPointsStartHeight: '948000' }, dayBudgetWei: budget, rateCapSchedule: [], tiers: [] });
  assert.equal('evmpooldeposit' in t.rates, false, 'a pool no chain scores is not offered');
  assert.equal('weiname' in t.rates, false);
  assert.equal(t.rates.btcpool, 1, 'a Bitcoin-pool shield is offered once it is scored');
  assert.equal(t.holder, null, 'no tiers, no holder boost');
  assert.deepEqual(t.rateCap, []);
  console.log('ok - what is switched off is left out');
}

{
  const t = programTerms({ cfg: { ...cfg, tethWrapBoostMultiplier: 1.2, cusdMintBonusMultiplier: 1.1, pointsBonusScale: 2.5 }, dayBudgetWei: budget, rateCapSchedule: parseRateCapSchedule('20729:0.03,20790:off'), tiers });
  assert.equal(t.rates.wrap, 1200, 'a product that is not exact in binary reads as the figure it is');
  assert.equal(t.rates.cusdmint, 1.1);
  assert.equal(t.earlyBonus.max, 3.5);
  assert.deepEqual(t.rateCap.map((e) => e.maxWeiPerPoint === null), [false, true], 'a ceiling that is lifted is null');
  console.log('ok - figures are rounded to what they are and a lifted ceiling is null');
}

{
  const t = programTerms({ cfg: { ...cfg, pointsBondHoldFromDay: 20730 }, dayBudgetWei: budget, rateCapSchedule: schedule, tiers,
    weights: parseCategoryWeights('20730:cbtcmint=3,cusdmint=2;20760:off'), engagement: parseEngagementSchedule('20730:0.25,0.25,2,25;20760:off') });
  assert.deepEqual(t.weights, [{ fromDay: 20730, weights: { cbtcmint: 3, cusdmint: 2 } }, { fromDay: 20760, weights: {} }]);
  assert.deepEqual(t.engagement, [{ fromDay: 20730, kindStep: 0.25, returnStep: 0.25, maxKinds: 2, minPoints: 25 }, { fromDay: 20760, off: true }]);
  assert.equal(t.bondHoldFromDay, 20730);
  assert.equal(t.kinds.cbtcmint, 'borrow');
  const none = programTerms({ cfg, dayBudgetWei: budget });
  assert.deepEqual([none.weights, none.engagement, none.bondHoldFromDay], [[], [], null], 'none configured states none');
  JSON.stringify(t);
  console.log('ok - the terms state the weights, the week multiplier and the bond hold, and none when none is set');
}

{
  const t = programTerms({ cfg: { ...cfg, pointsCbtcHoldRate: 500, pointsCbtcHoldFromDay: 20730 }, dayBudgetWei: budget });
  assert.equal(t.rates.cbtchold, 500);
  assert.equal(t.cbtcHoldFromDay, 20730);
  const off = programTerms({ cfg: { ...cfg, pointsCbtcHoldRate: 0, pointsCbtcHoldFromDay: 20730 }, dayBudgetWei: budget });
  assert.equal('cbtchold' in off.rates, false, 'a rate of 0 offers nothing');
  assert.equal(off.cbtcHoldFromDay, null);
  console.log('ok - the terms state the daily credit for a bond that stays posted, and none when it is off');
}
