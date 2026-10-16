import assert from "node:assert/strict";
import test from "node:test";
import { registerBackgroundCompaction } from "../src/background-runtime.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};

function makeHarness({ entries, projected, contextTokens = 600 } = {}) {
  const handlers = new Map();
  const notifications = [];
  const sessionManager = {
    getSessionId: () => "assistant-turn-session",
    getLeafId: () => entries.at(-1)?.id ?? "root",
    getBranch: () => [...entries],
    buildSessionProjection: () => ({ entries: [...projected], messages: projected.flatMap((item) => item.messages) }),
  };
  const ctx = {
    sessionManager,
    getContextUsage: () => ({ tokens: contextTokens, contextWindow: 1000, percent: contextTokens / 10 }),
    model: { provider: "test-provider", id: "fake-model", maxTokens: 4096 },
    modelRegistry: { getAvailable: () => [] },
    ui: { notify(message, type) { notifications.push({ message, type }); } },
  };
  const pi = {
    on(name, handler) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    registerCommand() {},
  };
  return { handlers, notifications, sessionManager, ctx, pi, entries, projected };
}

function addEntry(harness, role, id, text) {
  const previous = harness.sessionManager.getBranch().at(-1);
  const entry = {
    type: "message",
    id,
    parentId: previous?.id ?? null,
    message: { role, content: [{ type: "text", text }] },
  };
  harness.entries.push(entry);
  harness.projected.push({ sourceEntry: entry, messages: [entry.message] });
  return entry;
}

function buildOneUserManyAssistantTurns() {
  const entries = [];
  const projected = [];
  const harness = makeHarness({ entries, projected });
  addEntry(harness, "user", "user-1", "one long autonomous task");
  for (let turn = 1; turn <= 5; turn++) {
    addEntry(harness, "assistant", `assistant-${turn}`, `assistant response ${turn}`);
    addEntry(harness, "toolResult", `tool-result-${turn}`, `tool output ${turn}`);
  }
  return harness;
}

test("automatic compaction counts assistant/tool cycles within one long user request", async () => {
  const harness = buildOneUserManyAssistantTurns();
  const gate = deferred();
  let capturedSnapshot;
  const state = registerBackgroundCompaction(harness.pi, {
    summarizeOverride: (snapshot) => { capturedSnapshot = snapshot; return gate.promise; },
    settings: { startAtPercent: 50, keepRecentPercent: 20, maxCompactTurns: 80 },
  });

  harness.handlers.get("turn_end")[0]({ type: "turn_end", context: { contextEntries: harness.projected } }, harness.ctx);
  await Promise.resolve();

  assert.equal(state.status, "summarizing", "60% context use with five assistant turns should start a background summary");
  assert.equal(capturedSnapshot.turnsToSummarize.length, 4, "one user request can contain multiple independently completed assistant turns, retaining the latest 20%");
  assert.equal(capturedSnapshot.firstKeptEntryId, "assistant-5");
  const summarizedText = capturedSnapshot.turnsToSummarize.flatMap((turn) => turn.messages)
    .flatMap((message) => message.content ?? []).map((part) => part.text ?? "").join("\n");
  assert.match(summarizedText, /one long autonomous task/, "the original request is included in the first summarized assistant turn");
  assert.match(summarizedText, /tool output 4/, "tool results from summarized assistant turns are included");
  assert.doesNotMatch(summarizedText, /assistant response 5/, "the first retained assistant turn is excluded from the frozen summary");
  assert.doesNotMatch(summarizedText, /tool output 5/, "the retained assistant turn's tool result is not separated from it");

  gate.resolve("summary of the first four assistant turns");
  await new Promise((resolve) => setImmediate(resolve));
  addEntry(harness, "user", "user-2", "continue after summary is ready");
  addEntry(harness, "assistant", "assistant-6", "continuation response");
  const applied = harness.handlers.get("turn_end")[0]({ type: "turn_end", context: { contextEntries: harness.projected } }, harness.ctx);

  assert.equal(applied.entries[0].type, "compaction");
  assert.equal(applied.entries[0].firstKeptEntryId, "assistant-5", "safe boundary starts at an assistant message, never in the middle of its tool results");
  assert.equal(applied.entries[0].details.summarizedThrough, 4);
  assert.equal(state.status, "applied");
  assert.ok(harness.notifications.some(({ message }) => message.includes("applied through assistant turn 4")));
});

test("legacy user-turn counters reset while their previous summary remains available", async () => {
  const entries = [{
    type: "compaction",
    id: "legacy-compaction",
    parentId: null,
    summary: "legacy summary retained as context",
    firstKeptEntryId: "assistant-1",
    details: { strategy: "background-turn-percent-v1", summarizedThrough: 80 },
  }];
  const projected = [{ sourceEntry: entries[0], messages: [{ role: "compactionSummary", summary: entries[0].summary }] }];
  const harness = makeHarness({ entries, projected });
  for (let turn = 1; turn <= 3; turn++) {
    addEntry(harness, "assistant", `assistant-${turn}`, `assistant turn ${turn}`);
    if (turn < 3) addEntry(harness, "toolResult", `tool-result-${turn}`, `tool result ${turn}`);
  }
  const gate = deferred();
  let capturedSnapshot;
  const state = registerBackgroundCompaction(harness.pi, {
    summarizeOverride: (snapshot) => { capturedSnapshot = snapshot; return gate.promise; },
    settings: { startAtPercent: 0, keepRecentPercent: 20 },
  });

  harness.handlers.get("turn_end")[0]({ type: "turn_end", context: { contextEntries: harness.projected } }, harness.ctx);
  await Promise.resolve();

  assert.equal(state.status, "summarizing");
  assert.equal(capturedSnapshot.fromTurn, 1, "v1 counts user turns and cannot be reused as assistant-turn counts");
  assert.equal(capturedSnapshot.throughTurn, 2);
  assert.equal(capturedSnapshot.previousSummary, "legacy summary retained as context");
  assert.equal(capturedSnapshot.turnsToSummarize.length, 2);
  assert.equal(capturedSnapshot.firstKeptEntryId, "assistant-3");
  gate.resolve("updated summary");
  await new Promise((resolve) => setImmediate(resolve));
  const draft = state.applyAtBoundary({ sessionId: "assistant-turn-session", branchId: "legacy-compaction" });
  assert.equal(draft.details.strategy, "background-agent-turn-percent-v2");
  assert.equal(draft.details.summarizedThrough, 2);
});
