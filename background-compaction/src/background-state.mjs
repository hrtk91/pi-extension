import { planCompaction, shouldStartBackgroundCompaction } from "./rolling-plan.mjs";

/**
 * Runtime-neutral orchestration for an async summary: snapshot once, summarize without
 * blocking the caller, then expose a one-shot compaction draft at a safe boundary.
 */
export class BackgroundCompactionState {
  #active = null;
  #lastResult = null;

  get status() {
    return this.#active?.status ?? this.#lastResult?.status ?? "idle";
  }

  get lastResult() {
    return this.#lastResult;
  }

  observe(snapshot, summarize, options = {}) {
    if (this.#active) return { started: false, reason: "already-active" };
    if (!shouldStartBackgroundCompaction(snapshot.contextTokens, snapshot.contextWindow, options.startAtPercent ?? 50)) {
      return { started: false, reason: "below-threshold" };
    }
    const summarizedThrough = snapshot.summarizedThrough ?? 0;
    const totalLifetimeTurns = summarizedThrough + snapshot.turns.length;
    const plan = planCompaction(totalLifetimeTurns, summarizedThrough, options);
    if (!plan) return { started: false, reason: "no-eligible-prefix" };

    // The current branch contains only turns after the previous compaction boundary.
    const localEnd = plan.throughTurn - summarizedThrough - 1;
    const firstKeptTurn = snapshot.turns[localEnd + 1];
    if (!firstKeptTurn?.firstEntryId) return { started: false, reason: "missing-kept-boundary" };
    const frozen = {
      sessionId: snapshot.sessionId,
      branchId: snapshot.branchId,
      anchorEntryId: snapshot.anchorEntryId,
      fromTurn: plan.fromTurn,
      throughTurn: plan.throughTurn,
      firstKeptEntryId: firstKeptTurn.firstEntryId,
      tokensBefore: snapshot.contextTokens,
      turnsToSummarize: snapshot.turns.slice(0, localEnd + 1),
      previousSummary: snapshot.previousSummary ?? null,
      summarizedThrough: plan.throughTurn,
      model: snapshot.model,
      modelRegistry: snapshot.modelRegistry,
      signal: snapshot.signal,
      abortController: snapshot.abortController,
    };
    const task = { status: "summarizing", snapshot: frozen, summary: undefined, error: undefined, startedAt: Date.now() };
    this.#active = task;

    // Do not await: the caller can continue the active agent run immediately.
    Promise.resolve().then(() => summarize(frozen)).then(
      (summary) => {
        if (this.#active !== task) return;
        const text = typeof summary === "string" ? summary : summary?.text;
        if (typeof text !== "string" || !text.trim()) {
          task.status = "failed";
          task.error = "summarizer returned an empty or non-text summary";
          this.#lastResult = { status: task.status, error: task.error, snapshot: frozen };
          this.#active = null;
          return;
        }
        task.summary = text.trim();
        task.usage = typeof summary === "object" ? summary.usage : undefined;
        task.summaryStartedAt = typeof summary === "object" ? summary.summaryStartedAt : undefined;
        task.summaryCompletedAt = typeof summary === "object" ? summary.summaryCompletedAt : undefined;
        task.summaryDurationMs = typeof summary === "object" ? summary.summaryDurationMs : undefined;
        task.status = "ready";
      },
      (error) => {
        if (this.#active !== task) return;
        task.status = "failed";
        task.error = error instanceof Error ? error.message : String(error);
        this.#lastResult = { status: task.status, error: task.error, snapshot: frozen };
        this.#active = null;
      },
    );
    return { started: true, plan, snapshot: frozen };
  }

  applyAtBoundary({ sessionId, branchId, tokensBefore }) {
    const task = this.#active;
    if (!task || task.status !== "ready") return null;
    if (sessionId !== task.snapshot.sessionId || branchId !== task.snapshot.branchId) {
      this.#lastResult = { status: "discarded-stale", snapshot: task.snapshot };
      this.#active = null;
      return null;
    }
    const draft = {
      type: "compaction",
      summary: task.summary,
      firstKeptEntryId: task.snapshot.firstKeptEntryId,
      tokensBefore: tokensBefore ?? task.snapshot.tokensBefore,
      ...(task.usage ? { usage: task.usage } : {}),
      details: {
        ...(task.summaryStartedAt ? { summaryStartedAt: task.summaryStartedAt } : {}),
        ...(task.summaryCompletedAt ? { summaryCompletedAt: task.summaryCompletedAt } : {}),
        ...(task.summaryDurationMs !== undefined ? { summaryDurationMs: task.summaryDurationMs } : {}),
        strategy: "background-turn-percent-v1",
        fromTurn: task.snapshot.fromTurn,
        throughTurn: task.snapshot.throughTurn,
        summarizedThrough: task.snapshot.summarizedThrough,
        snapshotBranchId: task.snapshot.branchId,
      },
    };
    this.#lastResult = {
      status: "applied", snapshot: task.snapshot, usage: task.usage,
      summaryStartedAt: task.summaryStartedAt, summaryCompletedAt: task.summaryCompletedAt,
      summaryDurationMs: task.summaryDurationMs,
    };
    this.#active = null;
    return draft;
  }

  cancel(reason = "cancelled") {
    if (!this.#active) return false;
    this.#lastResult = { status: reason, snapshot: this.#active.snapshot };
    this.#active = null;
    return true;
  }
}
