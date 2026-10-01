// The program's own terms as the service holds them, so a client shows them instead of restating them: the dates, the
// day's pot, the per-point ceiling, what each kind of activity earns, the early bonus and the holder tiers. Plain JSON;
// wei are decimal strings. A kind of activity the service is not scoring is left out of `rates`, and `holder` is null
// when the boost is off.
//
// cfg: the service's config. dayBudgetWei(i): the budget of the i-th day of the program. rateCapSchedule: the parsed
// ceiling entries. tiers: parseBoostTiers' output for the TAC holder boost, or [].

const BLOCK_SECS = 12;
const round6 = (x) => Math.round(x * 1e6) / 1e6;

export function programTerms({ cfg, dayBudgetWei, rateCapSchedule = [], tiers = [] }) {
  const startDay = Math.floor(cfg.pointsProgramStartSec / 86400);
  const rates = {
    wrap: round6(cfg.pointsBasePerEth * cfg.tethWrapBoostMultiplier),
    zswapeth: cfg.pointsBasePerZswapEth,
    cbtcmint: cfg.pointsBasePerCbtc,
    cusdmint: round6(cfg.pointsBasePerCusd * cfg.cusdMintBonusMultiplier),
    pmbet: cfg.pointsBasePerPmBet,
    pmcreate: cfg.pointsPerPmCreate,
  };
  if (Object.values(cfg.evmPoolPointsStartBlocks || {}).some(Boolean)) rates.evmpooldeposit = cfg.pointsBasePerEvmPoolEth;
  if (cfg.weinameEnabled) rates.weiname = cfg.pointsBasePerWeiname;
  if (cfg.btcPoolPointsStartHeight) rates.btcpool = cfg.pointsBasePerBtcPoolTac;
  return {
    startDay,
    days: cfg.pointsProgramDays,
    lastDay: startDay + cfg.pointsProgramDays - 1,
    totalWei: cfg.pointsProgramTotalWei.toString(),
    dayBudgetWei: dayBudgetWei(0).toString(),
    rateCap: rateCapSchedule.map((e) => ({ fromDay: e.fromDay, maxWeiPerPoint: e.maxWeiPerPoint === null ? null : e.maxWeiPerPoint.toString() })),
    settleGraceSecs: cfg.pointsSettleGraceSecs,
    earlyBonus: { max: round6(1 + cfg.pointsBonusScale), halfLife: cfg.pointsBonusHalfLife },
    tethWrapBoost: cfg.tethWrapBoostMultiplier,
    holder: tiers.length
      ? { tiers: tiers.map((t) => ({ tac: Number(t.minWei / 10n ** 18n), multiplier: t.multiplier })), windowHours: round6(cfg.tacBoostWindowBlocks * BLOCK_SECS / 3600) }
      : null,
    rates,
  };
}
