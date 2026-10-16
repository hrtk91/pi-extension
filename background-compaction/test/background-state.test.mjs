import assert from "node:assert/strict";
import { BackgroundCompactionState } from "../src/background-state.mjs";

const turns = (count) => Array.from({ length: count }, (_, i) => ({ id: `t${i + 1}`, firstEntryId: `e${i + 1}`, content: `fact-${i + 1}` }));
const base = (overrides = {}) => ({
  sessionId: "s1", branchId: "b1", contextTokens: 500, contextWindow: 1000,
  turns: turns(100), summarizedThrough: 0, previousSummary: "earlier facts", ...overrides,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

// 50% starts exactly once; observe is non-blocking; new input during summary is not in frozen prefix.
{
  const state = new BackgroundCompactionState();
  const gate = deferred();
  const started = state.observe(base(), (snapshot) => gate.promise);
  assert.equal(started.started, true);
  assert.equal(started.plan.fromTurn, 1);
  assert.equal(started.plan.throughTurn, 80);
  assert.equal(started.snapshot.turnsToSummarize.length, 80);
  assert.equal(state.status, "summarizing");
  assert.equal(state.observe(base({ turns: turns(120) }), async () => "wrong" ).reason, "already-active");
  let draft = state.applyAtBoundary({ sessionId: "s1", branchId: "b1" });
  assert.equal(draft, null, "must not apply while summary is pending");
  gate.resolve("summary of first 80");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.status, "ready");
  draft = state.applyAtBoundary({ sessionId: "s1", branchId: "b1" });
  assert.equal(draft.firstKeptEntryId, "e81");
  assert.equal(draft.summary, "summary of first 80");
  assert.equal(state.lastResult.status, "applied");
  assert.equal(state.applyAtBoundary({ sessionId: "s1", branchId: "b1" }), null, "apply is one-shot");
}

// Strict threshold, selected percentage, and maximum summary batch.
{
  const state = new BackgroundCompactionState();
  assert.equal(state.observe(base({ contextTokens: 499 }), async () => "x").reason, "below-threshold");
  const result = state.observe(base({ turns: turns(260), contextTokens: 900 }), async () => "summary", { keepRecentPercent: 20, maxCompactTurns: 80 });
  assert.equal(result.started, true);
  assert.equal(result.plan.throughTurn, 80);
  assert.equal(result.snapshot.firstKeptEntryId, "e81");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(state.applyAtBoundary({ sessionId: "s1", branchId: "b1" }));
}

// Rolling percentage applies to lifetime turns after a prior summary: 80 already summarized + 100 live -> summarize 64, keep 36.
{
  const state = new BackgroundCompactionState();
  const result = state.observe(base({ turns: turns(100), summarizedThrough: 80, contextTokens: 700 }), async (snapshot) => `through ${snapshot.throughTurn}`);
  assert.equal(result.started, true);
  assert.equal(result.plan.fromTurn, 81);
  assert.equal(result.plan.throughTurn, 144);
  assert.equal(result.snapshot.turnsToSummarize.length, 64);
  assert.equal(result.snapshot.firstKeptEntryId, "e65");
  await new Promise((resolve) => setImmediate(resolve));
  const draft = state.applyAtBoundary({ sessionId: "s1", branchId: "b1" });
  assert.equal(draft.details.summarizedThrough, 144);
}

// A branch/session change while the summary runs makes its result stale and unapplied.
{
  const state = new BackgroundCompactionState();
  const gate = deferred();
  state.observe(base(), () => gate.promise);
  gate.resolve("stale summary");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.applyAtBoundary({ sessionId: "s1", branchId: "other" }), null);
  assert.equal(state.lastResult.status, "discarded-stale");
}

// Failure and empty summaries leave the original context untouched and expose a fallback condition.
for (const summarize of [async () => { throw new Error("fake provider failure"); }, async () => "   "]) {
  const state = new BackgroundCompactionState();
  state.observe(base(), summarize);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.status, "failed");
  assert.equal(state.applyAtBoundary({ sessionId: "s1", branchId: "b1" }), null);
  assert.equal(state.lastResult.status, "failed");
}

console.log("PASS: async non-blocking snapshot, 50% threshold, 80/20 cut, one-shot apply, stale discard, and failure fallback");
