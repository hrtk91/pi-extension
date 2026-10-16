import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBackgroundCompaction } from "../src/background-runtime.mjs";

function createHarness({ contextTokens = 500 } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const state = registerBackgroundCompaction({
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerCommand(name, definition) { commands.set(name, definition); },
  }, { summarizeOverride: async () => "unused" });
  const entries = [];
  const projected = [];
  const notifications = [];
  const addTurn = (n) => {
    const user = { type: "message", id: `u${n}`, parentId: entries.at(-1)?.id ?? null, message: { role: "user", content: [{ type: "text", text: `question ${n}` }] } };
    const assistant = { type: "message", id: `a${n}`, parentId: user.id, message: { role: "assistant", content: [{ type: "text", text: `answer ${n}` }] } };
    entries.push(user, assistant);
    projected.push({ sourceEntry: user, messages: [user.message] }, { sourceEntry: assistant, messages: [assistant.message] });
  };
  const sessionManager = {
    getSessionId: () => "session-1",
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
  const event = () => ({ context: { contextEntries: [...projected] } });
  return { handlers, commands, state, entries, projected, notifications, addTurn, ctx, event };
}
const deferred = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};
const registerOnHarness = (h, options = {}) => registerBackgroundCompaction({
  on(name, handler) { const list = h.handlers.get(name) ?? []; list.push(handler); h.handlers.set(name, list); },
  registerCommand(name, definition) { h.commands.set(name, definition); },
}, options);

// Actual pi event handlers kick off the summary without waiting, then append at a safe boundary.
{
  const h = createHarness();
  for (let i = 1; i <= 100; i++) h.addTurn(i);
  const gate = deferred();
  h.state.cancel("replace-test-summarizer");
  const state = registerBackgroundCompaction({
    on(name, handler) { const list = h.handlers.get(name) ?? []; list.push(handler); h.handlers.set(name, list); },
    registerCommand(name, definition) { h.commands.set(name, definition); },
  }, { summarizeOverride: (snapshot) => { assert.equal(snapshot.turnsToSummarize.length, 80); return gate.promise; } });
  const event = h.event();
  const handler = h.handlers.get("turn_end").at(-1);
  const started = handler(event, h.ctx);
  assert.equal(started, undefined, "turn_end must not await the summary model");
  assert.equal(state.status, "summarizing");

  // Conversation progresses while the snapshot is being summarized.
  for (let i = 101; i <= 110; i++) h.addTurn(i);
  gate.resolve("summary for turns 1-80");
  await new Promise((resolve) => setImmediate(resolve));
  h.ctx.getContextUsage = () => ({ tokens: 600, contextWindow: 1000, percent: 60 });
  const applied = handler(h.event(), h.ctx);
  assert.equal(applied.entries[0].type, "compaction");
  assert.equal(applied.entries[0].firstKeptEntryId, "u81");
  assert.equal(applied.entries[0].details.summarizedThrough, 80);
  assert.equal(applied.entries[0].tokensBefore, 600);
  assert.equal(state.status, "applied");
}

// A standard compaction after the snapshot invalidates its result instead of overwriting newer history.
{
  const h = createHarness();
  for (let i = 1; i <= 100; i++) h.addTurn(i);
  const gate = deferred();
  const state = registerBackgroundCompaction({
    on(name, handler) { const list = h.handlers.get(name) ?? []; list.push(handler); h.handlers.set(name, list); },
    registerCommand(name, definition) { h.commands.set(name, definition); },
  }, { summarizeOverride: () => gate.promise });
  const handler = h.handlers.get("turn_end").at(-1);
  handler(h.event(), h.ctx);
  gate.resolve("old summary");
  await new Promise((resolve) => setImmediate(resolve));
  h.entries.push({ type: "compaction", id: "fallback-compact", parentId: h.entries.at(-1).id, summary: "standard summary", firstKeptEntryId: "u90" });
  h.ctx.sessionManager.getLeafId = () => "fallback-compact";
  assert.equal(handler(h.event(), h.ctx), undefined);
  assert.equal(state.lastResult.status, "discarded-stale");
  assert.equal(state.status, "discarded-stale");
}

