import assert from "node:assert/strict";
import { GoalBadgeComponent, GoalPanelComponent } from "../src/goal-ui.mjs";
import { applyGoalAudit, emptyGoalState, reduceGoalCommand } from "../src/goal-state.mjs";
import { createDefaultPanelSlots } from "../src/panel-slots.mjs";

const theme = { fg: (_name, text) => text };

// The top-right badge opens on a left click and reflects the current goal state.
{
  let opened = 0;
  const badge = new GoalBadgeComponent(theme, () => opened++);
  assert.equal(badge.render(7)[0], "○", "closed panel uses the hollow-circle icon");
  assert.deepEqual(badge.handleMouse({ type: "press", button: "left" }), { handled: true });
  assert.equal(opened, 0, "mouse-down arms TUI click dispatch without toggling yet");
  badge.handleMouse({ type: "click", button: "left" });
  assert.equal(opened, 1);
  badge.setPanelOpen(true);
  assert.equal(badge.render(7)[0], "◉", "open panel uses the filled-circle icon");
  badge.handleMouse({ type: "click", button: "left" });
  assert.equal(opened, 2, "repeated clicks notify the host to toggle visibility");
  badge.setPanelOpen(false);
  assert.equal(badge.render(7)[0], "○");
  badge.handleMouse({ type: "press", button: "left" });
  badge.handleMouse({ type: "click", button: "right" });
  assert.equal(opened, 2);
}

// The panel switches tabs by mouse only; its non-capturing overlay leaves keyboard input to the main editor.
{
  let state = reduceGoalCommand(emptyGoalState(), "set 日本語のゴールを表示する").state;
  state = reduceGoalCommand(state, "criterion パネルに日本語が出る", 2).state;
  state = reduceGoalCommand(state, "note UI確認を開始", 3).state;
  const panel = new GoalPanelComponent(state, theme, createDefaultPanelSlots().list());
  const initial = panel.render(60).join("\n");
  assert.doesNotMatch(initial, /Pi panel/);
  assert.match(initial.split("\n")[1], /● 🎯 ゴール/);
  assert.match(initial.split("\n")[1], /📊 利用統計/);
  assert.match(initial, /日本語のゴール/);
  assert.match(initial.split("\n")[1], /⠿/, "the top bar shows a subtle drag handle");
  assert.equal(initial.split("\n")[0].at(-1), "╮", "the panel keeps a normal top-right corner");
  assert.doesNotMatch(initial, /\[×\]/, "the separate badge remains the only mouse toggle");
  assert.equal(panel.tabHitRanges.length, 2);

  const usageTab = panel.tabHitRanges[1];
  assert.deepEqual(panel.handleMouse({
    type: "press", button: "left", y: 1, x: usageTab.start, width: 60, height: panel.lastPanelHeight,
    screenX: usageTab.start + 50, screenY: 4,
  }), { handled: true, capture: true });
  panel.handleMouse({
    type: "release", button: "left", y: 1, x: usageTab.start, width: 60, height: panel.lastPanelHeight,
    screenX: usageTab.start + 50, screenY: 4,
  });
  panel.handleMouse({ type: "click", button: "left", y: 1, x: usageTab.start, width: 60, height: panel.lastPanelHeight });
  const usage = panel.render(60).join("\n");
  assert.match(usage, /利用統計スロットのサンプル/);
  assert.match(usage, /実データには/);
  assert.match(usage, /接続していません/);

  assert.equal(typeof panel.handleInput, "undefined", "the panel does not accept keyboard input");
  const goalTab = panel.tabHitRanges[0];
  panel.handleMouse({ type: "press", button: "left", y: 1, x: goalTab.start, width: 60, height: panel.lastPanelHeight, screenX: goalTab.start + 50, screenY: 4 });
  panel.handleMouse({ type: "release", button: "left", y: 1, x: goalTab.start, width: 60, height: panel.lastPanelHeight, screenX: goalTab.start + 50, screenY: 4 });
  panel.handleMouse({ type: "click", button: "left", y: 1, x: goalTab.start, width: 60, height: panel.lastPanelHeight });
  assert.match(panel.render(60).join("\n"), /現在のゴール/);
  assert.equal(panel.handleMouse({ type: "click", button: "left", y: 0, x: 59, width: 60 }), undefined);
}

