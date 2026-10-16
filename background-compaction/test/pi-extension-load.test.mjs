import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const installerPath = fileURLToPath(new URL("../install.sh", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "pi-background-compaction-smoke-"));
const agentDir = join(temp, "agent");
const homeDir = join(temp, "home");
mkdirSync(agentDir, { recursive: true, mode: 0o700 });
mkdirSync(homeDir, { recursive: true, mode: 0o700 });

async function getCommands(env, name) {
  const sessionDir = join(temp, `sessions-${name}`);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const child = spawn("pi", [
    "--mode", "rpc", "--model", "llamacpp/fake-model", "--session-dir", sessionDir,
    "--no-mcp", "--no-tools", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
  ], { cwd: temp, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", stdout = "", stderr = "", names = [];
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk; buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try {
        const record = JSON.parse(line);
        if (record.type === "response" && record.id === "commands") {
          names = record.data?.commands?.map((command) => command.name) ?? [];
          child.stdin.end();
        }
      } catch { /* Ignore non-JSON startup output. */ }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdin.write(JSON.stringify({ id: "commands", type: "get_commands" }) + "\n");
  const outcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 500).unref();
    }, 15_000);
    child.once("error", reject);
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.equal(outcome.code, 0, `Pi exit=${outcome.code} signal=${outcome.signal}\nstdout=${stdout}\nstderr=${stderr}`);
  return names;
}

try {
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: { llamacpp: {
      baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "local-test-only",
      models: [{ id: "fake-model", name: "Fake model", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } },
  }, null, 2), { mode: 0o600 });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [] }), { mode: 0o600 });

  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? homeDir, LANG: "C.UTF-8", TMPDIR: temp,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
  };
  const installed = spawnSync("bash", [installerPath], { env, encoding: "utf8", timeout: 15_000 });
  assert.equal(installed.status, 0, `installer failed\nstdout=${installed.stdout}\nstderr=${installed.stderr}`);
  const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  const extensionPath = join(agentDir, "extensions/background-compaction/extension.mjs");
  assert.deepEqual(settings.extensions, [extensionPath]);
  assert.equal(existsSync(extensionPath), true);

  const normalCommands = await getCommands(env, "normal");
  assert.ok(normalCommands.includes("bgcompact"), `missing user command: ${normalCommands.join(", ")}`);
  for (const command of ["bgcompact-status", "bgcompact-probe", "bgcompact-selftest"]) {
    assert.ok(!normalCommands.includes(command), `${command} should be hidden unless PI_BGCOMPACT_DEBUG=1`);
  }

  const debugCommands = await getCommands({ ...env, PI_BGCOMPACT_DEBUG: "1" }, "debug");
  for (const command of ["bgcompact", "bgcompact-status", "bgcompact-probe", "bgcompact-selftest"]) {
    assert.ok(debugCommands.includes(command), `debug mode missing ${command}: ${debugCommands.join(", ")}`);
  }

  const uninstalled = spawnSync("bash", [installerPath, "--uninstall"], { env, encoding: "utf8", timeout: 15_000 });
  assert.equal(uninstalled.status, 0, `uninstaller failed\nstdout=${uninstalled.stdout}\nstderr=${uninstalled.stderr}`);
  assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).extensions, []);
  assert.equal(existsSync(extensionPath), false, "uninstall should move the installed copy into the backup directory");
  console.log("PASS: install/load/uninstall; /bgcompact stays visible while diagnostics require PI_BGCOMPACT_DEBUG=1");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
