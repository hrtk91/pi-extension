import assert from "node:assert/strict";
import { emptyGoalState, normalizeGoalState, reduceGoalCommand } from "../src/goal-state.mjs";

const apply = (state, command, now = 1) => reduceGoalCommand(state, command, now);

// A goal can be set with an explicit command or as the direct /goal argument.
{
  let state = emptyGoalState();
  let result = apply(state, "set テストを通してパネルを作る");
  assert.equal(result.kind, "update");
  state = result.state;
  assert.equal(state.goal, "テストを通してパネルを作る");
  assert.equal(state.status, "active");
  assert.equal(state.history[0].type, "goal");
  assert.equal(apply(emptyGoalState(), "UIを仕上げる").state.goal, "UIを仕上げる");
  assert.equal(apply(state, "").kind, "show");
}

// Conditions stay consistent; manual completion remains an explicit override.
{
  let state = apply(emptyGoalState(), "set バグを直す").state;
  state = apply(state, "criterion npm test が通る").state;
  state = apply(state, "criterion 変更内容を確認する").state;
  assert.equal(state.criteria.length, 2);
  state = apply(state, "done 1", 2).state;
  assert.equal(state.status, "active");
  assert.equal(state.criteria[0].complete, true);
  assert.equal(state.criteria[0].completionSource, "manual");
  state = apply(state, "done 2", 3).state;
  assert.equal(state.status, "complete");
  assert.match(state.history.at(-1).text, /手動で完了/);
  assert.equal(apply(state, "done 0").kind, "error");
  assert.equal(apply(state, "done 9").kind, "error");
}

// Notes, handoff records, blocked state, and clearing are visible events; handoff does not claim to launch an agent.
{
  let state = apply(emptyGoalState(), "set 引き継ぎを確認する").state;
  state = apply(state, "note 1回目のテストに失敗").state;
  state = apply(state, "handoff エラーと次の確認箇所").state;
  assert.equal(state.history.at(-1).type, "handoff note");
  assert.match(state.history.at(-1).text, /記録のみ/);
  assert.match(apply(state, "handoff 次の人へ").message, /起動していません/);
  state = apply(state, "blocked 同じエラーが続く").state;
  assert.equal(state.status, "blocked");
  state = apply(state, "resume").state;
  assert.equal(state.status, "active");
  state = apply(state, "clear").state;
  assert.equal(state.goal, null);
  assert.equal(state.criteria.length, 0);
  assert.ok(state.history.length >= 5, "clear keeps the timeline");
}

// Invalid persisted data and terminal control characters are normalized safely.
{
  const state = normalizeGoalState({
    goal: "goal\u001b[31m RED",
    status: "not-a-status",
    criteria: [{ text: "first\ncondition", complete: 1 }, null],
    history: [{ type: "x", text: "row\u001b[2J", at: 10 }],
  });
  assert.equal(state.goal, "goal [31m RED");
  assert.equal(state.status, "active");
  assert.equal(state.criteria[0].text, "first condition");
  assert.equal(state.criteria[0].complete, false);
  assert.equal(state.history[0].text, "row [2J");
}

// History is bounded so a long session does not create unbounded widget state.
{
  let state = apply(emptyGoalState(), "set long-running task").state;
  for (let i = 0; i < 50; i++) state = apply(state, `note event ${i}`, i + 2).state;
  assert.equal(state.history.length, 40);
  assert.match(state.history[0].text, /event 10/);
}

console.log("PASS: goal command reducer, criteria, manual override, history, and normalization");
