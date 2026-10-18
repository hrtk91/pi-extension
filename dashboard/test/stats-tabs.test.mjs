import assert from "node:assert/strict";
import { groupStatsByModel } from "../src/session-stats.mjs";
import { StatsTabsComponent } from "../src/stats-tabs.mjs";

const report = {
  ...groupStatsByModel([
    { sessionId: "one", provider: "provider-a", model: "model-one", outputTokens: 100, durationMs: 1000 },
    { sessionId: "two", provider: "provider-b", model: "model-two", outputTokens: 50, durationMs: 2000 },
  ]),
  indexedFiles: 12,
};
let renders = 0;
let closed = false;
const component = new StatsTabsComponent(
  { requestRender: () => { renders++; } },
  { fg: (_color, text) => text },
  { matches: (data, action) => data === "ESC" && action === "tui.select.cancel" },
  () => { closed = true; },
  report,
);

assert.match(component.render(80).join("\n"), /セッション応答統計/);
assert.match(component.render(80).join("\n"), /全モデル/);
component.handleInput("\t");
assert.equal(component.selectedIndex, 1);
assert.equal(renders, 1);
assert.match(component.render(80).join("\n"), /provider-a\/model-one/);
component.handleInput("\u001b[C");
assert.equal(component.selectedIndex, 2);
assert.match(component.render(80).join("\n"), /provider-b\/model-two/);
component.handleInput("\u001b[D");
assert.equal(component.selectedIndex, 1);
component.handleInput("ESC");
assert.equal(closed, true);
console.log("PASS: /stats model tabs render and switch with Tab/arrow keys");
