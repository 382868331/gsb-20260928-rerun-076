import { useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { Scenario } from "../types";
import { diffState, findStateRefs, substituteState } from "../sequence";

export interface SeqStep {
  id: string;
  label: string;
  method: string;
  path: string;
  query: string;
  headersText: string;
  bodyText: string;
  conditionText?: string;
  repeatCount?: number;
  pauseAfter?: boolean;
}

export type StepStatus = "ok" | "failed" | "cancelled" | "skipped" | "invalid" | "unknown";

export interface StepResult {
  status: StepStatus;
  httpStatus?: number;
  ms?: number;
  error?: string;
  note?: string;
  consumed?: { key: string; source: string | null }[];
  produced?: Record<string, unknown>;
  missing?: string[];
  branchTaken?: boolean;
  conditionText?: string;
  requestId?: string;
  roundId?: string;
  committed?: boolean;
  responseBody?: unknown;
  repeats?: StepResult[];
}

const STATUS_TEXT: Record<StepStatus, string> = {
  ok: "已完成",
  failed: "已确认失败",
  cancelled: "已确认未执行",
  skipped: "未执行",
  invalid: "变量失效",
  unknown: "结果未知",
};

function uid(prefix: string) {
  const random = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${prefix}-${random}`;
}

function evalCondition(expr: string, state: Record<string, unknown>, status = 0, body: unknown = null) {
  const text = expr.trim();
  if (!text) return true;
  try {
    const fn = new Function("state", "status", "body", `return (${text});`);
    return Boolean(fn(state, status, body));
  } catch {
    return false;
  }
}

function tryParseBody(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

export function SequencePanel({
  scenario,
  steps,
  setSteps,
  onRefresh,
}: {
  scenario: Scenario;
  steps: SeqStep[];
  setSteps: (s: SeqStep[]) => void;
  onRefresh: () => void;
}) {
  const definitionSignature = useMemo(
    () => JSON.stringify({ initial: scenario.initialState, steps }),
    [scenario.initialState, steps]
  );
  const [results, setResults] = useState<Record<string, StepResult>>({});
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [roundId, setRoundId] = useState("");
  const [resumeIndex, setResumeIndex] = useState(0);
  const [runSignature, setRunSignature] = useState("");
  const prerequisitesChanged = roundId !== "" && runSignature !== definitionSignature;
  const abortRef = useRef<AbortController | null>(null);
  const runningIndexRef = useRef(0);
  const pendingOps = useMemo(
    () => (scenario.operations ?? []).filter((op) => op.status === "pending"),
    [scenario.operations]
  );
  const blockingResult = Object.values(results).find((result) => result.status === "failed" || result.status === "invalid");

  const update = (id: string, patch: Partial<SeqStep>) =>
    setSteps(steps.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const executeOnce = async (
    step: SeqStep,
    index: number,
    state: Record<string, unknown>,
    producedBy: Map<string, string>,
    activeRoundId: string,
    repeatIndex: number,
    signal?: AbortSignal,
    lastStatus = 0,
    lastBody: unknown = null
  ): Promise<StepResult> => {
    const branchTaken = evalCondition(step.conditionText ?? "", state, lastStatus, lastBody);
    const allText = [step.conditionText ?? "", step.path, step.query, step.headersText, step.bodyText].join("\n");
    const consumed = findStateRefs(allText).map((key) => ({ key, source: producedBy.get(key) ?? null }));
    const missing = consumed.filter((c) => c.source === null).map((c) => c.key);
    if (!branchTaken) {
      return { status: "skipped", branchTaken: false, conditionText: step.conditionText, note: "条件为 false，该分支本轮未运行，不提供旧值" };
    }
    if (missing.length > 0) {
      return { status: "invalid", branchTaken: true, consumed, missing, note: `变量 ${missing.join("、")} 在本轮没有来源` };
    }
    const sub = (t: string) => substituteState(t, state).text;
    let headers: Record<string, string> = {};
    try {
      headers = JSON.parse(sub(step.headersText) || "{}");
    } catch {
      return { status: "failed", branchTaken: true, consumed, error: "请求头不是合法 JSON" };
    }
    const requestId = uid("req");
    const hasBody = !["GET", "HEAD"].includes(step.method);
    const bodyText = hasBody && sub(step.bodyText) ? sub(step.bodyText) : undefined;
    const query = sub(step.query).trim().replace(/^[?]/, "");
    const path = sub(step.path);
    const url = `/mocks/${scenario.id}${path}` + (query ? (path.includes("?") ? "&" : "?") + query : "");
    const started = performance.now();
    try {
      const res = await fetch(url, {
        method: step.method,
        headers: {
          ...headers,
          "X-Mock-Request-Id": requestId,
          "X-Mock-Round-Id": activeRoundId,
          "X-Mock-Step-Id": step.id,
          "X-Mock-Branch-Id": step.id,
          "X-Mock-Condition": step.conditionText ?? "",
          "X-Mock-Repeat-Index": String(repeatIndex + 1),
        },
        body: bodyText,
        signal,
      });
      const responseText = await res.text();
      const responseBody = tryParseBody(responseText);
      const after = await api.get(scenario.id);
      const op = after.operations?.find((item) => item.requestId === requestId);
      const newState = after.state ?? {};
      const produced = diffState(state, newState);
      for (const k of Object.keys(produced)) {
        producedBy.set(k, `第 ${index + 1} 步${repeatIndex > 0 ? ` 第 ${repeatIndex + 1} 次` : ""}`);
      }
      return {
        status: op?.committed === false ? "unknown" : "ok",
        httpStatus: res.status,
        ms: Math.round(performance.now() - started),
        consumed,
        produced,
        branchTaken: true,
        conditionText: step.conditionText,
        requestId,
        roundId: activeRoundId,
        responseBody,
        note: op?.uncommittedReason || (responseText ? undefined : "响应体为空"),
      };
    } catch (e) {
      return {
        status: "unknown",
        branchTaken: true,
        consumed,
        requestId,
        roundId: activeRoundId,
        error: e instanceof Error ? e.message : String(e),
        note: "请求已发出但结果尚未收齐；不会自动重发，请先查看已保存事实",
      };
    }
  };

  const run = async (startIndex = 0, resumeRoundId = "", existing: Record<string, StepResult> = {}) => {
    if (running || steps.length === 0) return;
    let effectiveStart = startIndex;
    let effectiveRound = resumeRoundId;
    let effectiveExisting = existing;
    if (resumeRoundId && prerequisitesChanged) {
      effectiveStart = 0;
      effectiveRound = "";
      effectiveExisting = {};
      setPaused(false);
      setResults({});
    }
    const activeRoundId = effectiveRound || uid("round");
    setRunning(true);
    setPaused(false);
    const abort = new AbortController();
    abortRef.current = abort;
    const out = { ...effectiveExisting };
    setRunSignature(definitionSignature);
    try {
      const fresh = effectiveStart === 0 ? await api.beginRound(scenario.id, activeRoundId) : await api.get(scenario.id);
      setRoundId(activeRoundId);
      let state: Record<string, unknown> = fresh.state ?? {};
      let lastStatus = 0;
      let lastBody: unknown = null;
      const producedBy = new Map<string, string>();
      for (const k of Object.keys(state)) producedBy.set(k, "初始状态");
      for (const result of Object.values(out)) {
        for (const item of result.repeats ?? [result]) {
          for (const k of Object.keys(item.produced ?? {})) producedBy.set(k, "本轮暂停前已确认步骤");
        }
      }

      for (let i = effectiveStart; i < steps.length; i++) {
        runningIndexRef.current = i;
        const step = steps[i];
        const repeats: StepResult[] = [];
        const total = Math.max(1, step.repeatCount ?? 1);
        for (let rep = 0; rep < total; rep++) {
          const result = await executeOnce(step, i, state, producedBy, activeRoundId, rep, abort.signal, lastStatus, lastBody);
          repeats.push(result);
          if (result.status === "ok") {
            state = (await api.get(scenario.id)).state ?? {};
            lastStatus = result.httpStatus ?? 0;
            lastBody = result.responseBody ?? null;
          } else if (result.status === "skipped") {
            break;
          } else {
            for (const skipped of steps.slice(i + 1)) {
              out[skipped.id] = {
                status: "skipped",
                note: result.status === "unknown" ? "前序结果未知：重开后可等待事实、另开独立轮次或终止路径，不会自动重发" : "前序未确认完成，本路径终止",
              };
            }
            if (result.status === "unknown") {
              setPaused(true);
              setResumeIndex(i + 1);
            }
            break;
          }
        }
        const first = repeats[0] ?? { status: "skipped" as const };
        out[step.id] = { ...first, repeats: repeats.length > 1 ? repeats : undefined };
        setResults({ ...out });
        if (first.status !== "ok") break;
        if (step.pauseAfter) {
          setPaused(true);
          setResumeIndex(i + 1);
          break;
        }
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      onRefresh();
    }
  };

  const pause = () => {
    abortRef.current?.abort();
    setPaused(true);
    setResumeIndex(runningIndexRef.current + 1);
  };

  const adoptFacts = () => {
    const confirmed: Record<string, StepResult> = {};
    for (const op of scenario.operations ?? []) {
      if (op.roundId !== roundId || op.status === "pending") continue;
      confirmed[op.stepId || ""] = {
        ...(results[op.stepId || ""] ?? {}),
        status: op.status === "completed" ? "ok" : "failed",
        httpStatus: op.statusHttp,
        requestId: op.requestId,
        roundId: op.roundId,
        committed: op.committed,
        note: op.uncommittedReason,
      };
    }
    setResults((prev) => ({ ...prev, ...confirmed }));
    onRefresh();
  };

  return (
    <div className="sequence">
      <div className="row-between">
        <h4>轮次执行（条件分支、有限重复、暂停审阅）</h4>
        <div className="seq-actions">
          {!running && !paused && (
            <button className="btn primary" onClick={() => run()} disabled={steps.length === 0 || !scenario.enabled}>
              开始新一轮
            </button>
          )}
          {running && <button className="btn" onClick={pause}>人为暂停</button>}
          {paused && (
            <button className="btn primary" onClick={() => run(resumeIndex, roundId, results)} disabled={pendingOps.length > 0 || Boolean(blockingResult)}>
              从第 {resumeIndex + 1} 步继续（不混入旧轮次）
            </button>
          )}
          <button className="btn-mini" disabled={running || steps.length === 0} onClick={() => { setSteps([]); setResults({}); setPaused(false); }}>
            清空
          </button>
        </div>
      </div>
      <p className="muted small">
        每轮先重置状态与计数。条件表达式可用 state/status/body；只有实际运行的分支写入本轮变量。
        修改前置条件后继续会使用新一轮结果，旧轮次迟到结果只归入原轮次。
      </p>
      {prerequisitesChanged && (
        <div className="issue issue-warning">
          前置条件已修改：继续前将开始独立的新一轮，已完成事实仍保留，旧轮次变量不会混入。
        </div>
      )}
      {pendingOps.length > 0 && (
        <div className="issue issue-warning">
          有 {pendingOps.length} 个结果不确定请求：{pendingOps.map((op) => op.requestId.slice(0, 8)).join("、")}。可等待刷新、另开独立轮次或终止路径，系统不会悄悄重发。
          <div className="seq-actions">
            <button className="btn-mini" onClick={onRefresh}>等待并刷新事实</button>
            <button className="btn-mini" onClick={adoptFacts}>采纳已确认事实</button>
            <button className="btn-mini" onClick={() => run()} disabled={running}>重新执行独立轮次</button>
            <button className="btn-mini danger" onClick={() => { setResults({}); setPaused(false); setResumeIndex(0); }}>终止当前路径</button>
          </div>
        </div>
      )}
      {steps.length === 0 && <p className="muted">还没有步骤。</p>}
      {(scenario.operations ?? []).length > 0 && (
        <details className="operation-ledger">
          <summary>已保存事实（完成 / 失败 / 未知）</summary>
          {(scenario.operations ?? []).slice().reverse().map((op) => (
            <div key={op.requestId} className={`op-fact op-${op.status}`}>
              <strong>{op.status === "pending" ? "结果不确定" : op.status === "completed" ? "已确认完成" : "已确认未执行"}</strong>
              <code>{op.requestId}</code>
              <span>{op.method} {op.path} · 轮次 {op.roundId.slice(0, 8)} · 重复 {op.repeatIndex}</span>
              {op.ruleId && <span>分支/规则 {op.ruleId}</span>}
              <span>变量来源 {JSON.stringify(op.stateBefore ?? {})} → {JSON.stringify(op.proposedState ?? {})}</span>
              {op.uncommittedReason && <span className="resp-error">{op.uncommittedReason}</span>}
            </div>
          ))}
        </details>
      )}
      {steps.map((step, i) => {
        const result = results[step.id];
        const repeats = result?.repeats ?? (result ? [result] : []);
        return (
          <div key={step.id} className={`seq-step seq-${result?.status ?? "idle"}`}>
            <div className="seq-head">
              <span className="seq-num"># {i + 1}</span>
              <strong>{step.method} {step.path}</strong>
              {result && <span className={`seq-badge seq-badge-${result.status}`}>{STATUS_TEXT[result.status]}{result.httpStatus !== undefined && ` · HTTP ${result.httpStatus}`}</span>}
              <button className="btn-mini danger" disabled={running} onClick={() => setSteps(steps.filter((s) => s.id !== step.id))}>移除</button>
            </div>
            <details className="seq-edit" open={!result}>
              <summary>条件 / 重复 / 请求</summary>
              <label className="block">条件（JS，如 status &gt;= 200 &amp;&amp; state.ok）
                <input value={step.conditionText ?? ""} disabled={running} onChange={(e) => update(step.id, { conditionText: e.target.value })} placeholder="留空表示始终运行" />
              </label>
              <div className="seq-edit-row">
                <label>重复次数
                  <input type="number" min="1" value={step.repeatCount ?? 1} disabled={running} onChange={(e) => update(step.id, { repeatCount: Math.max(1, Number(e.target.value) || 1) })} />
                </label>
                <label><input type="checkbox" checked={step.pauseAfter ?? false} disabled={running} onChange={(e) => update(step.id, { pauseAfter: e.target.checked })} /> 完成后暂停审阅</label>
              </div>
              <label className="block">路径（可用 {"{{state.键}}"}）<input value={step.path} disabled={running} onChange={(e) => update(step.id, { path: e.target.value })} /></label>
              <label className="block">Query<input value={step.query} disabled={running} onChange={(e) => update(step.id, { query: e.target.value })} /></label>
              <label className="block">请求头 JSON<textarea rows={2} value={step.headersText} disabled={running} spellCheck={false} onChange={(e) => update(step.id, { headersText: e.target.value })} /></label>
              {!["GET", "HEAD"].includes(step.method) && (
                <label className="block">请求体<textarea rows={3} value={step.bodyText} disabled={running} spellCheck={false} onChange={(e) => update(step.id, { bodyText: e.target.value })} /></label>
              )}
            </details>
            {result && (
              <div className="seq-result">
                {repeats.map((rep, n) => (
                  <div key={`${rep.requestId ?? n}-${n}`} className="repeat-result">
                    <strong>第 {n + 1} 次</strong>
                    {rep.consumed?.map((c) => <span key={c.key} className={c.source ? "var-chip" : "var-chip invalid"}>{c.key} ← {c.source ?? "本轮无来源"}</span>)}
                    {Object.entries(rep.produced ?? {}).map(([k, v]) => <span key={k} className="var-chip produced">{k} = {JSON.stringify(v)}</span>)}
                    {rep.requestId && <code>{rep.requestId}</code>}
                    {rep.note && <span className="muted small">{rep.note}</span>}
                    {rep.error && <span className="resp-error">{rep.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
