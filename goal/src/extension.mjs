import { Type } from "typebox";
import { applyGoalAudit, emptyGoalState, normalizeGoalState, reduceGoalCommand, recordGoalEvent } from "./goal-state.mjs";
import {
  buildGoalTrackingInstructions,
  formatGoalAuditSummary,
  parseGoalCheckerReport,
  runReadOnlyGoalChecker,
} from "./goal-checker.mjs";
import { createDefaultPanelSlots } from "./panel-slots.mjs";
import { GoalBadgeComponent, GoalPanelComponent } from "./goal-ui.mjs";
import { createGoalOverlayOptions } from "./panel-layout.mjs";

const STATE_ENTRY = "pi-goal-state";

function readState(ctx) {
  const branch = ctx.sessionManager?.getBranch?.() ?? [];
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "custom" && entry.customType === STATE_ENTRY) {
      return normalizeGoalState(entry.data);
    }
  }
  return emptyGoalState();
}

function copyState(state) {
  state = normalizeGoalState(state);
  return {
    ...state,
    criteria: state.criteria.map((item) => {
      const verification = item.verification ?? { status: "unchecked", reason: "", evidence: [], checkedAt: 0 };
      return {
        ...item,
        verification: { ...verification, evidence: [...(verification.evidence ?? [])] },
      };
    }),
    history: state.history.map((item) => ({ ...item })),
  };
}

