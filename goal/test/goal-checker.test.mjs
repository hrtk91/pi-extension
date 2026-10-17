import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildGoalCheckerTask,
  buildGoalTrackingInstructions,
  extractFinalAssistantText,
  formatGoalAuditSummary,
  parseGoalCheckerReport,
  runReadOnlyGoalChecker,
} from "../src/goal-checker.mjs";
import { applyGoalAudit, emptyGoalState, normalizeGoalState, reduceGoalCommand } from "../src/goal-state.mjs";

function goalWithCriteria() {
  let state = reduceGoalCommand(emptyGoalState(), "set 設定画面を実装する", 1).state;
  state = reduceGoalCommand(state, "criterion 設定画面が表示される", 2).state;
  state = reduceGoalCommand(state, "criterion node --test が成功する", 3).state;
  return state;
}

// The worker sees its goal on each run and is prompted to reflect and request an independent audit.
{
  const state = goalWithCriteria();
  const prompt = buildGoalTrackingInstructions(state);
  assert.match(prompt, /after meaningful work steps/);
  assert.match(prompt, /goal_audit/);
  assert.match(prompt, /設定画面が表示される/);
  assert.match(prompt, /do not treat your own claim as verification/);
  assert.equal(buildGoalTrackingInstructions(emptyGoalState()), "");

  const task = buildGoalCheckerTask({
    state,
    workerSummary: "実装とテストを完了しました。",
    workerEvidence: ["worker says tests passed"],
    sessionEvidence: ["npm test output: 2 passed"],
  });
  assert.match(task, /Verify worker claims against artifacts/);
  assert.match(task, /実装とテストを完了しました/);
  assert.match(task, /worker says tests passed/);
  assert.match(task, /npm test output: 2 passed/);
}

// Audits are strict: every condition gets a verdict, and an unsupported pass becomes unknown.
{
  const state = goalWithCriteria();
  const report = parseGoalCheckerReport(JSON.stringify({ verdicts: [
    { criterion: 1, verdict: "pass", reason: "Rendered by GoalPanelComponent.", evidence: ["goal/src/goal-ui.mjs: GoalPanelComponent.render"] },
    { criterion: 2, verdict: "pass", reason: "The worker reported tests passing.", evidence: [] },
  ] }), state.criteria);
  assert.deepEqual(report.verdicts.map((item) => item.verdict), ["pass", "unknown"]);
  assert.deepEqual(parseGoalCheckerReport("not JSON", state.criteria).verdicts.map((item) => item.verdict), ["unknown", "unknown"]);
  const duplicate = parseGoalCheckerReport(JSON.stringify({ verdicts: [
    { criterion: 1, verdict: "pass", reason: "One result", evidence: ["src/a.mjs:1"] },
    { criterion: 1, verdict: "fail", reason: "Conflicting result", evidence: ["src/a.mjs:2"] },
    { criterion: 2, verdict: "pass", evidence: ["test output"] },
  ] }), state.criteria);
  assert.deepEqual(duplicate.verdicts.map((item) => item.verdict), ["unknown", "unknown"]);
  assert.match(formatGoalAuditSummary(report), /pass 1, fail 0, unknown 1/);
}

// Only checker passes complete criteria; failures and uncertainty reopen them and preserve evidence.
{
  const state = goalWithCriteria();
  const passed = applyGoalAudit(state, { verdicts: [
    { criterion: 1, verdict: "pass", reason: "Component renders the target view.", evidence: ["goal/src/goal-ui.mjs:render"] },
    { criterion: 2, verdict: "pass", reason: "The recorded test run passed.", evidence: ["node --test: 2 passed"] },
  ] }, 10, "Both conditions appear satisfied.");
  assert.equal(passed.status, "complete");
  assert.ok(passed.criteria.every((item) => item.complete && item.completionSource === "checker"));
  assert.ok(passed.criteria.every((item) => item.verification.status === "passed"));
  assert.equal(passed.history.at(-2).type, "reflection");
  assert.equal(passed.history.at(-1).type, "audit");

  const failed = applyGoalAudit(passed, { verdicts: [
    { criterion: 1, verdict: "pass", reason: "View exists.", evidence: ["goal/src/goal-ui.mjs"] },
    { criterion: 2, verdict: "fail", reason: "The test output shows a failure.", evidence: ["node --test: 1 failed"] },
  ] }, 11);
  assert.equal(failed.status, "active");
  assert.equal(failed.criteria[0].complete, true);
  assert.equal(failed.criteria[1].complete, false);
  assert.equal(failed.criteria[1].verification.status, "failed");

  const migrated = normalizeGoalState({ goal: "old", criteria: [{ text: "old condition", complete: true }] });
  assert.equal(migrated.criteria[0].completionSource, "manual");
  const unsupportedPass = normalizeGoalState({ goal: "new", criteria: [{
    text: "audited condition",
    complete: true,
    completionSource: "checker",
    verification: { status: "passed", evidence: [] },
  }] });
  assert.equal(unsupportedPass.criteria[0].verification.status, "unknown");
  assert.equal(unsupportedPass.criteria[0].complete, false);
  const inconsistent = normalizeGoalState({ goal: "inconsistent", status: "complete", criteria: [{ text: "condition", complete: false }] });
  assert.equal(inconsistent.status, "active");
}

// The spawned reviewer receives only read-oriented tools, no extensions or shell, and must finish before parsing.
{
  const state = goalWithCriteria();
  const expectedReport = JSON.stringify({ verdicts: [
    { criterion: 1, verdict: "pass", reason: "Rendered.", evidence: ["goal/src/goal-ui.mjs:render"] },
    { criterion: 2, verdict: "unknown", reason: "No test output was available.", evidence: [] },
  ] });
  const lines = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: expectedReport }] } });
  assert.equal(extractFinalAssistantText(`${lines}\nnot-json\n`), expectedReport);

  let observed;
  const output = await runReadOnlyGoalChecker({
    cwd: "/repo",
    model: "openai/test-model",
    thinkingLevel: "low",
    state,
    workerSummary: "Review the finished work.",
    workerEvidence: ["worker test claim"],
    sessionEvidence: ["npm test output"],
    timeoutMs: 17_000,
    exec: async (command, args, options) => {
      observed = { command, args, options };
      const systemPath = args[args.indexOf("--append-system-prompt") + 1];
      assert.match(await readFile(systemPath, "utf8"), /independent, read-only reviewer/);
      return { code: 0, killed: false, stdout: lines, stderr: "" };
    },
  });
  assert.equal(output, expectedReport);
  const tools = observed.args[observed.args.indexOf("--tools") + 1].split(",");
  assert.deepEqual(tools, ["read", "grep", "find", "ls"]);
  assert.ok(observed.args.includes("--no-extensions"));
  assert.ok(observed.args.includes("--no-mcp"));
  assert.ok(!tools.some((tool) => ["bash", "write", "edit"].includes(tool)));
  assert.ok(observed.args.includes("openai/test-model"));
  assert.equal(observed.options.cwd, "/repo");
  assert.equal(observed.options.timeout, 17_000);
}

console.log("PASS: goal reflection, read-only independent audits, evidence validation, and completion transitions");
