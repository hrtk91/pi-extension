import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const installerPath = fileURLToPath(new URL("../install.sh", import.meta.url));
const READY_NOTICE = "Background compaction summary is ready";
const APPLIED_NOTICE = "background compaction applied through assistant turn 80";
const SUMMARY_TEXT = "## Goal\nE2E background summary checkpoint\n\n## Progress\n- Preserved recent conversation.";
const OLD_ONLY_MARKER = "e2e-old-only-prefix-marker-0001";

test("manual and autonomous compaction show progress, safely replace real Pi history, and preserve continuation", { timeout: 120_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-background-compaction-happy-path-"));
  const agentDir = join(temp, "agent");
  const homeDir = join(temp, "home");
  const sessionDir = join(temp, "sessions");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

  let releaseSummary;
  const summaryGate = new Promise((resolve) => { releaseSummary = resolve; });
  let markSummaryRequest;
  const summaryRequestSeen = new Promise((resolve) => { markSummaryRequest = resolve; });
  let summaryRequestCount = 0;
  let requestCount = 0;
  let autonomousMode = false;
  let autonomousStep = 0;
  const requestDiagnostics = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const serializedMessages = JSON.stringify(payload.messages ?? []);
        const isSummaryRequest = serializedMessages.includes("<conversation>");
        if (!isSummaryRequest && serializedMessages.includes("e2e-long-autonomous-run")) autonomousMode = true;
        requestCount++;
        if (isSummaryRequest) {
          summaryRequestCount++;
          markSummaryRequest();
          await summaryGate;
        }
        const autonomousToolCall = !isSummaryRequest && autonomousMode && ++autonomousStep <= 10;
        if (!isSummaryRequest && autonomousMode && !autonomousToolCall) autonomousMode = false;
        const text = isSummaryRequest ? SUMMARY_TEXT : "E2E assistant reply";
        const base = { id: `chatcmpl-e2e-${requestCount}`, object: "chat.completion.chunk", created: 1_700_000_000, model: "fake-model" };
        const delta = autonomousToolCall
          ? { tool_calls: [{ index: 0, id: `call-e2e-${autonomousStep}`, type: "function", function: {
            name: "bash", arguments: JSON.stringify({ command: `printf 'e2e-autonomous-step-${autonomousStep} '; for i in {1..60}; do printf 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu '; done` }),
          } }] }
          : { content: text };
        requestDiagnostics.push({ summary: isSummaryRequest, autonomousMode, autonomousStep, messageCount: payload.messages?.length, messageChars: serializedMessages.length, lastMessage: serializedMessages.slice(-100) });
        const finishReason = autonomousToolCall ? "tool_calls" : "stop";
        const promptTokens = autonomousToolCall && autonomousStep <= 2 ? 4500 : 8;
        const chunksOut = [
          { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: promptTokens, completion_tokens: 4, total_tokens: promptTokens + 4 } },
        ];
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        for (const chunk of chunksOut) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.end("data: [DONE]\n\n");
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
  });

  let child;
  let closePromise;
  let stderr = "";
  let stdoutBuffer = "";
  const pendingResponses = new Map();
  const notifications = [];
  let nextCommandId = 0;
  const turnEvents = [];
  const eventWaiters = [];
  const notificationWaiters = [];

  const notifyWaiters = (waiters, value) => {
    for (let index = waiters.length - 1; index >= 0; index--) {
      if (waiters[index].predicate(value)) {
        const [waiter] = waiters.splice(index, 1);
        waiter.resolve(value);
      }
    }
  };
  const waitFor = (predicate, waiters, values, description, timeoutMs = 10_000) => {
    const found = values.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${description}`));
      }, timeoutMs);
      const originalResolve = waiter.resolve;
      waiter.resolve = (value) => { clearTimeout(timer); originalResolve(value); };
    });
  };
  const sendRpc = (command, timeoutMs = 15_000) => {
    const id = `e2e-${++nextCommandId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingResponses.delete(id);
        reject(new Error(`RPC ${command.type} timed out; stderr=${stderr}`));
      }, timeoutMs);
      pendingResponses.set(id, {
        resolve: (record) => { clearTimeout(timer); resolve(record); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return;
        const pending = pendingResponses.get(id);
        pendingResponses.delete(id);
        pending?.reject(error);
      });
    });
  };
  const waitForIdle = async (timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await sendRpc({ type: "get_state" });
      if (state.success && !state.data.isStreaming) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Pi did not become idle; stderr=${stderr}`);
  };
  const promptAndWait = async (message) => {
    const response = await sendRpc({ type: "prompt", message });
    assert.equal(response.success, true, `prompt failed: ${JSON.stringify(response)}`);
    await waitForIdle();
  };
  const getEntries = async () => {
    const response = await sendRpc({ type: "get_entries" });
    assert.equal(response.success, true, `get_entries failed: ${JSON.stringify(response)}`);
    return response.data.entries;
  };
  const getMessages = async () => {
    const response = await sendRpc({ type: "get_messages" });
    assert.equal(response.success, true, `get_messages failed: ${JSON.stringify(response)}`);
    return response.data.messages;
  };

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const settings = { extensions: [] };
    writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(agentDir, "models.json"), `${JSON.stringify({
      providers: { llamacpp: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "test-only-key",
        models: [
          { id: "fake-model", name: "Fake model", reasoning: false, input: ["text"], contextWindow: 65_536, maxTokens: 2048,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
          { id: "fake-small", name: "Fake small-window model", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 2048,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        ],
      } },
    }, null, 2)}\n`, { mode: 0o600 });
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: homeDir,
      LANG: "C.UTF-8",
      TMPDIR: temp,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      NO_PROXY: "*",
    };
    const installed = spawnSync("bash", [installerPath], { env, encoding: "utf8", timeout: 15_000 });
    assert.equal(installed.status, 0, `isolated install failed\nstdout=${installed.stdout}\nstderr=${installed.stderr}`);
    assert.ok(existsSync(join(agentDir, "extensions/background-compaction/extension.mjs")));

    child = spawn("pi", [
      "--mode", "rpc", "--model", "llamacpp/fake-model", "--session-dir", sessionDir,
      "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    ], { cwd: temp, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdoutBuffer += chunk;
      while (stdoutBuffer.includes("\n")) {
        const newline = stdoutBuffer.indexOf("\n");
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        try {
          const record = JSON.parse(line);
          if (record.type === "response" && record.id) {
            const pending = pendingResponses.get(record.id);
            if (pending) {
              pendingResponses.delete(record.id);
              pending.resolve(record);
            }
          } else if (record.type === "extension_ui_request" && record.method === "notify") {
            notifications.push(record);
            notifyWaiters(notificationWaiters, record);
          } else if (record.type === "turn_end") {
            turnEvents.push(record);
            notifyWaiters(eventWaiters, record);
          }
        } catch {
          // Ignore non-JSON startup output; RPC records are newline-delimited JSON.
        }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      for (const [id, pending] of pendingResponses) {
        pendingResponses.delete(id);
        pending.reject(error);
      }
    });
    closePromise = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));

    const commands = await sendRpc({ type: "get_commands" });
    assert.equal(commands.success, true);
    assert.ok(commands.data.commands.some((command) => command.name === "bgcompact"));
    for (let number = 1; number <= 100; number++) {
      await promptAndWait(number === 1 ? OLD_ONLY_MARKER : `e2e-seed-turn-${String(number).padStart(3, "0")}`);
    }
    const seededEntries = await getEntries();
    assert.equal(seededEntries.filter((entry) => entry.type === "message" && entry.message.role === "user").length, 100);
    assert.equal(seededEntries.some((entry) => entry.type === "compaction"), false, "seeded context starts uncompacted");

    const manualCommand = await sendRpc({ type: "prompt", message: "/bgcompact" });
    assert.equal(manualCommand.success, true, `manual command failed: ${JSON.stringify(manualCommand)}`);
    await waitFor((record) => record.message.includes("Manual background compaction started"), notificationWaiters, notifications, "manual start notification");
    await Promise.race([
      summaryRequestSeen,
      new Promise((_, reject) => setTimeout(() => reject(new Error("summary model request did not start")), 10_000)),
    ]);
    assert.equal(summaryRequestCount, 1, "manual trigger should issue one background summary request");
    assert.equal(notifications.some((record) => record.message.includes(READY_NOTICE)), false, "summary must not be reported ready while its model request is held");

    await promptAndWait("e2e-continue-while-summary-is-running");
    const whileRunningEntries = await getEntries();
    assert.equal(whileRunningEntries.some((entry) => entry.type === "compaction"), false, "history must not be replaced before the summary is ready");
    assert.equal(notifications.some((record) => record.message.includes(APPLIED_NOTICE)), false);

    releaseSummary();
    await waitFor((record) => record.message.includes(READY_NOTICE), notificationWaiters, notifications, "summary-ready notification");
    const readyEntries = await getEntries();
    assert.equal(readyEntries.some((entry) => entry.type === "compaction"), false, "ready means prepared, not yet applied");

    await promptAndWait("e2e-continue-after-summary-ready");
    await waitFor((record) => record.message.includes(APPLIED_NOTICE), notificationWaiters, notifications, "compaction-applied notification");
    const compactedEntries = await getEntries();
    const compactions = compactedEntries.filter((entry) => entry.type === "compaction");
    assert.equal(compactions.length, 1, "the safe boundary should append exactly one real session compaction entry");
    const compaction = compactions[0];
    const keptTurn = compactedEntries.find((entry) => entry.type === "message" && entry.message.role === "user" &&
      JSON.stringify(entry.message.content).includes("e2e-seed-turn-081"));
    assert.ok(keptTurn, "raw session history retains the selected keep boundary");
    assert.equal(compaction.firstKeptEntryId, keptTurn.id, "compaction must point at the first retained user turn");
    assert.equal(compaction.details.summarizedThrough, 80);
    assert.match(compaction.summary, /E2E background summary checkpoint/);
    assert.ok(compactedEntries.some((entry) => entry.type === "message" && JSON.stringify(entry.message.content).includes(OLD_ONLY_MARKER),
      "the append-only session log keeps older entries expandable"));

    const currentMessages = await getMessages();
    const currentText = JSON.stringify(currentMessages);
    assert.match(currentText, /E2E background summary checkpoint/, "the active context receives the summary");
    assert.doesNotMatch(currentText, new RegExp(OLD_ONLY_MARKER), "the summarized old prefix is removed from active context");
    assert.match(currentText, /e2e-seed-turn-081/, "the retained boundary remains in active context");
    assert.match(currentText, /e2e-continue-while-summary-is-running/, "messages appended during background work are preserved");
    assert.match(currentText, /e2e-continue-after-summary-ready/, "the turn that reaches the safe boundary is preserved");

    await promptAndWait("e2e-post-compaction-continuation");
    const lastAssistant = await sendRpc({ type: "get_last_assistant_text" });
    assert.equal(lastAssistant.data.text, "E2E assistant reply", "the session continues normally after history replacement");
    const finalMessages = await getMessages();
    assert.match(JSON.stringify(finalMessages), /e2e-post-compaction-continuation/);

    // A single user request drives many assistant/tool cycles. This is the case
    // that used to count as only one turn and silently refuse background planning.
    const newSession = await sendRpc({ type: "new_session" });
    assert.equal(newSession.success, true);
    const smallModel = await sendRpc({ type: "set_model", provider: "llamacpp", modelId: "fake-small" });
    assert.equal(smallModel.success, true);
    const autoCompaction = await sendRpc({ type: "set_auto_compaction", enabled: false });
    assert.equal(autoCompaction.success, true, "native compaction is disabled so this test isolates the extension's trigger");
    const autonomousNoticeStart = notifications.length;
    await promptAndWait("e2e-long-autonomous-run");
    assert.ok(autonomousStep >= 5, `fake model did not complete autonomous tool cycles; step=${autonomousStep}; requests=${JSON.stringify(requestDiagnostics.slice(-12))}; stderr=${stderr}`);
    const newAutonomousNotice = (predicate) => (record) => notifications.indexOf(record) >= autonomousNoticeStart && predicate(record);
    try {
      await waitFor(newAutonomousNotice((record) => record.message.includes("background compaction started") && !record.message.includes("Manual")),
        notificationWaiters, notifications, "automatic start during one autonomous run");
    } catch (error) {
      const stats = await sendRpc({ type: "get_session_stats" });
      throw new Error(`${error.message}; autonomousStep=${autonomousStep}; stats=${JSON.stringify(stats.data)}; diagnostics=${JSON.stringify(requestDiagnostics.slice(-12))}; stderr=${stderr}`);
    }
    await waitFor(newAutonomousNotice((record) => record.message.includes("background compaction applied through assistant turn")),
      notificationWaiters, notifications, "autonomous compaction-applied notification");
    assert.ok(summaryRequestCount >= 2, "the long autonomous run should issue a second background model request");

    const autonomousEntries = await getEntries();
    assert.equal(autonomousEntries.filter((entry) => entry.type === "message" && entry.message.role === "user").length, 1,
      "the autonomous run contains one user request, not many user turns");
    assert.ok(autonomousEntries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length >= 5,
      "the fake model drives multiple assistant turns");
    assert.ok(autonomousEntries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult").length >= 4,
      "tool results are persisted between assistant turns");
    const autonomousCompactions = autonomousEntries.filter((entry) => entry.type === "compaction");
    assert.ok(autonomousCompactions.length >= 1, "a long single-request run must append a real session compaction");
    for (const entry of autonomousCompactions) {
      assert.equal(entry.details.strategy, "background-agent-turn-percent-v2");
      const keptEntry = autonomousEntries.find((candidate) => candidate.id === entry.firstKeptEntryId);
      assert.equal(keptEntry?.type, "message");
      assert.equal(keptEntry?.message.role, "assistant", "the retained boundary must start at a complete assistant turn, not its tool result");
    }
    assert.match(JSON.stringify(await getMessages()), /e2e-autonomous-step-/,
      "recent tool results remain in the active context after autonomous compaction");
  } finally {
    releaseSummary?.();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const outcome = await Promise.race([closePromise, new Promise((resolve) => setTimeout(() => resolve(undefined), 2000))]);
      if (!outcome && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closePromise;
      }
    }
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    rmSync(temp, { recursive: true, force: true });
  }
});
