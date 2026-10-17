const BADGE_WIDTH = 7;
const BADGE_RIGHT_MARGIN = 1;
const BADGE_TOP_MARGIN = 1;
const PANEL_TOP_MARGIN = 3;
export const GOAL_PANEL_DEFAULT_WIDTH = 38;
export const GOAL_PANEL_MIN_WIDTH = 32;
export const GOAL_PANEL_MAX_WIDTH = 80;

/** Place the panel's toggle glyph exactly where the closed-state badge appears. */
export function createGoalOverlayOptions(panelWidth = GOAL_PANEL_DEFAULT_WIDTH) {
  const panelRightMargin = BADGE_RIGHT_MARGIN + BADGE_WIDTH - 1;
  const boundedPanelWidth = Math.max(GOAL_PANEL_MIN_WIDTH, Math.min(GOAL_PANEL_MAX_WIDTH, Math.floor(panelWidth)));
  return {
    badge: {
      anchor: "top-right",
      width: BADGE_WIDTH,
      maxHeight: 1,
      margin: { top: BADGE_TOP_MARGIN, right: BADGE_RIGHT_MARGIN },
      nonCapturing: true,
    },
    panel: {
      anchor: "top-right",
      nonCapturing: true,
      width: boundedPanelWidth,
      minWidth: GOAL_PANEL_MIN_WIDTH,
      maxHeight: "88%",
      margin: { top: PANEL_TOP_MARGIN, right: panelRightMargin },
    },
  };
}
