function codePointWidth(char) {
  const cp = char.codePointAt(0);
  if (cp === undefined || /\p{Mark}/u.test(char) || cp === 0x200d || cp === 0xfe0f) return 0;
  if (
    cp >= 0x1100 && (
      cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f1e6 && cp <= 0x1f1ff) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    )
  ) return 2;
  return 1;
}

function cellWidth(text) {
  return Array.from(String(text)).reduce((sum, char) => sum + codePointWidth(char), 0);
}

function truncateCells(text, width) {
  const target = Math.max(0, width);
  if (cellWidth(text) <= target) return text;
  if (target === 0) return "";
  let output = "";
  let used = 0;
  for (const char of Array.from(String(text))) {
    const next = codePointWidth(char);
    if (used + next > target - 1) break;
    output += char;
    used += next;
  }
  return `${output}…`;
}

function wrapCells(text, width) {
  const limit = Math.max(1, width);
  const lines = [];
  let line = "";
  let used = 0;
  for (const char of Array.from(String(text))) {
    const next = codePointWidth(char);
    if (used + next > limit && line) {
      lines.push(line);
      line = "";
      used = 0;
    }
    line += char;
    used += next;
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

function padCells(text, width) {
  return text + " ".repeat(Math.max(0, width - cellWidth(text)));
}

function border(theme, text, color = "border") {
  return theme?.fg ? theme.fg(color, text) : text;
}

function applyStyle(theme, text, style) {
  let output = text;
  if (style?.bold && theme?.bold) output = theme.bold(output);
  if (style?.color && theme?.fg) output = theme.fg(style.color, output);
  return output;
}

function clipSegments(segments, width) {
  const normalized = segments.filter((segment) => segment?.text).map((segment) => ({
    text: String(segment.text),
    style: segment.style,
  }));
  const fullWidth = normalized.reduce((sum, segment) => sum + cellWidth(segment.text), 0);
  if (fullWidth <= width) return normalized;
  if (width <= 0) return [];

  const result = [];
  const limit = Math.max(0, width - 1);
  let used = 0;
  for (const segment of normalized) {
    const chars = Array.from(segment.text);
    let text = "";
    let index = 0;
    for (; index < chars.length; index++) {
      const char = chars[index];
      const next = codePointWidth(char);
      if (used + next > limit) break;
      text += char;
      used += next;
    }
    if (text) result.push({ text, style: segment.style });
    if (index < chars.length) break;
  }
  result.push({ text: "…", style: { color: "muted" } });
  return result;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export class GoalBadgeComponent {
  constructor(theme, onToggle, tui, panelOpen = false) {
    this.theme = theme;
    this.onToggle = onToggle;
    this.tui = tui;
    this.panelOpen = panelOpen;
  }

  setPanelOpen(panelOpen) {
    if (this.panelOpen === panelOpen) return;
    this.panelOpen = panelOpen;
    this.tui?.requestRender();
  }

  render(width) {
    const icon = this.panelOpen ? "◉" : "○";
    const content = truncateCells(icon, Math.max(1, width));
    return [this.theme?.fg ? this.theme.fg("accent", content) : content];
  }

  handleMouse(event) {
    if (event.button !== "left") return undefined;
    if (event.type === "press") return { handled: true };
    if (event.type === "click") {
      this.onToggle();
      return { handled: true };
    }
    return undefined;
  }

  invalidate() {}
  dispose() {}
}

export class GoalPanelComponent {
  constructor(state, theme, slots, tui, resizeOptions = {}) {
    this.state = state;
    this.theme = theme;
    this.slots = slots;
    this.tui = tui;
    this.activeIndex = 0;
    this.panelWidth = Math.max(1, Math.floor(resizeOptions.width ?? 38));
    this.panelHeight = Number.isFinite(resizeOptions.height) ? Math.floor(resizeOptions.height) : undefined;
    this.panelRow = Number.isFinite(resizeOptions.row) ? Math.floor(resizeOptions.row) : undefined;
    this.panelCol = Number.isFinite(resizeOptions.col) ? Math.floor(resizeOptions.col) : undefined;
    this.panelPositioned = resizeOptions.positioned === true;
    this.minPanelWidth = Math.max(1, Math.floor(resizeOptions.minWidth ?? 32));
    this.maxPanelWidth = Math.max(this.minPanelWidth, Math.floor(resizeOptions.maxWidth ?? 80));
    this.panelRightMargin = Math.max(0, Math.floor(resizeOptions.rightMargin ?? 0));
    this.onGeometryChange = resizeOptions.onGeometryChange;
    this.scrollTop = 0;
    this.bodyLayout = undefined;
    this.windowDrag = undefined;
    this.scrollDrag = undefined;
    this.lastPanelHeight = 0;
    this.tabHitRanges = [];
    this.leftArrowRange = undefined;
    this.rightArrowRange = undefined;
  }

  select(index) {
    if (!this.slots.length) return;
    this.activeIndex = (index + this.slots.length) % this.slots.length;
    this.scrollTop = 0;
    this.tui?.requestRender();
  }

  scrollBy(amount) {
    const maximum = this.bodyLayout?.maxScrollTop ?? 0;
    const next = clamp(this.scrollTop + Math.trunc(amount), 0, maximum);
    if (next === this.scrollTop) return;
    this.scrollTop = next;
    this.tui?.requestRender();
  }

  resizeLimits() {
    const columns = this.tui?.terminal?.columns;
    const rightMargin = this.panelPositioned ? 0 : this.panelRightMargin;
    const availableWidth = Number.isFinite(columns) ? columns - rightMargin : this.maxPanelWidth;
    const maxWidth = Math.max(this.minPanelWidth, Math.min(this.maxPanelWidth, availableWidth));
    const rows = this.tui?.terminal?.rows;
    const maxHeight = Number.isFinite(rows) && rows > 0 ? Math.max(8, Math.floor(rows * 0.88)) : 60;
    return { maxWidth, minHeight: Math.min(10, maxHeight), maxHeight };
  }

  resizeEdges(event) {
    return {
      left: event.x <= 1,
      right: event.x >= event.width - 2,
      top: event.y === 0,
      bottom: event.y >= event.height - 1,
    };
  }

  updateWindowDrag(event) {
    const drag = this.windowDrag;
    if (!drag) return;
    const deltaX = event.screenX - drag.screenX;
    const deltaY = event.screenY - drag.screenY;
    const columns = this.tui?.terminal?.columns ?? 120;
    const rows = this.tui?.terminal?.rows ?? 60;
    let left = drag.left;
    let top = drag.top;
    let width = drag.width;
    let height = drag.height;

    if (drag.kind === "move") {
      left = clamp(drag.left + deltaX, 0, Math.max(0, columns - width));
      top = clamp(drag.top + deltaY, 0, Math.max(0, rows - height));
    } else {
      const { maxWidth, minHeight, maxHeight } = this.resizeLimits();
      if (drag.edges.left) {
        width = clamp(drag.width - deltaX, this.minPanelWidth, maxWidth);
        left = drag.left + drag.width - width;
      } else if (drag.edges.right) {
        width = clamp(drag.width + deltaX, this.minPanelWidth, maxWidth);
      }
      if (drag.edges.top) {
        height = clamp(drag.height - deltaY, minHeight, maxHeight);
        top = drag.top + drag.height - height;
      } else if (drag.edges.bottom) {
        height = clamp(drag.height + deltaY, minHeight, maxHeight);
      }
      left = clamp(left, 0, Math.max(0, columns - width));
      top = clamp(top, 0, Math.max(0, rows - height));
    }

    const changed = width !== this.panelWidth || height !== this.panelHeight || left !== this.panelCol || top !== this.panelRow || !this.panelPositioned;
    this.panelWidth = width;
    this.panelHeight = height;
    this.panelCol = left;
    this.panelRow = top;
    this.panelPositioned = true;
    if (changed) this.onGeometryChange?.({
      width: this.panelWidth,
      height: this.panelHeight,
      row: this.panelRow,
      col: this.panelCol,
      positioned: this.panelPositioned,
    });
    this.tui?.requestRender();
  }

  setScrollFromPointer(y, grabOffset = 0) {
    const layout = this.bodyLayout;
    if (!layout || layout.maxScrollTop <= 0 || layout.viewportHeight <= 0) return;
    const trackTravel = Math.max(0, layout.viewportHeight - layout.thumbHeight);
    const thumbTop = clamp(y - layout.top - grabOffset, 0, trackTravel);
    const next = trackTravel === 0 ? 0 : Math.round(thumbTop / trackTravel * layout.maxScrollTop);
    if (next === this.scrollTop) return;
    this.scrollTop = next;
    this.tui?.requestRender();
  }

  handleMouse(event) {
    if (this.windowDrag) {
      if (event.type === "drag") {
        this.updateWindowDrag(event);
        return { handled: true };
      }
      if (event.type === "release") {
        this.windowDrag = undefined;
        return { handled: true };
      }
      if (event.type === "click") this.windowDrag = undefined;
    }

    if (this.scrollDrag) {
      if (event.type === "drag") {
        this.setScrollFromPointer(event.y, this.scrollDrag.grabOffset);
        return { handled: true };
      }
      if (event.type === "release") {
        this.scrollDrag = undefined;
        return { handled: true };
      }
    }

    if (event.type === "wheel") {
      const layout = this.bodyLayout;
      if (layout && event.y >= layout.top && event.y < layout.top + layout.viewportHeight) {
        this.scrollBy(event.wheelDelta ?? 0);
        return { handled: true };
      }
      return undefined;
    }

    if (event.type === "press" && event.button === "left") {
      const edges = this.resizeEdges(event);
      if (edges.left || edges.right || edges.top || edges.bottom) {
        this.windowDrag = {
          kind: "resize",
          edges,
          screenX: event.screenX,
          screenY: event.screenY,
          left: event.screenX - event.x,
          top: event.screenY - event.y,
          width: event.width,
          height: event.height,
        };
        return { handled: true, capture: true };
      }
      if (event.y === 1) {
        this.windowDrag = {
          kind: "move",
          screenX: event.screenX,
          screenY: event.screenY,
          left: event.screenX - event.x,
          top: event.screenY - event.y,
          width: event.width,
          height: event.height,
        };
        return { handled: true, capture: true };
      }
      if (this.bodyLayout?.maxScrollTop > 0 && event.x === this.bodyLayout.scrollbarX) {
        const thumbTop = this.bodyLayout.top + this.bodyLayout.thumbTop;
        const onThumb = event.y >= thumbTop && event.y < thumbTop + this.bodyLayout.thumbHeight;
        this.scrollDrag = { grabOffset: onThumb ? event.y - thumbTop : Math.floor(this.bodyLayout.thumbHeight / 2) };
        this.setScrollFromPointer(event.y, this.scrollDrag.grabOffset);
        return { handled: true, capture: true };
      }
      return { handled: true };
    }

    if (event.button !== "left" || event.type !== "click") return undefined;
    if (event.y === 1) {
      if (this.leftArrowRange && event.x >= this.leftArrowRange.start && event.x < this.leftArrowRange.end) {
        this.select(this.activeIndex - 1);
        return { handled: true };
      }
      if (this.rightArrowRange && event.x >= this.rightArrowRange.start && event.x < this.rightArrowRange.end) {
        this.select(this.activeIndex + 1);
        return { handled: true };
      }
      const hit = this.tabHitRanges.find((range) => event.x >= range.start && event.x < range.end);
      if (hit) {
        this.select(hit.index);
        return { handled: true };
      }
    }
    return undefined;
  }

  render(width) {
    const resizeLimits = this.resizeLimits();
    const outerWidth = Math.max(28, Math.floor(width));
    const innerWidth = outerWidth - 2;
    const contentWidth = innerWidth - 2;
    const bodyWidth = Math.max(1, contentWidth - 1);
    const lines = [border(this.theme, `╭${"─".repeat(innerWidth)}╮`, "borderAccent")];
    const addRow = (content, style) => {
      const clipped = truncateCells(content, contentWidth);
      const padded = padCells(clipped, contentWidth);
      lines.push(`${border(this.theme, "│")} ${applyStyle(this.theme, padded, style)} ${border(this.theme, "│")}`);
    };
    const addSegmentRow = (segments) => {
      const clipped = clipSegments(segments, contentWidth);
      const visibleWidth = clipped.reduce((sum, segment) => sum + cellWidth(segment.text), 0);
      const styled = clipped.map((segment) => applyStyle(this.theme, segment.text, segment.style)).join("");
      lines.push(`${border(this.theme, "│")} ${styled}${" ".repeat(Math.max(0, contentWidth - visibleWidth))} ${border(this.theme, "│")}`);
    };

    const tabs = [];
    const tabSegments = [{ text: "‹ ", style: { color: "muted" } }];
    let x = 2;
    this.leftArrowRange = { start: x, end: x + 1 };
    let tabRow = "‹ ";
    x += 2;
    this.tabHitRanges = [];
    for (const [index, slot] of this.slots.entries()) {
      const selected = index === this.activeIndex;
      const label = `${selected ? "●" : "○"} ${slot.icon} ${slot.title}`;
      const labelWidth = cellWidth(label);
      this.tabHitRanges.push({ start: x, end: x + labelWidth, index });
      tabs.push(label);
      tabSegments.push({ text: label, style: { color: selected ? "accent" : "muted", bold: selected } });
      if (index < this.slots.length - 1) tabSegments.push({ text: "   " });
      x += labelWidth + 3;
    }
    tabRow += tabs.join("   ");
    const tabRowWidth = cellWidth(tabRow);
    const rightStart = 2 + tabRowWidth + 1;
    this.rightArrowRange = { start: rightStart, end: rightStart + 1 };
    tabSegments.push({ text: " ›", style: { color: "muted" } });
    tabSegments.push({ text: " ⠿", style: { color: "muted" } });
    addSegmentRow(tabSegments);

    addRow("─".repeat(contentWidth), { color: "borderAccent" });
    const slot = this.slots[this.activeIndex];
    let slotLines;
    try {
      const rendered = slot?.render(this.state);
      slotLines = Array.isArray(rendered) ? rendered : [String(rendered ?? "")];
    } catch (error) {
      slotLines = [`スロットの表示に失敗しました: ${error instanceof Error ? error.message : String(error)}`];
    }
    const contentLines = slotLines.flatMap((line) => {
      const text = String(line);
      let style;
      try {
        style = slot?.styleLine?.(text, this.state);
      } catch {
        style = undefined;
      }
      return wrapCells(text, bodyWidth).map((wrapped) => ({ text: wrapped, style }));
    });
    const terminalRows = this.tui?.terminal?.rows;
    const automaticHeight = Number.isFinite(terminalRows) && terminalRows > 0
      ? Math.floor(terminalRows * 0.82)
      : 40;
    const targetHeight = clamp(this.panelHeight ?? automaticHeight, resizeLimits.minHeight, resizeLimits.maxHeight);
    const fixedRows = lines.length + 1;
    const viewportHeight = Math.max(0, targetHeight - fixedRows);
    const maxScrollTop = Math.max(0, contentLines.length - viewportHeight);
    this.scrollTop = clamp(this.scrollTop, 0, maxScrollTop);
    const thumbHeight = maxScrollTop > 0 && viewportHeight > 0
      ? Math.max(1, Math.floor(viewportHeight * viewportHeight / contentLines.length))
      : viewportHeight;
    const thumbTop = maxScrollTop > 0 && viewportHeight > thumbHeight
      ? Math.round(this.scrollTop / maxScrollTop * (viewportHeight - thumbHeight))
      : 0;
    this.bodyLayout = {
      top: lines.length,
      viewportHeight,
      contentHeight: contentLines.length,
      maxScrollTop,
      scrollbarX: 2 + bodyWidth,
      thumbHeight,
      thumbTop,
    };

    const visibleLines = contentLines.slice(this.scrollTop, this.scrollTop + viewportHeight);
    for (let index = 0; index < viewportHeight; index++) {
      const line = visibleLines[index];
      const text = line ? padCells(truncateCells(line.text, bodyWidth), bodyWidth) : " ".repeat(bodyWidth);
      const isThumb = maxScrollTop > 0 && index >= thumbTop && index < thumbTop + thumbHeight;
      const scrollbar = maxScrollTop > 0
        ? applyStyle(this.theme, isThumb ? "█" : "│", { color: isThumb ? "accent" : "muted" })
        : " ";
      lines.push(`${border(this.theme, "│")} ${applyStyle(this.theme, text, line?.style)}${scrollbar} ${border(this.theme, "│")}`);
    }
    lines.push(border(this.theme, `╰${"─".repeat(innerWidth)}╯`));
    this.lastPanelHeight = lines.length;
    return lines;
  }

  invalidate() {}
  dispose() {}
}
