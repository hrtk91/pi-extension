const MAX_HISTORY = 40;
const MAX_EVIDENCE = 4;
const VALID_STATUSES = new Set(["idle", "active", "blocked", "complete"]);
const VALID_VERIFICATION_STATUSES = new Set(["unchecked", "passed", "failed", "unknown"]);
const COMMANDS = new Set(["set", "criterion", "done", "note", "handoff", "blocked", "resume", "clear", "help", "panel"]);

export function emptyGoalState() {
  return { goal: null, status: "idle", criteria: [], history: [], updatedAt: 0 };
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeVerification(value) {
  let status = VALID_VERIFICATION_STATUSES.has(value?.status) ? value.status : "unchecked";
  const evidence = Array.isArray(value?.evidence)
    ? value.evidence.map(cleanText).filter(Boolean).slice(0, MAX_EVIDENCE)
    : [];
  let reason = cleanText(value?.reason).slice(0, 600);
  if (status === "passed" && evidence.length === 0) {
    status = "unknown";
    reason ||= "A pass verdict without evidence is not accepted.";
  }
  return {
    status,
    reason,
    evidence,
    checkedAt: Number.isFinite(value?.checkedAt) ? value.checkedAt : 0,
  };
}

function normalizeCriterion(item) {
  const verification = normalizeVerification(item.verification);
  let complete = item.complete === true || verification.status === "passed";
  let completionSource = item.completionSource === "checker" || item.completionSource === "manual"
    ? item.completionSource
    : complete ? verification.status === "passed" ? "checker" : "manual" : null;
  if (completionSource === "checker" && verification.status !== "passed") {
    complete = false;
    completionSource = null;
  }
  if (!complete) completionSource = null;
  return { text: cleanText(item.text), complete, completionSource, verification };
}

export function normalizeGoalState(value) {
  if (!value || typeof value !== "object") return emptyGoalState();
  const criteria = Array.isArray(value.criteria)
    ? value.criteria
        .filter((item) => item && typeof item.text === "string")
        .map(normalizeCriterion)
        .filter((item) => item.text)
    : [];
  const history = Array.isArray(value.history)
    ? value.history
        .filter((item) => item && typeof item.text === "string")
        .map((item) => ({
          type: cleanText(item.type) || "note",
          text: cleanText(item.text),
          at: Number.isFinite(item.at) ? item.at : 0,
        }))
        .filter((item) => item.text)
        .slice(-MAX_HISTORY)
    : [];
  const goal = typeof value.goal === "string" ? cleanText(value.goal) || null : null;
  let status = VALID_STATUSES.has(value.status) ? value.status : goal ? "active" : "idle";
  if (status === "complete" && (criteria.length === 0 || !criteria.every((item) => item.complete))) status = "active";
  return {
    goal,
    status: goal ? status : "idle",
    criteria,
    history,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

function record(state, type, text, now) {
  return {
    ...state,
    updatedAt: now,
    history: [...state.history, { type, text: cleanText(text), at: now }].slice(-MAX_HISTORY),
  };
}

function result(kind, state, message) {
  return { kind, state, message };
}

export function recordGoalEvent(currentState, type, text, now = Date.now()) {
  return record(normalizeGoalState(currentState), cleanText(type) || "note", text, now);
}

/** Apply a /goal command. Mutations are returned as snapshots for session persistence. */
export function reduceGoalCommand(currentState, rawArgs = "", now = Date.now()) {
  const state = normalizeGoalState(currentState);
  const args = cleanText(rawArgs);
  if (!args || args === "panel") return result("show", state);

  const firstSpace = args.indexOf(" ");
  const firstWord = firstSpace === -1 ? args : args.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : args.slice(firstSpace + 1).trim();
  const command = COMMANDS.has(firstWord) ? firstWord : "set";
  const text = command === "set" && !COMMANDS.has(firstWord) ? args : rest;

  switch (command) {
    case "help":
      return result("help", state,
        "/goal set <goal> · /goal criterion <condition> · /goal done <number> (手動上書き) · /goal note <text> · /goal handoff <summary> · /goal blocked <reason> · /goal resume · /goal clear");

    case "set": {
      if (!text) return result("error", state, "使い方: /goal set <ゴール>");
      let next = { ...state, goal: text, status: "active", criteria: [] };
      next = record(next, "goal", `ゴールを設定: ${text}`, now);
      return result("update", next, "ゴールを設定しました。");
    }

    case "criterion": {
      if (!state.goal) return result("error", state, "先に /goal set <ゴール> でゴールを設定してください。");
      if (!text) return result("error", state, "使い方: /goal criterion <完了条件>");
      let next = { ...state, status: state.status === "blocked" ? "blocked" : "active", criteria: [...state.criteria, { text, complete: false, completionSource: null, verification: normalizeVerification() }] };
      next = record(next, "condition", `完了条件を追加: ${text}`, now);
      return result("update", next, "完了条件を追加しました。");
    }

    case "done": {
      const index = Number.parseInt(rest, 10) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= state.criteria.length) {
        return result("error", state, `条件番号を指定してください (1-${state.criteria.length})。`);
      }
      const criteria = state.criteria.map((item, i) => i === index ? { ...item, complete: true, completionSource: "manual" } : item);
      const complete = criteria.length > 0 && criteria.every((item) => item.complete);
      let next = { ...state, criteria, status: complete ? "complete" : "active" };
      next = record(next, "manual", `手動で完了にしました: ${criteria[index].text}`, now);
      const message = !complete
        ? `条件 ${index + 1} を手動で完了にしました。`
        : criteria.every((item) => item.completionSource === "manual")
          ? "全条件を手動で完了にしました。"
          : "全条件が完了しました (手動記録を含みます)。";
      return result("update", next, message);
    }

    case "note":
    case "handoff": {
      if (!state.goal) return result("error", state, "先に /goal set <ゴール> でゴールを設定してください。");
      if (!text) return result("error", state, `使い方: /goal ${command} <内容>`);
      const type = command === "handoff" ? "handoff note" : "progress";
      const prefix = command === "handoff" ? "引き継ぎメモ (記録のみ・起動はしません): " : "経緯: ";
      const next = record(state, type, `${prefix}${text}`, now);
      return result("update", next, command === "handoff" ? "引き継ぎメモを記録しました (エージェントは起動していません)。" : "経緯を記録しました。");
    }

    case "blocked": {
      if (!state.goal) return result("error", state, "先に /goal set <ゴール> でゴールを設定してください。");
      if (!text) return result("error", state, "使い方: /goal blocked <理由>");
      let next = { ...state, status: "blocked" };
      next = record(next, "blocked", `ブロック中: ${text}`, now);
      return result("update", next, "ゴールをブロック中にしました。");
    }

    case "resume": {
      if (!state.goal) return result("error", state, "現在のゴールはありません。");
      let next = { ...state, status: "active" };
      next = record(next, "resumed", "作業を再開", now);
      return result("update", next, "ゴールを作業中に戻しました。");
    }

    case "clear": {
      let next = { ...state, goal: null, status: "idle", criteria: [] };
      next = record(next, "cleared", "現在のゴールを解除", now);
      return result("update", next, "ゴールを解除しました (履歴は残しています)。");
    }

    default:
      return result("error", state, "不明なコマンドです。/goal help で使い方を確認してください。");
  }
}

/** Apply a validated independent checker report; only evidence-backed passes complete criteria. */
export function applyGoalAudit(currentState, report, now = Date.now(), workerSummary = "") {
  const state = normalizeGoalState(currentState);
  if (!state.goal || state.criteria.length === 0) return state;
  const verdicts = Array.isArray(report?.verdicts) ? report.verdicts : [];
  const criteria = state.criteria.map((item, index) => {
    const verdict = verdicts.find((entry) => entry?.criterion === index + 1);
    let status = ["pass", "fail", "unknown"].includes(verdict?.verdict) ? verdict.verdict : "unknown";
    const evidence = Array.isArray(verdict?.evidence)
      ? verdict.evidence.map(cleanText).filter(Boolean).slice(0, MAX_EVIDENCE)
      : [];
    if (status === "pass" && evidence.length === 0) status = "unknown";
    const verification = {
      status: status === "pass" ? "passed" : status === "fail" ? "failed" : "unknown",
      reason: cleanText(verdict?.reason || "Checker did not provide a usable verdict.").slice(0, 600),
      evidence,
      checkedAt: now,
    };
    return {
      ...item,
      complete: status === "pass",
      completionSource: status === "pass" ? "checker" : null,
      verification,
    };
  });
  const complete = criteria.every((item) => item.complete);
  const counts = criteria.reduce((result, item) => {
    result[item.verification.status] = (result[item.verification.status] ?? 0) + 1;
    return result;
  }, {});
  let next = {
    ...state,
    criteria,
    status: complete ? "complete" : state.status === "blocked" ? "blocked" : "active",
    updatedAt: now,
  };
  const reflection = cleanText(workerSummary).slice(0, 600);
  if (reflection) next = record(next, "reflection", `Workerの振り返り: ${reflection}`, now);
  const summary = `GoalChecker: 合格 ${counts.passed ?? 0} / 未達 ${counts.failed ?? 0} / 判断不能 ${counts.unknown ?? 0}`;
  return record(next, "audit", summary, now);
}
