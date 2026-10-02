import { useRef, useState } from "react";
import { api } from "../api";
import type { Scenario } from "../types";
import {
  clampRepeat,
  diffState,
  emptyScope,
  evalCondition,
  findRefs,
  MAX_REPEAT,
  planRerun,
  rebuildScope,
  resolveRef,
  substitute,
  type Preflight,
  type RunScope,
} from "../sequence";

export interface SeqStep {
  id: string;
  label: string;
  method: string;
  path: string; // may contain {{state.key}} / {{step.N.key}} templates
  query: string;
  headersText: string;
  bodyText: string;
  condition?: string; // branch condition, empty = always runs
  repeat?: number;    // bounded repetitions, 1..MAX_REPEAT
}

export type StepStatus =
  | "ok"
  | "failed"
  | "cancelled"
  | "skipped"
  | "invalid"
  | "blocked"
  | "branch-off";

export interface RepResult {
  n: number;
  status: "ok" | "failed" | "cancelled";
  httpStatus?: number;
  ms?: number;
  produced?: Record<string, unknown>;
  error?: string;
}

export interface StepResult {
  status: StepStatus;
  round?: number;
  httpStatus?: number;
  ms?: number;
  error?: string;
  note?: string;
  consumed?: { ref: string; source: string | null }[];
  produced?: Record<string, unknown>;
  reps?: RepResult[];
  completedRepeats?: number;
  missing?: string[];
}

const STATUS_TEXT: Record<StepStatus, string> = {
  ok: "已完成",
  failed: "失败",
  cancelled: "已取消",
  skipped: "未执行",
  invalid: "变量失效",
  blocked: "已停止",
  "branch-off": "分支未运行",
};

