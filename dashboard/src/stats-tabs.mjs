function plainVisibleWidth(text) {
  return [...text.replace(/\u001b\[[0-9;]*m/g, "")].length;
}

function plainTruncate(text, width) {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, "");
  return [...clean].slice(0, Math.max(0, width)).join("");
}

function formatTokens(value) {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function fg(theme, color, text) {
  return theme?.fg ? theme.fg(color, text) : text;
}

export class StatsTabsComponent {
  constructor(tui, theme, keybindings, done, report, textTools = {}) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.report = report;
    this.truncateToWidth = textTools.truncateToWidth ?? plainTruncate;
    this.visibleWidth = textTools.visibleWidth ?? plainVisibleWidth;
    this.tabs = [
      { key: "all", label: "全モデル", stats: report.all },
      ...report.models.map(({ key, stats }) => ({ key, label: key, stats })),
    ];
    this.selectedIndex = 0;
  }

  handleInput(data) {
    if (this.keybindings?.matches?.(data, "tui.select.cancel") || data === "q") {
      this.done(undefined);
      return;
    }
    const next = data === "\t" || data === "\u001b[C" || data === "l" || data === "n";
    const previous = data === "\u001b[Z" || data === "\u001b[D" || data === "h" || data === "p";
    if (!next && !previous) return;
    const delta = next ? 1 : -1;
    this.selectedIndex = (this.selectedIndex + delta + this.tabs.length) % this.tabs.length;
    this.tui?.requestRender?.();
  }

  renderTabs(width) {
    const previous = this.selectedIndex > 0 ? this.tabs[this.selectedIndex - 1].label : null;
    const current = this.tabs[this.selectedIndex].label;
    const next = this.selectedIndex + 1 < this.tabs.length ? this.tabs[this.selectedIndex + 1].label : null;
    const activeWidth = Math.max(8, Math.min(30, width - (previous ? 14 : 0) - (next ? 14 : 0) - 5));
    const parts = [];
    if (previous) parts.push(fg(this.theme, "muted", `‹ ${this.truncateToWidth(previous, 12)} `));
    parts.push(fg(this.theme, "accent", `[${this.truncateToWidth(current, activeWidth)}]`));
    if (next) parts.push(fg(this.theme, "muted", ` ${this.truncateToWidth(next, 12)} ›`));
    const line = parts.join("");
    return this.visibleWidth(line) > width ? this.truncateToWidth(line, width) : line;
  }

  render(width) {
    const selected = this.tabs[this.selectedIndex];
    const stats = selected.stats;
    const lines = [
      fg(this.theme, "accent", "セッション応答統計"),
      this.renderTabs(width),
      "",
      `応答数: ${stats.responses}`,
      `セッション数: ${stats.sessions}`,
      `出力token: ${formatTokens(stats.outputTokens)}`,
    ];
    if (stats.responses > 0) {
      lines.push(
        `tok/s p50: ${stats.p50.toFixed(0)}    p90: ${stats.p90.toFixed(0)}`,
        `平均応答時間: ${(stats.averageDurationMs / 1000).toFixed(2)}秒`,
        `合算応答速度: ${stats.combinedTokPerSec.toFixed(0)} tok/s`,
      );
    } else {
      lines.push("durationMs付きの応答がありません。");
    }
    lines.push(
      "",
      fg(this.theme, "dim", "←/→ または Tab: モデル切替  •  Esc: 閉じる"),
      fg(this.theme, "dim", `索引済みsession files: ${this.report.indexedFiles}`),
    );
    return lines.map((line) => this.visibleWidth(line) > width ? this.truncateToWidth(line, width) : line);
  }

  invalidate() {}
  dispose() {}
}