// Body content scrolls with the mouse wheel; edges/corners resize the window and the top tab bar moves it.
{
  let state = reduceGoalCommand(emptyGoalState(), "set Scroll test").state;
  for (let i = 1; i <= 30; i++) state = reduceGoalCommand(state, `criterion condition ${String(i).padStart(2, "0")}`).state;
  let renders = 0;
  const tui = { terminal: { rows: 18, columns: 120 }, requestRender: () => renders++ };
  const panel = new GoalPanelComponent(state, theme, createDefaultPanelSlots().list(), tui);
  const initial = panel.render(38).join("\n");
  assert.ok(panel.bodyLayout.maxScrollTop > 0, "many conditions should create a scrollable body");
  assert.match(initial, /condition 01/);
  assert.deepEqual(panel.handleMouse({
    type: "wheel", button: "none", x: 8, y: panel.bodyLayout.top, wheelDelta: 7,
    screenX: 110, screenY: 5, width: 38, height: panel.lastPanelHeight,
  }), { handled: true });
  assert.equal(panel.scrollTop, 7);
  const scrolled = panel.render(38).join("\n");
  assert.doesNotMatch(scrolled, /condition 01/);
  assert.match(scrolled, /condition 07/);
  assert.ok(renders > 0);

  const track = panel.bodyLayout;
  assert.deepEqual(panel.handleMouse({
    type: "press", button: "left", x: track.scrollbarX, y: track.top + track.viewportHeight - 1,
    screenX: 110, screenY: 10, width: 38, height: panel.lastPanelHeight,
  }), { handled: true, capture: true });
  assert.equal(panel.scrollTop, track.maxScrollTop, "clicking the scrollbar track jumps toward the end");
  panel.handleMouse({
    type: "drag", button: "left", x: track.scrollbarX, y: track.top,
    screenX: 110, screenY: 3, width: 38, height: panel.lastPanelHeight,
  });
  assert.equal(panel.scrollTop, 0, "dragging the thumb returns to the start");
  panel.handleMouse({
    type: "release", button: "left", x: track.scrollbarX, y: track.top,
    screenX: 110, screenY: 3, width: 38, height: panel.lastPanelHeight,
  });
  assert.equal(typeof panel.handleInput, "undefined", "keyboard navigation is left to the main editor");

  let resizedGeometry;
  const resizePanel = new GoalPanelComponent(state, theme, createDefaultPanelSlots().list(), {
    terminal: { rows: 50, columns: 120 }, requestRender: () => renders++,
  }, { width: 38, minWidth: 32, maxWidth: 80, rightMargin: 7, onGeometryChange: (geometry) => { resizedGeometry = geometry; } });
  resizePanel.render(38);
  const height = resizePanel.lastPanelHeight;
  assert.deepEqual(resizePanel.handleMouse({
    type: "press", button: "left", x: 1, y: height - 1, screenX: 60, screenY: 40, width: 38, height,
  }), { handled: true, capture: true });
  assert.deepEqual(resizePanel.handleMouse({
    type: "drag", button: "left", x: -4, y: height + 3, screenX: 55, screenY: 44, width: 38, height,
  }), { handled: true });
  assert.equal(resizePanel.panelWidth, 43, "dragging a left edge expands the window");
  assert.equal(resizePanel.panelHeight, 44, "dragging the bottom edge expands height up to the terminal limit");
  assert.deepEqual(resizedGeometry, { width: 43, height: 44, row: 0, col: 54, positioned: true });
  resizePanel.render(resizePanel.panelWidth);
  assert.equal(resizePanel.lastPanelHeight, 44);
  assert.deepEqual(resizePanel.handleMouse({
    type: "release", button: "left", x: -4, y: height + 3, screenX: 55, screenY: 44, width: 43, height: 44,
  }), { handled: true });

  resizePanel.render(43);
  resizePanel.handleMouse({
    type: "press", button: "left", x: 42, y: 10, screenX: 96, screenY: 10, width: 43, height: 44,
  });
  resizePanel.handleMouse({
    type: "drag", button: "left", x: 46, y: 10, screenX: 100, screenY: 10, width: 43, height: 44,
  });
  assert.equal(resizePanel.panelWidth, 47, "dragging the right edge changes width without moving the left edge");
  assert.equal(resizePanel.panelCol, 54);
  resizePanel.handleMouse({ type: "release", button: "left", x: 46, y: 10, screenX: 100, screenY: 10, width: 47, height: 44 });

  resizePanel.render(47);
  resizePanel.handleMouse({
    type: "press", button: "left", x: 20, y: 0, screenX: 74, screenY: 0, width: 47, height: 44,
  });
  resizePanel.handleMouse({
    type: "drag", button: "left", x: 20, y: 5, screenX: 74, screenY: 5, width: 47, height: 44,
  });
  assert.equal(resizePanel.panelHeight, 39, "dragging the top edge changes height while holding the bottom edge");
  assert.equal(resizePanel.panelRow, 5);
  resizePanel.handleMouse({ type: "release", button: "left", x: 20, y: 5, screenX: 74, screenY: 5, width: 47, height: 39 });

  let movedGeometry;
  const movePanel = new GoalPanelComponent(state, theme, createDefaultPanelSlots().list(), {
    terminal: { rows: 50, columns: 120 }, requestRender: () => renders++,
  }, { width: 38, onGeometryChange: (geometry) => { movedGeometry = geometry; } });
  movePanel.render(38);
  assert.deepEqual(movePanel.handleMouse({
    type: "press", button: "left", x: 18, y: 1, screenX: 68, screenY: 4, width: 38, height: movePanel.lastPanelHeight,
  }), { handled: true, capture: true });
  movePanel.handleMouse({
    type: "drag", button: "left", x: 26, y: 5, screenX: 76, screenY: 8, width: 38, height: movePanel.lastPanelHeight,
  });
  assert.deepEqual(movedGeometry, { width: 38, height: movePanel.lastPanelHeight, row: 7, col: 58, positioned: true });
  movePanel.handleMouse({
    type: "release", button: "left", x: 26, y: 5, screenX: 76, screenY: 8, width: 38, height: movePanel.lastPanelHeight,
  });
}

