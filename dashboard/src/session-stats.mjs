function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

/** Summarize completed assistant responses from the currently selected session branch. */
export function summarizeSamples(samples) {
  const valid = (samples ?? []).filter((sample) =>
    Number.isFinite(sample?.outputTokens) && sample.outputTokens > 0 &&
    Number.isFinite(sample?.durationMs) && sample.durationMs > 0,
  );
  const rates = valid.map((sample) => sample.outputTokens / (sample.durationMs / 1000)).sort((a, b) => a - b);
  const totalOutputTokens = valid.reduce((sum, sample) => sum + sample.outputTokens, 0);
  const totalDurationMs = valid.reduce((sum, sample) => sum + sample.durationMs, 0);
  return {
    responses: valid.length,
    outputTokens: totalOutputTokens,
    totalDurationMs,
    averageDurationMs: valid.length > 0 ? totalDurationMs / valid.length : null,
    combinedTokPerSec: totalDurationMs > 0 ? totalOutputTokens / (totalDurationMs / 1000) : null,
    p50: percentile(rates, 0.5),
    p90: percentile(rates, 0.9),
    sessions: new Set(valid.map((sample) => sample.sessionId).filter(Boolean)).size,
  };
}

export function groupStatsByModel(samples) {
  const grouped = new Map();
  for (const sample of samples ?? []) {
    const provider = typeof sample?.provider === "string" ? sample.provider : "unknown";
    const model = typeof sample?.model === "string" ? sample.model : "unknown";
    const key = `${provider}/${model}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(sample);
  }
  const models = [...grouped].map(([key, modelSamples]) => ({
    key,
    provider: key.slice(0, key.indexOf("/")),
    model: key.slice(key.indexOf("/") + 1),
    stats: summarizeSamples(modelSamples),
  })).sort((a, b) => a.key.localeCompare(b.key));
  return { all: summarizeSamples(samples), models };
}

export function calculateSessionStats(branchEntries) {
  let assistantResponses = 0;
  let outputTokens = 0;
  let measuredOutputTokens = 0;
  let totalDurationMs = 0;
  const rates = [];

  for (const entry of branchEntries ?? []) {
    const message = entry?.type === "message" ? entry.message : null;
    if (message?.role !== "assistant") continue;

    assistantResponses++;
    const output = Number.isFinite(message.usage?.output) && message.usage.output > 0
      ? message.usage.output
      : 0;
    outputTokens += output;

    const durationMs = message.durationMs;
    if (!Number.isFinite(durationMs) || durationMs <= 0 || output <= 0) continue;

    measuredOutputTokens += output;
    totalDurationMs += durationMs;
    rates.push(output / (durationMs / 1000));
  }

  rates.sort((a, b) => a - b);
  return {
    assistantResponses,
    measuredResponses: rates.length,
    outputTokens,
    measuredOutputTokens,
    totalDurationMs,
    averageDurationMs: rates.length > 0 ? totalDurationMs / rates.length : null,
    p50: percentile(rates, 0.5),
    p90: percentile(rates, 0.9),
  };
}
