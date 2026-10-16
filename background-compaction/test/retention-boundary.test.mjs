import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundCompactionState } from "../src/background-state.mjs";
import { registerBackgroundCompaction } from "../src/background-runtime.mjs";

const makeTurns = (count) => Array.from({ length: count }, (_, index) => ({
  id: `turn-${index + 1}`,
  firstEntryId: `user-${index + 1}`,
  messages: [],
}));

function createManualHarness({ contextTokens = 100 } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  const projected = [];
  const notifications = [];
  const addTurn = (number) => {
    const user = {
      type: "message", id: `u${number}`, parentId: entries.at(-1)?.id ?? null,
      message: { role: "user", content: [{ type: "text", text: `question ${number}` }] },
    };
    const assistant = {
      type: "message", id: `a${number}`, parentId: user.id,
      message: { role: "assistant", content: [{ type: "text", text: `answer ${number}` }] },
    };
    entries.push(user, assistant);
    projected.push({ sourceEntry: user, messages: [user.message] }, { sourceEntry: assistant, messages: [assistant.message] });
  };
  const sessionManager = {
    getSessionId: () => "retention-session",
    getLeafId: () => entries.at(-1)?.id ?? "root",
    getBranch: () => [...entries],
    buildSessionProjection: () => ({ entries: [...projected], messages: projected.flatMap((entry) => entry.messages) }),
  };
  const ctx = {
    sessionManager,
    isIdle: () => true,
    getContextUsage: () => ({ tokens: contextTokens, contextWindow: 1000, percent: contextTokens / 10 }),
    model: { provider: "test-provider", id: "active-model", maxTokens: 4096 },
    modelRegistry: { getAvailable: () => [] },
    ui: { notify(message, type) { notifications.push({ message, type }); } },
  };
  const pi = {
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerCommand(name, definition) { commands.set(name, definition); },
  };
  return {
    handlers, commands, entries, projected, notifications, addTurn, ctx,
    register: (options) => registerBackgroundCompaction(pi, options),
  };
}

test("a fresh one-turn conversation has no prefix while preserving the recent-turn policy", () => {
  const state = new BackgroundCompactionState();
  let summarizeCalls = 0;
  const result = state.observe({
    sessionId: "s", branchId: "b", anchorEntryId: "a1", contextTokens: 900, contextWindow: 1000,
    turns: makeTurns(1), summarizedThrough: 0,
  }, async () => { summarizeCalls++; return "unused"; }, { startAtPercent: 0 });

  assert.equal(result.started, false);
  assert.equal(result.reason, "no-eligible-prefix");
  assert.equal(state.status, "idle");
  assert.equal(summarizeCalls, 0);
});

test("after turn 80 was summarized, 21 kept turns have no prefix and turn 22 unlocks only turn 81", async () => {
  const state = new BackgroundCompactionState();
  const snapshot = (count) => ({
    sessionId: "s", branchId: "b", anchorEntryId: `assistant-${count}`, contextTokens: 900, contextWindow: 1000,
    turns: makeTurns(count), summarizedThrough: 80,
  });
  const blocked = state.observe(snapshot(21), async () => "must not run", { startAtPercent: 0 });
  assert.equal(blocked.started, false);
  assert.equal(blocked.reason, "no-eligible-prefix");
  assert.equal(state.status, "idle");

  const started = state.observe(snapshot(22), async (frozen) => {
    assert.equal(frozen.turnsToSummarize.length, 1);
    return "summary through turn 81";
  }, { startAtPercent: 0 });
  assert.equal(started.started, true);
  assert.equal(started.plan.fromTurn, 81);
  assert.equal(started.plan.throughTurn, 81);
  assert.equal(started.snapshot.firstKeptEntryId, "user-2");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.status, "ready");
});

test("/bgcompact explains no eligible prefix, then starts when a new turn makes one eligible", async () => {
  const harness = createManualHarness();
  for (let number = 1; number <= 21; number++) harness.addTurn(number);
  harness.entries.unshift({
    type: "compaction", id: "prior-compaction", parentId: null, summary: "summary through turn 80",
    details: { strategy: "background-turn-percent-v1", summarizedThrough: 80 },
  });
  const summarized = [];
  const gate = new Promise((resolve) => { harness.resolveSummary = resolve; });
  const state = harness.register({ summarizeOverride: (snapshot) => { summarized.push(snapshot); return gate; } });
  const command = harness.commands.get("bgcompact").handler;

  await command("", harness.ctx);
  assert.equal(state.status, "idle");
  assert.equal(summarized.length, 0);
  assert.equal(harness.notifications.at(-1).type, "warning");
  assert.match(harness.notifications.at(-1).message, /直近 20% を残すと要約対象がありません/);
  assert.match(harness.notifications.at(-1).message, /会話を続けてから \/bgcompact を再実行/);

  harness.addTurn(22);
  await command("", harness.ctx);
  assert.equal(state.status, "summarizing");
  await Promise.resolve();
  assert.equal(summarized.length, 1);
  assert.equal(summarized[0].turnsToSummarize.length, 1);
  assert.equal(summarized[0].fromTurn, 81);
  assert.equal(summarized[0].throughTurn, 81);
  harness.resolveSummary("summary through turn 81");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.status, "ready");
  state.cancel("test-cleanup");
});

test("/bgcompact refuses while Pi is busy or before an assistant reply exists", async () => {
  const harness = createManualHarness();
  harness.addTurn(1);
  harness.addTurn(2);
  let summarizeCalls = 0;
  const state = harness.register({ summarizeOverride: async () => { summarizeCalls++; return "unused"; } });
  const command = harness.commands.get("bgcompact").handler;

  harness.ctx.isIdle = () => false;
  await command("", harness.ctx);
  assert.equal(state.status, "idle");
  assert.match(harness.notifications.at(-1).message, /Wait for the current assistant reply to finish/);

  harness.ctx.isIdle = () => true;
  harness.projected.pop();
  await command("", harness.ctx);
  assert.equal(state.status, "idle");
  assert.match(harness.notifications.at(-1).message, /There is no completed assistant reply/);
  assert.equal(summarizeCalls, 0);
});
