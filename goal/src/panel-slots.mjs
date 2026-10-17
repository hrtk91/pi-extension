function timeLabel(timestamp) {
  if (!timestamp) return "--:--";
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "--:--";
  }
}

function statusLabel(state) {
  if (state.status === "complete") {
    if (state.criteria.every((item) => item.completionSource === "checker")) return "完了 (監査済み)";
    if (state.criteria.every((item) => item.completionSource === "manual")) return "完了 (手動記録)";
    return "完了 (監査・手動)";
  }
  return ({ idle: "未設定", active: "作業中", blocked: "ブロック中" })[state.status] ?? "不明";
}

function verificationLabel(status) {
  return ({ passed: "合格", failed: "未達", unknown: "判断不能", unchecked: "未監査" })[status] ?? "未監査";
}

export class PanelSlotRegistry {
  #slots = new Map();

  register(slot) {
    if (!slot || typeof slot.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(slot.id)) {
      throw new TypeError("Panel slot id must match [a-z][a-z0-9-]*");
    }
    if (this.#slots.has(slot.id)) throw new Error(`Panel slot already registered: ${slot.id}`);
    if (typeof slot.title !== "string" || !slot.title.trim()) throw new TypeError("Panel slot title is required");
    if (typeof slot.icon !== "string" || !slot.icon) throw new TypeError("Panel slot icon is required");
    if (!Number.isFinite(slot.order)) throw new TypeError("Panel slot order must be a number");
    if (typeof slot.render !== "function") throw new TypeError("Panel slot render must be a function");
    if (slot.styleLine !== undefined && typeof slot.styleLine !== "function") throw new TypeError("Panel slot styleLine must be a function");

    const registered = Object.freeze({ ...slot, title: slot.title.trim() });
    this.#slots.set(slot.id, registered);
    return () => this.#slots.delete(slot.id);
  }

  list() {
    return [...this.#slots.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }
}

export function createDefaultPanelSlots() {
  const registry = new PanelSlotRegistry();
  registry.register({
    id: "goal",
    title: "ゴール",
    icon: "🎯",
    order: 10,
    render(state) {
      const completeCount = state.criteria.filter((item) => item.complete).length;
      const lines = [
        `現在のゴール: ${state.goal ?? "未設定"}`,
        `状態: ${statusLabel(state)}`,
        `完了条件: ${completeCount}/${state.criteria.length}`,
      ];
      if (state.criteria.length === 0) {
        lines.push("  条件はまだありません · /goal criterion <条件>");
      } else {
        for (const [index, item] of state.criteria.entries()) {
          const verification = item.verification?.status ?? "unchecked";
          const marker = verification === "failed" ? "✗" : verification === "unknown" ? "?" : item.complete ? "✓" : "○";
          const source = item.completionSource === "manual" ? " [手動]" : "";
          lines.push(`  ${marker} ${index + 1}. ${item.text}${source}`);
          if (verification !== "unchecked") {
            lines.push(`    監査: ${verificationLabel(verification)} — ${item.verification.reason}`);
            for (const evidence of item.verification.evidence.slice(0, 2)) lines.push(`    根拠: ${evidence}`);
          }
        }
      }
      lines.push("", "これまでの経緯");
      const history = state.history.slice(-4);
      if (history.length === 0) lines.push("  まだ記録はありません");
      for (const item of history) lines.push(`  ${timeLabel(item.at)} [${item.type}] ${item.text}`);
      if (state.history.length > history.length) lines.push(`  …ほか ${state.history.length - history.length} 件`);
      lines.push("", "GoalCheckerは根拠を監査し、handoffはメモのみ記録します。");
      return lines;
    },
    styleLine(line, state) {
      if (line.startsWith("現在のゴール:")) return { color: "accent", bold: true };
      if (line.startsWith("状態:")) {
        const color = ({ complete: "success", blocked: "warning", active: "accent", idle: "muted" })[state.status] ?? "muted";
        return { color, bold: true };
      }
      if (line.startsWith("完了条件:")) return { color: "accent", bold: true };
      if (/^\s*✓\s/.test(line)) return { color: "success", bold: true };
      if (/^\s*✗\s/.test(line)) return { color: "error", bold: true };
      if (/^\s*\?\s/.test(line)) return { color: "warning", bold: true };
      if (/^\s*○\s/.test(line)) return { color: "muted" };
      if (line.startsWith("    監査:")) {
        if (line.includes("合格")) return { color: "success" };
        if (line.includes("未達")) return { color: "error" };
        if (line.includes("判断不能")) return { color: "warning" };
        return { color: "muted" };
      }
      if (line.startsWith("    根拠:") || line.startsWith("GoalCheckerは") || line.startsWith("  条件は") || line.startsWith("  …ほか")) {
        return { color: "muted" };
      }
      if (line === "これまでの経緯") return { color: "accent", bold: true };
      if (/^\s*\d{2}:\d{2} \[/.test(line)) return { color: "muted" };
      return undefined;
    },
  });
  registry.register({
    id: "usage",
    title: "利用統計",
    icon: "📊",
    order: 20,
    render() {
      return [
        "利用統計スロットのサンプルです。",
        "ここにトークン数、実行時間、モデル使用量などを表示できます。",
        "",
        "このタブは拡張ポイントの動作確認用で、まだ実データには接続していません。",
      ];
    },
  });
  return registry;
}
