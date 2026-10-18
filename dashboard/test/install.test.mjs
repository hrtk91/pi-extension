import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const installerPath = fileURLToPath(new URL("../install.sh", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "pi-dashboard-smoke-"));
const agentDir = join(temp, "agent");
const homeDir = join(temp, "home");
const extensionsDir = join(agentDir, "extensions");
mkdirSync(extensionsDir, { recursive: true, mode: 0o700 });
mkdirSync(homeDir, { recursive: true, mode: 0o700 });

async function getCommands(env) {
  const sessionDir = join(temp, "sessions");
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const child = spawn("pi", [
    "--mode", "rpc", "--model", "llamacpp/fake-model", "--session-dir", sessionDir,
    "--no-mcp", "--no-tools", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
  ], { cwd: temp, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", stdout = "", stderr = "", names = [];
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
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
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    extensions: ["~/.pi/agent/extensions/dashboard.js", "/other/extensions/kept.mjs"],
  }, null, 2), { mode: 0o600 });
  writeFileSync(join(extensionsDir, "dashboard.js"), "legacy dashboard source\n", { mode: 0o600 });
  const statsCachePath = join(extensionsDir, "dashboard-stats.json");
  const statsCacheContent = '{"version":1,"files":[],"samples":[{"key":"preserve-me"}]}\n';
  writeFileSync(statsCachePath, statsCacheContent, { mode: 0o600 });

  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homeDir, LANG: "C.UTF-8", TMPDIR: temp,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
  };
  const installed = spawnSync("bash", [installerPath], { env, encoding: "utf8", timeout: 15_000 });
  assert.equal(installed.status, 0, `installer failed\nstdout=${installed.stdout}\nstderr=${installed.stderr}`);

  const settingsPath = join(agentDir, "settings.json");
  const extensionPath = join(extensionsDir, "dashboard/extension.mjs");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.deepEqual(settings.extensions, ["/other/extensions/kept.mjs", extensionPath]);
  assert.equal(existsSync(extensionPath), true);
  for (const file of ["session-stats.mjs", "history-store.mjs", "stats-tabs.mjs"]) {
    assert.equal(existsSync(join(extensionsDir, "dashboard", file)), true, `missing installed module ${file}`);
  }
  assert.equal(readFileSync(statsCachePath, "utf8"), statsCacheContent, "install must preserve persistent statistics");
  assert.equal(existsSync(join(extensionsDir, "dashboard.js")), false);
  assert.match(installed.stdout, /Backup: (.+)/);
  const backupDir = installed.stdout.match(/Backup: (.+)/)[1].trim();
  assert.equal(readFileSync(join(backupDir, "legacy-dashboard.js"), "utf8"), "legacy dashboard source\n");

  const commands = await getCommands(env);
  assert.ok(commands.includes("stats"), `missing /stats command: ${commands.join(", ")}`);

  const uninstalled = spawnSync("bash", [installerPath, "--uninstall"], { env, encoding: "utf8", timeout: 15_000 });
  assert.equal(uninstalled.status, 0, `uninstaller failed\nstdout=${uninstalled.stdout}\nstderr=${uninstalled.stderr}`);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).extensions, ["/other/extensions/kept.mjs"]);
  assert.equal(existsSync(extensionPath), false, "uninstall should move the installed copy into backups");
  assert.equal(readFileSync(statsCachePath, "utf8"), statsCacheContent, "uninstall must preserve persistent statistics");
  console.log("PASS: dashboard install, legacy migration, /stats load, and uninstall");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