function stepText(s: SeqStep): string {
  return [s.path, s.query, s.headersText, s.bodyText].join("\n");
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
  const [results, setResults] = useState<Record<string, StepResult>>({});
  const [running, setRunning] = useState(false);
  const [edited, setEdited] = useState<ReadonlySet<string>>(new Set());
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const roundRef = useRef(0);

  const update = (id: string, patch: Partial<SeqStep>) => {
    setSteps(steps.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    setEdited((prev) => new Set(prev).add(id));
  };

  const sourceOf = (
    ref: string,
    scope: RunScope,
    producedBy: Map<string, string>
  ): string | null => {
    if (ref.startsWith("state.")) {
      return producedBy.get(ref.slice("state.".length)) ?? null;
    }
    const m = /^step\.(\d+)(?:\[(\d+)\])?/.exec(ref);
    if (!m) return null;
    if (resolveRef(ref, scope) === undefined) return null;
    const n = Number(m[1]);
    return m[2] ? `第 ${n} 步第 ${m[2]} 次` : `第 ${n} 步`;
  };

  const markRemaining = (
    from: number,
    out: Record<string, StepResult>,
    note: string,
    round: number
  ) => {
    for (let j = from; j < steps.length; j++) {
      out[steps[j].id] = { status: "skipped", note, round };
    }
  };

  // execute runs steps[fromIdx..] against the given scope. Steps whose
  // condition or variables cannot be resolved are stopped individually;
  // independent branches keep running and keep their results.
  const execute = async (
    fromIdx: number,
    scope: RunScope,
    producedBy: Map<string, string>,
    keep: Record<string, StepResult>
  ) => {
    setRunning(true);
    const abort = new AbortController();
    abortRef.current = abort;
    const round = roundRef.current + 1;
    roundRef.current = round;
    const out: Record<string, StepResult> = { ...keep };
    const failedNotes: string[] = [];
    try {
      for (let i = fromIdx; i < steps.length; i++) {
        const step = steps[i];
        const n = i + 1;
        if (abort.signal.aborted) {
          out[step.id] = { status: "cancelled", note: "执行已取消", round };
          markRemaining(i + 1, out, "执行已取消", round);
          break;
        }
        if (step.condition?.trim()) {
          const c = evalCondition(step.condition, scope);
          if (c.pass === null) {
            out[step.id] = {
              status: "blocked",
              round,
              missing: c.missing,
              note: `条件「${step.condition.trim()}」无法判定：${c.missing.join("、")} 在本次运行中没有来源` +
                (failedNotes.length ? `（${failedNotes.join("；")}）` : "") +
                "。本分支停止，其它独立分支不受影响。",
            };
            setResults({ ...out });
            continue;
          }
          if (!c.pass) {
            out[step.id] = {
              status: "branch-off",
              round,
              note: `条件「${step.condition.trim()}」不满足，分支未运行；它不会提供任何变量，引用其结果的步骤将停止。`,
            };
            setResults({ ...out });
            continue;
          }
        }
        const refs = findRefs(stepText(step));
        const consumed = refs.map((ref) => ({
          ref,
          source: sourceOf(ref, scope, producedBy),
        }));
        const missing = consumed.filter((c) => c.source === null).map((c) => c.ref);
        if (missing.length > 0) {
          out[step.id] = {
            status: "invalid",
            round,
            consumed,
            missing,
            note: `变量 ${missing.join("、")} 在本次运行中没有来源（未运行的分支或失败的步骤不提供旧值）` +
              (failedNotes.length ? `；${failedNotes.join("；")}` : ""),
          };
          setResults({ ...out });
          continue;
        }
        const total = clampRepeat(step.repeat);
        const reps: RepResult[] = [];
        let halt: "failed" | "cancelled" | null = null;
        let lastError = "";
        for (let k = 1; k <= total; k++) {
          if (abort.signal.aborted) {
            halt = "cancelled";
            break;
          }
          const sub = (t: string) => substitute(t, scope).text;
          let headers: Record<string, string> = {};
          try {
            headers = JSON.parse(sub(step.headersText) || "{}");
          } catch {
            halt = "failed";
            lastError = "请求头不是合法 JSON";
            break;
          }
          const hasBody = !["GET", "HEAD"].includes(step.method);
          const body = hasBody && sub(step.bodyText) ? sub(step.bodyText) : undefined;
          const query = sub(step.query).trim().replace(/^[?]/, "");
          const path = sub(step.path);
          const url =
            `/mocks/${scenario.id}${path}` +
            (query ? (path.includes("?") ? "&" : "?") + query : "");
          const started = performance.now();
          try {
            const res = await fetch(url, {
              method: step.method,
              headers,
              body,
              signal: abort.signal,
            });
            await res.text();
            const ms = Math.round(performance.now() - started);
            const after = await api.get(scenario.id);
            const newState: Record<string, unknown> = after.state ?? {};
            const produced = diffState(scope.state, newState);
            reps.push({ n: k, status: "ok", httpStatus: res.status, ms, produced });
            scope.steps[n] = [...(scope.steps[n] ?? []), produced];
            scope.state = newState;
            for (const key of Object.keys(produced)) {
              producedBy.set(key, total > 1 ? `第 ${n} 步第 ${k} 次` : `第 ${n} 步`);
            }
          } catch (e) {
            const cancelled = abort.signal.aborted;
            lastError = cancelled ? "已取消" : e instanceof Error ? e.message : String(e);
            reps.push({ n: k, status: cancelled ? "cancelled" : "failed", error: lastError });
            halt = cancelled ? "cancelled" : "failed";
            break;
          }
        }
        const doneReps = reps.filter((r) => r.status === "ok").length;
        const merged = Object.assign(
          {},
          ...reps.filter((r) => r.produced).map((r) => r.produced)
        ) as Record<string, unknown>;
        if (halt === "cancelled") {
          out[step.id] = {
            status: "cancelled",
            round,
            reps,
            completedRepeats: doneReps,
            consumed,
            error: lastError || "已取消",
            note: "取消的请求不会写入场景状态",
          };
          markRemaining(i + 1, out, "执行已取消", round);
          break;
        }
        if (halt === "failed") {
          failedNotes.push(`第 ${n} 步失败`);
          out[step.id] = {
            status: "failed",
            round,
            reps,
            completedRepeats: doneReps,
            consumed,
            error: lastError,
            note: "失败的请求不会写入场景状态；依赖本步结果的分支将停止，独立分支继续执行" +
              (total > 1 ? `（重复 ${doneReps}/${total} 次后中断）` : ""),
          };
          setResults({ ...out });
          continue;
        }
        out[step.id] = {
          status: "ok",
          round,
          reps,
          completedRepeats: doneReps,
          consumed,
          produced: merged,
          httpStatus: reps[reps.length - 1]?.httpStatus,
          ms: reps.reduce((acc, r) => acc + (r.ms ?? 0), 0),
        };
        setResults({ ...out });
      }
      setResults({ ...out });
      setEdited((prev) => {
        const next = new Set(prev);
        for (let i = fromIdx; i < steps.length; i++) next.delete(steps[i].id);
        return next;
      });
    } catch (e) {
      out[steps[fromIdx]?.id ?? ""] = {
        status: "failed",
        round,
        error: e instanceof Error ? e.message : String(e),
      };
      setResults({ ...out });
    } finally {
      setRunning(false);
      abortRef.current = null;
      onRefresh();
    }
  };

  // A full run always starts from a clean slate so values from previous
  // rounds cannot leak into this one.
  const run = async () => {
    if (running || steps.length === 0) return;
    try {
      const fresh = await api.reset(scenario.id);
      const scope = emptyScope(fresh.state ?? {});
      const producedBy = new Map<string, string>(
        Object.keys(scope.state).map((k) => [k, "初始状态"])
      );
      await execute(0, scope, producedBy, {});
    } catch (e) {
      setResults({
        [steps[0]?.id ?? ""]: {
          status: "failed",
          error: e instanceof Error ? e.message : String(e),
        },
      });
    }
  };

  // Re-run from a middle step: first show what must be re-obtained, then
  // rebuild the variable pool from the kept earlier steps only.
  const startRerun = (n: number) => {
    const texts = Object.fromEntries(steps.map((s) => [s.id, stepText(s)]));
    setPreflight(planRerun(steps, results, edited, texts, n));
  };

  const confirmRerun = async () => {
    const pf = preflight;
    if (!pf) return;
    setPreflight(null);
    const produced: Record<string, Record<string, unknown>[]> = {};
    for (const s of steps) {
      const reps = results[s.id]?.reps;
      if (reps) produced[s.id] = reps.filter((x) => x.produced).map((x) => x.produced!);
    }
    const ids = steps.map((s) => s.id);
    const scope = rebuildScope(scenario.initialState ?? {}, ids, produced, pf.from);
    const producedBy = new Map<string, string>(
      Object.keys(scenario.initialState ?? {}).map((k) => [k, "初始状态"])
    );
    for (let i = 0; i < pf.from - 1; i++) {
      const reps = produced[ids[i]] ?? [];
      reps.forEach((p, k) => {
        for (const key of Object.keys(p)) {
          producedBy.set(key, reps.length > 1 ? `第 ${i + 1} 步第 ${k + 1} 次` : `第 ${i + 1} 步`);
        }
      });
    }
    // Align the server-side state with the reconstructed pool so mock
    // responses render from this round's values, not leftovers.
    await api.setState(scenario.id, scope.state);
    const keep: Record<string, StepResult> = {};
    for (let i = 0; i < pf.from - 1; i++) {
      const r = results[ids[i]];
      if (r) keep[ids[i]] = r;
    }
    await execute(pf.from - 1, scope, producedBy, keep);
  };

  const cancel = () => abortRef.current?.abort();

  return (
    <div className="sequence">
      <div className="row-between">
        <h4>序列执行（条件分支 + 有限重复，变量只取本次运行的值）</h4>
        <div className="seq-actions">
          {!running && (
            <button
              className="btn primary"
              onClick={run}
              disabled={steps.length === 0 || !scenario.enabled}
            >
              执行序列（先重置状态）
            </button>
          )}
          {running && (
            <button className="btn danger" onClick={cancel}>
              取消执行
            </button>
          )}
          <button
            className="btn-mini"
            disabled={running || steps.length === 0}
            onClick={() => {
              setSteps([]);
              setResults({});
              setEdited(new Set());
              setPreflight(null);
            }}
          >
            清空
          </button>
        </div>
      </div>
      <p className="muted small">
        每步可设分支条件（如 <code>token</code>、<code>!token</code>、<code>status == 200</code>）与重复次数
        （1-{MAX_REPEAT}）。后续步骤可用 {"{{state.键}}"} 引用状态、{"{{step.N.键}}"} 引用第 N 步结果、
        {"{{step.N[i].键}}"} 引用第 N 步第 i 次重复。未运行的分支不提供任何变量；某步失败后，
        只有依赖它的分支会停止，独立分支继续执行并保留结果。
      </p>
      {steps.length === 0 && (
        <p className="muted">还没有步骤。用上方“加入序列”把当前请求加入，或在调用历史里勾选一段请求重新执行。</p>
      )}
      {preflight && (
        <div className="preflight">
          <h4>从第 {preflight.from} 步重新执行 — 执行前核对</h4>
          {preflight.stalePreconditions.length > 0 ? (
            <div className="issue issue-error">
              前置步骤 {preflight.stalePreconditions.map((n) => `第 ${n} 步`).join("、")}{" "}
              在上次运行后被修改（或尚未运行），其输出不可信。请改从最早被修改的步骤重新执行。
              <button
                className="btn-mini"
                onClick={() => {
                  const first = preflight.stalePreconditions[0];
                  setPreflight(null);
                  startRerun(first);
                }}
              >
                改从第 {preflight.stalePreconditions[0]} 步
              </button>
            </div>
          ) : (
            <>
              {preflight.partialRepeats.length > 0 && (
                <div className="issue issue-warning">
                  {preflight.partialRepeats.map((p) => (
                    <div key={p.step}>
                      第 {p.step} 步上次仅完成 {p.done}/{p.total} 次重复，保留的结果可能不完整。
                    </div>
                  ))}
                </div>
              )}
              <div className="preflight-list">
                {preflight.reAcquire.map((item) => (
                  <div key={item.step} className="preflight-item">
                    <strong>第 {item.step} 步</strong>
                    {item.conditions.length > 0 && (
                      <span>需重新判定：{item.conditions.join("、")}</span>
                    )}
                    {item.refs.length > 0 && (
                      <span>需重新取得变量：{item.refs.join("、")}</span>
                    )}
                    {item.conditions.length === 0 && item.refs.length === 0 && (
                      <span className="muted">无条件与外部变量</span>
                    )}
                  </div>
                ))}
              </div>
              {preflight.discarded.length > 0 && (
                <p className="muted small">
                  将丢弃上一轮结果：{preflight.discarded.map((n) => `第 ${n} 步`).join("、")}；
                  重开后这些步骤的变量来源以新一轮为准，不会混入旧值。
                </p>
              )}
              <div className="seq-actions">
                <button className="btn primary" onClick={confirmRerun}>
                  确认，从第 {preflight.from} 步重新执行
                </button>
                <button className="btn" onClick={() => setPreflight(null)}>
                  取消
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {steps.map((step, i) => {
        const r = results[step.id];
        const isEdited = edited.has(step.id) && !!r;
        return (
          <div key={step.id} className={`seq-step seq-${r?.status ?? "idle"}`}>
            <div className="seq-head">
              <span className="seq-num">#{i + 1}</span>
              <strong>
                {step.method} {step.path}
              </strong>
              <span className="muted small">{step.label}</span>
              {step.condition?.trim() && (
                <span className="var-chip">条件：{step.condition.trim()}</span>
              )}
              {clampRepeat(step.repeat) > 1 && (
                <span className="var-chip">重复 {clampRepeat(step.repeat)} 次</span>
              )}
              {r && (
                <span className={`seq-badge seq-badge-${r.status}`}>
                  {STATUS_TEXT[r.status]}
                  {r.httpStatus !== undefined && ` · HTTP ${r.httpStatus}`}
                  {r.ms !== undefined && ` · ${r.ms}ms`}
                  {r.round !== undefined && ` · 第 ${r.round} 轮`}
                </span>
              )}
              {isEdited && <span className="var-chip invalid">已修改未重跑</span>}
              {r && !running && (
                <button className="btn-mini" onClick={() => startRerun(i + 1)}>
                  从第 {i + 1} 步重跑
                </button>
              )}
              <button
                className="btn-mini danger"
                disabled={running}
                onClick={() => setSteps(steps.filter((s) => s.id !== step.id))}
              >
                移除
              </button>
            </div>
            <details className="seq-edit">
              <summary>查看 / 修改请求与分支设置</summary>
              <label className="block">
                分支条件（留空 = 总是执行；如 token、!token、status == 200、step.2.code == 0）
                <input
                  value={step.condition ?? ""}
                  disabled={running}
                  onChange={(e) => update(step.id, { condition: e.target.value })}
                />
              </label>
              <label className="block">
                重复次数（1-{MAX_REPEAT}，有限次；后续步骤可用 {"{{step."}{i + 1}{"[i].键}}"} 引用某一次）
                <input
                  type="number"
                  min={1}
                  max={MAX_REPEAT}
                  value={clampRepeat(step.repeat)}
                  disabled={running}
                  onChange={(e) => update(step.id, { repeat: Number(e.target.value) })}
                />
              </label>
              <label className="block">
                路径（可用 {"{{state.键}}"} / {"{{step.N.键}}"}）
                <input value={step.path} disabled={running} onChange={(e) => update(step.id, { path: e.target.value })} />
              </label>
              <label className="block">
                Query
                <input value={step.query} disabled={running} onChange={(e) => update(step.id, { query: e.target.value })} />
              </label>
              <label className="block">
                请求头 JSON
                <textarea rows={2} value={step.headersText} disabled={running} spellCheck={false}
                  onChange={(e) => update(step.id, { headersText: e.target.value })} />
              </label>
              {!["GET", "HEAD"].includes(step.method) && (
                <label className="block">
                  请求体
                  <textarea rows={4} value={step.bodyText} disabled={running} spellCheck={false}
                    onChange={(e) => update(step.id, { bodyText: e.target.value })} />
                </label>
              )}
            </details>
            {r && (
              <div className="seq-result">
                {r.consumed && r.consumed.length > 0 && (
                  <div className="seq-vars">
                    <span className="muted small">本次变量来源：</span>
                    {r.consumed.map((c) => (
                      <span key={c.ref} className={c.source ? "var-chip" : "var-chip invalid"}>
                        {c.ref} ← {c.source ?? "失效（本次运行无来源）"}
                      </span>
                    ))}
                  </div>
                )}
                {r.reps && r.reps.length > 0 && (r.reps.length > 1 || clampRepeat(step.repeat) > 1) && (
                  <div className="seq-vars">
                    <span className="muted small">重复执行：</span>
                    {r.reps.map((rep) => (
                      <span key={rep.n} className={`var-chip ${rep.status === "ok" ? "produced" : "invalid"}`}>
                        第 {rep.n} 次{rep.httpStatus !== undefined && ` · HTTP ${rep.httpStatus}`}
                        {rep.status !== "ok" && ` · ${rep.status === "failed" ? "失败" : "已取消"}`}
                      </span>
                    ))}
                    {r.completedRepeats !== undefined && (
                      <span className="muted small">完成 {r.completedRepeats}/{clampRepeat(step.repeat)}</span>
                    )}
                  </div>
                )}
                {r.produced && Object.keys(r.produced).length > 0 && (
                  <div className="seq-vars">
                    <span className="muted small">本步写入：</span>
                    {Object.entries(r.produced).map(([k, v]) => (
                      <span key={k} className="var-chip produced">
                        {k} = {JSON.stringify(v)}
                      </span>
                    ))}
                  </div>
                )}
                {r.error && <div className="resp-error">{r.error}</div>}
                {r.note && <div className="muted small">{r.note}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
