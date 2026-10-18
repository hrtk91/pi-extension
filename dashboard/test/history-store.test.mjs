import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, unlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshHistoricalStats } from "../src/history-store.mjs";
import { groupStatsByModel } from "../src/session-stats.mjs";

const temp = mkdtempSync(join(tmpdir(), "pi-dashboard-history-"));
const agentDir = join(temp, "agent");
const sessionRoot = join(agentDir, "sessions");
const firstDir = join(sessionRoot, "project-a", "nested");
const secondDir = join(sessionRoot, "project-b");
mkdirSync(firstDir, { recursive: true });
mkdirSync(secondDir, { recursive: true });

function entry(id, { provider = "provider-a", model = "model-one", output = 10, duration = 1000, timestamp = 1000, content = "PRIVATE_PROMPT_AND_RESPONSE" } = {}) {
  const message = {
    role: "assistant",
    provider,
    model,
    timestamp,
    usage: { output },
    content: [{ type: "text", text: content }],
  };
  if (duration !== null) message.durationMs = duration;
  return { type: "message", id, parentId: null, timestamp: new Date(timestamp).toISOString(), message };
}

function jsonl(sessionId, entries) {
  return [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-10-01T00:00:00.000Z", cwd: temp }),
    ...entries.map((item) => typeof item === "string" ? item : JSON.stringify(item)),
  ].join("\n") + "\n";
}

const firstFile = join(firstDir, "first.jsonl");
const forkFile = join(secondDir, "fork.jsonl");
const customSessionFile = join(temp, "external-session.jsonl");
writeFileSync(firstFile, jsonl("session-a", [
  entry("entry-one", { output: 20, duration: 2000, timestamp: 10000 }),
  entry("entry-two", { output: 30, duration: 3000, timestamp: 20000 }),
  entry("untimed", { output: 100, duration: null, timestamp: 30000 }),
  { type: "message", id: "user-entry", message: { role: "user", content: "not a statistic" } },
]));
writeFileSync(forkFile, jsonl("session-fork", [
  // Forked copies retain the same entry metadata and must not count a response twice.
  entry("entry-one", { output: 20, duration: 2000, timestamp: 10000 }),
  entry("entry-three", { provider: "provider-b", model: "model-two", output: 50, duration: 1000, timestamp: 40000 }),
  "{ incomplete trailing JSON",
]));
writeFileSync(customSessionFile, jsonl("custom-session", [
  entry("entry-four", { provider: "provider-a", model: "model-one", output: 40, duration: 4000, timestamp: 50000 }),
]));

try {
  const first = await refreshHistoricalStats({ agentDir, currentSessionFile: customSessionFile });
  assert.equal(first.indexedFiles, 3);
  assert.equal(first.rescannedFiles, 3);
  assert.equal(first.samples.length, 4, "untimed, non-assistant, malformed and duplicate fork entries are excluded");

  const groups = groupStatsByModel(first.samples);
  assert.equal(groups.all.responses, 4);
  assert.equal(groups.all.outputTokens, 140);
  assert.equal(groups.all.sessions, 3);
  assert.deepEqual(groups.models.map((item) => item.key), ["provider-a/model-one", "provider-b/model-two"]);
  assert.equal(groups.models[0].stats.responses, 3);
  assert.equal(groups.models[0].stats.p50, 10);
  assert.equal(groups.models[1].stats.p50, 50);

  const cachePath = join(agentDir, "extensions", "dashboard-stats.json");
  const cacheText = readFileSync(cachePath, "utf8");
  const cache = JSON.parse(cacheText);
  assert.equal(statSync(cachePath).mode & 0o777, 0o600, "statistics cache must be private to the current user");
  assert.doesNotMatch(cacheText, /PRIVATE_PROMPT_AND_RESPONSE/, "cache must not persist message content");
  assert.ok(cache.samples.every((sample) => !("content" in sample) && !("message" in sample)));

  const unchanged = await refreshHistoricalStats({ agentDir, currentSessionFile: customSessionFile });
  assert.equal(unchanged.rescannedFiles, 0, "unchanged session files are served from the fingerprint cache");
  assert.equal(unchanged.samples.length, 4);

  appendFileSync(firstFile, `${JSON.stringify(entry("entry-five", { output: 12, duration: 2000, timestamp: 60000 }))}\n`);
  const appended = await refreshHistoricalStats({ agentDir, currentSessionFile: customSessionFile });
  assert.equal(appended.rescannedFiles, 1);
  assert.equal(appended.samples.length, 5);
  assert.equal(groupStatsByModel(appended.samples).all.outputTokens, 152);

  unlinkSync(forkFile);
  const afterSessionDelete = await refreshHistoricalStats({ agentDir, currentSessionFile: customSessionFile });
  assert.equal(afterSessionDelete.indexedFiles, 2);
  assert.equal(afterSessionDelete.samples.length, 5, "collected statistics persist after source session files are deleted");
  assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).version, 1);
  console.log("PASS: historical session scan, model grouping, fork deduplication, cache privacy and persistence");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
