import assert from "node:assert/strict";
import { createGoalOverlayOptions } from "../src/panel-layout.mjs";

const { badge, panel } = createGoalOverlayOptions();
assert.equal(badge.width, 7);
assert.equal(badge.margin.right, 1, "keep the badge at its original right-edge position");
assert.equal(panel.margin.right, badge.margin.right + badge.width - 1);
assert.equal(panel.margin.top, badge.margin.top + 2, "the floating panel sits just below the independent badge");
assert.equal(panel.nonCapturing, true, "the panel leaves keyboard focus in the main editor");
assert.equal(createGoalOverlayOptions(52).panel.width, 52, "the overlay accepts a dynamically resized width");
assert.equal(createGoalOverlayOptions(200).panel.width, 80, "resized width is capped");
assert.equal(createGoalOverlayOptions(12).panel.width, 32, "resized width respects the minimum");

for (const terminalWidth of [89, 120]) {
  const badgeGlyphColumn = terminalWidth - badge.margin.right - badge.width;
  const panelLeftColumn = terminalWidth - panel.margin.right - panel.width;
  const panelToggleColumn = panelLeftColumn + panel.width - 1;
  assert.equal(panelToggleColumn, badgeGlyphColumn, `toggle alignment at ${terminalWidth} columns`);
}

console.log("PASS: fixed badge position and floating-panel alignment");
