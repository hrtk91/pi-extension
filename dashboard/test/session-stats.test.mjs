import assert from "node:assert/strict";
import { calculateSessionStats, groupStatsByModel } from "../src/session-stats.mjs";

const assistant = (output, durationMs) => ({
  type: "message",
  message: { role: "assistant", usage: { output }, ...(durationMs === undefined ? {} : { durationMs }) },
});

{
  const stats = calculateSessionStats([
    assistant(100, 1000),
    { type: "message", message: { role: "user" } },
    assistant(200, 4000),
    { type: "toolResult", message: { role: "toolResult" } },
    assistant(30, 500),
    assistant(50), // Legacy response without durationMs contributes to tokens, not throughput.
    assistant(0, 100),
  ]);

  assert.equal(stats.assistantResponses, 5);
  assert.equal(stats.measuredResponses, 3);
  assert.equal(stats.outputTokens, 380);
  assert.equal(stats.measuredOutputTokens, 330);
  assert.equal(stats.totalDurationMs, 5500);
  assert.equal(stats.averageDurationMs, 5500 / 3);
  assert.equal(stats.p50, 60);
  assert.equal(stats.p90, 100);
}

{
  const stats = calculateSessionStats([assistant(20), { type: "other" }]);
  assert.equal(stats.assistantResponses, 1);
  assert.equal(stats.measuredResponses, 0);
  assert.equal(stats.outputTokens, 20);
  assert.equal(stats.p50, null);
  assert.equal(stats.p90, null);
  assert.equal(stats.averageDurationMs, null);
}

assert.equal(calculateSessionStats(null).assistantResponses, 0);

{
  const grouped = groupStatsByModel([
    { sessionId: "one", provider: "provider-a", model: "model/one", outputTokens: 100, durationMs: 1000 },
    { sessionId: "two", provider: "provider-a", model: "model/one", outputTokens: 200, durationMs: 4000 },
    { sessionId: "two", provider: "provider-b", model: "model-two", outputTokens: 50, durationMs: 1000 },
  ]);
  assert.equal(grouped.all.responses, 3);
  assert.equal(grouped.all.outputTokens, 350);
  assert.equal(grouped.all.sessions, 2);
  assert.equal(grouped.models.find((item) => item.key === "provider-a/model/one").stats.p50, 50);
  assert.equal(grouped.models.find((item) => item.key === "provider-b/model-two").stats.combinedTokPerSec, 50);
}

console.log("PASS: session and provider/model statistics count timed assistant responses");
