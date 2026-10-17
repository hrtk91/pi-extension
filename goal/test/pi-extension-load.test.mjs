import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionPath = fileURLToPath(new URL("../src/extension.mjs", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "pi-goal-extension-smoke-"));
const agentDir = join(temp, "agent");
mkdirSync(agentDir, { recursive: true, mode: 0o700 });
writeFileSync(join(agentDir, "models.json"), JSON.stringify({
  providers: { llamacpp: {
    baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "local-test-only",
    models: [{ id: "fake-model", name: "Fake model", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } },
}, null, 2), { mode: 0o600 });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [] }), { mode: 0o600 });

const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: temp,
  LANG: "C.UTF-8",
  TMPDIR: temp,
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
};

try {
  const child = spawn("pi", [
    "--mode", "rpc", "--model", "llamacpp/fake-model", "--session-dir", join(temp, "sessions"),
    "--extension", extensionPath, "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
  ], { cwd: temp, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", stdout = "", stderr = "";
  const exitPromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  const commandResult = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 500).unref();
    }, 15_000);
    child.once("error", reject);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === "response" && event.id === "goal-commands") {
            resolve(event.data?.commands?.map((command) => command.name) ?? []);
            child.stdin.end();
          }
        } catch { /* Ignore non-JSON startup output. */ }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Pi exit=${code}\nstdout=${stdout}\nstderr=${stderr}`));
    });
    child.stdin.write(JSON.stringify({ id: "goal-commands", type: "get_commands" }) + "\n");
  });
  const names = await commandResult;
  const exit = await exitPromise;
  assert.equal(exit, 0, `Pi did not exit cleanly\nstdout=${stdout}\nstderr=${stderr}`);
  assert.ok(names.includes("goal"), `missing /goal command: ${names.join(", ")}\n${stderr}`);
  assert.ok(!names.includes("goal_audit"), "the checker must be a tool, not a slash subcommand");
  console.log("PASS: Goal extension loads, registers /goal, and keeps goal_audit out of slash commands");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
