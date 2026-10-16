import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { buildStandardSummaryPrompt, SUMMARIZATION_SYSTEM_PROMPT } from "../src/background-runtime.mjs";

const piCli = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const managedVersionPath = join(piAgentDir, "install", "current-version");
const managedVersion = existsSync(managedVersionPath) ? readFileSync(managedVersionPath, "utf8").trim() : undefined;
const candidates = [
  process.env.PI_CODING_AGENT_PACKAGE_ROOT,
  resolve(dirname(piCli), "../.."),
  managedVersion && join(piAgentDir, "install", "releases", managedVersion, "node_modules", "@earendil-works", "pi-coding-agent"),
].filter(Boolean);
const piRoot = candidates.find((candidate) => existsSync(join(candidate, "dist/core/compaction/compaction.js")));
assert.ok(piRoot, `could not locate Pi package; checked ${candidates.join(", ")}`);
const core = join(piRoot, "dist/core/compaction/compaction.js");
const utils = join(piRoot, "dist/core/compaction/utils.js");
const compactionSource = readFileSync(core, "utf8");
const utilsSource = readFileSync(utils, "utf8");
const template = (source, name) => {
  const match = source.match(new RegExp("(?:const|export const) " + name + " = `([\\s\\S]*?)`;"));
  assert.ok(match, `could not find native ${name}`);
  return match[1];
};
const nativeInitial = template(compactionSource, "SUMMARIZATION_PROMPT");
const nativeUpdateInstructions = template(compactionSource, "UPDATE_SUMMARIZATION_INSTRUCTIONS");
const nativeSystem = template(utilsSource, "SUMMARIZATION_SYSTEM_PROMPT");
const transcript = "[User]: preserve this\n[Assistant]: answer";
const previous = "## Goal\nprior goal";
assert.equal(SUMMARIZATION_SYSTEM_PROMPT, nativeSystem);
assert.equal(buildStandardSummaryPrompt(transcript), `<conversation>\n${transcript}\n</conversation>\n\n${nativeInitial}`);
const nativeUpdate = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.\n\n${nativeUpdateInstructions}`;
assert.equal(buildStandardSummaryPrompt(transcript, previous), `<conversation>\n${transcript}\n</conversation>\n\n<previous-summary>\n${previous}\n</previous-summary>\n\n${nativeUpdate}`);
console.log("PASS: background summary system and initial/update prompts exactly match the installed Pi native compaction prompts");