function collectRecentToolEvidence(ctx) {
  const branch = ctx.sessionManager?.getBranch?.() ?? [];
  const testCommands = new Map();
  const evidence = [];
  const isTestCommand = (value) => /^(?:npm\s+test|pnpm\s+test|yarn\s+test|node\s+--test(?:\s+[\w./*-]+)*|pytest(?:\s+[\w./=-]+)*|cargo\s+test(?:\s+[\w./=-]+)*|go\s+test(?:\s+[\w./-]+)*)$/.test(String(value ?? "").trim());
  for (const entry of branch.slice(-60)) {
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role === "assistant") {
      for (const part of message.content ?? []) {
        if (part?.type !== "toolCall" || part.name !== "bash") continue;
        const command = part.arguments?.command;
        if (isTestCommand(command)) testCommands.set(part.id, command);
      }
      continue;
    }
    if (message?.role !== "toolResult" || message.toolName !== "bash" || !testCommands.has(message.toolCallId)) continue;
    const text = Array.isArray(message.content)
      ? message.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n")
      : "";
    if (text.trim()) evidence.push(`${testCommands.get(message.toolCallId)} output (tail): ${text.slice(-1_200)}`);
  }
  return evidence.slice(-6);
}

function sameGoalDefinition(left, right) {
  return left.goal === right.goal && left.criteria.length === right.criteria.length &&
    left.criteria.every((item, index) => item.text === right.criteria[index].text);
}

function unknownReport(criteria, reason) {
  return {
    verdicts: criteria.map((_item, index) => ({
      criterion: index + 1,
      verdict: "unknown",
      reason: String(reason || "Checker could not complete the review.").slice(0, 600),
      evidence: [],
    })),
  };
}

export default function goalExtension(pi) {
  let state = emptyGoalState();
  let activeContext;
  let badgeComponent;
  let badgeStarted = false;
  let panelOpen = false;
  let closePanel;
  let panelOverlayHandle;
  let auditRunning = false;
  let panelComponent;
  const slots = createDefaultPanelSlots();
  const overlayOptions = createGoalOverlayOptions();
  let panelGeometry = {
    width: overlayOptions.panel.width,
    height: undefined,
    row: undefined,
    col: undefined,
    positioned: false,
  };

  function getPanelOverlayOptions(geometry) {
    const options = { ...overlayOptions.panel, width: geometry.width };
    if (geometry.positioned) {
      options.row = geometry.row;
      options.col = geometry.col;
      options.margin = 0;
    }
    return options;
  }

  async function openPanel(ctx = activeContext) {
    if (!ctx?.hasUI || ctx.mode !== "tui" || panelOpen) return;
    panelOpen = true;
    badgeComponent?.setPanelOpen(true);
    try {
      await ctx.ui.custom(
        (tui, theme, _keybindings, done) => {
          closePanel = () => done(undefined);
          panelComponent = new GoalPanelComponent(
            copyState(state),
            theme,
            slots.list(),
            tui,
            {
              ...panelGeometry,
              minWidth: overlayOptions.panel.minWidth,
              maxWidth: 80,
              rightMargin: overlayOptions.panel.margin.right,
              onGeometryChange: (geometry) => {
                panelGeometry = { ...geometry };
                if (!panelComponent) return;
                panelOverlayHandle?.hide();
                panelOverlayHandle = tui.showOverlay(panelComponent, getPanelOverlayOptions(panelGeometry));
              },
            },
          );
          return panelComponent;
        },
        {
          overlay: true,
          overlayOptions: getPanelOverlayOptions(panelGeometry),
          onHandle: (handle) => { panelOverlayHandle = handle; },
        },
      );
    } finally {
      if (panelComponent) {
        panelGeometry = {
          width: panelComponent.panelWidth,
          height: panelComponent.panelHeight,
          row: panelComponent.panelRow,
          col: panelComponent.panelCol,
          positioned: panelComponent.panelPositioned,
        };
      }
      panelOverlayHandle?.hide();
      panelOverlayHandle = undefined;
      panelOpen = false;
      closePanel = undefined;
      panelComponent = undefined;
      badgeComponent?.setPanelOpen(false);
    }
  }

  function togglePanel(ctx = activeContext) {
    if (panelOpen) {
      const close = closePanel;
      closePanel = undefined;
      close?.();
      return;
    }
    void openPanel(ctx);
  }

  function updateBadge(ctx) {
    activeContext = ctx;
    if (!ctx.hasUI || ctx.mode !== "tui" || badgeStarted) return;
    badgeStarted = true;
    void ctx.ui.custom(
      (tui, theme, _keybindings, done) => {
        badgeComponent = new GoalBadgeComponent(theme, () => togglePanel(), tui, panelOpen);
        return badgeComponent;
      },
      {
        overlay: true,
        overlayOptions: overlayOptions.badge,
      },
    ).catch((error) => {
      badgeStarted = false;
      badgeComponent = undefined;
      ctx.ui.notify(`ゴールアイコンを表示できませんでした: ${error instanceof Error ? error.message : String(error)}`, "warning");
    });
  }

  function restore(ctx) {
    state = readState(ctx);
    updateBadge(ctx);
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("before_agent_start", (event) => {
    const instructions = buildGoalTrackingInstructions(state);
    if (!instructions) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
  });

  pi.registerTool({
    name: "goal_audit",
    label: "Goal audit",
    description: "Ask an independent read-only reviewer to inspect the current goal criteria and project artifacts. Call after reflecting on progress and collecting relevant evidence; only checker passes mark criteria complete.",
    parameters: Type.Object({
      summary: Type.String({ description: "Your brief self-reflection on progress and why the goal is ready for review.", maxLength: 2_000 }),
      evidence: Type.Optional(Type.Array(Type.String({ description: "Relevant test output, artifact paths, or other evidence to guide review." }), { maxItems: 6 })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (auditRunning) {
        return { content: [{ type: "text", text: "A goal audit is already running. Wait for its result before requesting another." }] };
      }
      const snapshot = readState(ctx);
      if (!snapshot.goal) {
        return { content: [{ type: "text", text: "No active goal to audit." }], isError: true };
      }
      if (snapshot.criteria.length === 0) {
        return { content: [{ type: "text", text: "The goal has no completion criteria, so it cannot be audited." }], isError: true };
      }

      auditRunning = true;
      try {
        let rawReport;
        try {
          rawReport = await runReadOnlyGoalChecker({
            exec: (command, args, options) => pi.exec(command, args, options),
            cwd: ctx.cwd,
            model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
            thinkingLevel: ctx.thinkingLevel,
            state: snapshot,
            workerSummary: params.summary,
            workerEvidence: params.evidence ?? [],
            sessionEvidence: collectRecentToolEvidence(ctx),
            signal,
          });
        } catch (error) {
          const current = readState(ctx);
          if (!sameGoalDefinition(snapshot, current)) {
            return { content: [{ type: "text", text: "The goal or criteria changed while the audit was running; the stale result was discarded." }] };
          }
          const report = unknownReport(snapshot.criteria, `Checker unavailable: ${error instanceof Error ? error.message : String(error)}`);
          state = recordGoalEvent(current, "audit-error", `監査を実行できませんでした: ${error instanceof Error ? error.message : String(error)}`);
          pi.appendEntry(STATE_ENTRY, copyState(state));
          if (panelComponent) {
            panelComponent.state = copyState(state);
            panelComponent.tui?.requestRender();
          }
          const text = formatGoalAuditSummary(report);
          return { content: [{ type: "text", text: `${text}\nExisting criterion statuses were left unchanged because the checker could not run.` }], details: { verdicts: report.verdicts } };
        }

        const report = parseGoalCheckerReport(rawReport, snapshot.criteria);
        const current = readState(ctx);
        if (!sameGoalDefinition(snapshot, current)) {
          return { content: [{ type: "text", text: "The goal or criteria changed while the audit was running; the stale result was discarded." }] };
        }
        state = applyGoalAudit(current, report, Date.now(), params.summary);
        pi.appendEntry(STATE_ENTRY, copyState(state));
        if (panelComponent) {
          panelComponent.state = copyState(state);
          panelComponent.tui?.requestRender();
        }
        return { content: [{ type: "text", text: formatGoalAuditSummary(report) }], details: { verdicts: report.verdicts, goalStatus: state.status } };
      } finally {
        auditRunning = false;
      }
    },
  });

  pi.registerCommand("goal", {
    description: "Set and inspect the current session goal",
    handler: async (args, ctx) => {
      const outcome = reduceGoalCommand(state, args);
      if (outcome.kind === "show") {
        togglePanel(ctx);
        return;
      }
      if (outcome.kind === "help" || outcome.kind === "error") {
        ctx.ui.notify(outcome.message, outcome.kind === "error" ? "warning" : "info");
        return;
      }
      state = outcome.state;
      pi.appendEntry(STATE_ENTRY, copyState(state));
      updateBadge(ctx);
      ctx.ui.notify(outcome.message, "info");
    },
  });
}
