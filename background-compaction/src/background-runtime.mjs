import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BackgroundCompactionState } from "./background-state.mjs";

const STRATEGY = "background-turn-percent-v1";
const DEFAULTS = { startAtPercent: 50, keepRecentPercent: 20, maxCompactTurns: 80 };

export function getBackgroundCompactionPreferencesPath() {
  let agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  if (/^~[\\/]/.test(agentDir)) agentDir = join(homedir(), agentDir.slice(2));
  return join(resolve(agentDir), "extensions", "background-compaction.json");
}

function readPreferredModel(modelConfigPath) {
  if (!modelConfigPath || !existsSync(modelConfigPath)) return { model: undefined, error: undefined };
  try {
    const config = JSON.parse(readFileSync(modelConfigPath, "utf8"));
    if (config.version !== 1 || (config.defaultModel !== undefined && typeof config.defaultModel !== "string")) {
      throw new Error("unsupported configuration format");
    }
    return { model: config.defaultModel, error: undefined };
  } catch (error) {
    return { model: undefined, error: `Could not read ${modelConfigPath}: ${error.message}` };
  }
}

function writePreferredModel(modelConfigPath, modelRef) {
  if (!modelConfigPath) throw new Error("persistent model preferences are not configured");
  const tempPath = `${modelConfigPath}.tmp-${process.pid}-${randomUUID()}`;
  mkdirSync(dirname(modelConfigPath), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(tempPath, `${JSON.stringify({ version: 1, defaultModel: modelRef }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tempPath, modelConfigPath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* No temporary file to clean up. */ }
    throw error;
  }
}

function clearPreferredModel(modelConfigPath) {
  if (!modelConfigPath) throw new Error("persistent model preferences are not configured");
  try { unlinkSync(modelConfigPath); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function modelReference(model) {
  return `${model.provider}/${model.id}`;
}

function resolveAvailableModel(reference, ctx) {
  const models = ctx.modelRegistry?.getAvailable?.() ?? [];
  const normalized = reference.trim().toLowerCase();
  const canonicalMatches = models.filter((model) => modelReference(model).toLowerCase() === normalized);
  const matches = canonicalMatches.length ? canonicalMatches : models.filter((model) => model.id.toLowerCase() === normalized);
  if (matches.length === 1) return { model: matches[0] };
  if (matches.length > 1) return { error: `Model name "${reference}" is ambiguous; use provider/model-id` };
  return { error: `Model "${reference}" is not available or its provider is not authenticated` };
}
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.\n\nUse this EXACT format:\n\n## Goal\n[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]\n\n## Constraints & Preferences\n- [Any constraints, preferences, or requirements mentioned by user]\n- [Or "(none)" if none were mentioned]\n\n## Progress\n### Done\n- [x] [Completed tasks/changes]\n\n### In Progress\n- [ ] [Current work]\n\n### Blocked\n- [Issues preventing progress, if any]\n\n## Key Decisions\n- **[Decision]**: [Brief rationale]\n\n## Next Steps\n1. [Ordered list of what should happen next]\n\n## Critical Context\n- [Any data, examples, or references needed to continue]\n- [Or "(none)" if not applicable]\n\nKeep each section concise. Preserve exact file paths, function names, and error messages.`;
const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:\n- PRESERVE all existing information from the previous summary\n- ADD new progress, decisions, and context from the new messages\n- UPDATE the Progress section: move items from "In Progress" to "Done" when completed\n- UPDATE "Next Steps" based on what was accomplished\n- PRESERVE exact file paths, function names, and error messages\n- If something is no longer relevant, you may remove it\n\nUse this EXACT format:\n\n## Goal\n[Preserve existing goals, add new ones if the task expanded]\n\n## Constraints & Preferences\n- [Preserve existing, add new ones discovered]\n\n## Progress\n### Done\n- [x] [Include previously done items AND newly completed items]\n\n### In Progress\n- [ ] [Current work - update based on progress]\n\n### Blocked\n- [Current blockers - remove if resolved]\n\n## Key Decisions\n- **[Decision]**: [Brief rationale] (preserve all previous, add new)\n\n## Next Steps\n1. [Update based on current state]\n\n## Critical Context\n- [Preserve important context, add new if needed]\n\nKeep each section concise. Preserve exact file paths, function names, and error messages.`;
const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.\n\n${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

export function buildStandardSummaryPrompt(transcript, previousSummary = null) {
  const basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  let prompt = `<conversation>\n${transcript}\n</conversation>\n\n`;
  if (previousSummary) prompt += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  return prompt + basePrompt;
}

function projectedTurns(contextEntries) {
  const turns = [];
  let current;
  for (const projected of contextEntries ?? []) {
    const source = projected.sourceEntry;
    const startsTurn = source?.type === "message" && source.message?.role === "user";
    if (startsTurn) {
      current = { id: source.id, firstEntryId: source.id, entries: [], messages: [] };
      turns.push(current);
    }
    if (current) {
      current.entries.push(projected);
      current.messages.push(...(projected.messages ?? []));
    }
  }
  return turns;
}

function currentSummaryState(ctx) {
  const branch = ctx.sessionManager.getBranch();
  const compactions = branch.filter((entry) => entry.type === "compaction");
  const latest = compactions.at(-1);
  const details = latest?.details;
  const summarizedThrough = details?.strategy === STRATEGY && Number.isSafeInteger(details.summarizedThrough)
    ? details.summarizedThrough : 0;
  return { branch, latest, summarizedThrough, previousSummary: latest?.summary ?? null };
}

function identityAtBoundary(ctx, snapshot) {
  const { branch, latest } = currentSummaryState(ctx);
  const anchorIndex = branch.findIndex((entry) => entry.id === snapshot.anchorEntryId);
  if (anchorIndex < 0) return `stale:${ctx.sessionManager.getLeafId()}`;
  const invalidated = branch.slice(anchorIndex + 1).some((entry) => entry.type === "compaction" || entry.type === "context_edit");
  if (invalidated) return `stale:${ctx.sessionManager.getLeafId()}`;
  return latest?.id ?? "no-compaction";
}

function makeSnapshot(event, ctx, sessionId) {
  const usage = ctx.getContextUsage();
  if (!usage || usage.tokens == null || usage.contextWindow <= 0) return null;
  const projected = event.context.contextEntries ?? [];
  const turns = projectedTurns(projected);
  const { latest, summarizedThrough, previousSummary } = currentSummaryState(ctx);
  const anchorEntryId = projected.at(-1)?.sourceEntry?.id ?? ctx.sessionManager.getLeafId();
  if (!anchorEntryId) return null;
  const branch = ctx.sessionManager.getBranch();
  const latestCompactionId = latest?.id ?? "no-compaction";
  const startIndex = branch.findIndex((entry) => entry.id === anchorEntryId);
  if (startIndex < 0) return null;
  const recentInvalidation = branch.slice(startIndex + 1).some((entry) => entry.type === "compaction" || entry.type === "context_edit");
  if (recentInvalidation) return null;
  return {
    sessionId,
    branchId: latestCompactionId,
    anchorEntryId,
    contextTokens: usage.tokens,
    contextWindow: usage.contextWindow,
    turns,
    summarizedThrough,
    previousSummary,
  };
}

function messagesForSummary(snapshot) {
  return snapshot.turnsToSummarize.flatMap((turn) => turn.messages);
}

function appendStandardFileLists(summary, messages) {
  const fileOps = { read: new Set(), written: new Set(), edited: new Set() };
  const addFile = (name, args) => {
    const path = typeof args?.path === "string" ? args.path : undefined;
    if (!path) return;
    if (name === "read") fileOps.read.add(path);
    else if (name === "write") fileOps.written.add(path);
    else if (name === "edit") fileOps.edited.add(path);
  };
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content ?? []) if (part.type === "toolCall") addFile(part.name, part.arguments);
    } else if (message.role === "toolResult") {
      for (const call of message.nestedCalls?.calls ?? []) addFile(call.name, call.arguments);
    }
  }
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((path) => !modified.has(path)).sort();
  const modifiedFiles = [...modified].sort();
  const sections = [];
  if (readFiles.length) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  return sections.length ? `${summary}\n\n${sections.join("\n\n")}` : summary;
}

const STATUS_KEY = "background-compaction";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function registerBackgroundCompaction(pi, { summarizeOverride, serializeMessages, settings = DEFAULTS, debugMode = process.env.PI_BGCOMPACT_DEBUG === "1", modelConfigPath } = {}) {
  const state = new BackgroundCompactionState();
  let sessionId;
  let activeAbortController;
  let spinnerTimer;
  let spinnerUi;
  let { model: configuredModelRef, error: modelConfigError } = readPreferredModel(modelConfigPath);
  let lastModelErrorNotified;

  const modelIsAllowed = (model) => !settings.allowedModels?.length || settings.allowedModels.includes(modelReference(model));
  const resolveSummaryModel = (ctx, oneShotReference) => {
    if (oneShotReference) return resolveAvailableModel(oneShotReference, ctx);
    if (modelConfigError) return { error: modelConfigError };
    if (configuredModelRef) return resolveAvailableModel(configuredModelRef, ctx);
    return ctx.model ? { model: ctx.model } : { error: "no active model", silent: true };
  };
  const notifyModelError = (ctx, error) => {
    if (error === lastModelErrorNotified) return;
    lastModelErrorNotified = error;
    ctx.ui.notify(`Background compaction model: ${error}`, "error");
  };
  const notifyCurrentModelPreference = (ctx) => {
    if (modelConfigError) {
      notifyModelError(ctx, modelConfigError);
    } else if (configuredModelRef) {
      ctx.ui.notify(`Background compaction default model: ${configuredModelRef}`, "info");
    } else if (ctx.model) {
      ctx.ui.notify(`No saved background compaction model; using Pi's selected model (${modelReference(ctx.model)})`, "info");
    } else {
      ctx.ui.notify("No saved background compaction model and no active Pi model", "warning");
    }
  };
  const handleModelPreferenceCommand = (args, ctx) => {
    const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    if (!action || action === "show") {
      if (rest.length) ctx.ui.notify("Usage: /bgcompact model [show|set <provider/model-id>|reset]", "warning");
      else notifyCurrentModelPreference(ctx);
      return;
    }
    if (action === "set" && rest.length === 1) {
      const resolved = resolveAvailableModel(rest[0], ctx);
      if (resolved.error) {
        ctx.ui.notify(`Cannot set background compaction model: ${resolved.error}`, "error");
        return;
      }
      if (!modelIsAllowed(resolved.model)) {
        ctx.ui.notify(`Cannot set background compaction model: ${modelReference(resolved.model)} is excluded by the configured allowlist`, "error");
        return;
      }
      try {
        writePreferredModel(modelConfigPath, modelReference(resolved.model));
        configuredModelRef = modelReference(resolved.model);
        modelConfigError = undefined;
        lastModelErrorNotified = undefined;
        ctx.ui.notify(`Background compaction default model set to ${configuredModelRef}; applies to future summaries`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not save background compaction model: ${error.message}`, "error");
      }
      return;
    }
    if (action === "reset" && rest.length === 0) {
      try {
        clearPreferredModel(modelConfigPath);
        configuredModelRef = undefined;
        modelConfigError = undefined;
        lastModelErrorNotified = undefined;
        ctx.ui.notify("Background compaction model reset; future summaries will use Pi's selected model", "info");
      } catch (error) {
        ctx.ui.notify(`Could not reset background compaction model: ${error.message}`, "error");
      }
      return;
    }
    ctx.ui.notify("Usage: /bgcompact model [show|set <provider/model-id>|reset]", "warning");
  };

  const clearSpinner = () => {
    if (spinnerTimer) clearInterval(spinnerTimer);
    spinnerTimer = undefined;
    if (spinnerUi) {
      try { spinnerUi.setStatus(STATUS_KEY, undefined); } catch { /* UI may already be disposed. */ }
    }
    spinnerUi = undefined;
  };

  const startSpinner = (ctx, plan) => {
    if (ctx.mode !== "tui" || typeof ctx.ui?.setStatus !== "function") return false;
    clearSpinner();
    spinnerUi = ctx.ui;
    const startedAt = Date.now();
    let frame = 0;
    const render = () => {
      if (state.status !== "summarizing") {
        clearSpinner();
        return;
      }
      const glyph = SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length];
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      const label = ` bgcompact ${plan.fromTurn}–${plan.throughTurn} · ${elapsedSeconds}s`;
      const theme = ctx.ui.theme;
      const text = theme?.fg ? theme.fg("accent", glyph) + theme.fg("dim", label) : `${glyph}${label}`;
      try { spinnerUi?.setStatus(STATUS_KEY, text); } catch { clearSpinner(); }
    };
    render();
    if (spinnerUi) {
      spinnerTimer = setInterval(render, 100);
      spinnerTimer.unref?.();
    }
    return true;
  };

  const abortPending = (reason) => {
    clearSpinner();
    if (activeAbortController) activeAbortController.abort(new Error(reason));
    activeAbortController = undefined;
    state.cancel(reason);
  };

  const watchSummary = (ctx) => {
    const timer = setInterval(() => {
      if (state.status === "summarizing") return;
      clearInterval(timer);
      if (state.status === "ready") {
        ctx.ui.notify("Background compaction summary is ready; it will be applied at the next safe turn boundary", "info");
      } else if (state.status === "failed") {
        ctx.ui.notify(`Background compaction failed: ${state.lastResult?.error ?? "unknown error"}`, "warning");
      }
    }, 100);
    timer.unref?.();
  };

  const summarize = async (snapshot) => {
    const summaryStartedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    let timeout;
    const work = (async () => {
      if (summarizeOverride) return summarizeOverride(snapshot);
      const ctxModel = snapshot.model;
      if (!ctxModel) throw new Error("no active model available for background summary");
      if (typeof serializeMessages !== "function") throw new Error("summary serializer is not configured");
      const messages = messagesForSummary(snapshot);
      const transcript = serializeMessages(messages);
      const prompt = buildStandardSummaryPrompt(transcript, snapshot.previousSummary);
      const reserveTokens = settings.reserveTokens ?? 16_384;
      const maxTokens = Math.min(Math.floor(0.8 * reserveTokens), ctxModel.maxTokens > 0 ? ctxModel.maxTokens : Number.POSITIVE_INFINITY);
      const response = await snapshot.modelRegistry.complete(ctxModel, {
        systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
      }, { maxTokens, signal: snapshot.signal, cacheRetention: "none", sessionId: randomUUID() });
      const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      return {
        text: appendStandardFileLists(text, messages), usage: response.usage,
        summaryStartedAt, summaryCompletedAt: new Date().toISOString(), summaryDurationMs: Date.now() - startedAtMs,
      };
    })();
    const timeoutMs = settings.summaryTimeoutMs ?? 30000;
    let onAbort;
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        snapshot.abortController?.abort(new Error("background summary timed out"));
        reject(new Error(`background summary timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(snapshot.signal?.reason ?? new Error("background summary aborted"));
      if (snapshot.signal?.aborted) onAbort();
      else snapshot.signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([work, timedOut, aborted]);
    } finally {
      clearTimeout(timeout);
      snapshot.signal?.removeEventListener("abort", onAbort);
    }
  };

  const snapshotEvent = (event, ctx, model = ctx.model) => {
    const currentSessionId = ctx.sessionManager.getSessionId();
    if (!currentSessionId) return null;
    if (sessionId !== currentSessionId) {
      abortPending("session-changed");
      sessionId = currentSessionId;
    }
    const snapshot = makeSnapshot(event, ctx, currentSessionId);
    if (!snapshot) return null;
    const controller = new AbortController();
    activeAbortController = controller;
    return {
      ...snapshot,
      model,
      modelRegistry: ctx.modelRegistry,
      signal: controller.signal,
      abortController: controller,
    };
  };

  const applyReady = (ctx) => {
    const usage = ctx.getContextUsage();
    const draft = state.applyAtBoundary({
      sessionId: ctx.sessionManager.getSessionId(),
      branchId: stateSnapshotBranchIdentity(ctx),
      tokensBefore: usage?.tokens ?? undefined,
    });
    if (draft) {
      activeAbortController = undefined;
      clearSpinner();
    }
    return draft;
  };

  const stateSnapshotBranchIdentity = (ctx) => {
    // The manager validates against the compaction generation captured at start.
    const active = state.status;
    if (active === "idle" || active === "failed" || active === "applied" || active === "discarded-stale") {
      return currentSummaryState(ctx).latest?.id ?? "no-compaction";
    }
    // State stores the captured generation; appends after the anchor are safe, but a
    // later compaction/context edit or a branch switch invalidates the snapshot.
    const snapshot = state._snapshotForAdapter;
    return snapshot ? identityAtBoundary(ctx, snapshot) : currentSummaryState(ctx).latest?.id ?? "no-compaction";
  };

  const onBoundary = (event, ctx) => {
    const draft = applyReady(ctx);
    if (draft) {
      ctx.ui.notify(`background compaction applied through turn ${draft.details.summarizedThrough}; summaryMs=${draft.details.summaryDurationMs ?? 0}; inputTokens=${draft.usage?.input ?? 0}; outputTokens=${draft.usage?.output ?? 0}`, "info");
      return { entries: [draft] };
    }
    const selection = resolveSummaryModel(ctx);
    if (selection.error) {
      if (!selection.silent) notifyModelError(ctx, selection.error);
      return;
    }
    if (!selection.model || !modelIsAllowed(selection.model)) return;
    lastModelErrorNotified = undefined;
    const snapshot = snapshotEvent(event, ctx, selection.model);
    if (!snapshot) return;
    const result = state.observe(snapshot, summarize, settings);
    if (result.started) {
      state._snapshotForAdapter = result.snapshot;
      const shownInFooter = startSpinner(ctx, result.plan);
      if (!shownInFooter) {
        ctx.ui.notify(`background compaction started with ${modelReference(snapshot.model)} at ${Math.round(snapshot.contextTokens / snapshot.contextWindow * 100)}%; summarizing turns ${result.plan.fromTurn}-${result.plan.throughTurn}`, "info");
      }
      watchSummary(ctx);
    }
  };

  pi.on("turn_end", onBoundary);
  pi.on("agent_before_settle", onBoundary);
  pi.on("session_before_compact", (_event, ctx) => {
    abortPending("standard-compaction-fallback");
    ctx.ui.notify("background compaction yielded to Pi's standard compaction", "warning");
  });
  pi.on("session_shutdown", () => abortPending("session-shutdown"));
  pi.registerCommand("bgcompact", {
    description: "手動圧縮: /bgcompact [provider/model-id]。モデル設定: /bgcompact model [show|set <provider/model-id>|reset]",
    handler: async (_args, ctx) => {
      const args = String(_args ?? "").trim();
      if (args === "model" || args.startsWith("model ")) {
        handleModelPreferenceCommand(args.slice("model".length), ctx);
        return;
      }
      if (state.status === "summarizing" || state.status === "ready") {
        ctx.ui.notify(`Background compaction is already ${state.status}`, "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current assistant reply to finish, then retry /bgcompact", "warning");
        return;
      }
      const selection = resolveSummaryModel(ctx, args || undefined);
      if (selection.error || !selection.model) {
        if (selection.error) notifyModelError(ctx, selection.error);
        else ctx.ui.notify("Cannot start background compaction: no active model", "error");
        return;
      }
      if (!modelIsAllowed(selection.model)) {
        ctx.ui.notify(`Background compaction is disabled for ${modelReference(selection.model)}`, "error");
        return;
      }
      // Rebuild from the session manager instead of relying on an in-memory turn_end
      // event. This also works immediately after restarting or resuming a session.
      const projection = ctx.sessionManager.buildSessionProjection();
      if (!projection.entries.length || projection.messages.at(-1)?.role !== "assistant") {
        ctx.ui.notify("There is no completed assistant reply to summarize in this session yet", "warning");
        return;
      }
      const snapshot = snapshotEvent({ context: { contextEntries: projection.entries } }, ctx, selection.model);
      if (!snapshot) {
        ctx.ui.notify("Cannot use the current conversation for compaction; it may have changed during compaction or context editing", "warning");
        return;
      }
      const result = state.observe(snapshot, summarize, { ...settings, startAtPercent: 0 });
      if (!result.started) {
        ctx.ui.notify(`Background compaction did not start (${result.reason})`, "warning");
        return;
      }
      state._snapshotForAdapter = result.snapshot;
      startSpinner(ctx, result.plan);
      const source = args ? " (one-time override)" : "";
      ctx.ui.notify(`Manual background compaction started with ${modelReference(selection.model)}${source}; summarizing turns ${result.plan.fromTurn}-${result.plan.throughTurn}`, "info");
      watchSummary(ctx);
    },
  });
  if (debugMode) {
    pi.registerCommand("bgcompact-status", {
      description: "Show background compaction state",
      handler: async (_args, ctx) => {
        ctx.ui.notify(`background compaction: ${state.status}; last=${state.lastResult?.status ?? "none"}`, "info");
      },
    });
    pi.registerCommand("bgcompact-probe", {
      description: "Exercise the default async summarizer against the effective background model",
      handler: async (_args, ctx) => {
        const selection = resolveSummaryModel(ctx);
        if (!selection.model) {
          ctx.ui.notify(`FAIL: no background model available${selection.error ? `: ${selection.error}` : ""}`, "error");
          return;
        }
        if (!modelIsAllowed(selection.model)) {
          ctx.ui.notify(`FAIL: provider probe is disabled for ${modelReference(selection.model)}`, "error");
          return;
        }
        const probe = new BackgroundCompactionState();
        const probeController = new AbortController();
        const turns = Array.from({ length: 100 }, (_, index) => ({
          id: `probe-turn-${index + 1}`,
          firstEntryId: `probe-user-${index + 1}`,
          messages: [{ role: "user", content: [{ type: "text", text: `probe fact ${index + 1}` }], timestamp: Date.now() }],
        }));
        const result = probe.observe({
          sessionId: "probe-session", branchId: "probe-branch", anchorEntryId: "probe-assistant-100",
          contextTokens: 500, contextWindow: 1000, turns, summarizedThrough: 0,
          model: selection.model, modelRegistry: ctx.modelRegistry, signal: probeController.signal, abortController: probeController,
        }, summarize, settings);
        if (!result.started) {
          ctx.ui.notify(`FAIL: probe did not start (${result.reason})`, "error");
          return;
        }
        const timeout = Date.now() + 15000;
        while (probe.status === "summarizing" && Date.now() < timeout) await new Promise((resolve) => setTimeout(resolve, 10));
        if (probe.status !== "ready") {
          probeController.abort(new Error("provider probe timeout"));
          ctx.ui.notify(`FAIL: provider probe ended ${probe.status}: ${probe.lastResult?.error ?? "timeout"}`, "error");
          return;
        }
        const draft = probe.applyAtBoundary({ sessionId: "probe-session", branchId: "probe-branch" });
        const passed = draft?.firstKeptEntryId === "probe-user-81" && draft.details.summarizedThrough === 80;
        ctx.ui.notify(`${passed ? "PASS" : "FAIL"}: provider summary round-trip; retained boundary=${draft?.firstKeptEntryId ?? "none"}`, passed ? "info" : "error");
      },
    });
    pi.registerCommand("bgcompact-selftest", {
      description: "Test the turn-based rolling compaction planner",
      handler: async (_args, ctx) => {
        const { planCompaction } = await import("./rolling-plan.mjs");
        const initial = planCompaction(100, 0, settings);
        const next = planCompaction(180, 80, settings);
        const passed = initial?.throughTurn === 80 && next?.throughTurn === 144;
        ctx.ui.notify(`rolling compaction scheduler: ${passed ? "PASS" : "FAIL"}; 100 turns→summarize 1-80; 180 turns→81-144; retain 20%`, passed ? "info" : "error");
      },
    });
  }
  return state;
}

export default function backgroundCompactionExtension(pi) {
  return registerBackgroundCompaction(pi);
}