// Semantic theme colors distinguish status, verification markers, evidence, tabs, and section headings.
{
  const colors = [];
  const colorTheme = {
    fg: (color, text) => { colors.push(color); return text; },
    bold: (text) => text,
  };
  let state = reduceGoalCommand(emptyGoalState(), "set Theme colors test").state;
  state = reduceGoalCommand(state, "criterion pass is visible").state;
  state = reduceGoalCommand(state, "criterion failure is visible").state;
  state = reduceGoalCommand(state, "criterion uncertainty is visible").state;
  state = applyGoalAudit(state, { verdicts: [
    { criterion: 1, verdict: "pass", reason: "Proof exists.", evidence: ["proof.txt:1"] },
    { criterion: 2, verdict: "fail", reason: "Proof is missing.", evidence: ["proof.txt:2"] },
    { criterion: 3, verdict: "unknown", reason: "Not observable.", evidence: [] },
  ] }, 10);
  const panel = new GoalPanelComponent(state, colorTheme, createDefaultPanelSlots().list());
  panel.render(60);
  for (const color of ["accent", "success", "error", "warning", "muted", "borderAccent"]) {
    assert.ok(colors.includes(color), `expected semantic theme color ${color}`);
  }
}

// The sidebar uses the available height, keeps its border visible without a footer, and scrolls overflowing content at a narrow width.
{
  let state = reduceGoalCommand(emptyGoalState(), `set ${"長いゴール".repeat(30)}`).state;
  for (let i = 0; i < 12; i++) {
    state = reduceGoalCommand(state, `note ${"長い経緯".repeat(30)}`, i + 1).state;
  }
  const tui = { terminal: { rows: 52 } };
  const panel = new GoalPanelComponent(state, theme, createDefaultPanelSlots().list(), tui);
  const lines = panel.render(38);
  assert.equal(lines.length, Math.floor(52 * 0.82));
  assert.ok(lines.every((row) => row.startsWith("│") || row.startsWith("╭") || row.startsWith("╰")));
  assert.equal(lines.at(-1).startsWith("╰"), true, "the bottom border remains visible");
  assert.match(lines.join("\n"), /長いゴール/);
  assert.match(lines.join("\n"), /█/, "overflow should show a scrollbar thumb instead of an omission notice");
  assert.match(lines[1], /⠿/, "the top bar exposes a subtle move grip");
  assert.doesNotMatch(lines.join("\n"), /ホイール|ドラッグしてサイズ変更/, "the panel has no footer instructions");
}

console.log("PASS: fixed badge, themed draggable window, scrollable body, mouse-only panel controls, and keyboard passthrough");
