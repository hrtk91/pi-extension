import assert from "node:assert/strict";
import { PanelSlotRegistry, createDefaultPanelSlots } from "../src/panel-slots.mjs";
import { applyGoalAudit, emptyGoalState, reduceGoalCommand } from "../src/goal-state.mjs";

// Slots have a minimal stable contract and are sorted without coupling the panel to a particular tab.
{
  const registry = new PanelSlotRegistry();
  registry.register({ id: "later", title: "Later", icon: "◦", order: 20, render: () => ["later"] });
  const unregister = registry.register({ id: "first", title: "First", icon: "•", order: 10, render: () => ["first"] });
  assert.deepEqual(registry.list().map((slot) => slot.id), ["first", "later"]);
  assert.throws(() => registry.register({ id: "first", title: "Duplicate", icon: "x", order: 30, render() {} }), /already registered/);
  unregister();
  assert.deepEqual(registry.list().map((slot) => slot.id), ["later"]);
}

// Invalid slots fail early; default goal and usage tabs use the same extension point.
{
  const registry = new PanelSlotRegistry();
  assert.throws(() => registry.register({ id: "Bad ID", title: "Bad", icon: "x", order: 0, render() {} }), /id/);
  assert.throws(() => registry.register({ id: "missing-render", title: "Bad", icon: "x", order: 0 }), /render/);
  const slots = createDefaultPanelSlots().list();
  assert.deepEqual(slots.map((slot) => slot.id), ["goal", "usage"]);
  assert.deepEqual(slots.map((slot) => slot.title), ["ゴール", "利用統計"]);
  let goal = reduceGoalCommand(emptyGoalState(), "set panel test").state;
  for (let i = 0; i < 6; i++) goal = reduceGoalCommand(goal, `note history ${i + 1}`, i + 1).state;
  const renderedGoal = slots[0].render(goal).join("\n");
  assert.match(renderedGoal, /panel test/);
  assert.match(renderedGoal, /history 6/);
  assert.doesNotMatch(renderedGoal, /history 1/);
  assert.match(renderedGoal, /ほか 3 件/);
  assert.match(slots[1].render(goal).join("\n"), /実データには接続していません/);

  let audited = reduceGoalCommand(emptyGoalState(), "set 監査表示テスト").state;
  audited = reduceGoalCommand(audited, "criterion 成果物が正しい").state;
  audited = applyGoalAudit(audited, { verdicts: [
    { criterion: 1, verdict: "pass", reason: "実装を確認した", evidence: ["src/result.mjs:12"] },
  ] }, 20);
  const renderedAudit = slots[0].render(audited).join("\n");
  assert.match(renderedAudit, /完了 \(監査済み\)/);
  assert.match(renderedAudit, /監査: 合格/);
  assert.match(renderedAudit, /src\/result.mjs:12/);
}

console.log("PASS: extensible panel slot contract, ordering, and sample tabs");
