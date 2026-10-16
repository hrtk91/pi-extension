// Turn-based rolling compaction planner. Percentages refer to completed user-message spans.
export function shouldStartBackgroundCompaction(contextTokens, maxContextTokens, startAtPercent = 50) {
  if (!Number.isFinite(contextTokens) || !Number.isFinite(maxContextTokens) || maxContextTokens <= 0 || startAtPercent < 0 || startAtPercent > 100) {
    throw new TypeError("invalid context size or trigger percentage");
  }
  return contextTokens >= maxContextTokens * startAtPercent / 100;
}

export function planCompaction(totalTurns, summarizedThrough = 0, { keepRecentPercent = 20, maxCompactTurns = 80 } = {}) {
  if (!Number.isSafeInteger(totalTurns) || !Number.isSafeInteger(summarizedThrough) || totalTurns < 0 || summarizedThrough < 0) {
    throw new TypeError("turn counts must be non-negative safe integers");
  }
  if (!Number.isFinite(keepRecentPercent) || keepRecentPercent < 0 || keepRecentPercent >= 100 || !Number.isSafeInteger(maxCompactTurns) || maxCompactTurns <= 0) {
    throw new TypeError("keepRecentPercent must be in [0, 100), maxCompactTurns must be positive");
  }
  const targetThrough = Math.floor(totalTurns * (1 - keepRecentPercent / 100));
  if (targetThrough <= summarizedThrough) return null;
  const fromTurn = summarizedThrough + 1;
  const throughTurn = Math.min(targetThrough, summarizedThrough + maxCompactTurns);
  return {
    fromTurn,
    throughTurn,
    compactTurns: throughTurn - fromTurn + 1,
    keepFromTurn: throughTurn + 1,
    keepRecentPercent,
    targetThrough,
    summarizedThrough: throughTurn,
  };
}

export function simulateRollingCompaction(totalTurns, options) {
  const plans = [];
  let summarizedThrough = 0;
  while (true) {
    const plan = planCompaction(totalTurns, summarizedThrough, options);
    if (!plan) break;
    plans.push(plan);
    summarizedThrough = plan.summarizedThrough;
  }
  return { plans, summarizedThrough, retainedTurns: totalTurns - summarizedThrough };
}
