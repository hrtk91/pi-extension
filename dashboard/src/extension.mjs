/**
 * System Dashboard Extension
 *
 * Displays a custom footer with:
 * - Model name
 * - Context usage (input/output tokens)
 * - VRAM usage
 * - Git branch
 * - GPU temperature
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";
import { refreshHistoricalStats } from "./history-store.mjs";
import { calculateSessionStats, groupStatsByModel } from "./session-stats.mjs";
import { StatsTabsComponent } from "./stats-tabs.mjs";

// Cache for system stats to avoid polling too frequently
let _lastStatsTime = 0;
let _cachedStats = null;
const STATS_CACHE_MS = 2000;

function getSystemStats() {
 const now = Date.now();
 if (_cachedStats && (now - _lastStatsTime) < STATS_CACHE_MS) {
   return _cachedStats;
 }

 const stats = {
   vramUsed: "-",
   vramTotal: "-",
   gpuTemp: "-",
 };

 if (process.env.PISB !== "1") {
   try {
     // GPU: nvidia-smi (memory + temperature)
     const nv = execSync(
       'nvidia-smi --query-gpu=memory.total,memory.used,temperature.gpu --format=csv,noheader',
       { encoding: "utf-8" }
     ).trim();
     const parts = nv.split(",");
     stats.vramTotal = parts[0].trim();
     stats.vramUsed = parts[1].trim();
     stats.gpuTemp = parts[2].trim() + "°";
   } catch {
     stats.vramTotal = "-";
     stats.vramUsed = "-";
     stats.gpuTemp = "-";
   }
 }

 _cachedStats = stats;
 _lastStatsTime = now;
 return stats;
}

function fmtTokens(n) {
 if (n < 1000) return String(n);
 if (n < 1000000) return (n / 1000).toFixed(1) + "k";
 return (n / 1000000).toFixed(1) + "M";
}

const THINKING_LABELS = {
 off: "off",
 minimal: "min",
 low: "low",
 medium: "med",
 high: "high",
 xhigh: "xhigh",
 max: "max",
};

function getThinkingLabel(level) {
 return THINKING_LABELS[level] || level || "-";
}

function sessionTokPerSec(ctx) {
 try {
  const stats = calculateSessionStats(ctx.sessionManager.getBranch());
  return stats.measuredResponses > 0 ? stats : null;
 } catch {
  return null;
 }
}

export default function (pi) {
 let _ctxRef = null;
 let _footerHandle = null;

 pi.registerCommand("stats", {
  description: "Show historical response statistics by model",
  handler: async (_args, ctx) => {
   let report;
   ctx.ui.setWorkingMessage("過去のセッション統計を集計中…");
   try {
    const history = await refreshHistoricalStats({ currentSessionFile: ctx.sessionManager.getSessionFile() });
    report = { ...groupStatsByModel(history.samples), indexedFiles: history.indexedFiles };
   } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await ctx.ui.select(`セッション統計を取得できませんでした\n${reason}`, ["閉じる"]);
    return;
   } finally {
    ctx.ui.setWorkingMessage();
   }

   if (ctx.mode === "tui" && ctx.hasUI) {
    await ctx.ui.custom(
     (tui, theme, keybindings, done) => new StatsTabsComponent(
      tui, theme, keybindings, done, report, { truncateToWidth, visibleWidth },
     ),
     { overlay: true, overlayOptions: { width: 76, minWidth: 56, maxHeight: 16, margin: 1 } },
    );
    return;
   }

   const lines = [
    `全モデル: ${report.all.responses}応答 / ${report.all.sessions} sessions`,
    `出力token: ${fmtTokens(report.all.outputTokens)}`,
   ];
   if (report.all.responses > 0) {
    lines.push(
     `tok/s p50 ${report.all.p50.toFixed(0)} / p90 ${report.all.p90.toFixed(0)}`,
     `平均応答時間 ${(report.all.averageDurationMs / 1000).toFixed(2)}秒`,
    );
   }
   for (const model of report.models) {
    lines.push(`${model.key}: n=${model.stats.responses}, p50 ${model.stats.p50.toFixed(0)}, p90 ${model.stats.p90.toFixed(0)}`);
   }
   lines.push(`索引済みsession files: ${report.indexedFiles}`, "TUIでは←/→またはTabでモデルを切り替えられます。");
   await ctx.ui.select(lines.join("\n"), ["閉じる"]);
  },
 });

 pi.on("session_start", async (_event, ctx) => {
  _ctxRef = ctx;

  // Also set a status indicator
  ctx.ui.setStatus("dashboard", ctx.ui.theme.fg("muted", " 📊 Dashboard"));

  // Create custom footer
  ctx.ui.setFooter((tui, theme, footerData) => {
    let branchUnsub = null;
    try {
      branchUnsub = footerData.onBranchChange(() => tui.requestRender());
    } catch {}

    return {
      invalidate() {},
      dispose: branchUnsub,
      render(width) {
        if (!_ctxRef) {
          return [" - "];
        }

        const modelId = _ctxRef.model?.id || "-";

        // Git branch
        const branch = footerData.getGitBranch();
        const branchStr = branch ? ` 🌿 ${branch}` : "";

        // Token stats
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheTokens = 0;
        let latestCacheHitRate = null;
        try {
          for (const e of _ctxRef.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const usage = e.message.usage;
              if (usage) {
                inputTokens += usage.input || 0;
                outputTokens += usage.output || 0;
                cacheTokens += (usage.cacheRead || 0) + (usage.cacheWrite || 0);
                const promptTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
                if (promptTokens > 0) latestCacheHitRate = ((usage.cacheRead || 0) / promptTokens) * 100;
              }
            }
          }
        } catch {
          // branch may not be accessible yet
        }

        // System stats (cached)
        const sys = getSystemStats();

        // Thinking level
        const thinkingLevel = pi.getThinkingLevel();
        const thinkingLabel = getThinkingLabel(thinkingLevel);

        // Context usage (tokens currently in context window)
        let contextStr = "";
        try {
          const usage = _ctxRef.getContextUsage();
          if (usage && usage.tokens !== null) {
            const remaining = usage.contextWindow - usage.tokens;
            const pct = usage.percent ?? 0;
            contextStr = ` ctx ${pct.toFixed(0)}% (${fmtTokens(remaining)}残)`;
          }
        } catch {
          // getContextUsage may not be available
        }

        const tok = sessionTokPerSec(_ctxRef);
        const sep = theme.fg("dim", " | ");
        const parts = [
          theme.fg("accent", modelId) + theme.fg("muted", ` [${thinkingLabel}]`),
          theme.fg("muted", `↑${fmtTokens(inputTokens)} ↓${fmtTokens(outputTokens)}`),
        ];
        if (tok) {
          parts.push(
            theme.fg("warning", `tok/s p50 ${tok.p50.toFixed(0)} p90 ${tok.p90.toFixed(0)}`),
          );
        }
        if (cacheTokens > 0 && latestCacheHitRate !== null) {
          const chColor = latestCacheHitRate < 80 ? "warning" : "dim";
          parts.push(theme.fg(chColor, `CH ${latestCacheHitRate.toFixed(0)}%`));
        }
        if (contextStr) parts.push(theme.fg("muted", contextStr.trim()));

        const left = " " + parts.join(sep);

        const rightItems = [];
        if (branchStr) rightItems.push(theme.fg("accent", branchStr));
        if (sys.vramUsed !== "-" || sys.vramTotal !== "-") rightItems.push(` 🎮 ${sys.vramUsed} / ${sys.vramTotal}`);
        if (sys.gpuTemp !== "-") rightItems.push(`🌡 ${sys.gpuTemp}`);
        const right = rightItems.join(" ");

        // Pad between left and right
        const leftWidth = visibleWidth(left);
        const rightWidth = visibleWidth(right);
        const pad = " ".repeat(Math.max(1, width - leftWidth - rightWidth));

        return [truncateToWidth(left + pad + right, width)];
      },
    };
  });
});

pi.on("session_end", async (_event, ctx) => {
  ctx.ui.setFooter(undefined);
  ctx.ui.setStatus("dashboard", undefined);
});
}
