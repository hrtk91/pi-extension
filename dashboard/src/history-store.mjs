import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const STORE_VERSION = 1;
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_TIMEOUT_MS = 60 * 1000;

function resolveAgentDir(agentDir) {
  const value = agentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

function fingerprint(info) {
  return {
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    ino: info.ino,
  };
}

function sameFingerprint(a, b) {
  return !!a && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
}

function makeSampleKey(sample) {
  return createHash("sha256")
    .update([
      sample.entryId,
      sample.timestamp,
      sample.provider,
      sample.model,
      sample.outputTokens,
      sample.durationMs,
    ].join("\u001f"))
    .digest("hex");
}

async function listSessionFiles(root) {
  const files = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(resolve(path));
    }
  }
  await walk(root);
  return files.sort();
}

async function samplesFromSessionFile(path) {
  const samples = [];
  let sessionId = basename(path, ".jsonl");
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // A Pi process can be writing the final JSONL line while /stats scans it.
      continue;
    }
    if (entry?.type === "session") {
      if (typeof entry.id === "string" && entry.id) sessionId = entry.id;
      continue;
    }
    const message = entry?.type === "message" ? entry.message : null;
    if (message?.role !== "assistant") continue;

    const outputTokens = message.usage?.output;
    const durationMs = message.durationMs;
    const provider = message.provider;
    const model = message.model;
    const entryId = entry.id;
    if (!Number.isFinite(outputTokens) || outputTokens <= 0) continue;
    if (!Number.isFinite(durationMs) || durationMs <= 0) continue;
    if (typeof provider !== "string" || !provider || typeof model !== "string" || !model) continue;
    if (typeof entryId !== "string" || !entryId) continue;

    const messageTimestamp = Number.isFinite(message.timestamp) ? message.timestamp : Date.parse(entry.timestamp);
    const sample = {
      entryId,
      sessionId,
      provider,
      model,
      outputTokens,
      durationMs,
      timestamp: Number.isFinite(messageTimestamp) ? messageTimestamp : 0,
    };
    sample.key = makeSampleKey(sample);
    samples.push(sample);
  }
  return samples;
}

async function readStore(path) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { store: { version: STORE_VERSION, files: [], samples: [] }, exists: false };
    throw error;
  }
  let store;
  try {
    store = JSON.parse(content);
  } catch (error) {
    throw new Error(`Dashboard statistics cache is not valid JSON (${path}): ${error.message}`);
  }
  if (store?.version !== STORE_VERSION || !Array.isArray(store.files) || !Array.isArray(store.samples)) {
    throw new Error(`Dashboard statistics cache has an unsupported format (${path}).`);
  }
  return { store, exists: true };
}

async function writeStore(path, store) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const content = `${JSON.stringify(store, null, 2)}\n`;
  await writeFile(temporary, content, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n${Date.now()}\n`);
        return handle;
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(path).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lockInfo = await stat(path);
        if (Date.now() - lockInfo.mtimeMs > LOCK_STALE_MS) await unlink(path);
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error("Timed out waiting for the dashboard statistics cache lock.");
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
}

/** Incrementally index Pi's persisted assistant usage without storing message content. */
export async function refreshHistoricalStats({ agentDir, currentSessionFile } = {}) {
  const baseDir = resolveAgentDir(agentDir);
  const storePath = join(baseDir, "extensions", "dashboard-stats.json");
  const lockPath = `${storePath}.lock`;
  const lock = await acquireLock(lockPath);
  try {
    const loaded = await readStore(storePath);
    const store = loaded.store;
    const filesByPath = new Map(store.files.map((item) => [item.path, item.fingerprint]));
    const samplesByKey = new Map(store.samples.map((sample) => [sample.key, sample]));
    const paths = new Set(await listSessionFiles(join(baseDir, "sessions")));
    if (typeof currentSessionFile === "string" && currentSessionFile) paths.add(resolve(currentSessionFile));
    const sortedPaths = [...paths].sort();
    let changed = false;
    let rescannedFiles = 0;

    // Forget fingerprints for deleted files, but retain already collected samples as persistent statistics.
    for (const oldPath of filesByPath.keys()) {
      if (!paths.has(oldPath)) {
        filesByPath.delete(oldPath);
        changed = true;
      }
    }

    for (const path of sortedPaths) {
      let before;
      try {
        before = await stat(path);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      const beforeFingerprint = fingerprint(before);
      if (sameFingerprint(filesByPath.get(path), beforeFingerprint)) continue;

      rescannedFiles++;
      const samples = await samplesFromSessionFile(path);
      let afterFingerprint = beforeFingerprint;
      try {
        const after = await stat(path);
        afterFingerprint = fingerprint(after);
        // If the session changed while it was read, leave the old fingerprint so the next refresh retries it.
        if (!sameFingerprint(beforeFingerprint, afterFingerprint)) afterFingerprint = filesByPath.get(path) ?? beforeFingerprint;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      filesByPath.set(path, afterFingerprint);
      changed = true;
      for (const sample of samples) {
        if (!samplesByKey.has(sample.key)) {
          samplesByKey.set(sample.key, sample);
          changed = true;
        }
      }
    }

    const result = [...samplesByKey.values()].sort((a, b) => a.timestamp - b.timestamp || a.key.localeCompare(b.key));
    if (changed || !loaded.exists) {
      await writeStore(storePath, {
        version: STORE_VERSION,
        files: [...filesByPath].map(([path, fileFingerprint]) => ({ path, fingerprint: fileFingerprint })).sort((a, b) => a.path.localeCompare(b.path)),
        samples: result,
      });
    }
    return { samples: result, indexedFiles: sortedPaths.length, rescannedFiles, storePath };
  } finally {
    await lock.close();
    await unlink(lockPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
}