// A hung summarizer times out, is aborted, and cannot leave the state machine stuck forever.
{
  const h = createHarness();
  for (let i = 1; i <= 100; i++) h.addTurn(i);
  let capturedSignal;
  const state = registerBackgroundCompaction({
    on(name, handler) { const list = h.handlers.get(name) ?? []; list.push(handler); h.handlers.set(name, list); },
    registerCommand(name, definition) { h.commands.set(name, definition); },
  }, { summarizeOverride: (snapshot) => { capturedSignal = snapshot.abortController.signal; return new Promise(() => {}); }, settings: { summaryTimeoutMs: 10 } });
  h.handlers.get("turn_end").at(-1)(h.event(), h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(capturedSignal.aborted, true);
  assert.equal(state.status, "failed");
  assert.match(state.lastResult.error, /timed out/);
}

// Pi's standard-compaction hook cancels background work and invalidates its result.
{
  const h = createHarness();
  for (let i = 1; i <= 100; i++) h.addTurn(i);
  let signal;
  const state = registerBackgroundCompaction({
    on(name, handler) { const list = h.handlers.get(name) ?? []; list.push(handler); h.handlers.set(name, list); },
    registerCommand(name, definition) { h.commands.set(name, definition); },
  }, { summarizeOverride: (snapshot) => { signal = snapshot.abortController.signal; return new Promise(() => {}); } });
  h.handlers.get("turn_end").at(-1)(h.event(), h.ctx);
  await Promise.resolve();
  h.handlers.get("session_before_compact").at(-1)({}, { ui: { notify() {} } });
  assert.equal(signal.aborted, true);
  assert.equal(state.status, "standard-compaction-fallback");
  assert.equal(state.applyAtBoundary({ sessionId: "session-1", branchId: "no-compaction" }), null);
}

// The interactive footer spinner is visible only while the background request is actually running.
{
  const h = createHarness();
  for (let i = 1; i <= 100; i++) h.addTurn(i);
  h.ctx.mode = "tui";
  const statusUpdates = [];
  h.ctx.ui = {
    notify() {},
    setStatus(key, text) { statusUpdates.push({ key, text }); },
    theme: { fg: (_color, text) => text },
  };
  const gate = deferred();
  const state = registerBackgroundCompaction({
    on(name, handler) { const list = h.handlers.get(name) ?? []; list.push(handler); h.handlers.set(name, list); },
    registerCommand(name, definition) { h.commands.set(name, definition); },
  }, { summarizeOverride: () => gate.promise });
  h.handlers.get("turn_end").at(-1)(h.event(), h.ctx);
  assert.equal(state.status, "summarizing");
  assert.equal(statusUpdates.at(-1).key, "background-compaction");
  assert.match(statusUpdates.at(-1).text, /bgcompact 1–80 · 0s/);
  gate.resolve("ready summary");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(state.status, "ready");
  assert.equal(statusUpdates.at(-1).text, undefined, "footer status clears when summarization ends");
  const updateCount = statusUpdates.length;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(statusUpdates.length, updateCount, "spinner timer is stopped after clearing");
}

// /bgcompact bypasses the automatic threshold but uses the same planner, allowlist, and async/safe-boundary flow.
{
  const h = createHarness({ contextTokens: 100 });
  for (let i = 1; i <= 100; i++) h.addTurn(i);
  h.ctx.model = { provider: "openai-codex", id: "gpt-6-luna" };
  const gate = deferred();
  const state = registerBackgroundCompaction({
    on(name, handler) { const list = h.handlers.get(name) ?? []; list.push(handler); h.handlers.set(name, list); },
    registerCommand(name, definition) { h.commands.set(name, definition); },
  }, {
    summarizeOverride: (snapshot) => { assert.equal(snapshot.turnsToSummarize.length, 80); return gate.promise; },
    settings: { allowedModels: ["openai-codex/gpt-6-luna"], startAtPercent: 50 },
  });
  // No turn_end event has populated extension memory: this models a freshly resumed session.
  // The command must reconstruct the current safe context directly from the session manager.
  h.addTurn(101);
  await h.commands.get("bgcompact").handler("", h.ctx);
  assert.equal(state.status, "summarizing", "/bgcompact should force the same background summary below threshold");
  assert.ok(h.notifications.some(({ message }) => message.includes("Manual background compaction started")), "manual command gives immediate feedback even when footer status is unavailable");
  gate.resolve("manually requested summary");
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(state.status, "ready");
  assert.ok(h.notifications.some(({ message }) => message.includes("summary is ready")), "manual command reports when the summary is ready");
}

// A standard compaction after the saved snapshot still invalidates it safely.
{
  const h = createHarness({ contextTokens: 100 });
  for (let i = 1; i <= 100; i++) h.addTurn(i);
  h.ctx.model = { provider: "openai-codex", id: "gpt-6-luna" };
  const state = registerBackgroundCompaction({
    on(name, handler) { const list = h.handlers.get(name) ?? []; list.push(handler); h.handlers.set(name, list); },
    registerCommand(name, definition) { h.commands.set(name, definition); },
  }, { summarizeOverride: async () => "unused", settings: { allowedModels: ["openai-codex/gpt-6-luna"] } });
  h.handlers.get("turn_end").at(-1)(h.event(), h.ctx);
  h.entries.push({ type: "compaction", id: "native-compact", parentId: "a100", summary: "native summary", firstKeptEntryId: "u90" });
  await h.commands.get("bgcompact").handler("", h.ctx);
  assert.equal(state.status, "idle", "manual compaction must not reuse a snapshot across standard compaction");
}

// Without an explicit allowlist, background compaction uses whichever Pi model is selected.
{
  const h = createHarness();
  for (let i = 1; i <= 100; i++) h.addTurn(i);
  h.ctx.model = { provider: "llamacpp", id: "fake-model" };
  const state = registerBackgroundCompaction({
    on(name, handler) { const list = h.handlers.get(name) ?? []; list.push(handler); h.handlers.set(name, list); },
    registerCommand(name, definition) { h.commands.set(name, definition); },
  }, { summarizeOverride: async () => "unused" });
  h.handlers.get("turn_end").at(-1)(h.event(), h.ctx);
  assert.equal(state.status, "summarizing", "any selected model can start a background summary by default");
}

// An explicit custom allowlist remains available to users who want one.
{
  const h = createHarness();
  for (let i = 1; i <= 100; i++) h.addTurn(i);
  h.ctx.model = { provider: "anthropic", id: "other-model" };
  const state = registerBackgroundCompaction({
    on(name, handler) { const list = h.handlers.get(name) ?? []; list.push(handler); h.handlers.set(name, list); },
    registerCommand(name, definition) { h.commands.set(name, definition); },
  }, { summarizeOverride: async () => "unused", settings: { allowedModels: ["openai-codex/gpt-6-luna"] } });
  h.handlers.get("turn_end").at(-1)(h.event(), h.ctx);
  assert.equal(state.status, "idle", "a caller-supplied allowlist still restricts models when configured");
}

// Model preferences can be changed live, persisted across extension reloads, overridden once, and reset.
{
  const temp = mkdtempSync(join(tmpdir(), "pi-bgcompact-model-preference-"));
  const modelConfigPath = join(temp, "background-compaction.json");
  const models = [
    { provider: "local-test", id: "summary-model", maxTokens: 2048 },
    { provider: "anthropic", id: "one-shot-model", maxTokens: 4096 },
    { provider: "provider-a", id: "shared-name", maxTokens: 2048 },
    { provider: "provider-b", id: "shared-name", maxTokens: 2048 },
  ];
  try {
    const h = createHarness();
    for (let i = 1; i <= 100; i++) h.addTurn(i);
    h.ctx.model = { provider: "openai-codex", id: "chat-model", maxTokens: 8192 };
    h.ctx.modelRegistry = { getAvailable: () => models };
    const liveModels = [];
    const liveState = registerOnHarness(h, {
      modelConfigPath,
      summarizeOverride: async (snapshot) => { liveModels.push(snapshot.model); return "unused"; },
    });
    await h.commands.get("bgcompact").handler("model set shared-name", h.ctx);
    assert.equal(existsSync(modelConfigPath), false, "ambiguous bare model ids must not be saved");
    await h.commands.get("bgcompact").handler("model set local-test/summary-model", h.ctx);
    assert.deepEqual(JSON.parse(readFileSync(modelConfigPath, "utf8")), { version: 1, defaultModel: "local-test/summary-model" });
    assert.ok(h.notifications.some(({ message }) => message.includes("default model set to local-test/summary-model")));
    await h.commands.get("bgcompact").handler("model", h.ctx);
    assert.ok(h.notifications.some(({ message }) => message.includes("default model: local-test/summary-model")));
    h.handlers.get("turn_end").at(-1)(h.event(), h.ctx);
    assert.equal(liveState.status, "summarizing");
    await Promise.resolve();
    assert.equal(liveModels[0].provider, "local-test", "changing the model applies without reloading Pi");
    liveState.cancel("test-cleanup");

    // A fresh extension instance reads the saved preference and uses it for automatic summaries.
    const reloaded = createHarness();
    for (let i = 1; i <= 100; i++) reloaded.addTurn(i);
    reloaded.ctx.model = { provider: "openai-codex", id: "chat-model", maxTokens: 8192 };
    reloaded.ctx.modelRegistry = { getAvailable: () => models };
    const automaticModels = [];
    const automaticState = registerOnHarness(reloaded, {
      modelConfigPath,
      summarizeOverride: async (snapshot) => { automaticModels.push(snapshot.model); return "unused"; },
    });
    reloaded.handlers.get("turn_end").at(-1)(reloaded.event(), reloaded.ctx);
    assert.equal(automaticState.status, "summarizing");
    await Promise.resolve();
    assert.equal(automaticModels[0].provider, "local-test");
    assert.equal(automaticModels[0].id, "summary-model");
    automaticState.cancel("test-cleanup");

    const manual = createHarness({ contextTokens: 100 });
    for (let i = 1; i <= 100; i++) manual.addTurn(i);
    manual.ctx.model = { provider: "openai-codex", id: "chat-model", maxTokens: 8192 };
    manual.ctx.modelRegistry = { getAvailable: () => models };
    const manualModels = [];
    const manualState = registerOnHarness(manual, {
      modelConfigPath,
      summarizeOverride: async (snapshot) => { manualModels.push(snapshot.model); return "unused"; },
    });
    await manual.commands.get("bgcompact").handler("unknown-model", manual.ctx);
    assert.equal(manualState.status, "idle", "unknown model names must not start compaction");
    assert.equal(JSON.parse(readFileSync(modelConfigPath, "utf8")).defaultModel, "local-test/summary-model", "invalid model must not overwrite the saved default");
    await manual.commands.get("bgcompact").handler("anthropic/one-shot-model", manual.ctx);
    await Promise.resolve();
    assert.equal(manualModels[0].provider, "anthropic");
    assert.equal(manualModels[0].id, "one-shot-model");
    assert.ok(manual.notifications.some(({ message }) => message.includes("one-time override")));
    assert.equal(JSON.parse(readFileSync(modelConfigPath, "utf8")).defaultModel, "local-test/summary-model", "one-time override must not replace the saved default");
    await manual.commands.get("bgcompact").handler("model reset", manual.ctx);
    assert.equal(existsSync(modelConfigPath), false, "reset removes the persistent override");
    manualState.cancel("test-cleanup");

    // With the preference reset, a new instance falls back to Pi's current model.
    const fallback = createHarness();
    for (let i = 1; i <= 100; i++) fallback.addTurn(i);
    fallback.ctx.model = { provider: "openai-codex", id: "chat-model", maxTokens: 8192 };
    fallback.ctx.modelRegistry = { getAvailable: () => models };
    const fallbackModels = [];
    const fallbackState = registerOnHarness(fallback, {
      modelConfigPath,
      summarizeOverride: async (snapshot) => { fallbackModels.push(snapshot.model); return "unused"; },
    });
    fallback.handlers.get("turn_end").at(-1)(fallback.event(), fallback.ctx);
    assert.equal(fallbackState.status, "summarizing");
    await Promise.resolve();
    assert.equal(fallbackModels[0].id, "chat-model");
    fallbackState.cancel("test-cleanup");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// Diagnostic commands are registered only with the explicit debug flag; /bgcompact remains user-facing.
{
  const commandSet = (debugMode) => {
    const commands = new Map();
    registerBackgroundCompaction({ on() {}, registerCommand(name, definition) { commands.set(name, definition); } }, {
      summarizeOverride: async () => "unused", debugMode,
    });
    return commands;
  };
  const normal = commandSet(false);
  assert.ok(normal.has("bgcompact"));
  for (const name of ["bgcompact-status", "bgcompact-probe", "bgcompact-selftest"]) assert.ok(!normal.has(name));
  const debug = commandSet(true);
  for (const name of ["bgcompact", "bgcompact-status", "bgcompact-probe", "bgcompact-selftest"]) assert.ok(debug.has(name));
}

console.log("PASS: automatic/manual compaction, spinner lifecycle, safe apply/fallback, model preferences/overrides, and debug-only diagnostics");
