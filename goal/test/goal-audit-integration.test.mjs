import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionPath = fileURLToPath(new URL("../src/extension.mjs", import.meta.url));

test("worker can invoke a read-only GoalChecker tool and persist its response", { timeout: 60_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-goal-audit-e2e-"));
  const agentDir = join(temp, "agent");
  const homeDir = join(temp, "home");
  const sessionDir = join(temp, "sessions");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

  const requests = [];
  let parentRequestedAudit = false;
  let reviewerSawReadOnlyTools = false;
  let workerSawGoalReminder = false;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const serialized = JSON.stringify(payload.messages ?? []);
        const isReviewer = serialized.includes("Independently audit the goal using the current project files");
        const toolNames = (payload.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
        const requestIndex = requests.length + 1;
        requests.push({ isReviewer, toolNames, serialized });
        let delta;
        let finishReason = "stop";
        if (isReviewer) {
          reviewerSawReadOnlyTools = ["read", "grep", "find", "ls"].every((name) => toolNames.includes(name)) &&
            !["bash", "write", "edit"].some((name) => toolNames.includes(name));
          delta = { content: JSON.stringify({ verdicts: [
            { criterion: 1, verdict: "pass", reason: "The goal and criterion are present in the recorded project state.", evidence: ["README.md: goal extension documentation"] },
          ] }) };
        } else if (!parentRequestedAudit && toolNames.includes("goal_audit")) {
          parentRequestedAudit = true;
          workerSawGoalReminder = serialized.includes("Goal tracking") && serialized.includes("goal_audit") && serialized.includes("Test the GoalChecker integration");
          delta = { tool_calls: [{ index: 0, id: "call-goal-audit-e2e", type: "function", function: {
            name: "goal_audit",
            arguments: JSON.stringify({ summary: "The implementation is ready for independent review.", evidence: ["npm test passed"] }),
          } }] };
          finishReason = "tool_calls";
        } else {
          delta = { content: "The independent audit finished." };
        }
        const base = { id: `chatcmpl-goal-${requestIndex}`, object: "chat.completion.chunk", created: 1_700_000_000, model: "fake-model" };
        const chunksOut = [
          { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
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
  let stdoutBuffer = "";
  let stdout = "";
  let stderr = "";
  let nextId = 0;
  const pending = new Map();
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

  const sendRpc = (command, timeoutMs = 20_000) => {
    const id = `goal-e2e-${++nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC ${command.type} timed out; stderr=${stderr}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (record) => { clearTimeout(timer); resolve(record); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return;
        const waiter = pending.get(id);
        pending.delete(id);
        waiter?.reject(error);
      });
    });
  };
  const waitForIdle = async (timeoutMs = 25_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await sendRpc({ type: "get_state" });
      if (state.success && !state.data.isStreaming) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Pi did not become idle; stderr=${stderr}`);
  };
  const promptAndWait = async (message) => {
    const result = await sendRpc({ type: "prompt", message });
    assert.equal(result.success, true, `prompt failed: ${JSON.stringify(result)}`);
    await waitForIdle();
  };

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [] }), { mode: 0o600 });
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: { llamacpp: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "test-only-key",
        models: [{ id: "fake-model", name: "Fake model", reasoning: false, input: ["text"], contextWindow: 16_384, maxTokens: 2048,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      } },
    }, null, 2), { mode: 0o600 });

    child = spawn("pi", [
      "--mode", "rpc", "--model", "llamacpp/fake-model", "--session-dir", sessionDir,
      "--extension", extensionPath, "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    ], { cwd: process.cwd(), env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      stdoutBuffer += chunk;
      while (stdoutBuffer.includes("\n")) {
        const index = stdoutBuffer.indexOf("\n");
        const line = stdoutBuffer.slice(0, index);
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        try {
          const record = JSON.parse(line);
          if (record.type === "response" && record.id) {
            const waiter = pending.get(record.id);
            if (waiter) {
              pending.delete(record.id);
              waiter.resolve(record);
            }
          }
        } catch { /* Ignore non-JSON startup output. */ }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      for (const [id, waiter] of pending) {
        pending.delete(id);
        waiter.reject(error);
      }
    });
    const closePromise = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));

    const commands = await sendRpc({ type: "get_commands" });
    assert.ok(commands.data.commands.some((command) => command.name === "goal"));
    assert.ok(!commands.data.commands.some((command) => command.name === "goal_audit"));
    await promptAndWait("/goal set Test the GoalChecker integration");
    await promptAndWait("/goal criterion The checker tool is invoked and reports evidence");
    await promptAndWait("Please make the goal ready for audit.");

    assert.ok(parentRequestedAudit, "worker should be able to call goal_audit");
    assert.ok(workerSawGoalReminder, "worker request should receive the goal tracking prompt");
    assert.ok(reviewerSawReadOnlyTools, "reviewer should have only read-oriented tools");
    const entries = await sendRpc({ type: "get_entries" });
    const goalEntry = [...entries.data.entries].reverse().find((entry) => entry.type === "custom" && entry.customType === "pi-goal-state");
    assert.ok(goalEntry, "goal state should be persisted after the reviewer returns");
    assert.equal(goalEntry.data.status, "complete");
    assert.equal(goalEntry.data.criteria[0].verification.status, "passed");
    assert.equal(goalEntry.data.criteria[0].completionSource, "checker");

    child.stdin.end();
    const outcome = await closePromise;
    assert.equal(outcome.code, 0, `Pi exit=${outcome.code} signal=${outcome.signal}\nstdout=${stdout}\nstderr=${stderr}`);
    console.log("PASS: worker reflection, read-only reviewer invocation, tool isolation, and checker-result persistence");
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => server.close(resolve));
    rmSync(temp, { recursive: true, force: true });
  }
});
